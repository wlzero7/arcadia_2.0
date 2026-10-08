const { random, code } = require("./random");
const catalog = require("./football-catalog");
const DURATION_MS = 36000;
const RETURN = .96;
function market(home, away) {
    if (home.id === away.id && !home.custom && !away.custom) throw new Error("Escolha dois times diferentes.");
    if (![home.strength, away.strength].every((value) => Number.isFinite(value) && value >= 1 && value <= 100)) throw new Error("Elenco invalido.");
    const difference = (home.strength - away.strength) / 22;
    const draw = .2 - .06 * Math.abs(Math.tanh(difference));
    const homeWin = (1 - draw) * (.5 + .24 * Math.tanh(difference));
    const probabilities = { home: homeWin, draw, away: 1 - homeWin - draw };
    const odds = Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [key, Math.floor(RETURN / value * 100) / 100]));
    return { probabilities, odds, returnRate: RETURN };
}
function selected(choice = {}) {
    if (!["home", "draw", "away"].includes(choice.picked)) throw new Error("Escolha vitoria da casa, empate ou visitante.");
    return choice.picked;
}
function schedule(result, home, away, rng) {
    const rand = (max) => Math.min(max - 1, Math.floor(rng() * max));
    const base = rand(3);
    const score = result === "draw" ? [base, base] : result === "home" ? [base + 1 + rand(2), base] : [base, base + 1 + rand(2)];
    const goalSides = [...Array(score[0]).fill("home"), ...Array(score[1]).fill("away")];
    const moments = Array.from({length: 18}, (_, index) => index + 2);
    for (let i = moments.length - 1; i > 0; i--) { const j = rand(i + 1); [moments[i], moments[j]] = [moments[j], moments[i]]; }
    const goals = new Map(goalSides.map((side, index) => [moments[index], side]));
    const timeline = [];
    for (let index = 0; index < 22; index++) {
        const at = index * 1500;
        const side = goals.get(index) || (rng() < .5 ? "home" : "away");
        const players = side === "home" ? home.players : away.players;
        const from = 5 + rand(6), to = 1 + rand(10);
        timeline.push({ at, until: at + 1200, type: goals.has(index) || index % 3 === 2 ? "shot" : "pass",
            team: side, from, to, player: players[from].name, number: players[from].number });
        if (goals.has(index)) timeline.push({ at: at + 1200, until: at + 1500, type: "goal", team: side, from, to,
            player: players[from].name, number: players[from].number });
        else if (index % 3 === 2) timeline.push({ at: at + 1200, until: at + 1500, type: "save", team: side, from, to: 0,
            player: players[from].name, number: players[from].number });
    }
    return { timeline: timeline.sort((a, b) => a.at - b.at), score };
}
function createMatch(home, away, picked, amount, rng = random, now = Date.now()) {
    selected({ picked });
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Aposta invalida.");
    const prices = market(home, away);
    const draw = rng();
    const outcome = draw < prices.probabilities.home ? "home" : draw < prices.probabilities.home + prices.probabilities.draw ? "draw" : "away";
    const events = schedule(outcome, home, away, rng);
    const maximum = Math.floor(amount * prices.odds[picked]);
    if (!Number.isSafeInteger(maximum)) throw new Error("Aposta supera o limite seguro de premio.");
    return { id: code(16), game: "football", home: structuredClone(home), away: structuredClone(away), picked,
        odds: prices.odds, probabilities: prices.probabilities, wager: amount, startedAt: now, durationMs: DURATION_MS,
        winner: outcome, timeline: events.timeline, finalScore: events.score, payout: outcome === picked ? maximum : 0 };
}
function create(choice, amount, now = Date.now()) {
    return createMatch(catalog.team(choice?.home), catalog.team(choice?.away), selected(choice), amount, random, now);
}
function publicMatch(match, now = Date.now()) {
    const elapsed = Math.min(match.durationMs, Math.max(0, now - match.startedAt));
    const events = match.timeline.filter((event) => event.at <= elapsed);
    const score = [events.filter((event) => event.type === "goal" && event.team === "home").length,
        events.filter((event) => event.type === "goal" && event.team === "away").length];
    return { id: match.id, game: "football", home: match.home, away: match.away, picked: match.picked, odds: match.odds,
        probabilities: match.probabilities, wager: match.wager, startedAt: match.startedAt, durationMs: match.durationMs,
        elapsed, minute: Math.min(90, Math.floor(elapsed / match.durationMs * 90)), score, events,
        ended: elapsed >= match.durationMs };
}
function result(match) {
    return { ...publicMatch(match, match.startedAt + match.durationMs), winner: match.winner,
        payout: match.payout, multiplier: match.payout / match.wager, outcome: match.payout ? "win" : "loss" };
}
module.exports = { DURATION_MS, RETURN, market, createMatch, create, publicMatch, result };
