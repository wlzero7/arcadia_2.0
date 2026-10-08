window.ArcadiaBlackjack = (() => {
    function cards(container, hand) {
        const previous = [...container.children];
        hand.forEach((card, i) => {
            const signature = card.hidden ? "hidden" : card.rank + card.suit;
            let element = previous[i];
            if (!element || element.dataset.card !== signature) {
                const replacement = document.createElement("div");
                replacement.className = "card" + (card.hidden ? " back" : ["\u2665", "\u2666"].includes(card.suit) ? " red" : "");
                replacement.dataset.card = signature;
                replacement.setAttribute("aria-label", card.hidden ? "Carta oculta" : signature);
                if (!card.hidden) {
                    const rank = document.createElement("span"), suit = document.createElement("span");
                    rank.textContent = card.rank; suit.textContent = card.suit; suit.className = "suit";
                    replacement.append(rank, suit);
                }
                if (element) element.replaceWith(replacement); else container.appendChild(replacement);
            }
        });
        for (const element of previous.slice(hand.length)) element.remove();
    }
    function controls(host, onUse) {
        host.classList.add("bj-trumps");
        host.innerHTML = `<label>Trunfo<select data-trump><option value="">Nenhum</option></select></label><label data-target-label>Alvo<select data-target><option value="dealer">Dealer</option><option value="player">Minha mao</option></select></label><label data-pick-label>Carta<select data-rank aria-label="Valor da carta">${["A","2","3","4","5","6","7","8","9","10","J","Q","K"].map((r) => `<option>${r}</option>`).join("")}</select><select data-suit aria-label="Naipe da carta">${["\u2660","\u2665","\u2666","\u2663"].map((s) => `<option>${s}</option>`).join("")}</select></label><button type="button" class="btn btn-outline" data-use>Usar trunfo</button><span data-energy></span><span class="bj-trump-status" role="status"></span>`;
        const select = host.querySelector("[data-trump]"), use = host.querySelector("[data-use]");
        let inventory = [], state = {}, busy = false;
        function render(next = state) {
            state = next;
            const selected = inventory.find((c) => c.key === select.value);
            host.querySelector("[data-target-label]").classList.toggle("hidden", select.value !== "remove_last");
            host.querySelector("[data-pick-label]").classList.toggle("hidden", select.value !== "pick_card");
            host.querySelector("[data-energy]").textContent = `NRG: ${state.nrg ?? 5} · Limite: ${state.limit || 21}`;
            select.title = selected?.houseDesc || selected?.desc || "Trunfos do inventario";
            select.disabled = busy || !state.canUse;
            use.disabled = busy || !state.canUse || !selected || selected.nrg > (state.nrg ?? 5);
        }
        async function refresh() {
            if (!ArcadiaAPI.isLoggedIn()) return;
            try {
                const data = await ArcadiaAPI.request("/api/games/blackjack/cards");
                inventory = data.inventory; const value = select.value;
                select.replaceChildren(new Option("Nenhum", ""));
                inventory.forEach((c) => select.add(new Option(`${c.name} (x${c.qty} · ${c.nrg} NRG · ${c.rarity})`, c.key)));
                select.value = inventory.some((c) => c.key === value) ? value : "";
                render();
            } catch (err) { host.querySelector(".bj-trump-status").textContent = err.message; }
        }
        select.addEventListener("change", () => render());
        use.addEventListener("click", async () => {
            if (use.disabled) return;
            busy = true; render(); host.querySelector(".bj-trump-status").textContent = "";
            try { await onUse({ cardKey: select.value, target: host.querySelector("[data-target]").value, rank: host.querySelector("[data-rank]").value, suit: host.querySelector("[data-suit]").value }); }
            catch (err) { host.querySelector(".bj-trump-status").textContent = err.message; }
            finally { busy = false; await refresh(); }
        });
        render(); return { render, refresh };
    }
    return { cards, controls };
})();
