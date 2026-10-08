const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
require("./support.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-failures-"));
process.env.DB_PATH = path.join(directory, "test.db");
const pool = require("../src/config/database");

test("rollback response failures preserve the original transaction error", () => {
    const original = pool.db.exec.bind(pool.db);
    const failure = Object.assign(new Error("commit unavailable"), { code: "TRANSACTION_CLOSED" });
    pool.db.exec = (sql) => { original(sql); if (sql === "ROLLBACK") throw new Error("rollback response lost"); };
    try {
        assert.throws(() => pool.transactionSync(() => { throw failure; }), (error) => error === failure && error.code === "TRANSACTION_CLOSED" && error.rollbackFailed === true);
    } finally { pool.db.exec = original; }
    assert.equal(pool.transactionSync(() => 7), 7);
});

test("uncertain remote outcomes poison the connection, reject retries and still allow close", () => {
    const load = Module._load, methods = [];
    Module._load = function (name, ...args) {
        if (name === "synckit") return { createSyncFn: () => ({ method }) => {
            methods.push(method);
            return method === "close" ? { value: null } : { error: "Private remote request failed.", code: "TRANSACTION_CLOSED", uncertain: true };
        } };
        return load.call(this, name, ...args);
    };
    const target = require.resolve("../src/config/turso");
    delete require.cache[target];
    try {
        const db = require(target).createTursoDatabase("https://example.test", "private-test-token");
        assert.throws(() => db.exec("COMMIT"), (error) => error.code === "TRANSACTION_CLOSED" && error.command === "COMMIT");
        assert.equal(db.isAvailable(), false);
        assert.throws(() => db.get("SELECT 1"), { code: "DATABASE_UNAVAILABLE" });
        assert.equal(db.close(), null);
        assert.deepEqual(methods, ["exec", "close"]);
    } finally { Module._load = load; delete require.cache[target]; }
});

test.after(() => { pool.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
