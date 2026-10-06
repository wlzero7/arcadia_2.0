const { randomInt, randomBytes } = require("node:crypto");

function random() {
    return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}
function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}
function code(length = 6) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
}
module.exports = { random, randomInt, shuffle, code };
