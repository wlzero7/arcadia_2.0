const ArcadiaWallet = (() => {
    const kind = /\/(rooms|racing)\.html$/.test(location.pathname) ? "coop" : /\/duel\.html$/.test(location.pathname) ? "duel" : "solo";
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
    document.addEventListener("DOMContentLoaded", () => refresh());
    return { format, getCached, setCached, refresh, daily, kind };
})();
window.ArcadiaWallet = ArcadiaWallet;
