const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const { handler, wager } = require("../services/rounds");
const router = express.Router();

router.get("/", authenticate, handler((req) => {
    const kind = req.query.kind || "solo";
    const wallet = pool.getWalletSync(req.user.id, kind);
    return { kind, balance: wallet.balance };
}));
router.get("/transactions", authenticate, handler((req) => ({
    transactions: pool.db.all("SELECT w.kind AS wallet_kind, t.kind, t.amount, t.balance_after, t.ref_type, t.ref_id, t.created_at FROM transactions t INNER JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ? ORDER BY t.id DESC LIMIT 100", [req.user.id]),
})));
router.post("/daily", authenticate, (req, res, next) => {
    try {
        const result = pool.transactionSync(() => {
            const today = new Date().toISOString().slice(0, 10);
            const bonus = pool.db.get("SELECT * FROM daily_bonus WHERE user_id = ?", [req.user.id]);
            if (bonus && bonus.last_claim === today) return null;
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            const streak = bonus && bonus.last_claim === yesterday ? Math.min(bonus.streak + 1, 7) : 1;
            const amount = 1000 * streak;
            const wallet = pool.getWalletSync(req.user.id, "solo");
            pool.db.run("INSERT INTO daily_bonus (user_id, last_claim, streak) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET last_claim = excluded.last_claim, streak = excluded.streak", [req.user.id, today, streak]);
            const balance = pool.adjustBalanceSync(wallet.id, amount, "daily_bonus", "daily", today);
            return { amount, streak, balance };
        });
        if (!result) return res.status(400).json({ status: "error", message: "Você já resgatou o bônus de hoje. Volte amanhã!" });
        res.json({ status: "success", message: `Bônus diário: +${result.amount} AC.`, ...result });
    } catch (err) { next(err); }
});
router.post("/transfer", authenticate, handler((req) => {
    const amount = wager(req.body.amount, 1);
    const target = pool.db.get("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE", [String(req.body.toUsername || "").trim()]);
    if (!target) throw new Error("Escolha um jogador existente.");
    if (target.id === req.user.id) throw new Error("Escolha outro jogador.");
    const from = pool.getWalletSync(req.user.id, "solo");
    const to = pool.getWalletSync(target.id, "solo");
    const balance = pool.adjustBalanceSync(from.id, -amount, "transfer_out", "user", String(target.id));
    pool.adjustBalanceSync(to.id, amount, "transfer_in", "user", String(req.user.id));
    return { balance, message: `Enviado ${amount} AC para ${target.username}.` };
}));
module.exports = router;
