const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-collective-"));
process.env.DB_PATH = path.join(directory, "test.db");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-test-only";
const pool = require("../src/config/database");
const { recordBet, recordBets } = require("../src/services/rounds");
function user(name) {
    const id = pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,?)", [name, name + "@example.test", "hash"]).lastInsertRowid;
    for (const kind of ["solo", "duel", "coop"]) pool.getWalletSync(id, kind);
    return id;
}
function snapshot(id) {
    return {
        user: pool.db.get("SELECT xp,level FROM users WHERE id=?", [id]),
        wallets: pool.db.all("SELECT kind,balance FROM wallets WHERE user_id=? ORDER BY kind", [id]),
        rewards: pool.db.all("SELECT kind,amount,balance_after,ref_type,ref_id FROM transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=?) ORDER BY id", [id]),
        achievements: pool.db.all("SELECT achievement_key FROM user_achievements WHERE user_id=? ORDER BY achievement_key", [id]),
        missions: pool.db.all("SELECT mission_key,period,progress,completed,claimed FROM user_missions WHERE user_id=? ORDER BY mission_key,period", [id]),
        bets: pool.db.all("SELECT game,wager,multiplier,payout,outcome,detail FROM bets WHERE user_id=? ORDER BY id", [id]),
    };
}
test("16-player settlement uses bounded requests and rewards every wallet only once", () => {
    const ids = Array.from({ length: 16 }, (_, i) => user("full_" + i));
    const entries = ids.map((userId) => ({ userId, game: "roulette", amount: 100, payout: 200, outcome: "win", detail: { roomCode: "BATCH1" } }));
    const original = Object.fromEntries(["exec", "get", "all", "run"].map((method) => [method, pool.db[method].bind(pool.db)]));
    let requests = 0;
    for (const method of Object.keys(original)) pool.db[method] = (...args) => { requests++; return original[method](...args); };
    pool.db.batch = (statements) => { requests++; return statements.map(({ method = "run", sql, params = [] }) => original[method](sql, params)); };
    try {
        assert.equal(recordBets(entries, true).length, 16);
        assert.ok(requests <= 10, "Used " + requests + " remote-style requests");
        recordBets(entries, true);
    } finally {
        for (const method of Object.keys(original)) pool.db[method] = original[method];
        delete pool.db.batch;
    }
    for (const id of ids) {
        const state = snapshot(id);
        assert.equal(state.user.xp, 72);
        assert.equal(state.bets.length, 2);
        assert.deepEqual(state.achievements, [{ achievement_key: "first_victory" }]);
        assert.equal(state.rewards.length, 3);
        for (const wallet of state.wallets) assert.equal(wallet.balance, 1100000);
        assert.equal(state.missions.find((row) => row.mission_key === "weekly_rooms_5").progress, 1);
        assert.equal(state.missions.find((row) => row.mission_key === "daily_play_10").progress, 2);
    }
});
test("a ledger failure for the last participant rolls back all 16 players", () => {
    const ids = Array.from({ length: 16 }, (_, i) => user("rollback_" + i));
    const before = ids.map(snapshot);
    const lastWallet = pool.getWalletSync(ids.at(-1), "duel").id;
    const original = pool.db.run.bind(pool.db);
    pool.db.run = (sql, params) => {
        if (sql.startsWith("INSERT INTO transactions") && params[0] === lastWallet) throw new Error("last ledger failure");
        return original(sql, params);
    };
    try {
        assert.throws(() => recordBets(ids.map((userId) => ({ userId, game: "roulette", amount: 100, payout: 200, outcome: "win", detail: { roomCode: "BATCH2" } })), true), /last ledger failure/);
    } finally { pool.db.run = original; }
    assert.deepEqual(ids.map(snapshot), before);
    for (const id of ids) assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM mission_rooms WHERE user_id=?", [id]).n, 0);
});
test("collective and individual progression produce identical milestones, XP and ledgers", () => {
    const games = ["dice", "coinflip", "blackjack-mp", "slots", "mines", "crash", "racing", "plinko"];
    const pairs = games.map((game, i) => [user("single_" + i), user("group_" + i)]);
    for (const [a, b] of pairs) for (const id of [a, b]) {
        pool.db.run("UPDATE users SET level=25,xp=10 WHERE id=?", [id]);
        pool.db.run("UPDATE wallets SET balance=1990000 WHERE user_id=?", [id]);
        for (let i = 0; i < 9; i++) pool.db.run("INSERT INTO bets (user_id,game,wager,multiplier,payout,outcome,detail) VALUES (?,'dice',100,1.4,140,'win','{}')", [id]);
    }
    const detail = { tableCode: "EQUAL1", picked: 6, playerTotal: 21, hits: 0, allWin: true, jackpot: true, multiplier: 1000, cashout: 4, horseName: "Nicolas", horseOdds: 8, maxOdds: 8 };
    const entries = games.map((game, i) => ({ userId: pairs[i][1], game, amount: 100, payout: 100000, outcome: "win", detail }));
    for (let i = 0; i < games.length; i++) recordBet(pairs[i][0], games[i], 100, 100000, "win", detail);
    recordBets(entries);
    for (const [single, group] of pairs) assert.deepEqual(snapshot(group), snapshot(single));
    assert.throws(() => recordBets([entries[0], entries[0]]), /duplicado/);
});
test.after(() => { pool.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
