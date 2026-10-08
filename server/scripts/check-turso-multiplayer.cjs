const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
require("dotenv").config({ path: path.resolve(__dirname, "../.env.turso-test"), quiet: true });
let stage = "configuracao", controller, blackjack, pool;
const users = [], codes = [], tables = [];
async function main() {
    if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) throw new Error("Private configuration missing.");
    process.env.REQUIRE_PERSISTENT_DB = "1";
    stage = "inicializar schema";
    pool = require("../src/config/database");
    const { FakeIO } = require("../test/support.cjs");
    const { setupMultiplayer, rooms } = require("../src/realtime/rooms");
    const io = new FakeIO(); controller = setupMultiplayer(io);
    blackjack = require("../src/realtime/blackjack-mp").setupBlackjackMultiplayer(io);
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
    stage = "preparar Blackjack com 8 jogadores";
    const bjSockets = sockets.slice(0, 8);
    assert.equal(bjSockets[0].call("bj:create", {}).ok, true);
    const tableCode = bjSockets[0].data.tableCode; tables.push(tableCode);
    for (const [index, socket] of bjSockets.entries()) {
        if (index) assert.equal(socket.call("bj:join", { code: tableCode }).ok, true);
        assert.equal(socket.call("bj:bet", { amount: 1000 }).ok, true);
    }
    stage = "iniciar Blackjack com 8 jogadores";
    const dealStart = performance.now();
    assert.equal(bjSockets[0].call("bj:start", {}).ok, true);
    const dealMs = Math.round(performance.now() - dealStart);
    const table = blackjack.tables.get(tableCode);
    for (const [index, id] of table.order.entries()) table.players.get(id).hand = [{ rank: index < 6 ? "A" : "10", suit: "S" }, { rank: "K", suit: "H" }];
    let settleMs = 0;
    while (table.phase === "playing") {
        stage = "liquidar Blackjack com 8 jogadores";
        const socket = bjSockets.find((entry) => entry.userId === table.order[table.turnIdx]);
        const actionStart = performance.now();
        assert.equal(socket.call("bj:stand", {}).ok, true);
        settleMs = Math.max(settleMs, Math.round(performance.now() - actionStart));
    }
    assert.equal(table.pot, 0);
    assert.equal(table.results.reduce((sum, result) => sum + result.payout, 0), 8000);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE game='blackjack-mp' AND json_extract(detail,'$.tableCode')=?", [tableCode]).n, 8);
    console.log(JSON.stringify({ status: "ok", jogo: "Blackjack Coop", jogadores: 8, inicioMs: dealMs, maiorAcaoMs: settleMs, conservacao: true }));
    if (Math.max(dealMs, settleMs) >= 3000) { console.error("Blackjack sem margem segura: ajustar antes de publicar."); process.exitCode = 3; }
}
async function cleanup() {
    controller?.close();
    blackjack?.tables.clear();
    if (!users.length) return;
    const client = require("@libsql/client").createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
    try {
        await client.batch([
            ...codes.map((code) => ({ sql: "DELETE FROM rooms WHERE code=?", args: [code] })),
            ...tables.map((code) => ({ sql: "DELETE FROM realtime_sessions WHERE mode='blackjack' AND code=?", args: [code] })),
            ...users.map((id) => ({ sql: "DELETE FROM users WHERE id=?", args: [id] })),
        ], "write");
        console.log("Contas e sala de teste removidas.");
    } catch (_) { console.error("Limpeza pendente das contas temporarias de validacao; nao foram alteradas contas reais."); process.exitCode = 1; }
    finally { client.close(); }
}
main().catch((error) => { console.error(JSON.stringify({ status: "failed", etapa: stage, publicar: false, codigo: /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code || "") ? error.code : null, tipo: /^[A-Za-z]{1,40}$/.test(error.name || "") ? error.name : "Error" })); process.exitCode = 1; }).finally(cleanup);
