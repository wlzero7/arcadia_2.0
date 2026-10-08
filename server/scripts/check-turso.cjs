const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.turso-test"), quiet: true });
let stage = "configuracao";

async function main() {
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
        console.error("Preencha a configuracao privada server/.env.turso-test. Nao envie o token no chat.");
        process.exitCode = 2;
        return;
    }
    process.env.REQUIRE_PERSISTENT_DB = "1";
    stage = "inicializar schema";
    const pool = require("../src/config/database");
    assert.equal(pool.remote, true);
    stage = "carregar modulos do jogo";
    const { settleInstant } = require("../src/services/rounds");
    const existingName = process.env.ARCADIA_TURSO_VERIFY_USER;
    if (existingName) {
        stage = "verificar persistencia";
        const user = pool.db.get("SELECT id FROM users WHERE username = ?", [existingName]);
        assert.ok(user, "Account must survive a fresh process without a local database.");
        assert.equal(pool.getWalletSync(user.id).balance, 1310040);
        for (const kind of ["solo", "duel", "coop"]) {
            const wallet = pool.getWalletSync(user.id, kind);
            assert.equal(wallet.balance, kind === "solo" ? 1310040 : 1310000);
            const rewards = pool.db.get("SELECT COUNT(*) AS n, SUM(amount) AS total FROM transactions WHERE wallet_id = ? AND ref_type IN ('achievement', 'mission')", [wallet.id]);
            assert.equal(rewards.n, 4); assert.equal(rewards.total, 310000);
        }
        assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ?", [user.id]).n, 2);
        assert.equal(pool.db.get("SELECT progress FROM user_missions WHERE user_id = ? AND mission_key = 'daily_play_10'", [user.id]).progress, 2);
        assert.ok(Buffer.from(pool.db.get("SELECT image FROM avatar_images WHERE user_id = ?", [user.id]).image).length);
        pool.db.run("DELETE FROM users WHERE id = ?", [user.id]);
        pool.db.close();
        console.log("Persistencia apos reinicio e limpeza da conta de teste: OK.");
        return;
    }
    const metrics = [];
    let requests = 0;
    for (const method of ["exec", "get", "all", "run", "batch"]) {
        const original = pool.db[method];
        if (original) pool.db[method] = (...args) => { requests++; return original(...args); };
    }
    function measure(label, fn) {
        stage = label;
        const count = requests, start = performance.now();
        const result = fn();
        metrics.push({ teste: label, ms: Math.round(performance.now() - start), requisicoes: requests - count });
        return result;
    }
    const name = "persist_" + crypto.randomBytes(8).toString("hex");
    const id = measure("Criar conta", () => pool.transactionSync(() => {
        const id = pool.db.run("INSERT INTO users (username,email,password_hash) VALUES (?,?,?)", [name, name + "@example.test", "disabled-validation-account"]).lastInsertRowid;
        pool.batchSync(["solo", "duel", "coop"].map((kind) => ({ sql: "INSERT INTO wallets (user_id,kind,balance) VALUES (?,?,1000000)", params: [id, kind] })));
        return id;
    }));
    measure("Primeira aposta com conquistas", () => settleInstant(id, "dice", 100, 140, "win", { picked: 6, roll: 6 }));
    measure("Segunda aposta sem recompensa duplicada", () => settleInstant(id, "dice", 100, 100, "push", { picked: 6, roll: 6 }));
    const missions = require("../src/services/progression.routes");
    missions.trackLoginActivity(id);
    measure("Missao nas tres carteiras", () => missions.claimMission(id, "daily_login"));
    assert.throws(() => missions.claimMission(id, "daily_login"));
    const before = pool.getWalletSync(id).balance;
    stage = "rollback";
    assert.throws(() => pool.transactionSync(() => {
        pool.adjustBalanceSync(pool.getWalletSync(id).id, -100, "bet", "validation");
        throw new Error("intentional rollback");
    }), /intentional rollback/);
    assert.equal(pool.getWalletSync(id).balance, before);
    const image = await require("sharp")({ create: { width: 256, height: 256, channels: 3, background: "#19cbb3" } }).webp().toBuffer();
    measure("Persistir foto", () => require("../src/services/avatars").saveImage(id, image));
    pool.db.close();
    stage = "reinicio";
    const verified = spawnSync(process.execPath, [__filename], {
        env: { ...process.env, ARCADIA_TURSO_VERIFY_USER: name }, encoding: "utf8", timeout: 60000,
    });
    // Never forward SDK diagnostics: they can contain the private connection URL.
    assert.equal(verified.status, 0, "Fresh-process verification failed; temporary validation account was preserved.");
    console.log(JSON.stringify({ status: "ok", rollback: true, reinicio: true, foto: true, metrics }, null, 2));
    if (metrics.some((item) => item.ms >= 3000)) {
        console.error("Latencia acima da margem segura. Nao publicar antes de ajustar e testar partidas multiplayer.");
        process.exitCode = 3;
    }
}
main().catch((error) => {
    console.error("Validacao Turso falhou. Confira a configuracao privada e os limites no painel. Nenhum segredo foi exibido; nao publicar.");
    console.error(JSON.stringify({ etapa: stage, codigo: /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code || "") ? error.code : null, tipo: /^[A-Za-z]{1,40}$/.test(error.name || "") ? error.name : "Error", operacao: error.operation || null, comando: error.command || null, rollbackFalhou: error.rollbackFailed === true }));
    process.exitCode = 1;
});
