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
    renew: { name: "Renovar", rarity: "epica", nrg: 3, desc: "Troque sua mao por duas cartas aleatorias." },
    perfect_play: { name: "Jogada Perfeita", rarity: "lendaria", nrg: 4, desc: "Receba a carta exata para chegar a 21." },
    loving: { name: "Amoroso", rarity: "lendaria", nrg: 4, desc: "Leve a mao do adversario a 21, mesmo se o limite for menor." },
    double_opponent: { name: "Dobrar a mao do adversario", rarity: "cromatica", nrg: 5, desc: "Dobre o valor da mao adversaria." },
    recovery: { name: "Recuperacao", rarity: "cromatica", nrg: 5, desc: "Se voce perder, reinicie a mesma rodada sem movimentar AC." },
    profit_double: { name: "Lucro 2x", rarity: "super_rara", nrg: 2, desc: "Se vencer, receba o dobro do lucro." },
    plus_one: { name: "Mais um", rarity: "epica", nrg: 3, desc: "Receba dois trunfos de raridades aleatorias." },
};
function newDeck() { return shuffle(SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })))); }
function handValue(cards, limit = 21) {
    let total = 0, aces = 0;
    for (const c of cards) {
        if (Number.isFinite(c.value)) total += c.value;
        else if (c.rank === "A") { total += 11; aces++; }
        else total += ["J", "Q", "K"].includes(c.rank) ? 10 : Number(c.rank);
    }
    while (total > limit && aces-- > 0) total -= 10;
    return total;
}
function inventory(userId) {
    const rows = pool.db.all("SELECT card_key, COUNT(*) AS qty FROM blackjack_cards WHERE user_id = ? GROUP BY card_key", [userId]);
    return inventoryRows(rows);
}
function inventoryRows(rows) { return rows.filter((r) => Object.hasOwn(SPECIAL_CARDS, r.card_key)).map((r) => ({ key: r.card_key, qty: r.qty, ...SPECIAL_CARDS[r.card_key] })); }
function inventories(userIds) {
    return pool.batchSync(userIds.map((id) => ({ method: "all", sql: "SELECT card_key, COUNT(*) AS qty FROM blackjack_cards WHERE user_id = ? GROUP BY card_key", params: [id] }))).map(inventoryRows);
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
function drop(userId) { return actionDrop(userId); }
function actionDrop(userId) { return random() < 0.5 ? addCard(userId, rollSpecialCard()) : null; }
function total(cards, limit = 21, factor = 1) {
    return handValue(cards, cards.some((c) => c.perfect) ? 21 : limit) * factor;
}
function perfectCard(cards, factor = 1) {
    const missing = 21 / factor - handValue(cards, 21);
    if (!Number.isInteger(missing) || missing < 1) throw new Error("Nao ha carta que leve esta mao a 21.");
    // A trump creates a wildcard; it never duplicates or reveals an unseen deck card.
    return { rank: String(missing), suit: "\u2605", value: missing, perfect: true };
}
function restart(state) {
    const restarted = (state.restarted || 0) + 1;
    Object.assign(state, createHand(), { recovery: false, dealerRecovery: false, profitDouble: false,
        dealerProfitDouble: false, playerFactor: 1, dealerFactor: 1, stood: false, dealerStood: false,
        dealerNrg: 5, dealerHits: 0, dealerDoubled: false, dealerShield: false, dealerMirror: false,
        lastAttack: null, dealerLastAttack: null, restarted, note: "Recuperacao: mesma rodada, saldos inalterados." });
}
function orient(state, reverse = false) {
    if (!reverse) return state;
    const mapping = { player: "dealer", dealer: "player", nrg: "dealerNrg", dealerNrg: "nrg", hits: "dealerHits", dealerHits: "hits",
        doubled: "dealerDoubled", dealerDoubled: "doubled", shield: "dealerShield", dealerShield: "shield", mirror: "dealerMirror", dealerMirror: "mirror",
        playerFactor: "dealerFactor", dealerFactor: "playerFactor", recovery: "dealerRecovery", dealerRecovery: "recovery",
        profitDouble: "dealerProfitDouble", dealerProfitDouble: "profitDouble", stood: "dealerStood", dealerStood: "stood", lastAttack: "dealerLastAttack", dealerLastAttack: "lastAttack" };
    return new Proxy(state, { get: (object, key) => object[mapping[key] || key], set(object, key, value) { object[mapping[key] || key] = value; return true; } });
}
function createHand() {
    const deck = newDeck();
    return { deck, player: [deck.pop(),deck.pop()], dealer: [deck.pop(),deck.pop()], doubled: false, hits: 0, limit: 21, nrg: 5, shield: false, mirror: false };
}
function drawPlayer(state, card = state.deck.pop()) {
    if (!card) throw new Error("Nenhuma carta disponivel.");
    state.player.push(card); state.hits = (state.hits || 0) + 1;
    if (state.shield && total(state.player, state.limit, state.playerFactor || 1) > (state.limit || 21)) {
        state.player.pop(); state.shield = false; state.deck.unshift(card);
        state.note = "Escudo bloqueou a carta que estouraria sua mao.";
    }
}
function useSpecial(userId, state, data) {
    const key = String(data.cardKey || ""), meta = SPECIAL_CARDS[key];
    if (!Object.hasOwn(SPECIAL_CARDS, key)) throw new Error("Trunfo invalido.");
    if ((state.nrg ?? 5) < meta.nrg) throw new Error("Trunfo: NRG insuficiente.");
    const effect = state.pvp && key === "mirror" ? state.lastAttack?.key : key;
    if (!effect || !Object.hasOwn(SPECIAL_CARDS, effect)) throw new Error("Nenhum ataque para refletir.");
    const target = key !== "mirror" && data.target === "player" ? state.player : state.dealer;
    let picked;
    let perfect;
    if (effect === "perfect_play") perfect = perfectCard(state.player, state.playerFactor || 1);
    if (effect === "loving") perfect = perfectCard(state.dealer, state.dealerFactor || 1);
    if ((key === "recovery" && state.recovery) || (key === "profit_double" && state.profitDouble)) throw new Error("Trunfo ja ativo.");
    if (effect === "double_opponent" && !Number.isSafeInteger(total(state.dealer, state.limit, (state.dealerFactor || 1) * 2))) throw new Error("Mao fora do limite permitido.");
    if (effect === "pick_card") {
        picked = state.deck.findIndex((c) => c.rank === String(data.rank || "A") && c.suit === String(data.suit || SUITS[0]));
        if (picked < 0) throw new Error("Carta nao disponivel no baralho.");
    }
    if (effect === "remove_last" && target.length <= 2) throw new Error("Nenhuma carta extra para remover.");
    if ((key === "shield" && state.shield) || (key === "mirror" && state.mirror)) throw new Error("Trunfo ja ativo.");
    if (key === "draw_three" && state.deck.length < 3) throw new Error("Nenhuma carta disponivel.");
    if (effect === "force_hit" && !state.deck.length) throw new Error("Nenhuma carta disponivel.");
    consume(userId, key);
    state.nrg = (state.nrg ?? 5) - meta.nrg;
    state.note = meta.name;
    if (state.pvp && key === "mirror") state.lastAttack = null;
    const attack = ["force_hit", "loving", "double_opponent"].includes(effect) || (effect === "remove_last" && target === state.dealer);
    if (state.pvp && attack && key !== "mirror") state.dealerLastAttack = { key: effect };
    if (state.pvp && state.dealerShield && attack) {
        state.dealerShield = false; state.note = "Escudo bloqueou " + meta.name; return;
    }
    switch (effect) {
        case "renew": state.deck.push(...state.player.filter((c) => !c.perfect)); state.deck = shuffle(state.deck); state.player = [state.deck.pop(), state.deck.pop()]; state.hits = 0; state.playerFactor = 1; break;
        case "perfect_play": drawPlayer(state, perfect); break;
        case "loving": state.dealer.push(perfect); break;
        case "double_opponent": state.dealerFactor = (state.dealerFactor || 1) * 2; break;
        case "recovery": state.recovery = true; break;
        case "profit_double": state.profitDouble = true; break;
        case "plus_one": state.gainedCards = [addCard(userId, rollSpecialCard()), addCard(userId, rollSpecialCard())]; break;
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
    while (total(state.dealer, state.limit, state.dealerFactor || 1) < Math.min(17, state.limit || 21) && state.deck.length) {
        const card = state.deck.pop();
        if (state.mirror) { state.mirror = false; drawPlayer(state, card); }
        else state.dealer.push(card);
    }
}
function result(state, natural = false) {
    const limit = state.limit || 21, player = total(state.player, limit, state.playerFactor || 1), dealer = total(state.dealer, limit, state.dealerFactor || 1);
    let outcome = "loss", payout = 0;
    if (player <= limit && (dealer > limit || player > dealer)) { outcome = "win"; payout = Math.floor(state.wager * (natural && player === 21 ? 2.5 : 2)); }
    else if (player <= limit && player === dealer) { outcome = "push"; payout = state.wager; }
    if (outcome === "win" && state.profitDouble) payout += payout - state.wager;
    if (!Number.isSafeInteger(payout)) throw new Error("Premio fora do limite permitido.");
    return { outcome, payout, detail: { player: state.player, dealer: state.dealer, playerTotal: player, dealerTotal: dealer, hits: state.hits ?? Math.max(0,state.player.length - 2), limit, doubled: state.doubled, natural, profitDouble: !!state.profitDouble } };
}
function publicHand(state, finished = false) {
    const dealer = finished ? state.dealer : state.dealer.map((card, index) => index === 1 ? { hidden: true } : card);
    return { player: state.player, dealer, playerTotal: total(state.player, state.limit, state.playerFactor || 1), dealerTotal: total(dealer.filter((c) => !c.hidden), state.limit, state.dealerFactor || 1), limit: state.limit || 21, nrg: state.nrg ?? 5, shield: !!state.shield, mirror: !!state.mirror, recovery: !!state.recovery, profitDouble: !!state.profitDouble, restarted: state.restarted || 0, note: state.note || "", canDouble: !finished && !state.doubled && state.player.length === 2 && !(state.hits > 0) };
}
module.exports = { SUITS, RANKS, SPECIAL_CARDS, newDeck, handValue, total, perfectCard, restart, orient, inventory, inventories, consume, rollSpecialCard, addCard, drop, actionDrop, createHand, drawPlayer, useSpecial, stand, result, publicHand };
