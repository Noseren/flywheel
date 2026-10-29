import { planReservation } from './inventory.js';
import { quoteOrder } from './pricing.js';

export function fulfillOrder(state, order) {
  if (state.completed[order.id]) return { ok: true, state, receipt: state.completed[order.id], replayed: true };
  const reservation = planReservation(state.stock, order.lines);
  if (!reservation.ok) return { ...reservation, state };
  const pricing = quoteOrder(state.catalog, reservation.allocations, order.options);
  const receipt = { id: order.id, allocations: reservation.allocations, pricing };
  state.completed[order.id] = receipt;
  return { ok: true, state, receipt, replayed: false };
}
