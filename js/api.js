window.API_URL = window.location.origin;
const ArcadiaAPI = (() => {
    const USER_KEY = "arcadia_user";
    const TOKEN_KEY = "arcadia_token";
    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function getUser() {
        try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (_) { return null; }
    }
    function clearSession() {
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(TOKEN_KEY);
        for (const key of Object.keys(localStorage)) if (key.startsWith("arcadia_wallet")) localStorage.removeItem(key);
        document.dispatchEvent(new CustomEvent("arcadia:session"));
    }
    function setSession(data) {
        if (getUser()?.id !== data.user.id) clearSession();
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        // New tokens are kept in an HttpOnly cookie; migrate legacy tokens after /me.
        localStorage.removeItem(TOKEN_KEY);
        document.dispatchEvent(new CustomEvent("arcadia:session"));
        return data;
    }
    function isLoggedIn() { return !!getUser(); }
    async function request(path, options = {}) {
        if (path.startsWith("/api/games/") && options.body && window.ArcadiaWallet?.isAllWin()) {
            const body = JSON.parse(options.body);
            if (Object.hasOwn(body, "wager") || Object.hasOwn(body, "bets")) options = { ...options, body: JSON.stringify({ ...body, allWin: true }) };
        }
        const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
        const token = getToken();
        if (token) headers.Authorization = "Bearer " + token;
        const response = await fetch(window.API_URL + path, { ...options, headers, credentials: "same-origin" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401 && path !== "/api/auth/login") clearSession();
            const error = new Error(data.message || "Erro " + response.status);
            error.status = response.status;
            throw error;
        }
        return data;
    }
    async function logout() {
        await request("/api/auth/logout", { method: "POST" });
        clearSession();
    }
    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }
    const api = {
        getToken, getUser, setSession, isLoggedIn, logout, request, escapeHtml,
        register: (username, email, password) => request("/api/auth/register", { method: "POST", body: JSON.stringify({ username, email, password }) }).then(setSession),
        login: (email, password) => request("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }).then(setSession),
        me: () => request("/api/auth/me"),
        play: (game, wager, choice) => request("/api/games/" + game + "/play", { method: "POST", body: JSON.stringify({ wager, choice }) }),
        wallet: (kind = "solo") => request("/api/wallet?kind=" + encodeURIComponent(kind)),
        transactions: () => request("/api/wallet/transactions"),
        daily: () => request("/api/wallet/daily", { method: "POST" }),
        transfer: (toUsername, amount) => request("/api/wallet/transfer", { method: "POST", body: JSON.stringify({ toUsername, amount }) }),
        history: () => request("/api/games/history"),
        stats: () => request("/api/games/stats"),
    };
    api.ready = api.me().then(setSession).catch((err) => {
        if (err.status !== 401) console.warn("Sessão:", err.message);
    });
    return api;
})();
window.ArcadiaAPI = ArcadiaAPI;
document.addEventListener("DOMContentLoaded", async () => {
    const nav = document.querySelector(".nav-links");
    if (nav && !nav.querySelector('a[href="missoes.html"]')) {
        const item = document.createElement("li"), link = document.createElement("a");
        link.href = "missoes.html"; link.textContent = "Missões";
        item.appendChild(link);
        nav.insertBefore(item, nav.querySelector('a[href="perfil.html"]')?.parentElement || null);
    }
    await ArcadiaAPI.ready;
    if (location.pathname.endsWith("index.html") || location.pathname === "/") return;
    const actions = document.querySelector(".nav-actions");
    if (!actions) return;
    const link = document.createElement("a");
    link.className = "btn btn-outline";
    if (ArcadiaAPI.isLoggedIn()) { link.href = "perfil.html"; link.textContent = "Minha conta"; }
    else { link.href = "index.html?login=1&return=" + encodeURIComponent(location.pathname + location.search); link.textContent = "Entrar"; }
    actions.appendChild(link);
});
