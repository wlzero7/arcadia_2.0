const pool = require("../config/database");
const { grantXP } = require("./progression");
const { checkGameAchievements, trackGameActivity } = require("./progression.routes");

function wager(value, min = 10, max = 1000000) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < min || amount > max) {
        throw new Error(`Aposta deve ser inteira, entre ${min} e ${max} AC.`);
    }
    return amount;
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
        saveSession(userId, game, { ...state, wager: amount, walletId: wallet.id, startedAt: Date.now() });
        return balance;
    });
}
function recordBet(userId, game, amount, payout, outcome, detail = {}) {
    const multiplier = Number((payout / amount).toFixed(4));
    pool.db.run("INSERT INTO bets (user_id, game, wager, multiplier, payout, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)", [userId, game, amount, multiplier, payout, outcome, JSON.stringify(detail)]);
    if (game === "mines" && outcome === "push" && detail.picks === 0) return { levelInfo: null, unlocked: [], cancelled: true };
    const levelInfo = grantXP(userId, 10 + Math.floor(amount / 100));
    const unlocked = checkGameAchievements(userId, { game, wager: amount, outcome, multiplier, detail });
    trackGameActivity(userId, { game, wager: amount, outcome, detail });
    return { levelInfo, unlocked };
}
function settleRound(userId, game, payout, outcome, detail) {
    return pool.transactionSync(() => {
        const state = getSession(userId, game);
        if (!state) throw new Error("Nenhuma partida em andamento.");
        const balance = pool.adjustBalanceSync(state.walletId, payout, "payout", "game", game);
        const progression = recordBet(userId, game, state.wager, payout, outcome, detail);
        pool.db.run("DELETE FROM game_sessions WHERE user_id = ? AND game = ?", [userId, game]);
        return { balance, ...progression };
    });
}
function settleInstant(userId, game, amount, payout, outcome, detail, walletKind = "solo") {
    return pool.transactionSync(() => {
        const wallet = pool.getWalletSync(userId, walletKind);
        pool.adjustBalanceSync(wallet.id, -amount, "bet", "game", game);
        const balance = pool.adjustBalanceSync(wallet.id, payout, "payout", "game", game);
        return { balance, ...recordBet(userId, game, amount, payout, outcome, detail) };
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
module.exports = { wager, getSession, saveSession, startRound, settleRound, settleInstant, recordBet, handler };
