const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const { random, randomInt, shuffle } = require("../services/random");
const rounds = require("../services/rounds");
const router = express.Router();

const comb = (n, k) => {
    let value = 1;
    for (let i = 0; i < k; i++) value = value * (n - i) / (i + 1);
    return value;
};
const minesMultiplier = (mines, picks) => comb(25, picks) / comb(25 - mines, picks);
function integer(value, min, max, message) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(message);
    return n;
}
const GAMES = {
    dice: {
        minBet: 10,
        play(wager, choice) {
            const picked = integer(choice && typeof choice === "object" ? choice.number : choice, 1, 6, "Escolha um número de 1 a 6.");
            const roll = randomInt(1, 7);
            const win = roll === picked;
            return { outcome: win ? "win" : "loss", multiplier: win ? 6 : 0, payout: win ? wager * 6 : 0, detail: { roll, picked } };
        },
    },
    coinflip: {
        minBet: 10,
        play(wager, choice) {
            const picked = typeof choice === "object" && choice ? choice.side : choice;
            if (!["heads", "tails"].includes(picked)) throw new Error("Escolha cara ou coroa.");
            const flip = randomInt(2) ? "heads" : "tails";
            const win = picked === flip;
            return { outcome: win ? "win" : "loss", multiplier: win ? 2 : 0, payout: win ? wager * 2 : 0, detail: { flip, picked } };
        },
    },
    mines: {
        minBet: 10,
        play(wager, choice = {}) {
            choice ||= {};
            const mines = integer(choice.mines ?? 3, 1, 24, "Número de minas inválido.");
            const picks = integer(choice.picks ?? 3, 1, 25 - mines, "Número de escolhas inválido.");
            const minePositions = shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, mines);
            // Picks must be independent of the shuffle that places the mines.
            const opened = shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, picks);
            const win = !opened.some((cell) => minePositions.includes(cell));
            const multiplier = win ? minesMultiplier(mines, picks) : 0;
            return { outcome: win ? "win" : "loss", multiplier, payout: Math.floor(wager * multiplier), detail: { mines, picks, minePositions, opened } };
        },
    },
};

router.post("/:game/play", authenticate, rounds.handler((req) => {
    const game = Object.hasOwn(GAMES, req.params.game) && GAMES[req.params.game];
    if (!game) throw new Error("Jogo não encontrado.");
    const wager = rounds.resolveWager(req.user.id, req.body);
    const result = game.play(wager, req.body.choice);
    return { ...result, ...rounds.settleInstant(req.user.id, req.params.game, wager, result.payout, result.outcome, result.detail) };
}));

function minesState(userId) {
    const state = rounds.getSession(userId, "mines");
    if (!state) return { active: false };
    const multiplier = minesMultiplier(state.mines.length, state.picked.length);
    const nextMultiplier = state.picked.length < 25 - state.mines.length ? minesMultiplier(state.mines.length, state.picked.length + 1) : null;
    return { active: true, wager: state.wager, minesCount: state.mines.length, picked: state.picked, picks: state.picked.length, multiplier, nextMultiplier, potentialPayout: Math.floor(state.wager * multiplier), balance: pool.db.get("SELECT balance FROM wallets WHERE id = ?", [state.walletId]).balance };
}
router.get("/mines/state", authenticate, rounds.handler((req) => minesState(req.user.id)));
router.post("/mines/start", authenticate, rounds.handler((req) => {
    const wager = rounds.resolveWager(req.user.id, req.body);
    const count = integer(req.body.mines ?? 3, 1, 24, "Número de minas inválido.");
    const mines = shuffle(Array.from({ length: 25 }, (_, i) => i)).slice(0, count);
    const balance = rounds.startRound(req.user.id, "mines", wager, { mines, picked: [] });
    return { ...minesState(req.user.id), balance };
}));
router.post("/mines/pick", authenticate, rounds.handler((req) => {
    const state = rounds.getSession(req.user.id, "mines");
    if (!state) throw new Error("Nenhuma partida em andamento.");
    const cell = integer(req.body.cell, 0, 24, "Célula inválida.");
    if (state.picked.includes(cell)) throw new Error("Célula já aberta.");
    if (state.mines.includes(cell)) {
        return { boom: true, cell, mines: state.mines, ...rounds.settleRound(req.user.id, "mines", 0, "loss", { boom: cell, picks: state.picked.length }) };
    }
    state.picked.push(cell);
    rounds.saveSession(req.user.id, "mines", state);
    return { boom: false, cell, ...minesState(req.user.id) };
}));
router.post("/mines/cashout", authenticate, rounds.handler((req) => {
    const state = rounds.getSession(req.user.id, "mines");
    if (!state) throw new Error("Nenhuma partida em andamento.");
    // A zero-pick cashout cancels the round without trapping the wager.
    const multiplier = minesMultiplier(state.mines.length, state.picked.length);
    const payout = Math.floor(state.wager * multiplier);
    return { multiplier, payout, mines: state.mines, ...rounds.settleRound(req.user.id, "mines", payout, state.picked.length ? "win" : "push", { picks: state.picked.length }) };
}));

const crashMultiplier = (startedAt) => Math.pow(1.06, Math.max(0, Date.now() - startedAt) / 1000 * 6);
function crashState(userId, cashout = false) {
    const state = rounds.getSession(userId, "crash");
    if (!state) {
        if (cashout) throw new Error("Nenhuma partida em andamento.");
        return { active: false };
    }
    const current = crashMultiplier(state.startedAt);
    if (current >= state.crashPoint) {
        return { active: false, crashed: true, crashPoint: state.crashPoint, wager: state.wager, ...rounds.settleRound(userId, "crash", 0, "loss", { crashPoint: state.crashPoint }) };
    }
    // Round down so a payout never exceeds the server's current multiplier.
    const multiplier = Math.floor(current * 100) / 100;
    const payout = Math.floor(state.wager * multiplier);
    if (cashout) {
        return { active: false, crashed: false, multiplier, payout, ...rounds.settleRound(userId, "crash", payout, payout > state.wager ? "win" : "push", { cashout: multiplier }) };
    }
    return { active: true, wager: state.wager, multiplier, potentialPayout: payout };
}
router.post("/crash/start", authenticate, rounds.handler((req) => {
    if (rounds.getSession(req.user.id, "crash")) crashState(req.user.id);
    const wager = rounds.resolveWager(req.user.id, req.body);
    const crashPoint = Math.max(1, Math.floor(1 / (1 - random()) * 100) / 100);
    const balance = rounds.startRound(req.user.id, "crash", wager, { crashPoint });
    return { wager, balance };
}));
router.get("/crash/state", authenticate, rounds.handler((req) => crashState(req.user.id)));
router.post("/crash/cashout", authenticate, rounds.handler((req) => crashState(req.user.id, true)));

// ========================================
// LEADERBOARD — top jogadores por lucro
// ========================================

router.get("/leaderboard", async (req, res) => {
    try {
        const rows = await pool.query(
            `SELECT u.username, u.avatar, u.display_name AS displayName,
                    COALESCE(SUM(b.payout - b.wager), 0) AS net_profit,
                    COUNT(b.id) AS games,
                    SUM(CASE WHEN b.outcome = 'win' THEN 1 ELSE 0 END) AS wins
             FROM users u
             LEFT JOIN bets b ON b.user_id = u.id
             GROUP BY u.id
             ORDER BY net_profit DESC
             LIMIT 20`
        );

        return res.json({ status: "success", leaderboard: rows.rows });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Erro no ranking." });
    }
});

// ========================================
// GET /api/games/history — últimas apostas
// ========================================

router.get("/history", authenticate, async (req, res) => {
    try {
        const rows = await pool.query(
            `SELECT game, wager, multiplier, payout, outcome, detail, created_at
             FROM bets WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
            [req.user.id]
        );

        return res.status(200).json({ status: "success", history: rows.rows });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Erro ao buscar histórico." });
    }
});

// ========================================
// GET /api/games/stats — estatísticas do usuário
// ========================================

router.get("/stats", authenticate, async (req, res) => {
    try {
        const totals = await pool.get(
            `SELECT COUNT(*) AS total_games,
                    SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS total_wins,
                    SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS total_losses,
                    COALESCE(SUM(payout - wager), 0) AS net
             FROM bets WHERE user_id = ?`,
            [req.user.id]
        );

        return res.status(200).json({ status: "success", stats: totals });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Erro ao buscar estatísticas." });
    }
});


// ========================================
// GET /api/games/stats/full — estatísticas completas (v0.9.3)
// ========================================

router.get("/stats/full", authenticate, async (req, res) => {
    try {
        const uid = req.user.id;

        // ---- básicas ----
        const totals = await pool.get(
            `SELECT COUNT(*) AS total_games,
                    SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
                    SUM(CASE WHEN outcome = 'push' THEN 1 ELSE 0 END) AS pushes,
                    COALESCE(SUM(payout - wager), 0) AS net,
                    COALESCE(SUM(wager), 0) AS total_wagered,
                    COALESCE(SUM(payout), 0) AS total_payout
             FROM bets WHERE user_id = ?`,
            [uid]
        );

        // ---- por jogo ----
        const byGame = await pool.query(
            `SELECT game,
                    COUNT(*) AS games,
                    SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
                    COALESCE(SUM(payout - wager), 0) AS net
             FROM bets WHERE user_id = ?
             GROUP BY game`,
            [uid]
        );

        // melhor jogo (maior lucro, min 1 partida)
        const gameRows = byGame.rows || [];
        const bestGame = gameRows.length
            ? gameRows.reduce((a, b) => (Number(b.net) > Number(a.net) ? b : a))
            : null;
        const mostPlayed = gameRows.length
            ? gameRows.reduce((a, b) => (Number(b.games) > Number(a.games) ? b : a))
            : null;
        const leastPlayed = gameRows.length
            ? gameRows.reduce((a, b) => (Number(b.games) < Number(a.games) ? b : a))
            : null;

        // ---- maior lucro/déficit numa única rodada ----
        const bestRound = await pool.get(
            `SELECT game, wager, payout, (payout - wager) AS profit, created_at
             FROM bets WHERE user_id = ? ORDER BY (payout - wager) DESC LIMIT 1`,
            [uid]
        );
        const worstRound = await pool.get(
            `SELECT game, wager, payout, (payout - wager) AS profit, created_at
             FROM bets WHERE user_id = ?
             ORDER BY (payout - wager) ASC LIMIT 1`,
            [uid]
        );

        // ---- carteiras ----
        const wallets = await pool.query(`SELECT kind, balance FROM wallets WHERE user_id = ?`, [uid]);
        const walletMap = Object.fromEntries((wallets.rows || []).map((w) => [w.kind, w.balance]));

        // ---- conquistas ----
        const achCount = require("../services/achievements").achievementCount(uid);

        // ---- duelo ----
        const duel = await pool.get(`SELECT wins, losses FROM duel_stats WHERE user_id = ?`, [uid]);

        // ---- multiplayer: apostas em salas (ref_type room) e corridas ----
        const roomTx = await pool.get(
            `SELECT COALESCE(SUM(CASE WHEN t.kind = 'room_payout' THEN t.amount ELSE 0 END), 0) AS payouts,
                    COALESCE(SUM(CASE WHEN t.kind = 'room_stake' THEN -t.amount ELSE 0 END), 0) AS stakes
             FROM transactions t
             INNER JOIN wallets w ON w.id = t.wallet_id
             WHERE w.user_id = ? AND t.ref_type IN ('room','race')`,
            [uid]
        );

        // vitórias no multiplayer = rodadas ganhas em salas (game roulette) + corridas pagas
        const mpWins = await pool.get(
            `SELECT COUNT(*) AS wins FROM bets WHERE user_id = ? AND game = 'roulette' AND outcome = 'win'`,
            [uid]
        );

        const user = await pool.get(`SELECT level, xp, display_name, avatar, created_at FROM users WHERE id = ?`, [uid]);

        return res.json({
            status: "success",
            stats: {
                level: user ? user.level : 1,
                xp: user ? user.xp : 0,
                displayName: user ? (user.display_name || req.user.username) : req.user.username,
                avatar: user ? user.avatar || "🎰" : "🎰",
                memberSince: user ? user.created_at : null,

                totalGames: totals.total_games || 0,
                wins: totals.wins || 0,
                losses: totals.losses || 0,
                pushes: totals.pushes || 0,
                net: Number(totals.net) || 0,
                totalWagered: Number(totals.total_wagered) || 0,
                totalPayout: Number(totals.total_payout) || 0,

                bestGame: bestGame ? { game: bestGame.game, net: Number(bestGame.net), games: bestGame.games } : null,
                mostPlayed: mostPlayed ? { game: mostPlayed.game, games: mostPlayed.games, net: Number(mostPlayed.net) } : null,
                leastPlayed: leastPlayed ? { game: leastPlayed.game, games: leastPlayed.games } : null,
                byGame: gameRows.map((g) => ({ game: g.game, games: g.games, wins: g.wins || 0, net: Number(g.net) })),

                bestRound: bestRound ? { game: bestRound.game, profit: Number(bestRound.profit), wager: bestRound.wager, at: bestRound.created_at } : null,
                worstRound: worstRound ? { game: worstRound.game, profit: Number(worstRound.profit), wager: worstRound.wager, at: worstRound.created_at } : null,

                wallets: {
                    solo: walletMap.solo || 0,
                    coop: walletMap.coop || 0,
                    duel: walletMap.duel || 0,
                },

                achievementsUnlocked: achCount ? achCount.total : 0,

                duel: {
                    wins: duel ? duel.wins : 0,
                    losses: duel ? duel.losses : 0,
                },

                multiplayer: {
                    rouletteWins: mpWins ? mpWins.wins : 0,
                    roomStakes: Number(roomTx.stakes) || 0,
                    roomPayouts: Number(roomTx.payouts) || 0,
                },
            },
        });
    } catch (error) {
        console.error("Stats full:", error.message);
        return res.status(500).json({ status: "error", message: "Erro ao carregar estatísticas." });
    }
});

// ========================================
// GET /api/users/:username/profile — perfil PÚBLICO (v0.9.3)
// ========================================

router.get("/public/:username", async (req, res) => {
    try {
        const user = await pool.get(
            `SELECT id, username, display_name, avatar, level, xp, created_at FROM users WHERE LOWER(username) = LOWER(?)`,
            [String(req.params.username).trim()]
        );
        if (!user) {
            return res.status(404).json({ status: "error", message: "Jogador não encontrado." });
        }

        const totals = await pool.get(
            `SELECT COUNT(*) AS total_games,
                    SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
                    COALESCE(SUM(payout - wager), 0) AS net
             FROM bets WHERE user_id = ?`,
            [user.id]
        );

        const byGame = await pool.query(
            `SELECT game, COUNT(*) AS games, COALESCE(SUM(payout - wager), 0) AS net
             FROM bets WHERE user_id = ? GROUP BY game`,
            [user.id]
        );

        const achCount = require("../services/achievements").achievementCount(user.id);
        const duel = await pool.get(`SELECT wins, losses FROM duel_stats WHERE user_id = ?`, [user.id]);

        return res.json({
            status: "success",
            profile: {
                username: user.username,
                displayName: user.display_name || user.username,
                avatar: user.avatar || "🎰",
                level: user.level || 1,
                xp: user.xp || 0,
                memberSince: user.created_at,
                totalGames: totals.total_games || 0,
                wins: totals.wins || 0,
                net: Number(totals.net) || 0,
                achievements: achCount ? achCount.total : 0,
                duelWins: duel ? duel.wins : 0,
                duelLosses: duel ? duel.losses : 0,
                byGame: (byGame.rows || []).map((g) => ({ game: g.game, games: g.games, net: Number(g.net) })),
            },
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Erro ao carregar perfil." });
    }
});


const PLINKO_TABLES = {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
};
router.post("/plinko/drop", authenticate, rounds.handler((req) => {
    const wager = rounds.resolveWager(req.user.id, req.body);
    const risk = req.body.risk ?? "medium";
    if (!PLINKO_TABLES[risk]) throw new Error("Escolha um risco válido.");
    const path = Array.from({ length: 16 }, () => randomInt(2));
    const slot = path.reduce((a, b) => a + b, 0);
    const multiplier = PLINKO_TABLES[risk][slot];
    const payout = Math.floor(wager * multiplier);
    const outcome = payout > wager ? "win" : payout === wager ? "push" : "loss";
    return { risk, path, slot, multiplier, payout, outcome, ...rounds.settleInstant(req.user.id, "plinko", wager, payout, outcome, { risk, slot, path }) };
}));
module.exports = { router, GAMES, minesMultiplier, crashMultiplier };
