const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
require("./support.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-economy-"));
process.env.DB_PATH = path.join(directory, "test.db");
const pool = require("../src/config/database");
const progression = require("../src/services/progression");
const achievements = require("../src/services/achievements");
const missions = require("../src/services/progression.routes");
const rounds = require("../src/services/rounds");
const kinds = ["solo", "coop", "duel"];
let sequence = 0;
function user() {
    const name = "economy" + ++sequence;
    const id = pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,'test')", [name, name + "@example.test"]).lastInsertRowid;
    for (const kind of kinds) pool.getWalletSync(id, kind);
    return id;
}
function balances(id) { return kinds.map((kind) => pool.getWalletSync(id, kind).balance); }
function ledger(id, type) {
    return pool.db.all("SELECT w.kind AS wallet, t.amount, t.balance_after, t.ref_id FROM transactions t JOIN wallets w ON w.id = t.wallet_id WHERE w.user_id = ? AND t.ref_type = ? ORDER BY t.id", [id, type]);
}

test("levels require more XP, round XP is bounded, existing levels are preserved", () => {
    assert.equal(progression.xpForNextLevel(1), 300);
    for (const level of [1, 2, 25, 50, 75, 100, 998]) {
        assert.ok(progression.xpForNextLevel(level) > Math.floor(100 * level ** 1.5));
        assert.ok(progression.xpForNextLevel(level + 1) > progression.xpForNextLevel(level));
    }
    assert.equal(progression.xpForRound(100), 11);
    assert.equal(progression.xpForRound(1000000), 50);
    assert.equal(progression.xpForRound(Number.MAX_SAFE_INTEGER), 50);
    assert.throws(() => progression.xpForRound(NaN));
    assert.equal(progression.calculateXP({ level: 1, xp: 299 }, 1).level, 2);
    const id = user();
    pool.db.run("UPDATE users SET level = 24, xp = 123 WHERE id = ?", [id]);
    const result = progression.grantXP(id, 10);
    assert.equal(result.level, 24); assert.equal(result.xp, 133);
});

test("achievement coins reach all three wallets exactly once with exact ledger balances", () => {
    const id = user();
    const reward = achievements.unlockAchievement(id, "first_victory");
    assert.equal(reward.ac, 100000); assert.equal(reward.xp, 50);
    assert.deepEqual(balances(id), [1100000, 1100000, 1100000]);
    assert.deepEqual(ledger(id, "achievement").sort((a, b) => a.wallet.localeCompare(b.wallet)), [...kinds].sort().map((wallet) => ({ wallet, amount: 100000, balance_after: 1100000, ref_id: "first_victory" })));
    assert.equal(achievements.unlockAchievement(id, "first_victory"), null);
    achievements.checkProfileAchievements(id);
    assert.deepEqual(balances(id), [1100000, 1100000, 1100000]);
    assert.equal(ledger(id, "achievement").length, 3);
});

test("zero-XP achievements still award coins; invalid keys cannot issue rewards", () => {
    const id = user();
    achievements.unlockAchievement(id, "all_win");
    assert.equal(pool.db.get("SELECT xp FROM users WHERE id = ?", [id]).xp, 0);
    assert.deepEqual(balances(id), [1100000, 1100000, 1100000]);
    assert.equal(achievements.unlockAchievement(id, "old_generic"), null);
    assert.equal(ledger(id, "achievement").length, 3);
});

test("daily and weekly mission coins scale with XP and cannot be claimed twice", () => {
    const id = user(), now = new Date("2026-10-08T12:00:00Z");
    missions.trackLoginActivity(id, now);
    const daily = missions.claimMission(id, "daily_login", now);
    assert.equal(daily.ac, 10000); assert.equal(daily.xp, 50);
    pool.db.run("INSERT INTO user_missions (user_id,mission_key,period,progress,completed) VALUES (?,'weekly_play_100',?,100,1)", [id, missions.weekKey(now)]);
    const weekly = missions.claimMission(id, "weekly_play_100", now);
    assert.equal(weekly.ac, 80000); assert.equal(weekly.xp, 800);
    assert.deepEqual(balances(id), [1090000, 1090000, 1090000]);
    assert.equal(ledger(id, "mission").length, 6);
    for (const wallet of kinds) {
        assert.deepEqual(ledger(id, "mission").filter((r) => r.wallet === wallet).map((r) => [r.amount, r.balance_after]), [[10000, 1010000], [80000, 1090000]]);
    }
    assert.throws(() => missions.claimMission(id, "daily_login", now));
    assert.throws(() => missions.claimMission(id, "weekly_play_100", now));
    assert.deepEqual(balances(id), [1090000, 1090000, 1090000]);
});

test("ledger failure rolls back all wallet credits, XP and achievement ownership", () => {
    const id = user();
    pool.db.exec(`CREATE TEMP TRIGGER fail_reward BEFORE INSERT ON transactions WHEN NEW.ref_type = 'achievement' AND NEW.wallet_id = ${pool.getWalletSync(id, "duel").id} BEGIN SELECT RAISE(ABORT, 'reward failure'); END;`);
    try {
        assert.throws(() => achievements.unlockAchievement(id, "first_victory"), /reward failure/);
        assert.deepEqual(balances(id), [1000000, 1000000, 1000000]);
        assert.equal(pool.db.get("SELECT xp FROM users WHERE id = ?", [id]).xp, 0);
        assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = ?", [id]).n, 0);
        assert.equal(ledger(id, "achievement").length, 0);
    } finally { pool.db.exec("DROP TRIGGER fail_reward"); }
    achievements.unlockAchievement(id, "first_victory");
    assert.deepEqual(balances(id), [1100000, 1100000, 1100000]);
});

test("mission XP failure rolls back claim, coins and all three ledger entries", () => {
    const id = user(); missions.trackLoginActivity(id);
    pool.db.exec(`CREATE TEMP TRIGGER fail_reward_xp BEFORE UPDATE OF xp ON users WHEN NEW.id = ${id} BEGIN SELECT RAISE(ABORT, 'reward XP failure'); END;`);
    try {
        assert.throws(() => missions.claimMission(id, "daily_login"), /reward XP failure/);
        assert.deepEqual(balances(id), [1000000, 1000000, 1000000]);
        assert.equal(ledger(id, "mission").length, 0);
        assert.equal(pool.db.get("SELECT claimed FROM user_missions WHERE user_id = ? AND mission_key = 'daily_login'", [id]).claimed, 0);
    } finally { pool.db.exec("DROP TRIGGER fail_reward_xp"); }
});

test("reward wealth milestones converge once and game responses include awarded coins", () => {
    const id = user();
    pool.db.run("UPDATE wallets SET balance = 1950000 WHERE user_id = ?", [id]);
    achievements.unlockAchievement(id, "first_victory");
    assert.deepEqual(balances(id), [2150000, 2150000, 2150000]);
    assert.equal(ledger(id, "achievement").length, 6);
    achievements.checkProfileAchievements(id);
    assert.equal(ledger(id, "achievement").length, 6);
    const other = user();
    const result = rounds.settleInstant(other, "dice", 100, 140, "win", { picked: 6, roll: 6 });
    assert.equal(result.balance, 1300040);
    assert.deepEqual(balances(other), [1300040, 1300000, 1300000]);
    assert.equal(result.levelInfo.xp, 211);
    const again = rounds.settleInstant(other, "dice", 100, 100, "push", { picked: 6, roll: 6 });
    assert.equal(again.balance, 1300040); assert.equal(again.levelInfo.xp, 222);
    assert.equal(ledger(other, "achievement").length, 9);
});

test.after(() => { pool.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
