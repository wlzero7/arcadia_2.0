const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FakeIO, invoke, gameBalance } = require("./support.cjs");
const directory = process.env.ARCADIA_TEST_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-capital-trumps-"));
process.env.DB_PATH = path.join(directory, "test.db");
if (process.env.ARCADIA_LIBSQL_TEST === "1") {
    process.env.NODE_ENV = "test";
    process.env.TURSO_DATABASE_URL = require("node:url").pathToFileURL(process.env.DB_PATH).href;
    process.env.TURSO_AUTH_TOKEN = "";
}
const rng = require("../src/services/random");
const nativeRandom = rng.random;
let chance = null;
rng.random = () => chance ?? nativeRandom();
const pool = require("../src/config/database");
const bj = require("../src/services/blackjack");
const rounds = require("../src/services/rounds");
const solo = require("../src/routes/blackjack.routes");
const duel = require("../src/realtime/duels");
const mp = require("../src/realtime/blackjack-mp");
const store = require("../src/services/realtimeStore");
let sequence = 0;
const controllers = [];
const card = (rank) => ({ rank: String(rank), suit: bj.SUITS[0] });
function user() {
    const name = "capital" + ++sequence;
    return pool.db.run("INSERT INTO users(username,email,password_hash) VALUES(?,?,'test')", [name, name + "@example.test"]).lastInsertRowid;
}
function hand() { return { ...bj.createHand(), player: [card(8), card(10)], dealer: [card(7), card(8)], deck: [card(2), card(3)], nrg: 10 }; }
function inventorySize(id) { return pool.db.get("SELECT COUNT(*) AS n FROM blackjack_cards WHERE user_id=?", [id]).n; }
function room(capital = 1000, game = "blackjack", start = true) {
    const a = user(), b = user(), io = new FakeIO();
    controllers.push(duel.setupDuels(io));
    const p1 = io.connect(a, "Alice"), p2 = io.connect(b, "Bob");
    const created = p1.call("duel:create").duel;
    p2.call("duel:join", { code: created.code });
    assert.equal(p1.call("duel:ready", { capital }).ok, true);
    assert.equal(p2.call("duel:ready", { capital }).ok, true);
    const state = duel.duels.get(created.code);
    const idx = state.auction.findIndex((s) => s.game === game);
    p1.call("duel:bid", { gameIdx: idx, amount: 10 });
    if (start) { state.auctionEndsAt = Date.now() - 1; assert.equal(p1.call("duel:sync").ok, true); }
    return { a, b, io, p1, p2, state, idx };
}
function table() {
    const a = user(), b = user(), io = new FakeIO();
    const { tables } = mp.setupBlackjackMultiplayer(io);
    const p1 = io.connect(a), p2 = io.connect(b), code = p1.call("bj:create").table.code;
    p2.call("bj:join", { code });
    p1.call("bj:bet", { amount: 100 }); p2.call("bj:bet", { amount: 100 }); p1.call("bj:start");
    const state = tables.get(code);
    Object.assign(state.players.get(a), { hand: [card(8), card(10)], nrg: 10 });
    state.players.get(b).hand = [card(7), card(8)];
    state.deck = [card(2), card(3)];
    return { a, b, io, p1, p2, state, tables };
}
test("auction starts on both ready, cannot end early, selects highest bid and persists capital", () => {
    const r = room(1000, "dice", false);
    assert.equal(r.state.phase, "auction");
    assert.ok(r.state.auctionEndsAt - Date.now() > 24000);
    assert.equal(r.p1.call("duel:choose", { gameIdx: r.idx }).ok, false);
    assert.equal(r.p2.call("duel:bid", { gameIdx: 1, amount: 100 }).ok, true);
    assert.equal(r.p1.call("duel:bid", { gameIdx: 0, amount: 991 }).ok, false);
    r.state.auctionEndsAt = Date.now() - 1;
    assert.equal(r.p1.call("duel:bid", { gameIdx: 0, amount: 110 }).ok, false);
    r.p1.call("duel:sync");
    assert.equal(r.state.chosenGame, "coinflip"); assert.equal(r.state.turn, "p2");
    assert.equal(r.state.players.p2.battleBalance, 900);
    assert.equal(store.load("duel").get(r.state.code).players.p1.entryBalance, 1000);
    assert.equal(gameBalance(r.b, "duel"), 999900);
    r.p1.call("duel:sync"); assert.equal(gameBalance(r.b, "duel"), 999900);
    r.p1.call("duel:leave");
});
test("server timer closes the auction without polling, including restored deadlines", async () => {
    const r = room(1000, "dice", false);
    r.state.auctionEndsAt = Date.now() + 30;
    r.p1.call("duel:sync");
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(r.state.phase, "playing"); assert.equal(r.state.chosenGame, "dice");
    r.p1.call("duel:leave");
    const restored = room(1000, "dice", false);
    restored.state.auctionEndsAt = Date.now() - 1;
    store.save("duel", restored.state);
    controllers.at(-1).close();
    const saved = store.load("duel").get(restored.state.code);
    duel.duels.set(saved.code, saved);
    controllers.push(duel.setupDuels(new FakeIO()));
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(saved.phase, "playing"); assert.equal(saved.players.p1.battleBalance, 990);
    restored.p1.call("duel:leave");
});
test("battle All Win cannot consume the protected wallet or rewards received mid-battle", () => {
    const r = room(1000, "mines");
    const wallet = pool.getWalletSync(r.a, "duel");
    pool.adjustBalanceSync(wallet.id, 500, "payout", "mission", "test");
    assert.equal(r.p1.call("duel:play", { wager: 991, choice: { mines: 5 } }).ok, false);
    assert.equal(r.p1.call("duel:play", { allWin: true, choice: { mines: 5 } }).ok, true);
    assert.equal(r.state.activePlay.wager, 990);
    r.p1.call("duel:pick", { cell: r.state.activePlay.mines[0] });
    assert.equal(r.state.phase, "finished"); assert.equal(r.state.players.p1.battleBalance, 0);
    assert.equal(gameBalance(r.a, "duel"), 999000);
    assert.ok(pool.getWalletSync(r.a, "duel").balance >= 999500);
});
test("capital validation and transaction failure preserve ready flags, wallets and logs", () => {
    const r = room(1000, "dice", false), prior = structuredClone(r.state), original = pool.db.run;
    r.state.auctionEndsAt = Date.now() - 1;
    const before = structuredClone(r.state), balance = gameBalance(r.a, "duel"), messages = r.io.messages.length;
    pool.db.run = function(sql, ...args) { if (sql.includes("INSERT INTO realtime_sessions")) throw new Error("Test rollback"); return original.call(this, sql, ...args); };
    try { assert.equal(r.p1.call("duel:sync").ok, false); } finally { pool.db.run = original; }
    assert.deepEqual(r.state, before); assert.equal(gameBalance(r.a, "duel"), balance); assert.equal(r.io.messages.length, messages);
    r.state.auctionEndsAt = prior.auctionEndsAt; r.p1.call("duel:leave");
});
const expected = { renew: "epica", perfect_play: "lendaria", loving: "lendaria", double_opponent: "cromatica", recovery: "cromatica", profit_double: "super_rara", plus_one: "epica" };
for (const [key, rarity] of Object.entries(expected)) for (const mode of ["solo", "duel", "coop"]) {
    test(`${mode}: ${key} is disposable, has ${rarity} rarity and applies authoritative effect`, () => {
        chance = .99;
        const r = mode === "duel" ? room() : mode === "coop" ? table() : { a: user() };
        let state;
        if (mode === "solo") { rounds.startRound(r.a, "blackjack", 100, hand()); state = rounds.getSession(r.a, "blackjack"); }
        if (mode === "duel") {
            assert.equal(r.p1.call("duel:play", { wager: 100 }).ok, true);
            Object.assign(r.state.activePlay, hand(), { pvp: true, dealerNrg: 10 }); state = r.state.activePlay;
        }
        if (mode === "coop") state = r.state;
        bj.addCard(r.a, key);
        if (mode === "coop") r.p1.call("bj:join", { code: state.code });
        const before = inventorySize(r.a);
        const response = mode === "solo" ? invoke(solo, "/blackjack/special", r.a, { cardKey: key })
            : r.p1.call(mode === "duel" ? "duel:special" : "bj:special", { cardKey: key, targetId: r.b });
        assert.equal(mode === "solo" ? response.status : response.ok, mode === "solo" ? 200 : true);
        if (mode === "solo") state = rounds.getSession(r.a, "blackjack");
        const me = mode === "coop" ? state.players.get(r.a) : state;
        const own = mode === "coop" ? me.hand : state.player;
        const other = mode === "coop" ? state.players.get(r.b).hand : state.dealer;
        if (key === "renew") assert.equal(own.length, 2);
        if (key === "perfect_play") assert.equal(bj.total(own), 21);
        if (key === "loving") assert.equal(bj.total(other), 21);
        if (key === "double_opponent") {
            if (mode === "duel") assert.equal(r.state.lastPlay.detail.dealerTotal, 30);
            else assert.equal(mode === "coop" ? state.players.get(r.b).factor : state.dealerFactor, 2);
        }
        if (key === "recovery") assert.equal(me.recovery, true);
        if (key === "profit_double") assert.equal(me.profitDouble, true);
        assert.equal(inventorySize(r.a), before + (key === "plus_one" ? 1 : -1));
        assert.equal(bj.SPECIAL_CARDS[key].rarity, rarity);
        if (mode === "duel") r.p1.call("duel:leave");
        if (mode === "coop") r.tables.delete(state.code);
        chance = null;
    });
}
test("Solo recovery keeps the original escrow, restarts without XP and pays doubled profit once", () => {
    chance = .99;
    const id = user(); rounds.startRound(id, "blackjack", 100, hand()); bj.addCard(id, "recovery");
    invoke(solo, "/blackjack/special", id, { cardKey: "recovery" });
    let state = rounds.getSession(id, "blackjack"); state.player = [card(10), card(10)]; state.deck = [card(10)]; rounds.saveSession(id, "blackjack", state);
    const before = gameBalance(id), result = invoke(solo, "/blackjack/hit", id);
    assert.equal(result.active, true); assert.equal(result.restarted, 1); assert.equal(result.wager, 100); assert.equal(gameBalance(id), before);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?", [id]).n, 0);
    state = rounds.getSession(id, "blackjack"); Object.assign(state, hand(), { dealer: [card(10), card(7)] }); rounds.saveSession(id, "blackjack", state);
    bj.addCard(id, "profit_double"); invoke(solo, "/blackjack/special", id, { cardKey: "profit_double" });
    const win = invoke(solo, "/blackjack/stand", id); assert.equal(win.payout, 300);
    assert.equal(invoke(solo, "/blackjack/stand", id).status, 400); chance = null;
});
test("perfect trumps always target 21 and bust under limit 17, including soft aces", () => {
    const id = user(), state = { ...hand(), player: [card("A"), card(7)], dealer: [card(8), card(10)], limit: 17 };
    bj.addCard(id, "perfect_play"); bj.useSpecial(id, state, { cardKey: "perfect_play" });
    assert.equal(bj.total(state.player, 17), 21); assert.equal(bj.result({ ...state, wager: 100 }).outcome, "loss");
});
test("Duel Blackjack uses two human turns, records both players and caps transfer at battle funds", () => {
    chance = .99; const r = room();
    r.p1.call("duel:play", { wager: 100 }); Object.assign(r.state.activePlay, hand(), { dealer: [card(10), card(7)] });
    assert.equal(r.p2.call("duel:hit").ok, false);
    assert.equal(r.p1.call("duel:stand").ok, true); assert.equal(r.state.turn, "p2"); assert.ok(r.state.activePlay);
    assert.equal(r.p2.call("duel:stand").ok, true); assert.equal(r.state.activePlay, null);
    assert.equal(r.state.lastPlay.transfer, 100);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (?,?)", [r.a, r.b]).n, 2);
    assert.equal(gameBalance(r.a, "duel") + gameBalance(r.b, "duel"), 1999990);
    assert.equal(r.p2.call("duel:stand").ok, false); r.p1.call("duel:leave"); chance = null;
});
test("Duel recovery resets both hands and preserves wager, wallets and player energy", () => {
    chance = .99; const r = room(); r.p1.call("duel:play", { wager: 100 }); Object.assign(r.state.activePlay, hand());
    bj.addCard(r.a, "recovery"); r.p1.call("duel:special", { cardKey: "recovery" });
    r.state.activePlay.player = [card(10), card(10)]; r.state.activePlay.deck = [card(10)];
    const before = gameBalance(r.a, "duel") + gameBalance(r.b, "duel");
    assert.equal(r.p1.call("duel:hit").result.restarted, true); assert.equal(r.state.activePlay.restarted, 1);
    assert.equal(r.state.activePlay.wager, 100); assert.equal(r.state.activePlay.recovery, false); assert.equal(r.state.turn, "p1");
    assert.equal(gameBalance(r.a, "duel") + gameBalance(r.b, "duel"), before); r.p1.call("duel:leave"); chance = null;
});
test("Coop recovery retains the pot and no settlement; double charges only the authorized player", () => {
    chance = .99; const r = table(); bj.addCard(r.a, "recovery"); r.p1.call("bj:join", { code: r.state.code }); r.p1.call("bj:special", { cardKey: "recovery" });
    r.state.players.get(r.a).hand = [card(10), card(6)]; r.state.players.get(r.b).hand = [card(10), card(8)];
    r.p1.call("bj:stand"); r.p2.call("bj:stand"); assert.equal(r.state.phase, "playing"); assert.equal(r.state.pot, 200);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (?,?)", [r.a, r.b]).n, 0);
    const before = gameBalance(r.a, "coop"); r.state.players.get(r.a).hand = [card(2), card(3)]; r.state.deck = [card(2)];
    assert.equal(r.p1.call("bj:double").ok, true); assert.equal(r.state.pot, 300); assert.equal(gameBalance(r.a, "coop"), before - 100);
    assert.equal(r.p1.call("bj:double").ok, false); r.tables.delete(r.state.code); chance = null;
});
test("each valid hit, stand and double rolls exactly 50%; invalid actions never drop", () => {
    const id = user(); rounds.startRound(id, "blackjack", 100, hand());
    chance = .5; invoke(solo, "/blackjack/hit", id); assert.equal(inventorySize(id), 0);
    chance = .499; invoke(solo, "/blackjack/stand", id); assert.equal(inventorySize(id), 1);
    assert.equal(invoke(solo, "/blackjack/stand", id).status, 400); assert.equal(inventorySize(id), 1);
    rounds.startRound(id, "blackjack", 100, { ...hand(), dealer: [card(10), card(7)] });
    invoke(solo, "/blackjack/double", id); assert.equal(inventorySize(id), 2); chance = null;
});
test("human mirror reflects a received attack and shield blocks it exactly once", () => {
    const a = user(), b = user(), state = { ...hand(), pvp: true, dealerNrg: 10 };
    bj.addCard(a, "force_hit"); bj.useSpecial(a, state, { cardKey: "force_hit" });
    assert.equal(state.dealer.length, 3);
    const other = bj.orient(state, true); bj.addCard(b, "mirror");
    bj.useSpecial(b, other, { cardKey: "mirror" }); assert.equal(state.player.length, 3); assert.equal(state.dealerLastAttack, null);
    state.dealerShield = true; bj.addCard(a, "double_opponent"); state.nrg = 10;
    bj.useSpecial(a, state, { cardKey: "double_opponent" }); assert.equal(state.dealerFactor, undefined); assert.equal(state.dealerShield, false);
});
test("legacy ready, auction and playing duels migrate once without charging protected money", () => {
    for (const phase of ["ready", "auction", "playing"]) {
        const r = room(1000, "blackjack", phase === "playing");
        r.state.phase = phase; delete r.state.capitalVersion; delete r.state.auctionEndsAt;
        for (const p of Object.values(r.state.players)) { delete p.entryBalance; delete p.battleBalance; }
        const before = gameBalance(r.a, "duel") + gameBalance(r.b, "duel");
        controllers.push(duel.setupDuels(new FakeIO()));
        assert.equal(r.state.capitalVersion, 2);
        assert.equal(r.state.players.p1.battleBalance, phase === "ready" ? 1000000 : phase === "playing" ? 990 : 1000);
        if (phase !== "playing") assert.ok(r.state.auctionEndsAt - Date.now() > 24000);
        assert.equal(gameBalance(r.a, "duel") + gameBalance(r.b, "duel"), before);
        const snapshot = structuredClone(r.state);
        controllers.push(duel.setupDuels(new FakeIO())); assert.deepEqual(r.state, snapshot);
        assert.equal(store.load("duel").get(r.state.code).capitalVersion, 2); r.p1.call("duel:leave");
    }
});
test("second human recovery restarts without a transfer or statistics", () => {
    chance = .99; const r = room(); r.p1.call("duel:play", { wager: 100 });
    Object.assign(r.state.activePlay, hand(), { dealerNrg: 10, player: [card(10), card(9)], dealer: [card(8), card(8)] });
    r.p1.call("duel:stand"); bj.addCard(r.b, "recovery");
    assert.equal(r.p2.call("duel:special", { cardKey: "recovery" }).ok, true);
    const before = gameBalance(r.b, "duel");
    assert.equal(r.p2.call("duel:stand").result.restarted, true);
    assert.equal(gameBalance(r.b, "duel"), before); assert.equal(r.state.turn, "p1");
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (?,?)", [r.a, r.b]).n, 0);
    assert.equal(inventorySize(r.b), 0); r.p1.call("duel:leave"); chance = null;
});
test("second human doubled profit is capped, audited for both sides, and cannot settle twice", () => {
    chance = .99; const r = room(); r.state.players.p1.battleBalance = 150;
    r.p1.call("duel:play", { wager: 100 }); Object.assign(r.state.activePlay, hand(), { dealerNrg: 10, player: [card(8), card(8)], dealer: [card(10), card(9)] });
    r.p1.call("duel:stand"); bj.addCard(r.b, "profit_double"); r.p2.call("duel:special", { cardKey: "profit_double" });
    const a = gameBalance(r.a, "duel"), b = gameBalance(r.b, "duel");
    const start = performance.now(), result = r.p2.call("duel:stand").result;
    assert.ok(performance.now() - start < 2500, "local settlement budget");
    assert.equal(result.payout, 250); assert.equal(r.state.lastPlay.playerKey, "p2");
    assert.equal(gameBalance(r.a, "duel"), a - 150); assert.equal(gameBalance(r.b, "duel"), b + 150);
    assert.equal(r.state.players.p1.battleBalance, 0);
    const bets = pool.db.all("SELECT user_id,wager,payout,outcome,detail FROM bets WHERE user_id IN (?,?) ORDER BY id", [r.a, r.b]);
    assert.equal(bets.length, 2); assert.equal(bets[0].outcome, "win"); assert.equal(JSON.parse(bets[0].detail).profitDouble, true);
    assert.equal(bets[1].wager - bets[1].payout, 150); assert.equal(bets[1].outcome, "loss");
    assert.equal(r.p2.call("duel:stand").ok, false); chance = null;
});
test("human ties and both busts transfer no coins; all-win flags follow each human", () => {
    chance = .99;
    for (const total of [18, 24]) {
        const r = room(); r.state.players.p1.battleBalance = 100; r.state.players.p2.battleBalance = 200;
        r.p1.call("duel:play", { allWin: true });
        Object.assign(r.state.activePlay, hand(), { player: [card(total / 2), card(total / 2)], dealer: [card(total / 2), card(total / 2)] });
        const before = gameBalance(r.a, "duel") + gameBalance(r.b, "duel");
        r.p1.call("duel:stand"); if (r.state.activePlay) r.p2.call("duel:stand");
        assert.equal(r.state.lastPlay.transfer, 0); assert.equal(gameBalance(r.a, "duel") + gameBalance(r.b, "duel"), before);
        const bets = pool.db.all("SELECT user_id,detail FROM bets WHERE user_id IN (?,?)", [r.a, r.b]);
        assert.equal(JSON.parse(bets.find((bet) => bet.user_id === r.a).detail).allWin, true);
        assert.equal(JSON.parse(bets.find((bet) => bet.user_id === r.b).detail).allWin, false); r.p1.call("duel:leave");
    }
    const r = room(); r.state.players.p1.battleBalance = 100; r.state.players.p2.battleBalance = 200;
    r.p1.call("duel:play", { allWin: true }); Object.assign(r.state.activePlay, hand(), { player: [card(8), card(8)], dealer: [card(10), card(9)] });
    r.p1.call("duel:stand"); r.p2.call("duel:stand");
    const bets = pool.db.all("SELECT user_id,detail FROM bets WHERE user_id IN (?,?)", [r.a, r.b]);
    assert.equal(JSON.parse(bets.find((bet) => bet.user_id === r.a).detail).allWin, true);
    assert.equal(JSON.parse(bets.find((bet) => bet.user_id === r.b).detail).allWin, false); chance = null;
});
test("Coop doubled profit is explicit in the ledger and settlement remains idempotent", () => {
    chance = .99; const r = table(); bj.addCard(r.a, "profit_double"); r.p1.call("bj:join", { code: r.state.code });
    r.p1.call("bj:special", { cardKey: "profit_double" });
    r.p1.call("bj:stand"); r.p2.call("bj:stand");
    assert.equal(r.state.pot, 0); assert.equal(gameBalance(r.a, "coop"), 1000200); assert.equal(gameBalance(r.b, "coop"), 999900);
    const bet = pool.db.get("SELECT payout,detail FROM bets WHERE user_id=?", [r.a]);
    assert.equal(bet.payout, 300); assert.equal(JSON.parse(bet.detail).profitDouble, true);
    assert.equal(r.p2.call("bj:stand").ok, false); assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?", [r.a]).n, 1);
    r.tables.delete(r.state.code); chance = null;
});
for (const mode of ["duel", "coop"]) for (const action of ["hit", "stand", "double"]) {
    test(`${mode}: accepted ${action} drops once at the 50% boundary, rejected actions never drop`, () => {
        for (const probability of [.5, .499]) {
            chance = .99; const r = mode === "duel" ? room() : table();
            if (mode === "duel") { r.p1.call("duel:play", { wager: 100 }); Object.assign(r.state.activePlay, hand()); }
            const prefix = mode === "duel" ? "duel:" : "bj:";
            chance = probability; const response = r.p1.call(prefix + action);
            assert.equal(response.ok, true); assert.equal(inventorySize(r.a), probability < .5 ? 1 : 0);
            const wrong = action === "hit" ? r.p2 : r.p1;
            assert.equal(wrong.call(prefix + action).ok, false);
            assert.equal(inventorySize(wrong === r.p1 ? r.a : r.b), wrong === r.p1 && probability < .5 ? 1 : 0);
            if (mode === "duel") r.p1.call("duel:leave"); else r.tables.delete(r.state.code);
        }
        chance = null;
    });
}
test("failed create and join leave no ghost duel or membership", () => {
    const a = user(), b = user(), io = new FakeIO(); controllers.push(duel.setupDuels(io));
    const p1 = io.connect(a), p2 = io.connect(b), count = duel.duels.size, original = pool.db.run;
    const fail = function(sql, ...args) { if (sql.includes("INSERT INTO realtime_sessions")) throw new Error("Test failure"); return original.call(this, sql, ...args); };
    pool.db.run = fail;
    try { assert.equal(p1.call("duel:create").ok, false); assert.equal(duel.duels.size, count); assert.equal(p1.data.duelCode, null); }
    finally { pool.db.run = original; }
    const created = p1.call("duel:create").duel; const state = duel.duels.get(created.code);
    pool.db.run = fail;
    try { assert.equal(p2.call("duel:join", { code: state.code }).ok, false); assert.equal(state.players.p2, null); assert.equal(p2.data.duelCode, null); }
    finally { pool.db.run = original; }
    p1.call("duel:leave");
});
test("a delivery failure after commit cannot restore an already settled round", () => {
    chance = .99; const r = room(); r.p1.call("duel:play", { wager: 100 });
    Object.assign(r.state.activePlay, hand(), { dealer: [card(10), card(7)] }); r.p1.call("duel:stand");
    const before = gameBalance(r.a, "duel"), original = r.io.to, originalError = console.error;
    r.io.to = () => ({ emit() { throw new Error("Test delivery outage"); } }); console.error = () => {};
    try { assert.equal(r.p2.call("duel:stand").ok, true); } finally { r.io.to = original; console.error = originalError; }
    assert.equal(r.state.activePlay, null); assert.equal(gameBalance(r.a, "duel"), before + 100);
    assert.equal(r.p2.call("duel:stand").ok, false);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (?,?)", [r.a, r.b]).n, 2);
    r.p1.call("duel:leave"); chance = null;
});
test("PVP batches both ledger movements and both round records in a single settlement", () => {
    chance = .99; const r = room(); r.p1.call("duel:play", { wager: 100 });
    Object.assign(r.state.activePlay, hand(), { dealer: [card(10), card(7)] }); r.p1.call("duel:stand");
    const original = pool.db.batch, batches = [], methods = Object.fromEntries(["get", "all", "run"].map((key) => [key, pool.db[key]]));
    let requests = 0;
    for (const [key, method] of Object.entries(methods)) pool.db[key] = (...args) => { requests++; return method.call(pool.db, ...args); };
    pool.db.batch = function(entries) {
        requests++; batches.push(entries);
        return original ? original.call(this, entries) : entries.map(({ method = "run", sql, params = [] }) => methods[method].call(pool.db, sql, params));
    };
    try { assert.equal(r.p2.call("duel:stand").ok, true); } finally {
        Object.assign(pool.db, methods); if (original) pool.db.batch = original; else delete pool.db.batch;
    }
    assert.equal(batches.filter((entries) => entries.filter((entry) => entry.sql.includes("INSERT INTO bets")).length === 2).length, 1);
    assert.equal(batches.filter((entries) => entries.filter((entry) => entry.sql.includes("INSERT INTO transactions")).length === 2).length, 1);
    assert.ok(requests <= 25, "Remote-style requests: " + requests);
    r.p1.call("duel:leave"); chance = null;
});
test("failed Mais um rolls back consumption, extra cards, energy and memory", () => {
    chance = .99; const r = room(); r.p1.call("duel:play", { wager: 100 }); bj.addCard(r.a, "plus_one");
    const before = structuredClone(r.state), original = pool.db.run; let inserts = 0;
    pool.db.run = function(sql, ...args) {
        if (sql.includes("INSERT INTO blackjack_cards") && ++inserts === 2) throw new Error("Test second card failure");
        return original.call(this, sql, ...args);
    };
    try { assert.equal(r.p1.call("duel:special", { cardKey: "plus_one" }).ok, false); } finally { pool.db.run = original; }
    assert.deepEqual(r.state, before); assert.equal(inventorySize(r.a), 1);
    assert.equal(r.p1.call("duel:special", { cardKey: "plus_one" }).ok, true); assert.equal(inventorySize(r.a), 2);
    r.p1.call("duel:leave"); chance = null;
});
test("Coop recovery with all reconnect windows expired does not strand the pot", () => {
    chance = .99; const r = table(); bj.addCard(r.a, "recovery"); r.p1.call("bj:join", { code: r.state.code });
    r.p1.call("bj:special", { cardKey: "recovery" });
    r.state.players.get(r.a).hand = [card(10), card(6)]; r.state.players.get(r.b).hand = [card(10), card(8)];
    for (const p of r.state.players.values()) { p.socketIds.clear(); p.reconnectUntil = 0; }
    assert.equal(r.p1.call("bj:stand").ok, true); assert.equal(r.state.phase, "finished"); assert.equal(r.state.pot, 0);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (?,?)", [r.a, r.b]).n, 2);
    assert.equal(gameBalance(r.a, "coop") + gameBalance(r.b, "coop"), 2000000);
    r.tables.delete(r.state.code); chance = null;
});
test.after(() => {
    controllers.forEach((c) => c.close()); pool.db.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    if (!process.env.ARCADIA_TEST_DIRECTORY) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
