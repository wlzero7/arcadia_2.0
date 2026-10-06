const pool = require("../config/database");
const { code, random } = require("../services/random");
const { GAMES } = require("../routes/game.routes");
const { TRUMPS, resolveSpin, rollCardDrop } = require("../services/slotsEngine");
const { wager, recordBet } = require("../services/rounds");
const roulette = require("../services/roulette");
const { allocateShares } = require("../services/roomShares");
const { unlockAchievement, trackRoomActivity } = require("../services/progression.routes");
const rooms = new Map();
const MULTI_GAMES = { dice: {}, coinflip: {}, crash: {}, roulette: {}, slots: {} };

function roomSummary(room) {
    return { code: room.code, name: room.name, hostId: room.hostId, game: room.game,
        minBet: room.minBet, maxBet: room.maxBet, maxPlayers: room.maxPlayers, pot: room.pot,
        players: [...room.members].map(([id, m]) => ({ id, username: m.username, stake: room.stakes.get(id) || 0, online: m.socketIds.size > 0 })),
        history: room.history.slice(-20), rBets: room.rBets, rLast: room.rLast };
}
function persistRoomMember(room, userId) {
    pool.db.run("INSERT INTO room_members (room_id, user_id, role, stake) VALUES (?, ?, ?, ?) ON CONFLICT(room_id, user_id) DO UPDATE SET role = excluded.role, stake = excluded.stake",
        [room.id, userId, userId === room.hostId ? "host" : "player", room.stakes.get(userId) || 0]);
}
function persistRoomCreate(room) {
    return pool.transactionSync(() => {
        const result = pool.db.run("INSERT INTO rooms (code, name, host_id, game, max_players, min_bet, max_bet) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [room.code, room.name, room.hostId, room.game, room.maxPlayers, room.minBet, room.maxBet]);
        room.id = result.lastInsertRowid;
        pool.db.run("INSERT INTO room_pot (room_id, balance) VALUES (?, ?)", [room.id, room.pot]);
        for (const id of room.members.keys()) persistRoomMember(room, id);
        unlockAchievement(room.hostId, "room_host");
    });
}
function persistRoom(room) {
    pool.db.run("UPDATE rooms SET host_id = ? WHERE id = ?", [room.hostId, room.id]);
    pool.db.run("UPDATE room_pot SET balance = ?, pending_bets = ?, history = ? WHERE room_id = ?",
        [room.pot, JSON.stringify(room.rBets), JSON.stringify(room.history), room.id]);
    for (const id of room.members.keys()) persistRoomMember(room, id);
}
function hydrateRooms() {
    const rows = pool.db.all("SELECT r.*, p.balance AS pot, p.pending_bets, p.history FROM rooms r JOIN room_pot p ON p.room_id = r.id WHERE r.status IN ('lobby','playing')");
    for (const row of rows) {
        const room = { id: row.id, code: row.code, name: row.name, hostId: row.host_id, game: row.game,
            minBet: row.min_bet, maxBet: row.max_bet, maxPlayers: row.max_players, pot: row.pot,
            members: new Map(), stakes: new Map(), history: JSON.parse(row.history), rBets: JSON.parse(row.pending_bets), rLast: null, createdAt: Date.now() };
        for (const m of pool.db.all("SELECT rm.*, u.username FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE room_id = ?", [row.id])) {
            room.members.set(m.user_id, { username: m.username, socketIds: new Set(), lastSeen: Date.now() });
            room.stakes.set(m.user_id, m.stake);
        }
        // Recover legacy contributions using the transaction ledger, including members removed on disconnect.
        if (room.pot > 0 && ![...room.stakes.values()].some((n) => n > 0)) {
            const contributions = pool.db.all("SELECT w.user_id, u.username, MAX(0, -SUM(t.amount)) AS stake FROM transactions t JOIN wallets w ON w.id = t.wallet_id JOIN users u ON u.id = w.user_id WHERE t.ref_type = 'room' AND t.ref_id = ? AND t.kind IN ('room_stake','room_payout','room_refund') GROUP BY w.user_id", [room.code]);
            for (const entry of contributions.filter((c) => c.stake > 0)) {
                if (!room.members.has(entry.user_id)) room.members.set(entry.user_id, { username: entry.username, socketIds: new Set(), lastSeen: Date.now() });
                room.stakes.set(entry.user_id, entry.stake);
            }
            if (![...room.stakes.values()].some((n) => n > 0)) room.stakes.set(room.hostId, 1);
            room.stakes = allocateShares(room.stakes, room.pot);
            pool.transactionSync(() => persistRoom(room));
        }
        rooms.set(room.code, room);
    }
}
function mutate(room, fn) {
    const before = structuredClone(room);
    try {
        return pool.transactionSync(() => { const result = fn(); persistRoom(room); return result; });
    } catch (err) {
        Object.assign(room, before);
        throw err;
    }
}
function consumeTrump(userId, trump, pot, amount) {
    if (!trump) return;
    if (!Object.hasOwn(TRUMPS, trump) || TRUMPS[trump].duelOnly) throw new Error("Trunfo inválido.");
    if (pot < amount * (trump === "duplicador" ? 2 : 1)) throw new Error("Pote insuficiente para a perda máxima do trunfo.");
    const owned = pool.db.get("SELECT id FROM slots_cards WHERE user_id = ? AND card_key = ? LIMIT 1", [userId, trump]);
    if (!owned) throw new Error("Você não possui esse trunfo.");
    pool.db.run("DELETE FROM slots_cards WHERE id = ?", [owned.id]);
}
function setupMultiplayer(io) {
    hydrateRooms();
    io.on("connection", (socket) => {
        socket.data.roomCode = null;
        function current() {
            const room = rooms.get(socket.data.roomCode);
            if (!room || !room.members.get(socket.userId)?.socketIds.has(socket.id)) throw new Error("Você não está numa sala.");
            return room;
        }
        function broadcast(room) { io.to("room:" + room.code).emit("room:update", roomSummary(room)); }
        function on(event, fn) {
            socket.on(event, (data, cb) => {
                if (typeof data === "function") { cb = data; data = {}; }
                try { const result = fn(data || {}); if (typeof cb === "function") cb({ ok: true, ...result }); }
                catch (err) { if (typeof cb === "function") cb({ ok: false, error: err.message }); }
            });
        }
        function leave() {
            const room = rooms.get(socket.data.roomCode);
            if (!room) return;
            const member = room.members.get(socket.userId);
            if (member) {
                member.socketIds.delete(socket.id);
                member.lastSeen = Date.now();
                // Funded members stay in the roster while offline so their shares remain withdrawable.
                if (!member.socketIds.size && !(room.stakes.get(socket.userId) > 0) && !room.rBets.length) {
                    room.members.delete(socket.userId);
                    room.stakes.delete(socket.userId);
                    pool.db.run("DELETE FROM room_members WHERE room_id = ? AND user_id = ?", [room.id, socket.userId]);
                }
                if (room.hostId === socket.userId && !member.socketIds.size) {
                    room.hostId = [...room.members].find(([, m]) => m.socketIds.size)?.[0] || [...room.members.keys()][0] || socket.userId;
                }
                if (!room.members.size && room.pot === 0 && !room.rBets.length) {
                    pool.db.run("UPDATE rooms SET status = 'closed' WHERE id = ?", [room.id]);
                    rooms.delete(room.code);
                } else pool.transactionSync(() => persistRoom(room));
            }
            socket.leave("room:" + room.code);
            socket.data.roomCode = null;
            broadcast(room);
        }
        on("room:create", (data) => {
            leave();
            let roomCode;
            do { roomCode = code(); } while (pool.db.get("SELECT 1 FROM rooms WHERE code = ?", [roomCode]));
            const minBet = wager(data.minBet ?? 10);
            const maxBet = wager(data.maxBet ?? 1000, minBet);
            const maxPlayers = Number(data.maxPlayers ?? 8);
            if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 16) throw new Error("Limite de jogadores inválido.");
            const game = data.game || "dice";
            if (!Object.hasOwn(MULTI_GAMES, game)) throw new Error("Jogo inválido.");
            const room = { code: roomCode, name: String(data.name || "Sala de " + socket.username).slice(0, 40), hostId: socket.userId, game, minBet, maxBet, maxPlayers,
                members: new Map([[socket.userId, { username: socket.username, socketIds: new Set([socket.id]), lastSeen: Date.now() }]]),
                stakes: new Map(), pot: 0, history: [], rBets: [], rLast: null, createdAt: Date.now() };
            persistRoomCreate(room);
            rooms.set(roomCode, room);
            socket.data.roomCode = roomCode;
            socket.join("room:" + roomCode);
            return { room: roomSummary(room) };
        });
        on("room:join", (data) => {
            const room = rooms.get(String(data.code || "").toUpperCase().trim());
            if (!room) throw new Error("Sala não encontrada.");
            const online = [...room.members.values()].filter((m) => m.socketIds.size).length;
            if (!room.members.has(socket.userId) && online >= room.maxPlayers) throw new Error("Sala cheia.");
            if (socket.data.roomCode !== room.code) leave();
            mutate(room, () => {
                if (!room.members.has(socket.userId)) room.members.set(socket.userId, { username: socket.username, socketIds: new Set(), lastSeen: Date.now() });
                room.members.get(socket.userId).socketIds.add(socket.id);
            });
            socket.data.roomCode = room.code;
            socket.join("room:" + room.code);
            broadcast(room);
            return { room: roomSummary(room) };
        });
        on("room:leave", () => { leave(); return {}; });
        on("room:stake", (data) => {
            const room = current();
            mutate(room, () => {
                if (room.rBets.length) throw new Error("Finalize o giro antes de depositar.");
                const amount = wager(data.amount, 1);
                const wallet = pool.getWalletSync(socket.userId, "coop");
                pool.adjustBalanceSync(wallet.id, -amount, "room_stake", "room", room.code);
                room.pot += amount;
                if (!Number.isSafeInteger(room.pot)) throw new Error("Saldo fora do limite permitido.");
                room.stakes.set(socket.userId, (room.stakes.get(socket.userId) || 0) + amount);
            });
            broadcast(room);
            return { room: roomSummary(room) };
        });
        on("room:withdraw", (data) => {
            const room = current();
            mutate(room, () => {
                if (room.rBets.length) throw new Error("Finalize o giro antes de sacar.");
                const myStake = room.stakes.get(socket.userId) || 0;
                const amount = wager(data.amount ?? myStake, 1, Number.MAX_SAFE_INTEGER);
                if (amount > myStake || amount > room.pot) throw new Error("Valor maior que sua participação no pote.");
                const wallet = pool.getWalletSync(socket.userId, "coop");
                pool.adjustBalanceSync(wallet.id, amount, "room_payout", "room", room.code);
                room.pot -= amount;
                room.stakes.set(socket.userId, myStake - amount);
            });
            broadcast(room);
            return { room: roomSummary(room) };
        });
        function addHistory(room, result) {
            const entry = { id: code(12), playerId: socket.userId, playerName: socket.username, ...result, potAfter: room.pot, at: Date.now() };
            room.history.push(entry);
            if (room.history.length > 100) room.history.shift();
            return entry;
        }
        on("room:play", (data) => {
            const room = current();
            const entry = mutate(room, () => {
                if (room.game === "roulette") throw new Error("Use as apostas da roleta.");
                const amount = wager(data.wager, room.minBet, room.maxBet);
                if (amount > room.pot) throw new Error("Pote insuficiente.");
                let result;
                if (room.game === "slots") {
                    const trump = data.choice?.trump || null;
                    consumeTrump(socket.userId, trump, room.pot, amount);
                    const spin = resolveSpin({ wager: amount, trump });
                    result = { ...spin, multiplier: spin.mult, wager: amount * spin.lossMultiplier };
                } else if (room.game === "crash") {
                    const target = Number(data.choice?.autoCashout ?? 2);
                    if (!Number.isFinite(target) || target < 1.01 || target > 100) throw new Error("Cashout inválido.");
                    const crashPoint = Math.max(1, Math.floor(1 / (1 - random()) * 100) / 100);
                    const win = crashPoint >= target;
                    result = { wager: amount, crashPoint, autoCashout: target, payout: win ? Math.floor(amount * target) : 0, multiplier: win ? target : 0 };
                } else result = { ...GAMES[room.game].play(amount, data.choice), wager: amount };
                result.type = room.game;
                result.outcome = result.payout > result.wager ? "win" : result.payout === result.wager ? "push" : "loss";
                room.pot += result.payout - result.wager;
                room.stakes = allocateShares(room.stakes, room.pot);
                recordBet(socket.userId, room.game, result.wager, result.payout, result.outcome, { ...result, roomCode: room.code });
                trackRoomActivity(socket.userId, room.code);
                if (room.game === "slots") {
                    result.card = rollCardDrop(false);
                    if (result.card) pool.db.run("INSERT INTO slots_cards (user_id, card_key, rarity) VALUES (?, ?, ?)", [socket.userId, result.card.key, result.card.rarity]);
                }
                // Preserve the flat fields consumed by the multiplayer client.
                Object.assign(result, result.detail);
                return addHistory(room, result);
            });
            io.to("room:" + room.code).emit("room:round", entry);
            broadcast(room);
            return { round: entry };
        });
        on("room:rbet", (data) => {
            const room = current();
            mutate(room, () => {
                if (room.game !== "roulette") throw new Error("Sala não é de roleta.");
                const bet = roulette.validateBet(data, room.minBet, room.maxBet);
                if (room.rBets.length >= 100) throw new Error("Limite de apostas atingido.");
                if (bet.amount > room.pot) throw new Error("Pote insuficiente.");
                room.pot -= bet.amount;
                room.rBets.push({ ...bet, userId: socket.userId, username: socket.username });
            });
            broadcast(room);
            return { room: roomSummary(room) };
        });
        on("room:rspin", () => {
            const room = current();
            const entry = mutate(room, () => {
                if (room.game !== "roulette" || !room.rBets.length) throw new Error("Nenhuma aposta na roleta.");
                const result = roulette.spin(room.rBets);
                room.pot += result.totalPayout;
                room.stakes = allocateShares(room.stakes, room.pot);
                room.rLast = result;
                for (const userId of new Set(room.rBets.map((b) => b.userId))) {
                    const bets = result.results.filter((b) => b.userId === userId);
                    const amount = bets.reduce((s, b) => s + b.amount, 0);
                    const payout = bets.reduce((s, b) => s + b.payout, 0);
                    recordBet(userId, "roulette", amount, payout, payout > amount ? "win" : payout === amount ? "push" : "loss", { results: bets, roomCode: room.code });
                    trackRoomActivity(userId, room.code);
                }
                room.rBets = [];
                return addHistory(room, { ...result, type: "roulette", wager: result.totalWager, payout: result.totalPayout });
            });
            io.to("room:" + room.code).emit("room:round", entry);
            broadcast(room);
            return { round: entry };
        });
        on("room:chat", (data) => {
            const room = current();
            const message = String(data.message || "").trim().slice(0, 240);
            if (message) io.to("room:" + room.code).emit("room:chat", { username: socket.username, message, at: Date.now() });
            return {};
        });
        on("rooms:list", () => ({ rooms: [...rooms.values()].map(roomSummary) }));
        socket.on("disconnect", () => { try { leave(); } catch (err) { console.error("Room disconnect:", err.message); } });
    });
    return { rooms, MULTI_GAMES };
}
module.exports = { setupMultiplayer, rooms, persistRoomCreate, persistRoomMember, hydrateRooms, roomSummary };
