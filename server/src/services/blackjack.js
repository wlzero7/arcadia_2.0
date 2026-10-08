const pool = require("../config/database");
const { random, shuffle } = require("./random");
const { checkProfileAchievements } = require("./achievements");
const SUITS = ["\u2660", "\u2665", "\u2666", "\u2663"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SPECIAL_CARDS = {
    force_hit: { name: "Forcar compra", rarity: "comum", nrg: 1, desc: "Force um adversario a comprar uma carta." },
    remove_last: { name: "Remover ultima carta", rarity: "rara", nrg: 2, desc: "Remova a ultima carta extra de um alvo." },
    raise_limit_28: { name: "Limite 28", rarity: "rara", nrg: 2, desc: "Aumente o limite da mesa para 28." },
    lower_limit_17: { name: "Limite 17", rarity: "epica", nrg: 3, desc: "Reduza o limite da mesa para 17." },
    pick_card: { name: "Escolher carta", rarity: "lendaria", nrg: 4, desc: "Escolha uma carta disponivel no baralho." },
    draw_three: { name: "Comprar tres", rarity: "super_rara", nrg: 2, desc: "Compre tres cartas." },
    mirror: { name: "Espelhar", rarity: "cromatica", nrg: 5, desc: "Reflita o ultimo ataque recebido.", houseDesc: "Receba a proxima carta extra do dealer em vez dele." },
    shield: { name: "Escudo", rarity: "epica", nrg: 3, desc: "Bloqueie o proximo trunfo contra voce.", houseDesc: "Descarte a proxima carta comprada que faria sua mao estourar." },
};
function newDeck() { return shuffle(SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })))); }
function handValue(cards, limit = 21) {
    let total = 0, aces = 0;
    for (const c of cards) {
        if (c.rank === "A") { total += 11; aces++; }
        else total += ["J", "Q", "K"].includes(c.rank) ? 10 : Number(c.rank);
    }
    while (total > limit && aces-- > 0) total -= 10;
    return total;
}
function inventory(userId) {
    const rows = pool.db.all("SELECT card_key, COUNT(*) AS qty FROM blackjack_cards WHERE user_id = ? GROUP BY card_key", [userId]);
    return rows.filter((r) => Object.hasOwn(SPECIAL_CARDS, r.card_key)).map((r) => ({ key: r.card_key, qty: r.qty, ...SPECIAL_CARDS[r.card_key] }));
}
function consume(userId, key) {
    const row = pool.db.get("SELECT id FROM blackjack_cards WHERE user_id = ? AND card_key = ? ORDER BY id LIMIT 1", [userId, key]);
    if (!row) throw new Error("Voce nao possui esse Trunfo.");
    pool.db.run("DELETE FROM blackjack_cards WHERE id = ?", [row.id]);
}
function rollSpecialCard() {
    let roll = random() * 100;
    for (const [rarity, weight] of [["comum",50],["rara",25],["super_rara",15],["epica",6],["lendaria",3],["cromatica",1]]) {
        if ((roll -= weight) < 0) { const keys = Object.keys(SPECIAL_CARDS).filter((k) => SPECIAL_CARDS[k].rarity === rarity); return keys[Math.floor(random() * keys.length)]; }
    }
    return "force_hit";
}
function addCard(userId, key) {
    const meta = SPECIAL_CARDS[key];
    if (!meta) throw new Error("Trunfo invalido.");
    pool.db.run("INSERT INTO blackjack_cards (user_id,card_key,rarity) VALUES (?,?,?)", [userId, key, meta.rarity]);
    checkProfileAchievements(userId);
    return { key, ...meta };
}
function drop(userId) { return random() < 0.3 ? addCard(userId, rollSpecialCard()) : null; }
function createHand() {
    const deck = newDeck();
    return { deck, player: [deck.pop(),deck.pop()], dealer: [deck.pop(),deck.pop()], doubled: false, hits: 0, limit: 21, nrg: 5, shield: false, mirror: false };
}
function drawPlayer(state, card = state.deck.pop()) {
    if (!card) throw new Error("Nenhuma carta disponivel.");
    state.player.push(card); state.hits = (state.hits || 0) + 1;
    if (state.shield && handValue(state.player, state.limit) > (state.limit || 21)) {
        state.player.pop(); state.shield = false; state.deck.unshift(card);
        state.note = "Escudo bloqueou a carta que estouraria sua mao.";
    }
}
function useSpecial(userId, state, data) {
    const key = String(data.cardKey || ""), meta = SPECIAL_CARDS[key];
    if (!Object.hasOwn(SPECIAL_CARDS, key)) throw new Error("Trunfo invalido.");
    if ((state.nrg ?? 5) < meta.nrg) throw new Error("Trunfo: NRG insuficiente.");
    const target = data.target === "player" ? state.player : state.dealer;
    let picked;
    if (key === "pick_card") {
        picked = state.deck.findIndex((c) => c.rank === String(data.rank || "A") && c.suit === String(data.suit || SUITS[0]));
        if (picked < 0) throw new Error("Carta nao disponivel no baralho.");
    }
    if (key === "remove_last" && target.length <= 2) throw new Error("Nenhuma carta extra para remover.");
    if ((key === "shield" && state.shield) || (key === "mirror" && state.mirror)) throw new Error("Trunfo ja ativo.");
    if (key === "draw_three" && state.deck.length < 3) throw new Error("Nenhuma carta disponivel.");
    if (key === "force_hit" && !state.deck.length) throw new Error("Nenhuma carta disponivel.");
    consume(userId, key);
    state.nrg = (state.nrg ?? 5) - meta.nrg;
    state.note = meta.name;
    switch (key) {
        case "force_hit": state.dealer.push(state.deck.pop()); break;
        case "remove_last": state.deck.unshift(target.pop()); break;
        case "raise_limit_28": state.limit = 28; break;
        case "lower_limit_17": state.limit = 17; break;
        case "pick_card": drawPlayer(state, state.deck.splice(picked,1)[0]); break;
        case "draw_three": for (let i = 0; i < 3; i++) drawPlayer(state); break;
        case "shield": state.shield = true; break;
        case "mirror": state.mirror = true; break;
    }
}
function stand(state) {
    while (handValue(state.dealer, state.limit) < Math.min(17, state.limit || 21) && state.deck.length) {
        const card = state.deck.pop();
        if (state.mirror) { state.mirror = false; drawPlayer(state, card); }
        else state.dealer.push(card);
    }
}
function result(state, natural = false) {
    const limit = state.limit || 21, player = handValue(state.player, limit), dealer = handValue(state.dealer, limit);
    let outcome = "loss", payout = 0;
    if (player <= limit && (dealer > limit || player > dealer)) { outcome = "win"; payout = Math.floor(state.wager * (natural && player === 21 ? 2.5 : 2)); }
    else if (player <= limit && player === dealer) { outcome = "push"; payout = state.wager; }
    return { outcome, payout, detail: { player: state.player, dealer: state.dealer, playerTotal: player, dealerTotal: dealer, hits: state.hits ?? Math.max(0,state.player.length - 2), limit, doubled: state.doubled, natural } };
}
function publicHand(state, finished = false) {
    const dealer = finished ? state.dealer : state.dealer.map((card, index) => index === 1 ? { hidden: true } : card);
    return { player: state.player, dealer, playerTotal: handValue(state.player, state.limit), dealerTotal: handValue(dealer.filter((c) => !c.hidden), state.limit), limit: state.limit || 21, nrg: state.nrg ?? 5, shield: !!state.shield, mirror: !!state.mirror, note: state.note || "", canDouble: !finished && !state.doubled && state.player.length === 2 && !(state.hits > 0) };
}
module.exports = { SUITS, RANKS, SPECIAL_CARDS, newDeck, handValue, inventory, consume, rollSpecialCard, addCard, drop, createHand, drawPlayer, useSpecial, stand, result, publicHand };
