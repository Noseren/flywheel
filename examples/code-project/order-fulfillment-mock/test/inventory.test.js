import test from 'node:test';
import assert from 'node:assert/strict';
import { planReservation } from '../src/inventory.js';

test('inventory: successful reservation leaves both inputs unchanged', () => {
  const stock = { A: 8, B: 3 }, lines = [{ sku: 'A', quantity: 2 }];
  const before = structuredClone({ stock, lines });
  const result = planReservation(stock, lines);
  assert.deepEqual(result, { ok: true, stock: { A: 6, B: 3 }, allocations: lines });
  assert.deepEqual({ stock, lines }, before);
  assert.notEqual(result.stock, stock);
});
test('inventory: duplicates aggregate in first appearance order', () => {
  assert.deepEqual(planReservation({ A: 9, B: 9 }, [
    { sku: 'B', quantity: 2 }, { sku: 'A', quantity: 1 }, { sku: 'B', quantity: 3 },
  ]), { ok: true, stock: { A: 8, B: 4 }, allocations: [{ sku: 'B', quantity: 5 }, { sku: 'A', quantity: 1 }] });
});
test('inventory: combined shortage cannot partially mutate stock', () => {
  const stock = { A: 5 };
  assert.deepEqual(planReservation(stock, [{ sku: 'A', quantity: 3 }, { sku: 'A', quantity: 3 }]),
    { ok: false, errors: [{ code: 'insufficient_stock', sku: 'A' }] });
  assert.deepEqual(stock, { A: 5 });
});
test('inventory: collect format errors before all stock errors', () => {
  assert.deepEqual(planReservation({ A: 2, B: 0 }, [
    { sku: '', quantity: 1 }, { sku: 'A', quantity: -1 }, { sku: 'missing', quantity: 2 },
    { sku: 'A', quantity: 3 }, { sku: 'B', quantity: 1 },
  ]), { ok: false, errors: [
    { code: 'invalid_sku', index: 0 }, { code: 'invalid_quantity', index: 1 },
    { code: 'unknown_sku', sku: 'missing' }, { code: 'insufficient_stock', sku: 'A' }, { code: 'insufficient_stock', sku: 'B' },
  ] });
});
test('inventory: fractional and nonnumeric quantities are invalid', () => {
  assert.deepEqual(planReservation({ A: 9 }, [{ sku: 'A', quantity: 0.5 }, { sku: 'A', quantity: '2' }]),
    { ok: false, errors: [{ code: 'invalid_quantity', index: 0 }, { code: 'invalid_quantity', index: 1 }] });
});
test('inventory: inherited properties are not SKUs', () => {
  assert.deepEqual(planReservation({}, [{ sku: 'toString', quantity: 1 }]),
    { ok: false, errors: [{ code: 'unknown_sku', sku: 'toString' }] });
});
test('inventory: own prototype-like SKU is a normal key', () => {
  const stock = JSON.parse('{"__proto__":4}');
  const result = planReservation(stock, [{ sku: '__proto__', quantity: 2 }]);
  assert.equal(result.ok, true); assert.equal(Object.hasOwn(result.stock, '__proto__'), true);
  assert.equal(result.stock.__proto__, 2); assert.equal(stock.__proto__, 4);
});
test('inventory: empty request succeeds with a new stock', () => {
  const stock = { A: 3 }, result = planReservation(stock, []);
  assert.deepEqual(result, { ok: true, stock: { A: 3 }, allocations: [] });
  assert.notEqual(result.stock, stock);
});
test('inventory: unsafe quantity and merged overflow are rejected', () => {
  assert.deepEqual(planReservation({ A: Number.MAX_SAFE_INTEGER }, [{ sku: 'A', quantity: Number.MAX_SAFE_INTEGER + 1 }]),
    { ok: false, errors: [{ code: 'invalid_quantity', index: 0 }] });
  assert.deepEqual(planReservation({ A: Number.MAX_SAFE_INTEGER }, [{ sku: 'A', quantity: Number.MAX_SAFE_INTEGER }, { sku: 'A', quantity: 1 }]),
    { ok: false, errors: [{ code: 'invalid_quantity', index: 1 }] });
});
