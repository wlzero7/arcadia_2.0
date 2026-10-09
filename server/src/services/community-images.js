const sharp = require("sharp");
const { CommunityError } = require("./community");
const MAX_BYTES = 2 * 1024 * 1024;
async function normalize(images) {
    if (images === undefined) return [];
    if (!Array.isArray(images) || images.length > 2) throw new CommunityError("Envie no maximo duas imagens por publicacao.");
    const output = [];
    for (const value of images) {
        if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new CommunityError("Imagem invalida ou maior que 2 MB.");
        const buffer = Buffer.from(value, "base64");
        if (!buffer.length || buffer.length > MAX_BYTES) throw new CommunityError("Imagem invalida ou maior que 2 MB.");
        try {
            const source = sharp(buffer, { limitInputPixels: 16777216, failOn: "error", animated: false });
            const metadata = await source.metadata();
            if (!["png", "jpeg", "webp"].includes(metadata.format) || metadata.pages > 1 || metadata.width < 16 || metadata.height < 16 || metadata.width > 4096 || metadata.height > 4096) throw new Error("Unsupported image");
            const result = await source.rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
            if (result.data.length > 500 * 1024) throw new Error("Image too large");
            output.push({ image: result.data, width: result.info.width, height: result.info.height });
        } catch (_) { throw new CommunityError("Use PNG, JPG ou WebP estatico entre 16 e 4096 pixels por lado."); }
    }
    return output;
}
module.exports = { normalize, MAX_BYTES };
