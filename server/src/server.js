// ========================================
// ARCADIA - SERVER (Express + Socket.IO + SQLite)
// v1.0.2: /api/games/slots montado ANTES do /api/games
// (o coringa /:game/play sequestrava a rota do Slots → "Jogo não encontrado")
// ========================================

require("dotenv").config();

const express = require("express");
const compression = require("compression");
const cors = require("cors");
const http = require("http");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");
const security = require("./middleware/security");
const { authenticateSocket } = require("./middleware/auth");

const pool = require("./config/database");
const authRoutes = require("./routes/auth.routes");
const { router: gameRoutes } = require("./routes/game.routes");
const walletRoutes = require("./routes/wallet.routes");
const friendsRoutes = require("./routes/friends.routes");
const blackjackRoutes = require("./routes/blackjack.routes");
const rouletteRoutes = require("./routes/roulette.routes");
const slotsRoutes = require("./routes/slots.routes");
const { setupMultiplayer } = require("./realtime/rooms");
const { setupBlackjackMultiplayer } = require("./realtime/blackjack-mp");
const { setupRacing } = require("./realtime/racing");
const { setupDuels } = require("./realtime/duels");
const { initInvites } = require("./realtime/invites");
const progression = require("./services/progression.routes");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ========================================
// MIDDLEWARES
// ========================================

app.use(security.headers);
app.use(security.originGuard);
app.use(cors({ origin: (origin, cb) => cb(null, (process.env.ALLOWED_ORIGINS || "").split(",").includes(origin)), credentials: true }));

app.use(compression()); // gzip nas respostas
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());

// Cache: HTML sempre revalida; JS/CSS revalidam via ETag (rápido, 304) mas nunca ficam velhos.
// (max-age longo aqui serviu versão bugada por 24h na v0.9.4 — nunca mais)
app.use((req, res, next) => {
    if (req.path.match(/\.(css|js|png|jpg|svg|ico|woff2?)$/)) {
        res.setHeader("Cache-Control", "no-cache"); // revalida: 304 se não mudou
    } else if (req.path.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache");
    }
    next();
});

// Rate limit simples por IP (proteção básica da API)
const rateHits = new Map();
app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    const ip = req.ip || req.socket.remoteAddress;
    const now = Date.now();
    const rec = rateHits.get(ip) || { count: 0, reset: now + 60000 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
    rec.count++;
    rateHits.set(ip, rec);
    if (rateHits.size > 5000) rateHits.clear(); // evita vazamento de memória
    if (rec.count > 1200) {
        return res.status(429).json({ status: "error", message: "Muitas requisições. Aguarde um minuto." });
    }
    next();
});

// ========================================
// ROTAS
// ⚠️ ORDEM IMPORTA: rotas específicas ANTES de rotas com coringa.
// /api/games/slots precisa vir antes de /api/games (que tem /:game/play).
// ========================================

app.use("/api/auth", security.authRateLimit(), authRoutes);
app.use("/api/avatars", require("./routes/avatar.routes"));
app.use("/api/games/slots", slotsRoutes);
app.use("/api/games", gameRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/friends", friendsRoutes);
app.use("/api/games", blackjackRoutes);
app.use("/api/games", rouletteRoutes);
app.use("/api/progression", progression.router);

// ========================================
// HEALTH
// ========================================

app.get("/api/health", (req, res) => {
    if (pool.db.isAvailable && !pool.db.isAvailable()) return res.status(503).json({ status: "unavailable", application: "Arcadia API" });
    res.status(200).json({
        status: "ok",
        application: "Arcadia API",
        version: "1.3.0",
        realtime: true,
    });
});

app.get("/api/database/health", async (req, res) => {
    try {
        const result = await pool.get("SELECT datetime('now') AS database_time");
        res.status(200).json({
            status: "ok",
            database: pool.remote ? "Turso" : "SQLite",
            persistent: pool.remote,
            connected: true,
            time: result ? result.database_time : null,
        });
    } catch (error) {
        res.status(500).json({
            status: "error",
            database: pool.remote ? "Turso" : "SQLite",
            persistent: pool.remote,
            connected: false,
        });
    }
});

// Frontend estático pelo próprio Express (deploy em 1 serviço)
const path = require("path");
const frontend = path.join(__dirname, "..", "..");
app.use("/css", express.static(path.join(frontend, "css")));
app.use("/js", express.static(path.join(frontend, "js")));
app.use("/assets", express.static(path.join(frontend, "assets")));
app.use((req, res, next) => {
    if (req.path === "/" || /^\/[a-z0-9-]+\.html$/.test(req.path)) return express.static(frontend)(req, res, next);
    next();
});

// ========================================
// SOCKET.IO
// ========================================

const io = new Server(server, {
    cors: { origin: (origin, cb) => cb(null, (process.env.ALLOWED_ORIGINS || "").split(",").includes(origin)), credentials: true },
    allowRequest: (req, cb) => cb(null, security.sameOrigin(req, req.headers.origin)),
});
io.use(authenticateSocket);

setupMultiplayer(io);
setupBlackjackMultiplayer(io);
setupRacing(io);
setupDuels(io);
initInvites(io);
app.use((err, req, res, next) => {
    console.error("Request error:", err.message);
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ status: "error", message: err.status === 400 ? "Dados inválidos." : "Erro interno. Tente novamente." });
});

// ========================================
// START
// ========================================

server.keepAliveTimeout = 65000; // evita 502 em proxies com idle > 5s
server.headersTimeout = 66000;

server.listen(PORT, () => {
    console.log(`Arcadia API v1.3.0 http://localhost:${server.address().port}`);
    console.log(`   Banco: ${pool.DB_PATH}`);
    console.log(`   Realtime: Socket.IO ativo`);
});
