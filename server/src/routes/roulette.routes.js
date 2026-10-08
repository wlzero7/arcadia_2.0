const express = require("express");
const { authenticate } = require("../middleware/auth");
const rounds = require("../services/rounds");
const roulette = require("../services/roulette");
const router = express.Router();
router.post("/roulette/spin", authenticate, rounds.handler((req) => {
    if (!Array.isArray(req.body.bets) || req.body.bets.length < 1 || req.body.bets.length > 10) throw new Error("Escolha entre 1 e 10 apostas.");
    if (req.body.allWin === true && req.body.bets.length !== 1) throw new Error("All Win exige uma única aposta na mesa.");
    const bets = req.body.bets.map((b) => roulette.validateBet(req.body.allWin === true ? { ...b, amount: rounds.resolveWager(req.user.id, req.body) } : b, req.body.allWin === true ? 1 : 10, req.body.allWin === true ? Number.MAX_SAFE_INTEGER : 1000000));
    const result = roulette.spin(bets);
    rounds.wager(result.totalWager, req.body.allWin === true ? 1 : 10, req.body.allWin === true ? Number.MAX_SAFE_INTEGER : 1000000);
    return { ...result, ...rounds.settleInstant(req.user.id, "roulette", result.totalWager, result.totalPayout, result.outcome, result) };
}));
module.exports = router;
