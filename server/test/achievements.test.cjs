const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { invoke, FakeIO, gameBalance } = require("./support.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-achievements-"));
process.env.DB_PATH = path.join(directory, "test.db");
const pool = require("../src/config/database");
const rounds = require("../src/services/rounds");
const achievements = require("../src/services/achievements");
const progression = require("../src/services/progression.routes");
const games = require("../src/routes/game.routes");
const slots = require("../src/routes/slots.routes");
const roulette = require("../src/routes/roulette.routes");
let sequence = 0;
function user(username = "achievement" + ++sequence) {
    const id = pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,'test')", [username, username + "@example.test"]).lastInsertRowid;
    for (const kind of ["solo", "duel", "coop"]) pool.getWalletSync(id, kind);
    return id;
}
function owned(id, key) { return !!pool.db.get("SELECT 1 FROM user_achievements WHERE user_id = ? AND achievement_key = ?", [id, key]); }
function record(id, game, outcome, detail = {}, amount = 100, multiplier = 2) { return rounds.recordBet(id, game, amount, outcome === "win" ? amount * multiplier : 0, outcome, detail); }

test("catalog contains exactly the 40 requested names and XP rewards", () => {
    const names = ["Primeira Vitória!", "Primeira Derrota!", "6 Faces.", "Ao infinito e além!", "Invicto!", "Super Invicto!", "Derrotado!", "ALL WIN!!", "Rico!", "Blackjack 21!", "Foguete não da Ré!", "croissant", "Reportador de Bugs", "Não preciso de cartas!", "Minerador!", "50/50", "Minerador Nato!", "O número ruim da Face!", "Pobre!", "O Subestimado!", "Criando novos Laços!", "Progressista!", "Mestre do XP!", "XP Farmer", "Lvl Lenda!", "O número da Sorte!", "Sortudo!", "Rei dos Trunfos!", "Roletado!", "Conquistador!", "Magnata!", "Bilionário!", "Plin-Plinkoo!", "Diarista!", "Missionário!", "X1", "Cooperador", "Amigos Ricos!", "Vencedor!", "Platina"];
    const xp = [50,50,100,100,1000,2000,500,0,100,300,500,1000,10000,500,1000,1000,200,50,1000,2000,100,200,500,1000,5000,777,1000,1000,1000,500,10000,50000,4500,0,1000,400,400,1000,2000,0];
    assert.deepEqual(Object.values(achievements.ACHIEVEMENTS).map((a) => a.name), names);
    assert.deepEqual(Object.values(achievements.ACHIEVEMENTS).map((a) => a.xp), xp);
    const id = user(); achievements.unlockAchievement(id, "first_win");
    assert.equal(achievements.achievementCount(id).total, 0);
    assert.equal(invoke(progression.router, "/achievements", id, {}, "get").achievements.length, 40);
});
test("game achievements normalize Duel and Coop and do not reward twice", () => {
    const id = user();
    record(id, "duel", "win", { game: "dice", picked: 6 });
    for (const key of ["first_victory", "six_faces", "bad_face"]) assert.ok(owned(id, key));
    const before = pool.db.get("SELECT xp,level FROM users WHERE id = ?", [id]);
    assert.equal(achievements.unlockAchievement(id, "six_faces"), null);
    assert.deepEqual(pool.db.get("SELECT xp,level FROM users WHERE id = ?", [id]), before);
    record(id, "crash", "loss", { roomCode: "COOP01" });
    assert.ok(owned(id, "first_defeat")); assert.ok(owned(id, "infinity"));
    record(id, "blackjack", "win", { player: [{ rank: "A" }, { rank: "K" }], hits: 0 });
    assert.ok(owned(id, "blackjack_21")); assert.ok(owned(id, "no_cards"));
    record(id, "crash", "win", { cashout: 4 }); assert.ok(owned(id, "rocket_reverse"));
    record(id, "mines", "win", { multiplier: 7 }); assert.ok(owned(id, "miner"));
    record(id, "racing", "win", { horseName: "Nicolas", horseOdds: 8, maxOdds: 8, mode: "coop" });
    assert.ok(owned(id, "croissant")); assert.ok(owned(id, "underestimated"));
    record(id, "slots", "win", { jackpot: true }); assert.ok(owned(id, "lucky"));
    record(id, "plinko", "win", {}, 100, 1000); assert.ok(owned(id, "plin_plinkoo"));
    record(id, "dice", "loss", {}, 777777); assert.ok(owned(id, "lucky_number"));
});
test("win/loss streaks reset, while individual game streaks ignore other games", () => {
    const id = user();
    for (let i = 0; i < 9; i++) record(id, "dice", "win");
    record(id, "dice", "loss"); record(id, "dice", "win"); assert.equal(owned(id, "undefeated_10"), false);
    for (let i = 0; i < 19; i++) record(id, "coinflip", "win");
    assert.ok(owned(id, "undefeated_10")); assert.ok(owned(id, "undefeated_20"));
    for (let i = 0; i < 10; i++) record(id, "dice", "loss"); assert.ok(owned(id, "defeated_10"));
    for (let i = 0; i < 25; i++) { record(id, "duel", "win", { game: "mines" }); record(id, "dice", "loss"); }
    assert.ok(owned(id, "born_miner"));
    for (let i = 0; i < 10; i++) record(id, "roulette", "win", { roomCode: "ROOM01" });
    assert.ok(owned(id, "roulette_10")); assert.ok(owned(id, "coop_5"));
});
test("profile milestones, missions, wealth and rare inventories unlock from persisted state", () => {
    const id = user(), friend = user();
    pool.db.run("UPDATE users SET level = 100 WHERE id = ?", [id]);
    pool.db.run("UPDATE wallets SET balance = 400000000 WHERE user_id = ?", [id]);
    pool.db.run("INSERT INTO friendships (user_id,friend_id,status) VALUES (?,?,'accepted')", [id, friend]);
    pool.db.run("INSERT INTO slots_cards (user_id,card_key,rarity) VALUES (?,'abencoado','cromatica')", [id]);
    pool.db.run("INSERT INTO blackjack_cards (user_id,card_key,rarity) VALUES (?,'pick_card','lendaria')", [id]);
    pool.db.run("INSERT INTO duel_stats (user_id,wins,losses) VALUES (?,5,0)", [id]);
    const today = new Date().toISOString().slice(0,10);
    for (let i = 0; i < 30; i++) pool.db.run("INSERT INTO user_missions (user_id,mission_key,period,progress,completed) VALUES (?,?,?,1,1)", [id, "daily_test" + i, today]);
    record(id, "dice", "loss", {}, 1000000);
    for (const key of ["rich", "magnate", "billionaire", "new_bonds", "trump_king", "level_25_new", "level_50_new", "level_75_new", "level_100_new", "duel_5", "daily_worker", "missionary", "poor"]) assert.ok(owned(id, key), key);
    const insert = () => pool.db.run("INSERT INTO bets (user_id,game,wager,multiplier,payout,outcome,detail) VALUES (?,'dice',10,2,20,'win','{}')", [id]);
    pool.transactionSync(() => { for (let i = 0; i < 1000; i++) insert(); });
    achievements.checkProfileAchievements(id); assert.ok(owned(id, "winner_1000"));
});
test("achievement milestones exclude generic rows and platinum requires all other 39", () => {
    const id = user();
    pool.db.run("INSERT INTO user_achievements (user_id,achievement_key) VALUES (?,'old_generic')", [id]);
    const keys = Object.keys(achievements.ACHIEVEMENTS).filter((key) => !["conqueror", "platinum"].includes(key));
    for (const key of keys.slice(0,24)) achievements.unlockAchievement(id, key);
    assert.equal(owned(id, "conqueror"), false);
    achievements.unlockAchievement(id, keys[24]); assert.ok(owned(id, "conqueror"));
    assert.equal(owned(id, "platinum"), false);
    for (const key of keys.slice(25)) achievements.unlockAchievement(id, key);
    assert.ok(owned(id, "platinum")); assert.equal(achievements.achievementCount(id).total, 40);
});
test("only wl07 can approve bug reports; pending/rejected reports award no XP", () => {
    const id = user(), admin = user("wl07"), stranger = user();
    const report = invoke(progression.router, "/bugs", id, { title: "Erro nas cartas", description: "O dealer recebe uma carta duplicada ao parar a rodada." });
    assert.equal(report.status, 200); assert.equal(owned(id, "bug_reporter"), false);
    const review = (userId, approved) => invoke(progression.router, "/bugs/:id/review", userId, { approved }, "post", { params: { id: report.id } });
    assert.equal(review(stranger, true).status, 403);
    assert.equal(invoke(progression.router, "/bugs", stranger, {}, "get").reports.length, 0);
    assert.equal(review(admin, true).status, 200); assert.ok(owned(id, "bug_reporter"));
    const before = pool.db.get("SELECT xp,level FROM users WHERE id = ?", [id]);
    assert.equal(review(admin, true).status, 409); assert.deepEqual(pool.db.get("SELECT xp,level FROM users WHERE id = ?", [id]), before);
    const rejected = user(), next = invoke(progression.router, "/bugs", rejected, { title: "Outro relato", description: "Relato com passos que o desenvolvedor não conseguiu reproduzir." });
    assert.equal(invoke(progression.router, "/bugs/:id/review", admin, { approved: false }, "post", { params: { id: next.id } }).status, 200);
    assert.equal(owned(rejected, "bug_reporter"), false);
});
test("All Win resolves authoritative balances above normal caps and survives active round settlement", () => {
    const id = user(); pool.db.run("UPDATE wallets SET balance = 2000123 WHERE user_id = ? AND kind = 'solo'", [id]);
    const result = invoke(games.router, "/:game/play", id, { wager: 10, allWin: true, choice: { side: "heads" } }, "post", { params: { game: "coinflip" } });
    assert.equal(result.status, 200); assert.equal(pool.db.get("SELECT wager FROM bets WHERE user_id = ?", [id]).wager, 2000123);
    assert.ok(owned(id, "all_win")); assert.equal(owned(id, "fifty_fifty"), result.outcome === "win");
    const other = user();
    rounds.settleInstant(other, "coinflip", 10, 20, "win", { allWin: true });
    assert.equal(owned(other, "all_win"), false);
    const active = user(); invoke(games.router, "/mines/start", active, { wager: 10, mines: 3, allWin: true });
    const state = rounds.getSession(active, "mines"); assert.equal(state.wager, 1000000); assert.equal(state.allWin, true);
    const safe = Array.from({length:25}, (_,i) => i).find((i) => !state.mines.includes(i));
    invoke(games.router, "/mines/pick", active, { cell: safe }); invoke(games.router, "/mines/cashout", active); assert.ok(owned(active, "all_win"));
    const rl = user(); assert.equal(invoke(roulette, "/roulette/spin", rl, { allWin: true, bets: [{ type: "red", amount: 10 }, { type: "black", amount: 10 }] }).status, 400);
    assert.equal(invoke(roulette, "/roulette/spin", rl, { allWin: true, bets: [{ type: "red", amount: 10 }] }).status, 200);
    assert.equal(pool.db.get("SELECT wager FROM bets WHERE user_id = ?", [rl]).wager, 1000000);
});
test("Slots trumps work in Solo and Coop and guaranteed jackpots match the visible reels", () => {
    const id = user(); pool.db.run("INSERT INTO slots_cards (user_id,card_key,rarity) VALUES (?,'abencoado','cromatica')", [id]);
    const jackpot = invoke(slots, "/play", id, { wager: 100, trump: "abencoado" });
    assert.equal(jackpot.status, 200); assert.equal(jackpot.payout, 10000); assert.deepEqual(jackpot.reels, ["7️⃣","7️⃣","7️⃣"]); assert.ok(owned(id, "lucky"));
    for (const key of ["bloqueador", "allwin"]) {
        const player = user(); pool.db.run("INSERT INTO slots_cards (user_id,card_key,rarity) VALUES (?,?,'cromatica')", [player, key]);
        assert.equal(invoke(slots, "/play", player, { wager: 100, trump: key }).status, 200);
        if (key === "allwin") assert.ok(owned(player, "all_win"));
    }
    const coop = user(), io = new FakeIO(), rooms = require("../src/realtime/rooms"); rooms.setupMultiplayer(io);
    const socket = io.connect(coop); socket.call("room:create", { game: "slots" }); socket.call("room:stake", { amount: 100 });
    pool.db.run("INSERT INTO slots_cards (user_id,card_key,rarity) VALUES (?,'bloqueador','super_rara')", [coop]);
    assert.equal(socket.call("room:play", { wager: 10, choice: { trump: "bloqueador" } }).ok, true);
});
test("Coop All Win deposits wallet, bets full pot, and awards large-pot contributors", () => {
    const id = user(), other = user(), io = new FakeIO(), rooms = require("../src/realtime/rooms"); rooms.setupMultiplayer(io);
    const socket = io.connect(id), guest = io.connect(other); const created = socket.call("room:create", { game: "coinflip" }).room;
    guest.call("room:join", { code: created.code }); guest.call("room:stake", { amount: 100 });
    pool.db.run("UPDATE wallets SET balance = 10000000 WHERE user_id = ? AND kind = 'coop'", [id]);
    assert.equal(socket.call("room:stake", { amount: 10, allWin: true }).ok, true);
    assert.equal(gameBalance(id, "coop"), 0);
    assert.ok(owned(id, "rich_friends")); assert.ok(owned(other, "rich_friends"));
    const result = socket.call("room:play", { wager: 10, allWin: true, choice: { side: "heads" } });
    assert.equal(result.ok, true); assert.equal(result.round.wager, 10000100); assert.ok(owned(id, "all_win"));
});
for (const mode of ["solo","duel","coop"]) for (const [key,meta] of Object.entries(require("../src/services/slotsEngine").TRUMPS)) {
    test(`Slots ${key} is usable and consumed atomically in ${mode}`, () => {
        const id = user(), io = new FakeIO();
        const ownedId = pool.db.run("INSERT INTO slots_cards (user_id,card_key,rarity) VALUES (?,?,?)",[id,key,meta.rarity]).lastInsertRowid;
        if (mode === "solo") {
            const before = gameBalance(id,"solo");
            const result = invoke(slots,"/play",id,{ wager: 100,trump: key });
            assert.equal(result.status,200);
            const bet = pool.db.get("SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 1",[id]);
            assert.equal(gameBalance(id,"solo"),before - bet.wager + bet.payout);
            if (key === "allwin") assert.equal(bet.wager,before);
            if (key === "abencoado") assert.deepEqual(result.reels,["7️⃣","7️⃣","7️⃣"]);
        } else if (mode === "coop") {
            const rooms = require("../src/realtime/rooms"); rooms.setupMultiplayer(io);
            const socket = io.connect(id); socket.call("room:create",{ game: "slots" }); socket.call("room:stake",{ amount: 1000 });
            const result = socket.call("room:play",{ wager: 100,choice: { trump: key } });
            assert.equal(result.ok,true);
            assert.equal(result.round.potAfter,1000 - result.round.wager + result.round.payout);
            if (key === "allwin") assert.equal(result.round.wager,1000);
            socket.call("room:leave");
        } else {
            const duels = require("../src/realtime/duels"); duels.setupDuels(io);
            const other = user(), socket = io.connect(id), guest = io.connect(other);
            const code = socket.call("duel:create").duel.code;
            guest.call("duel:join",{ code }); socket.call("duel:ready"); guest.call("duel:ready"); socket.call("duel:ready");
            socket.call("duel:bid",{ gameIdx: 5,amount: 10 }); socket.call("duel:choose",{ gameIdx: 5 });
            const before = gameBalance(id,"duel") + gameBalance(other,"duel");
            assert.equal(socket.call("duel:play",{ wager: 100,choice: { trump: key } }).ok,true);
            assert.equal(gameBalance(id,"duel") + gameBalance(other,"duel"),before);
            if (key === "bloqueador") assert.equal(duels.duels.get(code).turn,"p1");
            socket.call("duel:leave");
        }
        assert.equal(pool.db.get("SELECT id FROM slots_cards WHERE id = ?",[ownedId]),null);
    });
}
test("Diarista counts completed daily missions across dates, without requiring the same day", () => {
    const id = user();
    for (let i = 1; i <= 3; i++) pool.db.run("INSERT INTO user_missions (user_id,mission_key,period,completed) VALUES (?,'daily_dice',?,1)",[id,`2026-09-0${i}`]);
    achievements.checkProfileAchievements(id); assert.ok(owned(id,"daily_worker"));
});
test("Duel Roulette All Win accepts the full real wallet above the ordinary limit", () => {
    const id = user(), other = user(), io = new FakeIO(), duels = require("../src/realtime/duels"); duels.setupDuels(io);
    const socket = io.connect(id), guest = io.connect(other), code = socket.call("duel:create").duel.code;
    guest.call("duel:join",{ code }); socket.call("duel:ready"); guest.call("duel:ready"); socket.call("duel:ready");
    socket.call("duel:bid",{ gameIdx: 4,amount: 10 }); socket.call("duel:choose",{ gameIdx: 4 });
    pool.db.run("UPDATE wallets SET balance = 2000005 WHERE user_id = ? AND kind = 'duel'",[id]);
    assert.equal(socket.call("duel:play",{ allWin: true,wager: 10,choice: { bet: "red" } }).ok,true);
    assert.equal(pool.db.get("SELECT wager FROM bets WHERE user_id = ?",[id]).wager,2000005); assert.ok(owned(id,"all_win"));
    socket.call("duel:leave");
});
test.after(() => { pool.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
