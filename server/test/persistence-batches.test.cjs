const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-batches-")), "test.db");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "local-test-only";
const pool = require("../src/config/database");
const missions = require("../src/services/progression.routes");
const { settleInstant } = require("../src/services/rounds");
function user(name) {
    const id = pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,?)", [name, name + "@example.test", "hash"]).lastInsertRowid;
    for (const kind of ["solo", "duel", "coop"]) pool.getWalletSync(id, kind);
    return id;
}
test("mixed batches return rows and mutation metadata, and failures roll back all statements", () => {
    const id = user("mixed");
    const results = pool.batchSync([
        { sql: "UPDATE wallets SET balance=77 WHERE user_id=? AND kind='solo'", params: [id] },
        { method: "get", sql: "SELECT balance FROM wallets WHERE user_id=? AND kind='solo'", params: [id] },
        { method: "all", sql: "SELECT kind FROM wallets WHERE user_id=? ORDER BY kind", params: [id] },
    ]);
    assert.equal(results[0].changes, 1); assert.equal(results[1].balance, 77); assert.equal(results[2].length, 3);
    assert.throws(() => pool.batchSync([
        { sql: "UPDATE wallets SET balance=88 WHERE user_id=? AND kind='solo'", params: [id] },
        { sql: "INSERT INTO wallets (user_id,kind,balance) VALUES (?,'solo',1)", params: [id] },
    ]));
    assert.equal(pool.getWalletSync(id).balance, 77);
    assert.deepEqual(pool.batchSync([]), []);
    assert.throws(() => pool.batchSync([{ method: "exec", sql: "DELETE FROM users" }]), /Invalid batch/);
});
test("mission upserts cap progress, preserve claims, and do not reaward completed milestones", () => {
    const id = user("missions"); const date = new Date("2026-10-08T01:00:00Z");
    const event = { game: "dice", wager: 400, outcome: "push" };
    missions.trackGameActivity(id, event, date);
    missions.trackGameActivity(id, event, date);
    let row = pool.db.get("SELECT * FROM user_missions WHERE user_id=? AND mission_key='daily_bet_500'", [id]);
    assert.equal(row.progress, 500); assert.equal(row.completed, 1);
    pool.db.run("UPDATE user_missions SET claimed=1 WHERE user_id=?", [id]);
    missions.trackGameActivity(id, event, date);
    row = pool.db.get("SELECT * FROM user_missions WHERE user_id=? AND mission_key='daily_bet_500'", [id]);
    assert.equal(row.progress, 500); assert.equal(row.claimed, 1);
    const invalid = user("invalid_wager");
    missions.trackGameActivity(invalid, { ...event, wager: -1 }, date);
    assert.ok(!pool.db.get("SELECT 1 FROM user_missions WHERE user_id=? AND mission_key='daily_bet_500'", [invalid]));
});
test("game mission batches keep variety unique and roll back with the enclosing wager", () => {
    const id = user("variety"); const date = new Date("2026-10-08T01:00:00Z");
    assert.throws(() => pool.transactionSync(() => {
        missions.trackGameActivity(id, { game: "dice", wager: 100, outcome: "win" }, date);
        throw new Error("rollback");
    }));
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM user_missions WHERE user_id=?", [id]).n, 0);
    for (const game of ["dice", "dice", "slots", "crash"]) missions.trackGameActivity(id, { game, wager: 100, outcome: "win" }, date);
    assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id=? AND mission_key='daily_variety_3'", [id]).progress, 3);
    assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id=? AND mission_key='daily_play_10'", [id]).progress, 4);
});
test("settled rounds check profile once, avoid duplicate XP, and use bounded remote-style requests", () => {
    const id = user("requests");
    const original = Object.fromEntries(["exec", "get", "all", "run"].map((method) => [method, pool.db[method].bind(pool.db)]));
    let count = 0; const batches = [];
    for (const method of Object.keys(original)) pool.db[method] = (...args) => { count++; return original[method](...args); };
    pool.db.batch = (statements) => {
        count++; batches.push(statements);
        return statements.map(({ method = "run", sql, params = [] }) => original[method](sql, params));
    };
    try {
        const first = settleInstant(id, "dice", 100, 140, "win", { picked: 6, roll: 6 });
        assert.deepEqual(first.unlocked.map((a) => a.key).sort(), ["bad_face", "first_victory", "six_faces"]);
        assert.equal(batches.filter((b) => b.some((s) => s.sql.includes("COALESCE(w.balance, 1000000)"))).length, 1);
        assert.deepEqual(first.levelInfo.xp, pool.db.get("SELECT xp FROM users WHERE id=?", [id]).xp);
        const xp = first.levelInfo.xp;
        count = 0;
        const second = settleInstant(id, "dice", 100, 140, "win", { picked: 6, roll: 6 });
        assert.ok(count <= 22, "Repeated round used " + count + " requests");
        assert.equal(second.unlocked.length, 0); assert.equal(second.levelInfo.xp, xp + 11);
    } finally {
        for (const method of Object.keys(original)) pool.db[method] = original[method];
        delete pool.db.batch;
    }
});
test.after(() => pool.db.close());
