// Deliberately incomplete starting point. The public contract is in goal.md.
export function planReservation(stock, lines) {
  const allocations = [];
  for (const { sku, quantity } of lines) {
    if (!(sku in stock)) return { ok: false, errors: [{ code: 'unknown_sku', sku }] };
    if (stock[sku] < quantity) return { ok: false, errors: [{ code: 'insufficient_stock', sku }] };
    stock[sku] -= quantity;
    allocations.push({ sku, quantity });
  }
  return { ok: true, stock, allocations };
}
