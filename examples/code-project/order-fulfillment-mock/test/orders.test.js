import test from 'node:test';
import assert from 'node:assert/strict';
import { fulfillOrder } from '../src/orders.js';

const initial = () => ({ stock: { A: 4, B: 2 }, catalog: { A: 199, B: 101 }, completed: {} });
const order = () => ({ id: 'order-1', lines: [{ sku: 'A', quantity: 2 }, { sku: 'B', quantity: 1 }], options: { discountBps: 1000, shippingCents: 30 } });

test('orders: success atomically returns a new state and exact receipt', () => {
  const state = initial(), request = order(), before = structuredClone({ state, request });
  const result = fulfillOrder(state, request);
  assert.equal(result.ok, true); assert.equal(result.replayed, false); assert.notEqual(result.state, state);
  assert.notEqual(result.state.completed, state.completed);
  assert.deepEqual(result.state.stock, { A: 2, B: 1 });
  assert.deepEqual(result.receipt, { id: 'order-1', allocations: request.lines, pricing: { subtotalCents: 499, discountCents: 49, shippingCents: 30, totalCents: 480 } });
  assert.deepEqual({ state, request }, before);
});
test('orders: replay succeeds after original reservation depleted stock', () => {
  const request = { id: 'all-A', lines: [{ sku: 'A', quantity: 4 }] };
  const first = fulfillOrder(initial(), request), snapshot = structuredClone(first.state);
  const replay = fulfillOrder(first.state, structuredClone(request));
  assert.equal(replay.ok, true); assert.equal(replay.replayed, true); assert.equal(replay.state, first.state);
  assert.deepEqual(replay.receipt, first.receipt); assert.deepEqual(first.state, snapshot);
});
test('orders: omitted options and explicit defaults are idempotent', () => {
  const request = { id: 'defaults', lines: [{ sku: 'A', quantity: 1 }] };
  const first = fulfillOrder(initial(), request);
  const replay = fulfillOrder(first.state, { ...request, options: { discountBps: 0, shippingCents: 0 } });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);
});
test('orders: id reuse with changed lines or options is a conflict', () => {
  const request = order(), first = fulfillOrder(initial(), request);
  for (const changed of [{ ...request, lines: [{ sku: 'B', quantity: 1 }] }, { ...request, options: { shippingCents: 99 } }]) {
    const before = structuredClone(first.state), result = fulfillOrder(first.state, changed);
    assert.deepEqual(result, { ok: false, state: first.state, errors: [{ code: 'idempotency_conflict' }] });
    assert.deepEqual(first.state, before);
  }
});
test('orders: inventory failure preserves all state', () => {
  const state = initial(), before = structuredClone(state);
  const result = fulfillOrder(state, { id: 'short', lines: [{ sku: 'A', quantity: 1 }, { sku: 'B', quantity: 3 }] });
  assert.deepEqual(result, { ok: false, state, errors: [{ code: 'insufficient_stock', sku: 'B' }] });
  assert.deepEqual(state, before);
});
test('orders: pricing failure cannot consume inventory or reserve id', () => {
  const state = initial(), before = structuredClone(state);
  const result = fulfillOrder(state, { id: 'bad-price', lines: [{ sku: 'A', quantity: 1 }], options: { discountBps: 10001 } });
  assert.deepEqual(result, { ok: false, state, errors: [{ code: 'invalid_pricing' }] });
  assert.deepEqual(state, before);
});
test('orders: a failed order can be corrected with the same id', () => {
  const state = initial();
  const rejected = fulfillOrder(state, { id: 'retry', lines: [{ sku: 'A', quantity: 99 }] });
  assert.equal(rejected.ok, false);
  const corrected = fulfillOrder(state, { id: 'retry', lines: [{ sku: 'A', quantity: 1 }] });
  assert.equal(corrected.ok, true); assert.equal(corrected.replayed, false); assert.equal(corrected.state.stock.A, 3);
});
test('orders: invalid id is rejected before effects', () => {
  for (const id of ['', 0, null]) {
    const state = initial(), before = structuredClone(state);
    assert.deepEqual(fulfillOrder(state, { id, lines: [{ sku: 'A', quantity: 1 }] }), { ok: false, state, errors: [{ code: 'invalid_order_id' }] });
    assert.deepEqual(state, before);
  }
});
test('orders: prototype-like order ids are ordinary own keys', () => {
  for (const id of ['toString', 'constructor', '__proto__']) {
    const state = initial(), request = { id, lines: [{ sku: 'A', quantity: 1 }] };
    const first = fulfillOrder(state, request);
    assert.equal(first.ok, true); assert.equal(first.replayed, false);
    assert.equal(Object.hasOwn(first.state.completed, id), true);
    assert.equal(fulfillOrder(first.state, request).replayed, true);
    assert.deepEqual(state, initial());
  }
});
test('orders: duplicate lines have one allocation in the receipt', () => {
  const result = fulfillOrder(initial(), { id: 'duplicate', lines: [{ sku: 'A', quantity: 1 }, { sku: 'A', quantity: 2 }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.receipt.allocations, [{ sku: 'A', quantity: 3 }]);
  assert.equal(result.receipt.pricing.subtotalCents, 597);
});
