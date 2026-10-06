const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const { TRUMPS, resolveSpin, rollCardDrop } = require("../services/slotsEngine");
const rounds = require("../services/rounds");
const router = express.Router();

router.post("/play", authenticate, rounds.handler((req) => {
    const wager = rounds.wager(req.body.wager);
    const trump = req.body.trump || null;
    if (trump && (!Object.hasOwn(TRUMPS, trump) || TRUMPS[trump].duelOnly)) throw new Error("Trunfo inválido para o modo solo.");
    const wallet = pool.getWalletSync(req.user.id, "solo");
    const maxLoss = wager * (trump === "duplicador" ? 2 : 1);
    if (wallet.balance < maxLoss) throw new Error("Saldo insuficiente para a perda máxima do trunfo.");
    if (trump) {
        const owned = pool.db.get("SELECT id FROM slots_cards WHERE user_id = ? AND card_key = ? LIMIT 1", [req.user.id, trump]);
        if (!owned) throw new Error("Você não possui esse trunfo.");
        pool.db.run("DELETE FROM slots_cards WHERE id = ?", [owned.id]);
    }
    const result = resolveSpin({ wager, trump });
    const charged = wager * result.lossMultiplier;
    const outcome = result.payout > charged ? "win" : result.payout === charged ? "push" : "loss";
    const settled = rounds.settleInstant(req.user.id, "slots", charged, result.payout, outcome, { reels: result.reels, jackpot: result.jackpot, trump, baseWager: wager });
    const card = rollCardDrop(false);
    if (card) pool.db.run("INSERT INTO slots_cards (user_id, card_key, rarity) VALUES (?, ?, ?)", [req.user.id, card.key, card.rarity]);
    return { ...result, outcome, delta: result.payout - charged, ...settled, card };
}));
router.get("/cards", authenticate, rounds.handler((req) => {
    const rows = pool.db.all("SELECT card_key, rarity, COUNT(*) AS qty FROM slots_cards WHERE user_id = ? GROUP BY card_key, rarity", [req.user.id]);
    return { inventory: rows.map((r) => ({ key: r.card_key, rarity: r.rarity, qty: r.qty, ...(TRUMPS[r.card_key] || {}) })), catalog: TRUMPS };
}));
module.exports = router;
