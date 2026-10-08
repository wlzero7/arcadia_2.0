const { runAsWorker } = require("synckit");
const { createClient } = require("@libsql/client");
let client, transaction;
function safeNumber(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("INTEGER_RANGE");
    return number;
}
function rows(result) {
    return result.rows.map((row) => Object.fromEntries(result.columns.map((key) => [key,
        typeof row[key] === "bigint" ? safeNumber(row[key]) : row[key]])));
}
function value(result, method) {
    if (method === "run") return { changes: result.rowsAffected, lastInsertRowid: result.lastInsertRowid == null ? 0 : safeNumber(result.lastInsertRowid) };
    const data = rows(result);
    return method === "get" ? data[0] : data;
}
runAsWorker(async ({ method, sql, params, url, authToken }) => {
    try {
        client ||= createClient({ url, authToken, intMode: "bigint" });
        if (method === "close") { transaction?.close(); client.close(); return { value: null }; }
        if (method === "batch") {
            const statements = params.map((statement) => ({ sql: statement.sql, args: statement.params || [] }));
            const results = await (transaction ? transaction.batch(statements) : client.batch(statements, "write"));
            return { value: results.map((result, i) => value(result, params[i].method || "run")) };
        }
        if (method === "exec") {
            const command = sql.trim().replace(/;$/, "").toUpperCase();
            if (command === "BEGIN IMMEDIATE") {
                if (transaction) throw new Error("TRANSACTION_OPEN");
                transaction = await client.transaction("write");
            } else if (command === "COMMIT" || command === "ROLLBACK") {
                const active = transaction;
                try { if (active) await active[command === "COMMIT" ? "commit" : "rollback"](); }
                finally { active?.close(); transaction = null; }
            } else await (transaction || client).executeMultiple(sql);
            return { value: null };
        }
        const result = await (transaction || client).execute({ sql, args: params });
        return { value: value(result, method) };
    } catch (error) {
        const constraint = /^SQLITE_(CONSTRAINT|ERROR|MISMATCH|RANGE|UNKNOWN|BUSY|LOCKED|READONLY)(_|$)/.test(error.code || "");
        return { error: constraint ? error.message : "Conexao com o banco indisponivel. Confira o painel Turso.", uncertain: !constraint, code: /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code || "") ? error.code : "DATABASE_ERROR" };
    }
});
