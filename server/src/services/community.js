const pool = require("../config/database");

class CommunityError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}
function text(value, min, max, label) {
    if (typeof value !== "string") throw new CommunityError(label + " invalido.");
    const clean = value.trim();
    if (clean.length < min || clean.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(clean)) {
        throw new CommunityError(label + " deve ter entre " + min + " e " + max + " caracteres.");
    }
    return clean;
}
function category(value = "discussion") {
    if (!["discussion", "feedback"].includes(value)) throw new CommunityError("Categoria invalida.");
    return value;
}
function positiveId(value) {
    if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new CommunityError("Identificador invalido.");
    return Number(value);
}
function access(userId) {
    const user = userId && pool.db.get("SELECT id,username,level FROM users WHERE id=?", [userId]);
    return { registered: !!user, level: user?.level || 0, canFeedback: !!user && user.level >= 5, moderator: user?.username.toLowerCase() === "wl07" };
}
function requireAccess(userId, channel, writing = false) {
    const permissions = access(userId);
    if ((writing || channel === "feedback") && !permissions.registered) throw new CommunityError("Entre na sua conta para continuar.", 401);
    if (channel === "feedback" && !permissions.canFeedback) throw new CommunityError("Feedbacks disponiveis a partir do nivel 5.", 403);
    return permissions;
}
function pagination(query = {}) {
    const before = query.before === undefined || query.before === "" ? Number.MAX_SAFE_INTEGER : positiveId(query.before);
    const limit = query.limit === undefined ? 20 : positiveId(query.limit);
    if (limit > 40) throw new CommunityError("Limite de pagina invalido.");
    return { before, limit };
}
function thread(userId, id) {
    const value = pool.db.get("SELECT * FROM community_threads WHERE id=? AND removed=0", [positiveId(id)]);
    if (!value) throw new CommunityError("Topico nao encontrado.", 404);
    requireAccess(userId, value.category);
    return value;
}
function list(userId, query = {}) {
    const channel = category(query.category);
    requireAccess(userId, channel);
    const { before, limit } = pagination(query);
    const search = query.search ? text(query.search, 1, 80, "Pesquisa") : "";
    const escaped = search.replace(/[\\%_]/g, (value) => "\\" + value);
    const rows = pool.db.all(`SELECT t.id,t.user_id,t.category,t.title,t.state,t.created_at,
        u.username,u.display_name,u.avatar,u.level,
        (SELECT COUNT(*) FROM community_replies r WHERE r.thread_id=t.id AND r.removed=0) AS replies,
        (SELECT COUNT(*) FROM community_likes l WHERE l.thread_id=t.id) AS likes,
        EXISTS(SELECT 1 FROM community_likes l WHERE l.thread_id=t.id AND l.user_id=?) AS liked
        FROM community_threads t JOIN users u ON u.id=t.user_id
        WHERE t.category=? AND t.removed=0 AND t.id<? AND t.title LIKE ? ESCAPE '\\'
        ORDER BY t.id DESC LIMIT ?`, [userId || 0, channel, before, "%" + escaped + "%", limit + 1]);
    return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}
function detail(userId, id, query = {}) {
    const value = thread(userId, id);
    const author = pool.db.get("SELECT username,display_name,avatar,level FROM users WHERE id=?", [value.user_id]);
    const permissions = access(userId);
    const counts = pool.db.get(`SELECT (SELECT COUNT(*) FROM community_likes WHERE thread_id=?) AS likes,
        EXISTS(SELECT 1 FROM community_likes WHERE thread_id=? AND user_id=?) AS liked`, [value.id, value.id, userId || 0]);
    const { before, limit } = pagination(query);
    const rows = pool.db.all(`SELECT r.id,r.user_id,r.body,r.created_at,u.username,u.display_name,u.avatar,u.level
        FROM community_replies r JOIN users u ON u.id=r.user_id
        WHERE r.thread_id=? AND r.removed=0 AND r.id<? ORDER BY r.id DESC LIMIT ?`, [value.id, before, limit + 1]);
    return { thread: { ...value, ...author, ...counts, canManage: permissions.moderator || value.user_id === userId },
        replies: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null, moderator: permissions.moderator };
}
function throttle(userId, table, seconds) {
    const recent = pool.db.get(`SELECT 1 FROM ${table} WHERE user_id=? AND created_at>datetime('now',?) LIMIT 1`, [userId, "-" + seconds + " seconds"]);
    if (recent) throw new CommunityError("Aguarde antes de publicar novamente.", 429);
}
function create(userId, body = {}) {
    const channel = category(body.category);
    requireAccess(userId, channel, true);
    const title = text(body.title, 8, 120, "Titulo");
    const copy = text(body.body, 20, 6000, "Mensagem");
    return pool.transactionSync(() => {
        throttle(userId, "community_threads", 90);
        const result = pool.db.run("INSERT INTO community_threads(user_id,category,title,body) VALUES(?,?,?,?)", [userId, channel, title, copy]);
        return { id: Number(result.lastInsertRowid) };
    });
}
function reply(userId, id, body = {}) {
    const copy = text(body.body, 3, 2000, "Resposta");
    return pool.transactionSync(() => {
        const value = thread(userId, id);
        requireAccess(userId, value.category, true);
        if (value.state !== "open") throw new CommunityError("Este topico esta encerrado.", 409);
        throttle(userId, "community_replies", 10);
        const result = pool.db.run("INSERT INTO community_replies(thread_id,user_id,body) VALUES(?,?,?)", [value.id, userId, copy]);
        return { id: Number(result.lastInsertRowid) };
    });
}
function like(userId, id, body = {}) {
    if (typeof body.liked !== "boolean") throw new CommunityError("Curtida invalida.");
    return pool.transactionSync(() => {
        const value = thread(userId, id);
        requireAccess(userId, value.category, true);
        if (body.liked) pool.db.run("INSERT OR IGNORE INTO community_likes(thread_id,user_id) VALUES(?,?)", [value.id, userId]);
        else pool.db.run("DELETE FROM community_likes WHERE thread_id=? AND user_id=?", [value.id, userId]);
        return { liked: body.liked };
    });
}
function moderate(userId, id, body = {}, replyId = null) {
    const reason = text(body.reason, 5, 500, "Motivo");
    return pool.transactionSync(() => {
        const value = thread(userId, id);
        const permissions = requireAccess(userId, value.category, true);
        const target = replyId ? pool.db.get("SELECT id,user_id FROM community_replies WHERE id=? AND thread_id=? AND removed=0", [positiveId(replyId), value.id]) : value;
        if (!target) throw new CommunityError("Resposta nao encontrada.", 404);
        if (!permissions.moderator && target.user_id !== userId) throw new CommunityError("Acao nao autorizada.", 403);
        const action = body.action;
        if (replyId && action !== "remove") throw new CommunityError("Acao invalida.");
        if (action === "remove") pool.db.run(replyId ? "UPDATE community_replies SET removed=1 WHERE id=?" : "UPDATE community_threads SET removed=1 WHERE id=?", [target.id]);
        else if (["close", "reopen"].includes(action)) pool.db.run("UPDATE community_threads SET state=? WHERE id=?", [action === "close" ? "closed" : "open", target.id]);
        else throw new CommunityError("Acao invalida.");
        pool.db.run("INSERT INTO community_moderation(actor_id,target_type,target_id,action,reason) VALUES(?,?,?,?,?)", [userId, replyId ? "reply" : "thread", target.id, action, reason]);
        return { changed: true };
    });
}
module.exports = { CommunityError, access, requireAccess, list, detail, create, reply, like, moderate };
