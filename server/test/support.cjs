const Module = require("node:module");
const originalLoad = Module._load;
const offline = process.env.ARCADIA_OFFLINE_TEST === "1";
if (offline) {
    const { DatabaseSync } = require("node:sqlite");
    class Database {
        constructor(path) { this.connection = new DatabaseSync(path); }
        exec(sql) { return this.connection.exec(sql); }
        run(sql, params = []) { return this.connection.prepare(sql).run(...params); }
        get(sql, params = []) { return this.connection.prepare(sql).get(...params); }
        all(sql, params = []) { return this.connection.prepare(sql).all(...params); }
        close() { this.connection.close(); }
    }
    const express = { Router() {
        const router = { stack: [] };
        for (const method of ["get", "post", "patch", "delete"]) router[method] = (path, ...handlers) => {
            router.stack.push({ route: { path, methods: { [method]: true }, stack: handlers.map((handle) => ({ handle })) } });
        };
        return router;
    } };
    Module._load = function (name, ...args) {
        if (name === "node-sqlite3-wasm") return { Database };
        if (name === "express") return express;
        if (name === "jsonwebtoken") return { verify() { throw new Error("JWT tests require installed dependencies."); } };
        return originalLoad.call(this, name, ...args);
    };
}
function invoke(router, path, userId, body = {}, method = "post", extra = {}) {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    if (!layer) throw new Error("Missing route: " + path);
    let status = 200, result, failure;
    const response = { status(code) { status = code; return this; }, json(data) { result = data; return this; } };
    const handler = layer.route.stack.at(-1).handle;
    handler({ user: { id: userId, username: "tester" }, body, query: {}, ...extra }, response, (err) => { failure = err; });
    if (failure) throw failure;
    return { ...result, status };
}
class FakeIO {
    constructor() { this.connectionHandlers = []; this.messages = []; }
    on(name, fn) { if (name === "connection") this.connectionHandlers.push(fn); }
    to(channel) { return { emit: (event, data) => this.messages.push({ channel, event, data }) }; }
    connect(userId, username = "tester") {
        const handlers = new Map();
        const socket = { id: "socket-" + userId, userId, username, data: {}, on: (name, fn) => handlers.set(name, fn), join() {}, leave() {} };
        for (const handler of this.connectionHandlers) handler(socket);
        socket.call = (name, data = {}) => {
            let result;
            handlers.get(name)(data, (response) => { result = response; });
            return result;
        };
        socket.callWithoutData = (name) => {
            let result;
            handlers.get(name)((response) => { result = response; });
            return result;
        };
        socket.disconnect = () => handlers.get("disconnect")?.();
        return socket;
    }
}
module.exports = { invoke, FakeIO, offline };
