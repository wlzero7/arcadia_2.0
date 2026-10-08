// ========================================
// ARCADIA ROOMS — cliente multiplayer (Socket.IO)
// v1.0: jogo Slots disponível nas salas coop (com trunfos e drop de cartas)
// ========================================

const Rooms = (() => {

    let socket = null;
    let currentRoom = null;
    let selectedDice = null;
    let selectedSide = null;
    let visual = null, visualKey = null, lastRoundId = null, animating = false;
    const LABELS = { dice: "Dados", coinflip: "Cara ou coroa", crash: "Crash", roulette: "Roleta", slots: "Slots", football: "Futebol" };

    // ---------- ELEMENTOS ----------
    const $ = (id) => document.getElementById(id);
    const createRoomBtn = $("createRoomBtn");
    const joinRoomBtn = $("joinRoomBtn");
    const joinCodeInput = $("joinCode");
    const roomsList = $("roomsList");
    const roomModal = $("roomModal");
    const toast = $("toast");

    function toastMsg(msg) {
        toast.textContent = msg;
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 2600);
    }

    function requireLogin() {
        if (ArcadiaAPI.isLoggedIn()) return true;
        toastMsg("Entre na sua conta primeiro (página inicial).");
        setTimeout(() => (window.location.href = "index.html"), 1200);
        return false;
    }

    function connect() {
        return new Promise((resolve, reject) => {
            if (socket && socket.connected) return resolve(socket);
            socket = io(API_URL, { auth: { token: ArcadiaAPI.getToken() } });
            socket.on("connect", () => {
                const saved = sessionStorage.getItem("arcadia_room");
                if (saved) socket.emit("room:join", { code: saved }, (result) => {
                    if (!result.ok) sessionStorage.removeItem("arcadia_room");
                });
                resolve(socket);
            });
            socket.on("connect_error", (e) => {
                toastMsg("Erro de conexão: " + e.message);
                reject(e);
            });
            socket.on("room:update", (room) => {
                sessionStorage.setItem("arcadia_room", room.code);
                currentRoom = room;
                renderRoom(room);
            });
            socket.on("room:round", (round) => {
                renderRound(round);
                showRound(round);
                ArcadiaWallet.refresh().catch((error) => toastMsg(error.message));
            });
            socket.on("room:live", ({ play, serverTime }) => {
                if (currentRoom?.activePlay?.id === play.id) visual?.live(play, serverTime);
            });
            socket.on("room:chat", (msg) => {
                const log = $("chatLog");
                const div = document.createElement("div");
                if (msg.system) {
                    div.className = "sys";
                    div.textContent = msg.message;
                } else {
                    ArcadiaAvatar.chat(div, msg);
                }
                log.appendChild(div);
                log.scrollTop = log.scrollHeight;
            });
        });
    }

    function colorName(c) {
        return c === "green" ? "verde" : c === "red" ? "vermelho" : "preto";
    }

    function escapeHtml(s) {
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    // ---------- RENDER ----------
    function renderRoom(room) {
        $("mRoomName").textContent = room.name;
        $("mRoomCode").textContent = room.code;
        $("mPot").textContent = ArcadiaWallet.format(room.pot);
        $("mReserved").textContent = room.activePlay ? "Em jogo: " + ArcadiaWallet.format(room.activePlay.wager) : "";
        $("playerCount").textContent = room.players.filter((player) => player.online).length + "/" + room.maxPlayers;
        $("coopGameName").textContent = LABELS[room.game];
        ArcadiaWallet.setPoolBalance(room.pot);

        const me = ArcadiaAPI.getUser();
        const list = $("mPlayers");
        list.innerHTML = "";
        room.players.forEach((p) => {
            const li = document.createElement("li");
            if (!p.online) li.className = "offline";
            const isMe = me && p.id === me.id;
            li.innerHTML = `
                <span>${isMe ? "Você" : escapeHtml(p.username)} ${p.id === room.hostId ? '<span class="host-tag">👑 host</span>' : ""}</span>
                <span class="muted">stake: ${ArcadiaWallet.format(p.stake)}</span>
            `;
            list.appendChild(li);
            const name = li.firstElementChild; name.classList.add("player-identity");
            const avatar = document.createElement("span"); avatar.className = "player-avatar";
            ArcadiaAvatar.render(avatar, p.avatar, p.displayName || p.username); name.prepend(avatar);
        });

        renderGameControls(room);
        renderRoundHistory(room);
        if (visualKey !== room.code + ":" + room.game) {
            visual?.destroy(); visualKey = room.code + ":" + room.game; lastRoundId = null; animating = false;
            visual = ArcadiaVisuals.create($("coopLiveStage"), room.game);
        }
        if (room.activePlay) {
            visual.live(room.activePlay, room.serverTime);
            $("coopLiveStatus").textContent = room.activePlay.playerName + " · Em jogo";
        } else if (room.history.length) showRound(room.history.at(-1));
        lockControls();
        $("potTrend").textContent = room.history.length ? ArcadiaVisuals.chart($("potChart"), room.history) : "Sem rodadas ainda";
        if (!room.history.length) ArcadiaVisuals.chart($("potChart"), []);

        // painel de apostas da roleta
        if (room.game === "roulette") {
            const betsEl = document.getElementById("mpRlBets");
            if (betsEl) {
                betsEl.innerHTML = (room.rBets || []).length === 0
                    ? '<span class="muted">Nenhuma aposta no giro.</span>'
                    : (room.rBets || []).map((b) =>
                        `<span class="bet-entry">${escapeHtml(b.username)}: ${escapeHtml(b.type)}${b.value != null ? " " + b.value : ""} — ${b.amount} AC</span>`
                    ).join("");
            }
            const lastEl = document.getElementById("mpRlLast");
            if (lastEl && room.rLast) {
                lastEl.textContent = `Último giro: ${room.rLast.number} (${colorName(room.rLast.color)}) — pagou ${ArcadiaWallet.format(room.rLast.totalPayout)}`;
            }
        }
    }

    function renderGameControls(room) {
        const area = $("gameArea");
        const key = room.code + ":" + room.game;
        if (area.dataset.rendered === key) return;
        area.dataset.rendered = key;
        selectedDice = null;
        selectedSide = null;

        area.classList.toggle("football-bets", room.game === "football");
        if (room.game === "football") {
            area.dataset.footballMount = key;
            area.textContent = "Preparando mercado...";
            area.addEventListener("football:ready", lockControls, { once: true });
            if (!area.dataset.footballPreviewListener) {
                area.dataset.footballPreviewListener = "true";
                area.addEventListener("football:market", ({ detail }) => { if (currentRoom?.game === "football" && !currentRoom.activePlay) visual?.preview(detail.home, detail.away); lockControls(); });
            }
            ArcadiaFootballControls.mount(area, (choice, wager) => {
                socket.emit("room:play", { wager, choice, allWin: ArcadiaWallet.isAllWin("mpBet") }, (result) => { if (!result.ok) toastMsg(result.error); });
            }, room).catch((error) => toastMsg(error.message));
        } else if (room.game === "dice") {
            area.innerHTML = `
                <div class="dice-big" id="mpDice">🎲</div>
                <div class="number-pick" id="mpNumbers"></div>
                <div class="bet-row">
                    <input type="number" id="mpBet" placeholder="Aposta (${room.minBet}-${room.maxBet})" min="${room.minBet}" max="${room.maxBet}">
                    <button class="btn btn-primary" id="mpPlay">Jogar</button>
                </div>
                <div class="game-result" id="mpResult"></div>
            `;
            const nums = $("mpNumbers");
            for (let i = 1; i <= 6; i++) {
                const b = document.createElement("button");
                b.textContent = i;
                b.addEventListener("click", () => {
                    selectedDice = i;
                    nums.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
                    b.classList.add("selected");
                });
                nums.appendChild(b);
            }
            $("mpPlay").addEventListener("click", () => {
                if (!selectedDice) return toastMsg("Escolha um número!");
                socket.emit("room:play", { allWin: ArcadiaWallet.isAllWin("mpBet"), wager: Number($("mpBet").value), choice: { number: selectedDice } }, (r) => {
                    if (!r.ok) toastMsg(r.error);
                });
            });

        } else if (room.game === "coinflip") {
            area.innerHTML = `
                <div class="dice-big" id="mpCoin">🪙</div>
                <div class="side-pick">
                    <button data-side="heads">👑 Cara</button>
                    <button data-side="tails">🦅 Coroa</button>
                </div>
                <div class="bet-row">
                    <input type="number" id="mpBet" placeholder="Aposta (${room.minBet}-${room.maxBet})" min="${room.minBet}" max="${room.maxBet}">
                    <button class="btn btn-primary" id="mpPlay">Jogar</button>
                </div>
                <div class="game-result" id="mpResult"></div>
            `;
            area.querySelectorAll(".side-pick button").forEach((b) => {
                b.addEventListener("click", () => {
                    selectedSide = b.dataset.side;
                    area.querySelectorAll(".side-pick button").forEach((x) => x.classList.remove("selected"));
                    b.classList.add("selected");
                });
            });
            $("mpPlay").addEventListener("click", () => {
                if (!selectedSide) return toastMsg("Escolha um lado!");
                socket.emit("room:play", { allWin: ArcadiaWallet.isAllWin("mpBet"), wager: Number($("mpBet").value), choice: { side: selectedSide } }, (r) => {
                    if (!r.ok) toastMsg(r.error);
                });
            });

        } else if (room.game === "roulette") {
            area.innerHTML = `
                <div class="rlm-last" id="mpRlLast">Façam suas apostas! 🎡</div>
                <div class="rlm-out">
                    <button data-rt="red" class="red">Vermelho 2x</button>
                    <button data-rt="black">Preto 2x</button>
                    <button data-rt="even">Par</button>
                    <button data-rt="odd">Ímpar</button>
                    <button data-rt="low">1-18</button>
                    <button data-rt="high">19-36</button>
                    <button data-rt="dozen1">1ª dz 3x</button>
                    <button data-rt="dozen2">2ª dz 3x</button>
                    <button data-rt="dozen3">3ª dz 3x</button>
                </div>
                <div class="rlm-nums" id="mpRlNums"></div>
                <div class="bet-row">
                    <input type="number" id="mpBet" value="100" min="${room.minBet}" max="${room.maxBet}">
                    <button class="btn btn-primary" id="mpSpin">🎰 Girar</button>
                </div>
                <div id="mpRlBets" class="rlm-bets"></div>
                <div class="game-result" id="mpResult"></div>
            `;
            const nums = area.querySelector("#mpRlNums");
            const REDSET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
            for (let n = 0; n <= 36; n++) {
                const b = document.createElement("button");
                b.className = n === 0 ? "green" : REDSET.has(n) ? "red" : "black";
                b.textContent = n;
                b.dataset.rt = "straight";
                b.dataset.rv = n;
                nums.appendChild(b);
            }
            area.querySelectorAll("[data-rt]").forEach((b) => {
                b.addEventListener("click", () => {
                    socket.emit("room:rbet", {
                        type: b.dataset.rt,
                        value: b.dataset.rv != null ? Number(b.dataset.rv) : null,
                        amount: Number($("mpBet").value),
                        allWin: ArcadiaWallet.isAllWin("mpBet"),
                    }, (r) => { if (!r.ok) toastMsg(r.error); });
                });
            });
            $("mpSpin").addEventListener("click", () => {
                socket.emit("room:rspin", {}, (r) => { if (!r.ok) toastMsg(r.error); });
            });

        } else if (room.game === "crash") {
            area.innerHTML = `
                <div class="dice-big" id="mpCrash">🚀</div>
                <div class="bet-row">
                    <input type="number" id="mpTarget" placeholder="Auto-cashout (ex: 2)" step="0.1" min="1.1">
                    <input type="number" id="mpBet" placeholder="Aposta" min="${room.minBet}" max="${room.maxBet}">
                    <button class="btn btn-primary" id="mpPlay">Decolar</button>
                </div>
                <div class="game-result" id="mpResult"></div>
            `;
            $("mpPlay").addEventListener("click", () => {
                socket.emit("room:play", {
                    wager: Number($("mpBet").value),
                    allWin: ArcadiaWallet.isAllWin("mpBet"),
                    choice: { autoCashout: $("mpTarget").value === "" ? null : Number($("mpTarget").value) },
                }, (r) => {
                    if (!r.ok) toastMsg(r.error);
                });
            });
            $("mpTarget").placeholder = "Auto-cashout (opcional)";
            const cashout = document.createElement("button"); cashout.id = "mpCashout"; cashout.className = "btn btn-outline"; cashout.textContent = "Resgatar";
            $("mpPlay").after(cashout);
            cashout.addEventListener("click", () => socket.emit("room:cashout", {}, (result) => { if (!result.ok) toastMsg(result.error); }));

        } else if (room.game === "slots") {
            area.innerHTML = `
                <div class="dice-big" id="mpSlotReels">❔ ❔ ❔</div>
                <div class="field">
                    <label>Trunfo (opcional — consome a carta)</label>
                    <select id="mpTrump"><option value="">— Nenhum —</option></select>
                </div>
                <div class="bet-row">
                    <input type="number" id="mpBet" placeholder="Aposta (${room.minBet}-${room.maxBet})" min="${room.minBet}" max="${room.maxBet}">
                    <button class="btn btn-primary" id="mpPlay">🎰 Girar</button>
                </div>
                <div class="game-result" id="mpResult"></div>
            `;
            loadSlotsTrumps();
            $("mpPlay").addEventListener("click", () => {
                socket.emit("room:play", {
                    wager: Number($("mpBet").value),
                    allWin: ArcadiaWallet.isAllWin("mpBet"),
                    choice: { trump: $("mpTrump").value || undefined },
                }, (r) => {
                    if (!r.ok) toastMsg(r.error);
                });
            });
        }
    }

    async function loadSlotsTrumps() {
        if (!ArcadiaAPI.isLoggedIn()) return;
        try {
            const data = await ArcadiaAPI.request("/api/games/slots/cards");
            const sel = $("mpTrump");
            if (!sel) return;
            const previous = sel.value;
            sel.replaceChildren(new Option("Nenhum", ""));
            (data.inventory || []).forEach((c) => sel.add(new Option(`${c.name} (x${c.qty})`, c.key)));
            if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
        } catch (error) { toastMsg(error.message); }
    }

    function lockControls() {
        const active = currentRoom?.activePlay;
        if (currentRoom?.game === "football") $("gameArea").footballSync?.(active);
        for (const id of ["mpPlay", "mpSpin", "mpBet", "mpTarget", "mpTrump"]) if ($(id)) $(id).disabled = Boolean(active || animating);
        if (currentRoom?.game === "football" && $("gameArea").dataset.marketPending === "true" && $("mpPlay")) $("mpPlay").disabled = true;
        document.querySelectorAll("#gameArea [data-football-choice]").forEach((input) => input.disabled = Boolean(active || animating));
        for (const id of ["stakeBtn", "withdrawBtn", "stakeAmount"]) $(id).disabled = Boolean(active);
        if ($("mpCashout")) $("mpCashout").disabled = !active || active.playerId !== ArcadiaAPI.getUser()?.id;
        document.querySelectorAll("#gameArea [data-rt]").forEach((button) => { button.disabled = Boolean(animating); });
    }
    function showRound(round) {
        if (!visual || lastRoundId === round.id) return;
        lastRoundId = round.id; animating = true; lockControls();
        $("coopLiveStatus").textContent = "Rodada de " + round.playerName;
        const key = visualKey;
        visual.round(round).then(() => {
            if (key !== visualKey || lastRoundId !== round.id) return;
            renderGameResult(round); animating = false; lockControls();
            $("coopLiveStatus").textContent = "Rodada concluída";
        });
    }

    function renderGameResult(round) {
        const el = $("mpResult");
        if (!el) return;
        el.className = "game-result " + round.outcome;

        if (round.type === "football") {
            el.textContent = round.home.name + " " + round.score.join(" : ") + " " + round.away.name + " · Premio " + ArcadiaWallet.format(round.payout);
        } else if (round.type === "dice") {
            el.textContent = round.outcome === "win"
                ? `🎲 Caiu ${round.roll} — ${escapeHtml(round.playerName)} ganhou ${ArcadiaWallet.format(round.payout)}!`
                : `🎲 Caiu ${round.roll} — ${escapeHtml(round.playerName)} perdeu ${ArcadiaWallet.format(round.wager)}`;
            $("mpDice").textContent = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"][round.roll];

        } else if (round.type === "coinflip") {
            el.textContent = round.outcome === "win"
                ? `🪙 ${round.flip === "heads" ? "Cara" : "Coroa"} — ${escapeHtml(round.playerName)} ganhou ${ArcadiaWallet.format(round.payout)}!`
                : `🪙 ${round.flip === "heads" ? "Cara" : "Coroa"} — ${escapeHtml(round.playerName)} perdeu ${ArcadiaWallet.format(round.wager)}`;
            $("mpCoin").textContent = round.flip === "heads" ? "👑" : "🦅";

        } else if (round.type === "roulette") {
            el.textContent = round.payout > 0
                ? `🎡 Saiu ${round.number} (${colorName(round.color)}) — mesa pagou ${ArcadiaWallet.format(round.payout)}!`
                : `🎡 Saiu ${round.number} (${colorName(round.color)}) — sem prêmios dessa vez.`;

        } else if (round.type === "crash") {
            el.textContent = round.outcome === "win"
                ? `🚀 Cashout em ${round.multiplier}x — ${escapeHtml(round.playerName)} ganhou ${ArcadiaWallet.format(round.payout)}!`
                : `💥 Crash em ${round.crashPoint}x — ${escapeHtml(round.playerName)} perdeu ${ArcadiaWallet.format(round.wager)}`;
            $("mpCrash").textContent = round.outcome === "win" ? "🚀" : "💥";

        } else if (round.type === "slots") {
            loadSlotsTrumps();
            const reelsText = Array.isArray(round.reels) ? round.reels.join(" ") : "🎰";
            el.textContent = round.outcome === "win"
                ? `🎰 ${reelsText} — ${escapeHtml(round.playerName)} ganhou ${ArcadiaWallet.format(round.payout)}!`
                : `🎰 ${reelsText} — ${escapeHtml(round.playerName)} perdeu ${ArcadiaWallet.format(round.wager)}`;
            const reelsEl = $("mpSlotReels");
            if (reelsEl) reelsEl.textContent = reelsText;
            // notas de trunfo usados na rodada
            (round.notes || []).forEach((n) => toastMsg(n));
            // carta ganha no drop de 50%
            if (round.card) {
                toastMsg(`🎁 ${escapeHtml(round.playerName)} ganhou a carta ${round.card.name}!`);
                if (Sfx.achievement) Sfx.achievement();
            }
        }
    }

    function renderRound(round) {
        const h = $("roundHistory");
        const div = document.createElement("div");
        div.className = "round-item " + round.outcome;
        const net = round.payout - round.wager;
        const delta = (net >= 0 ? "+" : "-") + ArcadiaWallet.format(Math.abs(net));
        div.innerHTML = `<span>${escapeHtml(round.playerName)}</span><span>${delta}</span>`;
        h.prepend(div);
    }

    function renderRoundHistory(room) {
        const h = $("roundHistory");
        h.innerHTML = "";
        [...room.history].reverse().forEach((r) => {
            const div = document.createElement("div");
            div.className = "round-item " + r.outcome;
            const net = r.payout - r.wager;
            const delta = (net >= 0 ? "+" : "-") + ArcadiaWallet.format(Math.abs(net));
            div.innerHTML = `<span>${escapeHtml(r.playerName)}</span><span>${delta}</span>`;
            h.appendChild(div);
        });
    }

    // ---------- AÇÕES ----------
    createRoomBtn.addEventListener("click", async () => {
        if (!requireLogin()) return;
        await connect();
        socket.emit("room:create", {
            name: $("roomName").value || undefined,
            game: $("roomGame").value,
            maxPlayers: Number($("roomMax").value),
            minBet: Number($("roomMin").value),
            maxBet: Number($("roomMaxBet").value),
        }, (r) => {
            if (r.ok) openRoom(r.room);
            else toastMsg(r.error);
        });
    });

    joinRoomBtn.addEventListener("click", async () => {
        if (!requireLogin()) return;
        await connect();
        socket.emit("room:join", { code: joinCodeInput.value }, (r) => {
            if (r.ok) openRoom(r.room);
            else toastMsg(r.error);
        });
    });

    function openRoom(room) {
        currentRoom = room;
        sessionStorage.setItem("arcadia_room", room.code);
        renderRoom(room);
        $("chatLog").innerHTML = "";
        roomModal.classList.add("active");
        roomModal.hidden = false;
        document.querySelector(".rooms-grid").hidden = true;
        refreshRoomsList();
    }

    $("leaveRoomBtn").addEventListener("click", () => {
        socket.emit("room:leave");
        sessionStorage.removeItem("arcadia_room");
        roomModal.classList.remove("active");
        roomModal.hidden = true; currentRoom = null; visual?.destroy(); visualKey = null;
        document.querySelector(".rooms-grid").hidden = false;
        refreshRoomsList();
    });

    $("stakeBtn").addEventListener("click", () => {
        socket.emit("room:stake", { allWin: ArcadiaWallet.isAllWin("stakeAmount"), amount: Number($("stakeAmount").value) }, (r) => {
            if (r.ok) { toastMsg("Depositado no pote! 🎰"); $("stakeAmount").value = ""; ArcadiaWallet.refresh(); }
            else toastMsg(r.error);
        });
    });

    $("withdrawBtn").addEventListener("click", () => {
        socket.emit("room:withdraw", {}, (r) => {
            if (r.ok) { toastMsg("Stake sacado! 💸"); ArcadiaWallet.refresh(); }
            else toastMsg(r.error);
        });
    });

    $("chatSend").addEventListener("click", sendChat);
    $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

    function sendChat() {
        const input = $("chatInput");
        if (input.value.trim()) {
            socket.emit("room:chat", { message: input.value });
            input.value = "";
        }
    }

    $("copyCode").addEventListener("click", () => {
        if (currentRoom) {
            navigator.clipboard.writeText(currentRoom.code);
            toastMsg("Código copiado! 📋");
        }
    });

    // ---------- LISTA DE SALAS ----------
    function refreshRoomsList() {
        if (!socket || !socket.connected) return;
        socket.emit("rooms:list", (r) => {
            if (!r.ok) return;
            if (r.rooms.length === 0) {
                roomsList.innerHTML = '<p class="muted">Nenhuma sala aberta ainda.</p>';
                return;
            }
            roomsList.innerHTML = "";
            r.rooms.forEach((room) => {
                const div = document.createElement("div");
                div.className = "room-list-item";
                div.innerHTML = `<span>${escapeHtml(room.name)}</span><span class="muted">${room.players.length}/${room.maxPlayers} · ${ArcadiaWallet.format(room.pot)}</span>`;
                div.addEventListener("click", async () => {
                    await connect();
                    socket.emit("room:join", { code: room.code }, (rj) => {
                        if (rj.ok) openRoom(rj.room);
                        else toastMsg(rj.error);
                    });
                });
                roomsList.appendChild(div);
            });
        });
    }

    // ---------- INIT ----------
    async function init() {
        window.lucide?.createIcons();
        await ArcadiaAPI.ready;
        const preferred = new URLSearchParams(location.search).get("game");
        if (["coinflip", "football"].includes(preferred)) $("roomGame").value = preferred;
        if (ArcadiaAPI.isLoggedIn()) {
            await ArcadiaWallet.refresh();
            $("walletBalance").textContent = ArcadiaWallet.format(ArcadiaWallet.getCached());
            await connect();
            refreshRoomsList();
            // Reconexão automática: F5 não expulsa mais da partida
            const savedRoom = sessionStorage.getItem("arcadia_room");
            if (savedRoom) {
                socket.emit("room:join", { code: savedRoom }, (rj) => {
                    if (rj.ok) {
                        openRoom(rj.room);
                        toastMsg("Reconectado à sala ✓");
                    } else {
                        sessionStorage.removeItem("arcadia_room");
                    }
                });
            }
        }
        document.addEventListener("arcadia:balance", (e) => {
            $("walletBalance").textContent = ArcadiaWallet.format(e.detail.balance);
        });
    }

    init().catch((err) => toastMsg(err.message));

    return { socket: () => socket, currentRoom: () => currentRoom };
})();
