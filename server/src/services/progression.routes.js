// ========================================
// ARCADIA - ACHIEVEMENTS + MISSIONS (v0.9)
// Mission periods use UTC consistently across routes and game events.
// ========================================

const pool = require("../config/database");
const { grantXP } = require("./progression");
const { ACHIEVEMENTS, unlockAchievement, checkGameAchievements, checkProfileAchievements } = require("./achievements");

// ========================================
// CONQUISTAS — catálogo por chave (nome/editável depois)
// ========================================


// ========================================
// MISSÕES — diárias e semanais (chaves genéricas)
// ========================================

const MISSIONS = {
    // diárias
    daily_login: { period: "daily", category: "login", target: 1, xp: 50, desc: "Entre no Arcadia hoje" },
    daily_play_10: { period: "daily", category: "play", target: 10, xp: 150, desc: "Jogue 10 rodadas" },
    daily_win_3: { period: "daily", category: "win", target: 3, xp: 200, desc: "Vença 3 rodadas" },
    daily_bet_500: { period: "daily", category: "wager", target: 500, xp: 150, desc: "Aposte 500 AC no total", unit: "AC" },
    daily_mines_1: { period: "daily", category: "game", game: "mines", target: 1, xp: 100, desc: "Complete 1 partida de Mines" },
    daily_coinflip_5: { period: "daily", category: "game", game: "coinflip", target: 5, xp: 120, desc: "Jogue 5 rodadas de Coin Flip" },
    daily_coinflip_win_2: { period: "daily", category: "win", game: "coinflip", target: 2, xp: 150, desc: "Vença 2 rodadas de Coin Flip" },
    daily_dice_5: { period: "daily", category: "game", game: "dice", target: 5, xp: 120, desc: "Jogue 5 rodadas de Dice" },
    daily_blackjack_3: { period: "daily", category: "game", game: "blackjack", target: 3, xp: 150, desc: "Complete 3 partidas de Blackjack" },
    daily_roulette_3: { period: "daily", category: "game", game: "roulette", target: 3, xp: 120, desc: "Complete 3 giros de Roleta" },
    daily_slots_3: { period: "daily", category: "game", game: "slots", target: 3, xp: 120, desc: "Complete 3 giros de Slots" },
    daily_crash_3: { period: "daily", category: "game", game: "crash", target: 3, xp: 150, desc: "Complete 3 partidas de Crash" },
    daily_plinko_3: { period: "daily", category: "game", game: "plinko", target: 3, xp: 120, desc: "Jogue 3 rodadas de Plinko" },
    daily_bet_100_twice: { period: "daily", category: "wager", target: 2, xp: 100, desc: "Faça 2 apostas de exatamente 100 AC" },
    daily_high_bet: { period: "daily", category: "wager", target: 1, xp: 150, desc: "Complete uma aposta de 1.000 AC ou mais" },
    daily_variety_3: { period: "daily", category: "game", target: 3, xp: 200, desc: "Jogue 3 jogos diferentes" },
    daily_coop_3: { period: "daily", category: "social", mode: "coop", target: 3, xp: 180, desc: "Jogue 3 rodadas em salas Coop" },
    daily_duel_3: { period: "daily", category: "social", mode: "duel", target: 3, xp: 180, desc: "Jogue 3 rodadas em duelos" },
    daily_duel_win: { period: "daily", category: "win", mode: "duel", target: 1, xp: 250, desc: "Vença um duelo" },
    daily_blackjack_mp_3: { period: "daily", category: "game", game: "blackjack-mp", target: 3, xp: 180, desc: "Complete 3 rodadas de Blackjack MP com 2 ou mais jogadores" },
    daily_blackjack_mp_win: { period: "daily", category: "win", game: "blackjack-mp", target: 1, xp: 150, desc: "Vença uma rodada de Blackjack MP com 2 ou mais jogadores" },
    // semanais
    weekly_login_4: { period: "weekly", category: "login", target: 4, xp: 400, desc: "Entre em 4 dias diferentes" },
    weekly_play_100: { period: "weekly", category: "play", target: 100, xp: 800, desc: "Jogue 100 rodadas" },
    weekly_win_30: { period: "weekly", category: "win", target: 30, xp: 1000, desc: "Vença 30 rodadas" },
    weekly_rooms_5: { period: "weekly", category: "social", mode: "coop", target: 5, xp: 600, desc: "Jogue em 5 salas diferentes" },
    weekly_duel_1: { period: "weekly", category: "social", mode: "duel", target: 1, xp: 700, desc: "Complete 1 duelo x1" },
    weekly_coinflip_30: { period: "weekly", category: "game", game: "coinflip", target: 30, xp: 500, desc: "Jogue 30 rodadas de Coin Flip" },
    weekly_bet_5000: { period: "weekly", category: "wager", target: 5000, xp: 500, desc: "Aposte 5.000 AC no total", unit: "AC" },
};

// ========================================
// CONQUISTAS
// ========================================


// ========================================
// MISSÕES
// ========================================

function weekKey(now = new Date()) {
    const start = Date.UTC(now.getUTCFullYear(), 0, 1);
    const week = Math.ceil((Math.floor((now - start) / 86400000) + new Date(start).getUTCDay() + 1) / 7);
    return `${now.getUTCFullYear()}-W${week}`;
}

function todayKey(now = new Date()) {
    return now.toISOString().slice(0, 10);
}

function resets(now = new Date()) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const daily = midnight + 86400000;
    const weekly = Math.min(midnight + (7 - now.getUTCDay()) * 86400000, Date.UTC(now.getUTCFullYear() + 1, 0, 1));
    return { daily: new Date(daily).toISOString(), weekly: new Date(weekly).toISOString() };
}

// Incrementa progresso de missões; marca completas
function progressMission(userId, key, amount = 1, now = new Date()) {
    const m = Object.hasOwn(MISSIONS, key) && MISSIONS[key];
    if (!m || !Number.isSafeInteger(amount) || amount <= 0) return;
    const period = m.period === "weekly" ? weekKey(now) : todayKey(now);

    pool.db.run(
        `INSERT INTO user_missions (user_id, mission_key, period, progress, completed)
         VALUES (?, ?, ?, 0, 0)
         ON CONFLICT(user_id, mission_key, period) DO NOTHING`,
        [userId, key, period]
    );

    const row = pool.db.get(
        "SELECT progress, completed FROM user_missions WHERE user_id = ? AND mission_key = ? AND period = ?",
        [userId, key, period]
    );
    if (!row || row.completed) return;

    const progress = row.progress + amount;
    const completed = progress >= m.target ? 1 : 0;

    pool.db.run(
        "UPDATE user_missions SET progress = ?, completed = ? WHERE user_id = ? AND mission_key = ? AND period = ?",
        [Math.min(progress, m.target), completed, userId, key, period]
    );
    if (completed) checkProfileAchievements(userId);
}

// Hooks de jogo
function trackGameActivity(userId, { game, outcome, wager, detail = {} }, now = new Date()) {
    const add = (key, amount = 1) => progressMission(userId, key, amount, now);
    const mode = game === "duel" ? "duel" : detail.roomCode || detail.tableCode ? "coop" : "solo";
    const playedGame = game === "duel" ? detail.game : game;
    add("daily_play_10");
    add("weekly_play_100");
    if (outcome === "win") {
        add("daily_win_3");
        add("weekly_win_30");
    }
    add("daily_bet_500", wager || 0);
    add("weekly_bet_5000", wager || 0);
    const gameMissions = { mines: "daily_mines_1", coinflip: "daily_coinflip_5", dice: "daily_dice_5", blackjack: "daily_blackjack_3", "blackjack-mp": "daily_blackjack_mp_3", roulette: "daily_roulette_3", slots: "daily_slots_3", crash: "daily_crash_3", plinko: "daily_plinko_3" };
    if (Object.hasOwn(gameMissions, playedGame)) {
        add(gameMissions[playedGame]);
        const inserted = pool.db.run("INSERT OR IGNORE INTO mission_games (user_id, day, game) VALUES (?, ?, ?)", [userId, todayKey(now), playedGame]);
        if (inserted.changes) add("daily_variety_3");
    }
    if (playedGame === "coinflip") {
        add("weekly_coinflip_30");
        if (outcome === "win") add("daily_coinflip_win_2");
    }
    if (playedGame === "blackjack-mp" && outcome === "win") add("daily_blackjack_mp_win");
    if (wager === 100) add("daily_bet_100_twice");
    if (wager >= 1000) add("daily_high_bet");
    if (mode === "coop") add("daily_coop_3");
    if (mode === "duel") add("daily_duel_3");
}

function trackLoginActivity(userId, now = new Date()) {
    return pool.transactionSync(() => {
        const result = pool.db.run("INSERT OR IGNORE INTO mission_logins (user_id, day) VALUES (?, ?)", [userId, todayKey(now)]);
        if (result.changes) {
            progressMission(userId, "daily_login", 1, now);
            progressMission(userId, "weekly_login_4", 1, now);
        }
    });
}

function trackRoomActivity(userId, roomCode, now = new Date()) {
    const result = pool.db.run("INSERT OR IGNORE INTO mission_rooms (user_id, period, room_code) VALUES (?, ?, ?)", [userId, weekKey(now), roomCode]);
    if (result.changes) progressMission(userId, "weekly_rooms_5", 1, now);
}

function trackDuelActivity(userId, won = false) {
    progressMission(userId, "weekly_duel_1");
    if (won) progressMission(userId, "daily_duel_win");
    checkProfileAchievements(userId);
}

// ========================================
// ROTAS
// ========================================

const express = require("express");
const { authenticate } = require("../middleware/auth");
const router = express.Router();

// GET /api/progression/achievements
router.get("/achievements", authenticate, (req, res) => {
    checkProfileAchievements(req.user.id);
    const unlocked = pool.db.all(
        "SELECT achievement_key, unlocked_at FROM user_achievements WHERE user_id = ?",
        [req.user.id]
    );
    const map = Object.fromEntries(unlocked.map((r) => [r.achievement_key, r.unlocked_at]));
    res.json({
        status: "success",
        achievements: Object.entries(ACHIEVEMENTS).map(([key, meta]) => ({
            key,
            ...meta,
            unlocked: !!map[key],
            unlockedAt: map[key] || null,
        })),
    });
});

// GET /api/progression/missions
router.get("/missions", authenticate, (req, res) => {
    const now = new Date();
    trackLoginActivity(req.user.id, now);
    const today = todayKey(now);
    const week = weekKey(now);
    const rows = pool.db.all(
        "SELECT mission_key, period, progress, completed, claimed FROM user_missions WHERE user_id = ? AND period IN (?, ?)",
        [req.user.id, today, week]
    );
    const map = Object.fromEntries(rows.map((r) => [`${r.mission_key}|${r.period}`, r]));

    const missions = Object.entries(MISSIONS).map(([key, m]) => {
        const period = m.period === "weekly" ? week : today;
        const row = map[`${key}|${period}`] || { progress: 0, completed: 0, claimed: 0 };
        return { key, ...m, cadence: m.period, period, progress: row.progress, completed: !!row.completed, claimed: !!row.claimed };
    });
    res.json({ status: "success", missions, serverTime: now.toISOString(), resetsAt: resets(now) });
});

// POST /api/progression/missions/claim { key }
router.post("/missions/claim", authenticate, (req, res) => {
    try {
        const reward = claimMission(req.user.id, String(req.body?.missionKey || ""), new Date(), req.body?.period);
        res.json({ status: "success", message: `+${reward.xp} XP!`, ...reward });
    } catch (error) {
        if (!error.status) throw error;
        res.status(error.status).json({ status: "error", message: error.message });
    }
});

function claimMission(userId, key, now = new Date(), expectedPeriod) {
    const m = Object.hasOwn(MISSIONS, key) && MISSIONS[key];
    if (!m) throw Object.assign(new Error("Missão não existe."), { status: 404 });
    const period = m.period === "weekly" ? weekKey(now) : todayKey(now);
    if (expectedPeriod !== undefined && expectedPeriod !== period) throw Object.assign(new Error("Missão expirada. Atualize a página."), { status: 400 });
    return pool.transactionSync(() => {
        const result = pool.db.run("UPDATE user_missions SET claimed = 1 WHERE user_id = ? AND mission_key = ? AND period = ? AND completed = 1 AND claimed = 0", [userId, key, period]);
        if (!result.changes) throw Object.assign(new Error("Missão incompleta, expirada ou já resgatada."), { status: 400 });
        return { xp: m.xp, levelInfo: grantXP(userId, m.xp) };
    });
}

function isBugReviewer(userId) {
    const username = pool.db.get("SELECT username FROM users WHERE id = ?", [userId])?.username;
    return String(username).toLowerCase() === "wl07";
}
router.get("/bugs", authenticate, (req, res) => {
    const canReview = isBugReviewer(req.user.id);
    const reports = pool.db.all(`SELECT b.*, u.username FROM bug_reports b JOIN users u ON u.id = b.user_id ${canReview ? "" : "WHERE b.user_id = ?"} ORDER BY b.id DESC LIMIT 100`, canReview ? [] : [req.user.id]);
    res.json({ status: "success", canReview, reports });
});
router.post("/bugs", authenticate, (req, res) => {
    const title = String(req.body?.title || "").trim();
    const description = String(req.body?.description || "").trim();
    if (title.length < 5 || title.length > 120 || description.length < 20 || description.length > 4000) return res.status(400).json({ status: "error", message: "Título: 5 a 120 caracteres. Relato: 20 a 4.000 caracteres." });
    const pending = pool.db.get("SELECT COUNT(*) AS n FROM bug_reports WHERE user_id = ? AND status = 'pending'", [req.user.id]).n;
    if (pending >= 5) return res.status(400).json({ status: "error", message: "Você já tem cinco relatos aguardando análise." });
    const result = pool.db.run("INSERT INTO bug_reports (user_id, title, description) VALUES (?, ?, ?)", [req.user.id, title, description]);
    res.json({ status: "success", id: Number(result.lastInsertRowid), message: "Relato enviado para análise." });
});
router.post("/bugs/:id/review", authenticate, (req, res) => {
    if (!isBugReviewer(req.user.id)) return res.status(403).json({ status: "error", message: "Somente o desenvolvedor pode analisar relatos." });
    const status = req.body?.approved === true ? "approved" : req.body?.approved === false ? "rejected" : null;
    if (!status) return res.status(400).json({ status: "error", message: "Escolha aprovar ou rejeitar." });
    const result = pool.transactionSync(() => {
        const report = pool.db.get("SELECT * FROM bug_reports WHERE id = ?", [Number(req.params.id)]);
        if (!report || report.status !== "pending") return null;
        pool.db.run("UPDATE bug_reports SET status = ?, reviewed_by = ? WHERE id = ?", [status, req.user.id, report.id]);
        return { unlocked: status === "approved" ? unlockAchievement(report.user_id, "bug_reporter") : null };
    });
    if (!result) return res.status(409).json({ status: "error", message: "Relato inexistente ou já analisado." });
    res.json({ status: "success", ...result });
});
module.exports = { router, ACHIEVEMENTS, unlockAchievement, checkGameAchievements, checkProfileAchievements, trackGameActivity, trackRoomActivity, trackDuelActivity, trackLoginActivity, claimMission, weekKey, todayKey, resets };
