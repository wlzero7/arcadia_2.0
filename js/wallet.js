const ArcadiaWallet = (() => {
    const kind = /\/(rooms|racing|blackjack-mp)\.html$/.test(location.pathname) ? "coop" : /\/duel\.html$/.test(location.pathname) || (location.pathname.endsWith("/football.html") && new URLSearchParams(location.search).get("mode") === "duel") ? "duel" : "solo";
    const allWin = new Set();
    let poolBalance = 0;
    let battleCapital = null;
    function setBattleCapital(value) {
        battleCapital = Number.isSafeInteger(value) && value >= 0 ? value : null;
        const input = document.getElementById("wager");
        if (input && battleCapital !== null && isAllWin()) input.value = battleCapital;
        const button = input?.nextElementSibling;
        if (button?.classList.contains("all-win-button")) button.title = battleCapital !== null ? "Apostar todo o capital da batalha" : "Apostar todo o saldo da carteira";
    }
    function setPoolBalance(value) {
        poolBalance = value;
        const input = document.getElementById("mpBet");
        if (input && isAllWin("mpBet")) input.value = value;
    }
    function isAllWin(id) { return allWin.has(id || "main"); }
    function installAllWin() {
        for (const id of ["betAmount", "coinWager", "wager", "mpBet", "stakeAmount", "bjWager"]) {
            const input = document.getElementById(id);
            if (!input) continue;
            if (input.dataset.allWinControl) {
                const button = input.nextElementSibling;
                if (button?.classList.contains("all-win-button") && button.disabled !== input.disabled) button.disabled = input.disabled;
                continue;
            }
            input.dataset.allWinControl = "true";
            const key = ["mpBet", "stakeAmount", "bjWager"].includes(id) ? id : "main";
            allWin.delete(key);
            const button = document.createElement("button");
            button.type = "button"; button.className = "btn btn-outline all-win-button"; button.textContent = "All Win";
            button.setAttribute("aria-pressed", "false");
            button.disabled = input.disabled;
            button.title = id === "mpBet" ? "Apostar todo o pote compartilhado" : id === "wager" && battleCapital !== null ? "Apostar todo o capital da batalha" : "Apostar todo o saldo da carteira";
            button.addEventListener("click", () => {
                const selected = !allWin.has(key);
                if (selected) { allWin.add(key); input.removeAttribute("max"); input.min = "1"; input.value = id === "mpBet" ? poolBalance : id === "wager" && battleCapital !== null ? battleCapital : getCached(); }
                else allWin.delete(key);
                button.setAttribute("aria-pressed", String(selected));
                input.dispatchEvent(new Event("change", { bubbles: true }));
            });
            input.addEventListener("input", () => { allWin.delete(key); button.setAttribute("aria-pressed", "false"); });
            input.parentElement.style.flexWrap = "wrap";
            input.after(button);
        }
        const spin = location.pathname.endsWith("roulette.html") && document.getElementById("spinBtn");
        if (spin && !document.getElementById("rouletteAllWin")) {
            const button = document.createElement("button");
            button.id = "rouletteAllWin"; button.type = "button"; button.className = "btn btn-outline btn-block all-win-button"; button.textContent = "All Win";
            button.title = "Apostar todo o saldo da carteira em uma unica aposta";
            button.setAttribute("aria-pressed", "false");
            button.addEventListener("click", () => { if (isAllWin()) allWin.delete("main"); else allWin.add("main"); button.setAttribute("aria-pressed", String(isAllWin())); document.dispatchEvent(new Event("arcadia:all-win")); });
            spin.before(button);
        }
    }
    let pending = null;
    const cacheKey = () => "arcadia_wallet_" + (ArcadiaAPI.getUser()?.id || "guest") + "_" + kind;
    function format(value) { return (Number(value) || 0).toLocaleString("pt-BR") + " AC"; }
    function getCached() {
        if (!ArcadiaAPI.isLoggedIn()) return 0;
        const value = Number(localStorage.getItem(cacheKey()));
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }
    function setCached(value) {
        if (!Number.isSafeInteger(value) || value < 0) return getCached();
        if (ArcadiaAPI.isLoggedIn()) localStorage.setItem(cacheKey(), String(value));
        document.dispatchEvent(new CustomEvent("arcadia:balance", { detail: { balance: value, kind } }));
        return value;
    }
    async function refresh() {
        await ArcadiaAPI.ready;
        if (!ArcadiaAPI.isLoggedIn()) return 0;
        if (pending) return pending;
        pending = ArcadiaAPI.wallet(kind).then((data) => setCached(data.balance))
            .catch((err) => { console.warn("Saldo:", err.message); return getCached(); })
            .finally(() => { pending = null; });
        return pending;
    }
    async function daily() { const data = await ArcadiaAPI.daily(); await refresh(); return data; }
    document.addEventListener("arcadia:balance", (event) => {
        for (const id of ["walletBalance", "homeWalletBalance"]) {
            const element = document.getElementById(id);
            if (element) element.textContent = format(event.detail.balance);
        }
    });
    document.addEventListener("DOMContentLoaded", () => {
        refresh(); installAllWin();
        new MutationObserver(installAllWin).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    });
    return { format, getCached, setCached, refresh, daily, kind, isAllWin, setPoolBalance, setBattleCapital };
})();
window.ArcadiaWallet = ArcadiaWallet;
