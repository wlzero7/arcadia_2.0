const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

async function check(script) {
    const child = spawn(process.execPath, [path.join(__dirname, script)], {
        cwd: path.resolve(__dirname, ".."), stdio: ["ignore", "pipe", "pipe"],
    });
    // These validation scripts emit only sanitized metrics, never SDK diagnostics.
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Validation timed out.")); }, 180000);
        child.once("error", () => { clearTimeout(timeout); reject(new Error("Validation could not start.")); });
        child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error("Validation failed; production remains unchanged.")); });
    });
}
async function main() {
    await check("check-turso.cjs");
    await check("check-turso-multiplayer.cjs");
    // The validation service exposes no registration, gameplay, accounts or database.
    http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.statusCode = req.url === "/api/health" ? 200 : 404;
        res.end(JSON.stringify(req.url === "/api/health" ? { status: "ok", database: "Turso", validated: true } : { status: "not_found" }));
    }).listen(Number(process.env.PORT) || 10000, "0.0.0.0", () => console.log("Render/Turso validation completed. Production was not changed."));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
