const pool = require("../config/database");
const catalog = require("./football-catalog");
const rating = (investment) => Number(Math.min(96, 45 + 17 * Math.log10(1 + investment / 1000)).toFixed(2));
function load(userId) {
    const row = pool.db.get("SELECT * FROM football_clubs WHERE user_id=?", [userId]);
    if (!row) return { userId, teamId: catalog.TEAMS[0].id, lineup: catalog.TEAMS[0].players.map((player) => player.id), investments: {}, revision: 0 };
    return { userId, teamId: row.team_id, lineup: JSON.parse(row.lineup), investments: JSON.parse(row.investments), revision: row.revision };
}
function asTeam(club) {
    const skin = catalog.team(club.teamId);
    const owner = pool.db.get("SELECT username,display_name FROM users WHERE id=?", [club.userId]);
    if (!owner) throw new Error("Elenco nao encontrado.");
    const players = club.lineup.map((id, index) => ({ ...catalog.BY_PLAYER.get(id), number: index + 1,
        investment: club.investments[id] || 0, rating: rating(club.investments[id] || 0) }));
    return { ...skin, id: "club-" + club.userId, custom: true, name: owner.display_name || owner.username,
        players, strength: Number((players.reduce((sum, player) => sum + player.rating, 0) / 11).toFixed(2)) };
}
function get(userId) {
    const club = load(userId);
    return { ...club, team: asTeam(club), balance: pool.getWalletSync(userId, "duel").balance };
}
function save(userId, body = {}) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Elenco invalido.");
    if (!Number.isInteger(body.revision) || body.revision < 0) throw new Error("Elenco desatualizado. Recarregue.");
    const skin = catalog.team(body.teamId);
    if (!Array.isArray(body.players) || body.players.length !== 11) throw new Error("O elenco deve ter onze jogadores.");
    const ids = body.players.map((entry) => entry?.id);
    if (new Set(ids).size !== 11) throw new Error("Escolha onze jogadores diferentes.");
    const validated = body.players.map((entry, index) => {
        const player = catalog.BY_PLAYER.get(entry.id);
        if (!player || player.position !== catalog.POSITIONS[index]) throw new Error("Jogador fora da posicao do elenco.");
        if (!Number.isSafeInteger(entry.investment) || entry.investment < 0 || entry.investment > 1000000) throw new Error("Investimento deve ser inteiro, entre 0 e 1000000 AC por jogador.");
        return entry;
    });
    return pool.transactionSync(() => {
        const current = load(userId);
        if (body.revision !== current.revision) throw new Error("Elenco desatualizado. Recarregue.");
        const investments = { ...current.investments };
        let charged = 0;
        for (const entry of validated) {
            const paid = investments[entry.id] || 0;
            if (entry.investment < paid) throw new Error("Investimento permanente nao pode ser reduzido.");
            charged += entry.investment - paid;
            investments[entry.id] = entry.investment;
        }
        const wallet = pool.getWalletSync(userId, "duel");
        if (charged > wallet.balance) throw new Error("Saldo DUEL insuficiente para o elenco.");
        if (charged) pool.adjustBalanceSync(wallet.id, -charged, "bet", "football_training", String(current.revision + 1));
        pool.db.run("INSERT INTO football_clubs(user_id,team_id,lineup,investments,revision) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET team_id=excluded.team_id,lineup=excluded.lineup,investments=excluded.investments,revision=excluded.revision",
            [userId, skin.id, JSON.stringify(ids), JSON.stringify(investments), current.revision + 1]);
        return { ...get(userId), charged };
    });
}
module.exports = { rating, load, asTeam, get, save };
