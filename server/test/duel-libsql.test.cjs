const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
test("Duel capital and trumps run with the official libSQL adapter", { skip: process.env.ARCADIA_OFFLINE_TEST === "1" }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-libsql-duel-"));
    try {
        const env = { ...process.env, ARCADIA_LIBSQL_TEST: "1", ARCADIA_TEST_DIRECTORY: directory };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ["--test", "test/duel-capital-trumps.test.cjs"], { cwd: path.resolve(__dirname, ".."), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let output = ""; child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => output += data);
        const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
        assert.equal(code, 0, output); assert.match(output, /pass [1-9]\d*/); assert.match(output, /fail 0/);
    } finally {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
});
