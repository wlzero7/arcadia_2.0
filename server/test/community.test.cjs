const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-community-"));
Object.assign(process.env, { DB_PATH: path.join(directory, "game.db"), NODE_ENV: "test", TURSO_DATABASE_URL: "", TURSO_AUTH_TOKEN: "", REQUIRE_PERSISTENT_DB: "" });
if (process.env.ARCADIA_LIBSQL_TEST === "1") process.env.TURSO_DATABASE_URL = require("node:url").pathToFileURL(process.env.DB_PATH).href;
require("./support.cjs");
const pool = require("../src/config/database");
const community = require("../src/services/community");
const user = (name, level) => Number(pool.db.run("INSERT INTO users(username,email,password_hash,level) VALUES(?,?,?,?)", [name, name + "@example.test", "hash", level]).lastInsertRowid);
const low = user("new_player", 4), high = user("regular_player", 5), owner = user("wl07", 5);
const payload = (category = "discussion") => ({ category, title: "Minha ideia para o Arcadia", body: "Podemos conversar sobre melhorias nos jogos e nas salas." });
const hasStatus = (status) => (error) => error instanceof community.CommunityError && error.status === status;
test.beforeEach(() => {
    pool.db.exec("DELETE FROM community_moderation; DELETE FROM community_threads;");
    pool.db.run("UPDATE users SET level=5 WHERE id=?", [high]);
});
test.after(() => pool.db.close());

test("registered users discuss and visitors read public threads", () => {
    const item = community.create(low, payload());
    assert.equal(community.list(null).items[0].id, item.id);
    assert.equal(community.detail(null, item.id).thread.title, payload().title);
    assert.equal(community.access(low).canFeedback, false);
});
test("visitors cannot publish, like, reply or read feedback", () => {
    assert.throws(() => community.create(null, payload()), hasStatus(401));
    const item = community.create(high, payload("feedback"));
    assert.throws(() => community.list(null, { category: "feedback" }), hasStatus(401));
    assert.throws(() => community.detail(null, item.id), hasStatus(401));
    assert.throws(() => community.like(null, item.id, { liked: true }), hasStatus(401));
    assert.throws(() => community.reply(null, item.id, { body: "Excelente ideia" }), hasStatus(401));
});
test("level four cannot bypass feedback restrictions with supplied client metadata", () => {
    const item = community.create(high, payload("feedback"));
    assert.throws(() => community.create(low, { ...payload("feedback"), level: 100, moderator: true }), hasStatus(403));
    assert.throws(() => community.list(low, { category: "feedback" }), hasStatus(403));
    assert.throws(() => community.detail(low, item.id), hasStatus(403));
    assert.throws(() => community.reply(low, item.id, { body: "Quero acessar feedback" }), hasStatus(403));
    assert.throws(() => community.like(low, item.id, { liked: true }), hasStatus(403));
});
test("level five reads and publishes feedback and access is rechecked after a downgrade", () => {
    const item = community.create(high, payload("feedback"));
    assert.equal(community.list(high, { category: "feedback" }).items.length, 1);
    assert.ok(community.reply(high, item.id, { body: "Complementando minha ideia" }).id);
    pool.db.run("UPDATE users SET level=4 WHERE id=?", [high]);
    assert.throws(() => community.detail(high, item.id), hasStatus(403));
});
test("likes are explicit and idempotent", () => {
    const item = community.create(low, payload());
    community.like(high, item.id, { liked: true });
    community.like(high, item.id, { liked: true });
    assert.equal(community.detail(high, item.id).thread.likes, 1);
    community.like(high, item.id, { liked: false });
    community.like(high, item.id, { liked: false });
    assert.equal(community.detail(high, item.id).thread.likes, 0);
    assert.throws(() => community.like(high, item.id, { liked: "true" }), hasStatus(400));
});
test("post and reply cooldowns persist in the database", () => {
    const item = community.create(low, payload());
    assert.throws(() => community.create(low, payload()), hasStatus(429));
    community.reply(high, item.id, { body: "Uma primeira resposta" });
    assert.throws(() => community.reply(high, item.id, { body: "Mais uma resposta" }), hasStatus(429));
    pool.db.exec("UPDATE community_threads SET created_at=datetime('now','-2 minutes'); UPDATE community_replies SET created_at=datetime('now','-20 seconds');");
    assert.ok(community.create(low, payload()).id);
    assert.ok(community.reply(high, item.id, { body: "Resposta apos o intervalo" }).id);
});
test("thread owners close and reopen with an audit reason", () => {
    const item = community.create(low, payload());
    community.moderate(low, item.id, { action: "close", reason: "Assunto resolvido" });
    assert.throws(() => community.reply(high, item.id, { body: "Mais uma ideia" }), hasStatus(409));
    community.moderate(low, item.id, { action: "reopen", reason: "Novas sugestoes" });
    assert.ok(community.reply(high, item.id, { body: "Mais uma ideia" }).id);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM community_moderation").n, 2);
});
test("users cannot moderate another author but wl07 can", () => {
    const item = community.create(low, payload());
    assert.throws(() => community.moderate(high, item.id, { action: "remove", reason: "Quero remover" }), hasStatus(403));
    community.moderate(owner, item.id, { action: "remove", reason: "Mensagem fora das regras" });
    assert.equal(community.list(null).items.length, 0);
    assert.throws(() => community.detail(low, item.id), hasStatus(404));
    assert.equal(pool.db.get("SELECT actor_id FROM community_moderation").actor_id, owner);
});
test("reply removal checks ownership and belongs to the correct thread", () => {
    const item = community.create(low, payload()), other = community.create(high, payload());
    const reply = community.reply(high, item.id, { body: "Uma resposta moderavel" });
    assert.throws(() => community.moderate(low, item.id, { action: "remove", reason: "Remover resposta" }, reply.id), hasStatus(403));
    assert.throws(() => community.moderate(owner, other.id, { action: "remove", reason: "Remover resposta" }, reply.id), hasStatus(404));
    community.moderate(high, item.id, { action: "remove", reason: "Corrigir minha resposta" }, reply.id);
    assert.equal(community.detail(null, item.id).replies.length, 0);
});
test("moderation is rolled back if its audit fails", () => {
    const item = community.create(low, payload());
    pool.db.exec("CREATE TRIGGER fail_community_audit BEFORE INSERT ON community_moderation BEGIN SELECT RAISE(ABORT,'test failure'); END;");
    try {
        assert.throws(() => community.moderate(owner, item.id, { action: "remove", reason: "Teste atomico" }));
        assert.equal(community.detail(null, item.id).thread.removed, 0);
    } finally { pool.db.exec("DROP TRIGGER fail_community_audit"); }
});
test("bounded pagination, escaped search and sensitive field projections", () => {
    for (let i = 0; i < 5; i++) {
        pool.db.exec("UPDATE community_threads SET created_at=datetime('now','-2 minutes');");
        community.create(low, { ...payload(), title: "Topico numero " + i });
    }
    const first = community.list(null, { limit: 2 });
    const second = community.list(null, { limit: 2, before: first.nextCursor });
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
    assert.equal(community.list(null, { search: "%" }).items.length, 0);
    assert.throws(() => community.list(null, { limit: 100000 }), hasStatus(400));
    assert.throws(() => community.detail(null, "1 OR 1=1"), hasStatus(400));
    assert.doesNotMatch(JSON.stringify(first), /password_hash|email|token_version/);
});
test("content limits and categories reject invalid input without awarding XP", () => {
    assert.throws(() => community.create(low, { ...payload(), category: "private" }), hasStatus(400));
    assert.throws(() => community.create(low, { ...payload(), title: "tiny" }), hasStatus(400));
    assert.throws(() => community.create(low, { ...payload(), body: "a".repeat(6001) }), hasStatus(400));
    community.create(low, { ...payload(), title: "<script>alert(1)</script>" });
    assert.equal(pool.db.get("SELECT xp FROM users WHERE id=?", [low]).xp, 0);
});
