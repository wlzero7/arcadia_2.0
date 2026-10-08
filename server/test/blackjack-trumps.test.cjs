const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { invoke, FakeIO, gameBalance } = require("./support.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-blackjack-"));
process.env.DB_PATH = path.join(directory, "test.db");
const pool = require("../src/config/database");
const bj = require("../src/services/blackjack");
const rounds = require("../src/services/rounds");
const router = require("../src/routes/blackjack.routes");
const duels = require("../src/realtime/duels");
const multiplayer = require("../src/realtime/blackjack-mp");
let sequence = 0;
const card = (rank, suit = bj.SUITS[0]) => ({ rank: String(rank), suit });
function user() {
    const name = "blackjack" + ++sequence;
    return pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,'test')", [name,name + "@example.test"]).lastInsertRowid;
}
function hand() { return { deck: [card("K"),card(5),card(3),card(2),card(4)], player: [card(2),card(3)], dealer: [card(7),card(8)], hits: 0, limit: 21, nrg: 10, doubled: false }; }
function count(id, key) { return bj.inventory(id).find((c) => c.key === key)?.qty || 0; }
function has(id, key) { return !!pool.db.get("SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_key = ?", [id,key]); }
function duel() {
    const a = user(), b = user(), io = new FakeIO();
    duels.setupDuels(io);
    const p1 = io.connect(a), p2 = io.connect(b);
    const created = p1.call("duel:create").duel;
    p2.call("duel:join", { code: created.code });
    p1.call("duel:ready"); p2.call("duel:ready"); p1.call("duel:ready");
    p1.call("duel:bid", { gameIdx: 6, amount: 10 });
    assert.equal(p1.call("duel:choose", { gameIdx: 6 }).ok, true);
    const state = duels.duels.get(created.code);
    // Start a deterministic active hand without relying on random natural 21s.
    state.activePlay = { ...hand(), id: "hand-" + a, game: "blackjack", playerKey: "p1", username: "tester", wager: 100, startedAt: Date.now() };
    return { a,b,io,p1,p2,state };
}
function table() {
    const a = user(), b = user(), io = new FakeIO();
    const { tables } = multiplayer.setupBlackjackMultiplayer(io);
    const p1 = io.connect(a), p2 = io.connect(b);
    const code = p1.call("bj:create").table.code;
    p2.call("bj:join", { code });
    assert.equal(p1.call("bj:start").ok, true);
    const state = tables.get(code);
    state.players.get(a).hand = [card(2),card(3)];
    state.players.get(b).hand = [card(7),card(8)];
    state.players.get(a).nrg = 10;
    state.deck = hand().deck;
    return { a,b,io,p1,p2,state,tables };
}
function prepare(state, key) {
    if (key === "remove_last") state.dealer.push(card(2));
    if (key === "shield") state.player = [card(10),card(9)];
}
function checkEffect(state, key, oldLength) {
    if (key === "force_hit") assert.equal(state.dealer.length, oldLength + 1);
    if (key === "remove_last") assert.equal(state.dealer.length, oldLength - 1);
    if (key === "raise_limit_28") assert.equal(state.limit, 28);
    if (key === "lower_limit_17") assert.equal(state.limit, 17);
    if (key === "pick_card") assert.equal(state.player.at(-1).rank, "2");
    if (key === "draw_three") assert.equal(state.player.length, 5);
    if (key === "mirror") assert.equal(state.mirror, true);
    if (key === "shield") assert.equal(state.shield, true);
}
for (const key of Object.keys(bj.SPECIAL_CARDS)) {
    test(`Solo consumes ${key} once and applies its effect`, () => {
        const id = user(), state = hand(); prepare(state,key);
        rounds.startRound(id,"blackjack",100,state);
        bj.addCard(id,key);
        const before = state.dealer.length;
        assert.equal(invoke(router,"/blackjack/special",id,{ cardKey: key, rank: "2", suit: bj.SUITS[0] }).status,200);
        checkEffect(rounds.getSession(id,"blackjack"),key,before);
        assert.equal(count(id,key),0);
        assert.equal(invoke(router,"/blackjack/special",id,{ cardKey: key, rank: "2", suit: bj.SUITS[0] }).status,400);
    });
    test(`Duel consumes ${key} once, broadcasts live effects and enforces ownership`, () => {
        const r = duel(); prepare(r.state.activePlay,key); bj.addCard(r.a,key);
        const before = r.state.activePlay.dealer.length;
        assert.equal(r.p2.call("duel:special",{ cardKey: key }).ok,false);
        assert.equal(r.p1.call("duel:special",{ cardKey: key, rank: "2", suit: bj.SUITS[0] }).ok,true);
        checkEffect(r.state.activePlay,key,before); assert.equal(count(r.a,key),0);
        const state = r.io.messages.filter((m) => m.event === "duel:state").at(-1).data.activePlay;
        assert.equal(state.deck,undefined); assert.equal(state.dealer[1].hidden,true);
        if (key === "force_hit") assert.equal(state.dealer.length,3);
        assert.equal(r.p1.call("duel:special",{ cardKey: key }).ok,false);
        r.p1.call("duel:leave");
    });
    test(`Multiplayer persists and consumes ${key} with its multiplayer effect`, () => {
        const r = table(), me = r.state.players.get(r.a), target = r.state.players.get(r.b);
        if (key === "remove_last") target.hand.push(card(2));
        if (key === "mirror") me.lastAttack = { key: "force_hit", from: r.b };
        const before = target.hand.length;
        bj.addCard(r.a,key); r.p1.call("bj:join",{ code: r.state.code });
        assert.equal(r.p2.call("bj:special",{ cardKey: key }).ok,false);
        assert.equal(r.p1.call("bj:special",{ cardKey: key, targetId: r.b, rank: "2", suit: bj.SUITS[0] }).ok,true);
        assert.equal(count(r.a,key),0); assert.equal(me.nrg,10 - bj.SPECIAL_CARDS[key].nrg);
        if (key === "force_hit" || key === "mirror") assert.equal(target.hand.length,before + 1);
        if (key === "remove_last") assert.equal(target.hand.length,before - 1);
        if (key === "raise_limit_28") assert.equal(r.state.limit,28);
        if (key === "lower_limit_17") assert.equal(r.state.limit,17);
        if (key === "pick_card") assert.equal(me.hand.at(-1).rank,"2");
        if (key === "draw_three") assert.equal(me.hand.length,5);
        if (key === "shield") assert.equal(me.shield,true);
        assert.equal(r.p1.call("bj:special",{ cardKey: key }).ok,false);
        assert.ok(r.io.messages.filter((m) => m.event === "bj:specials").every((m) => m.channel.startsWith("socket-")));
        r.tables.delete(r.state.code);
    });
}
test("changed limits value aces correctly, shield prevents bust and mirror diverts a dealer draw", () => {
    assert.equal(bj.handValue([card("A"),card(10),card(7)],28),28);
    assert.equal(bj.handValue([card("A"),card(10),card(7)],21),18);
    assert.equal(bj.handValue([card("A"),card(7)],17),8);
    const shield = { ...hand(), player: [card(10),card(9)], shield: true };
    bj.drawPlayer(shield,card(10)); assert.equal(bj.handValue(shield.player),19); assert.equal(shield.shield,false); assert.equal(shield.hits,1);
    const mirror = { ...hand(), mirror: true };
    bj.stand(mirror); assert.equal(mirror.mirror,false); assert.equal(mirror.player.length,3); assert.ok(bj.handValue(mirror.dealer) >= 17);
});
test("invalid specials roll back inventory, state and balance", () => {
    const id = user(); rounds.startRound(id,"blackjack",100,hand()); bj.addCard(id,"pick_card");
    const before = rounds.getSession(id,"blackjack");
    assert.equal(invoke(router,"/blackjack/special",id,{ cardKey: "pick_card", rank: "Q", suit: bj.SUITS[1] }).status,400);
    assert.deepEqual(rounds.getSession(id,"blackjack"),before); assert.equal(count(id,"pick_card"),1);
    assert.equal(pool.getWalletSync(id,"solo").balance,999900);
    const r = table(); bj.addCard(r.a,"remove_last"); r.p1.call("bj:join",{ code: r.state.code });
    assert.equal(r.p1.call("bj:special",{ cardKey: "remove_last", targetId: r.b }).ok,false);
    assert.equal(count(r.a,"remove_last"),1); assert.equal(r.state.players.get(r.a).nrg,10); r.tables.delete(r.state.code);
});
test("Solo 21 and no-hit achievements use authoritative round details and settlement is one-time", () => {
    const id = user(), state = { ...hand(), player: [card("A"),card("K")], dealer: [card(10),card(8)] };
    rounds.startRound(id,"blackjack",100,state);
    assert.equal(invoke(router,"/blackjack/stand",id).outcome,"win");
    assert.ok(has(id,"blackjack_21")); assert.ok(has(id,"no_cards"));
    assert.equal(invoke(router,"/blackjack/stand",id).status,400);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?",[id]).n,1);
});
test("Duel reconnect restores cards without exposing deck, double settles once and conserves both wallets", () => {
    const r = duel(); const total = () => gameBalance(r.a,"duel") + gameBalance(r.b,"duel");
    const before = total(), restored = r.io.connect(r.a).call("duel:join",{ code: r.state.code }).duel.activePlay;
    assert.equal(restored.deck,undefined); assert.deepEqual(restored.player,r.state.activePlay.player); assert.deepEqual(restored.dealer[1],{ hidden: true });
    assert.equal(r.p2.call("duel:double").ok,false); assert.equal(r.p1.call("duel:double").ok,true);
    assert.equal(r.state.lastPlay.wager,200); assert.equal(r.state.lastPlay.detail.hits,1);
    assert.equal(r.p1.call("duel:stand").ok,false); assert.equal(total(),before);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?",[r.a]).n,1); r.p1.call("duel:leave");
});
function funded(amounts) {
    const r = table(); r.state.phase = "lobby";
    for (const [id,amount] of [[r.a,amounts[0]],[r.b,amounts[1]]]) {
        pool.getWalletSync(id,"coop");
        pool.db.run("UPDATE wallets SET balance = ? WHERE user_id = ? AND kind = 'coop'",[amount,id]);
    }
    assert.equal(r.p1.call("bj:bet",{ amount: 1, allWin: true }).ok,true);
    assert.equal(r.p2.call("bj:bet",{ amount: 1, allWin: true }).ok,true);
    return r;
}
test("Multiplayer All Win debits only on consent, settles full pot, preserves total and records achievements", () => {
    const r = funded([101,202]); assert.equal(pool.getWalletSync(r.a,"coop").balance,101);
    assert.equal(r.p1.call("bj:start").ok,true); assert.equal(r.state.pot,303);
    assert.equal(pool.getWalletSync(r.a,"coop").balance,0);
    r.state.players.get(r.a).hand = [card("A"),card("K")]; r.state.players.get(r.b).hand = [card(10),card(8)];
    assert.equal(r.p1.call("bj:stand").ok,true); assert.equal(r.p2.call("bj:stand").ok,true);
    assert.equal(gameBalance(r.a,"coop"),303); assert.equal(gameBalance(r.b,"coop"),0);
    assert.ok(has(r.a,"all_win")); assert.ok(has(r.b,"all_win")); assert.ok(has(r.a,"blackjack_21")); assert.ok(has(r.a,"no_cards"));
    assert.equal(r.p2.call("bj:stand").ok,false); assert.equal(r.state.pot,0);
    r.tables.delete(r.state.code);
});
test("Multiplayer odd-pot ties and all-bust refunds conserve every AC", () => {
    for (const busted of [false,true]) {
        const r = funded([101,202]); r.p1.call("bj:start");
        for (const id of [r.a,r.b]) r.state.players.get(id).hand = busted ? [card(10),card(10),card(10)] : [card(10),card(8)];
        r.p1.call("bj:stand"); r.p2.call("bj:stand");
        const a = gameBalance(r.a,"coop"), b = gameBalance(r.b,"coop");
        assert.equal(a + b,303);
        if (busted) { assert.equal(a,101); assert.equal(b,202); }
        else assert.equal(Math.abs(a - b),1);
        r.tables.delete(r.state.code);
    }
});
test("Multiplayer rejects mixed practice/betting and rolls back a stale balance without publishing a round", () => {
    const r = funded([101,202]); r.p2.call("bj:bet",{ amount: 0 });
    assert.equal(r.p1.call("bj:start").ok,false); assert.equal(pool.getWalletSync(r.a,"coop").balance,101);
    r.p2.call("bj:bet",{ amount: 202 }); pool.db.run("UPDATE wallets SET balance = 0 WHERE user_id = ? AND kind = 'coop'",[r.b]);
    const emitted = r.io.messages.length;
    assert.equal(r.p1.call("bj:start").ok,false); assert.equal(r.io.messages.length,emitted);
    assert.equal(r.state.phase,"lobby"); assert.equal(r.state.pot,0); assert.equal(pool.getWalletSync(r.a,"coop").balance,101);
    r.tables.delete(r.state.code);
});
test("Multiplayer large shared pot unlocks rich friends and reconnect keeps escrow", () => {
    const r = funded([5000000,5000000]); r.p1.call("bj:start"); assert.ok(has(r.a,"rich_friends")); assert.ok(has(r.b,"rich_friends"));
    assert.equal(r.io.connect(r.a).call("bj:join",{ code: r.state.code }).table.pot,10000000);
    assert.equal(gameBalance(r.a,"coop"),0); r.tables.delete(r.state.code);
});
test("Multiplayer reconnect preserves the turn and disconnect expiry settles at most once", () => {
    const r = funded([101,202]); r.p1.call("bj:start");
    r.state.players.get(r.a).hand = [card(10),card(9)]; r.state.players.get(r.b).hand = [card(10),card(8)];
    const original = global.setTimeout;
    let expire;
    global.setTimeout = (fn,ms,...args) => ms === 25000 ? (expire = fn, { unref() { return this; } }) : original(fn,ms,...args);
    try {
        r.p1.disconnect(); assert.equal(r.state.phase,"playing"); assert.equal(r.state.players.get(r.a).stood,false);
        const reconnect = r.io.connect(r.a); assert.equal(reconnect.call("bj:join",{ code: r.state.code }).ok,true);
        expire(); assert.equal(r.state.players.get(r.a).stood,false); assert.equal(r.state.pot,303);
        reconnect.disconnect(); expire(); assert.equal(r.state.players.get(r.a).stood,true);
        assert.equal(r.p2.call("bj:stand").ok,true); expire();
        assert.equal(gameBalance(r.a,"coop") + gameBalance(r.b,"coop"),303);
        assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (?,?)",[r.a,r.b]).n,2);
    } finally { global.setTimeout = original; r.tables.delete(r.state.code); }
});
test("Multiplayer cannot abandon a funded hand by switching or creating tables", () => {
    const r = funded([101,202]); r.p1.call("bj:start");
    const other = r.io.connect(user()).call("bj:create").table.code, size = r.tables.size;
    assert.equal(r.p1.call("bj:join",{ code: other }).ok,false);
    assert.equal(r.p1.call("bj:create").ok,false); assert.equal(r.tables.size,size);
    assert.equal(r.p1.data.tableCode,r.state.code); assert.ok(r.state.players.get(r.a).socketIds.has(r.p1.id));
    assert.equal(r.state.pot,303); r.tables.delete(other); r.tables.delete(r.state.code);
});
test("Multiplayer persistence failure rolls back a trump and never broadcasts its uncommitted effect", () => {
    const r = table(); bj.addCard(r.a,"force_hit"); r.p1.call("bj:join",{ code: r.state.code });
    const before = structuredClone(r.state), emitted = r.io.messages.length, original = pool.db.run;
    pool.db.run = function (sql,...args) { if (sql.includes("INSERT INTO realtime_sessions")) throw new Error("Test persistence failure"); return original.call(this,sql,...args); };
    try { assert.equal(r.p1.call("bj:special",{ cardKey: "force_hit",targetId: r.b }).ok,false); }
    finally { pool.db.run = original; }
    assert.deepEqual(r.state,before); assert.equal(count(r.a,"force_hit"),1); assert.equal(r.io.messages.length,emitted);
    r.tables.delete(r.state.code);
});
test.after(() => { pool.db.close(); fs.rmSync(directory,{ recursive: true,force: true }); });
