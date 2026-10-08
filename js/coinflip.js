(() => {
    const $ = (id) => document.getElementById(id);
    let busy = false, played = 0, wins = 0;
    const label = (side) => side === "heads" ? "Cara" : "Coroa";
    const message = (text, outcome = "") => { $("coinMessage").textContent = text; $("coinMessage").dataset.outcome = outcome; };
    function lock(value) {
        $("coinPlay").disabled = value || !ArcadiaAPI.isLoggedIn();
        $("coinWager").disabled = value;
        document.querySelectorAll('input[name="side"]').forEach((input) => { input.disabled = value; });
    }
    $("coinForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy) return;
        if (!ArcadiaAPI.isLoggedIn()) return message("Entre na sua conta para jogar.");
        const wager = Number($("coinWager").value), side = document.querySelector('input[name="side"]:checked').value;
        if (!ArcadiaWallet.isAllWin() && (!Number.isSafeInteger(wager) || wager < 10 || wager > 1000000)) return message("Aposta inteira de 10 a 1.000.000 AC.");
        const userId = ArcadiaAPI.getUser().id;
        busy = true; lock(true); message("Lan\u00e7ando moeda...");
        $("coinFace").classList.add("flipping");
        Sfx.coin();
        try {
            const result = await ArcadiaAPI.play("coinflip", wager, { side });
            await new Promise((resolve) => setTimeout(resolve, 650));
            if (ArcadiaAPI.getUser()?.id !== userId) return;
            $("coinFace").src = "css/coin-" + result.detail.flip + ".svg";
            $("coinFace").alt = "Moeda: " + label(result.detail.flip);
            ArcadiaWallet.setCached(result.balance);
            const won = result.outcome === "win", net = result.payout - wager;
            message(label(result.detail.flip) + ". " + (won ? "Voc\u00ea venceu! Pr\u00eamio: " + ArcadiaWallet.format(result.payout) : "Voc\u00ea perdeu " + ArcadiaWallet.format(wager)) + ".", result.outcome);
            if (won) Sfx.win(); else Sfx.lose();
            if (played === 0) $("coinHistory").replaceChildren();
            played++; if (won) wins++;
            $("coinCount").textContent = played; $("coinWins").textContent = wins;
            const row = document.createElement("li"), title = document.createElement("span"), value = document.createElement("strong");
            title.textContent = label(result.detail.flip) + " / escolheu " + label(side);
            value.textContent = (net > 0 ? "+" : "") + ArcadiaWallet.format(net);
            value.className = won ? "win" : "loss";
            row.append(title, value); $("coinHistory").prepend(row);
            if ($("coinHistory").children.length > 20) $("coinHistory").lastElementChild.remove();
        } catch (error) {
            message(error.message + (error.status ? "" : " Confira seu saldo e historico antes de tentar novamente."));
            await ArcadiaWallet.refresh();
        } finally {
            $("coinFace").classList.remove("flipping"); busy = false; lock(false);
        }
    });
    document.addEventListener("arcadia:session", () => { if (!busy) lock(false); });
    (async () => {
        await ArcadiaAPI.ready;
        lock(false); $("coinLogin").classList.toggle("hidden", ArcadiaAPI.isLoggedIn());
        message(ArcadiaAPI.isLoggedIn() ? "" : "Entre na sua conta para jogar.");
    })();
})();
