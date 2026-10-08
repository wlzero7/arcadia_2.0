const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { invoke, FakeIO, gameBalance } = require("./support.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-regression-"));
process.env.DB_PATH = path.join(directory, "test.db");
const pool = require("../src/config/database");
const rounds = require("../src/services/rounds");
const games = require("../src/routes/game.routes");
const blackjack = require("../src/routes/blackjack.routes");
const roulette = require("../src/routes/roulette.routes");
const slots = require("../src/routes/slots.routes");
const wallet = require("../src/routes/wallet.routes");
const shares = require("../src/services/roomShares");
let sequence = 0;
function user() {
    const n = ++sequence;
    const id = pool.db.run("INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'test')", ["tester" + n, "tester" + n + "@example.test"]).lastInsertRowid;
    for (const kind of ["solo", "coop", "duel"]) pool.getWalletSync(id, kind);
    return id;
}
function balance(id, kind = "solo") { return gameBalance(id, kind); }
function card(id, key) { pool.db.run("INSERT INTO slots_cards (user_id, card_key, rarity) VALUES (?, ?, 'epica')", [id, key]); }

test("balances survive boot without being refilled; sessions survive another process", () => {
    const id = user();
    rounds.startRound(id, "mines", 100, { mines: [0], picked: [] });
    const result = spawnSync(process.execPath, ["-e", 'require("./test/support.cjs"); const p=require("./src/config/database"); console.log(JSON.stringify({balance:p.getWalletSync(' + id + ',"solo").balance,state:require("./src/services/rounds").getSession(' + id + ',"mines")}));'], { cwd: path.resolve(__dirname, ".."), env: process.env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.balance, 999900);
    assert.deepEqual(data.state.mines, [0]);
});
test("transaction rolls back debit, card consumption and session together", () => {
    const id = user(); card(id, "escudo");
    assert.throws(() => pool.transactionSync(() => {
        pool.adjustBalanceSync(pool.getWalletSync(id).id, -100, "bet");
        pool.db.run("DELETE FROM slots_cards WHERE user_id = ?", [id]);
        rounds.saveSession(id, "mines", { wager: 100 });
        throw new Error("simulated storage failure");
    }));
    assert.equal(balance(id), 1000000);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM slots_cards WHERE user_id = ?", [id]).n, 1);
    assert.equal(rounds.getSession(id, "mines"), null);
});
test("legacy wallet migration preserves balances, ledger and foreign keys", () => {
    const legacyPath = path.join(directory, "legacy.db");
    const { Database } = require("node-sqlite3-wasm");
    const legacy = new Database(legacyPath);
    legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, email TEXT UNIQUE, password_hash TEXT, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE wallets (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE, balance INTEGER, updated_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE transactions (id INTEGER PRIMARY KEY, wallet_id INTEGER REFERENCES wallets(id) ON DELETE CASCADE, kind TEXT, amount INTEGER, balance_after INTEGER, ref_type TEXT, ref_id TEXT, created_at TEXT DEFAULT (datetime('now')));
        INSERT INTO users (id,username,email,password_hash) VALUES (1,'legacy','legacy@example.test','test');
        INSERT INTO wallets (id,user_id,balance) VALUES (1,1,1234);
        INSERT INTO transactions (id,wallet_id,kind,amount,balance_after) VALUES (1,1,'bet',-10,1234);
    `);
    legacy.close();
    const result = spawnSync(process.execPath, ["-e", 'require("./test/support.cjs"); const p=require("./src/config/database"); console.log(JSON.stringify({balance:p.getWalletSync(1,"solo").balance,ledger:p.db.all("SELECT * FROM transactions"),invalid:p.db.all("PRAGMA foreign_key_check")}));'], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, DB_PATH: legacyPath }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim());
    assert.equal(data.balance, 1234);
    assert.equal(data.ledger.length, 1);
    assert.equal(data.ledger[0].amount, -10);
    assert.deepEqual(data.invalid, []);
});
test("wager missions count credits and reconnecting to a room does not inflate progress", () => {
    const id = user();
    rounds.settleInstant(id, "dice", 500, 0, "loss", {});
    const progression = require("../src/services/progression.routes");
    let mission = pool.db.get("SELECT progress, completed FROM user_missions WHERE user_id = ? AND mission_key = 'daily_bet_500'", [id]);
    assert.deepEqual({ ...mission }, { progress: 500, completed: 1 });
    progression.trackRoomActivity(id, "ROOM1");
    progression.trackRoomActivity(id, "ROOM1");
    mission = pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'weekly_rooms_5'", [id]);
    assert.equal(mission.progress, 1);
});
test("a round can settle only once", () => {
    const id = user(); rounds.startRound(id, "mines", 100, { mines: [0], picked: [1] });
    rounds.settleRound(id, "mines", 125, "win", {});
    assert.throws(() => rounds.settleRound(id, "mines", 125, "win", {}));
    assert.equal(balance(id), 1000025);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?", [id]).n, 1);
});

test("Coin Flip validates sides, pays 2x and updates game missions", () => {
    const id = user();
    const invalid = invoke(games.router, "/:game/play", id, { wager: 100, choice: { side: "invalid" } }, "post", { params: { game: "coinflip" } });
    assert.equal(invalid.status, 400);
    assert.equal(balance(id), 1000000);
    const result = invoke(games.router, "/:game/play", id, { wager: 100, choice: { side: "heads" } }, "post", { params: { game: "coinflip" } });
    assert.equal(result.status, 200);
    assert.equal(result.payout, result.detail.flip === "heads" ? 200 : 0);
    assert.equal(balance(id), 999900 + result.payout);
    assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'daily_coinflip_5'", [id]).progress, 1);
});

test("login missions count distinct days and claim rewards only once", () => {
    const id = user(), progression = require("../src/services/progression.routes");
    const now = new Date("2026-10-05T12:00:00Z");
    progression.trackLoginActivity(id, now); progression.trackLoginActivity(id, now);
    progression.trackLoginActivity(id, new Date("2026-10-06T12:00:00Z"));
    assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'weekly_login_4'", [id]).progress, 2);
    assert.equal(progression.claimMission(id, "daily_login", now).xp, 50);
    assert.throws(() => progression.claimMission(id, "daily_login", now));
    assert.equal(pool.db.get("SELECT xp FROM users WHERE id = ?", [id]).xp, 50);
    assert.throws(() => progression.claimMission(id, "constructor", now));
});

test("mission cadence and reset boundaries are consistent in UTC", () => {
    const id = user(), progression = require("../src/services/progression.routes");
    const morning = new Date("2026-10-10T00:00:00Z"), evening = new Date("2026-10-10T23:59:59Z");
    assert.equal(progression.weekKey(morning), progression.weekKey(evening));
    assert.notEqual(progression.weekKey(evening), progression.weekKey(new Date("2026-10-11T00:00:00Z")));
    assert.equal(progression.resets(evening).weekly, "2026-10-11T00:00:00.000Z");
    const result = invoke(progression.router, "/missions", id, {}, "get");
    assert.equal(result.missions.filter((m) => m.cadence === "daily").length, 21);
    assert.equal(result.missions.filter((m) => m.cadence === "weekly").length, 7);
    assert.equal(result.missions.find((m) => m.key === "daily_login").completed, true);
});

test("duel game details count Coin Flip and variety without counting repeats", () => {
    const id = user();
    rounds.recordBet(id, "duel", 100, 200, "win", { game: "coinflip" });
    rounds.recordBet(id, "coinflip", 100, 0, "loss", { roomCode: "COIN01" });
    const progress = (key) => pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = ?", [id, key]).progress;
    assert.equal(progress("daily_coinflip_5"), 2);
    assert.equal(progress("daily_variety_3"), 1);
    assert.equal(progress("daily_duel_3"), 1);
    assert.equal(progress("daily_coop_3"), 1);
    assert.equal(progress("daily_bet_100_twice"), 2);
});

test("mission rewards roll back on XP failure and return actual level information", () => {
    const id = user(), progression = require("../src/services/progression.routes"), now = new Date("2026-10-05T12:00:00Z");
    progression.trackLoginActivity(id, now);
    pool.db.exec(`CREATE TEMP TRIGGER fail_mission_xp BEFORE UPDATE OF xp ON users WHEN NEW.id = ${id} BEGIN SELECT RAISE(ABORT, 'simulated XP failure'); END;`);
    try {
        assert.throws(() => progression.claimMission(id, "daily_login", now), /simulated XP failure/);
        assert.equal(pool.db.get("SELECT claimed FROM user_missions WHERE user_id = ? AND mission_key = 'daily_login'", [id]).claimed, 0);
        assert.equal(pool.db.get("SELECT xp FROM users WHERE id = ?", [id]).xp, 0);
    } finally { pool.db.exec("DROP TRIGGER fail_mission_xp"); }
    const reward = progression.claimMission(id, "daily_login", now);
    assert.equal(reward.levelInfo.level, 1);
    assert.equal(reward.levelInfo.xp, 50);
    assert.equal(reward.levelInfo.then, undefined);
});

test("expired mission snapshots cannot claim the new period", () => {
    const id = user(), progression = require("../src/services/progression.routes");
    const before = new Date("2026-12-31T23:59:59Z"), after = new Date("2027-01-01T00:00:00Z");
    progression.trackLoginActivity(id, before); progression.trackLoginActivity(id, after);
    assert.throws(() => progression.claimMission(id, "daily_login", after, progression.todayKey(before)), /expirada/);
    assert.equal(progression.resets(before).weekly, "2027-01-01T00:00:00.000Z");
    assert.notEqual(progression.weekKey(before), progression.weekKey(after));
    assert.equal(progression.claimMission(id, "daily_login", after, progression.todayKey(after)).xp, 50);
});

test("cancelled zero-pick Mines rounds do not farm XP, missions or achievements", () => {
    const id = user();
    invoke(games.router, "/mines/start", id, { wager: 100, mines: 3 });
    const result = invoke(games.router, "/mines/cashout", id);
    assert.equal(result.cancelled, true);
    assert.equal(balance(id), 1000000);
    assert.equal(pool.db.get("SELECT xp FROM users WHERE id = ?", [id]).xp, 0);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM user_missions WHERE user_id = ?", [id]).n, 0);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM user_achievements WHERE user_id = ?", [id]).n, 0);
});

test("Coop Coin Flip conserves shares and withdrawals after reconnection", () => {
    const a = user(), b = user(), io = new FakeIO(), rooms = require("../src/realtime/rooms"); rooms.setupMultiplayer(io);
    const p1 = io.connect(a), p2 = io.connect(b), created = p1.call("room:create", { game: "coinflip" }).room;
    p2.call("room:join", { code: created.code });
    p1.call("room:stake", { amount: 100 }); p2.call("room:stake", { amount: 300 });
    assert.equal(p1.call("room:play", { wager: 100, choice: { side: "invalid" } }).ok, false);
    assert.equal(rooms.rooms.get(created.code).pot, 400);
    const result = p1.call("room:play", { wager: 100, choice: { side: "heads" } });
    assert.equal(result.ok, true);
    assert.equal(result.round.payout, result.round.flip === "heads" ? 200 : 0);
    const state = rooms.rooms.get(created.code);
    assert.equal(state.pot, 300 + result.round.payout);
    assert.equal(state.stakes.get(a) * 3, state.stakes.get(b));
    p1.disconnect(); p2.disconnect(); rooms.rooms.clear(); rooms.hydrateRooms();
    const reconnect1 = io.connect(a), reconnect2 = io.connect(b);
    reconnect1.call("room:join", { code: created.code }); reconnect2.call("room:join", { code: created.code });
    assert.equal(reconnect1.callWithoutData("room:withdraw").ok, true);
    assert.equal(reconnect2.callWithoutData("room:withdraw").ok, true);
    assert.equal(reconnect1.callWithoutData("room:withdraw").ok, false);
    assert.equal(balance(a, "coop") + balance(b, "coop"), 2000000 + result.round.payout - 100);
    assert.equal(balance(a), 1000000);
    assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'daily_coinflip_5'", [a]).progress, 1);
});

test("duel Coin Flip enforces turns, preserves balances and tracks both players", () => {
    const a = user(), b = user(), io = new FakeIO(); require("../src/realtime/duels").setupDuels(io);
    const p1 = io.connect(a), p2 = io.connect(b), duel = p1.callWithoutData("duel:create").duel;
    p2.call("duel:join", { code: duel.code }); p1.callWithoutData("duel:ready"); p2.callWithoutData("duel:ready"); p1.callWithoutData("duel:ready");
    assert.equal(p1.call("duel:bid", { gameIdx: 1, amount: 10 }).ok, true);
    require("../src/realtime/duels").duels.get(duel.code).auctionEndsAt = Date.now() - 1;
    assert.equal(p1.call("duel:choose", { gameIdx: 1 }).ok, true);
    const sum = balance(a, "duel") + balance(b, "duel");
    assert.equal(p2.call("duel:play", { game: "coinflip", wager: 100, choice: { side: "tails" } }).ok, false);
    assert.equal(p1.call("duel:play", { game: "coinflip", wager: 100, choice: { side: "invalid" } }).ok, false);
    assert.equal(balance(a, "duel") + balance(b, "duel"), sum);
    assert.equal(p1.call("duel:play", { game: "coinflip", wager: 100, choice: { side: "heads" } }).ok, true);
    assert.equal(p1.call("duel:play", { game: "coinflip", wager: 100, choice: { side: "heads" } }).ok, false);
    assert.equal(p2.call("duel:play", { game: "coinflip", wager: 100, choice: { side: "tails" } }).ok, true);
    assert.equal(balance(a, "duel") + balance(b, "duel"), sum);
    for (const id of [a, b]) assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'daily_coinflip_5'", [id]).progress, 1);
    p1.callWithoutData("duel:leave");
    assert.equal(pool.db.get("SELECT completed FROM user_missions WHERE user_id = ? AND mission_key = 'daily_duel_win'", [b]).completed, 1);
});

test("multiplayer Blackjack missions settle once and exclude offline spectators", () => {
    const a = user(), b = user(), c = user(), io = new FakeIO();
    const { tables } = require("../src/realtime/blackjack-mp").setupBlackjackMultiplayer(io);
    const p1 = io.connect(a), p2 = io.connect(b), offline = io.connect(c), created = p1.callWithoutData("bj:create");
    const code = created.table.code;
    p2.call("bj:join", { code }); offline.call("bj:join", { code }); offline.disconnect();
    p1.callWithoutData("bj:start");
    const table = tables.get(code);
    assert.deepEqual(table.order, [a, b]);
    table.players.get(a).hand = [{ rank: "10", suit: "S" }, { rank: "Q", suit: "H" }];
    table.players.get(b).hand = [{ rank: "10", suit: "S" }, { rank: "9", suit: "H" }];
    table.players.get(c).hand = [{ rank: "A", suit: "S" }, { rank: "K", suit: "H" }];
    assert.equal(p1.callWithoutData("bj:stand").ok, true);
    assert.equal(p2.callWithoutData("bj:stand").ok, true);
    const ended = io.messages.filter((m) => m.event === "bj:round_end").at(-1).data;
    assert.equal(ended.winner.id, a); assert.equal(ended.results.length, 2);
    assert.equal(p2.callWithoutData("bj:stand").ok, false);
    for (const id of [a, b]) assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'daily_blackjack_mp_3'", [id]).progress, 1);
    assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'daily_blackjack_mp_win'", [a]).progress, 1);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM user_missions WHERE user_id = ?", [c]).n, 0);
    tables.delete(code);
});
test("Mines hides mines during a round, accepts a safe pick and cashes out once", () => {
    const id = user();
    assert.equal(invoke(games.router, "/mines/start", id, { wager: 100, mines: 3 }).status, 200);
    const state = rounds.getSession(id, "mines");
    const publicState = invoke(games.router, "/mines/state", id, {}, "get");
    assert.equal(publicState.mines, undefined);
    assert.ok(publicState.nextMultiplier > publicState.multiplier);
    const safe = Array.from({ length: 25 }, (_, i) => i).find((cell) => !state.mines.includes(cell));
    assert.equal(invoke(games.router, "/mines/pick", id, { cell: safe }).boom, false);
    assert.equal(invoke(games.router, "/mines/pick", id, { cell: safe }).status, 400);
    assert.equal(invoke(games.router, "/mines/cashout", id).status, 200);
    assert.equal(invoke(games.router, "/mines/cashout", id).status, 400);
});
test("zero-pick Mines cancellation refunds the wager", () => {
    const id = user(); invoke(games.router, "/mines/start", id, { wager: 100, mines: 3 });
    assert.equal(invoke(games.router, "/mines/cashout", id).payout, 100);
    assert.equal(balance(id), 1000000);
});
test("legacy Mines cannot guarantee safe picks from its own mine shuffle", () => {
    const outcomes = new Set();
    for (let i = 0; i < 200; i++) outcomes.add(games.GAMES.mines.play(100, { mines: 20, picks: 5 }).outcome);
    assert.ok(outcomes.has("loss"));
    // With five safe cells and five picks, a guaranteed win would reveal the old exploit.
    assert.throws(() => games.GAMES.mines.play(100, { mines: 3.5, picks: 1 }));
});
test("all instant games validate their input before charging", () => {
    const id = user();
    assert.equal(invoke(games.router, "/:game/play", id, { wager: 100, choice: { number: 7 } }, "post", { params: { game: "dice" } }).status, 400);
    assert.equal(invoke(games.router, "/mines/start", id, { wager: Infinity, mines: 3 }).status, 400);
    assert.equal(invoke(games.router, "/plinko/drop", id, { wager: 1000001, risk: "high" }).status, 400);
    assert.equal(invoke(roulette, "/roulette/spin", id, { bets: [{ type: "straight", value: null, amount: 100 }] }).status, 400);
    assert.equal(balance(id), 1000000);
});
test("Crash uses server time, settles elapsed rounds and prevents a duplicate payout", () => {
    const id = user(); rounds.startRound(id, "crash", 100, { crashPoint: 1.01 });
    const state = rounds.getSession(id, "crash"); state.startedAt -= 60000;
    rounds.saveSession(id, "crash", state);
    assert.equal(invoke(games.router, "/crash/state", id, {}, "get").crashed, true);
    assert.equal(invoke(games.router, "/crash/cashout", id).status, 400);
    assert.equal(balance(id), 999900);
});
test("Blackjack hides the hole card and double debits/settles exactly once", () => {
    const id = user();
    rounds.startRound(id, "blackjack", 100, { deck: [{ rank: "2", suit: "♠" }, { rank: "10", suit: "♠" }], player: [{ rank: "5", suit: "♠" }, { rank: "6", suit: "♥" }], dealer: [{ rank: "10", suit: "♦" }, { rank: "7", suit: "♣" }], doubled: false });
    const state = invoke(blackjack, "/blackjack/state", id, {}, "get");
    assert.deepEqual(state.dealer[1], { hidden: true });
    const result = invoke(blackjack, "/blackjack/double", id);
    assert.equal(result.outcome, "win"); assert.equal(result.payout, 400); assert.equal(balance(id), 1000200);
    assert.equal(invoke(blackjack, "/blackjack/double", id).status, 400);
});
test("Escudo accounts for refunds, and insufficient Duplicador preserves the card", () => {
    const id = user(); card(id, "escudo");
    const result = invoke(slots, "/play", id, { wager: 100, trump: "escudo" });
    assert.equal(result.status, 200); assert.equal(balance(id), 1000000 + result.delta); assert.equal(result.balance, pool.getWalletSync(id).balance); assert.ok(result.delta >= 0);
    const poor = user(); pool.db.run("UPDATE wallets SET balance = 150 WHERE user_id = ? AND kind = 'solo'", [poor]); card(poor, "duplicador");
    assert.equal(invoke(slots, "/play", poor, { wager: 100, trump: "duplicador" }).status, 400);
    assert.equal(balance(poor), 150);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM slots_cards WHERE user_id = ?", [poor]).n, 1);
});
test("daily bonus and transfers are atomic", () => {
    const a = user(), b = user();
    assert.equal(invoke(wallet, "/daily", a).amount, 1000);
    assert.equal(invoke(wallet, "/daily", a).status, 400);
    const username = pool.db.get("SELECT username FROM users WHERE id = ?", [b]).username;
    const sum = balance(a) + balance(b);
    assert.equal(invoke(wallet, "/transfer", a, { toUsername: username, amount: 100 }).status, 200);
    assert.equal(balance(a) + balance(b), sum);
});
test("room shares preserve every credit after wins and losses", () => {
    for (let total = 0; total < 100; total++) {
        const result = shares.allocateShares(new Map([[1, 10], [2, 20], [3, 30]]), total);
        assert.equal([...result.values()].reduce((a, b) => a + b, 0), total);
    }
});
test("rooms use COOP, retain offline stakes, hydrate and allow withdrawal", () => {
    const id = user(), io = new FakeIO();
    const rooms = require("../src/realtime/rooms"); rooms.setupMultiplayer(io);
    const socket = io.connect(id);
    const room = socket.call("room:create", { game: "dice" }).room;
    assert.equal(socket.callWithoutData("rooms:list").ok, true);
    assert.equal(socket.call("room:stake", { amount: 100 }).ok, true);
    assert.equal(balance(id), 1000000); assert.equal(balance(id, "coop"), 999900);
    socket.disconnect(); rooms.rooms.clear(); rooms.hydrateRooms();
    const reconnect = io.connect(id);
    assert.equal(reconnect.call("room:join", { code: room.code }).room.players[0].stake, 100);
    assert.equal(reconnect.call("room:withdraw").ok, true); assert.equal(balance(id, "coop"), 1000000);
    assert.equal(reconnect.call("room:withdraw").ok, false);
});
test("roulette room pending bets survive hydration", () => {
    const id = user(), io = new FakeIO(), rooms = require("../src/realtime/rooms"); rooms.setupMultiplayer(io);
    const socket = io.connect(id), room = socket.call("room:create", { game: "roulette" }).room;
    socket.call("room:stake", { amount: 100 });
    assert.equal(socket.call("room:rbet", { type: "red", amount: 10 }).ok, true);
    rooms.rooms.clear(); rooms.hydrateRooms();
    const reconnect = io.connect(id); const joined = reconnect.call("room:join", { code: room.code });
    assert.equal(joined.room.rBets.length, 1); assert.equal(joined.room.pot, 90);
    assert.equal(reconnect.call("room:withdraw").ok, false);
    assert.equal(reconnect.call("room:rspin").ok, true);
    const state = rooms.rooms.get(room.code);
    assert.equal([...state.stakes.values()].reduce((a, b) => a + b, 0), state.pot);
});
test("duel requires ready players, locks selected mode and conserves credits", () => {
    const a = user(), b = user(), io = new FakeIO();
    const duelRealtime = require("../src/realtime/duels");
    duelRealtime.setupDuels(io);
    const p1 = io.connect(a, "player_one"), p2 = io.connect(b, "player_two");
    const duel = p1.call("duel:create").duel;
    p2.call("duel:join", { code: duel.code }); p1.call("duel:ready"); p2.call("duel:ready"); p1.call("duel:ready");
    assert.equal(p1.call("duel:bid", { gameIdx: 0, amount: 10 }).ok, true);
    duelRealtime.duels.get(duel.code).auctionEndsAt = Date.now() - 1;
    assert.equal(p1.call("duel:choose", { gameIdx: 0 }).ok, true);
    assert.equal(p1.call("duel:play", { game: "mines", wager: 10, choice: { picks: 1 } }).ok, false);
    const sum = balance(a, "duel") + balance(b, "duel");
    assert.equal(p1.call("duel:play", { game: "dice", wager: 10, choice: { number: 1 } }).ok, true);
    const lastPlay = duelRealtime.duels.get(duel.code).lastPlay;
    assert.equal(lastPlay.game, "dice");
    assert.equal(lastPlay.choice.number, 1);
    assert.equal(typeof lastPlay.id, "string");
    assert.equal(balance(a, "duel") + balance(b, "duel"), sum);
    assert.equal(p1.call("duel:play", { game: "dice", wager: 10, choice: { number: 1 } }).ok, false);
    assert.equal(p1.callWithoutData("duel:leave").ok, true);
    assert.equal(balance(a, "duel") + balance(b, "duel"), sum);
    const ended = io.messages.filter((m) => m.event === "duel:finished").at(-1);
    assert.equal(ended.data.winner, "player_two");
    assert.notEqual(p1.callWithoutData("duel:create").duel.code, duel.code);
});
test("a waiting duel can be cancelled without blocking a new duel or charging credits", () => {
    const id = user(), io = new FakeIO();
    require("../src/realtime/duels").setupDuels(io);
    const socket = io.connect(id);
    const old = socket.callWithoutData("duel:create").duel;
    assert.equal(socket.callWithoutData("duel:leave").ok, true);
    assert.equal(balance(id, "duel"), 1000000);
    assert.equal(io.messages.filter((m) => m.event === "duel:finished").at(-1).data.cancelled, true);
    assert.notEqual(socket.callWithoutData("duel:create").duel.code, old.code);
});
test("race replacement refunds old stakes, can be cancelled and is persisted", () => {
    const id = user(), io = new FakeIO();
    pool.db.run("UPDATE users SET display_name=?, avatar=? WHERE id=?", ["Race Owner", "\u{1F451}", id]);
    const racing = require("../src/realtime/racing"); racing.setupRacing(io);
    const socket = io.connect(id), room = socket.call("race:create").race;
    assert.equal(room.players[0].displayName, "Race Owner");
    assert.equal(room.players[0].avatar, "\u{1F451}");
    assert.equal(room.players[0].online, true);
    assert.equal(room.startedAt, null);
    assert.ok(Number.isFinite(room.serverTime));
    socket.call("race:bet", { horseId: 0, amount: 100 }); socket.call("race:bet", { horseId: 1, amount: 200 });
    const visible = io.messages.filter((message) => message.event === "race:state").at(-1).data;
    assert.equal(visible.players[0].stake, 200);
    assert.equal(visible.players[0].id, id);
    assert.equal(balance(id, "coop"), 999800);
    assert.ok(pool.db.get("SELECT state FROM realtime_sessions WHERE mode = 'race' AND code = ?", [room.code]));
    assert.equal(socket.call("race:withdraw").ok, true); assert.equal(balance(id, "coop"), 1000000);
});
test("multiplayer Blackjack delivers private cards, enforces turns and charges shield energy", () => {
    const a = user(), b = user(), io = new FakeIO();
    const { tables } = require("../src/realtime/blackjack-mp").setupBlackjackMultiplayer(io);
    const p1 = io.connect(a), p2 = io.connect(b);
    const created = p1.callWithoutData("bj:create");
    assert.equal(created.ok, true);
    const code = created.table.code;
    assert.equal(p2.call("bj:join", { code }).ok, true);
    assert.equal(p1.callWithoutData("bj:start").ok, true);
    assert.equal(p1.callWithoutData("bj:start").ok, false);
    const table = tables.get(code), actor = table.players.get(a), opponent = table.players.get(b);
    actor.specials = ["shield", "pick_card"];
    opponent.specials = ["force_hit"];
    const bjCards = require("../src/services/blackjack");
    for (const key of actor.specials) bjCards.addCard(a, key);
    for (const key of opponent.specials) bjCards.addCard(b, key);
    assert.equal(p2.call("bj:special", { cardKey: "force_hit", targetId: a }).ok, false);
    assert.equal(opponent.specials.length, 1);
    assert.equal(p1.call("bj:special", { cardKey: "shield" }).ok, true);
    assert.equal(actor.nrg, 0);
    assert.equal(actor.shield, true);
    const delivered = io.messages.filter((m) => m.channel === p1.id && m.event === "bj:specials").at(-1);
    assert.deepEqual(delivered.data.cards, ["pick_card"]);
    const publicState = io.messages.filter((m) => m.event === "bj:state").at(-1).data;
    assert.equal(typeof publicState.players[0].specials, "number");
    actor.nrg = 10;
    table.deck = [];
    assert.equal(p1.call("bj:special", { cardKey: "pick_card", rank: "A", suit: "spades" }).ok, false);
    assert.equal(actor.nrg, 10);
    assert.deepEqual(actor.specials, ["pick_card"]);
    actor.hand = [{ rank: "2", suit: "spades" }, { rank: "2", suit: "hearts" }];
    table.discard = [{ rank: "2", suit: "clubs" }];
    assert.equal(p1.callWithoutData("bj:hit").ok, true);
    assert.ok(actor.hand.every((c) => c && c.rank && c.suit));
    assert.ok(pool.db.get("SELECT state FROM realtime_sessions WHERE mode = 'blackjack' AND code = ?", [code]));
});
test("security rejects unknown origins and adds CSP", () => {
    const security = require("../src/middleware/security");
    const req = { protocol: "https", headers: { host: "arcadia.example" }, secure: true };
    assert.equal(security.sameOrigin(req, "https://arcadia.example"), true);
    assert.equal(security.sameOrigin(req, "https://evil.example"), false);
    const headers = {}; security.headers(req, { setHeader: (k, v) => { headers[k] = v; } }, () => {});
    assert.ok(headers["Content-Security-Policy"].includes("script-src 'self'"));
});
test("session revocation disconnects every socket for only the affected user", () => {
    const { sessionSockets, disconnectUserSockets } = require("../src/middleware/auth");
    const disconnected = [];
    sessionSockets.set(1001, new Set([{ disconnect: (force) => disconnected.push(force) }, { disconnect: (force) => disconnected.push(force) }]));
    sessionSockets.set(1002, new Set([{ disconnect: () => { throw new Error("Wrong user disconnected"); } }]));
    disconnectUserSockets(1001);
    assert.deepEqual(disconnected, [true, true]);
    assert.equal(sessionSockets.has(1001), false);
    assert.equal(sessionSockets.has(1002), true);
    sessionSockets.delete(1002);
});
test.after(() => { pool.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
