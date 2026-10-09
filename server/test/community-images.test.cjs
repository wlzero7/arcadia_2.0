const test = require("node:test"), assert = require("node:assert/strict");
const path = require("node:path"), fs = require("node:fs"), os = require("node:os");
const sharp = require("sharp");
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-images-")), "qa.db");
process.env.TURSO_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.REQUIRE_PERSISTENT_DB = "0";
if (process.env.ARCADIA_LIBSQL_TEST === "1") process.env.TURSO_DATABASE_URL = require("node:url").pathToFileURL(process.env.DB_PATH).href;
const pool = require("../src/config/database");
const community = require("../src/services/community"), media = require("../src/services/community-images");
const user = pool.db.run("INSERT INTO users(username,email,password_hash,level) VALUES('images','images@example.test','test',5)").lastInsertRowid;
const low = pool.db.run("INSERT INTO users(username,email,password_hash) VALUES('low','low@example.test','test')").lastInsertRowid;
test("image normalization rejects active, fake, oversize and excessive files", async () => {
    for (const images of [[Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>').toString("base64")], [Buffer.from("<html>not an image</html>").toString("base64")], ["%invalid"], ["a", "b", "c"], ["A".repeat(3 * 1024 * 1024)]]) await assert.rejects(media.normalize(images));
    const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    await assert.rejects(media.normalize([small.toString("base64")]));
    const tall = await sharp({ create: { width: 16, height: 4097, channels: 3, background: "red" } }).png().toBuffer();
    await assert.rejects(media.normalize([tall.toString("base64")]));
});
test("attachments commit with publications, survive reopen and respect feedback/removal", async () => {
    const input = await sharp({ create: { width: 1900, height: 900, channels: 3, background: "red" } }).withMetadata().jpeg().toBuffer();
    const normalized = await media.normalize([input.toString("base64")]);
    const metadata = await sharp(normalized[0].image).metadata();
    assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 1600); assert.equal(metadata.exif, undefined);
    const id = community.create(user, { category: "feedback", title: "Image feedback QA", body: "A feedback with safe attached images." }, normalized).id;
    const attached = community.detail(user, id).thread.images[0];
    assert.ok(Buffer.from(community.image(user, attached.id)).equals(normalized[0].image));
    assert.throws(() => community.image(low, attached.id), /nivel 5/);
    assert.throws(() => community.image(undefined, attached.id), /conta/);
    if (process.env.ARCADIA_LIBSQL_TEST === "1") {
        const otherDb = require("@libsql/client").createClient({ url: process.env.TURSO_DATABASE_URL });
        try {
            const persisted = await otherDb.execute("SELECT image FROM community_images");
            assert.equal(persisted.rows.length, 1);
            assert.ok(Buffer.from(persisted.rows[0].image).equals(normalized[0].image));
        } finally { otherDb.close(); }
    } else {
        const otherDb = new (require("node-sqlite3-wasm").Database)(process.env.DB_PATH);
        assert.equal(otherDb.get("SELECT COUNT(*) AS n FROM community_images").n, 1); otherDb.close();
    }
    const reply = community.reply(user, id, { body: "Image reply" }, normalized).id;
    const replyImage = community.detail(user, id).replies[0].images[0];
    community.moderate(user, id, { action: "remove", reason: "Removing QA attachment" }, reply);
    assert.throws(() => community.image(user, replyImage.id), /encontrada/);
    community.moderate(user, id, { action: "remove", reason: "Removing QA feedback" });
    assert.throws(() => community.image(user, attached.id), /encontrada/);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM community_images").n, 0);
});
test.after(() => pool.db.close());
test("quota rejection rolls back text and all images", async () => {
    const normalized = await media.normalize([(await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer()).toString("base64")]);
    const old = community.create(low, { title: "Old attachments QA", body: "Existing post for quota rollback testing." }).id;
    pool.db.run("UPDATE community_threads SET created_at=datetime('now','-2 minutes') WHERE id=?", [old]);
    for (let i = 0; i < 80; i++) pool.db.run("INSERT INTO community_images(user_id,thread_id,image,width,height) VALUES(?,?,?,?,?)", [low, old, normalized[0].image, 64, 64]);
    assert.throws(() => community.create(low, { title: "Should not persist", body: "This body must roll back with its images." }, normalized), /Limite/);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM community_threads WHERE user_id=?", [low]).n, 1);
    assert.equal(pool.db.get("SELECT COUNT(*) AS n FROM community_images WHERE user_id=?", [low]).n, 80);
});
