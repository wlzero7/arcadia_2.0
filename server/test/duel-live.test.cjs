const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FakeIO, gameBalance } = require("./support.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-duel-live-"));
process.env.DB_PATH = path.join(directory, "test.db");
const pool = require("../src/config/database");
const realtime = require("../src/realtime/duels");
const store = require("../src/services/realtimeStore");
let sequence = 0;

function user() {
    const name = "live" + ++sequence;
    return pool.db.run("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'test')", [name, name + "@example.test"]).lastInsertRowid;
}
function room(game) {
    const a = user(), b = user(), io = new FakeIO();
    realtime.setupDuels(io);
    const p1 = io.connect(a, "Alice"), p2 = io.connect(b, "Bob");
    const created = p1.call("duel:create").duel;
    p2.call("duel:join", { code: created.code });
    p1.call("duel:ready"); p2.call("duel:ready"); p1.call("duel:ready");
    const gameIdx = ["dice", "coinflip", "crash", "mines", "roulette", "slots"].indexOf(game);
    p1.call("duel:bid", { gameIdx, amount: 10 });
    assert.equal(p1.call("duel:choose", { gameIdx }).ok, true);
    const duel = realtime.duels.get(created.code);
    const total = () => gameBalance(a, "duel") + gameBalance(b, "duel");
    return { a, b, io, p1, p2, duel, total, before: total() };
}
function publicState(io) { return io.messages.filter((m) => m.event === "duel:state").at(-1).data; }

test("Duel Mines broadcasts real picks, hides mines, restores the board and settles once", () => {
    const r = room("mines"), { a, io, p1, p2, duel } = r;
    assert.equal(p1.call("duel:play", { wager: 100, choice: { mines: 25 } }).ok, false);
    assert.equal(p1.call("duel:play", { wager: 100, choice: { mines: 5 } }).active, true);
    assert.equal(duel.turn, "p1");
    assert.equal(duel.lastPlay, null);
    assert.equal(publicState(io).activePlay.mines, undefined);
    assert.equal(publicState(io).activePlay.minePositions, undefined);
    assert.equal(publicState(io).activePlay.minesCount, 5);
    assert.equal(p1.call("duel:play", { wager: 100 }).ok, false);
    assert.equal(p2.call("duel:pick", { cell: 1 }).ok, false);
    assert.equal(p2.call("duel:cashout").ok, false);
    assert.equal(p1.call("duel:pick", { cell: 1.5 }).ok, false);
    const safe = Array.from({ length: 25 }, (_, i) => i).find((i) => !duel.activePlay.mines.includes(i));
    assert.equal(p1.call("duel:pick", { cell: safe }).ok, true);
    assert.deepEqual(publicState(io).activePlay.picked, [safe]);
    assert.equal(p1.call("duel:pick", { cell: safe }).ok, false);
    const reconnect = io.connect(a, "Alice");
    const restored = reconnect.call("duel:join", { code: duel.code });
    assert.deepEqual(restored.duel.activePlay.picked, [safe]);
    assert.deepEqual(store.load("duel").get(duel.code).activePlay.picked, [safe]);
    assert.equal(reconnect.call("duel:cashout").result.payout, 125);
    assert.equal(duel.activePlay, null);
    assert.equal(duel.turn, "p2");
    assert.deepEqual(publicState(io).lastPlay.detail.opened, [safe]);
    assert.equal(duel.lastPlay.detail.minePositions.length, 5);
    assert.equal(reconnect.call("duel:cashout").ok, false);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?", [a]).n, 1);
    assert.equal(r.total(), r.before);
    p1.call("duel:leave");
});

test("Duel Mines hitting a mine transfers the stake and zero picks can be cancelled", () => {
    const r = room("mines"), { b, p1, p2, duel } = r;
    p1.call("duel:play", { wager: 100, choice: { mines: 5 } });
    const mine = duel.activePlay.mines[0];
    assert.equal(p1.call("duel:pick", { cell: mine }).result.outcome, "loss");
    assert.equal(duel.lastPlay.transfer, -100);
    assert.deepEqual(duel.lastPlay.detail.opened, [mine]);
    assert.equal(p1.call("duel:pick", { cell: mine }).ok, false);
    p2.call("duel:play", { wager: 100, choice: { mines: 5 } });
    assert.equal(p2.call("duel:cashout").result.outcome, "push");
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?", [b]).n, 0);
    assert.equal(pool.db.get("SELECT xp FROM users WHERE id = ?", [b]).xp, 0);
    assert.equal(r.total(), r.before);
    p1.call("duel:leave");
});

test("Duel Crash uses server time for manual/auto cashout and hides the crash point", () => {
    const r = room("crash"), { a, io, p1, p2, duel } = r;
    assert.equal(p1.call("duel:play", { wager: 100, choice: { autoCashout: 1 } }).ok, false);
    assert.equal(p1.call("duel:play", { wager: 100, choice: {} }).active, true);
    assert.equal(publicState(io).activePlay.crashPoint, undefined);
    assert.equal(p2.call("duel:cashout").ok, false);
    duel.activePlay.crashPoint = 10;
    duel.activePlay.startedAt = Date.now() - 1500;
    const manual = p1.call("duel:cashout");
    assert.equal(manual.result.outcome, "win");
    assert.ok(manual.result.detail.cashout >= 1.68 && manual.result.detail.cashout < 1.8);
    assert.equal(p1.call("duel:cashout").ok, false);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?", [a]).n, 1);
    p2.call("duel:play", { wager: 100, choice: { autoCashout: 2 } });
    duel.activePlay.crashPoint = 10;
    duel.activePlay.startedAt = Date.now() - 2500;
    p2.call("duel:sync");
    assert.equal(duel.activePlay, null);
    assert.equal(duel.lastPlay.detail.cashout, 2);
    assert.equal(duel.lastPlay.transfer, 100);
    assert.equal(r.total(), r.before);
    p1.call("duel:leave");
});

test("Duel Crash resolves without client polling and rejects late cashout", async () => {
    const r = room("crash"), { io, p1, duel } = r;
    p1.call("duel:play", { wager: 100 });
    duel.activePlay.crashPoint = 1.01;
    p1.call("duel:join", { code: duel.code });
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(duel.activePlay, null);
    assert.equal(publicState(io).lastPlay.detail.crashed, true);
    assert.equal(p1.call("duel:cashout").ok, false);
    assert.equal(r.total(), r.before);
    p1.call("duel:leave");
});

test("leaving an active Duel round clears it and conserves credits", () => {
    const r = room("mines"), { a, p1, duel } = r;
    const wallet = pool.getWalletSync(a, "duel");
    pool.adjustBalanceSync(wallet.id, 100 - wallet.balance, "bet");
    const before = r.total();
    p1.call("duel:play", { wager: 100 });
    assert.equal(p1.call("duel:leave").ok, true);
    assert.equal(duel.phase, "finished");
    assert.equal(duel.activePlay, null);
    assert.equal(duel.winnerKey, "p2");
    assert.equal(duel.cancelled, undefined);
    assert.equal(r.total(), before);
});

test.after(() => { pool.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
