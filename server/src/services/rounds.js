const pool = require("../config/database");
const { applyGameProgressions } = require("./achievements");
const { gameMissionStatements, roomMissionStatements } = require("./progression.routes");
const { xpForRound } = require("./progression");

function wager(value, min = 10, max = 1000000) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
        throw new Error(`Aposta deve ser inteira, entre ${min} e ${max} AC.`);
    }
    return amount;
}
function resolveWager(userId, body, kind = "solo") {
    return body.allWin === true
        ? wager(pool.getWalletSync(userId, kind).balance, 1, Number.MAX_SAFE_INTEGER)
        : wager(body.wager ?? body.amount);
}
function getSession(userId, game) {
    const row = pool.db.get("SELECT state FROM game_sessions WHERE user_id = ? AND game = ?", [userId, game]);
    return row ? JSON.parse(row.state) : null;
}
function saveSession(userId, game, state) {
    pool.db.run("INSERT INTO game_sessions (user_id, game, state) VALUES (?, ?, ?) ON CONFLICT(user_id, game) DO UPDATE SET state = excluded.state", [userId, game, JSON.stringify(state)]);
}
function startRound(userId, game, amount, state) {
    return pool.transactionSync(() => {
        if (getSession(userId, game)) throw new Error("Você já tem uma partida em andamento.");
        const wallet = pool.getWalletSync(userId, "solo");
        const balance = pool.adjustBalanceSync(wallet.id, -amount, "bet", "game", game);
        saveSession(userId, game, { ...state, allWin: amount === wallet.balance, wager: amount, walletId: wallet.id, startedAt: Date.now() });
        return balance;
    });
}
function recordBet(userId, game, amount, payout, outcome, detail = {}) {
    return recordBets([{ userId, game, amount, payout, outcome, detail }])[0];
}
function recordBets(entries, trackRooms = false) {
    if (new Set(entries.map((entry) => entry.userId)).size !== entries.length) throw new Error("Jogador duplicado na liquidacao.");
    return pool.transactionSync(() => {
        const now = new Date();
        const rounds = entries.map(({ userId, game, amount, payout, outcome, detail = {} }) => ({
            userId, round: { game, wager: amount, payout, outcome, detail, multiplier: amount ? Number((payout / amount).toFixed(4)) : 0 },
            cancelled: game === "mines" && outcome === "push" && detail.picks === 0,
        }));
        pool.batchSync(rounds.flatMap(({ userId, round, cancelled }) => [
            { sql: "INSERT INTO bets (user_id, game, wager, multiplier, payout, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [userId, round.game, round.wager, round.multiplier, round.payout, round.outcome, JSON.stringify(round.detail)] },
            ...(cancelled ? [] : gameMissionStatements(userId, round, now)),
            ...(trackRooms && round.detail.roomCode && !cancelled ? roomMissionStatements(userId, round.detail.roomCode, now) : []),
        ]));
        const results = applyGameProgressions(rounds.filter((entry) => !entry.cancelled).map((entry) => ({ ...entry, baseXP: xpForRound(entry.round.wager) })));
        let index = 0;
        return rounds.map((entry) => entry.cancelled ? { levelInfo: null, unlocked: [], cancelled: true } : results[index++]);
    });
}
function settleRound(userId, game, payout, outcome, detail) {
    return pool.transactionSync(() => {
        const state = getSession(userId, game);
        if (!state) throw new Error("Nenhuma partida em andamento.");
        pool.adjustBalanceSync(state.walletId, payout, "payout", "game", game);
        const progression = recordBet(userId, game, state.wager, payout, outcome, { ...detail, allWin: state.allWin === true });
        pool.db.run("DELETE FROM game_sessions WHERE user_id = ? AND game = ?", [userId, game]);
        return { balance: pool.db.get("SELECT balance FROM wallets WHERE id = ?", [state.walletId]).balance, ...progression };
    });
}
function settleInstant(userId, game, amount, payout, outcome, detail, walletKind = "solo") {
    return pool.transactionSync(() => {
        const [wallet] = pool.adjustWalletsSync([{ userId, walletKind, movements: [
            { delta: -amount, kind: "bet", refType: "game", refId: game },
            { delta: payout, kind: "payout", refType: "game", refId: game },
        ] }]);
        const progression = recordBet(userId, game, amount, payout, outcome, { ...detail, allWin: amount === wallet.previousBalance });
        return { balance: pool.db.get("SELECT balance FROM wallets WHERE id = ?", [wallet.id]).balance, ...progression };
    });
}
function handler(fn) {
    return (req, res, next) => {
        try {
            res.json({ status: "success", ...pool.transactionSync(() => fn(req)) });
        } catch (error) {
            if (/partida|Aposta|Saldo|Célula|mina|carta|Dobrar|Carteira|Número|aposta|Nenhum|Trunfo|possui|jogo|Escolha|Tipo|limite|Cashout/i.test(error.message)) {
                return res.status(400).json({ status: "error", message: error.message });
            }
            next(error);
        }
    };
}
module.exports = { wager, resolveWager, getSession, saveSession, startRound, settleRound, settleInstant, recordBet, recordBets, handler };
