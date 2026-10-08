const pool = require("../config/database");
const { grantXP } = require("./progression");
const meta = (name, xp, desc) => ({ name, xp, desc });
const ACHIEVEMENTS = {
    first_victory: meta("Primeira Vitória!", 50, "Ganhe sua primeira partida em qualquer jogo ou modo."),
    first_defeat: meta("Primeira Derrota!", 50, "Perca sua primeira partida em qualquer jogo ou modo."),
    six_faces: meta("6 Faces.", 100, "Jogue Dice em qualquer modo."),
    infinity: meta("Ao infinito e além!", 100, "Jogue Crash em qualquer modo."),
    undefeated_10: meta("Invicto!", 1000, "Vença 10 partidas seguidas."),
    undefeated_20: meta("Super Invicto!", 2000, "Vença 20 partidas seguidas."),
    defeated_10: meta("Derrotado!", 500, "Perca 10 partidas seguidas."),
    all_win: meta("ALL WIN!!", 0, "Aposte todo o saldo disponível em uma aposta."),
    rich: meta("Rico!", 100, "Tenha 2.000.000 AC em uma carteira."),
    blackjack_21: meta("Blackjack 21!", 300, "Vença Blackjack com exatamente 21 pontos."),
    rocket_reverse: meta("Foguete não da Ré!", 500, "Vença Crash com multiplicador de 4x ou mais."),
    croissant: meta("croissant", 1000, "Vença Racing com o cavalo Nicolas."),
    bug_reporter: meta("Reportador de Bugs", 10000, "Tenha um relato de bug aprovado pelo desenvolvedor."),
    no_cards: meta("Não preciso de cartas!", 500, "Vença Blackjack sem pedir uma carta."),
    miner: meta("Minerador!", 1000, "Vença Mines com multiplicador de pelo menos 7x."),
    fifty_fifty: meta("50/50", 1000, "Vença Coin Flip apostando todo o saldo."),
    born_miner: meta("Minerador Nato!", 200, "Vença 25 partidas de Mines seguidas."),
    bad_face: meta("O número ruim da Face!", 50, "Vença Dice apostando no número 6."),
    poor: meta("Pobre!", 1000, "Acumule 1.000.000 AC em perdas nas partidas."),
    underestimated: meta("O Subestimado!", 2000, "Vença Racing com o cavalo de maior multiplicador."),
    new_bonds: meta("Criando novos Laços!", 100, "Tenha pelo menos um amigo na lista."),
    level_25_new: meta("Progressista!", 200, "Alcance o nível 25."),
    level_50_new: meta("Mestre do XP!", 500, "Alcance o nível 50."),
    level_75_new: meta("XP Farmer", 1000, "Alcance o nível 75."),
    level_100_new: meta("Lvl Lenda!", 5000, "Alcance o nível 100."),
    lucky_number: meta("O número da Sorte!", 777, "Faça uma aposta de exatamente 777.777 AC."),
    lucky: meta("Sortudo!", 1000, "Ganhe o prêmio máximo de Slots."),
    trump_king: meta("Rei dos Trunfos!", 1000, "Tenha um trunfo cromático e um lendário no inventário."),
    roulette_10: meta("Roletado!", 1000, "Vença 10 partidas de Roleta seguidas."),
    conqueror: meta("Conquistador!", 500, "Desbloqueie 25 conquistas deste catálogo."),
    magnate: meta("Magnata!", 10000, "Some 100.000.000 AC nas três carteiras."),
    billionaire: meta("Bilionário!", 50000, "Some 1.000.000.000 AC nas três carteiras."),
    plin_plinkoo: meta("Plin-Plinkoo!", 4500, "Ganhe o prêmio máximo de Plinko: 1.000x."),
    daily_worker: meta("Diarista!", 0, "Conclua três missões diárias."),
    missionary: meta("Missionário!", 1000, "Conclua 30 missões diárias ou semanais."),
    duel_5: meta("X1", 400, "Vença cinco duelos."),
    coop_5: meta("Cooperador", 400, "Vença cinco partidas no Coop."),
    rich_friends: meta("Amigos Ricos!", 1000, "Participe de um pote Coop com pelo menos 10.000.000 AC."),
    winner_1000: meta("Vencedor!", 2000, "Acumule 1.000 vitórias em partidas."),
    platinum: meta("Platina", 0, "Desbloqueie todas as outras 39 conquistas."),
};
const checking = new Set();
function unlockAchievement(userId, key) {
    if (!Object.hasOwn(ACHIEVEMENTS, key)) return null;
    return pool.transactionSync(() => {
        const inserted = pool.db.run("INSERT OR IGNORE INTO user_achievements (user_id, achievement_key) VALUES (?, ?)", [userId, key]);
        if (!inserted.changes) return null;
        const xp = ACHIEVEMENTS[key].xp;
        const levelInfo = xp ? grantXP(userId, xp, false) : null;
        checkProfileAchievements(userId);
        return { key, ...ACHIEVEMENTS[key], levelInfo };
    });
}
function checkProfileAchievements(userId) {
    if (checking.has(userId)) return [];
    checking.add(userId);
    const unlocked = [];
    const award = (key, condition) => { if (condition) { const item = unlockAchievement(userId, key); if (item) unlocked.push(item); } };
    try {
        return pool.transactionSync(() => {
            const wallets = pool.db.all("SELECT balance FROM wallets WHERE user_id = ?", [userId]);
            const total = wallets.reduce((sum, w) => sum + w.balance, 0);
            award("rich", wallets.some((w) => w.balance >= 2000000));
            award("magnate", total >= 100000000); award("billionaire", total >= 1000000000);
            award("new_bonds", !!pool.db.get("SELECT 1 FROM friendships WHERE status = 'accepted' AND (user_id = ? OR friend_id = ?) LIMIT 1", [userId, userId]));
            const rarities = new Set(pool.db.all("SELECT rarity FROM slots_cards WHERE user_id = ? UNION SELECT rarity FROM blackjack_cards WHERE user_id = ?", [userId, userId]).map((r) => r.rarity));
            award("trump_king", rarities.has("cromatica") && rarities.has("lendaria"));
            const stats = pool.db.get("SELECT SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins, SUM(MAX(wager - payout, 0)) AS lost FROM bets WHERE user_id = ?", [userId]);
            award("winner_1000", stats.wins >= 1000); award("poor", stats.lost >= 1000000);
            award("duel_5", (pool.db.get("SELECT wins FROM duel_stats WHERE user_id = ?", [userId])?.wins || 0) >= 5);
            const coopWins = pool.db.get("SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND outcome = 'win' AND (json_extract(detail, '$.mode') = 'coop' OR json_extract(detail, '$.roomCode') IS NOT NULL OR json_extract(detail, '$.tableCode') IS NOT NULL)", [userId]).n;
            award("coop_5", coopWins >= 5);
            const missions = pool.db.all("SELECT mission_key, period FROM user_missions WHERE user_id = ? AND completed = 1", [userId]);
            award("daily_worker", missions.filter((m) => m.mission_key.startsWith("daily_")).length >= 3);
            award("missionary", missions.length >= 30);
            // Rewards may cross another level or achievement milestone; converge without double rewards.
            let previous = -1;
            for (let i = 0; i < 40 && previous !== unlocked.length; i++) {
                previous = unlocked.length;
                const level = pool.db.get("SELECT level FROM users WHERE id = ?", [userId])?.level || 1;
                for (const n of [25, 50, 75, 100]) award(`level_${n}_new`, level >= n);
                const owned = new Set(pool.db.all("SELECT achievement_key FROM user_achievements WHERE user_id = ?", [userId]).map((a) => a.achievement_key));
                const count = Object.keys(ACHIEVEMENTS).filter((key) => owned.has(key)).length;
                award("conqueror", count >= 25);
                award("platinum", Object.keys(ACHIEVEMENTS).every((key) => key === "platinum" || owned.has(key)));
            }
            return unlocked;
        });
    } finally { checking.delete(userId); }
}
function streak(userId, outcome, count, game = null) {
    const sql = game ? " AND CASE WHEN game = 'duel' THEN json_extract(detail, '$.game') WHEN game = 'blackjack-mp' THEN 'blackjack' ELSE game END = ?" : "";
    const rows = pool.db.all("SELECT outcome FROM bets WHERE user_id = ?" + sql + " ORDER BY id DESC LIMIT ?", game ? [userId, game, count] : [userId, count]);
    return rows.length === count && rows.every((row) => row.outcome === outcome);
}
function checkGameAchievements(userId, { game, outcome, multiplier, wager, detail = {} }) {
    const played = game === "duel" ? detail.game : game === "blackjack-mp" ? "blackjack" : game;
    const unlocked = [];
    const award = (key, condition) => { if (condition) { const item = unlockAchievement(userId, key); if (item) unlocked.push(item); } };
    const won = outcome === "win";
    award("first_victory", won); award("first_defeat", outcome === "loss");
    award("six_faces", played === "dice"); award("infinity", played === "crash");
    award("all_win", detail.allWin === true); award("lucky_number", (detail.baseWager ?? wager) === 777777);
    award("fifty_fifty", played === "coinflip" && won && detail.allWin === true);
    award("bad_face", played === "dice" && won && detail.picked === 6);
    const total = (detail.player || []).reduce((sum, c) => sum + (c.rank === "A" ? 11 : ["J", "Q", "K"].includes(c.rank) ? 10 : Number(c.rank)), 0);
    let blackjackTotal = total, aces = (detail.player || []).filter((c) => c.rank === "A").length;
    while (blackjackTotal > 21 && aces-- > 0) blackjackTotal -= 10;
    award("blackjack_21", played === "blackjack" && won && (detail.playerTotal ?? blackjackTotal) === 21);
    award("no_cards", played === "blackjack" && won && (Number.isInteger(detail.hits) || Array.isArray(detail.player)) && (detail.hits ?? Math.max(0, detail.player.length - 2)) === 0);
    award("rocket_reverse", played === "crash" && won && (detail.cashout ?? detail.target ?? detail.autoCashout ?? multiplier) >= 4);
    award("miner", played === "mines" && won && (detail.multiplier ?? multiplier) >= 7);
    award("croissant", played === "racing" && won && detail.horseName === "Nicolas");
    award("underestimated", played === "racing" && won && detail.horseOdds === detail.maxOdds && Number.isFinite(detail.maxOdds));
    award("lucky", played === "slots" && won && detail.jackpot === true);
    award("plin_plinkoo", played === "plinko" && won && multiplier >= 1000);
    award("undefeated_10", won && streak(userId, "win", 10)); award("undefeated_20", won && streak(userId, "win", 20));
    award("defeated_10", outcome === "loss" && streak(userId, "loss", 10));
    award("born_miner", played === "mines" && won && streak(userId, "win", 25, "mines"));
    award("roulette_10", played === "roulette" && won && streak(userId, "win", 10, "roulette"));
    return unlocked.concat(checkProfileAchievements(userId));
}
function achievementCount(userId) {
    const keys = Object.keys(ACHIEVEMENTS);
    return pool.db.get(`SELECT COUNT(*) AS total FROM user_achievements WHERE user_id = ? AND achievement_key IN (${keys.map(() => "?").join(",")})`, [userId, ...keys]);
}
module.exports = { ACHIEVEMENTS, unlockAchievement, checkGameAchievements, checkProfileAchievements, achievementCount };
