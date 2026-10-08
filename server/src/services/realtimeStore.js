const pool = require("../config/database");
function encode(value) {
    return JSON.stringify(value, (_, item) => item instanceof Map ? { $map: [...item] } : item instanceof Set ? { $set: [...item] } : item);
}
function decode(value) {
    return JSON.parse(value, (_, item) => item && item.$map ? new Map(item.$map) : item && item.$set ? new Set(item.$set) : item);
}
function clearSockets(value) {
    if (!value || typeof value !== "object") return;
    if (value.socketIds instanceof Set) value.socketIds.clear();
    for (const child of value instanceof Map ? value.values() : Object.values(value)) clearSockets(child);
}
function load(mode) {
    const entries = new Map();
    for (const row of pool.db.all("SELECT code, state FROM realtime_sessions WHERE mode = ?", [mode])) {
        const state = decode(row.state);
        clearSockets(state);
        entries.set(row.code, state);
    }
    return entries;
}
function save(mode, state) {
    pool.db.run("INSERT INTO realtime_sessions (mode, code, state) VALUES (?, ?, ?) ON CONFLICT(mode, code) DO UPDATE SET state = excluded.state", [mode, state.code, encode(state)]);
}
function restore(target, snapshot) {
    for (const key of Object.keys(target)) if (!Object.hasOwn(snapshot, key)) delete target[key];
    Object.assign(target, snapshot);
}
module.exports = { load, save, decode, restore };
