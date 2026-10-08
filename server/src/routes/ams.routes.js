const express = require("express");
const { createPublicKey, verify } = require("node:crypto");
const { z } = require("zod");
const pool = require("../config/database");
const { disconnectUserSockets } = require("../middleware/auth");
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actionSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("inspect"), payload: z.object({}).strict() })
    .strict(),
  z
    .object({
      action: z.literal("profile"),
      payload: z
        .object({ displayName: z.string().trim().min(3).max(32) })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("suspension"),
      payload: z
        .object({ suspended: z.boolean(), expectedRevision: positive })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("revoke_sessions"),
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("balance"),
      payload: z
        .object({
          wallet: z.enum(["solo", "duel", "coop"]),
          delta: z
            .number()
            .int()
            .min(-1000000000)
            .max(1000000000)
            .refine((v) => v !== 0),
          expectedBalance: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal("grant_xp"),
      payload: z
        .object({
          amount: positive.max(100000),
          expectedXp: z.number().int().nonnegative(),
          expectedLevel: positive.max(999),
        })
        .strict(),
    })
    .strict(),
]);
const commandSchema = z
  .object({
    id: z.uuid(),
    actor: z
      .object({
        id: positive,
        username: z.string().max(64),
        role: z.enum(["owner", "dev", "worker"]),
      })
      .strict(),
    playerId: positive,
    action: z.string(),
    payload: z.unknown(),
    reason: z.string().trim().min(10).max(300),
  })
  .strict();
function fail(status, code, message) {
  const error = new Error(message);
  Object.assign(error, { status, code });
  throw error;
}
function busy(id) {
  if (pool.db.get("SELECT 1 FROM game_sessions WHERE user_id=?", [id]))
    return true;
  if (
    pool.db.get(
      "SELECT 1 FROM room_members rm JOIN room_pot p ON p.room_id=rm.room_id JOIN rooms r ON r.id=rm.room_id WHERE (rm.user_id=? OR r.host_id=?) AND (rm.stake>0 OR p.balance>0 OR p.pending_bets!='[]') LIMIT 1",
      [id, id],
    )
  )
    return true;
  return pool.db.all("SELECT mode,state FROM realtime_sessions").some((row) => {
    const state = require("../services/realtimeStore").decode(row.state);
    if (row.mode === "duel")
      return (
        state.phase !== "finished" &&
        Object.values(state.players).some((p) => p?.userId === id)
      );
    if (row.mode === "race")
      return state.phase !== "finished" && state.bets.has(id);
    return (
      row.mode === "blackjack" &&
      state.phase === "playing" &&
      state.players instanceof Map &&
      state.players.has(id)
    );
  });
}
function controls(id) {
  return (
    pool.db.get(
      "SELECT suspended,revision FROM account_controls WHERE user_id=?",
      [id],
    ) || { suspended: 0, revision: 1 }
  );
}
function execute(command) {
  const existing = pool.db.get(
    "SELECT command,result FROM ams_command_receipts WHERE id=?",
    [command.id],
  );
  if (existing) {
    if (existing.command !== JSON.stringify(command))
      fail(409, "KEY_REUSED", "Identificador ja usado para outra operacao.");
    return JSON.parse(existing.result);
  }
  const user = pool.db.get(
    "SELECT id,username,display_name,level,xp FROM users WHERE id=?",
    [command.playerId],
  );
  if (!user) fail(404, "NOT_FOUND", "Conta nao encontrada.");
  const state = controls(user.id);
  if (command.action === "inspect")
    return {
      suspended: Boolean(state.suspended),
      revision: state.revision,
      available: true,
    };
  if (!["owner", "dev"].includes(command.actor.role))
    fail(403, "FORBIDDEN", "Cargo sem permissao para alterar contas.");
  if (command.action === "grant_xp" && command.actor.role !== "owner")
    fail(403, "FORBIDDEN", "Ajuste de XP reservado ao Owner.");
  if (
    command.action === "balance" &&
    command.actor.role === "dev" &&
    Math.abs(command.payload.delta) > 1000000
  )
    fail(403, "FORBIDDEN", "Ajustes acima de um milhao de AC exigem Owner.");
  if (busy(user.id))
    fail(
      409,
      "PLAYER_BUSY",
      "Finalize partidas e saque participacoes no Coop antes de alterar esta conta.",
    );
  let result = { action: command.action, playerId: user.id },
    before = {},
    after = {};
  if (command.action === "profile") {
    before = { displayName: user.display_name };
    after = { displayName: command.payload.displayName };
    pool.db.run("UPDATE users SET display_name=? WHERE id=?", [
      after.displayName,
      user.id,
    ]);
  } else if (command.action === "suspension") {
    if (state.revision !== command.payload.expectedRevision)
      fail(409, "CONFLICT", "A conta mudou. Atualize antes de salvar.");
    before = state;
    after = {
      suspended: command.payload.suspended ? 1 : 0,
      revision: state.revision + 1,
    };
    pool.db.run(
      "INSERT INTO account_controls(user_id,suspended,revision) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET suspended=excluded.suspended,revision=excluded.revision",
      [user.id, after.suspended, after.revision],
    );
    pool.db.run("UPDATE users SET token_version=token_version+1 WHERE id=?", [
      user.id,
    ]);
  } else if (command.action === "revoke_sessions") {
    pool.db.run("UPDATE users SET token_version=token_version+1 WHERE id=?", [
      user.id,
    ]);
    after = { sessionsRevoked: true };
  } else if (command.action === "balance") {
    const wallet = pool.getWalletSync(user.id, command.payload.wallet);
    if (wallet.balance !== command.payload.expectedBalance)
      fail(409, "CONFLICT", "O saldo mudou. Atualize antes de salvar.");
    const next = wallet.balance + command.payload.delta;
    if (!Number.isSafeInteger(next) || next < 0)
      fail(
        400,
        "BALANCE_INVALID",
        "Saldo insuficiente ou fora do limite seguro.",
      );
    before = { wallet: wallet.kind, balance: wallet.balance };
    after = {
      wallet: wallet.kind,
      balance: pool.adjustBalanceSync(
        wallet.id,
        command.payload.delta,
        command.payload.delta > 0 ? "transfer_in" : "transfer_out",
        "ams_adjustment",
        command.id,
      ),
    };
  } else if (command.action === "grant_xp") {
    if (
      user.xp !== command.payload.expectedXp ||
      user.level !== command.payload.expectedLevel
    )
      fail(409, "CONFLICT", "A progressao mudou. Atualize antes de salvar.");
    before = { level: user.level, xp: user.xp };
    after = require("../services/progression").grantXP(
      user.id,
      command.payload.amount,
    );
  }
  result = { ...result, before, after };
  pool.db.run(
    "INSERT INTO ams_command_receipts(id,command,result,actor_name,reason,created_at) VALUES(?,?,?,?,?,?)",
    [
      command.id,
      JSON.stringify(command),
      JSON.stringify(result),
      command.actor.username,
      command.reason,
      Date.now(),
    ],
  );
  return result;
}
function createAmsRouter(publicKey = process.env.AMS_COMMAND_PUBLIC_KEY) {
  const router = express.Router();
  let key;
  if (publicKey) {
    key = createPublicKey({
      key: Buffer.from(publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("AMS requires an Ed25519 public key.");
  }
  router.post("/commands", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!key)
        fail(
          503,
          "CONNECTOR_DISABLED",
          "Integracao administrativa nao ativada.",
        );
      const envelope = z
        .object({
          issuedAt: z.number().int(),
          mfaVerifiedAt: z.number().int(),
          command: commandSchema,
        })
        .strict()
        .parse(req.body);
      const signature = req.get("X-AMS-Signature") || "";
      if (
        !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
        !verify(
          null,
          Buffer.from(JSON.stringify(envelope)),
          key,
          Buffer.from(signature, "base64url"),
        )
      )
        fail(403, "SIGNATURE_INVALID", "Assinatura administrativa invalida.");
      if (Math.abs(Date.now() - envelope.issuedAt) > 30000)
        fail(403, "SIGNATURE_EXPIRED", "Requisicao administrativa expirada.");
      const { command } = envelope;
      actionSchema.parse({ action: command.action, payload: command.payload });
      if (
        command.action !== "inspect" &&
        (envelope.mfaVerifiedAt > Date.now() + 30000 ||
          envelope.mfaVerifiedAt < Date.now() - 300000)
      )
        fail(403, "MFA_REQUIRED", "Validacao MFA expirada.");
      const { result, replayed } = pool.transactionSync(() => ({
        replayed: Boolean(
          pool.db.get("SELECT 1 FROM ams_command_receipts WHERE id=?", [
            command.id,
          ]),
        ),
        result: execute(command),
      }));
      if (
        !replayed &&
        ["suspension", "revoke_sessions"].includes(command.action)
      )
        disconnectUserSockets(command.playerId);
      res.json({ data: result });
    } catch (error) {
      res
        .status(error instanceof z.ZodError ? 400 : error.status || 503)
        .json({
          error: {
            code: error.code || "COMMAND_INVALID",
            message: error.status
              ? error.message
              : "Operacao administrativa indisponivel.",
          },
        });
    }
  });
  return router;
}
module.exports = { createAmsRouter, actionSchema };
