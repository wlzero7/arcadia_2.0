const { createSyncFn } = require("synckit");

// Preserve the existing synchronous money transactions without interleaving
// socket actions while the official libSQL client performs network I/O.
function createTursoDatabase(url, authToken) {
    const parsed = new URL(url);
    const localTest = process.env.NODE_ENV === "test" && parsed.protocol === "file:";
    if (!localTest && (!["libsql:", "https:"].includes(parsed.protocol) || !authToken || parsed.username || parsed.password || parsed.search)) {
        throw new Error("Configure uma URL Turso TLS e seu token privado no servidor.");
    }
    const call = createSyncFn(require.resolve("./turso-worker.cjs"), { timeout: 15000 });
    let unavailable = false;
    function request(method, sql, params = []) {
        if (unavailable && method !== "close") throw Object.assign(new Error("Banco indisponivel. Reinicie o servidor apos conferir a conexao."), { code: "DATABASE_UNAVAILABLE" });
        let result;
        try { result = call({ method, sql, params, url, authToken }); }
        catch (_) { unavailable = true; throw Object.assign(new Error("Tempo de conexao com o banco excedido. Operacao nao sera repetida automaticamente."), { code: "DATABASE_TIMEOUT", operation: method }); }
        if (result.error) {
            if (result.uncertain) unavailable = true;
            const error = new Error(result.error);
            error.code = result.code;
            error.operation = method;
            error.command = method === "exec" && ["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(sql) ? sql : null;
            throw error;
        }
        return result.value;
    }
    return {
        exec: (sql) => request("exec", sql),
        get: (sql, params) => request("get", sql, params),
        all: (sql, params) => request("all", sql, params),
        run: (sql, params) => request("run", sql, params),
        batch: (statements) => request("batch", null, statements),
        close: () => request("close"),
        isAvailable: () => !unavailable,
    };
}
module.exports = { createTursoDatabase };
