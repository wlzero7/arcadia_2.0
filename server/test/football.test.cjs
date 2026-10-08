const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { invoke, FakeIO, gameBalance } = require("./support.cjs");
const directory = process.env.ARCADIA_TEST_DIRECTORY || fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-football-"));
process.env.DB_PATH = path.join(directory, "test.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
if (process.env.ARCADIA_LIBSQL_TEST === "1") {
    process.env.NODE_ENV = "test";
    process.env.TURSO_DATABASE_URL = require("node:url").pathToFileURL(process.env.DB_PATH).href;
}
const pool = require("../src/config/database");
const catalog = require("../src/services/football-catalog");
const football = require("../src/services/football");
const clubs = require("../src/services/football-clubs");
const { router } = require("../src/routes/football.routes");
const rounds = require("../src/services/rounds");
const { setupDuels, duels } = require("../src/realtime/duels");
const { setupMultiplayer, rooms, roomSummary, hydrateRooms } = require("../src/realtime/rooms");
let n = 0;
function user() {
    const name = "football" + ++n;
    return pool.db.run("INSERT INTO users(username,email,password_hash) VALUES(?,?,'test')", [name, name + "@example.test"]).lastInsertRowid;
}
const choice = { home: "aurora", away: "bairro", picked: "home" };
function body(id, investment = 0) {
    const club = clubs.get(id);
    return { revision: club.revision, teamId: club.teamId, players: club.lineup.map((id) => ({ id, investment })) };
}
test("football has 14 fictional teams, 154 unique players and valid numbered 11-player squads", () => {
    assert.equal(catalog.TEAMS.length, 14);
    assert.equal(new Set(catalog.PLAYERS.map((p) => p.name)).size, 154);
    assert.equal(new Set(catalog.PLAYERS.map((p) => p.lastName.toLowerCase())).size, 154);
    for (const player of catalog.PLAYERS) assert.equal(player.shirtName, player.lastName.toUpperCase());
    assert.ok(catalog.PLAYERS.some(p => p.name === "Ren Takahara"));
    assert.ok(catalog.PLAYERS.some(p => p.name === "Kwame Agyeman"));
    assert.ok(catalog.PLAYERS.some(p => p.name === "Noah Whitfield"));
    for (const team of catalog.TEAMS) {
        assert.equal(team.players.length, 11);
        assert.deepEqual(team.players.map((p) => p.position), catalog.POSITIONS);
        assert.deepEqual(team.players.map((p) => p.number), Array.from({ length: 11 }, (_, i) => i + 1));
    }
});
test("football prices reward underdogs, keep their chance meaningful and never offer positive expected return", () => {
    const market = football.market(catalog.team("aurora"), catalog.team("bairro"));
    assert.ok(market.probabilities.away >= .2);
    assert.ok(market.odds.away > market.odds.home);
    assert.ok(Math.abs(Object.values(market.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-12);
    for (const picked of ["home", "draw", "away"]) assert.ok(market.odds[picked] * market.probabilities[picked] <= .96);
    assert.throws(() => football.create({ ...choice, away: "aurora" }, 10), /diferentes/);
    assert.throws(() => football.create({ ...choice, picked: "hack" }, 10), /Escolha/);
    assert.throws(() => football.create(choice, Number.MAX_SAFE_INTEGER), /limite seguro/);
});
test("the private outcome matches the goals, while live snapshots hide every future event and result", () => {
    for (const roll of [.01, .7, .99]) {
        const match = football.createMatch(catalog.team("aurora"), catalog.team("bairro"), "home", 100, () => roll, 1000);
        const start = football.publicMatch(match, 1000);
        for (const secret of ["timeline", "finalScore", "winner", "payout"]) assert.equal(start[secret], undefined);
        assert.ok(start.events.every((event) => event.at === 0));
        const final = football.result(match);
        assert.deepEqual(final.score, match.finalScore);
        assert.equal(final.minute, 90);
        assert.equal(final.winner, match.winner);
        assert.equal(final.payout, match.payout);
    }
});
test("club investments charge only their increment, persist per player and reject refund, stale revision or duplicates", () => {
    const id = user(), before = gameBalance(id, "duel");
    assert.equal(clubs.get(id).team.strength, 45);
    const saved = clubs.save(id, body(id, 1000));
    assert.equal(saved.charged, 11000);
    assert.equal(gameBalance(id, "duel"), before - 11000);
    assert.ok(saved.team.strength > 45);
    assert.equal(clubs.save(id, body(id, 1000)).charged, 0);
    assert.throws(() => clubs.save(id, body(id, 999)), /reduzido/);
    const bad = body(id, 1000); bad.players[1] = bad.players[0];
    assert.throws(() => clubs.save(id, bad), /diferentes/);
    const stale = body(id, 1000); stale.revision--;
    assert.throws(() => clubs.save(id, stale), /desatualizado/);
    const invalid = body(id, 1000); invalid.players[0] = { id: invalid.players[1].id, investment: 1000 }; invalid.players[1] = { id: "player-12", investment: 0 };
    assert.throws(() => clubs.save(id, invalid), /posicao/);
    assert.throws(() => clubs.save(id, body(id, 1000000)), /insuficiente/);
    assert.equal(gameBalance(id, "duel"), before - 11000);
    assert.equal(pool.getWalletSync(id, "solo").balance, 1000000);
});
test("club ledger or database failures roll back money and the whole roster", () => {
    const id = user(), before = clubs.get(id);
    pool.db.exec("CREATE TRIGGER fail_club BEFORE INSERT ON football_clubs BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.throws(() => clubs.save(id, body(id, 1000)), /fixture/);
    pool.db.exec("DROP TRIGGER fail_club");
    assert.deepEqual(clubs.get(id), before);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM transactions WHERE ref_type='football_training' AND wallet_id=?", [pool.getWalletSync(id, "duel").id]).n, 0);
});
test("Solo locks the wager, persists live state, settles once and restores the final receipt", () => {
    const id = user(), before = gameBalance(id);
    const started = invoke(router, "/start", id, { wager: 100, choice });
    assert.equal(started.status, 200);
    assert.equal(gameBalance(id), before - 100);
    assert.equal(started.match.winner, undefined);
    assert.equal(invoke(router, "/start", id, { wager: 100, choice }).status, 400);
    const play = rounds.getSession(id, "football");
    play.startedAt -= play.durationMs + 1;
    pool.db.run("UPDATE game_sessions SET state=? WHERE user_id=? AND game='football'", [JSON.stringify(play), id]);
    const settled = invoke(router, "/state", id, {}, "get");
    assert.equal(settled.active, false);
    assert.equal(gameBalance(id), before - 100 + play.payout);
    assert.deepEqual(invoke(router, "/state", id, {}, "get").match, settled.match);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?", [id]).n, 1);
    assert.equal(rounds.getSession(id, "football"), null);
});
test("Solo failed settlement retains pending match, balance and receipt atomically", () => {
    const id = user();
    invoke(router, "/start", id, { wager: 100, choice });
    const play = rounds.getSession(id, "football"); play.startedAt -= 40000;
    pool.db.run("UPDATE game_sessions SET state=? WHERE user_id=? AND game='football'", [JSON.stringify(play), id]);
    const before = gameBalance(id);
    pool.db.exec("CREATE TRIGGER fail_football_receipt BEFORE INSERT ON football_results BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.equal(invoke(router, "/state", id, {}, "get").status, 503);
    pool.db.exec("DROP TRIGGER fail_football_receipt");
    assert.equal(gameBalance(id), before);
    assert.ok(rounds.getSession(id, "football"));
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?", [id]).n, 0);
    assert.equal(invoke(router, "/state", id, {}, "get").status, 200);
});
test("sixteen concurrent active Solo matches keep separate escrows and settle once", () => {
    const ids=Array.from({length:16},user),started=performance.now();
    for(const id of ids)assert.equal(invoke(router,"/start",id,{wager:123,choice}).status,200);
    const matches=ids.map(id=>rounds.getSession(id,"football"));
    assert.equal(new Set(matches.map(match=>match.id)).size,16);
    for(const [index,id] of ids.entries()){
        assert.equal(gameBalance(id),1000000-123);
        const play=matches[index];play.startedAt-=40000;
        pool.db.run("UPDATE game_sessions SET state=? WHERE user_id=? AND game='football'",[JSON.stringify(play),id]);
    }
    for(const [index,id] of ids.entries()){
        assert.equal(invoke(router,"/state",id,{},"get").active,false);
        assert.equal(invoke(router,"/state",id,{},"get").active,false);
        assert.equal(gameBalance(id),1000000-123+matches[index].payout);
        assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?",[id]).n,1);
    }
    assert.ok(performance.now()-started<15000,"local settlement load exceeded safety budget");
});
test("Coop football escrows the pot, hides the outcome, survives hydration and settles without clients", async () => {
    const a = user(), b = user(), io = new FakeIO(), control = setupMultiplayer(io);
    const p1 = io.connect(a), p2 = io.connect(b);
    const created = p1.call("room:create", { game: "football" });
    assert.equal(created.ok, true);
    const code = created.room.code;
    p2.call("room:join", { code });
    p1.call("room:stake", { amount: 1000 }); p2.call("room:stake", { amount: 1000 });
    assert.equal(p1.call("room:play", { wager: 100, choice }).ok, true);
    let room = rooms.get(code);
    assert.equal(room.pot, 1900);
    assert.equal(roomSummary(room).activePlay.winner, undefined);
    assert.equal(p1.call("room:cashout").ok, false);
    assert.equal(p2.call("room:play", { wager: 100, choice }).ok, false);
    assert.equal(p1.call("room:withdraw").ok, false);
    const payout = room.activePlay.payout;
    hydrateRooms(); room = rooms.get(code);
    assert.equal(room.activePlay.game, "football");
    room.activePlay.startedAt -= 40000;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(room.activePlay, null);
    assert.equal(room.pot, 1900 + payout);
    assert.equal([...room.stakes.values()].reduce((a, b) => a + b, 0), room.pot);
    assert.equal(room.history.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(room.history.length, 1);
    control.close();
});
test("Duel uses both frozen clubs, protects turns and settles exactly once on authoritative time", () => {
    const a = user(), b = user(), io = new FakeIO();
    clubs.save(a, body(a, 1000));
    const control = setupDuels(io);
    const p1 = io.connect(a), p2 = io.connect(b);
    const created = p1.call("duel:create").duel;
    p2.call("duel:join", { code: created.code });
    p1.call("duel:ready"); p2.call("duel:ready"); p1.call("duel:ready");
    const index = duels.get(created.code).auction.findIndex((slot) => slot.game === "football");
    p1.call("duel:bid", { gameIdx: index, amount: 10 });
    duels.get(created.code).auctionEndsAt = Date.now() - 1;
    assert.equal(p1.call("duel:choose", { gameIdx: index }).ok, true);
    const duel = duels.get(created.code), before = gameBalance(a, "duel") + gameBalance(b, "duel");
    assert.equal(p1.call("duel:play", { wager: 100, choice: { picked: "away" } }).active, true);
    assert.equal(duel.activePlay.picked, "home");
    assert.ok(duel.activePlay.home.strength > duel.activePlay.away.strength);
    assert.equal(invoke(router, "/club", a, body(a, 2000)).status, 400);
    assert.equal(p1.call("duel:cashout").ok, false);
    assert.equal(p2.call("duel:play", { wager: 100 }).ok, false);
    const state = io.messages.filter((m) => m.event === "duel:state").at(-1).data;
    assert.equal(state.activePlay.winner, undefined);
    const saved = require("../src/services/realtimeStore").load("duel").get(duel.code);
    assert.deepEqual(saved.activePlay.home, duel.activePlay.home);
    duel.activePlay.startedAt -= 40000;
    p1.call("duel:sync");
    assert.equal(duel.activePlay, null);
    assert.equal(duel.turn, "p2");
    assert.equal(duel.lastPlay.detail.ended, true);
    p1.call("duel:sync");
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id=?", [a]).n, 1);
    assert.equal(gameBalance(a, "duel") + gameBalance(b, "duel"), before);
    p1.call("duel:leave");
    control.close();
});
test.after(async () => {
    pool.db.close();
    // The parent integration test removes libSQL fixtures after the worker process exits.
    if (process.env.ARCADIA_TEST_DIRECTORY) return;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
