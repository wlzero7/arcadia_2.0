const crypto = require("node:crypto");
function sameOrigin(req, origin) {
    if (!origin) return true;
    const allowed = (process.env.ALLOWED_ORIGINS || process.env.PUBLIC_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const proto = req.protocol || (req.headers["x-forwarded-proto"] === "https" ? "https" : "http");
    return origin === `${proto}://${req.headers.host}` || allowed.includes(origin);
}
function headers(req, res, next) {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
}
function originGuard(req, res, next) {
    if (!sameOrigin(req, req.headers.origin)) return res.status(403).json({ status: "error", message: "Origem não permitida." });
    next();
}
function authRateLimit() {
    const hits = new Map();
    return (req, res, next) => {
        if (!['/login', '/register', '/password'].includes(req.path) || req.method === 'GET') return next();
        const now = Date.now();
        for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
        const identifier = crypto.createHash("sha256").update(String(req.body?.email || "").trim().toLowerCase()).digest("hex");
        for (const key of ["ip:" + req.ip, "account:" + identifier]) {
            const entry = hits.get(key) || { count: 0, reset: now + 60000 };
            hits.set(key, entry);
            if (++entry.count > 15) {
                res.setHeader("Retry-After", "60");
                return res.status(429).json({ status: "error", message: "Muitas tentativas. Aguarde um minuto." });
            }
        }
        next();
    };
}
module.exports = { sameOrigin, headers, originGuard, authRateLimit };
