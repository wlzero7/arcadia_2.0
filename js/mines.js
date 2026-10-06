// ========================================
// ARCADIA MINES — cliente (estado no servidor)
// ========================================

(() => {

    const $ = (id) => document.getElementById(id);

    const board = $("minesBoard");
    const startBtn = $("startBtn");
    const cashoutBtn = $("cashoutBtn");
    const betInput = $("betAmount");
    const minesInput = $("minesCount");
    const msg = $("gameMessage");
    const currentMult = $("currentMult");
    const nextMult = $("nextMult");
    const potential = $("potential");

    let playing = false, busy = false;
    const opened = new Set();
    function lockBoard() {
        cells.forEach((cell, index) => { cell.disabled = !playing || busy || opened.has(index) || opened.size >= 25 - Number(minesInput.value); });
        betInput.disabled = playing;
        minesInput.disabled = playing;
    }

    // ---------- GRID ----------
    for (let i = 0; i < 25; i++) {
        const cell = document.createElement("button");
        cell.className = "mine-cell";
        cell.dataset.index = i;
        cell.disabled = true;
        cell.addEventListener("click", () => pick(i));
        board.appendChild(cell);
    }

    const cells = board.querySelectorAll(".mine-cell");

    function resetBoard() {
        cells.forEach((c) => {
            c.textContent = "";
            c.className = "mine-cell";
            c.disabled = !playing;
        });
    }

    function setMessage(text, cls) {
        msg.textContent = text;
        msg.className = "game-result" + (cls ? " " + cls : "");
    }

    function fmt(v) {
        return (Number(v) || 0).toLocaleString("pt-BR") + " AC";
    }
    function showMultipliers(data) {
        currentMult.textContent = data.multiplier.toFixed(2) + "x";
        nextMult.textContent = data.nextMultiplier == null ? "-" : data.nextMultiplier.toFixed(2) + "x";
        potential.textContent = fmt(data.potentialPayout);
    }

    function updateWallet(balance) {
        if (Number.isFinite(balance)) {
            ArcadiaWallet.setCached(balance);
            const el = document.getElementById("walletBalance");
            if (el) el.textContent = ArcadiaWallet.format(balance);
        }
    }

    // ---------- START ----------
    startBtn.addEventListener("click", async () => {
        await ArcadiaAPI.ready;
        if (busy) return;
        if (!ArcadiaAPI.isLoggedIn()) {
            setMessage("Entre na sua conta para jogar (página inicial).", "loss");
            return;
        }

        try {
            busy = true;
            startBtn.disabled = true;
            opened.clear();
            const data = await ArcadiaAPI.request("/api/games/mines/start", {
                method: "POST",
                body: JSON.stringify({
                    wager: Number(betInput.value),
                    mines: Number(minesInput.value),
                }),
            });

            playing = true;
            showMultipliers(data);
            resetBoard();
            cells.forEach((c) => (c.disabled = false));
            startBtn.classList.add("hidden");
            cashoutBtn.classList.remove("hidden");
            cashoutBtn.disabled = false;
            cashoutBtn.textContent = "Sacar " + fmt(data.wager);
            setMessage("Escolha uma célula. Boa sorte! 💣");
            updateWallet(data.balance);
        } catch (err) {
            setMessage(err.message, "loss");
        } finally {
            busy = false;
            startBtn.disabled = false;
            lockBoard();
        }
    });

    // ---------- PICK ----------
    async function pick(index) {
        if (!playing || busy) return;
        busy = true;
        lockBoard();
        cashoutBtn.disabled = true;
        const cell = cells[index];
        cell.disabled = true;

        try {
            const data = await ArcadiaAPI.request("/api/games/mines/pick", {
                method: "POST",
                body: JSON.stringify({ cell: index }),
            });

            if (data.boom) {
                // explodiu
                Sfx.boom();
                cell.textContent = "💥";
                cell.classList.add("boom");
                revealMines(data.mines);
                endRound(`💥 BOOM! Você perdeu ${fmt(Number(betInput.value))}.`, "loss");
                updateWallet(data.balance);
            } else {
                Sfx.gem();
                opened.add(index);
                cell.textContent = "💎";
                cell.classList.add("gem");
                showMultipliers(data);
                cashoutBtn.disabled = false;
                cashoutBtn.textContent = `💰 Sacar ${fmt(data.potentialPayout)}`;
                setMessage(`${data.picks} célula(s) segura(s). Continuar ou sacar?`);
            }
        } catch (err) {
            setMessage(err.message, "loss");
        } finally {
            busy = false;
            cashoutBtn.disabled = false;
            lockBoard();
        }
    }

    // ---------- CASHOUT ----------
    cashoutBtn.addEventListener("click", async () => {
        if (busy || !playing) return;
        busy = true;
        lockBoard();
        try {
            cashoutBtn.disabled = true;
            const data = await ArcadiaAPI.request("/api/games/mines/cashout", { method: "POST" });

            Sfx.cashout();
            revealMines(data.mines);
            endRound(`🎉 Sacou ${fmt(data.payout)} (${data.multiplier.toFixed(2)}x)!`, "win");
            updateWallet(data.balance);
        } catch (err) {
            setMessage(err.message, "loss");
        } finally {
            busy = false;
            cashoutBtn.disabled = false;
            lockBoard();
        }
    });

    // ---------- HELPERS ----------
    function revealMines(mines) {
        cells.forEach((c, i) => {
            c.disabled = true;
            if (mines.includes(i) && !c.classList.contains("boom")) {
                c.textContent = "💣";
                c.classList.add("dim");
            }
        });
    }

    function endRound(text, cls) {
        playing = false;
        lockBoard();
        setMessage(text, cls);
        cashoutBtn.classList.add("hidden");
        startBtn.classList.remove("hidden");
        currentMult.textContent = "—";
        nextMult.textContent = "—";
        potential.textContent = "—";
        ArcadiaWallet.refresh();
    }

    // ---------- INIT ----------
    async function init() {
        await ArcadiaAPI.ready;
        if (ArcadiaAPI.isLoggedIn()) {
            await ArcadiaWallet.refresh();
            const state = await ArcadiaAPI.request("/api/games/mines/state");
            if (state.active) {
                playing = true;
                betInput.value = state.wager;
                minesInput.value = state.minesCount;
                for (const index of state.picked) {
                    opened.add(index);
                    cells[index].textContent = "💎"; cells[index].classList.add("gem");
                }
                startBtn.classList.add("hidden"); cashoutBtn.classList.remove("hidden");
                cashoutBtn.disabled = false; cashoutBtn.textContent = "Sacar " + fmt(state.potentialPayout);
                showMultipliers(state);
                lockBoard();
            }
        }
    }

    init().catch((err) => setMessage(err.message, "loss"));
})();
