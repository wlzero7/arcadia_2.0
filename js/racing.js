// ========================================
// ARCADIA RACING — cliente multiplayer (v1.1)
// v1.1: barra de aposta própria (valor + confirmar), seleção clara
// do cavalo e guards contra elementos ausentes
// ========================================

(() => {

    const $ = (id) => document.getElementById(id);

    let socket = null;
    let race = null;
    let selectedHorse = null;

    function connect() {
        return new Promise((resolve, reject) => {
            if (socket && socket.connected) return resolve(socket);
            socket = io(API_URL, { auth: { token: ArcadiaAPI.getToken() } });
            socket.on("connect", () => {
                const saved = sessionStorage.getItem("arcadia_race");
                if (saved) socket.emit("race:join", { code: saved }, (result) => {
                    if (!result.ok) sessionStorage.removeItem("arcadia_race");
                });
                resolve(socket);
            });
            socket.on("connect_error", (e) => reject(e));

            socket.on("race:state", (r) => {
                sessionStorage.setItem("arcadia_race", r.code);
                race = r;
                render(r);
            });

            socket.on("race:tick", (t) => {
                if (t.horses[0] && t.horses[0].progress < 5) Sfx.horse();
                t.horses.forEach((h) => {
                    const bar = document.querySelector(`#lane-${h.id} .lane-bar div`);
                    const horse = document.querySelector(`#lane-${h.id} .lane-horse`);
                    if (bar) bar.style.width = h.progress + "%";
                    if (horse) horse.style.left = `calc(${h.progress}% - ${h.progress * 1.2}px)`;
                });
            });

            socket.on("race:finished", (f) => {
                const me = ArcadiaAPI.getUser();
                if (f.payouts.some((p) => p.userId === (me || {}).id)) Sfx.raceWin(); else Sfx.lose();
                const res = $("raceResults");
                if (!res) return;
                res.classList.remove("hidden");
                const mine = f.payouts.find((p) => p.userId === (me || {}).id);
                res.innerHTML = `🏆 <strong>${f.winner.emoji} ${f.winner.name}</strong> venceu! (${f.odds}x)` +
                    (mine ? ` — Você ganhou ${mine.payout.toLocaleString("pt-BR")} AC! 🎉` : "");
                if (mine) ArcadiaWallet.refresh();
            });
        });
    }

    // ---------- BARRA DE APOSTA (injeta se o HTML não tiver) ----------
    function ensureBetBar() {
        if ($("betAmount") && $("betBtn")) return; // HTML já tem
        const wrap = $("raceWrap");
        if (!wrap || $("raceBetBar")) return;
        const bar = document.createElement("div");
        bar.id = "raceBetBar";
        bar.className = "race-bet-bar";
        bar.innerHTML = `
            <input type="number" id="betAmount" value="100" min="10" placeholder="Aposta (AC)">
            <button class="btn btn-primary" id="betBtn">💰 Confirmar aposta</button>
        `;
        wrap.appendChild(bar);
    }

    function bindBetButton() {
        const betBtn = $("betBtn");
        if (!betBtn || betBtn.dataset.bound === "1") return;
        betBtn.dataset.bound = "1";
        betBtn.addEventListener("click", () => {
            if (selectedHorse === null) return alert("Selecione um cavalo primeiro (clique em Apostar na pista)!");
            const amount = Number($("betAmount").value);
            if (!ArcadiaWallet.isAllWin() && (!Number.isFinite(amount) || amount < 10)) return alert("Aposta mínima: 10 AC.");
            socket.emit("race:bet", { allWin: ArcadiaWallet.isAllWin(), horseId: selectedHorse, amount }, (r) => {
                if (!r.ok) alert(r.error);
                else {
                    Sfx.chip();
                    ArcadiaWallet.refresh();
                }
            });
        });
    }

    function render(r) {
        $("raceWrap").classList.remove("hidden");
        $("raceCode").textContent = r.code;
        $("racePot").textContent = (r.pot || 0).toLocaleString("pt-BR") + " AC";

        const me = ArcadiaAPI.getUser();
        const roster = $("racePlayers");
        roster.replaceChildren();
        for (const player of r.players || []) {
            const item = document.createElement("li");
            if (!player.online) item.className = "offline";
            const identity = document.createElement("span"); identity.className = "player-identity";
            const avatar = document.createElement("span"); avatar.className = "player-avatar";
            ArcadiaAvatar.render(avatar, player.avatar, player.displayName || player.username);
            const name = document.createElement("span"); name.textContent = (player.displayName || player.username) + (player.id === me?.id ? " (você)" : "");
            identity.append(avatar, name);
            const stake = document.createElement("span"); stake.className = "player-stake"; stake.textContent = ArcadiaWallet.format(player.stake);
            item.append(identity, stake); roster.append(item);
        }
        if (r.phase === "racing" && r.serverTime - r.startedAt < 3500) ArcadiaBattle.present($("raceBattleIntro"), r.code + ":" + r.round, (r.players || []).filter((player) => player.stake > 0));
        const isHost = me && r.hostId === me.id;
        $("startRaceBtn").classList.toggle("hidden", !(isHost && r.phase === "betting"));
        $("betRow").classList.toggle("hidden", r.phase !== "betting");
        $("cancelBetBtn").disabled = r.phase !== "betting" || !(r.bets || []).some((b) => b.userId === (me || {}).id);
        if (r.phase === "betting") $("raceResults").classList.add("hidden");

        ensureBetBar();
        bindBetButton();
        const betBar = $("raceBetBar");
        if (betBar) betBar.classList.toggle("hidden", r.phase !== "betting");

        // pista
        const track = $("raceTrack");
        track.innerHTML = "";
        r.horses.forEach((h) => {
            const lane = document.createElement("div");
            lane.className = "race-lane";
            lane.id = `lane-${h.id}`;
            if (selectedHorse === h.id) lane.classList.add("selected");
            const odds = r.odds.find((o) => o.id === h.id);
            const myBet = (r.bets || []).find((b) => b.userId === (me || {}).id && b.horseId === h.id);
            lane.innerHTML = `
                <div class="lane-horse" style="left:0">${h.emoji} <span class="lane-name">${h.name}</span> <span class="lane-odds">${odds ? odds.mult + "x" : ""}</span></div>
                <div class="lane-bar"><div style="width:0%"></div></div>
                ${r.phase === "betting" ? `<div class="lane-pick"><button data-horse="${h.id}" class="${selectedHorse === h.id ? "selected" : ""}">${myBet ? "✓ " : ""}Apostar</button></div>` : ""}
            `;
            track.appendChild(lane);
        });

        track.querySelectorAll("[data-horse]").forEach((b) => {
            b.addEventListener("click", () => {
                selectedHorse = Number(b.dataset.horse);
                track.querySelectorAll(".race-lane").forEach((l) => l.classList.remove("selected"));
                b.closest(".race-lane").classList.add("selected");
                track.querySelectorAll("[data-horse]").forEach((x) => x.classList.remove("selected"));
                b.classList.add("selected");
                Sfx.click();
            });
        });

        // minhas apostas
        const myBets = $("myBets");
        const mine = (r.bets || []).filter((b) => b.userId === (me || {}).id);
        myBets.innerHTML = mine.length === 0
            ? '<span class="muted">Nenhuma aposta ainda.</span>'
            : mine.map((b) => {
                const h = r.horses.find((x) => x.id === b.horseId);
                return `<div class="bet-entry"><span>${h ? h.emoji + " " + h.name : "?"}</span><span>${(b.amount || 0).toLocaleString("pt-BR")} AC</span></div>`;
            }).join("");
    }

    $("createRaceBtn").addEventListener("click", async () => {
        if (!ArcadiaAPI.isLoggedIn()) return alert("Entre na sua conta primeiro!");
        await connect();
        socket.emit("race:create", {}, (r) => {
            if (r.ok) { race = r.race; render(race); }
        });
    });

    $("joinRaceBtn").addEventListener("click", async () => {
        if (!ArcadiaAPI.isLoggedIn()) return alert("Entre na sua conta primeiro!");
        await connect();
        socket.emit("race:join", { code: $("joinCode").value }, (r) => {
            if (r.ok) { race = r.race; render(race); }
            else alert(r.error);
        });
    });

    $("startRaceBtn").addEventListener("click", () => {
        socket.emit("race:start", {}, (r) => { if (!r.ok) alert(r.error); });
    });
    $("cancelBetBtn").addEventListener("click", () => {
        if (!socket?.connected) return;
        $("cancelBetBtn").disabled = true;
        socket.emit("race:withdraw", {}, (result) => {
            if (!result.ok) { alert(result.error); if (race) render(race); }
            else ArcadiaWallet.refresh();
        });
    });

    (async () => {
        await ArcadiaAPI.ready;
        if (ArcadiaAPI.isLoggedIn()) {
            await ArcadiaWallet.refresh();
            if (sessionStorage.getItem("arcadia_race")) await connect();
            $("walletBalance").textContent = ArcadiaWallet.format(ArcadiaWallet.getCached());
        }
    })();
})();
