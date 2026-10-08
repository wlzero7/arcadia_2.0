const sharp = require("sharp");
const dns = require("node:dns/promises");
const https = require("node:https");
const ipaddr = require("ipaddr.js");
const crypto = require("node:crypto");
const pool = require("../config/database");
const AVATARS = ["🎰", "🎲", "🃏", "💣", "🚀", "🎡", "🐎", "👑", "🦊", "🐺", "🦁", "🐸", "🦅", "🐉", "🤖", "👽"];
const MAX_BYTES = 5 * 1024 * 1024;
function identity(userId) {
    const user = pool.db.get("SELECT username, display_name, avatar FROM users WHERE id = ?", [userId]);
    return { userId, username: user?.username || "Jogador", displayName: user?.display_name || user?.username || "Jogador", avatar: user?.avatar || AVATARS[0] };
}
function publicAddress(address) {
    try { return ipaddr.process(address).range() === "unicast"; } catch (_) { return false; }
}
async function downloadImage(input, redirects = 0, deadline = Date.now() + 8000) {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || redirects > 3) throw new Error("Use uma URL HTTPS publica de imagem.");
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (deadline <= Date.now()) throw new Error("A imagem demorou demais para responder.");
    let dnsTimer;
    const addresses = await Promise.race([
        dns.lookup(hostname, { all: true }),
        new Promise((_, reject) => { dnsTimer = setTimeout(() => reject(new Error("Consulta de endereco demorou demais.")), Math.min(3000, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(dnsTimer));
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error("Endereco de imagem nao permitido.");
    // Pin the validated DNS answer to the actual socket, including redirects.
    return new Promise((resolve, reject) => {
        let timer, settled = false, redirecting = false;
        function finish(error, buffer) {
            if (settled) return;
            settled = true; clearTimeout(timer);
            if (error) reject(error); else resolve(buffer);
        }
        const request = https.get(url, { agent: false, headers: { Accept: "image/png,image/jpeg,image/webp", "Accept-Encoding": "identity" },
            lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                redirecting = true; response.destroy(); clearTimeout(timer);
                if (!response.headers.location) return finish(new Error("Redirecionamento invalido."));
                let next;
                try { next = new URL(response.headers.location, url).href; }
                catch (_) { finish(new Error("Redirecionamento invalido.")); return; }
                downloadImage(next, redirects + 1, deadline).then((buffer) => finish(null, buffer), (error) => finish(error));
                return;
            }
            if (response.statusCode !== 200 || !/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers["content-type"] || "") || Number(response.headers["content-length"] || 0) > MAX_BYTES) {
                response.destroy(); finish(new Error("A URL deve apontar para PNG, JPG ou WebP de ate 5 MB.")); return;
            }
            let size = 0; const chunks = [];
            response.on("data", (chunk) => { size += chunk.length; if (size > MAX_BYTES) request.destroy(new Error("Imagem maior que 5 MB.")); else chunks.push(chunk); });
            response.on("end", () => finish(null, Buffer.concat(chunks)));
            response.on("error", (error) => finish(error));
            response.on("aborted", () => finish(new Error("Download de imagem interrompido.")));
            response.on("close", () => { if (!response.complete && !settled) finish(new Error("Download de imagem incompleto.")); });
        });
        timer = setTimeout(() => request.destroy(new Error("A imagem demorou demais para responder.")), Math.max(1, Math.min(5000, deadline - Date.now())));
        request.on("error", (error) => { if (!redirecting) finish(error); });
    });
}
async function normalizeImage(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_BYTES) throw new Error("Envie uma imagem de ate 5 MB.");
    const source = sharp(buffer, { limitInputPixels: 16777216, failOn: "error", animated: false });
    const metadata = await source.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format) || metadata.pages > 1 || metadata.width < 64 || metadata.height < 64 || metadata.width > 4096 || metadata.height > 4096) {
        throw new Error("Use PNG, JPG ou WebP estatico, entre 64 e 4096 pixels por lado.");
    }
    return source.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
}
function saveImage(userId, image) {
    const version = crypto.createHash("sha256").update(image).digest("hex").slice(0, 16);
    const avatar = `/api/avatars/${userId}?v=${version}`;
    pool.transactionSync(() => {
        pool.db.run("INSERT INTO avatar_images (user_id, image, version) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET image = excluded.image, version = excluded.version", [userId, image, version]);
        pool.db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatar, userId]);
    });
    return avatar;
}
module.exports = { AVATARS, MAX_BYTES, publicAddress, downloadImage, normalizeImage, saveImage, identity };
