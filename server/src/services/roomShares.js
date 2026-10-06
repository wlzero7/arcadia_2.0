function allocateShares(stakes, total) {
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Saldo fora do limite permitido.");
    const entries = [...stakes].filter(([, value]) => value > 0);
    const weight = entries.reduce((sum, [, value]) => sum + BigInt(value), 0n);
    if (!weight) {
        if (total) throw new Error("Pote sem participantes.");
        return new Map([...stakes.keys()].map((id) => [id, 0]));
    }
    const shares = entries.map(([id, value]) => {
        const product = BigInt(value) * BigInt(total);
        return { id, amount: Number(product / weight), remainder: product % weight };
    });
    shares.sort((a, b) => a.remainder === b.remainder ? a.id - b.id : a.remainder > b.remainder ? -1 : 1);
    const remaining = total - shares.reduce((sum, entry) => sum + entry.amount, 0);
    for (let i = 0; i < remaining; i++) shares[i].amount++;
    const result = new Map([...stakes.keys()].map((id) => [id, 0]));
    for (const entry of shares) result.set(entry.id, entry.amount);
    return result;
}
module.exports = { allocateShares };
