const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-friend-ui-"));
const output = path.resolve(__dirname, "../../../visual-output/friends-community"); fs.mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ["src/server.js"], { cwd: root, windowsHide: true, env: { ...process.env, PORT: "0", NODE_ENV: "test", DB_PATH: path.join(temporary, "qa.db"), TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", REQUIRE_PERSISTENT_DB: "0", JWT_SECRET: "local-friend-qa-only-123456789" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser; child.stderr.on("data", (data) => logs += data);
(async () => {
    try {
        const base = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error("QA server startup failed")), 15000); child.stdout.on("data", (data) => { logs += data; const port = /localhost:(\d+)/.exec(logs)?.[1]; if (port) { clearTimeout(timeout); resolve("http://127.0.0.1:" + port); } }); });
        browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
        const contexts = [await browser.newContext(), await browser.newContext()];
        for (const [index, context] of contexts.entries()) {
            const result = await context.request.post(base + "/api/auth/register", { data: { username: "friend_user_" + index, email: "friend" + index + "@example.test", password: "TestingFriends123!" } });
            assert.equal(result.status(), 201);
        }
        const a = await contexts[0].newPage(), b = await contexts[1].newPage(), errors = [];
        for (const page of [a, b]) page.on("pageerror", (error) => errors.push(error.message));
        await a.goto(base + "/perfil.html"); await b.goto(base + "/perfil.html");
        await a.locator(".friends-empty").waitFor();
        await a.fill("#friendUsername", "friend_user_1"); await a.press("#friendUsername", "Enter");
        await a.locator("#friendRequests").getByText("Enviados", { exact: true }).waitFor();
        await b.reload(); await b.getByRole("button", { name: "Aceitar pedido", exact: true }).click();
        await b.locator(".friend-row").waitFor(); await a.reload(); await a.locator(".friend-row").waitFor();
        assert.equal(await a.locator(".friend-row .player-avatar").count(), 1);
        await a.getByRole("button", { name: "Favoritar", exact: true }).click();
        await a.getByRole("button", { name: "Remover favorito", exact: true }).waitFor();
        const friends = await (await contexts[0].request.get(base + "/api/friends")).json();
        assert.equal(friends.friends[0].favorite, 1); assert.equal(friends.friends[0].level, 1);
        await a.fill("#friendSearch", "not-present"); await a.locator(".friends-empty").waitFor(); await a.fill("#friendSearch", "friend_user_1"); await a.locator(".friend-row").waitFor();
        for (const width of [1280, 390, 320]) {
            await a.setViewportSize({ width, height: 900 }); await a.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
            assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "profile overflow " + width);
            await a.screenshot({ path: path.join(output, "friends-" + width + ".png"), fullPage: true });
            await a.evaluate(() => { const panel = document.querySelector(".friends-heading").parentElement; window.scrollTo({ top: scrollY + panel.getBoundingClientRect().top - document.querySelector(".header").getBoundingClientRect().height - 12, behavior: "instant" }); });
            await a.locator(".friends-heading").locator("..").screenshot({ path: path.join(output, "friends-panel-" + width + ".png") });
        }
        await a.goto(base + "/comunidade.html"); await a.locator("#totalTopics").getByText("0", { exact: true }).waitFor();
        await a.click("#newThread"); await a.fill("#threadTitle", "A social QA discussion"); await a.fill("#threadBody", "Testing persisted topic counters with two isolated users.");
        const picture = await require("sharp")({ create: { width: 640, height: 360, channels: 3, background: "#10b981" } }).png().toBuffer();
        const file = { name: "qa.png", mimeType: "image/png", buffer: picture };
        await a.locator("#threadImages").setInputFiles([file]); assert.equal(await a.locator("#threadPreviews img").count(), 1);
        await a.waitForFunction(() => document.querySelector("#threadPreviews img")?.naturalWidth > 0);
        await a.getByRole("button", { name: "Remover imagem 1", exact: true }).click(); assert.equal(await a.locator("#threadPreviews img").count(), 0);
        await a.locator("#threadImages").setInputFiles([file]); await a.locator("#composeForm button[type=submit]").click();
        await a.locator("#totalTopics").getByText("1", { exact: true }).waitFor();
        await a.locator("#threadContent .post-image img").waitFor(); assert.ok(await a.locator("#threadContent .post-image img").evaluate((img) => img.complete && img.naturalWidth > 0));
        await a.getByRole("button", { name: "Abrir imagem", exact: true }).click(); await a.locator("#fullImage").waitFor(); await a.getByRole("button", { name: "Fechar imagem", exact: true }).click();
        await a.fill("#replyBody", "My test reply"); await a.locator("#replyImages").setInputFiles([file]); await a.locator("#replyForm button[type=submit]").click(); await a.locator("#totalComments").getByText("1", { exact: true }).waitFor();
        for (const width of [1280, 390, 320]) { await a.setViewportSize({ width, height: 900 }); assert.ok(await a.locator("#threadDialog").evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth + 1), "image dialog overflow " + width); await a.screenshot({ path: path.join(output, "community-images-" + width + ".png") }); }
        await a.goto(base + "/perfil.html"); await a.locator("#communityTopics").getByText("1", { exact: true }).waitFor(); await a.locator("#communityComments").getByText("1", { exact: true }).waitFor();
        a.once("dialog", (dialog) => dialog.accept()); await a.getByRole("button", { name: "Remover amizade", exact: true }).click(); await a.locator(".friends-empty").waitFor();
        const after = await (await contexts[0].request.get(base + "/api/friends")).json(); assert.equal(after.friends.length, 0);
        assert.deepEqual(errors, []);
        console.log("PASS: requests sent/received, acceptance, real avatar/level, favorite, search, removal, community/profile counters, 1280/390/320 layouts; no browser errors.");
    } finally { await browser?.close(); child.kill(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
