// ========================================
// ARCADIA - AUTH ROUTES
// v1.0.1: register cria as 3 carteiras (solo/coop/duel) com 1.000.000 AC
// ========================================

const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../config/database");
const { trackLoginActivity } = require("../services/progression.routes");
const { authenticate, issueSession, cookieOptions, verifySession, disconnectUserSockets } = require("../middleware/auth");
const router = express.Router();

// ========================================
// REGISTER
// ========================================

router.post("/register", async (req, res) => {
    const { username, email, password } = req.body || {};

    if (typeof username !== "string" || typeof email !== "string" || typeof password !== "string") {
        return res.status(400).json({ status: "error", message: "Preencha todos os campos." });
    }

    const normalizedUsername = String(username).trim();
    const normalizedEmail = String(email).trim().toLowerCase();

    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(normalizedUsername)) {
        return res.status(400).json({ status: "error", message: "Use 3 a 30 letras, números, ponto, hífen ou sublinhado no nome de usuário." });
    }

    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
        return res.status(400).json({ status: "error", message: "A senha deve possuir entre 8 caracteres e 72 bytes." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
        return res.status(400).json({ status: "error", message: "Digite um e-mail válido." });
    }

    try {
        const existing = await pool.get(
            `SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) LIMIT 1`,
            [normalizedEmail, normalizedUsername]
        );
        if (existing) {
            return res.status(409).json({ status: "error", message: "E-mail ou nome de usuário já cadastrado." });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const userId = pool.transactionSync(() => {
            const result = pool.db.run("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)", [normalizedUsername, normalizedEmail, passwordHash]);
            for (const kind of ["solo", "coop", "duel"]) pool.getWalletSync(result.lastInsertRowid, kind);
            trackLoginActivity(result.lastInsertRowid);
            return result.lastInsertRowid;
        });
        issueSession(res, { id: userId, username: normalizedUsername, token_version: 0 });

        return res.status(201).json({
            status: "success",
            message: "Conta criada com sucesso.",
            user: { id: userId, username: normalizedUsername, email: normalizedEmail },
            wallet: { balance: 1000000 },
        });
    } catch (error) {
        console.error("Register error:", error.message);
        if (/UNIQUE constraint/.test(error.message)) return res.status(409).json({ status: "error", message: "E-mail ou nome de usuário já cadastrado." });
        return res.status(500).json({ status: "error", message: "Não foi possível criar a conta." });
    }
});

// ========================================
// LOGIN
// ========================================

router.post("/login", async (req, res) => {
    const { email, password } = req.body || {};

    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
        return res.status(400).json({ status: "error", message: "Preencha e-mail e senha." });
    }

    try {
        const user = await pool.get(
            `SELECT u.id, u.username, u.email, u.password_hash, u.token_version, w.balance
             FROM users AS u
             INNER JOIN wallets AS w ON w.user_id = u.id AND w.kind = 'solo'
             WHERE u.email = ? COLLATE NOCASE OR u.username = ? COLLATE NOCASE
             LIMIT 1`,
            [email.trim(), email.trim()]
        );

        if (!user) {
            return res.status(401).json({ status: "error", message: "E-mail ou senha incorretos." });
        }

        const ok = await bcrypt.compare(String(password), user.password_hash);
        if (!ok) {
            return res.status(401).json({ status: "error", message: "E-mail ou senha incorretos." });
        }

        trackLoginActivity(user.id);
        issueSession(res, user);

        return res.status(200).json({
            status: "success",
            message: "Login realizado com sucesso.",
            user: { id: user.id, username: user.username, email: user.email },
            wallet: { balance: user.balance },
        });
    } catch (error) {
        console.error("Login error:", error.message);
        return res.status(500).json({ status: "error", message: "Não foi possível entrar." });
    }
});

// ========================================
// ME (sessão atual)
// ========================================

router.get("/me", authenticate, async (req, res) => {
    try {
        require("../services/achievements").checkProfileAchievements(req.user.id);
        const user = await pool.get(
            `SELECT id, username, email, created_at, display_name, avatar, xp, level FROM users WHERE id = ?`,
            [req.user.id]
        );

        if (!user) {
            return res.status(404).json({ status: "error", message: "Usuário não encontrado." });
        }

        const wallets = await pool.query(
            `SELECT kind, balance FROM wallets WHERE user_id = ?`,
            [req.user.id]
        );

        trackLoginActivity(user.id);
        if (req.headers.authorization) issueSession(res, req.user);
        return res.status(200).json({
            status: "success",
            user: {
                id: user.id,
                username: user.username,
                displayName: user.display_name || user.username,
                email: user.email,
                avatar: user.avatar || "🎰",
                createdAt: user.created_at,
                xp: user.xp || 0,
                level: user.level || 1,
            },
            wallet: { balance: (wallets.rows.find((w) => w.kind === "solo") || {}).balance || 0 },
            wallets: Object.fromEntries(wallets.rows.map((w) => [w.kind, w.balance])),
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Erro ao buscar sessão." });
    }
});

// ========================================
// PATCH /api/auth/profile — avatar + nome de exibição (v0.9)
// ========================================

router.patch("/profile", authenticate, async (req, res) => {
    try {
        const displayName = req.body.displayName ? String(req.body.displayName).trim().slice(0, 30) : null;
        const avatar = req.body.avatar ? String(req.body.avatar).slice(0, 8) : null;

        if (displayName) {
            await pool.run("UPDATE users SET display_name = ? WHERE id = ?", [displayName, req.user.id]);
        }
        if (avatar) {
            await pool.run("UPDATE users SET avatar = ? WHERE id = ?", [avatar, req.user.id]);
        }

        const user = await pool.get("SELECT id, username, display_name, avatar, level, xp FROM users WHERE id = ?", [req.user.id]);
        return res.json({
            status: "success",
            message: "Perfil atualizado!",
            user: { id: user.id, username: user.username, displayName: user.display_name || user.username, avatar: user.avatar, level: user.level, xp: user.xp },
        });
    } catch (error) {
        return res.status(500).json({ status: "error", message: "Erro ao atualizar perfil." });
    }
});

// ========================================
// PATCH /api/auth/password — trocar senha (v0.9.6)
// ========================================
router.patch("/password", authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ status: "error", message: "Preencha a senha atual e a nova." });
        }
        if (typeof newPassword !== "string" || newPassword.length < 8 || Buffer.byteLength(newPassword, "utf8") > 72) {
            return res.status(400).json({ status: "error", message: "A nova senha deve ter pelo menos 8 caracteres." });
        }

        const user = await pool.get(`SELECT id, password_hash FROM users WHERE id = ?`, [req.user.id]);
        if (!user) {
            return res.status(404).json({ status: "error", message: "Usuário não encontrado." });
        }

        const ok = await bcrypt.compare(String(currentPassword), user.password_hash);
        if (!ok) {
            return res.status(400).json({ status: "error", message: "Senha atual incorreta." });
        }

        const hash = await bcrypt.hash(String(newPassword), 10);
        await pool.run(`UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`, [hash, user.id]);
        disconnectUserSockets(user.id);
        issueSession(res, pool.db.get("SELECT id, username, token_version FROM users WHERE id = ?", [user.id]));

        return res.json({ status: "success", message: "Senha alterada com sucesso!" });
    } catch (error) {
        console.error("Change password error:", error.message);
        return res.status(500).json({ status: "error", message: "Não foi possível alterar a senha." });
    }
});

// ========================================
// DELETE /api/auth/account — deletar conta (v0.9.6)
// Exige a senha. friend_favorites e rooms(host) não têm cascade —
// limpa manualmente; todo o resto cai por ON DELETE CASCADE a partir de users.
// ========================================
router.delete("/account", authenticate, async (req, res) => {
    try {
        const user = await pool.get(`SELECT id, password_hash FROM users WHERE id = ?`, [req.user.id]);
        if (!user) {
            return res.status(404).json({ status: "error", message: "Usuário não encontrado." });
        }

        const ok = await bcrypt.compare(String(req.body.password || ""), user.password_hash);
        if (!ok) {
            return res.status(400).json({ status: "error", message: "Senha incorreta. A conta não foi deletada." });
        }

        const fundedRoom = pool.db.get("SELECT 1 FROM room_members rm JOIN room_pot p ON p.room_id = rm.room_id JOIN rooms r ON r.id = rm.room_id WHERE (rm.user_id = ? OR r.host_id = ?) AND (rm.stake > 0 OR p.balance > 0 OR p.pending_bets != '[]') LIMIT 1", [user.id, user.id]);
        const activeRound = pool.db.get("SELECT 1 FROM game_sessions WHERE user_id = ?", [user.id]);
        const activeRealtime = pool.db.all("SELECT mode, state FROM realtime_sessions").some((row) => {
            const state = require("../services/realtimeStore").decode(row.state);
            if (row.mode === "duel") return state.phase !== "finished" && Object.values(state.players).some((p) => p?.userId === user.id);
            if (row.mode === "race") return state.phase !== "finished" && state.bets.has(user.id);
            return false;
        });
        if (fundedRoom || activeRound || activeRealtime) return res.status(400).json({ status: "error", message: "Finalize suas partidas e saque o pote antes de apagar a conta." });
        pool.transactionSync(() => {
            pool.db.run("DELETE FROM friend_favorites WHERE user_id = ? OR friend_id = ?", [user.id, user.id]);
            pool.db.run("DELETE FROM rooms WHERE host_id = ?", [user.id]);
            pool.db.run("DELETE FROM users WHERE id = ?", [user.id]);
        });
        res.clearCookie("arcadia_token", cookieOptions);
        disconnectUserSockets(user.id);

        return res.json({ status: "success", message: "Conta deletada permanentemente." });
    } catch (error) {
        console.error("Delete account error:", error.message);
        return res.status(500).json({ status: "error", message: "Não foi possível deletar a conta." });
    }
});

router.post("/logout", (req, res) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : req.cookies?.arcadia_token;
    if (token) {
        try {
            const user = verifySession(token);
            pool.db.run("UPDATE users SET token_version = token_version + 1 WHERE id = ?", [user.id]);
            disconnectUserSockets(user.id);
        } catch (_) {}
    }
    res.clearCookie("arcadia_token", cookieOptions);
    res.json({ status: "success" });
});
module.exports = router;
