const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
test("real HTTP authentication, static file isolation, and game smoke tests", { skip: process.env.ARCADIA_OFFLINE_TEST === "1" }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arcadia-http-"));
    const child = spawn(process.execPath, ["src/server.js"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, PORT: "0", DB_PATH: path.join(directory, "test.db"), NODE_ENV: "test", JWT_SECRET: "integration-test-only-secret" }, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stderr.on("data", (data) => { logs += data; });
    let socket;
    try {
    const base = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Server startup timed out: " + logs)), 10000);
        child.stdout.on("data", (data) => {
            logs += data;
            const port = /http:\/\/localhost:(\d+)/.exec(logs)?.[1];
            if (port && port !== "0") { clearTimeout(timeout); resolve("http://127.0.0.1:" + port); }
        });
        child.once("exit", (code) => { clearTimeout(timeout); reject(new Error("Server exited " + code + ": " + logs)); });
    });
        const request = async (url, body, cookie, method = "POST", extraHeaders = {}) => {
            const response = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders }, ...(body ? { body: JSON.stringify(body) } : {}) });
            const data = await response.json().catch(() => ({}));
            return { status: response.status, data, cookie: response.headers.get("set-cookie"), headers: response.headers };
        };
        assert.equal((await request("/api/wallet", null, null, "GET")).status, 401);
        assert.equal((await request("/server/data/arcadia.db", null, null, "GET")).status, 404);
        assert.equal((await request("/server/src/config/database.js", null, null, "GET")).status, 404);
        assert.equal((await request("/api/health", null, null, "GET", { Origin: "https://evil.example" })).status, 403);
        const registration = await request("/api/auth/register", { username: "tester", email: "tester@example.test", password: "Testing123!" });
        assert.equal(registration.status, 201, JSON.stringify(registration.data));
        assert.match(registration.cookie, /HttpOnly/i); assert.equal(registration.data.token, undefined);
        assert.ok(registration.headers.get("content-security-policy"));
        const cookie = registration.cookie.split(";")[0];
        const missions = await request("/api/progression/missions", null, cookie, "GET");
        assert.equal(missions.status, 200);
        const loginMission = missions.data.missions.find((m) => m.key === "daily_login");
        assert.equal(loginMission.completed, true);
        const claim = await request("/api/progression/missions/claim", { missionKey: loginMission.key, period: loginMission.period }, cookie);
        assert.equal(claim.status, 200);
        assert.equal(claim.data.levelInfo.xp, 50);
        assert.equal((await request("/api/progression/missions/claim", { missionKey: loginMission.key, period: loginMission.period }, cookie)).status, 400);
        for (const page of ["/coinflip.html", "/missoes.html", "/css/coin-heads.svg", "/css/coin-tails.svg"]) assert.equal((await request(page, null, null, "GET")).status, 200);
        const { WebSocket } = require("ws");
        socket = new WebSocket(base.replace("http:", "ws:") + "/socket.io/?EIO=4&transport=websocket", { headers: { Cookie: cookie } });
        const acknowledgements = new Map();
        let nextAck = 1;
        const connected = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Socket connection timed out")), 5000);
            socket.on("message", (buffer) => {
                const packet = String(buffer);
                if (packet.startsWith("0")) socket.send("40");
                else if (packet === "2") socket.send("3");
                else if (packet.startsWith("40")) { clearTimeout(timeout); resolve(); }
                else if (packet.startsWith("44")) { clearTimeout(timeout); reject(new Error(packet)); }
                else if (packet.startsWith("43")) {
                    const match = /^43(\d+)(\[.*)$/.exec(packet);
                    if (match) { acknowledgements.get(Number(match[1]))?.(JSON.parse(match[2])[0]); acknowledgements.delete(Number(match[1])); }
                }
            });
            socket.on("error", reject);
        });
        await connected;
        const emit = (event, data = {}) => new Promise((resolve, reject) => {
            const id = nextAck++;
            const timeout = setTimeout(() => reject(new Error("Socket acknowledgement timed out: " + event)), 5000);
            acknowledgements.set(id, (value) => { clearTimeout(timeout); resolve(value); });
            socket.send("42" + id + JSON.stringify([event, data]));
        });
        assert.equal((await emit("room:create", { game: "coinflip" })).ok, true);
        assert.equal((await emit("room:stake", { amount: 100 })).ok, true);
        assert.equal((await request("/api/wallet?kind=coop", null, cookie, "GET")).data.balance, 999900);
        const coopFlip = await emit("room:play", { wager: 10, choice: { side: "heads" } });
        assert.equal(coopFlip.ok, true);
        assert.equal(coopFlip.round.type, "coinflip");
        assert.equal(coopFlip.round.payout, coopFlip.round.flip === "heads" ? 20 : 0);
        assert.equal((await emit("room:withdraw")).ok, true);
        assert.equal((await request("/api/wallet?kind=coop", null, cookie, "GET")).data.balance, 999990 + coopFlip.round.payout);
        assert.equal((await emit("room:withdraw")).ok, false);
        socket.close();
        assert.equal((await request("/api/auth/login", { email: "tester", password: "Testing123!" })).status, 200);
        assert.equal((await request("/api/auth/register", { username: "<img onerror=alert(1)>", email: "evil@example.test", password: "Testing123!" })).status, 400);
        for (const [url, body] of [
            ["/api/games/dice/play", { wager: 10, choice: { number: 1 } }],
            ["/api/games/coinflip/play", { wager: 10, choice: { side: "heads" } }],
            ["/api/games/plinko/drop", { wager: 10, risk: "medium" }],
            ["/api/games/roulette/spin", { bets: [{ type: "red", amount: 10 }] }],
            ["/api/games/slots/play", { wager: 10 }],
            ["/api/games/mines/start", { wager: 10, mines: 3 }],
            ["/api/games/mines/cashout", {}],
            ["/api/games/blackjack/start", { wager: 10 }],
        ]) assert.equal((await request(url, body, cookie)).status, 200, url);
        const blackjack = await request("/api/games/blackjack/state", null, cookie, "GET");
        if (blackjack.data.active) assert.equal((await request("/api/games/blackjack/stand", {}, cookie)).status, 200);
        const invalidPassword = await request("/api/auth/password", { currentPassword: "WrongPassword!", newPassword: "Changed123!" }, cookie, "PATCH");
        assert.equal(invalidPassword.status, 400);
        assert.equal((await request("/api/auth/me", null, cookie, "GET")).status, 200);
        const changed = await request("/api/auth/password", { currentPassword: "Testing123!", newPassword: "Changed123!" }, cookie, "PATCH");
        assert.equal(changed.status, 200);
        assert.equal((await request("/api/auth/me", null, cookie, "GET")).status, 401);
        assert.equal((await request("/api/auth/me", null, changed.cookie.split(";")[0], "GET")).status, 200);
        const freshCookie = changed.cookie.split(";")[0];
        assert.equal((await request("/api/auth/logout", {}, freshCookie)).status, 200);
        assert.equal((await request("/api/auth/me", null, freshCookie, "GET")).status, 401);
    } finally {
        socket?.terminate();
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill();
            await exited;
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
