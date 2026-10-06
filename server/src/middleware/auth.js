const jwt = require("jsonwebtoken");
const pool = require("../config/database");
if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) throw new Error("JWT_SECRET is required in production.");
const JWT_SECRET = process.env.JWT_SECRET || "arcadia-dev-secret";
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 7 * 86400000 };
const sessionSockets = new Map();
function disconnectUserSockets(userId) {
    for (const socket of [...(sessionSockets.get(userId) || [])]) socket.disconnect(true);
    sessionSockets.delete(userId);
}
function issueSession(res, user) {
    const token = jwt.sign({ id: user.id, username: user.username, v: user.token_version || 0 }, JWT_SECRET, { expiresIn: "7d" });
    res.cookie("arcadia_token", token, cookieOptions);
}
function verifySession(token) {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    const user = pool.db.get("SELECT id, username, token_version FROM users WHERE id = ?", [payload.id]);
    if (!user || user.username !== payload.username || (payload.v || 0) !== user.token_version) throw new Error("Sessão inválida.");
    return user;
}
function authenticate(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.cookies?.arcadia_token;
    if (!token) return res.status(401).json({ status: "error", message: "Não autenticado." });
    try { req.user = verifySession(token); next(); }
    catch (_) { res.status(401).json({ status: "error", message: "Sessão expirada. Faça login novamente." }); }
}
function authenticateSocket(socket, next) {
    try {
        const cookies = Object.fromEntries(String(socket.handshake.headers.cookie || "").split(";").filter((s) => s.includes("=")).map((s) => {
            const i = s.indexOf("="); return [s.slice(0, i).trim(), decodeURIComponent(s.slice(i + 1))];
        }));
        const user = verifySession(socket.handshake.auth?.token || cookies.arcadia_token);
        socket.userId = user.id;
        socket.username = user.username;
        if (!sessionSockets.has(user.id)) sessionSockets.set(user.id, new Set());
        sessionSockets.get(user.id).add(socket);
        socket.on("disconnect", () => {
            const sessions = sessionSockets.get(user.id);
            sessions?.delete(socket);
            if (!sessions?.size) sessionSockets.delete(user.id);
        });
        socket.use((packet, done) => {
            try { verifySession(socket.handshake.auth?.token || cookies.arcadia_token); done(); }
            catch (_) { socket.disconnect(true); done(new Error("Sessão expirada.")); }
        });
        next();
    } catch (_) { next(new Error("Sessão inválida. Faça login novamente.")); }
}
module.exports = { authenticate, authenticateSocket, verifySession, JWT_SECRET, issueSession, cookieOptions, disconnectUserSockets, sessionSockets };
