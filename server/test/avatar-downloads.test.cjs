const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const dns = require("node:dns/promises");
const https = require("node:https");
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-downloads-")), "test.db");
process.env.NODE_ENV = "test";
const avatars = require("../src/services/avatars");
function network(context, responses, lookup = async () => [{ address: "8.8.8.8", family: 4 }]) {
    const requests = [];
    context.mock.method(dns, "lookup", lookup);
    context.mock.method(https, "get", (url, options, callback) => {
        requests.push({ url, options });
        const req = new EventEmitter();
        req.destroy = (error) => { if (error) queueMicrotask(() => req.emit("error", error)); };
        const fixture = responses[requests.length - 1] || responses.at(-1);
        const response = new PassThrough();
        response.statusCode = fixture.status || 200;
        response.headers = fixture.headers || { "content-type": "image/png" };
        queueMicrotask(() => {
            callback(response);
            if (fixture.abort) { response.emit("aborted"); response.destroy(); }
            else { response.complete = true; response.end(fixture.body || Buffer.from("image bytes")); }
        });
        return req;
    });
    return requests;
}
test("public image downloads pin validated DNS to the socket, including all-address lookups", async (context) => {
    const requests = network(context, [{ body: Buffer.from("fixture") }]);
    assert.equal((await avatars.downloadImage("https://image.example/photo.png")).toString(), "fixture");
    requests[0].options.lookup("image.example", {}, (error, address, family) => {
        assert.ifError(error); assert.equal(address, "8.8.8.8"); assert.equal(family, 4);
    });
    requests[0].options.lookup("image.example", { all: true }, (error, addresses) => {
        assert.ifError(error); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
    });
});
test("every redirect is revalidated, including redirects to internal addresses", async (context) => {
    const requests = network(context, [{ status: 302, headers: { location: "https://internal.example/secret" } }], async (host) => [{ address: host === "internal.example" ? "127.0.0.1" : "8.8.8.8", family: 4 }]);
    await assert.rejects(avatars.downloadImage("https://image.example/a"), /nao permitido/);
    assert.equal(requests.length, 1);
});
test("relative redirects succeed and redirect loops stop after the fixed limit", async (context) => {
    const requests = network(context, [{ status: 302, headers: { location: "/new.png" } }, { body: Buffer.from("redirected") }]);
    assert.equal((await avatars.downloadImage("https://image.example/old.png")).toString(), "redirected");
    assert.equal(requests[1].url.pathname, "/new.png");
    context.mock.restoreAll();
    const loop = network(context, [{ status: 302, headers: { location: "/loop" } }]);
    await assert.rejects(avatars.downloadImage("https://image.example/loop")); assert.equal(loop.length, 4);
});
test("mixed private/public DNS answers, credentials, plaintext and custom ports are rejected", async (context) => {
    const requests = network(context, [{}], async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }]);
    for (const url of ["https://image.example/a", "https://user:password@image.example/a", "http://image.example/a", "https://image.example:8443/a"]) await assert.rejects(avatars.downloadImage(url));
    assert.equal(requests.length, 0);
});
test("oversized, invalid content and interrupted streams reject without keeping timers alive", async (context) => {
    for (const fixture of [
        { headers: { "content-type": "text/html" } },
        { headers: { "content-type": "image/png", "content-length": String(avatars.MAX_BYTES + 1) } },
        { body: Buffer.alloc(avatars.MAX_BYTES + 1) },
        { abort: true },
        { status: 302, headers: {} },
    ]) {
        context.mock.restoreAll(); network(context, [fixture]);
        await assert.rejects(avatars.downloadImage("https://image.example/a"));
    }
});
test.after(() => require("../src/config/database").db.close());
