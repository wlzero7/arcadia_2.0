// ========================================
// ARCADIA - BLACKJACK MULTIPLAYER (v0.9)
// Mesa ao vivo + CARTAS ESPECIAIS + NRG
// ========================================

const pool = require("../config/database");
const { random, code: secureCode } = require("../services/random");
const store = require("../services/realtimeStore");
const { trackGameActivity } = require("../services/progression.routes");
const { grantXP } = require("../services/progression");

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];

function newDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function handValue(cards) {
    let total = 0, aces = 0;
    for (const c of cards) {
        if (c.rank === "A") { aces++; total += 11; }
        else if (["J", "Q", "K"].includes(c.rank)) total += 10;
        else total += Number(c.rank);
    }
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

// ========================================
// CARTAS ESPECIAIS (v0.9)
// raridades: comum, raro, super-raro, épico, lendária, cromática
// ========================================

const SPECIAL_CARDS = {
    force_hit:        { rarity: "comum",     desc: "Force um adversário a comprar 1 carta", nrg: 1 },
    remove_last:      { rarity: "raro",      desc: "Remova a última carta que um alvo comprou", nrg: 2 },
    raise_limit_28:   { rarity: "raro",      desc: "Aumente o limite da mesa para 28", nrg: 2 },
    lower_limit_17:   { rarity: "épico",     desc: "Reduza o limite da mesa para 17", nrg: 3 },
    pick_card:        { rarity: "lendária",  desc: "Escolha uma carta específica do baralho", nrg: 4 },
    draw_three:       { rarity: "super-raro",desc: "Compre 3 cartas (contam juntas)", nrg: 2 },
    mirror:           { rarity: "cromática", desc: "Copie a última carta especial usada contra você de volta no emissor", nrg: 5 },
    shield:           { rarity: "épico",     desc: "Anule a próxima carta especial contra você", nrg: 3 },
};

const RARITY_DROP = [
    ["comum", 50],
    ["raro", 25],
    ["super-raro", 15],
    ["épico", 6],
    ["lendária", 3],
    ["cromática", 1],
];

function rollSpecialCard() {
    const total = RARITY_DROP.reduce((s, [, w]) => s + w, 0);
    let r = random() * total;
    for (const [rar, w] of RARITY_DROP) {
        if ((r -= w) < 0) {
            const options = Object.entries(SPECIAL_CARDS).filter(([, c]) => c.rarity === rar);
            const [key] = options[Math.floor(random() * options.length)];
            return key;
        }
    }
    return "force_hit";
}

// ========================================
// MESAS EM MEMÓRIA
// ========================================

// tables[code] = { code, hostId, players: Map<userId, {...}>, deck, limit, order, turnIdx, phase, specialHand, discard }
const tables = store.load("blackjack");

function newTable(code, hostId) {
    return {
        code,
        hostId,
        players: new Map(), // userId -> { username, hand, stood, busted, nrg, specials: [], shield: false, lastDrawn, socketIds: Set }
        deck: newDeck(),
        discard: [],
        limit: 21,
        order: [],
        turnIdx: 0,
        phase: "lobby", // lobby | playing | finished
        round: 0,
    };
}

function tableState(t) {
    return {
        code: t.code,
        hostId: t.hostId,
        phase: t.phase,
        limit: t.limit,
        round: t.round,
        players: [...t.players.entries()].map(([id, p]) => ({
            id,
            username: p.username,
            hand: p.hand,
            total: handValue(p.hand),
            stood: p.stood,
            busted: p.busted,
            nrg: p.nrg,
            specials: p.specials.length,
            online: p.socketIds.size > 0,
            isTurn: t.order[t.turnIdx] === id && t.phase === "playing",
        })),
    };
}

function draw(t) {
    if (t.deck.length === 0) {
        t.deck = t.discard.length ? t.discard.splice(0) : newDeck();
        for (let i = t.deck.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [t.deck[i], t.deck[j]] = [t.deck[j], t.deck[i]];
        }
    }
    return t.deck.pop();
}

// Tenta compra de carta especial (30% ao comprar do monte)
function maybeSpecial(t, player, io, code) {
    if (random() < 0.3) {
        const key = rollSpecialCard();
        player.specials.push(key);
        io.to(`bj:${code}`).emit("bj:chat", {
            system: true,
            message: `🎴 ${player.username} sacou carta especial: ${SPECIAL_CARDS[key].desc} (${SPECIAL_CARDS[key].rarity})`,
            at: Date.now(),
        });
    }
}

function nextTurn(t, io, code) {
    // avança para o próximo jogador não-estourado que não parou
    let tries = 0;
    do {
        t.turnIdx = (t.turnIdx + 1) % t.order.length;
        tries++;
    } while (tries <= t.order.length && (t.players.get(t.order[t.turnIdx]).stood || t.players.get(t.order[t.turnIdx]).busted || !t.players.get(t.order[t.turnIdx]).socketIds.size));

    // todos pararam/estouraram?
    const active = [...t.players.values()].filter((p) => !p.stood && !p.busted && p.socketIds.size);
    if (active.length === 0 || tries > t.order.length) {
        finishRound(t, io, code);
        return;
    }

    broadcastTable(t, io);
}

function finishRound(t, io, code) {
    if (t.phase !== "playing") return;
    const before = structuredClone(t);
    t.phase = "finished";
    // vencedor: maior total <= limit
    let best = null;
    for (const id of t.order) {
        const p = t.players.get(id);
        const total = handValue(p.hand);
        if (total <= t.limit && (!best || total > handValue(best.hand))) best = p;
    }
    const results = t.order.map((id) => {
        const p = t.players.get(id);
        return {
            id,
            username: p.username,
            total: handValue(p.hand),
            busted: p.busted,
            won: !!best && !p.busted && handValue(p.hand) === handValue(best.hand),
        };
    });

    try {
        pool.transactionSync(() => {
            // Solo practice at an empty table does not advance multiplayer missions.
            if (t.order.length >= 2) for (const result of results) {
                trackGameActivity(result.id, { game: "blackjack-mp", outcome: result.won ? "win" : "loss", wager: 0, detail: { tableCode: code } });
                grantXP(result.id, 10);
            }
            store.save("blackjack", t);
        });
    } catch (error) { Object.assign(t, before); throw error; }

    io.to(`bj:${code}`).emit("bj:round_end", {
        winner: best ? { id: results.find((r) => r.username === best.username)?.id, username: best.username } : null,
        results,
        limit: t.limit,
    });

    broadcastTable(t, io);
    const finishedRound = t.round;
    // reset para próxima rodada
    setTimeout(() => {
        if (!tables.has(code) || t.phase !== "finished" || t.round !== finishedRound) return;
        if (![...t.players.values()].some((p) => p.socketIds.size)) { t.phase = "lobby"; broadcastTable(t, io); return; }
        dealRound(t, true);
        broadcastTable(t, io);
    }, 5000).unref();
}

function dealRound(t, restoreEnergy = false) {
    t.round++;
    t.limit = 21;
    t.deck = newDeck();
    t.discard = [];
    t.order = [];
    for (const [id, p] of t.players) {
        const online = p.socketIds.size > 0;
        p.hand = online ? [t.deck.pop(), t.deck.pop()] : [];
        p.stood = !online;
        p.busted = false;
        p.shield = false;
        p.lastDrawn = null;
        p.lastAttack = null;
        if (restoreEnergy && online) p.nrg = Math.min(p.nrg + 2, 10);
        if (online) t.order.push(id);
    }
    t.turnIdx = 0;
    t.phase = "playing";
}

function broadcastTable(t, io) {
    store.save("blackjack", t);
    io.to("bj:" + t.code).emit("bj:state", tableState(t));
    for (const p of t.players.values()) for (const socketId of p.socketIds) {
        io.to(socketId).emit("bj:specials", { cards: p.specials });
    }
}
function setupBlackjackMultiplayer(io) {

    io.on("connection", (socket) => {
        socket.data.tableCode = null;
        function on(event, fn) {
            socket.on(event, (data, cb) => {
                if (typeof data === "function") { cb = data; data = {}; }
                try { fn(data || {}, typeof cb === "function" ? cb : () => {}); }
                catch (err) { if (typeof cb === "function") cb({ ok: false, error: err.message }); }
            });
        }

        // ---------- CRIAR/ENTRAR ----------
        on("bj:create", (data, cb) => {
            let code;
            do { code = secureCode(); } while (tables.has(code));
            const t = newTable(code, socket.userId);
            tables.set(code, t);
            joinTable(socket, t, io, cb);
        });

        on("bj:join", (data, cb) => {
            const t = tables.get(String(data && data.code || "").toUpperCase());
            if (!t) return cb && cb({ ok: false, error: "Mesa não encontrada." });
            joinTable(socket, t, io, cb);
        });

        function joinTable(socket, t, io, cb) {
            const prior = tables.get(socket.data.tableCode);
            if (prior && prior !== t) {
                prior.players.get(socket.userId)?.socketIds.delete(socket.id);
                socket.leave("bj:" + prior.code);
                broadcastTable(prior, io);
            }
            if (!t.players.has(socket.userId)) {
                if (t.players.size >= 8) return cb && cb({ ok: false, error: "Mesa cheia." });
                if (t.phase !== "lobby" && t.phase !== "finished") {
                    return cb && cb({ ok: false, error: "Rodada em andamento." });
                }
                t.players.set(socket.userId, {
                    username: socket.username,
                    hand: [],
                    stood: false,
                    busted: false,
                    nrg: 3,
                    specials: [],
                    shield: false,
                    lastDrawn: null,
                    socketIds: new Set(),
                });
                t.order.push(socket.userId);
            }
            t.players.get(socket.userId).socketIds.add(socket.id);
            if (!t.players.get(t.hostId)?.socketIds.size) t.hostId = socket.userId;
            if (t.phase === "playing" && !t.players.get(t.order[t.turnIdx])?.socketIds.size) nextTurn(t, io, t.code);
            socket.data.tableCode = t.code;
            socket.join(`bj:${t.code}`);
            broadcastTable(t, io);
            cb && cb({ ok: true, table: tableState(t) });
        }

        // ---------- INICIAR RODADA ----------
        on("bj:start", (_, cb) => {
            const t = tables.get(socket.data.tableCode);
            if (!t || t.hostId !== socket.userId) return cb && cb({ ok: false, error: "Só o host inicia." });
            if (t.phase === "playing") return cb && cb({ ok: false, error: "Rodada já em andamento." });
            if (t.players.size < 1) return cb && cb({ ok: false, error: "Sem jogadores." });

            dealRound(t, t.phase === "finished");
            broadcastTable(t, io);
            cb && cb({ ok: true });
        });

        // ---------- AÇÕES DE JOGO ----------
        on("bj:hit", (_, cb) => {
            const t = tables.get(socket.data.tableCode);
            if (!t || t.phase !== "playing") return cb && cb({ ok: false, error: "Rodada não ativa." });
            if (t.order[t.turnIdx] !== socket.userId) return cb && cb({ ok: false, error: "Não é sua vez." });

            const p = t.players.get(socket.userId);
            const card = draw(t);
            p.hand.push(card);
            p.lastDrawn = card;

            // chance de carta especial
            maybeSpecial(t, p, io, t.code);

            const total = handValue(p.hand);
            if (total > t.limit) {
                p.busted = true;
                io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `💥 ${p.username} estourou com ${total} (limite ${t.limit}).`, at: Date.now() });
                nextTurn(t, io, t.code);
            }
            broadcastTable(t, io);
            cb && cb({ ok: true });
        });

        on("bj:stand", (_, cb) => {
            const t = tables.get(socket.data.tableCode);
            if (!t || t.phase !== "playing") return cb && cb({ ok: false, error: "Rodada não ativa." });
            if (t.order[t.turnIdx] !== socket.userId) return cb && cb({ ok: false, error: "Não é sua vez." });

            const p = t.players.get(socket.userId);
            p.stood = true;
            io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `✋ ${p.username} parou em ${handValue(p.hand)}.`, at: Date.now() });
            nextTurn(t, io, t.code);
            cb && cb({ ok: true });
        });

        // ---------- CARTAS ESPECIAIS ----------
        on("bj:special", (data, cb) => {
            const t = tables.get(socket.data.tableCode);
            if (!t || t.phase !== "playing") return cb && cb({ ok: false, error: "Rodada não ativa." });

            if (t.order[t.turnIdx] !== socket.userId) return cb && cb({ ok: false, error: "Não é sua vez." });
            const me = t.players.get(socket.userId);
            const key = String(data && data.cardKey || "");
            const targetId = data && data.targetId ? Number(data.targetId) : null;
            const idx = me.specials.indexOf(key);
            if (idx === -1) return cb && cb({ ok: false, error: "Você não tem essa carta." });

            const meta = SPECIAL_CARDS[key];
            if (!meta) return cb && cb({ ok: false, error: "Carta inválida." });
            if (me.nrg < meta.nrg) return cb && cb({ ok: false, error: `NRG insuficiente (${meta.nrg}).` });

            // alvo padrão: próximo jogador
            const targeted = ["force_hit", "remove_last", "mirror"].includes(key);
            const finalTargetId = key === "mirror" ? me.lastAttack?.from : targetId || t.order[(t.turnIdx + 1) % t.order.length];
            const target = targeted ? t.players.get(finalTargetId) : me;
            if (!target || (targeted && (finalTargetId === socket.userId || !t.order.includes(finalTargetId)))) return cb && cb({ ok: false, error: "Alvo inválido." });
            if (key === "mirror" && !me.lastAttack) return cb && cb({ ok: false, error: "Nenhuma carta para refletir." });
            if (key === "pick_card" && !t.deck.some((c) => c.rank === String(data.rank || "A") && c.suit === String(data.suit || "♠"))) return cb && cb({ ok: false, error: "Carta não disponível no baralho." });
            const effect = key === "mirror" ? me.lastAttack.key : key;
            if (targeted && key !== "mirror") target.lastAttack = { key, from: socket.userId };
            if (key === "mirror") me.lastAttack = null;

            // escudo?
            if (targeted && target.shield) {
                me.nrg -= meta.nrg;
                target.shield = false;
                me.specials.splice(idx, 1);
                io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `🛡️ ${target.username} bloqueou ${meta.desc} com Escudo!`, at: Date.now() });
                broadcastTable(t, io);
                return cb && cb({ ok: true });
            }

            me.nrg -= meta.nrg;
            me.specials.splice(idx, 1);

            switch (effect) {
                case "force_hit": {
                    const card = draw(t);
                    target.hand.push(card);
                    target.lastDrawn = card;
                    if (handValue(target.hand) > t.limit) {
                        target.busted = true;
                        io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `💥 ${target.username} estourou com ${handValue(target.hand)}!`, at: Date.now() });
                    }
                    break;
                }
                case "remove_last": {
                    if (target.hand.length > 2) {
                        const removed = target.hand.pop();
                        t.discard.push(removed);
                        io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `🗑️ ${me.username} removeu o ${removed.rank}${removed.suit} de ${target.username}.`, at: Date.now() });
                    } else {
                        io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `🗑️ ${target.username} não tem carta extra para remover.`, at: Date.now() });
                    }
                    break;
                }
                case "raise_limit_28": {
                    t.limit = 28;
                    break;
                }
                case "lower_limit_17": {
                    t.limit = 17;
                    break;
                }
                case "pick_card": {
                    const rank = String(data && data.rank || "A");
                    const suit = String(data && data.suit || "♠");
                    const cardIdx = t.deck.findIndex((c) => c.rank === rank && c.suit === suit);
                    if (cardIdx !== -1) {
                        const card = t.deck.splice(cardIdx, 1)[0];
                        me.hand.push(card);
                        me.lastDrawn = card;
                        if (handValue(me.hand) > t.limit) me.busted = true;
                    }
                    break;
                }
                case "draw_three": {
                    for (let i = 0; i < 3; i++) {
                        const card = draw(t);
                        me.hand.push(card);
                        me.lastDrawn = card;
                    }
                    if (handValue(me.hand) > t.limit) me.busted = true;
                    break;
                }
                case "mirror": {
                    io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `🪞 ${me.username} refletiu o efeito!`, at: Date.now() });
                    break;
                }
                case "shield": {
                    me.shield = true;
                    break;
                }
            }

            io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `🎴 ${me.username} usou carta ${meta.rarity}: ${meta.desc}`, at: Date.now() });

            // busts por limite alterado
            for (const p of t.players.values()) {
                p.busted = handValue(p.hand) > t.limit;
            }

            const currentPlayer = t.players.get(t.order[t.turnIdx]);
            if (currentPlayer.busted || currentPlayer.stood) nextTurn(t, io, t.code);
            else broadcastTable(t, io);
            cb && cb({ ok: true });
        });

        // ---------- CHAT ----------
        on("bj:chat", (data) => {
            const code = socket.data.tableCode;
            if (!code || !tables.has(code)) return;
            const message = String(data && data.message || "").slice(0, 200).trim();
            if (!message) return;
            io.to(`bj:${code}`).emit("bj:chat", { username: socket.username, message, at: Date.now() });
        });

        socket.on("disconnect", () => {
            const code = socket.data.tableCode;
            if (!code) return;
            const t = tables.get(code);
            if (t && t.players.has(socket.userId)) {
                const player = t.players.get(socket.userId);
                player.socketIds.delete(socket.id);
                if (!player.socketIds.size) {
                    player.stood = true;
                    if (t.hostId === socket.userId) t.hostId = [...t.players].find(([, p]) => p.socketIds.size)?.[0] || t.hostId;
                    if (t.phase === "playing" && t.order[t.turnIdx] === socket.userId) nextTurn(t, io, code);
                }
                broadcastTable(t, io);
            }
        });
    });

    return { tables };
}

module.exports = { setupBlackjackMultiplayer, SPECIAL_CARDS, rollSpecialCard };
