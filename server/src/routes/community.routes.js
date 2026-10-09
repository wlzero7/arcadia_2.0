const express = require("express");
const { authenticate } = require("../middleware/auth");
const community = require("../services/community");
const router = express.Router();
function handle(fn) {
    return (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try { res.json({ status: "success", ...fn(req) }); }
        catch (error) {
            const known = error instanceof community.CommunityError;
            res.status(known ? error.status : 503).json({ status: "error", message: known ? error.message : "Comunidade indisponivel. Tente novamente." });
        }
    };
}
function protectedCategory(req, res, next) {
    if (req.query.category === "feedback" || req.headers.authorization || req.cookies?.arcadia_token) return authenticate(req, res, next);
    next();
}
function protectedThread(req, res, next) {
    const pool = require("../config/database");
    const row = pool.db.get("SELECT category FROM community_threads WHERE id=?", [String(req.params.id)]);
    if (row?.category === "feedback" || req.headers.authorization || req.cookies?.arcadia_token) return authenticate(req, res, next);
    next();
}
router.get("/access", authenticate, handle((req) => community.access(req.user.id)));
router.get("/stats", protectedCategory, handle((req) => community.statistics(req.user?.id)));
router.get("/threads", protectedCategory, handle((req) => community.list(req.user?.id, req.query)));
router.get("/threads/:id", protectedThread, handle((req) => community.detail(req.user?.id, req.params.id, req.query)));
router.get("/images/:id", (req, res, next) => {
    const pool = require("../config/database");
    const row = pool.db.get("SELECT t.category FROM community_images i JOIN community_threads t ON t.id=i.thread_id WHERE i.id=?", [String(req.params.id)]);
    if (row?.category === "feedback" || req.headers.authorization || req.cookies?.arcadia_token) return authenticate(req, res, next);
    next();
}, (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try { res.type("image/webp").send(Buffer.from(community.image(req.user?.id, req.params.id))); }
    catch (error) { res.status(error instanceof community.CommunityError ? error.status : 503).json({ status: "error", message: "Imagem indisponivel." }); }
});
router.post("/threads/:id/like", authenticate, handle((req) => community.like(req.user.id, req.params.id, req.body)));
router.patch("/threads/:id", authenticate, handle((req) => community.moderate(req.user.id, req.params.id, req.body)));
router.patch("/threads/:id/replies/:replyId", authenticate, handle((req) => community.moderate(req.user.id, req.params.id, req.body, req.params.replyId)));
module.exports = router;
