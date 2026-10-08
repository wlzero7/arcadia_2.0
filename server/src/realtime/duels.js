const pool = require("../config/database");
const { GAMES, minesMultiplier, crashMultiplier } = require("../routes/game.routes");
const { code, random, shuffle } = require("../services/random");
const store = require("../services/realtimeStore");
const { wager, recordBet } = require("../services/rounds");
const roulette = require("../services/roulette");
const { TRUMPS, resolveSpin, rollCardDrop } = require("../services/slotsEngine");
const bj = require("../services/blackjack");
const football = require("../services/football");
const clubs = require("../services/football-clubs");
const { unlockAchievement, trackDuelActivity } = require("../services/progression.routes");
const duels = store.load("duel");
const MODES = ["dice", "coinflip", "crash", "mines", "roulette", "slots", "blackjack", "football"];

function activeState(play) {
    if (!play) return null;
    if (play.game === "football") return { ...football.publicMatch(play), playerKey: play.playerKey, username: play.username };
    if (play.game === "blackjack") return { id: play.id, game: play.game, playerKey: play.playerKey, username: play.username, wager: play.wager, startedAt: play.startedAt, ...bj.publicHand(play) };
    const multiplier = play.game === "mines" ? minesMultiplier(play.mines.length, play.picked.length)
        : Math.floor(crashMultiplier(play.startedAt) * 100) / 100;
    return { id: play.id, game: play.game, playerKey: play.playerKey, username: play.username, wager: play.wager,
        startedAt: play.startedAt, autoCashout: play.autoCashout || null, picked: play.picked || [],
        minesCount: play.mines?.length, multiplier, potentialPayout: Math.floor(play.wager * multiplier) };
}

function syncBalances(duel) {
    for (const p of Object.values(duel.players)) if (p) p.balance = pool.getWalletSync(p.userId, "duel").balance;
}
function duelState(duel) {
    syncBalances(duel);
    const player = (p) => p ? { userId: p.userId, username: p.username, balance: p.balance, ready: p.ready } : null;
    return { code: duel.code, phase: duel.phase, round: duel.round, turn: duel.turn, p1: player(duel.players.p1), p2: player(duel.players.p2),
        auction: duel.auction, auctionWinner: duel.auctionWinner, chosenGame: duel.chosenGame,
        activePlay: activeState(duel.activePlay), lastPlay: duel.lastPlay || null, footballTeams: duel.footballTeams || null, footballMarkets: duel.footballMarkets || null, serverTime: Date.now(), log: duel.log.slice(-50) };
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
        auction: null, auctionWinner: null, chosenGame: null, activePlay: null, lastPlay: null, log: [] };
    store.save("duel", duel);
    duels.set(roomCode, duel);
    return duel;
}
function publicChoice(game, choice = {}) {
    if (game === "dice") return { number: Number(choice.number) || null };
    if (game === "coinflip") return { side: choice.side || null };
    if (game === "crash") return { autoCashout: Number(choice.autoCashout) || null };
    if (game === "mines") return { mines: Number(choice.mines) || 5 };
    if (game === "roulette") return { bet: choice.bet || "red" };
    if (game === "slots") return { trump: choice.trump || null };
    return {};
}
function playGame(game, amount, choice = {}) {
    if (game === "dice" || game === "coinflip") return GAMES[game].play(amount, choice);
    if (game === "roulette") {
        const bet = roulette.validateBet({ type: choice.bet ?? "red", amount }, 1, Number.MAX_SAFE_INTEGER);
        const result = roulette.spin([bet]);
        return { payout: result.totalPayout, detail: result };
    }
    throw new Error("Jogo inválido.");
}
function settlePlay(duel, key, amount, raw, choice = {}, trump = null, id = null) {
    const actor = duel.players[key], oppKey = key === "p1" ? "p2" : "p1";
    const wallet = pool.getWalletSync(actor.userId, "duel"), oppWallet = pool.getWalletSync(duel.players[oppKey].userId, "duel");
    const charged = amount * (raw.detail?.lossMultiplier || 1);
    let profit = raw.payout - charged;
    if (trump === "allwin") profit = raw.payout > amount ? oppWallet.balance : -wallet.balance;
    const transfer = profit > 0 ? Math.min(profit, oppWallet.balance) : Math.max(profit, -wallet.balance);
    pool.adjustBalanceSync(wallet.id, transfer, transfer >= 0 ? "payout" : "bet", "duel", duel.code);
    pool.adjustBalanceSync(oppWallet.id, -transfer, transfer > 0 ? "bet" : "payout", "duel", duel.code);
    const outcome = transfer > 0 ? "win" : transfer < 0 ? "loss" : "push";
    const result = { outcome, multiplier: (charged + transfer) / charged, payout: charged + transfer, detail: raw.detail };
    const cancelled = raw.payout === amount && (raw.detail?.cancelled || (duel.chosenGame === "mines" && !raw.detail?.opened?.length));
    if (cancelled) result.cancelled = true;
    else recordBet(actor.userId, "duel", charged, result.payout, outcome, { ...raw.detail, ...raw.detail?.detail, allWin: duel.activePlay?.allWin ?? (charged === wallet.balance), baseWager: amount, game: duel.chosenGame, duelCode: duel.code });
    if (duel.chosenGame === "slots") {
        result.card = rollCardDrop(true);
        if (result.card) pool.db.run("INSERT INTO slots_cards (user_id, card_key, rarity) VALUES (?, ?, ?)", [actor.userId, result.card.key, result.card.rarity]);
        require("../services/achievements").checkProfileAchievements(actor.userId);
    }
    if (duel.chosenGame === "blackjack" && !cancelled) result.card = bj.drop(actor.userId);
    syncBalances(duel);
    duel.lastPlay = { id: id || `${duel.code}:${duel.round}:${code()}`, round: duel.round, game: duel.chosenGame,
        playerKey: key, username: actor.username, wager: amount, charged, transfer, outcome,
        payout: result.payout, multiplier: result.multiplier, choice: publicChoice(duel.chosenGame, choice),
        detail: raw.detail, card: result.card || null, trump, at: Date.now() };
    duel.activePlay = null;
    pushLog(duel, actor.username + " jogou " + duel.chosenGame + ": " + transfer + " AC.");
    if (duel.players.p1.balance < 10 || duel.players.p2.balance < 10) finishDuel(duel, duel.players.p1.balance < 10 ? "p2" : "p1");
    else if (trump !== "bloqueador") { duel.turn = oppKey; duel.round++; }
    return result;
}
function updateCrash(duel, cashout = false) {
    const play = duel.activePlay;
    if (play?.game === "football") {
        if (Date.now() < play.startedAt + play.durationMs) return null;
        const result = football.result(play);
        return settlePlay(duel, play.playerKey, play.wager, { payout: result.payout, detail: result }, {}, null, play.id);
    }
    if (!play || play.game !== "crash") return null;
    const current = crashMultiplier(play.startedAt);
    const auto = play.autoCashout && play.autoCashout <= play.crashPoint && current >= play.autoCashout;
    const crashed = !auto && current >= play.crashPoint;
    if (!auto && !crashed && !cashout) return null;
    const multiplier = auto ? play.autoCashout : crashed ? 0 : Math.floor(current * 100) / 100;
    return settlePlay(duel, play.playerKey, play.wager, { payout: Math.floor(play.wager * multiplier),
        detail: { crashPoint: play.crashPoint, target: play.autoCashout, cashout: multiplier, crashed } },
        { autoCashout: play.autoCashout }, null, play.id);
}
function finishDuel(duel, winnerKey) {
    if (duel.phase === "finished") return;
    duel.phase = "finished";
    duel.winnerKey = winnerKey;
    const winner = duel.players[winnerKey], loser = duel.players[winnerKey === "p1" ? "p2" : "p1"];
    pool.db.run("INSERT INTO duel_stats (user_id, wins, losses) VALUES (?, 1, 0) ON CONFLICT(user_id) DO UPDATE SET wins = wins + 1", [winner.userId]);
    pool.db.run("INSERT INTO duel_stats (user_id, wins, losses) VALUES (?, 0, 1) ON CONFLICT(user_id) DO UPDATE SET losses = losses + 1", [loser.userId]);
    unlockAchievement(winner.userId, "first_victory");
    unlockAchievement(loser.userId, "first_defeat");
    trackDuelActivity(winner.userId, true); trackDuelActivity(loser.userId);
    pushLog(duel, winner.username + " venceu o duelo!");
}
function setupDuels(io) {
    const crashTimers = new Map();
    const liveTimer = setInterval(() => {
        for (const duel of duels.values()) if (duel.phase === "playing" && duel.activePlay?.game === "football") {
            io.to("duel:" + duel.code).emit("duel:live", { play: activeState(duel.activePlay), serverTime: Date.now() });
        }
    }, 500);
    liveTimer.unref();
    function publish(duel) {
        io.to("duel:" + duel.code).emit("duel:state", duelState(duel));
        if (duel.phase === "finished") {
            const winner = duel.cancelled ? null : duel.players[duel.winnerKey || (duel.players.p1.balance >= 10 ? "p1" : "p2")];
            io.to("duel:" + duel.code).emit("duel:finished", { winner: winner?.username || null, cancelled: !!duel.cancelled });
        }
    }
    function scheduleCrash(duel) {
        clearTimeout(crashTimers.get(duel.code));
        crashTimers.delete(duel.code);
        const play = duel.activePlay;
        if (duel.phase !== "playing" || !["crash", "football"].includes(play?.game)) return;
        const remaining = play.game === "football" ? play.startedAt + play.durationMs - Date.now()
            : play.startedAt + Math.log(Math.min(play.crashPoint, play.autoCashout || Infinity)) / (Math.log(1.06) * 6) * 1000 - Date.now();
        const timer = setTimeout(() => {
            const before = structuredClone(duel);
            try {
                pool.transactionSync(() => { updateCrash(duel); store.save("duel", duel); });
                publish(duel);
            } catch (err) {
                Object.assign(duel, before);
                console.error("Duelo Crash:", err.message);
            }
            scheduleCrash(duel);
        }, Math.max(100, Math.ceil(remaining)));
        timer.unref();
        crashTimers.set(duel.code, timer);
    }
    for (const duel of duels.values()) scheduleCrash(duel);
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
                    if (active) { publish(active); scheduleCrash(active); }
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
            updateCrash(duel);
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
            updateCrash(duel);
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
            if (duel.activePlay) {
                const play = duel.activePlay;
                settlePlay(duel, play.playerKey, play.wager, { payout: play.playerKey === key ? 0 : play.wager,
                    detail: { cancelled: true, minePositions: play.mines, opened: play.picked, crashPoint: play.crashPoint } }, {}, null, play.id);
            }
            if (duel.phase === "playing") finishDuel(duel, key === "p1" ? "p2" : "p1");
            else if (duel.phase !== "finished") { duel.phase = "finished"; duel.cancelled = true; pushLog(duel, "Duelo cancelado antes da partida."); }
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
            duel.auctionWinner = key; duel.chosenGame = slot.game; duel.turn = key; duel.phase = "playing"; duel.lastPlay = null;
            if (slot.game === "football") duel.footballTeams = Object.fromEntries(Object.entries(duel.players).map(([k, player]) => [k, clubs.asTeam(clubs.load(player.userId))]));
            if (slot.game === "football") duel.footballMarkets = { p1: football.market(duel.footballTeams.p1, duel.footballTeams.p2), p2: football.market(duel.footballTeams.p2, duel.footballTeams.p1) };
            return {};
        });
        on("duel:play", (data) => {
            const duel = current(), key = participant(duel);
            if (duel.phase !== "playing" || duel.turn !== key) throw new Error("Não é sua vez.");
            if (duel.activePlay) throw new Error("Uma jogada já está em andamento.");
            const game = duel.chosenGame;
            if (data.game && data.game !== game) throw new Error("Jogue o modo escolhido no leilão.");
            const wallet = pool.getWalletSync(socket.userId, "duel");
            let amount = data.allWin === true ? wager(wallet.balance, 1, Number.MAX_SAFE_INTEGER) : wager(data.wager);
            const trump = game === "slots" ? data.choice?.trump || null : null;
            if (trump && !Object.hasOwn(TRUMPS, trump)) throw new Error("Trunfo inválido.");
            if (trump === "allwin") amount = wallet.balance;
            const maximum = amount * (trump === "duplicador" ? 2 : 1);
            if (wallet.balance < maximum) throw new Error("Saldo DUEL insuficiente para a perda máxima.");
            if (game === "mines" || game === "crash" || game === "blackjack" || game === "football") {
                const play = { id: `${duel.code}:${duel.round}:${code()}`, game, playerKey: key, username: socket.username,
                    wager: amount, allWin: amount === wallet.balance, startedAt: Date.now() };
                if (game === "football") {
                    const oppKey = key === "p1" ? "p2" : "p1";
                    Object.assign(play, football.createMatch(duel.footballTeams[key], duel.footballTeams[oppKey], "home", amount));
                } else if (game === "mines") {
                    const count = Number(data.choice?.mines ?? 5);
                    if (!Number.isInteger(count) || count < 1 || count > 24) throw new Error("Número de minas inválido.");
                    play.mines = shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, count);
                    play.picked = [];
                } else if (game === "blackjack") {
                    Object.assign(play, bj.createHand());
                } else {
                    const target = data.choice?.autoCashout;
                    play.autoCashout = target == null || target === "" ? null : Number(target);
                    if (play.autoCashout !== null && (!Number.isFinite(play.autoCashout) || play.autoCashout < 1.01 || play.autoCashout > 100)) throw new Error("Cashout inválido.");
                    play.crashPoint = Math.max(1, Math.floor(1 / (1 - random()) * 100) / 100);
                }
                duel.activePlay = play;
                duel.lastPlay = null;
                pushLog(duel, socket.username + " iniciou " + game + ".");
                if (game === "blackjack" && (bj.handValue(play.player) === 21 || bj.handValue(play.dealer) === 21)) return { result: finishBlackjack(duel, play, true) };
                return { active: true };
            }
            if (trump) {
                const owned = pool.db.get("SELECT id FROM slots_cards WHERE user_id = ? AND card_key = ? LIMIT 1", [socket.userId, trump]);
                if (!owned) throw new Error("Você não possui esse trunfo.");
                pool.db.run("DELETE FROM slots_cards WHERE id = ?", [owned.id]);
            }
            const spin = game === "slots" ? resolveSpin({ wager: amount, trump, mode: "duel" }) : null;
            const raw = spin ? { payout: spin.payout, detail: spin } : playGame(game, amount, data.choice);
            return { result: settlePlay(duel, key, amount, raw, data.choice || {}, trump) };
        });
        on("duel:pick", (data) => {
            const duel = current(), key = participant(duel), play = duel.activePlay;
            if (duel.phase !== "playing" || play?.game !== "mines" || play.playerKey !== key) throw new Error("Não é sua vez de abrir células.");
            const cell = Number(data.cell);
            if (!Number.isInteger(cell) || cell < 0 || cell > 24) throw new Error("Célula inválida.");
            if (play.picked.includes(cell)) throw new Error("Célula já aberta.");
            play.picked.push(cell);
            if (play.mines.includes(cell)) {
                return { result: settlePlay(duel, key, play.wager, { payout: 0,
                    detail: { minePositions: play.mines, opened: play.picked, boom: cell } }, { mines: play.mines.length }, null, play.id) };
            }
            if (play.picked.length === 25 - play.mines.length) return { result: cashoutMines(duel, play) };
            return {};
        });
        function cashoutMines(duel, play) {
            const multiplier = minesMultiplier(play.mines.length, play.picked.length);
            return settlePlay(duel, play.playerKey, play.wager, { payout: Math.floor(play.wager * multiplier),
                detail: { minePositions: play.mines, opened: play.picked, multiplier } }, { mines: play.mines.length }, null, play.id);
        }
        function finishBlackjack(duel, play, natural = false) {
            return settlePlay(duel, play.playerKey, play.wager, bj.result(play, natural), {}, null, play.id);
        }
        for (const action of ["hit", "stand", "double", "special"]) on("duel:" + action, (data) => {
            const duel = current(), key = participant(duel), play = duel.activePlay;
            if (duel.phase !== "playing" || play?.game !== "blackjack" || play.playerKey !== key) throw new Error("Nao e sua vez no Blackjack.");
            if (action === "special") bj.useSpecial(socket.userId, play, data);
            else if (action === "hit") bj.drawPlayer(play);
            else if (action === "double") {
                if (!bj.publicHand(play).canDouble) throw new Error("Dobrar so com as duas cartas iniciais.");
                if (pool.getWalletSync(socket.userId, "duel").balance < play.wager * 2) throw new Error("Saldo DUEL insuficiente para dobrar.");
                play.wager *= 2; play.doubled = true; bj.drawPlayer(play);
                if (bj.handValue(play.player, play.limit) <= play.limit) bj.stand(play);
            } else bj.stand(play);
            if (action === "stand" || action === "double" || bj.handValue(play.player, play.limit) > play.limit) return { result: finishBlackjack(duel, play) };
            return {};
        });
        on("duel:cashout", () => {
            const duel = current(), key = participant(duel), play = duel.activePlay;
            if (duel.phase !== "playing" || !play || play.playerKey !== key) throw new Error("Nenhuma jogada sua em andamento.");
            if (play.game === "blackjack") throw new Error("Use Parar no Blackjack.");
            if (play.game === "football") throw new Error("Aguarde o apito final do futebol.");
            return { result: play.game === "mines" ? cashoutMines(duel, play) : updateCrash(duel, true) };
        });
        on("duel:sync", () => { const duel = current(); updateCrash(duel); return {}; });
        socket.on("disconnect", () => {
            const duel = duels.get(socket.data.duelCode);
            if (duel) { duel.players[participant(duel)].socketIds.delete(socket.id); store.save("duel", duel); }
        });
    });
    return { duels, close() { clearInterval(liveTimer); for (const timer of crashTimers.values()) clearTimeout(timer); } };
}
module.exports = { setupDuels, duels, createDuel };
