(() => {
    const $ = (id) => document.getElementById(id);
    let busy = false, active = false;
    function cards(id, hand) {
        $(id).replaceChildren();
        for (const card of hand) {
            const div = document.createElement("div");
            div.className = "card" + (card.hidden ? " back" : ["♥", "♦"].includes(card.suit) ? " red" : "");
            if (!card.hidden) {
                const rank = document.createElement("span"), suit = document.createElement("span");
                rank.textContent = card.rank; suit.textContent = card.suit; suit.className = "suit";
                div.append(rank, suit);
            }
            $(id).appendChild(div);
        }
    }
    function render(data) {
        active = !data.finished;
        cards("playerCards", data.player); cards("dealerCards", data.dealer);
        $("playerTotal").textContent = data.playerTotal;
        $("dealerTotal").textContent = data.dealerTotal + (active ? "+?" : "");
        $("gameMessage").textContent = data.message || "Comprar, parar ou dobrar?";
        $("gameMessage").className = "bj-message " + (data.outcome === "win" ? "win" : data.outcome === "loss" ? "loss" : "");
        $("betRow").classList.add("hidden");
        $("actionRow").classList.toggle("hidden", !active);
        $("newRoundBtn").classList.toggle("hidden", active);
        $("doubleBtn").disabled = !data.canDouble;
        if (Number.isSafeInteger(data.balance)) ArcadiaWallet.setCached(data.balance);
    }
    async function action(name, body) {
        if (busy) return;
        await ArcadiaAPI.ready;
        if (!ArcadiaAPI.isLoggedIn()) { $("gameMessage").textContent = "Entre na sua conta para jogar."; return; }
        busy = true;
        let canDouble = !$("doubleBtn").disabled;
        for (const id of ["dealBtn", "hitBtn", "standBtn", "doubleBtn"]) $(id).disabled = true;
        try {
            const data = await ArcadiaAPI.request("/api/games/blackjack/" + name, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
            render(data); canDouble = data.canDouble; Sfx.card();
        } catch (err) {
            $("gameMessage").textContent = err.message;
            try {
                const state = await ArcadiaAPI.request("/api/games/blackjack/state");
                if (state.active) { render(state); canDouble = state.canDouble; }
                else if (active) { active = false; $("actionRow").classList.add("hidden"); $("newRoundBtn").classList.remove("hidden"); }
            } catch (_) {}
        } finally {
            busy = false;
            for (const id of ["dealBtn", "hitBtn", "standBtn"]) $(id).disabled = false;
            $("doubleBtn").disabled = !active || !canDouble;
        }
    }
    $("dealBtn").addEventListener("click", () => action("start", { wager: Number($("betAmount").value) }));
    $("hitBtn").addEventListener("click", () => action("hit"));
    $("standBtn").addEventListener("click", () => action("stand"));
    $("doubleBtn").addEventListener("click", () => action("double"));
    $("newRoundBtn").addEventListener("click", () => {
        $("dealerCards").replaceChildren(); $("playerCards").replaceChildren();
        $("dealerTotal").textContent = ""; $("playerTotal").textContent = "";
        $("newRoundBtn").classList.add("hidden"); $("betRow").classList.remove("hidden");
        $("gameMessage").textContent = "Faça sua aposta.";
    });
    (async () => {
        await ArcadiaAPI.ready;
        if (ArcadiaAPI.isLoggedIn()) {
            await ArcadiaWallet.refresh();
            const state = await ArcadiaAPI.request("/api/games/blackjack/state").catch(() => null);
            if (state?.active) render(state);
        }
    })();
})();
