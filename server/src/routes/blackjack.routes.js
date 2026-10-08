const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const bj = require("../services/blackjack");
const rounds = require("../services/rounds");
const router = express.Router();
const { handValue } = bj;
function publicState(state, finished = false) {
    return {
        active: !finished, finished, wager: state.wager,
        balance: pool.db.get("SELECT balance FROM wallets WHERE id = ?", [state.walletId]).balance,
        ...bj.publicHand(state, finished),
    };
}
function session(userId) {
    const state = rounds.getSession(userId, "blackjack");
    if (!state) throw new Error("Nenhuma partida em andamento.");
    return state;
}
function finish(userId, state, natural = false) {
    const { outcome, payout, detail } = bj.result(state, natural);
    const message = outcome === "win" ? (natural ? "BLACKJACK! Pagou 3:2." : "Você ganhou!")
        : outcome === "push" ? "Empate, aposta devolvida." : "Dealer ganhou.";
    return { ...publicState(state, true), outcome, payout, message,
        ...rounds.settleRound(userId, "blackjack", payout, outcome, detail), card: bj.drop(userId) };
}
router.get("/blackjack/state", authenticate, rounds.handler((req) => {
    const state = rounds.getSession(req.user.id, "blackjack");
    return state ? publicState(state) : { active: false };
}));
router.post("/blackjack/start", authenticate, rounds.handler((req) => {
    const wager = rounds.resolveWager(req.user.id, req.body);
    rounds.startRound(req.user.id, "blackjack", wager, bj.createHand());
    const state = session(req.user.id);
    if (handValue(state.player) === 21 || handValue(state.dealer) === 21) return finish(req.user.id, state, true);
    return publicState(state);
}));
router.post("/blackjack/hit", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    bj.drawPlayer(state);
    rounds.saveSession(req.user.id, "blackjack", state);
    if (handValue(state.player, state.limit) > (state.limit || 21)) return finish(req.user.id, state);
    return publicState(state);
}));
router.post("/blackjack/stand", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    bj.stand(state);
    return finish(req.user.id, state);
}));
router.post("/blackjack/double", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    if (!bj.publicHand(state).canDouble) throw new Error("Dobrar só com as duas cartas iniciais.");
    pool.adjustBalanceSync(state.walletId, -state.wager, "bet", "game", "blackjack");
    state.wager *= 2;
    state.doubled = true;
    bj.drawPlayer(state);
    rounds.saveSession(req.user.id, "blackjack", state);
    if (handValue(state.player, state.limit) <= (state.limit || 21)) bj.stand(state);
    return finish(req.user.id, state);
}));
router.get("/blackjack/cards", authenticate, rounds.handler((req) => ({ inventory: bj.inventory(req.user.id), catalog: bj.SPECIAL_CARDS })));
router.post("/blackjack/special", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    bj.useSpecial(req.user.id, state, req.body);
    rounds.saveSession(req.user.id, "blackjack", state);
    if (handValue(state.player, state.limit) > (state.limit || 21)) return finish(req.user.id, state);
    return publicState(state);
}));
module.exports = router;
