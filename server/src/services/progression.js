// ========================================
// ARCADIA - PROGRESSION (v0.9) — XP, level 1→999
// ========================================

const pool = require("../config/database");

// Existing levels remain intact; future levels use the more demanding curve.
function xpForNextLevel(level) {
    return Math.floor(300 * Math.pow(level, 1.65));
}

function xpForRound(wager) {
    if (!Number.isSafeInteger(wager) || wager < 0) throw new Error("Aposta invalida para XP.");
    return 10 + Math.min(40, Math.floor(Math.sqrt(wager) / 10));
}

// Concede XP e processa level-ups (vários de uma vez se preciso)
function calculateXP(user, amount) {
    let { xp, level } = user;
    xp += Math.max(0, Math.floor(Number(amount) || 0));
    let leveledUp = false;
    while (level < 999 && xp >= xpForNextLevel(level)) {
        xp -= xpForNextLevel(level);
        level++;
        leveledUp = true;
    }
    if (level >= 999) { level = 999; xp = 0; }
    return { level, xp, xpNext: xpForNextLevel(level), leveledUp };
}
function grantXP(userId, amount, checkAchievements = true) {
    return pool.transactionSync(() => {
        const user = pool.db.get("SELECT id, xp, level FROM users WHERE id = ?", [userId]);
        if (!user) throw new Error("Usuário não encontrado.");

        let { xp, level, leveledUp } = calculateXP(user, amount);

        pool.db.run("UPDATE users SET xp = ?, level = ? WHERE id = ?", [xp, level, user.id]);
        if (checkAchievements) {
            require("./achievements").checkProfileAchievements(userId);
            const updated = pool.db.get("SELECT xp, level FROM users WHERE id = ?", [userId]);
            leveledUp ||= updated.level > level;
            ({ xp, level } = updated);
        }
        return { level, xp, xpNext: xpForNextLevel(level), leveledUp };
    });
}

module.exports = { grantXP, xpForNextLevel, xpForRound, calculateXP };
