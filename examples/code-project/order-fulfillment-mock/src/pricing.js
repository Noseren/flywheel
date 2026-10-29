// Deliberately incomplete starting point. All money is denominated in cents.
export function quoteOrder(catalog, allocations, options = {}) {
  const subtotalCents = allocations.reduce((sum, line) => sum + catalog[line.sku] * line.quantity, 0);
  const discountCents = Math.round(subtotalCents * (options.discountBps ?? 0) / 10000);
  const shippingCents = options.shippingCents ?? 0;
  return { subtotalCents, discountCents, shippingCents, totalCents: subtotalCents - discountCents + shippingCents };
}
