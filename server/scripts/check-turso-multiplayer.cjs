const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.turso-test"), quiet: true });
let stage = "configuracao", controller, pool;
const users = [], codes = [];
async function main() {
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error("Private configuration missing.");
    process.env.REQUIRE_PERSISTENT_DB = "1";
    stage = "inicializar schema";
    pool = require("../src/config/database");
    const { FakeIO } = require("../test/support.cjs");
    const { setupMultiplayer, rooms } = require("../src/realtime/rooms");
    const io = new FakeIO(); controller = setupMultiplayer(io);
    const prefix = "load_" + crypto.randomBytes(6).toString("hex");
    stage = "criar contas temporarias";
    const created = pool.batchSync(Array.from({ length: 16 }, (_, i) => ({ method: "get", sql: "INSERT INTO users (username,email,password_hash) VALUES (?,?,?) RETURNING id", params: [prefix + i, prefix + i + "@example.test", "disabled-validation-account"] })));
    users.push(...created.map((row) => row.id));
    pool.batchSync(users.flatMap((id) => ["solo", "duel", "coop"].map((kind) => ({ sql: "INSERT INTO wallets (user_id,kind,balance) VALUES (?,?,1000000)", params: [id, kind] }))));
    const sockets = users.map((id) => io.connect(id));
    const made = sockets[0].call("room:create", { game: "roulette", maxPlayers: 16 });
    assert.equal(made.ok, true); codes.push(made.room.code);
    stage = "preparar sala cheia";
    for (let i = 0; i < sockets.length; i++) {
        if (i) assert.equal(sockets[i].call("room:join", { code: made.room.code }).ok, true);
        assert.equal(sockets[i].call("room:stake", { amount: 1000 }).ok, true);
    }
    for (const socket of sockets) assert.equal(socket.call("room:rbet", { type: "red", amount: 100 }).ok, true);
    stage = "liquidar rodada com 16 jogadores";
    const start = performance.now();
    const result = sockets[0].call("room:rspin", {});
    const duration = Math.round(performance.now() - start);
    assert.equal(result.ok, true, "Full-room settlement failed.");
    const room = rooms.get(made.room.code);
    assert.equal(room.rBets.length, 0);
    assert.equal([...room.stakes.values()].reduce((sum, n) => sum + n, 0), room.pot);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id IN (" + users.map(() => "?").join(",") + ")", users).n, 16);
    console.log(JSON.stringify({ status: "ok", jogadores: 16, liquidacaoMs: duration, regiaoTestada: process.env.RENDER ? "Render -> Turso" : "computador do proprietario -> Turso", renderAindaPendente: !process.env.RENDER }));
    if (duration >= 3000) { console.error("Sem margem segura para a regiao do Render: ajustar antes de publicar."); process.exitCode = 3; }
}
async function cleanup() {
    controller?.close();
    if (!users.length) return;
    const client = require("@libsql/client").createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    try {
        await client.batch([
            ...codes.map((code) => ({ sql: "DELETE FROM rooms WHERE code=?", args: [code] })),
            ...users.map((id) => ({ sql: "DELETE FROM users WHERE id=?", args: [id] })),
        ], "write");
        console.log("Contas e sala de teste removidas.");
    } catch (_) { console.error("Limpeza pendente das contas temporarias de validacao; nao foram alteradas contas reais."); process.exitCode = 1; }
    finally { client.close(); }
}
main().catch(() => { console.error(JSON.stringify({ status: "failed", etapa: stage, publicar: false })); process.exitCode = 1; }).finally(cleanup);
