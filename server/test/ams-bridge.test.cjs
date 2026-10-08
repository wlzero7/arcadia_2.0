const test = require("node:test"),
  assert = require("node:assert/strict"),
  { generateKeyPairSync, sign, randomUUID } = require("node:crypto");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  express = require("express"),
  jwt = require("jsonwebtoken");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-ams-"));
process.env.DB_PATH = path.join(directory, "test.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
const pool = require("../src/config/database"),
  { createAmsRouter } = require("../src/routes/ams.routes"),
  { verifySession, JWT_SECRET } = require("../src/middleware/auth");
const keys = generateKeyPairSync("ed25519"),
  publicKey = keys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
const app = express();
app.use(express.json());
app.use("/api/ams", createAmsRouter(publicKey));
app.use("/disabled", createAmsRouter(""));
let server, base, userId;
test.before(async () => {
  userId = pool.db.run(
    "INSERT INTO users(username,email,password_hash) VALUES('amsfixture','ams@example.test','fixture')",
  ).lastInsertRowid;
  pool.getWalletSync(userId);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  pool.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const command = (
  action = "profile",
  payload = { displayName: "Novo jogador" },
  role = "owner",
) => ({
  id: randomUUID(),
  actor: { id: 1, username: "wl07", role },
  playerId: userId,
  action,
  payload,
  reason: "Revisao solicitada pelo jogador",
});
async function send(
  command,
  extra = {},
  route = "/api/ams/commands",
  tamper = false,
) {
  const body = {
    issuedAt: Date.now(),
    mfaVerifiedAt: Date.now(),
    command,
    ...extra,
  };
  const signature = sign(
    null,
    Buffer.from(JSON.stringify(body)),
    keys.privateKey,
  ).toString("base64url");
  if (tamper) body.command.actor.role = "owner";
  const response = await fetch(base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AMS-Signature": signature,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}
test("connector stays disabled without a public key", async () =>
  assert.equal((await send(command(), {}, "/disabled/commands")).status, 503));
test("tampered roles, expired signatures, expired MFA and unknown operations are rejected", async () => {
  assert.equal(
    (
      await send(
        command("profile", { displayName: "Hacker" }, "worker"),
        {},
        undefined,
        true,
      )
    ).status,
    403,
  );
  assert.equal(
    (await send(command(), { issuedAt: Date.now() - 40000 })).status,
    403,
  );
  assert.equal((await send(command(), { mfaVerifiedAt: 0 })).status, 403);
  assert.equal(
    (await send(command("execute_sql", { sql: "DROP TABLE users" }))).status,
    400,
  );
});
test("Worker reads state without MFA but cannot alter; Dev cannot grant XP or large balances", async () => {
  assert.equal(
    (await send(command("inspect", {}, "worker"), { mfaVerifiedAt: 0 })).data
      .available,
    true,
  );
  assert.equal(
    (await send(command("profile", { displayName: "Worker edit" }, "worker")))
      .status,
    403,
  );
  assert.equal(
    (
      await send(
        command(
          "grant_xp",
          { amount: 100, expectedXp: 0, expectedLevel: 1 },
          "dev",
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await send(
        command(
          "balance",
          { wallet: "solo", delta: 1000001, expectedBalance: 1000000 },
          "dev",
        ),
      )
    ).status,
    403,
  );
});
test("signed balance changes are optimistic, audited and idempotent", async () => {
  const cmd = command(
    "balance",
    { wallet: "solo", delta: 50, expectedBalance: 1000000 },
    "dev",
  );
  assert.equal((await send(cmd)).data.after.balance, 1000050);
  assert.equal((await send(cmd)).data.after.balance, 1000050);
  assert.equal(pool.getWalletSync(userId).balance, 1000050);
  assert.equal(
    pool.db.get(
      "SELECT COUNT(*) AS n FROM transactions WHERE ref_type='ams_adjustment' AND ref_id=?",
      [cmd.id],
    ).n,
    1,
  );
  assert.equal(
    (await send({ ...cmd, reason: "Outra justificativa diferente" })).status,
    409,
  );
  assert.equal(
    (
      await send(
        command("balance", {
          wallet: "solo",
          delta: 1,
          expectedBalance: 1000000,
        }),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await send(
        command("balance", {
          wallet: "solo",
          delta: -1000100,
          expectedBalance: 1000050,
        }),
      )
    ).status,
    400,
  );
});
test("audit receipt failure rolls back wallet and ledger", async () => {
  pool.db.exec(
    "CREATE TRIGGER fail_ams BEFORE INSERT ON ams_command_receipts BEGIN SELECT RAISE(ABORT,'fixture'); END",
  );
  const cmd = command("balance", {
    wallet: "solo",
    delta: 50,
    expectedBalance: 1000050,
  });
  assert.equal((await send(cmd)).status, 503);
  pool.db.exec("DROP TRIGGER fail_ams");
  assert.equal(pool.getWalletSync(userId).balance, 1000050);
  assert.equal(
    pool.db.get("SELECT COUNT(*) AS n FROM transactions WHERE ref_id=?", [
      cmd.id,
    ]).n,
    0,
  );
});
test("active wager protects account mutations", async () => {
  pool.db.run(
    "INSERT INTO game_sessions(user_id,game,state) VALUES(?,'football','{}')",
    [userId],
  );
  assert.equal((await send(command())).error.code, "PLAYER_BUSY");
  pool.db.run("DELETE FROM game_sessions WHERE user_id=?", [userId]);
});
test("suspension revokes sessions and reactivation does not resurrect revoked tokens", async () => {
  const token = jwt.sign(
    { id: userId, username: "amsfixture", v: 0 },
    JWT_SECRET,
  );
  assert.equal(verifySession(token).id, userId);
  assert.equal(
    (
      await send(
        command("suspension", { suspended: true, expectedRevision: 1 }),
      )
    ).status,
    200,
  );
  assert.throws(() => verifySession(token));
  const suspended = jwt.sign(
    { id: userId, username: "amsfixture", v: 1 },
    JWT_SECRET,
  );
  assert.throws(() => verifySession(suspended), /suspensa/);
  assert.equal(
    (
      await send(
        command("suspension", { suspended: false, expectedRevision: 2 }),
      )
    ).status,
    200,
  );
  assert.throws(() => verifySession(suspended));
  const fresh = jwt.sign(
    { id: userId, username: "amsfixture", v: 2 },
    JWT_SECRET,
  );
  assert.equal(verifySession(fresh).id, userId);
});
test("Owner grants XP through the existing progression rules", async () => {
  const before = pool.db.get("SELECT level,xp FROM users WHERE id=?", [userId]);
  const result = await send(
    command("grant_xp", {
      amount: 100,
      expectedXp: before.xp,
      expectedLevel: before.level,
    }),
  );
  assert.equal(result.status, 200);
  assert.equal(
    pool.db.get("SELECT xp FROM users WHERE id=?", [userId]).xp,
    100,
  );
});
test("duplicate revocation does not disconnect newly authenticated sessions", async () => {
  const { sessionSockets } = require("../src/middleware/auth");
  let disconnects = 0;
  sessionSockets.set(
    userId,
    new Set([
      {
        disconnect() {
          disconnects++;
        },
      },
    ]),
  );
  const cmd = command("revoke_sessions", {});
  assert.equal((await send(cmd)).status, 200);
  assert.equal(disconnects, 1);
  const version = pool.db.get("SELECT token_version FROM users WHERE id=?", [
    userId,
  ]).token_version;
  const fresh = jwt.sign(
    { id: userId, username: "amsfixture", v: version },
    JWT_SECRET,
  );
  sessionSockets.set(
    userId,
    new Set([
      {
        disconnect() {
          disconnects++;
        },
      },
    ]),
  );
  assert.equal((await send(cmd)).status, 200);
  assert.equal(disconnects, 1);
  assert.equal(verifySession(fresh).id, userId);
  sessionSockets.delete(userId);
});
