const { randomInt } = require("./random");
const { wager } = require("./rounds");
const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const TYPES = ["straight", "red", "black", "even", "odd", "low", "high", "dozen1", "dozen2", "dozen3"];
function validateBet(bet, min = 10, max = 1000000) {
    if (!bet || !TYPES.includes(bet.type)) throw new Error("Tipo de aposta inválido.");
    const amount = wager(bet.amount, min, max);
    const value = bet.type === "straight" ? Number(bet.value) : null;
    if (bet.type === "straight" && (bet.value == null || !Number.isInteger(value) || value < 0 || value > 36)) throw new Error("Número inválido.");
    return { ...bet, amount, value };
}
function spin(bets) {
    const number = randomInt(37);
    const color = number === 0 ? "green" : RED.has(number) ? "red" : "black";
    const results = bets.map((b) => {
        let multiplier = 0;
        if (b.type === "straight" && b.value === number) multiplier = 36;
        else if (b.type === color || (b.type === "even" && number !== 0 && number % 2 === 0) || (b.type === "odd" && number % 2 === 1) || (b.type === "low" && number >= 1 && number <= 18) || (b.type === "high" && number >= 19)) multiplier = 2;
        else if ((b.type === "dozen1" && number >= 1 && number <= 12) || (b.type === "dozen2" && number >= 13 && number <= 24) || (b.type === "dozen3" && number >= 25)) multiplier = 3;
        return { ...b, won: multiplier > 0, payout: b.amount * multiplier };
    });
    const totalWager = bets.reduce((sum, b) => sum + b.amount, 0);
    const totalPayout = results.reduce((sum, b) => sum + b.payout, 0);
    return { number, color, results, totalWager, totalPayout, outcome: totalPayout > totalWager ? "win" : totalPayout === totalWager ? "push" : "loss" };
}
module.exports = { validateBet, spin };
