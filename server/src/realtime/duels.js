const pool = require("../config/database");
const { GAMES } = require("../routes/game.routes");
const { code, random } = require("../services/random");
const store = require("../services/realtimeStore");
const { wager, recordBet } = require("../services/rounds");
const roulette = require("../services/roulette");
const { TRUMPS, resolveSpin, rollCardDrop } = require("../services/slotsEngine");
const { unlockAchievement, trackDuelActivity } = require("../services/progression.routes");
const duels = store.load("duel");
const MODES = ["dice", "coinflip", "crash", "mines", "roulette", "slots"];

function syncBalances(duel) {
    for (const p of Object.values(duel.players)) if (p) p.balance = pool.getWalletSync(p.userId, "duel").balance;
}
function duelState(duel) {
    syncBalances(duel);
    const player = (p) => p ? { userId: p.userId, username: p.username, balance: p.balance, ready: p.ready } : null;
    return { code: duel.code, phase: duel.phase, round: duel.round, turn: duel.turn, p1: player(duel.players.p1), p2: player(duel.players.p2),
        auction: duel.auction, auctionWinner: duel.auctionWinner, chosenGame: duel.chosenGame, log: duel.log.slice(-50) };
}
function pushLog(duel, message) {
    duel.log.push({ system: true, message, at: Date.now() });
    if (duel.log.length > 100) duel.log.shift();
}
function createDuel(userId, username) {
    let roomCode;
    do { roomCode = code(); } while (duels.has(roomCode));
    const duel = { code: roomCode, phase: "waiting", round: 1, turn: "p1",
        players: { p1: { userId, username, balance: pool.getWalletSync(userId, "duel").balance, ready: false, socketIds: new Set() }, p2: null },
        auction: null, auctionWinner: null, chosenGame: null, log: [] };
    store.save("duel", duel);
    duels.set(roomCode, duel);
    return duel;
}
function playGame(game, amount, choice = {}) {
    if (game === "dice" || game === "coinflip") return GAMES[game].play(amount, choice);
    if (game === "mines") return GAMES.mines.play(amount, { mines: 5, picks: choice.picks ?? 3 });
    if (game === "roulette") {
        const bet = roulette.validateBet({ type: choice.bet ?? "red", amount });
        const result = roulette.spin([bet]);
        return { payout: result.totalPayout, detail: result };
    }
    if (game === "crash") {
        const target = Number(choice.autoCashout ?? 2);
        if (!Number.isFinite(target) || target < 1.01 || target > 100) throw new Error("Cashout inválido.");
        const crashPoint = Math.max(1, Math.floor(1 / (1 - random()) * 100) / 100);
        return { payout: crashPoint >= target ? Math.floor(amount * target) : 0, detail: { crashPoint, target } };
    }
    throw new Error("Jogo inválido.");
}
function finishDuel(duel, winnerKey) {
    if (duel.phase === "finished") return;
    duel.phase = "finished";
    duel.winnerKey = winnerKey;
    const winner = duel.players[winnerKey], loser = duel.players[winnerKey === "p1" ? "p2" : "p1"];
    pool.db.run("INSERT INTO duel_stats (user_id, wins, losses) VALUES (?, 1, 0) ON CONFLICT(user_id) DO UPDATE SET wins = wins + 1", [winner.userId]);
    pool.db.run("INSERT INTO duel_stats (user_id, wins, losses) VALUES (?, 0, 1) ON CONFLICT(user_id) DO UPDATE SET losses = losses + 1", [loser.userId]);
    unlockAchievement(winner.userId, "duel_winner");
    trackDuelActivity(winner.userId, true); trackDuelActivity(loser.userId);
    pushLog(duel, winner.username + " venceu o duelo!");
}
function setupDuels(io) {
    io.on("connection", (socket) => {
        socket.data.duelCode = null;
        function participant(duel) {
            const key = Object.keys(duel.players).find((k) => duel.players[k]?.userId === socket.userId);
            if (!key) throw new Error("Você não participa do duelo.");
            return key;
        }
        function current() {
            const duel = duels.get(socket.data.duelCode);
            if (!duel) throw new Error("Você não está num duelo.");
            participant(duel);
            return duel;
        }
        function publish(duel) {
            io.to("duel:" + duel.code).emit("duel:state", duelState(duel));
            if (duel.phase === "finished") {
                const winner = duel.cancelled ? null : duel.players[duel.winnerKey || (duel.players.p1.balance >= 10 ? "p1" : "p2")];
                io.to("duel:" + duel.code).emit("duel:finished", { winner: winner?.username || null, cancelled: !!duel.cancelled });
            }
        }
        function on(event, fn) {
            socket.on(event, (data, cb) => {
                if (typeof data === "function") { cb = data; data = {}; }
                const duel = duels.get(socket.data.duelCode);
                const before = duel && structuredClone(duel);
                try {
                    const result = pool.transactionSync(() => {
                        const result = fn(data || {});
                        const active = duels.get(socket.data.duelCode);
                        if (active) store.save("duel", active);
                        return result;
                    });
                    const active = duels.get(socket.data.duelCode);
                    if (active) publish(active);
                    if (result.left) { socket.leave("duel:" + active.code); socket.data.duelCode = null; }
                    if (typeof cb === "function") cb({ ok: true, ...result });
                } catch (err) {
                    if (duel && before) Object.assign(duel, before);
                    if (typeof cb === "function") cb({ ok: false, error: err.message });
                }
            });
        }
        on("duel:create", () => {
            const active = [...duels.values()].find((d) => d.phase !== "finished" && Object.values(d.players).some((p) => p?.userId === socket.userId));
            const duel = active || createDuel(socket.userId, socket.username);
            const key = participant(duel);
            duel.players[key].socketIds.add(socket.id);
            socket.data.duelCode = duel.code; socket.join("duel:" + duel.code);
            return { duel: duelState(duel) };
        });
        on("duel:join", (data) => {
            const duel = duels.get(String(data.code || "").toUpperCase().trim());
            if (!duel || duel.phase === "finished") throw new Error("Duelo não encontrado.");
            const other = [...duels.values()].find((d) => d !== duel && d.phase !== "finished" && Object.values(d.players).some((p) => p?.userId === socket.userId));
            if (other) throw new Error("Você já participa de outro duelo.");
            let key = Object.keys(duel.players).find((k) => duel.players[k]?.userId === socket.userId);
            if (!key) {
                if (duel.players.p2) throw new Error("Duelo cheio.");
                key = "p2";
                duel.players.p2 = { userId: socket.userId, username: socket.username, balance: pool.getWalletSync(socket.userId, "duel").balance, ready: false, socketIds: new Set() };
            }
            duel.players[key].socketIds.add(socket.id);
            socket.data.duelCode = duel.code; socket.join("duel:" + duel.code);
            return { duel: duelState(duel) };
        });
        on("duel:ready", () => {
            const duel = current(), key = participant(duel);
            if (duel.phase === "ready" && key === "p1") {
                duel.phase = "auction";
                duel.auction = MODES.map((game) => ({ game, bids: { p1: 0, p2: 0 } }));
            } else if (duel.phase === "waiting" || duel.phase === "ready") {
                duel.players[key].ready = true;
                if (duel.players.p1.ready && duel.players.p2?.ready) duel.phase = "ready";
            } else throw new Error("Duelo já iniciado.");
            return {};
        });
        on("duel:leave", () => {
            const duel = current(), key = participant(duel);
            if (duel.phase === "finished") throw new Error("Duelo já encerrado.");
            if (duel.phase === "playing") finishDuel(duel, key === "p1" ? "p2" : "p1");
            else { duel.phase = "finished"; duel.cancelled = true; pushLog(duel, "Duelo cancelado antes da partida."); }
            duel.players[key].socketIds.delete(socket.id);
            return { left: true };
        });
        on("duel:bid", (data) => {
            const duel = current(), key = participant(duel);
            if (duel.phase !== "auction") throw new Error("Leilão fechado.");
            const slot = duel.auction[Number(data.gameIdx)];
            const amount = wager(data.amount);
            if (!slot) throw new Error("Modo inválido.");
            if (pool.getWalletSync(socket.userId, "duel").balance < amount) throw new Error("Saldo DUEL insuficiente.");
            if (amount <= Math.max(...Object.values(slot.bids))) throw new Error("O lance deve superar o anterior.");
            slot.bids[key] = amount;
            return {};
        });
        on("duel:choose", (data) => {
            const duel = current(), key = participant(duel), oppKey = key === "p1" ? "p2" : "p1";
            if (duel.phase !== "auction") throw new Error("Leilão fechado.");
            const slot = duel.auction[Number(data.gameIdx)];
            if (!slot || slot.bids[key] <= slot.bids[oppKey]) throw new Error("Você precisa liderar o lance.");
            const wallet = pool.getWalletSync(socket.userId, "duel");
            if (wallet.balance - slot.bids[key] < 10) throw new Error("Reserve pelo menos 10 AC para jogar.");
            pool.adjustBalanceSync(wallet.id, -slot.bids[key], "bet", "duel", duel.code);
            duel.auctionWinner = key; duel.chosenGame = slot.game; duel.turn = key; duel.phase = "playing";
            return {};
        });
        on("duel:play", (data) => {
            const duel = current(), key = participant(duel), oppKey = key === "p1" ? "p2" : "p1";
            if (duel.phase !== "playing" || duel.turn !== key) throw new Error("Não é sua vez.");
            const game = duel.chosenGame;
            if (data.game && data.game !== game) throw new Error("Jogue o modo escolhido no leilão.");
            const wallet = pool.getWalletSync(socket.userId, "duel");
            const opp = duel.players[oppKey], oppWallet = pool.getWalletSync(opp.userId, "duel");
            let amount = wager(data.wager);
            const trump = game === "slots" ? data.choice?.trump || null : null;
            if (trump && !Object.hasOwn(TRUMPS, trump)) throw new Error("Trunfo inválido.");
            if (trump === "allwin") amount = wallet.balance;
            const maximum = amount * (trump === "duplicador" ? 2 : 1);
            if (wallet.balance < maximum) throw new Error("Saldo DUEL insuficiente para a perda máxima.");
            if (trump) {
                const owned = pool.db.get("SELECT id FROM slots_cards WHERE user_id = ? AND card_key = ? LIMIT 1", [socket.userId, trump]);
                if (!owned) throw new Error("Você não possui esse trunfo.");
                pool.db.run("DELETE FROM slots_cards WHERE id = ?", [owned.id]);
            }
            const spin = game === "slots" ? resolveSpin({ wager: amount, trump }) : null;
            const raw = spin ? { payout: spin.payout, detail: spin } : playGame(game, amount, data.choice);
            const charged = amount * (spin?.lossMultiplier || 1);
            let profit = raw.payout - charged;
            if (trump === "allwin") profit = raw.payout > amount ? oppWallet.balance : -wallet.balance;
            const transfer = profit > 0 ? Math.min(profit, oppWallet.balance) : Math.max(profit, -wallet.balance);
            pool.adjustBalanceSync(wallet.id, transfer, transfer >= 0 ? "payout" : "bet", "duel", duel.code);
            pool.adjustBalanceSync(oppWallet.id, -transfer, transfer > 0 ? "bet" : "payout", "duel", duel.code);
            const outcome = transfer > 0 ? "win" : transfer < 0 ? "loss" : "push";
            const result = { outcome, multiplier: (charged + transfer) / charged, payout: charged + transfer, detail: raw.detail };
            recordBet(socket.userId, "duel", charged, result.payout, outcome, { ...raw.detail, game, duelCode: duel.code });
            if (game === "slots") {
                result.card = rollCardDrop(true);
                if (result.card) pool.db.run("INSERT INTO slots_cards (user_id, card_key, rarity) VALUES (?, ?, ?)", [socket.userId, result.card.key, result.card.rarity]);
            }
            syncBalances(duel);
            pushLog(duel, socket.username + " jogou " + game + ": " + transfer + " AC.");
            if (duel.players.p1.balance < 10 || duel.players.p2.balance < 10) finishDuel(duel, duel.players.p1.balance < 10 ? "p2" : "p1");
            else if (trump !== "bloqueador") { duel.turn = oppKey; duel.round++; }
            return { result };
        });
        socket.on("disconnect", () => {
            const duel = duels.get(socket.data.duelCode);
            if (duel) { duel.players[participant(duel)].socketIds.delete(socket.id); store.save("duel", duel); }
        });
    });
    return { duels };
}
module.exports = { setupDuels, duels, createDuel };
