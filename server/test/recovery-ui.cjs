const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-recovery-ui-"));
Object.assign(process.env, { NODE_ENV: "test", DB_PATH: path.join(temporary, "qa.db"), TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", REQUIRE_PERSISTENT_DB: "0" });
const pool = require("../src/config/database"), bcrypt = require("bcryptjs");
const { createRecovery } = require("../src/services/recovery");
const { createRouter } = require("../src/routes/recovery.routes");
const express = require("express"), messages = [];
const app = express();
app.use(express.json({ limit: "64kb" }));
const output = path.resolve(__dirname, "../../../visual-output/recovery");
fs.mkdirSync(output, { recursive: true });
let server, browser;
(async () => {
    try {
        const id = pool.db.run("INSERT INTO users(username,email,password_hash) VALUES(?,?,?)", ["recovery_ui", "qa@example.test", await bcrypt.hash("OldTestPassword123!", 10)]).lastInsertRowid;
        for (const kind of ["solo", "duel", "coop"]) pool.db.run("INSERT INTO wallets(user_id,kind,balance) VALUES(?,?,?)", [id, kind, 500]);
        server = app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        const base = "http://127.0.0.1:" + server.address().port;
        app.use("/api/auth", createRouter(createRecovery({ origin: base, delayMs: 5, mail: { configured: true, send: async (to, subject, text) => messages.push({ to, subject, text }) } })));
        app.use(express.static(path.resolve(__dirname, "../..")));
        browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
        const page = await browser.newPage(), errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(base + "/recuperar-senha.html");
        await page.getByLabel("E-mail ou usuario").fill("recovery_ui");
        await page.getByRole("button", { name: "Enviar instrucoes", exact: true }).click();
        await page.getByRole("status").getByText("Se existir uma conta", { exact: false }).waitFor();
        assert.equal(messages.length, 1);
        const link = messages[0].text.match(/http[^\s]+/)[0];
        await page.goto("about:blank");
        await page.goto(link);
        await page.getByRole("heading", { name: "Definir nova senha", exact: true }).waitFor();
        assert.equal(new URL(page.url()).hash, "");
        await page.getByLabel("Nova senha", { exact: true }).fill("FreshUiPassword123!");
        await page.getByLabel("Confirmar senha", { exact: true }).fill("WrongPassword123!");
        await page.getByRole("button", { name: "Alterar senha", exact: true }).click();
        await page.getByText("As senhas nao conferem.", { exact: true }).waitFor();
        await page.getByLabel("Confirmar senha", { exact: true }).fill("FreshUiPassword123!");
        for (const width of [1280, 390, 320]) {
            await page.setViewportSize({ width, height: 850 });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await page.screenshot({ path: path.join(output, "reset-" + width + ".png") });
        }
        await page.getByRole("button", { name: "Alterar senha", exact: true }).click();
        await page.getByRole("status").getByText("Senha alterada", { exact: false }).waitFor();
        const user = pool.db.get("SELECT password_hash,token_version FROM users WHERE id=?", [id]);
        assert.ok(await bcrypt.compare("FreshUiPassword123!", user.password_hash));
        assert.equal(user.token_version, 1);
        assert.deepEqual(pool.db.all("SELECT balance FROM wallets WHERE user_id=?", [id]).map((row) => row.balance), [500, 500, 500]);
        await page.goto("about:blank");
        await page.goto(link);
        await page.getByLabel("Nova senha", { exact: true }).fill("AnotherPassword123!");
        await page.getByLabel("Confirmar senha", { exact: true }).fill("AnotherPassword123!");
        await page.getByRole("button", { name: "Alterar senha", exact: true }).click();
        await page.getByText("Link invalido ou expirado.", { exact: true }).waitFor();
        assert.deepEqual(errors, []);
        console.log("PASS recovery UI: request, URL token removal, confirmation, reset, session invalidation, unchanged wallets, replay rejection and 1280/390/320 layouts; fixture mail only.");
    } finally {
        await browser?.close();
        if (server) await new Promise((resolve) => server.close(resolve));
        pool.db.close();
        assert.equal(path.dirname(temporary), os.tmpdir());
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
})().catch((error) => { console.error(error); process.exitCode = 1; });
