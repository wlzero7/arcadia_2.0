window.ArcadiaBattle = (() => {
    const states = new WeakMap();
    function present(host, key, players, title = "Partida iniciada") {
        if (!host || states.get(host)?.key === key) return;
        clearTimeout(states.get(host)?.timer);
        const heading = document.createElement("strong"); heading.textContent = title;
        const row = document.createElement("div"); row.className = "battle-lineup";
        for (const player of players) {
            const item = document.createElement("div"); item.className = "battle-person";
            const avatar = document.createElement("span"); avatar.className = "battle-avatar";
            ArcadiaAvatar.render(avatar, player.avatar, player.displayName || player.username);
            const name = document.createElement("span"); name.textContent = player.displayName || player.username;
            const amount = document.createElement("small"); amount.textContent = ArcadiaWallet.format(player.entryBalance ?? player.stake ?? player.wager ?? 0);
            const text = document.createElement("div"); text.append(name, amount); item.append(avatar, text); row.append(item);
        }
        host.replaceChildren(heading, row); host.classList.remove("hidden", "battle-entering");
        void host.offsetWidth; host.classList.add("battle-entering");
        host.setAttribute("role", "status"); Sfx.battleStart();
        const timer = setTimeout(() => host.classList.add("hidden"), 3500);
        states.set(host, { key, timer });
    }
    return { present };
})();
