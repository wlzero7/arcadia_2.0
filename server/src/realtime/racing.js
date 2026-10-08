const pool = require("../config/database");
const { code, random, randomInt, shuffle } = require("../services/random");
const store = require("../services/realtimeStore");
const { wager, recordBet } = require("../services/rounds");
const HORSE_NAMES = ["Barry", "Clade", "Lucy", "Nicolas", "Augusto", "Pé de Vento", "Trovão", "Biscate", "Cometa", "Fuscão Preto", "Relâmpago", "Maradona"];
const races = store.load("race");
const timers = new Map();
function newRace(roomCode, hostId, round = 0, members = new Map()) {
    return { code: roomCode, hostId, phase: "betting", round, members,
        horses: shuffle([...HORSE_NAMES]).slice(0, 6).map((name, id) => ({ id, name, emoji: "🐎", weight: randomInt(1, 6) })),
        bets: new Map(), pot: 0 };
}
function odds(race) {
    const weight = race.horses.reduce((s, h) => s + h.weight, 0);
    return race.horses.map((h) => ({ id: h.id, mult: Math.floor(weight / h.weight * 100) / 100 }));
}
function progress(race, horse) {
    if (race.phase === "betting") return 0;
    const elapsed = Math.min(1, Math.max(0, (Date.now() - race.startedAt) / 14000));
    return horse.id === race.winnerId ? elapsed * 100 : elapsed * (70 + horse.id * 4);
}
function raceState(race) {
    return { code: race.code, hostId: race.hostId, phase: race.phase, round: race.round, pot: race.pot,
        horses: race.horses.map((h) => ({ ...h, progress: progress(race, h) })), odds: odds(race),
        bets: [...race.bets].map(([userId, b]) => ({ userId, ...b })) };
}
function setupRacing(io) {
    function publish(race) { io.to("race:" + race.code).emit("race:state", raceState(race)); }
    function finishRace(race) {
        if (race.phase !== "racing") return;
        const winner = race.horses.find((h) => h.id === race.winnerId);
        const winnerOdds = odds(race).find((o) => o.id === winner.id).mult;
        const payouts = [];
        const settled = { ...race, phase: "finished", pot: 0, finishedAt: Date.now() };
        pool.transactionSync(() => {
            for (const [uid, b] of race.bets) {
                const payout = b.horseId === winner.id ? Math.floor(b.amount * winnerOdds) : 0;
                const wallet = pool.getWalletSync(uid, "coop");
                if (payout) {
                    pool.adjustBalanceSync(wallet.id, payout, "room_payout", "race", race.code);
                    payouts.push({ userId: uid, username: b.username, payout });
                }
                const horse = race.horses.find((h) => h.id === b.horseId);
                recordBet(uid, "racing", b.amount, payout, payout > b.amount ? "win" : "loss", { horseId: b.horseId, winnerId: winner.id, horseName: horse.name, horseOdds: odds(race).find((o) => o.id === horse.id).mult, maxOdds: Math.max(...odds(race).map((o) => o.mult)), allWin: b.allWin === true, mode: "coop" });
            }
            settled.result = { winner, odds: winnerOdds, payouts };
            store.save("race", settled);
        });
        Object.assign(race, settled);
        io.to("race:" + race.code).emit("race:finished", race.result);
        publish(race); schedule(race);
    }
    function schedule(race) {
        clearInterval(timers.get(race.code));
        if (race.phase === "racing") {
            timers.set(race.code, setInterval(() => {
                try {
                    if (Date.now() >= race.startedAt + 14000) finishRace(race);
                    else io.to("race:" + race.code).emit("race:tick", { horses: race.horses.map((h) => ({ id: h.id, progress: progress(race, h) })) });
                } catch (err) { console.error("Race settlement:", err.message); }
            }, 500));
        } else if (race.phase === "finished") {
            timers.set(race.code, setTimeout(() => {
                const fresh = newRace(race.code, race.hostId, race.round + 1, race.members);
                store.save("race", fresh); races.set(race.code, fresh); publish(fresh);
            }, Math.max(0, race.finishedAt + 8000 - Date.now())));
        }
    }
    for (const race of races.values()) {
        race.members ||= new Map();
        schedule(race);
    }
    io.on("connection", (socket) => {
        socket.data.raceCode = null;
        function current() {
            const race = races.get(socket.data.raceCode);
            if (!race || !race.members.get(socket.userId)?.socketIds.has(socket.id)) throw new Error("Entre em uma corrida.");
            return race;
        }
        function join(race) {
            const prior = races.get(socket.data.raceCode);
            if (prior && prior !== race) {
                prior.members.get(socket.userId)?.socketIds.delete(socket.id);
                socket.leave("race:" + prior.code);
            }
            if (!race.members.has(socket.userId)) race.members.set(socket.userId, { username: socket.username, socketIds: new Set() });
            race.members.get(socket.userId).socketIds.add(socket.id);
            if (!race.members.get(race.hostId)?.socketIds.size) race.hostId = socket.userId;
            socket.data.raceCode = race.code; socket.join("race:" + race.code);
            store.save("race", race); publish(race);
            return { race: raceState(race) };
        }
        function on(event, fn) {
            socket.on(event, (data, cb) => {
                if (typeof data === "function") { cb = data; data = {}; }
                const race = races.get(socket.data.raceCode);
                const before = race && structuredClone(race);
                try {
                    const result = pool.transactionSync(() => {
                        const result = fn(data || {});
                        const active = races.get(socket.data.raceCode);
                        if (active) store.save("race", active);
                        return result;
                    });
                    const active = races.get(socket.data.raceCode);
                    if (active) publish(active);
                    if (typeof cb === "function") cb({ ok: true, ...result });
                } catch (err) {
                    if (race && before) Object.assign(race, before);
                    if (typeof cb === "function") cb({ ok: false, error: err.message });
                }
            });
        }
        on("race:create", () => {
            const active = [...races.values()].find((r) => r.phase !== "finished" && (r.hostId === socket.userId || r.bets.has(socket.userId)));
            if (active) return join(active);
            let roomCode;
            do { roomCode = code(); } while (races.has(roomCode));
            const race = newRace(roomCode, socket.userId); races.set(roomCode, race);
            return join(race);
        });
        on("race:join", (data) => {
            const race = races.get(String(data.code || "").trim().toUpperCase());
            if (!race) throw new Error("Corrida não encontrada.");
            return join(race);
        });
        on("race:bet", (data) => {
            const race = current();
            if (race.phase !== "betting") throw new Error("Apostas fechadas.");
            const horseId = Number(data.horseId);
            if (!Number.isInteger(horseId) || !race.horses.some((h) => h.id === horseId)) throw new Error("Cavalo inválido.");
            const wallet = pool.getWalletSync(socket.userId, "coop");
            const prior = race.bets.get(socket.userId)?.amount || 0;
            const amount = wager(data.allWin === true ? wallet.balance + prior : data.amount, data.allWin === true ? 1 : 10, data.allWin === true ? Number.MAX_SAFE_INTEGER : 1000000);
            if (wallet.balance + prior < amount) throw new Error("Saldo COOP insuficiente.");
            if (prior) pool.adjustBalanceSync(wallet.id, prior, "room_refund", "race", race.code);
            pool.adjustBalanceSync(wallet.id, -amount, "room_stake", "race", race.code);
            race.pot += amount - prior;
            race.bets.set(socket.userId, { horseId, amount, allWin: amount === wallet.balance + prior, username: socket.username });
            return { race: raceState(race) };
        });
        on("race:withdraw", () => {
            const race = current();
            if (race.phase !== "betting") throw new Error("Apostas fechadas.");
            const bet = race.bets.get(socket.userId);
            if (!bet) throw new Error("Você não apostou.");
            const wallet = pool.getWalletSync(socket.userId, "coop");
            pool.adjustBalanceSync(wallet.id, bet.amount, "room_refund", "race", race.code);
            race.pot -= bet.amount; race.bets.delete(socket.userId);
            return { race: raceState(race) };
        });
        on("race:start", () => {
            const race = current();
            if (race.hostId !== socket.userId || race.phase !== "betting") throw new Error("Só o host inicia uma nova corrida.");
            if (!race.bets.size) throw new Error("Faça uma aposta antes de iniciar.");
            let draw = random() * race.horses.reduce((s, h) => s + h.weight, 0);
            race.winnerId = race.horses.at(-1).id;
            for (const h of race.horses) { draw -= h.weight; if (draw < 0) { race.winnerId = h.id; break; } }
            race.phase = "racing"; race.startedAt = Date.now();
            store.save("race", race);
            schedule(race);
            return {};
        });
        socket.on("disconnect", () => {
            const race = races.get(socket.data.raceCode);
            if (!race) return;
            race.members.get(socket.userId)?.socketIds.delete(socket.id);
            if (race.hostId === socket.userId && !race.members.get(socket.userId)?.socketIds.size) {
                race.hostId = [...race.members].find(([, m]) => m.socketIds.size)?.[0] || race.hostId;
            }
            store.save("race", race); publish(race);
        });
    });
    return { races, timers };
}
module.exports = { setupRacing, HORSE_NAMES, races };
