const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-duel-browser-"));
const output = process.env.QA_OUTPUT || path.resolve(__dirname, "../../../visual-output/duel-trumps");
fs.mkdirSync(output, { recursive: true });
process.env.DB_PATH = path.join(directory, "qa.db");
process.env.TURSO_DATABASE_URL = ""; process.env.TURSO_AUTH_TOKEN = "";
process.env.REQUIRE_PERSISTENT_DB = "0";
const pool = require("../src/config/database");
const bj = require("../src/services/blackjack");
const password = "LocalQaFixtureOnly123!";
const names = ["arena_alice", "arena_bob", "arena_solo"];
for (const name of names) {
    const id = pool.db.run("INSERT INTO users(username,email,password_hash,avatar) VALUES(?,?,?,?)", [name, name + "@example.test", require("bcryptjs").hashSync(password, 4), "\u{1F451}"]).lastInsertRowid;
    for (const key of Object.keys(bj.SPECIAL_CARDS)) bj.addCard(id, key);
}
pool.db.close();
const child = spawn(process.execPath, ["src/server.js"], { cwd: path.resolve(__dirname, ".."), windowsHide: true,
    env: { ...process.env, PORT: "0", NODE_ENV: "test", JWT_SECRET: "local-ui-fixture-only-123456789" }, stdio: ["ignore", "pipe", "pipe"] });
let browser, logs = "", checks = 0;
child.stderr.on("data", (data) => logs += data);
const check = (condition, message) => { assert.ok(condition, message); checks++; };
async function screens(page, label) {
    for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(150);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + " overflow " + width);
        check(await page.evaluate(() => [...document.querySelectorAll(".multiplayer-arena .pot-actions input, .multiplayer-arena .bet-row input")].filter((input) => input.getClientRects().length).every((input) => input.getBoundingClientRect().width >= 120)), label + " usable amount fields " + width);
        check(await page.evaluate(() => [...document.querySelectorAll(".multiplayer-arena .pot-actions .btn, .multiplayer-arena .bet-row .btn")].filter((button) => button.getClientRects().length).every((button) => {
            // Measure content, excluding the decorative hover shine pseudo-element.
            const range = document.createRange(); range.selectNodeContents(button);
            const text = range.getBoundingClientRect(), box = button.getBoundingClientRect();
            return text.left >= box.left - 1 && text.right <= box.right + 1 && text.top >= box.top - 1 && text.bottom <= box.bottom + 1;
        })), label + " amount button labels fit " + width);
        await page.screenshot({ path: path.join(output, label + "-" + width + ".png"), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
}
(async () => {
    try {
        const base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(logs)), 15000);
            child.stdout.on("data", (data) => { logs += data; const port = /http:\/\/localhost:(\d+)/.exec(logs)?.[1]; if (port) { clearTimeout(timer); resolve("http://127.0.0.1:" + port); } });
        });
        browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-swiftshader"] });
        const contexts = [], pages = [], errors = [];
        for (const name of names) {
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
            check((await context.request.post(base + "/api/auth/login", { data: { email: name + "@example.test", password } })).status() === 200, "fixture login");
            const page = await context.newPage(); pages.push(page); page.on("pageerror", (error) => errors.push(error.message));
        }
        const [a, b, solo] = pages;
        await a.addInitScript(() => {
            window.qaAudio = { nodes: 0, contexts: [], gains: [] };
            const Native = window.AudioContext;
            window.AudioContext = class extends Native {
                constructor(...args) { super(...args); window.qaAudio.contexts.push(this); }
                createOscillator() { window.qaAudio.nodes++; return super.createOscillator(); }
                createBufferSource() { window.qaAudio.nodes++; return super.createBufferSource(); }
                createGain() { const gain = super.createGain(); window.qaAudio.gains.push(gain); return gain; }
            };
        });
        await a.goto(base + "/duel.html"); await b.goto(base + "/duel.html");
        await a.click("#createDuelBtn"); await a.locator("#duelArena").waitFor({ state: "visible" });
        const code = await a.locator("#duelCode").textContent();
        await b.fill("#joinCode", code); await b.click("#joinDuelBtn");
        await a.fill("#duelCapital", "1234"); await b.fill("#duelCapital", "5678");
        await a.click("#readyBtn"); await b.click("#readyBtn");
        await a.locator("#auctionPanel").waitFor({ state: "visible" });
        check(await a.locator("#p1Balance").textContent() === "1.234 AC", "selected capital");
        check(await a.locator("#chooseBtn").isHidden(), "no early-start control");
        await a.locator(".auction-slot").nth(6).click(); await a.fill("#bidAmount", "10"); await a.click("#bidBtn");
        check(await a.locator("#chooseBtn").isHidden(), "selecting a slot cannot bypass countdown");
        await screens(a, "auction");
        await a.waitForFunction(() => document.querySelector("#gameSelect").disabled, null, { timeout: 35000 });
        check(await a.locator("#gameSelect").inputValue() === "blackjack", "automatic selected game");
        check(await a.locator("#battleIntro .battle-avatar").count() === 2, "duel intro identities");
        await a.locator("#wager + .all-win-button").click();
        check(await a.locator("#wager").inputValue() === "1224", "All Win displays only the remaining battle capital");
        check(await a.locator("#wager + .all-win-button").getAttribute("title") === "Apostar todo o capital da batalha", "All Win describes battle funds");
        const arenaStyle = await a.locator(".multiplayer-arena").evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, radius: getComputedStyle(el).borderRadius }));
        await a.fill("#wager", "100"); await a.click("#playBtn");
        await a.locator("#duelHit").waitFor({ state: "visible" });
        check((await a.locator("#duelLiveStage").textContent()).includes("arena_bob"), "human opponent label");
        check(await a.locator("#duelBlackjackTrumps select[data-trump] option").count() === 16, "all 15 trumps visible");
        await screens(a, "blackjack-pvp"); await screens(b, "blackjack-opponent");
        await a.click("#duelStand"); await b.locator("#duelStand").waitFor({ state: "visible" }); await b.click("#duelStand");
        await a.waitForFunction(() => !document.querySelector("#duelLiveSummary").textContent.includes("pontos"));
        await a.evaluate(() => { if (!Sfx.isEnabled()) Sfx.toggle(); Sfx.battleStart(); });
        await a.waitForTimeout(100);
        const families = ["dice", "coin", "rocket", "boom", "gem", "spin", "spinSlots", "card", "horse", "plinkoPeg", "footballKick", "footballNet", "footballGoal", "whistle", "battleStart", "countdown"];
        for (const family of families) {
            check(await a.evaluate((name) => { const before = qaAudio.nodes; Sfx[name](); return qaAudio.nodes > before; }, family), "audio nodes " + family);
        }
        await a.evaluate(() => Sfx.toggle());
        check(await a.evaluate((families) => { const before = qaAudio.nodes; families.forEach((name) => Sfx[name]()); return before === qaAudio.nodes; }, families), "mute suppresses all game sounds");
        await a.waitForTimeout(200);
        check(await a.evaluate(() => qaAudio.gains[0].gain.value < .001), "mute silences already scheduled sounds");
        await solo.goto(base + "/blackjack.html");
        await solo.locator("#blackjackTrumps select[data-trump] option").nth(15).waitFor({ state: "attached" });
        await screens(solo, "blackjack-solo");
        await a.goto(base + "/blackjack-mp.html"); await b.goto(base + "/blackjack-mp.html");
        await a.evaluate(() => { const original = io; window.io = (...args) => { window.qaSocket = original(...args); return qaSocket; }; });
        await a.click("#createTableBtn"); await a.locator("#bjmpArena").waitFor({ state: "visible" });
        const table = await a.locator("#tableCode").textContent(); await b.fill("#joinCode", table); await b.click("#joinTableBtn");
        await a.click("#startBtn"); await a.locator("#actionsRow").waitFor({ state: "visible" }); await a.click("#specialsBtn");
        check(await a.locator("#bjBattleIntro .battle-avatar").count() === 2, "coop blackjack intro");
        await a.locator("#specialsList").getByText("Mais um", { exact: true }).waitFor();
        check(await a.locator("#specialsList .special-card").count() >= 15, "coop catalog visible, including action drops");
        check(await a.locator("#doubleBtn").isEnabled(), "coop double available");
        await screens(a, "blackjack-coop");
        check(await a.locator(".multiplayer-arena").evaluate((el, style) => getComputedStyle(el).backgroundColor === style.background && getComputedStyle(el).borderRadius === style.radius, arenaStyle), "Duel and Blackjack Coop share the dark arena style");
        await a.evaluate(() => { if (!Sfx.isEnabled()) Sfx.toggle(); window.qaCards = 0; const original = Sfx.card; Sfx.card = () => { qaCards++; original(); }; });
        await a.click("#hitBtn"); await a.waitForFunction(() => qaCards === 1);
        await a.evaluate((code) => new Promise((resolve) => qaSocket.emit("bj:join", { code }, resolve)), table);
        check(await a.evaluate(() => qaCards) === 1, "synchronizing Coop does not replay the card sound");
        await a.goto(base + "/rooms.html"); await b.goto(base + "/rooms.html");
        await a.click("#createRoomBtn"); await a.locator("#roomModal").waitFor({ state: "visible" });
        const room = await a.locator("#mRoomCode").textContent(); await b.fill("#joinCode", room); await b.click("#joinRoomBtn");
        await a.locator("#mPlayers li").nth(1).waitFor();
        await a.fill("#stakeAmount", "1000"); await a.click("#stakeBtn");
        await a.waitForFunction(() => document.querySelector("#mPot").textContent.includes("1.000"));
        check(await a.locator(".multiplayer-arena").evaluate((el, style) => getComputedStyle(el).backgroundColor === style.background && getComputedStyle(el).borderRadius === style.radius, arenaStyle), "Duel and standard Coop share the dark arena style");
        check(await a.locator("#mPlayers .player-avatar").count() === 2, "Coop roster shows both avatars");
        check((await a.locator("#mPlayers").textContent()).includes("arena_alice"), "Coop roster shows the actual player name");
        check(await a.locator(".room-roster").evaluate((roster) => roster.getBoundingClientRect().bottom <= document.querySelector(".room-game").getBoundingClientRect().top), "Coop roster is above the game");
        await screens(a, "coop-arena-layout");
        await a.goto(base + "/racing.html"); await b.goto(base + "/racing.html");
        await a.click("#createRaceBtn"); await a.locator("#raceWrap").waitFor({ state: "visible" });
        const race = await a.locator("#raceCode").textContent(); await b.fill("#joinCode", race); await b.click("#joinRaceBtn");
        await a.locator("#racePlayers li").nth(1).waitFor();
        check(await a.locator(".multiplayer-arena").evaluate((el, style) => getComputedStyle(el).backgroundColor === style.background && getComputedStyle(el).borderRadius === style.radius, arenaStyle), "Racing Coop also shares the dark arena");
        check(await a.locator("#racePlayers .player-avatar").count() === 2, "Racing Coop shows both avatars");
        for (const page of [a, b]) { await page.locator("[data-horse]").first().click(); await page.fill("#betAmount", "10"); await page.click("#betBtn"); await page.locator("#myBets .bet-entry").waitFor(); }
        await screens(a, "racing-coop");
        await a.click("#startRaceBtn"); await a.locator("#raceBattleIntro .battle-avatar").nth(1).waitFor();
        check(await a.locator("#raceBattleIntro .battle-avatar").count() === 2, "Racing Coop starts with both betting players");
        await b.reload(); await b.locator("#racePlayers .player-avatar").nth(1).waitFor();
        check((await b.locator("#racePlayers").textContent()).includes("arena_bob"), "Racing Coop reconnect restores identities");
        await a.locator("#raceResults").waitFor({ state: "visible", timeout: 20000 });
        check((await a.locator("#raceResults").textContent()).includes("venceu"), "Racing Coop still settles normally");
        await solo.goto(base + "/dice.html");
        await solo.evaluate(() => { window.qaDice = 0; const original = Sfx.dice; Sfx.dice = () => { qaDice++; original(); }; });
        await solo.locator(".number-button").first().click(); await solo.fill("#betAmount", "10"); await solo.click("#rollButton");
        await solo.waitForFunction(() => qaDice === 1);
        check(await solo.evaluate(() => qaDice) === 1, "Solo Dice roll audio is wired");
        await solo.goto(base + "/coinflip.html");
        await solo.evaluate(() => { window.qaCoin = 0; const original = Sfx.coin; Sfx.coin = () => { qaCoin++; original(); }; });
        await solo.fill("#coinWager", "10"); await solo.click("#coinPlay"); await solo.waitForFunction(() => qaCoin === 1);
        check(await solo.evaluate(() => qaCoin) === 1, "Solo Coin Flip audio is wired");
        check(errors.length === 0, "browser errors: " + errors.join("; "));
        console.log(JSON.stringify({ checks, screenshots: output, errors }));
    } finally {
        await browser?.close(); child.kill();
        if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
