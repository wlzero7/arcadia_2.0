const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const { shuffle } = require("../services/random");
const rounds = require("../services/rounds");
const router = express.Router();
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function newDeck() {
    return shuffle(SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit }))));
}
function handValue(cards) {
    let total = 0, aces = 0;
    for (const card of cards) {
        if (card.rank === "A") { total += 11; aces++; }
        else total += ["J", "Q", "K"].includes(card.rank) ? 10 : Number(card.rank);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}
function publicState(state, finished = false) {
    return {
        active: !finished, finished, wager: state.wager,
        player: state.player,
        dealer: finished ? state.dealer : [state.dealer[0], { hidden: true }],
        playerTotal: handValue(state.player),
        dealerTotal: finished ? handValue(state.dealer) : handValue([state.dealer[0]]),
        canDouble: !finished && !state.doubled && state.player.length === 2,
        balance: pool.db.get("SELECT balance FROM wallets WHERE id = ?", [state.walletId]).balance,
    };
}
function session(userId) {
    const state = rounds.getSession(userId, "blackjack");
    if (!state) throw new Error("Nenhuma partida em andamento.");
    return state;
}
function finish(userId, state, natural = false) {
    const player = handValue(state.player), dealer = handValue(state.dealer);
    let outcome = "loss", payout = 0;
    if (player <= 21 && ((natural && player === 21 && dealer !== 21) || dealer > 21 || player > dealer)) {
        outcome = "win"; payout = Math.floor(state.wager * (natural && player === 21 ? 2.5 : 2));
    } else if (player <= 21 && player === dealer) {
        outcome = "push"; payout = state.wager;
    }
    const message = outcome === "win" ? (natural ? "BLACKJACK! Pagou 3:2." : "Você ganhou!")
        : outcome === "push" ? "Empate, aposta devolvida." : "Dealer ganhou.";
    return { ...publicState(state, true), outcome, payout, message,
        ...rounds.settleRound(userId, "blackjack", payout, outcome, { player: state.player, dealer: state.dealer, doubled: state.doubled, natural }) };
}
router.get("/blackjack/state", authenticate, rounds.handler((req) => {
    const state = rounds.getSession(req.user.id, "blackjack");
    return state ? publicState(state) : { active: false };
}));
router.post("/blackjack/start", authenticate, rounds.handler((req) => {
    const wager = rounds.wager(req.body.wager);
    const deck = newDeck();
    rounds.startRound(req.user.id, "blackjack", wager, { deck, player: [deck.pop(), deck.pop()], dealer: [deck.pop(), deck.pop()], doubled: false });
    const state = session(req.user.id);
    if (handValue(state.player) === 21 || handValue(state.dealer) === 21) return finish(req.user.id, state, true);
    return publicState(state);
}));
router.post("/blackjack/hit", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    state.player.push(state.deck.pop());
    rounds.saveSession(req.user.id, "blackjack", state);
    if (handValue(state.player) > 21) return finish(req.user.id, state);
    return publicState(state);
}));
router.post("/blackjack/stand", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    while (handValue(state.dealer) < 17) state.dealer.push(state.deck.pop());
    return finish(req.user.id, state);
}));
router.post("/blackjack/double", authenticate, rounds.handler((req) => {
    const state = session(req.user.id);
    if (state.doubled || state.player.length !== 2) throw new Error("Dobrar só com as duas cartas iniciais.");
    pool.adjustBalanceSync(state.walletId, -state.wager, "bet", "game", "blackjack");
    state.wager *= 2;
    state.doubled = true;
    state.player.push(state.deck.pop());
    rounds.saveSession(req.user.id, "blackjack", state);
    if (handValue(state.player) <= 21) {
        while (handValue(state.dealer) < 17) state.dealer.push(state.deck.pop());
    }
    return finish(req.user.id, state);
}));
module.exports = router;
