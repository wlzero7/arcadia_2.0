const express = require("express");
const { authenticate } = require("../middleware/auth");
const community = require("../services/community");
const { normalize } = require("../services/community-images");
const router = express.Router();
const busy = new Map();
const attempts = new Map();
const parser = express.json({ limit: "6mb" });
function reserve(req, res, next) {
    const now = Date.now();
    for (const [id, value] of attempts) if (value.reset <= now) attempts.delete(id);
    const value = attempts.get(req.user.id) || { count: 0, reset: now + 60000 };
    value.count++; attempts.set(req.user.id, value);
    if (value.count > 12 || attempts.size > 5000) return res.status(429).json({ status: "error", message: "Muitos envios. Aguarde um minuto." });
    if (busy.has(req.user.id) || busy.size >= 3) return res.status(429).json({ status: "error", message: "Aguarde o envio em andamento." });
    const lease = Symbol(); busy.set(req.user.id, lease);
    const release = () => { if (busy.get(req.user.id) === lease) busy.delete(req.user.id); };
    req.releasePublication = release;
    res.once("finish", () => { if (!req.publicationActive) release(); });
    res.once("close", () => { if (!req.publicationActive) release(); });
    parser(req, res, (error) => {
        if (error) { release(); return res.status(error.type === "entity.too.large" ? 413 : 400).json({ status: "error", message: "Publicacao invalida ou maior que 6 MB." }); }
        if (res.destroyed) { release(); return; }
        next();
    });
}
function publish(reply) {
    return async (req, res) => {
        req.publicationActive = true;
        res.setHeader("Cache-Control", "no-store");
        try {
            const body = req.body || {};
            const channel = reply ? community.thread(req.user.id, req.params.id).category : body.category || "discussion";
            if (!["discussion", "feedback"].includes(channel)) throw new community.CommunityError("Categoria invalida.");
            community.requireAccess(req.user.id, channel, true);
            const images = await normalize(body.images);
            const result = reply ? community.reply(req.user.id, req.params.id, body, images) : community.create(req.user.id, body, images);
            res.json({ status: "success", ...result });
        } catch (error) {
            const known = error instanceof community.CommunityError;
            res.status(known ? error.status : 503).json({ status: "error", message: known ? error.message : "Comunidade indisponivel. Tente novamente." });
        } finally { req.releasePublication(); }
    };
}
router.post("/threads", authenticate, reserve, publish(false));
router.post("/threads/:id/replies", authenticate, reserve, publish(true));
module.exports = router;
