const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const pool = require("../config/database");
const { disconnectUserSockets } = require("../middleware/auth");
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
class RecoveryError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
function mailer(env = process.env, transport = fetch) {
    const configured = !!env.BREVO_API_KEY && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.MAIL_FROM_EMAIL || "");
    return { configured, async send(to, subject, text) {
        if (!configured) throw new Error("Email unavailable");
        const response = await transport("https://api.brevo.com/v3/smtp/email", { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ sender: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME || "Arcadia" }, to: [{ email: to }], subject, textContent: text }) });
        if (!response.ok) throw new Error("Email unavailable");
        await response.body?.cancel();
    } };
}
function createRecovery({ mail = mailer(), origin = process.env.PUBLIC_ORIGIN || "https://arcadia-780b.onrender.com", delayMs = 5500 } = {}) {
    const address = new URL(origin);
    if (address.origin !== origin || address.username || address.password || !(address.protocol === "https:" || (address.protocol === "http:" && ["localhost", "127.0.0.1"].includes(address.hostname)))) throw new Error("Invalid recovery origin");
    async function request(identifier) {
        if (typeof identifier !== "string" || !identifier.trim() || identifier.length > 254) throw new RecoveryError("Preencha seu e-mail ou usuario.");
        if (!mail.configured) throw new RecoveryError("Recuperacao por e-mail indisponivel no momento.", 503);
        const started = Date.now(), value = identifier.trim().toLowerCase(), token = crypto.randomBytes(32).toString("base64url"), hash = digest(token);
        try {
            const user = pool.transactionSync(() => {
                pool.db.run("DELETE FROM password_recovery_limits WHERE resets_at<=?", [Date.now()]);
                pool.db.run("DELETE FROM password_recovery WHERE expires_at<=?", [Date.now()]);
                pool.db.run("INSERT INTO password_recovery_limits VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET attempts=attempts+1", [digest(value), Date.now() + 3600000]);
                if (pool.db.get("SELECT attempts FROM password_recovery_limits WHERE key_hash=?", [digest(value)]).attempts > 3) return null;
                const row = pool.db.get("SELECT id,email,token_version FROM users WHERE email=? COLLATE NOCASE OR username=? COLLATE NOCASE", [value, value]);
                if (!row) return null;
                pool.db.run("DELETE FROM password_recovery WHERE user_id=?", [row.id]);
                pool.db.run("INSERT INTO password_recovery VALUES(?,?,?,?)", [hash, row.id, row.token_version, Date.now() + 900000]);
                return row;
            });
            if (user) {
                try { await mail.send(user.email, "Arcadia - recuperar senha", "Para redefinir sua senha, abra este link em ate 15 minutos:\n\n" + origin + "/recuperar-senha.html#token=" + token + "\n\nO link so pode ser usado uma vez. Se voce nao pediu esta alteracao, ignore este e-mail."); }
                catch (_) { pool.db.run("DELETE FROM password_recovery WHERE token_hash=?", [hash]); console.warn("Password recovery email delivery failed."); }
            }
        } finally { await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs - (Date.now() - started)))); }
        return { message: "Se existir uma conta com esses dados, enviaremos as instrucoes para o e-mail cadastrado." };
    }
    async function reset(token, password) {
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new RecoveryError("Link invalido ou expirado.");
        if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 72) throw new RecoveryError("Use uma senha com pelo menos 8 caracteres e no maximo 72 bytes.");
        const hash = await bcrypt.hash(password, 10);
        const user = pool.transactionSync(() => {
            const row = pool.db.get(`SELECT u.id,u.email FROM password_recovery r JOIN users u ON u.id=r.user_id
                WHERE r.token_hash=? AND r.expires_at>? AND r.token_version=u.token_version`, [digest(token), Date.now()]);
            if (!row) throw new RecoveryError("Link invalido ou expirado.");
            pool.db.run("UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=?", [hash, row.id]);
            pool.db.run("DELETE FROM password_recovery WHERE user_id=?", [row.id]);
            return row;
        });
        disconnectUserSockets(user.id);
        try { await mail.send(user.email, "Arcadia - senha alterada", "Sua senha do Arcadia foi alterada. As sessoes anteriores foram encerradas. Se voce nao reconhece esta acao, entre em contato com o suporte."); } catch (_) { console.warn("Password change notification delivery failed."); }
        return { message: "Senha alterada. Entre novamente na sua conta." };
    }
    return { request, reset };
}
module.exports = { createRecovery, mailer, RecoveryError, digest };
