// ========================================
// ARCADIA DUEL — cliente x1 (v1.1)
// v1.1: fix do crash no load (elementos opcionais com guarda),
// seleção de jogo funcional, escolha por jogo (dado/moeda/crash/
// mines/roleta/slots) e trunfos do inventário
// ========================================

(() => {

    const $ = (id) => document.getElementById(id);

    let socket = null;
    let duel = null;
    let selectedDice = null;
    let selectedSide = null;
    let selectedAuctionSlot = null;
    let inventory = [];
    const requestedGame = new URLSearchParams(location.search).get("game");
    const preferredGame = ["coinflip", "football"].includes(requestedGame) ? requestedGame : null;
    let footballVisual = null;
    let lastRenderedPlayId = null;
    let activeRenderedId = null;
    let actionPending = false;
    let liveAnimating = false;
    const liveTimers = new Set();
    const GAME_ICON = { dice: "🎲", coinflip: "🪙", crash: "🚀", mines: "💣", roulette: "🎡", slots: "🎰", blackjack: "🃏" };
    const GAME_LABEL = { dice: "Dados", coinflip: "Cara ou coroa", crash: "Crash", mines: "Mines", roulette: "Roleta", slots: "Slots", blackjack: "Blackjack", football: "Futebol" };
    const bjTrumps = ArcadiaBlackjack.controls($("duelBlackjackTrumps"), (body) => new Promise((resolve, reject) => {
        socket.emit("duel:special", body, (r) => { if (r.ok) resolve(); else reject(new Error(r.error)); });
    }));
    const SIDE_LABEL = { heads: "Cara", tails: "Coroa" };
    const BET_LABEL = { red: "Vermelho", black: "Preto", even: "Par", odd: "Ímpar", low: "1-18", high: "19-36" };

    function later(fn, delay) {
        const id = setTimeout(() => {
            liveTimers.delete(id);
            fn();
        }, delay);
        liveTimers.add(id);
        return id;
    }

    function clearLiveTimers() {
        liveTimers.forEach((id) => clearTimeout(id));
        liveTimers.clear();
    }

    function fmtAC(value) {
        return (Number(value) || 0).toLocaleString("pt-BR") + " AC";
    }

    function signedAC(value) {
        const n = Number(value) || 0;
        return (n > 0 ? "+" : "") + fmtAC(n);
    }

    function esc(value) {
        return ArcadiaAPI.escapeHtml(String(value ?? ""));
    }

    function connect() {
        return new Promise((resolve, reject) => {
            if (socket && socket.connected) return resolve(socket);
            socket = io(API_URL, { auth: { token: ArcadiaAPI.getToken() } });
            socket.on("connect", () => {
                const saved = sessionStorage.getItem("arcadia_duel");
                if (saved) socket.emit("duel:join", { code: saved }, (result) => {
                    if (!result.ok) sessionStorage.removeItem("arcadia_duel");
                });
                resolve(socket);
            });
            socket.on("connect_error", (e) => reject(e));
            socket.on("disconnect", () => { actionPending = false; updateLiveControls(); });

            socket.on("duel:state", (d) => {
                sessionStorage.setItem("arcadia_duel", d.code);
                duel = d;
                render(d);
            });
            socket.on("duel:live", ({ play, serverTime }) => {
                if (duel?.activePlay?.id === play.id && play.game === "football") footballVisual?.live(play, serverTime);
            });

            socket.on("duel:finished", (f) => {
                sessionStorage.removeItem("arcadia_duel");
                Sfx.raceWin();
                const res = $("duelResult");
                if (res) {
                    res.classList.remove("hidden");
                    res.textContent = f.cancelled ? "Duelo cancelado." : `🏆 ${f.winner} venceu o duelo!`;
                }
            });
        });
    }

    function render(d) {
        $("duelLobby").classList.toggle("hidden", d.phase !== "finished");
        $("leaveDuelBtn").disabled = d.phase === "finished";
        if (d.phase !== "finished") $("duelResult").classList.add("hidden");
        $("duelArena").classList.remove("hidden");
        $("duelCode").textContent = d.code;

        const me = ArcadiaAPI.getUser();
        const myKey = me && d.p1.userId === me.id ? "p1" : me && d.p2?.userId === me.id ? "p2" : "p1";

        $("p1Name").textContent = d.p1.username;
        $("p1Balance").textContent = (d.p1.balance || 0).toLocaleString("pt-BR") + " AC";
        $("p2Name").textContent = d.p2 ? d.p2.username : "Aguardando...";
        $("p2Balance").textContent = d.p2 ? (d.p2.balance || 0).toLocaleString("pt-BR") + " AC" : "—";
        if (d[myKey]) ArcadiaWallet.setCached(d[myKey].balance);

        $("p1Box").classList.toggle("my-turn", d.turn === "p1" && d.phase === "playing");
        $("p2Box").classList.toggle("my-turn", d.turn === "p2" && d.phase === "playing");

        const selectedGame = $("gameSelect");
        if (selectedGame) {
            selectedGame.value = d.chosenGame || preferredGame || "dice";
            selectedGame.disabled = !!d.chosenGame;
            renderGameChoice();
        }
        updateDuelButtons(d, myKey);

        // LEILÃO
        const auctionPanel = $("auctionPanel");
        auctionPanel.classList.toggle("hidden", d.phase !== "auction");
        if (d.phase === "auction" && d.auction) {
            renderAuction(d, myKey);
        }

        // área de jogo
        const myTurn = d.phase === "playing" && d.turn === myKey;
        $("duelPlay").classList.toggle("hidden", !myTurn);
        $("duelTurn").textContent =
            d.phase === "waiting" ? "Aguardando oponente entrar..." :
            d.phase === "ready" ? "Ambos prontos para iniciar!" :
            d.phase === "playing" ? (myTurn ? "🎯 Sua vez!" : `⏳ Vez de ${d[d.turn].username}`) :
            "Duelo encerrado.";
        renderLiveArena(d);
        updateLiveControls();

        // log
        const log = $("duelLog");
        log.innerHTML = "";
        (d.log || []).forEach((l) => {
            const div = document.createElement("div");
            if (l.system) { div.className = "sys"; div.textContent = l.message; }
            else div.innerHTML = `<b>${ArcadiaAPI.escapeHtml(l.username)}:</b> ${ArcadiaAPI.escapeHtml(l.message)}`;
            log.appendChild(div);
        });
        log.scrollTop = log.scrollHeight;
    }

    function iAmReady(d, myKey) {
        return d[myKey] && d[myKey].ready;
    }

    // ---------- PRONTO / INICIAR ----------
    $("leaveDuelBtn").addEventListener("click", () => {
        if (!socket?.connected || !duel) return;
        const message = duel.phase === "playing" ? "Sair conta como derrota. Seu saldo restante sera mantido. Encerrar duelo?" : "Cancelar este duelo?";
        if (!confirm(message)) return;
        socket.emit("duel:leave", {}, (result) => { if (!result.ok) alert(result.error); });
    });
    function updateDuelButtons(d, myKey) {
        const readyBtn = $("readyBtn");
        const startBtn = $("startBtn");
        const me = ArcadiaAPI.getUser();
        const isHost = me && d.p1.userId === me.id;
        const amReady = iAmReady(d, myKey);

        const showReady = (d.phase === "waiting" || d.phase === "ready") && !amReady;
        readyBtn.classList.toggle("hidden", !showReady);

        const showStart = isHost && d.phase === "ready" && d.p2 && d.p1.ready && d.p2.ready;
        if (startBtn) startBtn.classList.toggle("hidden", !showStart);

        const st = $("readyStatus");
        if (st) {
            const p1r = d.p1.ready ? "✓" : "…";
            const p2r = d.p2 && d.p2.ready ? "✓" : "…";
            st.textContent = `Prontos: P1 ${p1r} · P2 ${p2r}`;
        }
    }

    // ---------- LEILÃO ----------
    function renderAuction(d, myKey) {
        const slots = $("auctionSlots");
        slots.innerHTML = "";
        const oppKey = myKey === "p1" ? "p2" : "p1";
        if (selectedAuctionSlot === null && preferredGame) selectedAuctionSlot = d.auction.findIndex((slot) => slot.game === preferredGame);

        d.auction.forEach((slot, idx) => {
            const myBid = slot.bids[myKey] || 0;
            const oppBid = slot.bids[oppKey] || 0;
            const leading = myBid > oppBid && myBid > 0;

            const div = document.createElement("div");
            div.className = "auction-slot" + (selectedAuctionSlot === idx ? " selected" : "");
            div.innerHTML = `
                <span class="as-game">${GAME_ICON[slot.game] || "🎮"} ${slot.game}</span>
                <span class="as-bids">${myBid ? `você: ${myBid} AC` : ""}${oppBid ? ` · oponente: ${oppBid} AC` : ""}</span>
                <span class="as-lead ${leading ? "me" : oppBid > 0 ? "opp" : ""}">${leading ? "👑 na frente" : oppBid > 0 ? "perdendo" : "sem lances"}</span>
                <span class="as-bid-btn"></span>
            `;
            const bidBtn = document.createElement("button");
            bidBtn.className = "btn btn-outline";
            bidBtn.style.padding = ".3rem .8rem";
            bidBtn.textContent = "+10 lance";
            bidBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const base = Math.max(myBid, oppBid) + 10;
                const input = $("bidAmount");
                if (input) input.value = base;
                selectedAuctionSlot = idx;
                slots.querySelectorAll(".auction-slot").forEach((x) => x.classList.remove("selected"));
                div.classList.add("selected");
                const choose = $("chooseBtn");
                if (choose) choose.classList.toggle("hidden", !leading);
                Sfx.chip();
            });
            div.querySelector(".as-bid-btn").appendChild(bidBtn);
            div.addEventListener("click", () => {
                selectedAuctionSlot = idx;
                slots.querySelectorAll(".auction-slot").forEach((x) => x.classList.remove("selected"));
                div.classList.add("selected");
                const choose = $("chooseBtn");
                if (choose) choose.classList.toggle("hidden", !leading);
            });
            slots.appendChild(div);
        });
        const selected=d.auction[selectedAuctionSlot];
        $("chooseBtn")?.classList.toggle("hidden",!selected || selected.bids[myKey]<=selected.bids[oppKey]);
    }

    // controles do leilão (com guarda — só liga se existirem no HTML)
    const bidBtn = $("bidBtn");
    if (bidBtn) {
        bidBtn.addEventListener("click", () => {
            if (selectedAuctionSlot === null) return setAuctionMsg("Selecione um modo!", "loss");
            socket.emit("duel:bid", { gameIdx: selectedAuctionSlot, amount: Number($("bidAmount").value) }, (r) => {
                if (!r.ok) setAuctionMsg(r.error, "loss");
                else { setAuctionMsg("Lance registrado! 🔨", "win"); Sfx.chip(); }
            });
        });
    }

    const chooseBtn = $("chooseBtn");
    if (chooseBtn) {
        chooseBtn.addEventListener("click", () => {
            if (selectedAuctionSlot === null) return setAuctionMsg("Selecione um modo que você venceu!", "loss");
            socket.emit("duel:choose", { gameIdx: selectedAuctionSlot }, (r) => {
                if (!r.ok) setAuctionMsg(r.error, "loss");
                else Sfx.achievement();
            });
        });
    }

    function setAuctionMsg(text, cls) {
        const el = $("auctionMsg");
        if (!el) return;
        el.textContent = text;
        el.className = "game-result" + (cls ? " " + cls : "");
    }

    // ---------- ARENA AO VIVO ----------
    function ownKey() {
        return duel?.p1.userId === ArcadiaAPI.getUser()?.id ? "p1" : "p2";
    }

    let blackjackInventoryRoom = "";
    function updateLiveControls() {
        if (!duel) return;
        const active = duel.activePlay;
        const ownTurn = duel.phase === "playing" && duel.turn === ownKey();
        const locked = actionPending || !socket?.connected || liveAnimating;
        $("playBtn").disabled = locked || !ownTurn || !!active;
        $("playBtn").textContent = ["mines", "crash"].includes(duel.chosenGame) ? "Iniciar rodada" : "Jogar";
        ["wager", "crashTarget", "minesCount", "rouletteBet", "trumpSelect"].forEach((id) => {
            if ($(id)) $(id).disabled = !!active || actionPending || liveAnimating;
        });
        const cashout = $("cashoutBtn");
        cashout.classList.toggle("hidden", !active || !ownTurn || ["blackjack", "football"].includes(active.game));
        cashout.disabled = locked;
        if (active) cashout.textContent = "Sacar " + fmtAC(active.potentialPayout);
        const blackjack = active?.game === "blackjack";
        $("duelBjActions").classList.toggle("hidden", !blackjack || !ownTurn);
        for (const id of ["duelHit", "duelStand", "duelDouble"]) $(id).disabled = locked || !ownTurn || !blackjack || (id === "duelDouble" && (!active.canDouble || duel[ownKey()].balance < active.wager * 2));
        $("duelBlackjackTrumps").classList.toggle("hidden", duel.chosenGame !== "blackjack");
        if (duel.chosenGame === "blackjack" && blackjackInventoryRoom !== duel.code) {
            blackjackInventoryRoom = duel.code;
            bjTrumps.refresh();
        }
        bjTrumps.render({ ...(blackjack ? active : {}), canUse: blackjack && ownTurn && !locked });
        document.querySelectorAll("button.live-mine-cell").forEach((cell) => {
            cell.disabled = locked || !active || !ownTurn || active.picked.includes(Number(cell.dataset.cell));
        });
    }

    function sendAction(event, data = {}) {
        if (actionPending || !socket?.connected) return;
        const activeId = duel?.activePlay?.id;
        actionPending = true;
        updateLiveControls();
        socket.timeout(5000).emit(event, data, (err, result) => {
            actionPending = false;
            if (err || !result?.ok) {
                if (activeId && duel?.lastPlay?.id === activeId) {
                    if (!liveAnimating) finishLive(duel.lastPlay);
                    updateLiveControls(); return;
                }
                $("duelLiveSummary").textContent = err ? "Conexão interrompida. Aguarde a atualização da sala." : result.error;
                $("duelLiveSummary").className = "duel-live-summary loss";
                if (err && socket.connected) socket.emit("duel:sync", {});
            }
            updateLiveControls();
        });
    }

    function resultClass(play) {
        const transfer = Number(play.transfer) || 0;
        return transfer > 0 ? "win" : transfer < 0 ? "loss" : "push";
    }

    function finishLive(play) {
        const summary = $("duelLiveSummary");
        if (!summary) return;
        const transfer = Number(play.transfer) || 0;
        const cls = resultClass(play);
        liveAnimating = false;
        const balance = document.querySelector("[data-live-balance]");
        const multiplier = document.querySelector("[data-live-multiplier]");
        if (balance) balance.textContent = signedAC(play.transfer);
        if (multiplier) multiplier.textContent = Number(play.multiplier || 0).toFixed(2) + "x";
        updateLiveControls();
        if (play.game === "slots") loadTrumps();
        if (play.game === "blackjack") bjTrumps.refresh();
        summary.className = "duel-live-summary " + cls;
        if (transfer > 0) {
            summary.textContent = `${play.username} venceu a jogada e puxou ${fmtAC(transfer)}.`;
            Sfx.win();
        } else if (transfer < 0) {
            summary.textContent = `${play.username} perdeu ${fmtAC(Math.abs(transfer))}.`;
            Sfx.lose();
        } else {
            summary.textContent = `${play.username} empatou a jogada.`;
            Sfx.push();
        }
    }

    function liveMeta(play) {
        return `
            <div class="live-player-tag">${esc(play.username)} ${play.transfer == null ? "jogando" : "jogou"}</div>
            <div class="live-detail-grid">
                <span>Aposta <strong data-live-wager>${fmtAC(play.wager)}</strong></span>
                <span>Saldo da jogada <strong data-live-balance>—</strong></span>
                <span>Multiplicador <strong data-live-multiplier>—</strong></span>
            </div>
        `;
    }

    function renderIdleLive(game, phase) {
        const icon = GAME_ICON[game] || "🎮";
        const label = GAME_LABEL[game] || "Duelo";
        const text =
            phase === "auction" ? "Dispute o leilão para escolher o modo." :
            game ? "Aguardando a primeira jogada." : "Aguardando jogadores.";
        if (game === "mines") return `<div class="live-mines-board">${Array.from({ length: 25 }, () => '<button class="live-mine-cell" disabled></button>').join("")}</div>`;
        if (game === "dice") return '<div class="live-dice">?</div>';
        if (game === "coinflip") return '<div class="live-coin"><img src="css/coin-heads.svg" alt="Cara"></div>';
        if (game === "slots") return '<div class="live-slots-machine"><div class="live-reel">❔</div><div class="live-reel">❔</div><div class="live-reel">❔</div></div>';
        if (game === "roulette") return '<div class="live-roulette-wheel"><div class="live-roulette-number">?</div></div>';
        if (game === "crash") return '<div class="live-crash-scene"><div class="live-crash-sky"><div class="live-crash-mult">1.00x</div><div class="live-crash-rocket">🚀</div></div></div>';
        return `
            <div class="live-idle">
                <div class="live-idle-icon">${icon}</div>
                <strong>${esc(label)}</strong>
                <span>${esc(text)}</span>
            </div>
        `;
    }

    function renderLiveArena(d) {
        const stage = $("duelLiveStage");
        if (!stage) return;
        const game = d.activePlay?.game || d.lastPlay?.game || d.chosenGame || preferredGame;
        if (game === "football" && d.footballTeams) {
            clearLiveTimers();liveAnimating=false;
            if (!footballVisual) footballVisual=ArcadiaFootballVisual.create(stage);
            if(d.activePlay)footballVisual.live(d.activePlay,d.serverTime);
            else if(d.lastPlay?.detail?.home)footballVisual.round(d.lastPlay);
            else footballVisual.preview(d.footballTeams.p1,d.footballTeams.p2);
            const summary=$("duelLiveSummary");
            summary.textContent=d.activePlay?"Bola em jogo · "+d.activePlay.username:d.lastPlay?.detail?.score?"Apito final · "+d.lastPlay.detail.score.join(" : ")+" · "+signedAC(d.lastPlay.transfer):"Aguardando a primeira partida";
            const title=$("liveGameTitle");if(title)title.textContent="Futebol";
            $("liveGameSubtitle").textContent=d.phase==="finished"?"Duelo encerrado":d.activePlay?"Partida em andamento":"Vez de "+d[d.turn].username;
            $("liveRoundChip").textContent="Rodada "+(d.lastPlay?.round || d.round);
            const price=d.footballMarkets?.[ownKey()];
            $("footballDuelInfo").textContent="Vitoria do seu elenco · "+(price?.odds.home?.toFixed(2)||"—")+"x · "+(price? (price.probabilities.home*100).toFixed(1)+"%":"")+" · Premio limitado ao saldo do adversario.";
            return;
        }
        if (footballVisual) { footballVisual.destroy(); footballVisual=null; }
        const title = $("liveGameTitle");
        const subtitle = $("liveGameSubtitle");
        const round = $("liveRoundChip");
        if (title) title.textContent = game ? `${GAME_ICON[game] || "🎮"} ${GAME_LABEL[game] || game}` : "🎮 Arena ao vivo";
        if (subtitle) {
            subtitle.textContent =
                d.phase === "auction" ? "Leilão aberto." :
                d.phase === "playing" ? (d.activePlay ? `${d.activePlay.username} jogando` : `Vez de ${d[d.turn].username}`) :
                d.phase === "finished" ? "Última jogada do duelo." :
                "Aguardando jogadores.";
        }
        if (round) round.textContent = `Rodada ${d.activePlay ? d.round : d.lastPlay?.round || d.round || 1}`;

        if (d.activePlay) {
            renderActivePlay(d.activePlay);
            return;
        }

        if (!d.lastPlay) {
            clearLiveTimers();
            lastRenderedPlayId = null;
            activeRenderedId = null;
            liveAnimating = false;
            stage.dataset.game = game || "idle";
            stage.innerHTML = renderIdleLive(game, d.phase);
            const summary = $("duelLiveSummary");
            if (summary) {
                summary.className = "duel-live-summary";
                summary.textContent =
                    d.phase === "auction" ? "Leilão aberto." :
                    d.chosenGame ? "Aguardando a primeira jogada." :
                    "Aguardando o início do duelo.";
            }
            return;
        }

        if (d.lastPlay.id === lastRenderedPlayId) return;
        lastRenderedPlayId = d.lastPlay.id;
        activeRenderedId = null;
        animateLivePlay(d.lastPlay);
    }

    function renderActivePlay(play) {
        clearLiveTimers();
        liveAnimating = false;
        lastRenderedPlayId = null;
        const firstRender = activeRenderedId !== play.id;
        activeRenderedId = play.id;
        const stage = $("duelLiveStage");
        stage.dataset.game = play.game;
        const summary = $("duelLiveSummary");
        summary.className = "duel-live-summary";
        if (play.game === "blackjack") {
            paintBlackjack(play, true);
            summary.textContent = `${play.username}: ${play.playerTotal} pontos · limite ${play.limit}${play.note ? " · " + play.note : ""}`;
        } else if (play.game === "mines") {
            const previous = new Set(Array.from(stage.querySelectorAll(".live-mine-cell.gem"), (cell) => Number(cell.dataset.cell)));
            stage.innerHTML = `${liveMeta(play)}<div class="live-mines-board">${Array.from({ length: 25 }, (_, i) =>
                `<button class="live-mine-cell${play.picked.includes(i) ? " open gem" : ""}" data-cell="${i}" aria-label="Célula ${i + 1}" ${play.picked.includes(i) ? "disabled" : ""}>${play.picked.includes(i) ? "💎" : ""}</button>`).join("")}</div>`;
            stage.querySelectorAll("button.live-mine-cell").forEach((cell) => cell.addEventListener("click", () => sendAction("duel:pick", { cell: Number(cell.dataset.cell) })));
            if (play.picked.some((cell) => !previous.has(cell))) Sfx.gem();
            stage.querySelector("[data-live-multiplier]").textContent = play.multiplier.toFixed(2) + "x";
            summary.textContent = `${play.username}: ${play.picked.length} célula(s) segura(s).`;
        } else {
            stage.innerHTML = `${liveMeta(play)}<div class="live-crash-scene"><div class="live-crash-sky" id="liveCrashSky">
                <div class="live-crash-target">${play.autoCashout ? `Auto ${play.autoCashout.toFixed(2)}x` : "Saque manual"}</div>
                <div class="live-crash-mult" id="liveCrashMult">1.00x</div><div class="live-crash-rocket" id="liveCrashRocket">🚀</div>
                </div></div>`;
            if (firstRender) Sfx.rocket();
            const receivedAt = performance.now();
            function tick() {
                const elapsed = Math.max(0, duel.serverTime - play.startedAt) + performance.now() - receivedAt;
                const value = Math.min(play.autoCashout || 1000000, Math.pow(1.06, elapsed / 1000 * 6));
                const multiplier = Math.floor(value * 100) / 100;
                paintCrash(multiplier);
                stage.querySelector("[data-live-multiplier]").textContent = multiplier.toFixed(2) + "x";
                $("cashoutBtn").textContent = "Sacar " + fmtAC(Math.floor(play.wager * multiplier));
                later(tick, 50);
            }
            tick();
            summary.textContent = `${play.username} em voo...`;
        }
    }

    function paintCrash(multiplier) {
        const sky = $("liveCrashSky"), rocket = $("liveCrashRocket"), mult = $("liveCrashMult");
        if (mult) mult.textContent = multiplier.toFixed(2) + "x";
        const t = Math.min(1, Math.max(0, (multiplier - 1) / 4));
        if (sky && rocket) {
            rocket.style.left = `${24 + t * (sky.clientWidth - 92)}px`;
            rocket.style.bottom = `${20 + t * (sky.clientHeight - 86)}px`;
            rocket.style.transform = `rotate(${-35 * t}deg)`;
        }
    }

    function animateLivePlay(play) {
        clearLiveTimers();
        liveAnimating = true;
        const stage = $("duelLiveStage");
        if (!stage) return;
        stage.dataset.game = play.game;
        const summary = $("duelLiveSummary");
        if (summary) {
            summary.className = "duel-live-summary";
            summary.textContent = `${play.username} jogando ${GAME_LABEL[play.game] || play.game}...`;
        }
        if (play.game === "blackjack") { paintBlackjack({ ...play, ...play.detail }, false); later(() => finishLive(play), 650); }
        else if (play.game === "dice") animateDice(play);
        else if (play.game === "coinflip") animateCoinflip(play);
        else if (play.game === "crash") animateCrash(play);
        else if (play.game === "mines") animateMines(play);
        else if (play.game === "roulette") animateRoulette(play);
        else if (play.game === "slots") animateSlots(play);
        else {
            stage.innerHTML = `${liveMeta(play)}${renderIdleLive(play.game, "playing")}`;
            finishLive(play);
        }
    }

    function paintBlackjack(play, active) {
        const stage = $("duelLiveStage");
        if (stage.dataset.bjPlayId !== play.id || !stage.querySelector("[data-bj-hand]")) {
            stage.dataset.bjPlayId = play.id;
            stage.innerHTML = `${liveMeta(play)}<div class="live-bj-table"><h3>Dealer <span data-bj-dealer-total></span></h3><div class="cards" data-bj-dealer></div><h3>${esc(play.username)} <span data-bj-total></span></h3><div class="cards" data-bj-hand></div></div>`;
        }
        ArcadiaBlackjack.cards(stage.querySelector("[data-bj-hand]"), play.player || []);
        stage.querySelector("[data-live-wager]").textContent = fmtAC(play.wager);
        ArcadiaBlackjack.cards(stage.querySelector("[data-bj-dealer]"), play.dealer || []);
        stage.querySelector("[data-bj-total]").textContent = play.playerTotal;
        stage.querySelector("[data-bj-dealer-total]").textContent = play.dealerTotal + (active ? "+?" : "");
    }

    function animateDice(play) {
        const stage = $("duelLiveStage");
        const picked = play.detail?.picked ?? play.choice?.number ?? "—";
        stage.innerHTML = `
            ${liveMeta(play)}
            <div class="live-dice-scene">
                <div class="live-dice rolling" id="liveDice">?</div>
                <div class="live-choice">Escolheu <strong>${esc(picked)}</strong></div>
            </div>
        `;
        Sfx.dice();
        const dice = $("liveDice");
        for (let i = 0; i < 10; i++) {
            later(() => { if (dice) dice.textContent = String(Math.floor(Math.random() * 6) + 1); }, i * 80);
        }
        later(() => {
            if (dice) {
                dice.classList.remove("rolling");
                dice.textContent = String(play.detail?.roll ?? "?");
            }
            finishLive(play);
        }, 900);
    }

    function animateCoinflip(play) {
        const stage = $("duelLiveStage");
        const picked = play.detail?.picked ?? play.choice?.side;
        const flip = play.detail?.flip || "heads";
        stage.innerHTML = `
            ${liveMeta(play)}
            <div class="live-coin-scene">
                <div class="live-coin flipping" id="liveCoin">
                    <img src="css/coin-heads.svg" alt="Moeda">
                </div>
                <div class="live-choice">Escolheu <strong>${esc(SIDE_LABEL[picked] || picked || "—")}</strong></div>
            </div>
        `;
        Sfx.coin();
        later(() => {
            const coin = $("liveCoin");
            const img = coin?.querySelector("img");
            if (coin) coin.classList.remove("flipping");
            if (img) {
                img.src = `css/coin-${flip}.svg`;
                img.alt = `Moeda: ${SIDE_LABEL[flip] || flip}`;
            }
            finishLive(play);
        }, 850);
    }

    function animateCrash(play) {
        const stage = $("duelLiveStage");
        const target = Number(play.detail?.target || play.choice?.autoCashout || 0);
        const crashPoint = Number(play.detail?.crashPoint || 1);
        const crashed = play.detail?.crashed ?? play.outcome === "loss";
        const endAt = crashed ? crashPoint : Number(play.detail?.cashout || target || 1);
        stage.innerHTML = `
            ${liveMeta(play)}
            <div class="live-crash-scene">
                <div class="live-crash-sky" id="liveCrashSky">
                    <div class="live-crash-target">${target ? `Auto ${target.toFixed(2)}x` : "Saque manual"}</div>
                    <div class="live-crash-mult" id="liveCrashMult">1.00x</div>
                    <div class="live-crash-rocket" id="liveCrashRocket">🚀</div>
                </div>
            </div>
        `;
        const sky = $("liveCrashSky");
        const rocket = $("liveCrashRocket");
        paintCrash(endAt);
        sky.classList.add(crashed ? "crashed" : "won");
        rocket.textContent = crashed ? "💥" : "💰";
        if (crashed) Sfx.boom(); else Sfx.cashout();
        finishLive(play);
    }

    function animateMines(play) {
        const stage = $("duelLiveStage");
        const mines = play.detail?.minePositions || [];
        const opened = play.detail?.opened || [];
        stage.innerHTML = `
            ${liveMeta(play)}
            <div class="live-mines-board" id="liveMinesBoard">
                ${Array.from({ length: 25 }, (_, i) => `<div class="live-mine-cell" data-cell="${i}"></div>`).join("")}
            </div>
        `;
        opened.forEach((cellIndex) => {
            const cell = stage.querySelector(`[data-cell="${cellIndex}"]`);
            if (!cell) return;
            const boom = mines.includes(cellIndex);
            cell.classList.add("open", boom ? "boom" : "gem");
            cell.textContent = boom ? "💥" : "💎";
        });
        mines.forEach((cellIndex) => {
            const cell = stage.querySelector(`[data-cell="${cellIndex}"]`);
            if (cell && !cell.textContent) {
                cell.classList.add("dim");
                cell.textContent = "💣";
            }
        });
        if (play.outcome === "loss") Sfx.boom(); else Sfx.cashout();
        finishLive(play);
    }

    function animateRoulette(play) {
        const stage = $("duelLiveStage");
        const detail = play.detail || {};
        const color = detail.color || "green";
        const bet = play.choice?.bet || detail.results?.[0]?.type || "red";
        stage.innerHTML = `
            ${liveMeta(play)}
            <div class="live-roulette-scene">
                <div class="live-roulette-wheel spin" id="liveRouletteWheel">
                    <div class="live-roulette-number" id="liveRouletteNumber">?</div>
                </div>
                <div class="live-choice">Aposta em <strong>${esc(BET_LABEL[bet] || bet)}</strong></div>
            </div>
        `;
        Sfx.spin();
        later(() => {
            const wheel = $("liveRouletteWheel");
            const number = $("liveRouletteNumber");
            if (wheel) wheel.classList.remove("spin");
            if (number) {
                number.textContent = String(detail.number ?? 0);
                number.className = "live-roulette-number " + color;
            }
            finishLive(play);
        }, 1250);
    }

    function animateSlots(play) {
        const stage = $("duelLiveStage");
        const reels = play.detail?.reels || ["❔", "❔", "❔"];
        stage.innerHTML = `
            ${liveMeta(play)}
            <div class="live-slots-scene">
                <div class="live-slots-machine" id="liveSlotsMachine">
                    <div class="live-reel spinning">❔</div>
                    <div class="live-reel spinning">❔</div>
                    <div class="live-reel spinning">❔</div>
                </div>
                <div class="live-choice">${play.trump ? `Trunfo <strong>${esc(play.trump)}</strong>` : "Sem trunfo"}</div>
                <div id="liveCardDrop"></div>
            </div>
        `;
        Sfx.spinSlots();
        const reelEls = Array.from(stage.querySelectorAll(".live-reel"));
        reels.forEach((emoji, i) => {
            later(() => {
                const reel = reelEls[i];
                if (!reel) return;
                reel.classList.remove("spinning");
                reel.textContent = emoji;
                Sfx.reelStop(i);
            }, 700 + i * 320);
        });
        later(() => {
            const machine = $("liveSlotsMachine");
            if (machine) machine.classList.add(play.detail?.jackpot ? "jackpot" : resultClass(play) === "win" ? "won" : "lost");
            if (play.card) {
                const drop = $("liveCardDrop");
                if (drop) drop.innerHTML = `<div class="live-card-drop">🎁 Carta: ${esc(play.card.name || play.card.key)}</div>`;
                Sfx.cardDrop(play.card.rarity);
            }
            if (play.detail?.jackpot) Sfx.jackpot();
            finishLive(play);
        }, 1800);
    }

    // ---------- ESCOLHA POR JOGO ----------
    const gameSelect = $("gameSelect");
    function renderGameChoice() {
        const g = gameSelect ? gameSelect.value : "dice";
        const crashTarget = $("crashTarget");
        if (crashTarget) crashTarget.classList.toggle("hidden", g !== "crash");

        const dicePick = $("dicePick");
        if (dicePick) {
            dicePick.classList.toggle("hidden", g !== "dice");
            if (g === "dice" && dicePick.dataset.built !== "1") {
                dicePick.dataset.built = "1";
                for (let i = 1; i <= 6; i++) {
                    const b = document.createElement("button");
                    b.textContent = i;
                    b.addEventListener("click", () => {
                        selectedDice = i;
                        dicePick.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
                        b.classList.add("selected");
                        Sfx.click();
                    });
                    dicePick.appendChild(b);
                }
            }
        }

        const sidePick = $("sidePick");
        if (sidePick) sidePick.classList.toggle("hidden", g !== "coinflip");

        const minesPick = $("minesPick");
        if (minesPick) minesPick.classList.toggle("hidden", g !== "mines");

        const roulettePick = $("roulettePick");
        if (roulettePick) roulettePick.classList.toggle("hidden", g !== "roulette");

        const trumpRow = $("trumpRow");
        if (trumpRow) trumpRow.classList.toggle("hidden", g !== "slots");
        let footballInfo=$("footballDuelInfo");
        if(!footballInfo){footballInfo=document.createElement("div");footballInfo.id="footballDuelInfo";gameSelect.parentElement.after(footballInfo);}
        footballInfo.classList.toggle("hidden",g!=="football");
        if(g==="football"&&!duel?.footballTeams){
            footballInfo.replaceChildren();
            const link=document.createElement("a");link.href="football.html?mode=duel";link.className="football-link";link.textContent="Montar elenco";footballInfo.append(link);
        }
    }

    if (gameSelect) {
        gameSelect.addEventListener("change", () => {
            renderGameChoice();
            Sfx.click();
        });
    }

    // moeda: cara/coroa
    const sidePick = $("sidePick");
    if (sidePick) {
        sidePick.querySelectorAll("button").forEach((b) => {
            b.addEventListener("click", () => {
                selectedSide = b.dataset.side;
                sidePick.querySelectorAll("button").forEach((x) => x.classList.remove("selected"));
                b.classList.add("selected");
                Sfx.click();
            });
        });
    }

    // ---------- TRUNFOS (inventário) ----------
    async function loadTrumps() {
        const sel = $("trumpSelect");
        if (!sel || !ArcadiaAPI.isLoggedIn()) return;
        try {
            const data = await ArcadiaAPI.request("/api/games/slots/cards");
            inventory = data.inventory || [];
            sel.innerHTML = '<option value="">— Nenhum —</option>';
            inventory.forEach((c) => {
                const opt = document.createElement("option");
                opt.value = c.key;
                opt.textContent = `${c.name} (x${c.qty})`;
                sel.appendChild(opt);
            });
        } catch (_) {}
    }

    // ---------- AÇÕES ----------
    $("createDuelBtn").addEventListener("click", async () => {
        if (!ArcadiaAPI.isLoggedIn()) return alert("Entre na sua conta primeiro!");
        await connect();
        socket.emit("duel:create", {}, (r) => {
            if (r.ok) { duel = r.duel; render(duel); }
            else alert(r.error);
        });
    });

    $("joinDuelBtn").addEventListener("click", async () => {
        if (!ArcadiaAPI.isLoggedIn()) return alert("Entre na sua conta primeiro!");
        await connect();
        socket.emit("duel:join", { code: $("joinCode").value }, (r) => {
            if (r.ok) { duel = r.duel; render(duel); }
            else alert(r.error);
        });
    });

    $("readyBtn").addEventListener("click", () => {
        socket.emit("duel:ready", {}, (r) => { if (!r.ok) alert(r.error); });
    });

    // Iniciar: host confirma o início quando ambos estão prontos (mesmo evento ready)
    const startBtn = $("startBtn");
    if (startBtn) {
        startBtn.addEventListener("click", () => {
            socket.emit("duel:ready", {}, (r) => { if (!r.ok) alert(r.error); });
        });
    }

    $("playBtn").addEventListener("click", () => {
        if (duel?.activePlay || liveAnimating || actionPending) return;
        const g = gameSelect ? gameSelect.value : "dice";
        const choice = {};

        if (g === "dice") {
            if (!selectedDice) return alert("Escolha um número!");
            choice.number = selectedDice;
        } else if (g === "coinflip") {
            if (!selectedSide) return alert("Escolha um lado!");
            choice.side = selectedSide;
        } else if (g === "crash") {
            choice.autoCashout = $("crashTarget").value === "" ? null : Number($("crashTarget").value);
        } else if (g === "mines") {
            choice.mines = Number($("minesCount").value);
        } else if (g === "roulette") {
            choice.bet = $("rouletteBet") ? $("rouletteBet").value : "red";
        } else if (g === "slots") {
            const trump = $("trumpSelect") ? $("trumpSelect").value : "";
            if (trump) choice.trump = trump;
        }

        sendAction("duel:play", { allWin: ArcadiaWallet.isAllWin(), game: g, wager: Number($("wager").value), choice });
    });
    $("cashoutBtn").addEventListener("click", () => sendAction("duel:cashout"));
    for (const [id, action] of [["duelHit","hit"],["duelStand","stand"],["duelDouble","double"]]) $(id).addEventListener("click", () => sendAction("duel:" + action));

    // ---------- INIT ----------
    (async () => {
        await ArcadiaAPI.ready;
        if (preferredGame && gameSelect) gameSelect.value = preferredGame;
        renderGameChoice();
        await loadTrumps();
        await bjTrumps.refresh();
        await ArcadiaAPI.ready;
        if (ArcadiaAPI.isLoggedIn()) {
            await ArcadiaWallet.refresh();
            if (sessionStorage.getItem("arcadia_duel")) await connect();
            $("walletBalance").textContent = ArcadiaWallet.format(ArcadiaWallet.getCached());
        }
    })();
})();
