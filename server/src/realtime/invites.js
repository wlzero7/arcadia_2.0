// ========================================
// ARCADIA - CONVITES DE AMIGOS (v0.9.5)
// Duelo x1 e Sala Coop direto da lista de amigos.
// Cada socket entra na sala pessoal "user:<id>" — é pra lá que o convite viaja.
// ========================================

const pool = require("../config/database");
const { code: secureCode } = require("../services/random");
const { duels, createDuel } = require("./duels");
const { rooms, persistRoomCreate, persistRoomMember } = require("./rooms");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let ioRef = null;

function generateCode(len = 6) { return secureCode(len); }

function initInvites(io) {
    ioRef = io;


    io.on("connection", (socket) => {
        // sala pessoal: convites chegam em user:<id>
        socket.join(`user:${socket.userId}`);
    });
}

async function sendInvite({ fromUserId, toUsername, kind }) {
    if (!ioRef) return { ok: false, error: "Realtime indisponível." };
    if (!["duel", "coop"].includes(kind)) return { ok: false, error: "Tipo de convite inválido." };

    const from = pool.db.get(`SELECT id, username FROM users WHERE id = ?`, [fromUserId]);
    if (!from) return { ok: false, error: "Remetente inválido." };

    const target = pool.db.get(
        `SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)`,
        [String(toUsername || "").trim()]
    );
    if (!target) return { ok: false, error: "Jogador não encontrado." };
    if (target.id === fromUserId) return { ok: false, error: "Você não pode se convidar." };

    const friendship = pool.db.get(
        `SELECT 1 FROM friendships WHERE status = 'accepted'
         AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`,
        [fromUserId, target.id, target.id, fromUserId]
    );
    if (!friendship) return { ok: false, error: "Vocês não são amigos ainda." };

    let code;

    if (kind === "duel") {
        const active = [...duels.values()].find((d) => d.phase !== "finished" && Object.values(d.players).some((p) => p?.userId === fromUserId));
        const duel = active || createDuel(fromUserId, from.username);
        code = duel.code;
    } else {
        // coop: sala com pote compartilhado (dice por padrão)
        do { code = generateCode(); } while (rooms.has(code));

        const room = {
            code,
            name: `Sala de ${from.username}`,
            hostId: fromUserId,
            game: "dice",
            minBet: 10,
            maxBet: 1000,
            maxPlayers: 8,
            members: new Map(),
            stakes: new Map(),
            pot: 0,
            history: [],
            rBets: [],
            rLast: null,
            createdAt: Date.now(),
        };
        room.members.set(fromUserId, { username: from.username, socketIds: new Set(), lastSeen: Date.now() });
        persistRoomCreate(room);
        rooms.set(code, room);
        persistRoomMember(room, fromUserId, from.username);
    }

    ioRef.to(`user:${target.id}`).emit("friend:invite", {
        from: from.username,
        kind, // 'duel' | 'coop'
        code,
        at: Date.now(),
    });

    return { ok: true, code, kind };
}

module.exports = { initInvites, sendInvite };
