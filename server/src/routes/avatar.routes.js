const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const avatars = require("../services/avatars");
const router = express.Router();
const busy = new Set();
function upload(handler) {
    return async (req, res) => {
        if (busy.has(req.user.id) || busy.size >= 3) return res.status(429).json({ message: "Aguarde a imagem anterior terminar." });
        busy.add(req.user.id);
        try {
            const image = await avatars.normalizeImage(await handler(req));
            res.json({ status: "success", avatar: avatars.saveImage(req.user.id, image) });
        } catch (_) { res.status(400).json({ message: "Imagem invalida. Use PNG, JPG ou WebP estatico de ate 5 MB, entre 64 e 4096 pixels, ou uma URL HTTPS publica." }); }
        finally { busy.delete(req.user.id); }
    };
}
router.post("/upload", authenticate, express.raw({ type: ["image/png", "image/jpeg", "image/webp"], limit: "5mb" }), upload((req) => req.body));
router.post("/import", authenticate, upload((req) => avatars.downloadImage(String(req.body?.url || ""))));
router.get("/:id", (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.sendStatus(404);
    const row = pool.db.get("SELECT image, version FROM avatar_images WHERE user_id = ?", [Number(req.params.id)]);
    if (!row || req.query.v !== row.version) return res.sendStatus(404);
    res.set({ "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${row.version}"` });
    res.send(Buffer.from(row.image));
});
module.exports = router;
