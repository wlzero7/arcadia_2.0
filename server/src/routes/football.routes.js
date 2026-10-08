const express = require("express");
const pool = require("../config/database");
const { authenticate } = require("../middleware/auth");
const rounds = require("../services/rounds");
const football = require("../services/football");
const catalog = require("../services/football-catalog");
const clubs = require("../services/football-clubs");
const router = express.Router();
function handle(fn) {
    return (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        try { res.json({ status: "success", ...pool.transactionSync(() => fn(req)) }); }
        catch (error) {
            const known = /Escolha|Elenco|elenco|Jogador|jogador|Saldo|Aposta|aposta|partida|Investimento|investimento|Posicao/i.test(error.message);
            res.status(known ? 400 : 503).json({ status: "error", message: known ? error.message : "Futebol indisponivel. Tente novamente." });
        }
    };
}
function state(userId) {
    const play = rounds.getSession(userId, "football");
    if (!play) {
        const last = pool.db.get("SELECT state FROM football_results WHERE user_id=?", [userId]);
        return { active: false, match: last ? JSON.parse(last.state) : null, serverTime: Date.now() };
    }
    if (Date.now() < play.startedAt + play.durationMs) return { active: true, match: football.publicMatch(play), serverTime: Date.now() };
    const result = football.result(play);
    const settled = rounds.settleRound(userId, "football", result.payout, result.outcome, { ...result, mode: "solo" });
    pool.db.run("INSERT INTO football_results(user_id,state) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state", [userId, JSON.stringify(result)]);
    return { active: false, match: result, serverTime: Date.now(), ...settled };
}
router.get("/catalog", (req, res) => res.json({ status: "success", teams: catalog.TEAMS, players: catalog.PLAYERS, positions: catalog.POSITIONS }));
router.get("/market", handle((req) => football.market(catalog.team(req.query.home), catalog.team(req.query.away))));
router.get("/club", authenticate, handle((req) => clubs.get(req.user.id)));
router.post("/club", authenticate, handle((req) => {
    const { duels } = require("../realtime/duels");
    if ([...duels.values()].some((duel) => duel.phase === "playing" && Object.values(duel.players).some((player) => player?.userId === req.user.id))) {
        throw new Error("Elenco bloqueado durante a partida de Duelo.");
    }
    return clubs.save(req.user.id, req.body);
}));
router.post("/start", authenticate, handle((req) => {
    const pending = rounds.getSession(req.user.id, "football");
    if (pending) {
        if (Date.now() < pending.startedAt + pending.durationMs) throw new Error("Voce ja tem uma partida em andamento.");
        state(req.user.id);
    }
    const amount = rounds.resolveWager(req.user.id, req.body);
    const match = football.create(req.body.choice, amount);
    const balance = rounds.startRound(req.user.id, "football", amount, match);
    const play = rounds.getSession(req.user.id, "football");
    return { active: true, match: football.publicMatch(play), serverTime: Date.now(), balance };
}));
router.get("/state", authenticate, handle((req) => state(req.user.id)));
module.exports = { router, state };
