const express = require("express");
const { authenticate } = require("../middleware/auth");
const rounds = require("../services/rounds");
const roulette = require("../services/roulette");
const router = express.Router();
router.post("/roulette/spin", authenticate, rounds.handler((req) => {
    if (!Array.isArray(req.body.bets) || req.body.bets.length < 1 || req.body.bets.length > 10) throw new Error("Escolha entre 1 e 10 apostas.");
    const bets = req.body.bets.map((b) => roulette.validateBet(b));
    const result = roulette.spin(bets);
    rounds.wager(result.totalWager);
    return { ...result, ...rounds.settleInstant(req.user.id, "roulette", result.totalWager, result.totalPayout, result.outcome, result) };
}));
module.exports = router;
