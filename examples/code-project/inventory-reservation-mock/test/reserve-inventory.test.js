import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveInventory } from '../src/reserve-inventory.js';

test('reserves one available SKU without mutating inputs', () => {
  const stock = { mug: 5 };
  const requests = [{ sku: 'mug', quantity: 2 }];

  assert.deepEqual(reserveInventory(stock, requests), {
    ok: true,
    stock: { mug: 3 },
    allocations: [{ sku: 'mug', quantity: 2 }],
  });
  assert.deepEqual(stock, { mug: 5 });
  assert.deepEqual(requests, [{ sku: 'mug', quantity: 2 }]);
});

test('merges duplicate SKUs in first-seen order', () => {
  const result = reserveInventory(
    { mug: 5, plate: 4 },
    [
      { sku: 'mug', quantity: 1 },
      { sku: 'plate', quantity: 2 },
      { sku: 'mug', quantity: 3 },
    ],
  );

  assert.deepEqual(result, {
    ok: true,
    stock: { mug: 1, plate: 2 },
    allocations: [
      { sku: 'mug', quantity: 4 },
      { sku: 'plate', quantity: 2 },
    ],
  });
});

test('uses the aggregated quantity when checking stock', () => {
  const stock = { mug: 3 };
  const result = reserveInventory(stock, [
    { sku: 'mug', quantity: 2 },
    { sku: 'mug', quantity: 2 },
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /mug/i);
  assert.deepEqual(stock, { mug: 3 });
});

test('collects independent errors in deterministic SKU order', () => {
  const result = reserveInventory(
    { mug: 1, plate: 2 },
    [
      { sku: 'mug', quantity: 3 },
      { sku: 'unknown', quantity: 1 },
      { sku: 'plate', quantity: 4 },
    ],
  );

  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /mug/i);
  assert.match(result.errors[1], /unknown/i);
  assert.match(result.errors[2], /plate/i);
  assert.equal('stock' in result, false);
  assert.equal('allocations' in result, false);
});

test('reports invalid request fields and continues validation', () => {
  const result = reserveInventory(
    { mug: 2 },
    [
      { sku: '', quantity: 1 },
      { sku: 'mug', quantity: 0 },
      { sku: 'ghost', quantity: -2 },
    ],
  );

  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
  assert.match(result.errors.join('\n'), /mug/i);
  assert.match(result.errors.join('\n'), /ghost/i);
});

test('accepts an empty batch and returns a fresh stock object', () => {
  const stock = { mug: 2 };
  const result = reserveInventory(stock, []);

  assert.deepEqual(result, { ok: true, stock: { mug: 2 }, allocations: [] });
  assert.notEqual(result.stock, stock);
});
