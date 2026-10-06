(async () => {
        const username = new URLSearchParams(location.search).get("u");
        const box = document.getElementById("publicProfile");

        if (!username) {
            box.innerHTML = `<div class="empty-state">
                <div class="empty-icon">🔍</div>
                <h3>Jogador não informado</h3>
                <p>Use o link <code>perfil-publico.html?u=username</code> para ver as estatísticas de alguém.</p>
            </div>`;
            return;
        }

        try {
            const r = await fetch(`${window.API_URL}/api/games/public/${encodeURIComponent(username)}`);
            const d = await r.json();
            if (!r.ok) throw new Error(d.message);

            const p = d.profile;
            const GAME_ICON = { dice: "🎲", coinflip: "🪙", mines: "💣", crash: "🚀", blackjack: "🃏", roulette: "🎡", racing: "🐎" };
            const signed = (v) => (Number(v) >= 0 ? "+" : "") + (Number(v) || 0).toLocaleString("pt-BR") + " AC";

            const byGame = p.byGame.map((g) => `
                <div class="bygame-row">
                    <span class="bg-name">${GAME_ICON[g.game] || "🎮"} ${ArcadiaAPI.escapeHtml(g.game)}</span>
                    <div class="bg-bar"><div style="width:60%"></div></div>
                    <span>${g.games} rodadas</span>
                    <span class="bg-net ${g.net >= 0 ? "pos" : "neg"}">${signed(g.net)}</span>
                </div>`).join("");

            box.innerHTML = `
                <section class="profile-hero">
                    <div class="profile-id">
                        <div class="avatar">${ArcadiaAPI.escapeHtml(p.avatar)}</div>
                        <div>
                            <h1>${ArcadiaAPI.escapeHtml(p.displayName)}</h1>
                            <p class="muted">@${ArcadiaAPI.escapeHtml(p.username)} · membro desde ${p.memberSince ? p.memberSince.slice(0, 10) : "?"}</p>
                            <div class="xp-wrap">
                                <span class="level-badge">Lv ${p.level}</span>
                            </div>
                        </div>
                    </div>
                </section>

                <div class="profile-grid">
                    <section class="profile-card wide">
                        <h2>📊 Estatísticas de ${ArcadiaAPI.escapeHtml(p.displayName)}</h2>
                        <div class="stats-hero">
                            <div class="stat-big ${p.net >= 0 ? "pos" : "neg"}">${signed(p.net)}</div>
                            <div class="muted">Lucro total</div>
                        </div>
                        <div class="stats-grid">
                            <div class="stat-box"><span class="muted">Partidas</span><strong>${p.totalGames}</strong></div>
                            <div class="stat-box"><span class="muted">Vitórias</span><strong class="pos">${p.wins}</strong></div>
                            <div class="stat-box"><span class="muted">🏆 Conquistas</span><strong>${p.achievements}</strong></div>
                            <div class="stat-box"><span class="muted">⚔️ Duelos ganhos</span><strong>${p.duelWins}</strong></div>
                            <div class="stat-box"><span class="muted">⚔️ Duelos perdidos</span><strong>${p.duelLosses}</strong></div>
                        </div>
                        <h3 style="margin-top:1.2rem; font-size:.95rem;">Por jogo</h3>
                        <div class="stats-bygame">${byGame || '<span class="muted">Sem partidas ainda.</span>'}</div>
                    </section>
                </section>
            `;
        } catch (err) {
            box.innerHTML = `<div class="empty-state">
                <div class="empty-icon">👻</div>
                <h3>${err.message || "Perfil não encontrado"}</h3>
                <p>Confira o username e tente de novo.</p>
            </div>`;
        }
    })();
