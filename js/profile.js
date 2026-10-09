// ========================================
// ARCADIA - PERFIL v0.9.5 — level, avatar, carteiras, conquistas, missões
// Amigos v0.9.5: favoritos + convites para duelo/coop em tempo real
// ========================================
(() => {
    const $ = (id) => document.getElementById(id);
    const AVATARS = ["🎰", "🎲", "🃏", "💣", "🚀", "🎡", "🐎", "👑", "🦊", "🐺", "🦁", "🐸", "🦅", "🐉", "🤖", "👽"];
    const KIND_LABEL = {
        bet: "Aposta", payout: "Prêmio", daily_bonus: "Bônus diário",
        room_stake: "Depósito em sala", room_payout: "Saque de sala", room_refund: "Reembolso",
        transfer_in: "Transferência recebida", transfer_out: "Transferência enviada",
    };
    function fmt(v) { return (Number(v) || 0).toLocaleString("pt-BR") + " AC"; }
    // ---------- SESSÃO / LEVEL ----------
    async function loadMe() {
        const data = await ArcadiaAPI.request("/api/auth/me");
        const u = data.user;
        ArcadiaAvatar.render($("profileAvatar"), u.avatar, u.displayName);
        $("profileName").textContent = u.displayName;
        $("profileUsername").textContent = "@" + u.username;
        $("profileLevel").textContent = "Lv " + u.level;
        const xpNext = u.xpNext;
        const pct = Math.min(100, Math.round((u.xp / xpNext) * 100));
        $("xpBar").style.width = pct + "%";
        $("xpText").textContent = `${u.xp} / ${xpNext} XP`;
        $("walletSolo").textContent = ArcadiaWallet.format(data.wallets.solo || 0);
        $("walletCoop").textContent = ArcadiaWallet.format(data.wallets.coop || 0);
        $("walletDuel").textContent = ArcadiaWallet.format(data.wallets.duel || 0);
        $("walletBalance").textContent = ArcadiaWallet.format(data.wallets.solo || 0);
        return u;
    }
    // ---------- EDITAR AVATAR ----------
    function renderAvatarPicker() {
        $("avatarPicker").remove();
        const picker = document.createElement("dialog");
        picker.id = "avatarDialog"; picker.className = "avatar-dialog";
        picker.innerHTML = `<header><h2>Foto de perfil</h2><button type="button" class="icon-button" id="avatarClose" title="Fechar" aria-label="Fechar"><i data-lucide="x"></i></button></header>
            <div class="avatar-preview" id="avatarPreview"></div>
            <div class="avatar-tabs" role="tablist"><button role="tab" aria-selected="true" id="avatarIconsTab">Ícones</button><button role="tab" aria-selected="false" id="avatarImageTab">Imagem</button></div>
            <div id="avatarIcons" class="avatar-options"></div>
            <div id="avatarImagePanel" hidden><label class="avatar-file-label" for="avatarFile"><i data-lucide="image-plus"></i> Escolher arquivo</label><input id="avatarFile" type="file" accept="image/png,image/jpeg,image/webp">
            <p class="muted">PNG, JPG ou WebP · até 5 MB · 64 a 4096 px · foto final 256 × 256</p>
            <label for="avatarUrl">URL da imagem</label><input id="avatarUrl" type="url" placeholder="https://..." autocomplete="off"></div>
            <p id="avatarStatus" role="status"></p><footer><button class="btn btn-outline" type="button" id="avatarCancel">Cancelar</button><button class="btn btn-primary" type="button" id="avatarSave">Salvar foto</button></footer>`;
        document.body.appendChild(picker);
        let selected = null, file = null, mode = "icons";
        AVATARS.forEach((a) => {
            const b = document.createElement("button");
            b.className = "avatar-option";
            b.textContent = a; b.type = "button"; b.setAttribute("aria-label", a); b.setAttribute("aria-pressed", "false");
            b.addEventListener("click", () => {
                selected = a;
                picker.querySelectorAll(".avatar-option").forEach((option) => option.setAttribute("aria-pressed", String(option === b)));
                ArcadiaAvatar.render($("avatarPreview"), a);
            });
            $("avatarIcons").appendChild(b);
        });
        const edit = $("editAvatarBtn"); edit.title = "Editar foto de perfil"; edit.setAttribute("aria-label", edit.title); edit.classList.add("icon-button"); edit.innerHTML = '<i data-lucide="pencil"></i>';
        edit.addEventListener("click", () => {
            selected = null; file = null; $("avatarFile").value = ""; $("avatarUrl").value = ""; $("avatarStatus").textContent = "";
            $("avatarPreview").replaceChildren(...Array.from($("profileAvatar").childNodes, (node) => node.cloneNode(true)));
            picker.showModal();
        });
        for (const id of ["avatarClose", "avatarCancel"]) $(id).addEventListener("click", () => picker.close());
        for (const [id, value] of [["avatarIconsTab", "icons"], ["avatarImageTab", "image"]]) $(id).addEventListener("click", () => {
            mode = value; $("avatarIcons").hidden = mode !== "icons"; $("avatarImagePanel").hidden = mode !== "image";
            $("avatarIconsTab").setAttribute("aria-selected", String(mode === "icons")); $("avatarImageTab").setAttribute("aria-selected", String(mode === "image"));
            $("avatarStatus").textContent = "";
        });
        $("avatarFile").addEventListener("change", () => {
            file = $("avatarFile").files[0]; $("avatarUrl").value = "";
            if (!file) return;
            if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) { file = null; $("avatarStatus").textContent = "Use PNG, JPG ou WebP de até 5 MB."; return; }
            const reader = new FileReader();
            reader.onload = () => { const image = new Image(); image.src = reader.result; image.alt = "Prévia da foto"; $("avatarPreview").replaceChildren(image); };
            reader.readAsDataURL(file);
        });
        $("avatarUrl").addEventListener("input", () => { file = null; $("avatarFile").value = ""; });
        $("avatarSave").addEventListener("click", async () => {
            const save = $("avatarSave"); save.disabled = true; $("avatarStatus").textContent = "Salvando...";
            try {
                if (mode === "icons") {
                    if (!selected) throw new Error("Escolha um ícone.");
                    await ArcadiaAPI.request("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ avatar: selected }) });
                } else if (file) await ArcadiaAPI.request("/api/avatars/upload", { method: "POST", body: file, headers: { "Content-Type": file.type } });
                else {
                    const url = $("avatarUrl").value.trim();
                    if (!url.startsWith("https://")) throw new Error("Escolha um arquivo ou informe uma URL HTTPS.");
                    await ArcadiaAPI.request("/api/avatars/import", { method: "POST", body: JSON.stringify({ url }) });
                }
                await loadMe(); picker.close(); edit.focus();
            } catch (error) { $("avatarStatus").textContent = error.message; }
            finally { save.disabled = false; }
        });
        window.lucide?.createIcons();
    }
    // ---------- CONQUISTAS ----------
    async function loadAchievements() {
        const data = await ArcadiaAPI.request("/api/progression/achievements");
        const list = $("achievementsList");
        list.innerHTML = "";
        data.achievements.forEach((a) => {
            const div = document.createElement("div");
            div.className = "achieve " + (a.unlocked ? "unlocked" : "locked");
            div.innerHTML = `<span class="achieve-icon">${a.unlocked ? "🏆" : "🔒"}</span><span class="achieve-copy"><strong>${ArcadiaAPI.escapeHtml(a.name)}</strong><small>${ArcadiaAPI.escapeHtml(a.desc)}</small></span><span class="achieve-xp">+${a.xp} XP<br>+${Number(a.ac).toLocaleString("pt-BR")} AC<small>Solo · Duelo · Coop</small></span>`;
            list.appendChild(div);
        });
    }
    // ---------- MISSÕES ----------
    async function loadBugReports() {
        let section = $("bugReports");
        if (!section) {
            section = document.createElement("section");
            section.id = "bugReports";
            section.className = "bug-reports";
            section.innerHTML = `<h2>Relatos de bugs</h2><form id="bugForm"><label>Título<input name="title" minlength="5" maxlength="120" required></label><label>Relato<textarea name="description" minlength="20" maxlength="4000" rows="4" required></textarea></label><button class="btn btn-primary">Enviar relato</button><span id="bugStatus" role="status"></span></form><div id="bugList"></div>`;
            document.querySelector(".profile-main").appendChild(section);
            $("bugForm").addEventListener("submit", async (event) => {
                event.preventDefault();
                const button = event.target.querySelector("button");
                button.disabled = true;
                try {
                    const result = await ArcadiaAPI.request("/api/progression/bugs", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
                    $("bugStatus").textContent = result.message;
                    event.target.reset(); await loadBugReports();
                } catch (err) { $("bugStatus").textContent = err.message; }
                finally { button.disabled = false; }
            });
        }
        const data = await ArcadiaAPI.request("/api/progression/bugs");
        $("bugList").replaceChildren();
        const labels = { pending: "Aguardando análise", approved: "Aprovado", rejected: "Rejeitado" };
        for (const report of data.reports) {
            const row = document.createElement("article");
            row.innerHTML = `<h3>${ArcadiaAPI.escapeHtml(report.title)}</h3><p>${ArcadiaAPI.escapeHtml(report.description)}</p><small>@${ArcadiaAPI.escapeHtml(report.username)} · ${labels[report.status]}</small>`;
            if (data.canReview && report.status === "pending") for (const approved of [true, false]) {
                const button = document.createElement("button");
                button.className = "btn"; button.textContent = approved ? "Aprovar" : "Rejeitar";
                button.addEventListener("click", async () => {
                    button.disabled = true;
                    try { await ArcadiaAPI.request(`/api/progression/bugs/${report.id}/review`, { method: "POST", body: JSON.stringify({ approved }) }); await loadBugReports(); }
                    catch (err) { $("bugStatus").textContent = err.message; button.disabled = false; }
                });
                row.appendChild(button);
            }
            $("bugList").appendChild(row);
        }
    }
    async function loadMissions() {
        const data = await ArcadiaAPI.request("/api/progression/missions");
        const daily = $("missionsDaily");
        const weekly = $("missionsWeekly");
        for (const [cadence, element] of [["daily", daily], ["weekly", weekly]]) {
            const missions = data.missions.filter((m) => m.cadence === cadence);
            element.textContent = `${missions.filter((m) => m.completed).length} de ${missions.length} concluídas`;
        }
        const ready = data.missions.filter((m) => m.completed && !m.claimed);
        const reward = ready.reduce((sum, m) => sum + m.xp, 0);
        const ac = ready.reduce((sum, m) => sum + m.ac, 0);
        $("missionsReward").textContent = `${reward.toLocaleString("pt-BR")} XP + ${ac.toLocaleString("pt-BR")} AC por carteira`;
    }
    // ---------- ESTATÍSTICAS COMPLETAS (v0.9.3) ----------
    const GAME_ICON = {
        dice: "🎲", coinflip: "🪙", mines: "💣", crash: "🚀",
        blackjack: "🃏", roulette: "🎡", racing: "🐎",
    };
    function fmt(v) { return (Number(v) || 0).toLocaleString("pt-BR") + " AC"; }
    function signed(v) { const n = Number(v) || 0; return (n >= 0 ? "+" : "") + fmt(n); }
    async function loadFullStats() {
        try {
            const data = await ArcadiaAPI.request("/api/games/stats/full");
            const s = data.stats;
            // herói
            const netEl = $("stNetBig");
            netEl.textContent = signed(s.net);
            netEl.className = "stat-big " + (s.net >= 0 ? "pos" : "neg");
            // grid
            $("stCoins").textContent = fmt((s.wallets.solo || 0) + (s.wallets.coop || 0) + (s.wallets.duel || 0));
            $("stWinsBig").textContent = s.wins;
            $("stLossesBig").textContent = s.losses;
            $("stWagered").textContent = fmt(s.totalWagered);
            $("stBestRound").textContent = s.bestRound ? signed(s.bestRound.profit) : "—";
            $("stWorstRound").textContent = s.worstRound ? signed(s.worstRound.profit) : "—";
            $("stBestGame").textContent = s.bestGame ? `${GAME_ICON[s.bestGame.game] || "🎮"} ${s.bestGame.game} (${signed(s.bestGame.net)})` : "—";
            $("stMostPlayed").textContent = s.mostPlayed ? `${GAME_ICON[s.mostPlayed.game] || "🎮"} ${s.mostPlayed.game} (${s.mostPlayed.games}x)` : "—";
            $("stLeastPlayed").textContent = s.leastPlayed ? `${GAME_ICON[s.leastPlayed.game] || "🎮"} ${s.leastPlayed.game} (${s.leastPlayed.games}x)` : "—";
            $("stAch").textContent = s.achievementsUnlocked;
            $("stDuelWins").textContent = s.duel.wins;
            $("stMpWins").textContent = s.multiplayer.rouletteWins;
            // por jogo com barras
            const bg = $("statsByGame");
            bg.innerHTML = "";
            if (!s.byGame.length) {
                bg.innerHTML = '<span class="muted">Jogue sua primeira partida para ver estatísticas por jogo!</span>';
                return;
            }
            const maxGames = Math.max(...s.byGame.map((g) => g.games));
            s.byGame.forEach((g) => {
                const div = document.createElement("div");
                div.className = "bygame-row";
                div.innerHTML = `
                    <span class="bg-name">${GAME_ICON[g.game] || "🎮"} ${g.game}</span>
                    <div class="bg-bar"><div style="width:${Math.round((g.games / maxGames) * 100)}%"></div></div>
                    <span>${g.games} rodadas</span>
                    <span class="bg-net ${g.net >= 0 ? "pos" : "neg"}">${signed(g.net)}</span>
                `;
                bg.appendChild(div);
            });
        } catch (err) {
            console.warn("stats:", err.message);
        }
    }
    // ---------- STATS + EXTRATO ----------
    async function loadStats() {
        const data = await ArcadiaAPI.request("/api/games/stats");
        $("stGames").textContent = data.stats.total_games || 0;
        $("stWins").textContent = data.stats.total_wins || 0;
        const net = Number(data.stats.net) || 0;
        $("stNet").textContent = (net >= 0 ? "+" : "") + fmt(net);
        $("stNet").style.color = net >= 0 ? "var(--success)" : "var(--danger)";
    }
    async function loadTx() {
        const data = await ArcadiaAPI.request("/api/wallet/transactions");
        const list = $("txList");
        list.innerHTML = "";
        data.transactions.slice(0, 30).forEach((tx) => {
            const div = document.createElement("div");
            div.className = "tx-item";
            const positive = tx.amount >= 0;
            div.innerHTML = `
                <span class="when">${tx.created_at}</span>
                <span class="kind">${KIND_LABEL[tx.kind] || tx.kind}</span>
                <span class="amount ${positive ? "positive" : "negative"}">${positive ? "+" : ""}${fmt(tx.amount)}</span>
            `;
            list.appendChild(div);
        });
    }
    let friendsData = { friends: [], requests: [], sent: [] };
    function friendIdentity(friend) {
        const link = document.createElement("a"); link.className = "friend-identity";
        link.href = "perfil-publico.html?u=" + encodeURIComponent(friend.username);
        const avatar = document.createElement("span"); avatar.className = "player-avatar";
        const label = friend.displayName || friend.display_name || friend.username;
        ArcadiaAvatar.render(avatar, friend.avatar, label);
        const copy = document.createElement("span");
        const name = document.createElement("strong"); name.textContent = label;
        const detail = document.createElement("small"); detail.textContent = "@" + friend.username + " · Lv " + (friend.level || 1);
        copy.append(name, detail); link.append(avatar, copy); return link;
    }
    function friendButton(icon, title, action, selected = false) {
        const button = document.createElement("button"); button.type = "button";
        button.className = "icon-button friend-action"; button.title = title; button.setAttribute("aria-label", title);
        button.innerHTML = '<i data-lucide="' + icon + '"></i>';
        if (icon === "star") button.setAttribute("aria-pressed", String(selected));
        button.addEventListener("click", async () => {
            button.disabled = true;
            try { await action(); }
            catch (error) { $("friendStatus").textContent = error.message; }
            finally { button.disabled = false; }
        });
        return button;
    }
    async function friendChange(path, body, message) {
        await ArcadiaAPI.request("/api/friends/" + path, { method: "POST", body: JSON.stringify(body) });
        await loadFriends(); $("friendStatus").textContent = message;
    }
    function renderFriends() {
        const query = $("friendSearch").value.trim().toLocaleLowerCase("pt-BR");
        const visible = friendsData.friends.filter((friend) => ((friend.displayName || "") + " " + friend.username).toLocaleLowerCase("pt-BR").includes(query));
        $("friendsCount").textContent = friendsData.friends.length;
        const list = $("friendsList"); list.replaceChildren();
        if (!visible.length) {
            const empty = document.createElement("li"); empty.className = "friends-empty";
            empty.textContent = query ? "Nenhum amigo encontrado." : "Sua lista esta vazia."; list.append(empty);
        }
        for (const friend of visible) {
            const row = document.createElement("li"); row.className = "friend-row";
            const actions = document.createElement("div"); actions.className = "friend-actions";
            actions.append(friendButton("star", friend.favorite ? "Remover favorito" : "Favoritar", () => friendChange("favorite", { friendId: friend.id }, "Favoritos atualizados."), !!friend.favorite));
            for (const [kind, icon, title] of [["duel", "swords", "Convidar para Duelo"], ["coop", "gamepad-2", "Convidar para Coop"]]) actions.append(friendButton(icon, title, async () => {
                const invite = await ArcadiaAPI.request("/api/friends/invite", { method: "POST", body: JSON.stringify({ username: friend.username, kind }) });
                $("friendStatus").textContent = "Convite enviado. Codigo: " + invite.code;
            }));
            actions.append(friendButton("user-minus", "Remover amizade", async () => {
                if (confirm("Remover a amizade com " + friend.username + "?")) await friendChange("remove", { friendId: friend.id }, "Amizade removida.");
            }));
            row.append(friendIdentity(friend), actions); list.append(row);
        }
        const requests = $("friendRequests"); requests.replaceChildren();
        for (const [items, outgoing] of [[friendsData.requests, false], [friendsData.sent || [], true]]) {
            if (!items.length) continue;
            const heading = document.createElement("h3"); heading.textContent = outgoing ? "Enviados" : "Recebidos"; requests.append(heading);
            for (const friend of items) {
                const row = document.createElement("div"); row.className = "friend-request";
                const actions = document.createElement("div"); actions.className = "friend-actions";
                if (!outgoing) actions.append(friendButton("check", "Aceitar pedido", () => friendChange("accept", { requestId: friend.from_id }, "Amizade aceita.")));
                actions.append(friendButton("x", outgoing ? "Cancelar pedido" : "Recusar pedido", () => friendChange("remove", { friendId: friend.id }, "Pedido removido.")));
                row.append(friendIdentity(friend), actions); requests.append(row);
            }
        }
        window.lucide?.createIcons();
    }
    async function loadFriends() {
        try { friendsData = await ArcadiaAPI.request("/api/friends"); renderFriends(); }
        catch (error) { $("friendStatus").textContent = error.message; }
    }
    $("friendSearch").addEventListener("input", renderFriends);
    $("friendForm").addEventListener("submit", async (event) => {
        event.preventDefault(); $("addFriendBtn").disabled = true;
        try {
            await friendChange("request", { username: $("friendUsername").value.trim() }, "Pedido de amizade enviado.");
            $("friendUsername").value = "";
        } catch (err) { $("friendStatus").textContent = err.message; }
        finally { $("addFriendBtn").disabled = false; }
    });
    async function loadCommunityStats() {
        try { const { mine } = await ArcadiaAPI.request("/api/community/stats");
            for (const [id, key] of [["communityTopics", "topics"], ["communityFeedbacks", "feedbacks"], ["communityComments", "comments"]]) $(id).textContent = mine[key];
        } catch (error) { $("communityTopics").textContent = "—"; }
    }
    // ---------- CONVITES EM TEMPO REAL (Socket.IO) ----------
    (function setupInvites() {
        const s = document.createElement("script");
        s.src = "/socket.io/socket.io.js";
        s.onload = () => {
            const socket = io(window.API_URL, {
                auth: { token: ArcadiaAPI.getToken() },
                transports: ["websocket", "polling"],
            });
            socket.on("friend:invite", (inv) => {
                const kind = inv.kind === "duel" ? "Duelo x1" : "Sala coop";
                if (confirm(`🎮 ${inv.from} convidou você para ${kind}!\nCódigo: ${inv.code}\n\nAceitar agora?`)) {
                    try { navigator.clipboard.writeText(inv.code); } catch (_) {}
                    const page = inv.kind === "duel" ? "duel.html" : "rooms.html";
                    window.location.href = page + "?code=" + encodeURIComponent(inv.code);
                }
            });
        };
        document.head.appendChild(s);
    })();
    $("logoutBtn").addEventListener("click", async () => {
        await ArcadiaAPI.logout();
        window.location.href = "index.html";
    });
    // ---------- GATE: precisa estar logado ----------
    function renderLoginGate() {
        document.querySelector(".profile-main").innerHTML = `
            <div class="auth-required">
                <div class="auth-required-icon">🔒</div>
                <h2>Ops! Essa área é só para membros</h2>
                <p>Crie sua conta grátis ou faça login para ver seu perfil, estatísticas, conquistas e missões.</p>
                <div class="auth-required-actions">
                    <a href="index.html" class="btn btn-primary">Entrar / Criar conta</a>
                </div>
                <p class="muted">É rápido — e você já começa com <strong>1.000.000 AC</strong> de bônus. 🎁</p>
            </div>
        `;
    }
    // ---------- INIT ----------
    (async function init() {
        await ArcadiaAPI.ready;
        if (!ArcadiaAPI.isLoggedIn()) {
            renderLoginGate();
            return;
        }
        try {
            renderAvatarPicker();
            await loadAchievements();
            await loadMe();
            loadBugReports();
            loadMissions();
            loadStats();
            loadFullStats();
            loadTx();
            loadFriends();
            loadCommunityStats();
        } catch (err) {
            // token inválido/expirado
            if (err.status === 401) renderLoginGate();
            else console.warn("Perfil:", err.message);
        }
    })();
})();
