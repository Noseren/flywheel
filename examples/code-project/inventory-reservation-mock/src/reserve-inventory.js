export function reserveInventory(stock, requests) {
  const nextStock = { ...stock };
  const allocations = [];

  for (const request of requests) {
    const available = nextStock[request.sku];
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      return { ok: false, errors: [`Invalid quantity for ${request.sku}`] };
    }
    if (available === undefined) {
      return { ok: false, errors: [`Unknown SKU: ${request.sku}`] };
    }
    if (available < request.quantity) {
      return { ok: false, errors: [`Insufficient stock for ${request.sku}`] };
    }

    nextStock[request.sku] -= request.quantity;
    allocations.push({ sku: request.sku, quantity: request.quantity });
  }

  return { ok: true, stock: nextStock, allocations };
}
