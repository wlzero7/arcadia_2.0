// ========================================
// ARCADIA - BLACKJACK MULTIPLAYER (v0.9)
// Mesa ao vivo + CARTAS ESPECIAIS + NRG
// ========================================

const pool = require("../config/database");
const { random, code: secureCode } = require("../services/random");
const store = require("../services/realtimeStore");
const { wager, recordBets } = require("../services/rounds");
const bj = require("../services/blackjack");
const { allocateShares } = require("../services/roomShares");

const { newDeck, handValue } = bj;

// ========================================
// CARTAS ESPECIAIS (v0.9)
// raridades: comum, raro, super-raro, épico, lendária, cromática
// ========================================

const SPECIAL_CARDS = bj.SPECIAL_CARDS;

const RARITY_DROP = [
    ["comum", 50],
    ["rara", 25],
    ["super_rara", 15],
    ["epica", 6],
    ["lendaria", 3],
    ["cromatica", 1],
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
const reconnectTimers = new Map();
const present = (p) => p.socketIds.size > 0 || p.reconnectUntil > Date.now();

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
        pot: t.pot || 0,
        results: t.phase === "finished" ? t.results || [] : [],
        players: [...t.players.entries()].map(([id, p]) => ({
            id,
            username: p.username,
            hand: p.hand,
            total: handValue(p.hand, t.limit),
            stood: p.stood,
            busted: p.busted,
            nrg: p.nrg,
            specials: p.specials.length,
            wager: p.wager || 0,
            pendingWager: p.pendingBet?.amount || 0,
            allWin: p.pendingBet?.allWin || false,
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
    const uid = [...t.players].find(([,p]) => p === player)[0];
    const card = bj.drop(uid);
    if (card) {
        const key = card.key;
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
    } while (tries <= t.order.length && (t.players.get(t.order[t.turnIdx]).stood || t.players.get(t.order[t.turnIdx]).busted || !present(t.players.get(t.order[t.turnIdx]))));

    // todos pararam/estouraram?
    const active = [...t.players.values()].filter((p) => !p.stood && !p.busted && present(p));
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
        const total = handValue(p.hand, t.limit);
        if (total <= t.limit && (!best || total > handValue(best.hand, t.limit))) best = p;
    }
    const results = t.order.map((id) => {
        const p = t.players.get(id);
        return {
            id,
            username: p.username,
            total: handValue(p.hand, t.limit),
            busted: p.busted,
            won: !!best && !p.busted && handValue(p.hand, t.limit) === handValue(best.hand, t.limit),
        };
    });

    try {
        pool.transactionSync(() => {
            // Solo practice at an empty table does not advance multiplayer missions.
            const winners = results.filter((r) => r.won);
            const shares = allocateShares(new Map((winners.length ? winners : results).map((r) => [r.id, winners.length ? 1 : t.players.get(r.id).wager || 1])), t.pot || 0);
            const settlements = [];
            if (t.order.length >= 2) pool.adjustWalletsSync(results.filter((result) => shares.get(result.id) > 0).map((result) => ({ userId: result.id, walletKind: "coop", delta: shares.get(result.id), kind: "payout", refType: "blackjack", refId: code })));
            if (t.order.length >= 2) for (const result of results) {
                const player = t.players.get(result.id);
                const payout = shares.get(result.id) || 0, amount = player.wager || 0;
                result.payout = payout;
                const outcome = amount ? payout > amount ? "win" : payout === amount ? "push" : "loss" : result.won ? "win" : "loss";
                result.wager = amount; result.outcome = outcome;
                settlements.push({ userId: result.id, game: "blackjack-mp", amount, payout, outcome, detail: { tableCode: code, player: player.hand, playerTotal: result.total, hits: player.hits ?? Math.max(0, player.hand.length - 2), allWin: player.allWin === true } });
            }
            recordBets(settlements);
            t.pot = 0;
            t.results = results;
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
        t.phase = "lobby";
        broadcastTable(t, io);
    }, 5000).unref();
}

function dealRound(t, restoreEnergy = false) {
    const onlinePlayers = [...t.players].filter(([,p]) => p.socketIds.size);
    const monetary = onlinePlayers.some(([,p]) => p.pendingBet);
    if (monetary && (onlinePlayers.length < 2 || onlinePlayers.some(([,p]) => !p.pendingBet))) throw new Error("Todos os jogadores devem confirmar uma aposta, ou jogar sem apostas.");
    t.pot = 0;
    t.results = null;
    t.round++;
    t.limit = 21;
    t.deck = newDeck();
    t.discard = [];
    t.order = [];
    const wagers = onlinePlayers.filter(([, player]) => player.pendingBet);
    const charged = pool.adjustWalletsSync(wagers.map(([id, player]) => ({ userId: id, walletKind: "coop", kind: "bet", refType: "blackjack", refId: t.code,
        delta: (wallet) => -wager(player.pendingBet.allWin ? wallet.balance : player.pendingBet.amount, player.pendingBet.allWin ? 1 : 10, player.pendingBet.allWin ? Number.MAX_SAFE_INTEGER : 1000000) })));
    const balances = new Map(wagers.map(([id], index) => [id, charged[index]]));
    for (const [id, p] of t.players) {
        const online = p.socketIds.size > 0;
        p.wager = 0; p.allWin = false;
        if (online && p.pendingBet) {
            const wallet = balances.get(id);
            p.wager = wallet.previousBalance - wallet.balance; p.allWin = wallet.balance === 0;
            t.pot += p.wager;
            if (!Number.isSafeInteger(t.pot)) throw new Error("Saldo fora do limite permitido.");
        }
        p.pendingBet = null;
        p.hand = online ? [t.deck.pop(), t.deck.pop()] : [];
        p.stood = !online;
        p.busted = false;
        p.shield = false;
        p.lastDrawn = null;
        p.lastAttack = null;
        p.hits = 0;
        if (online && (restoreEnergy || t.round > 1)) p.nrg = Math.min(p.nrg + 2, 10);
        if (online) t.order.push(id);
    }
    t.turnIdx = 0;
    t.phase = "playing";
    if (t.pot >= 10000000) require("../services/achievements").unlockAchievements(t.order.map((userId) => ({ userId, key: "rich_friends" })));
}

function broadcastTable(t, io) {
    const inventory = bj.inventories([...t.players.keys()]);
    [...t.players.values()].forEach((player, index) => { player.specials = inventory[index].flatMap((card) => Array(card.qty).fill(card.key)); });
    store.save("blackjack", t);
    io.to("bj:" + t.code).emit("bj:state", tableState(t));
    for (const p of t.players.values()) for (const socketId of p.socketIds) {
        io.to(socketId).emit("bj:specials", { cards: p.specials });
    }
}
function setupBlackjackMultiplayer(realIO) {
    let pendingEvents = null;
    const io = {
        on: (...args) => realIO.on(...args),
        to: (channel) => ({ emit(event, data) {
            if (pendingEvents) pendingEvents.push({ channel, event, data: structuredClone(data) });
            else realIO.to(channel).emit(event, data);
        } }),
    };
    function waitForReconnect(t, userId) {
        const player = t.players.get(userId), timerKey = t.code + ":" + userId;
        player.reconnectUntil = Date.now() + 25000;
        clearTimeout(reconnectTimers.get(timerKey));
        function expire() {
            reconnectTimers.delete(timerKey);
            const active = tables.get(t.code), offline = active?.players.get(userId);
            if (!offline || offline.socketIds.size) return;
            const before = structuredClone(active);
            pendingEvents = [];
            try {
                pool.transactionSync(() => {
                    offline.reconnectUntil = 0; offline.stood = true;
                    if (active.phase === "playing" && active.order[active.turnIdx] === userId) nextTurn(active, io, t.code);
                    broadcastTable(active, io);
                });
                const events = pendingEvents; pendingEvents = null;
                for (const message of events) realIO.to(message.channel).emit(message.event, message.data);
            } catch (error) {
                Object.assign(active, before);
                console.error("Blackjack reconnection:", error.message);
                reconnectTimers.set(timerKey, setTimeout(expire, 5000).unref());
            } finally { pendingEvents = null; }
        }
        reconnectTimers.set(timerKey, setTimeout(expire, 25000).unref());
    }
    // Restored tables have no live sockets; recover escrow after the reconnect window.
    for (const t of tables.values()) if (t.phase === "playing") {
        for (const [id,p] of t.players) if (!p.socketIds.size) waitForReconnect(t,id);
        store.save("blackjack",t);
    }

    io.on("connection", (socket) => {
        socket.data.tableCode = null;
        function on(event, fn) {
            socket.on(event, (data, cb) => {
                if (typeof data === "function") { cb = data; data = {}; }
                const t = tables.get(socket.data.tableCode), before = t && structuredClone(t);
                const priorCode = socket.data.tableCode;
                const target = event === "bj:join" ? tables.get(String(data?.code || "").trim().toUpperCase()) : null;
                const targetBefore = target && target !== t && structuredClone(target);
                const priorCodes = event === "bj:create" ? new Set(tables.keys()) : null;
                let response;
                pendingEvents = [];
                try {
                    pool.transactionSync(() => {
                        fn(data || {}, (result) => { response = result; });
                        const active = tables.get(socket.data.tableCode);
                        if (active) store.save("blackjack", active);
                    });
                    const events = pendingEvents; pendingEvents = null;
                    for (const message of events) realIO.to(message.channel).emit(message.event, message.data);
                    if (typeof cb === "function") cb(response || { ok: true });
                } catch (err) {
                    if (t && before) Object.assign(t, before);
                    if (targetBefore) Object.assign(target, targetBefore);
                    if (priorCodes) for (const key of tables.keys()) if (!priorCodes.has(key)) tables.delete(key);
                    socket.data.tableCode = priorCode;
                    if (typeof cb === "function") cb({ ok: false, error: err.message });
                } finally { pendingEvents = null; }
            });
        }

        // ---------- CRIAR/ENTRAR ----------
        on("bj:create", (data, cb) => {
            if (tables.get(socket.data.tableCode)?.phase === "playing") throw new Error("Finalize a rodada antes de trocar de mesa.");
            let code;
            do { code = secureCode(); } while (tables.has(code));
            const t = newTable(code, socket.userId);
            tables.set(code, t);
            joinTable(socket, t, io, cb);
        });

        on("bj:join", (data, cb) => {
            const t = tables.get(String(data && data.code || "").toUpperCase().trim());
            if (!t) return cb && cb({ ok: false, error: "Mesa não encontrada." });
            joinTable(socket, t, io, cb);
        });

        function joinTable(socket, t, io, cb) {
            const prior = tables.get(socket.data.tableCode);
            if (prior && prior !== t && prior.phase === "playing") throw new Error("Finalize a rodada antes de trocar de mesa.");
            if (!t.players.has(socket.userId)) {
                if (t.players.size >= 8) return cb && cb({ ok: false, error: "Mesa cheia." });
                if (t.phase !== "lobby" && t.phase !== "finished") return cb && cb({ ok: false, error: "Rodada em andamento." });
            }
            if (prior && prior !== t) {
                prior.players.get(socket.userId)?.socketIds.delete(socket.id);
                socket.leave("bj:" + prior.code);
                broadcastTable(prior, io);
            }
            if (!t.players.has(socket.userId)) {
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
            const joining = t.players.get(socket.userId);
            if (!joining.inventoryMigrated) {
                for (const key of joining.specials || []) if (Object.hasOwn(SPECIAL_CARDS, key)) bj.addCard(socket.userId, key);
                joining.inventoryMigrated = true;
            }
            joining.socketIds.add(socket.id);
            joining.reconnectUntil = 0;
            const timerKey = t.code + ":" + socket.userId;
            clearTimeout(reconnectTimers.get(timerKey)); reconnectTimers.delete(timerKey);
            if (!t.players.get(t.hostId)?.socketIds.size) t.hostId = socket.userId;
            if (t.phase === "playing" && !present(t.players.get(t.order[t.turnIdx]))) nextTurn(t, io, t.code);
            socket.data.tableCode = t.code;
            socket.join(`bj:${t.code}`);
            broadcastTable(t, io);
            cb && cb({ ok: true, table: tableState(t) });
        }

        // ---------- INICIAR RODADA ----------
        on("bj:bet", (data, cb) => {
            const t = tables.get(socket.data.tableCode), p = t?.players.get(socket.userId);
            if (!p || t.phase === "playing") throw new Error("Apostas fechadas.");
            if (data.amount === 0 && data.allWin !== true) p.pendingBet = null;
            else {
                const amount = require("../services/rounds").resolveWager(socket.userId, data, "coop");
                if (amount > pool.getWalletSync(socket.userId, "coop").balance) throw new Error("Saldo COOP insuficiente.");
                p.pendingBet = { amount, allWin: data.allWin === true };
            }
            broadcastTable(t, io); cb({ ok: true });
        });
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
            p.hits = (p.hits || 0) + 1;
            p.lastDrawn = card;

            // chance de carta especial
            maybeSpecial(t, p, io, t.code);

            const total = handValue(p.hand, t.limit);
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
            io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `✋ ${p.username} parou em ${handValue(p.hand, t.limit)}.`, at: Date.now() });
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
            const effect = key === "mirror" ? me.lastAttack.key : key;
            if (effect === "remove_last" && target.hand.length <= 2) return cb && cb({ ok: false, error: "Nenhuma carta extra para remover." });
            if (key === "shield" && me.shield) return cb && cb({ ok: false, error: "Escudo ja ativo." });
            if (key === "pick_card" && !t.deck.some((c) => c.rank === String(data.rank || "A") && c.suit === String(data.suit || "♠"))) return cb && cb({ ok: false, error: "Carta não disponível no baralho." });
            bj.consume(socket.userId, key);
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
                    if (handValue(target.hand, t.limit) > t.limit) {
                        target.busted = true;
                        io.to(`bj:${t.code}`).emit("bj:chat", { system: true, message: `💥 ${target.username} estourou com ${handValue(target.hand, t.limit)}!`, at: Date.now() });
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
                        me.hits = (me.hits || 0) + 1;
                        me.lastDrawn = card;
                        if (handValue(me.hand, t.limit) > t.limit) me.busted = true;
                    }
                    break;
                }
                case "draw_three": {
                    me.hits = (me.hits || 0) + 3;
                    for (let i = 0; i < 3; i++) {
                        const card = draw(t);
                        me.hand.push(card);
                        me.lastDrawn = card;
                    }
                    if (handValue(me.hand, t.limit) > t.limit) me.busted = true;
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
                p.busted = handValue(p.hand, t.limit) > t.limit;
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
            io.to(`bj:${code}`).emit("bj:chat", { ...require("../services/avatars").identity(socket.userId), message, at: Date.now() });
        });

        socket.on("disconnect", () => {
            const code = socket.data.tableCode;
            if (!code) return;
            const t = tables.get(code);
            if (t && t.players.has(socket.userId)) {
                const player = t.players.get(socket.userId);
                player.socketIds.delete(socket.id);
                if (!player.socketIds.size) {
                    if (t.hostId === socket.userId) t.hostId = [...t.players].find(([, p]) => p.socketIds.size)?.[0] || t.hostId;
                    waitForReconnect(t,socket.userId);
                }
                broadcastTable(t, io);
            }
        });
    });

    return { tables };
}

module.exports = { setupBlackjackMultiplayer, SPECIAL_CARDS, rollSpecialCard };
