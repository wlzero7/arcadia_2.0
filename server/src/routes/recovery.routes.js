const express = require("express");
const { createRecovery, RecoveryError, digest } = require("../services/recovery");
const pool = require("../config/database");
function createRouter(recovery = createRecovery()) {
const router = express.Router();
function limit(req, res, next) {
    const now = Date.now(), key = digest("ip:" + req.ip);
    const allowed = pool.transactionSync(() => {
        pool.db.run("DELETE FROM password_recovery_limits WHERE resets_at<=?", [now]);
        pool.db.run("INSERT INTO password_recovery_limits VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=attempts+1", [key, now + 900000]);
        return pool.db.get("SELECT attempts FROM password_recovery_limits WHERE key_hash=?", [key]).attempts <= 10;
    });
    if (!allowed) return res.status(429).json({ status: "error", message: "Muitas tentativas. Aguarde 15 minutos." });
    next();
}
const handle = (action) => async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try { res.json({ status: "success", ...await action(req.body || {}) }); }
    catch (error) { res.status(error instanceof RecoveryError ? error.status : 503).json({ status: "error", message: error instanceof RecoveryError ? error.message : "Recuperacao indisponivel. Tente novamente." }); }
};
router.post("/forgot-password", limit, handle((body) => recovery.request(body.identifier)));
router.post("/reset-password", limit, handle((body) => recovery.reset(body.token, body.password)));
return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
