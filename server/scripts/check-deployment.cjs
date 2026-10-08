const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.turso-test"), quiet: true });
const privateState = path.resolve(__dirname, "../.env.deployment-probe");
const base = "https://arcadia-780b.onrender.com";
const balances = { solo: 941337, duel: 854321, coop: 765432 };
let stage = "configuracao", client, state;
async function request(route, options = {}) {
    return fetch(base + route, { ...options, headers: { ...options.headers, ...(state?.cookie ? { Cookie: state.cookie } : {}) }, signal: AbortSignal.timeout(30000) });
}
async function verify() {
    stage = "ler conta pelo site";
    const response = await request("/api/auth/me");
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.user.id, state.id); assert.equal(data.user.username, state.username);
    assert.equal(data.user.xp, 17); assert.equal(data.user.level, 1);
    assert.deepEqual(data.wallets, balances);
    if (state.avatar) {
        assert.equal(data.user.avatar, state.avatar);
        stage = "foto publicada e banco";
        const picture = await request(state.avatar);
        assert.equal(picture.status, 200);
        const remote = await client.execute({ sql: "SELECT image FROM avatar_images WHERE user_id=?", args: [state.id] });
        assert.equal(remote.rows.length, 1);
        assert.deepEqual(Buffer.from(await picture.arrayBuffer()), Buffer.from(remote.rows[0].image));
    }
}
async function cleanup() {
    if (!state?.id) return;
    stage = "limpar somente a conta descartavel";
    const removed = await client.execute({ sql: "DELETE FROM users WHERE id=? AND username=? AND password_hash=?", args: [state.id, state.username, "disabled-deployment-validation"] });
    assert.equal(removed.rowsAffected, 1);
    if (fs.existsSync(privateState)) fs.unlinkSync(privateState);
    console.log("Conta descartavel e checkpoint privado removidos.");
}
async function main() {
    assert.ok(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN);
    client = require("@libsql/client").createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    const action = process.argv[2];
    if (action === "verify" || action === "cleanup") {
        state = JSON.parse(fs.readFileSync(privateState, "utf8"));
        assert.equal(state.base, base);
        assert.match(state.username, /^verify_[a-f0-9]{12}$/);
        if (action === "verify") {
            await verify();
            console.log(JSON.stringify({ status: "ok", aposRestart: true, conta: true, carteiras: true, sessao: true, fotoNoTurso: true }));
        }
        await cleanup();
        return;
    }
    assert.equal(action, "prepare");
    assert.equal(fs.existsSync(privateState), false, "An earlier probe must be verified or cleaned first.");
    state = { base, username: "verify_" + crypto.randomBytes(6).toString("hex") };
    stage = "cadastro pelo site publicado";
    const registration = await request("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: state.username, email: state.username + "@example.test", password: crypto.randomBytes(24).toString("hex") }) });
    assert.equal(registration.status, 201);
    const data = await registration.json();
    state.id = data.user.id;
    state.cookie = registration.headers.getSetCookie().find((cookie) => cookie.startsWith("arcadia_token="))?.split(";")[0];
    assert.ok(state.cookie);
    stage = "confirmar banco remoto e preparar marcadores";
    const account = await client.execute({ sql: "SELECT id FROM users WHERE username=?", args: [state.username] });
    assert.equal(account.rows[0]?.id, state.id);
    await client.batch([
        { sql: "UPDATE users SET password_hash=?,xp=17,level=1 WHERE id=?", args: ["disabled-deployment-validation", state.id] },
        ...Object.entries(balances).map(([kind, balance]) => ({ sql: "UPDATE wallets SET balance=? WHERE user_id=? AND kind=?", args: [balance, state.id, kind] })),
    ], "write");
    fs.writeFileSync(privateState, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    await verify();
    stage = "upload de foto pelo site";
    const photo = await require("sharp")({ create: { width: 256, height: 256, channels: 3, background: "#23b49c" } }).png().toBuffer();
    const uploaded = await request("/api/avatars/upload", { method: "POST", headers: { "Content-Type": "image/png" }, body: photo });
    assert.equal(uploaded.status, 200);
    state.avatar = (await uploaded.json()).avatar;
    fs.writeFileSync(privateState, JSON.stringify(state), { mode: 0o600 });
    await verify();
    console.log(JSON.stringify({ status: "ok", etapa: "antes do restart", cadastro: true, siteUsaTurso: true, carteiras: true, foto: true, checkpointPrivado: true }));
}
main().catch(() => {
    console.error(JSON.stringify({ status: "failed", etapa: stage, publicarValidacao: false, checkpointPreservado: fs.existsSync(privateState) }));
    process.exitCode = 1;
}).finally(() => client?.close());
