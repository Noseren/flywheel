import test from 'node:test';
import assert from 'node:assert/strict';
import { quoteOrder } from '../src/pricing.js';

test('pricing: sum integer cents and exclude shipping from discount', () => {
  assert.deepEqual(quoteOrder({ A: 199, B: 101 }, [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }], { discountBps: 1000, shippingCents: 30 }),
    { subtotalCents: 499, discountCents: 49, shippingCents: 30, totalCents: 480 });
});
test('pricing: fractional cents discount rounds down', () => {
  assert.equal(quoteOrder({ A: 3 }, [{ sku: 'A', quantity: 1 }], { discountBps: 5000 }).totalCents, 2);
});
test('pricing: empty order does not charge shipping', () => {
  assert.deepEqual(quoteOrder({}, [], { shippingCents: 500 }), { subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0 });
});
test('pricing: full discount retains shipping only', () => {
  assert.equal(quoteOrder({ A: 100 }, [{ sku: 'A', quantity: 2 }], { discountBps: 10000, shippingCents: 20 }).totalCents, 20);
});
test('pricing: options and quantities are validated', () => {
  for (const options of [{ discountBps: -1 }, { discountBps: 10001 }, { discountBps: 1.5 }, { shippingCents: -1 }, { shippingCents: 0.5 }]) {
    assert.throws(() => quoteOrder({ A: 100 }, [{ sku: 'A', quantity: 1 }], options), RangeError);
  }
  assert.throws(() => quoteOrder({ A: 100 }, [{ sku: 'A', quantity: 0 }]), RangeError);
});
test('pricing: unknown or invalid catalog entries fail', () => {
  assert.throws(() => quoteOrder({}, [{ sku: 'toString', quantity: 1 }]), RangeError);
  assert.throws(() => quoteOrder({ A: -1 }, [{ sku: 'A', quantity: 1 }]), RangeError);
  assert.throws(() => quoteOrder({ A: 1.2 }, [{ sku: 'A', quantity: 1 }]), RangeError);
});
test('pricing: safe final discount uses exact arithmetic', () => {
  const price = Number.MAX_SAFE_INTEGER - 1;
  const quote = quoteOrder({ A: price }, [{ sku: 'A', quantity: 1 }], { discountBps: 9999 });
  assert.equal(quote.discountCents, Number(BigInt(price) * 9999n / 10000n));
  assert.equal(quote.totalCents, price - quote.discountCents);
});
test('pricing: unsafe totals are rejected', () => {
  assert.throws(() => quoteOrder({ A: Number.MAX_SAFE_INTEGER }, [{ sku: 'A', quantity: 2 }]), RangeError);
  assert.throws(() => quoteOrder({ A: Number.MAX_SAFE_INTEGER }, [{ sku: 'A', quantity: 1 }], { shippingCents: 1 }), RangeError);
});
test('pricing: all inputs remain unchanged', () => {
  const catalog = { A: 50 }, allocations = [{ sku: 'A', quantity: 2 }], options = { discountBps: 1000, shippingCents: 5 };
  const before = structuredClone({ catalog, allocations, options });
  quoteOrder(catalog, allocations, options);
  assert.deepEqual({ catalog, allocations, options }, before);
});
