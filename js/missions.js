(() => {
    const $ = (id) => document.getElementById(id);
    const categories = { login: "Login", play: "Partidas", win: "Vit\u00f3rias", game: "Jogos", wager: "Apostas", social: "Multiplayer" };
    const games = { coinflip: "coinflip.html", dice: "dice.html", mines: "mines.html", blackjack: "blackjack.html", "blackjack-mp": "blackjack-mp.html", roulette: "roulette.html", slots: "slots.html", crash: "crash.html", plinko: "plinko.html" };
    let data = null, cadence = "daily", loading = false, claiming = false, resetTimer = null;
    const number = (value) => Number(value).toLocaleString("pt-BR");
    const status = (text) => { $("missionsStatus").textContent = text; };
    function render() {
        if (!data) return;
        const period = data.missions.filter((m) => m.cadence === cadence);
        const ready = period.filter((m) => m.completed && !m.claimed);
        $("missionCompleted").textContent = period.filter((m) => m.completed).length + " / " + period.length;
        $("missionReward").textContent = number(ready.reduce((total, m) => total + m.xp, 0)) + " XP + " + number(ready.reduce((total, m) => total + m.ac, 0)) + " AC / carteira";
        const reset = new Date(data.resetsAt[cadence]);
        $("missionReset").textContent = "Renova em " + reset.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        $("missionPeriodCount").textContent = period.length + " " + (cadence === "daily" ? "di\u00e1rias" : "semanais");
        const visible = period.filter((m) => ($("missionCategory").value === "all" || m.category === $("missionCategory").value) && (!$("missionHideClaimed").checked || !m.claimed));
        visible.sort((a, b) => Number(b.completed && !b.claimed) - Number(a.completed && !a.claimed) || Number(a.claimed) - Number(b.claimed));
        $("missionsList").replaceChildren();
        for (const mission of visible) {
            const card = document.createElement("article"); card.className = "mission-card";
            card.dataset.state = mission.claimed ? "claimed" : mission.completed ? "ready" : "active";
            const head = document.createElement("div"); head.className = "mission-card-head";
            const category = document.createElement("span"), reward = document.createElement("strong");
            category.textContent = categories[mission.category] || "Miss\u00e3o"; reward.textContent = "+" + mission.xp + " XP + " + number(mission.ac) + " AC / carteira";
            head.append(category, reward);
            const title = document.createElement("h2"); title.textContent = mission.desc;
            const labels = document.createElement("div"); labels.className = "mission-progress-label";
            const count = document.createElement("span"), state = document.createElement("span");
            count.textContent = number(mission.progress) + " / " + number(mission.target) + (mission.unit ? " " + mission.unit : "");
            state.textContent = mission.claimed ? "Resgatada" : mission.completed ? "Conclu\u00edda" : "Em progresso";
            labels.append(count, state);
            const progress = document.createElement("progress"); progress.max = mission.target; progress.value = mission.progress; progress.setAttribute("aria-label", mission.desc);
            const footer = document.createElement("footer"), button = document.createElement("button"); button.type = "button";
            button.textContent = mission.claimed ? "Resgatada" : "Resgatar";
            button.disabled = !mission.completed || mission.claimed || claiming || loading;
            button.addEventListener("click", () => claim(mission));
            const link = document.createElement("a");
            link.href = mission.mode === "coop" ? "rooms.html" : mission.mode === "duel" ? "duel.html" : games[mission.game] || "games.html";
            if (mission.game === "coinflip" && mission.mode) link.href += "?game=coinflip";
            link.textContent = "Jogar";
            if (mission.category !== "login") footer.appendChild(link);
            footer.appendChild(button); card.append(head, title, labels, progress, footer); $("missionsList").appendChild(card);
        }
        if (!visible.length) status("Nenhuma miss\u00e3o neste filtro.");
    }
    function guest() {
        clearTimeout(resetTimer); data = null; $("missionsList").replaceChildren();
        $("missionsLogin").classList.remove("hidden");
        for (const id of ["missionLevel", "missionCompleted", "missionReward", "missionReset", "missionPeriodCount", "missionXPText"]) $(id).textContent = "--";
        $("missionXP").value = 0;
        status("Entre na sua conta para ver suas miss\u00f5es.");
    }
    async function load() {
        if (loading) return;
        if (!ArcadiaAPI.isLoggedIn()) {
            return guest();
        }
        const userId = ArcadiaAPI.getUser().id;
        loading = true; $("missionsRefresh").disabled = true; $("missionPanel").setAttribute("aria-busy", "true");
        render();
        try {
            const missions = await ArcadiaAPI.request("/api/progression/missions");
            const me = await ArcadiaAPI.me();
            if (ArcadiaAPI.getUser()?.id !== userId) return;
            data = missions;
            clearTimeout(resetTimer);
            const expiry = Math.min(...Object.values(data.resetsAt).map((value) => Date.parse(value)));
            resetTimer = setTimeout(load, Math.max(250, expiry - Date.parse(data.serverTime) + 100));
            $("missionLevel").textContent = me.user.level;
            const max = me.user.xpNext;
            $("missionXP").max = max; $("missionXP").value = me.user.xp;
            $("missionXPText").textContent = number(me.user.xp) + " / " + number(max) + " XP";
            $("missionsLogin").classList.add("hidden"); status(""); render();
        } catch (error) { status(error.message); }
        finally { loading = false; $("missionsRefresh").disabled = claiming; $("missionPanel").removeAttribute("aria-busy"); render(); }
    }
    async function claim(mission) {
        if (claiming || loading) return;
        claiming = true; $("missionsRefresh").disabled = true; render();
        let resultMessage = "";
        try {
            const result = await ArcadiaAPI.request("/api/progression/missions/claim", { method: "POST", body: JSON.stringify({ missionKey: mission.key, period: mission.period }) });
            resultMessage = result.message;
        } catch (error) { resultMessage = error.message; }
        finally { claiming = false; await load(); status(resultMessage); }
    }
    function selectTab(tab) {
        cadence = tab.dataset.cadence;
        document.querySelectorAll(".mission-tabs button").forEach((button) => { button.setAttribute("aria-selected", String(button === tab)); button.tabIndex = button === tab ? 0 : -1; });
        $("missionPanel").setAttribute("aria-labelledby", tab.id);
        status(""); render();
    }
    document.querySelectorAll(".mission-tabs button").forEach((button) => {
        button.addEventListener("click", () => selectTab(button));
        button.addEventListener("keydown", (event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const tab = $(event.key === "Home" ? "dailyTab" : event.key === "End" ? "weeklyTab" : cadence === "daily" ? "weeklyTab" : "dailyTab");
            selectTab(tab); tab.focus();
        });
    });
    for (const id of ["missionCategory", "missionHideClaimed"]) $(id).addEventListener("change", () => { status(""); render(); });
    $("missionsRefresh").addEventListener("click", load);
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !claiming) load(); });
    document.addEventListener("arcadia:session", () => {
        if (!ArcadiaAPI.isLoggedIn()) guest();
    });
    (async () => { await ArcadiaAPI.ready; await load(); })();
})();
