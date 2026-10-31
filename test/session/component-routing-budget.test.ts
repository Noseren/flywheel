import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { ExecutionBudget, createExecutionBudgetState } from "../../src/session/execution-budget.ts";
import { openExecutionBudget } from "../../src/session/execution-budget-store.ts";
const req = { revision: "2026-10-29.compact.v3" as const, requestId: "search", windowId: "R3", binding: "public-hash", slots: 4, requiredReservationIds: ["verify", "target"] };
async function setup(tokens = 2_000_000, time = 1_800_000) {
  let now = 0;
  const budget = new ExecutionBudget(createExecutionBudgetState({ knownTokens: tokens, activeMs: time }), async () => {}, () => now);
  await budget.reserveRequiredWork("verify", { tokens: 32_000, activeMs: 120_000, source: "required" });
  await budget.reserveRequiredWork("target", { tokens: 32_000, activeMs: 30_000, source: "required" });
  return { budget, advance: (ms: number) => { now += ms; } };
}
test("trusted auxiliary chain uses shared optional tokens, one activation and per-call time", async () => {
  const { budget, advance } = await setup();
  const admitted = await budget.admitRoutingChain(req);
  assert.equal(admitted.admitted, true);
  assert.deepEqual(await budget.admitRoutingChain(req), admitted);
  const reservationId = admitted.reservationId!;
  assert.equal(budget.state.reservations![reservationId].activeMsRemaining, 480_000);
  for (let i = 0; i < 4; i++) {
    await budget.startInvocation(`slot-${i}`, { reservationId, estimateClass: "assistance" });
    assert.equal(budget.remainingInvocationActiveMs(`slot-${i}`), 120_000);
    advance(90_000);
    assert.equal(budget.remainingInvocationActiveMs(`slot-${i}`), 30_000);
    await budget.finishInvocation(`slot-${i}`, { inputTokens: 1000, outputTokens: 100 });
  }
  await assert.rejects(budget.startInvocation("fifth", { reservationId }), /attempts/);
  await budget.closeReservation(reservationId);
  assert.equal(budget.state.knownTokens, 4400);
  assert.equal(budget.state.reservations!.verify.tokensRemaining, 32_000);
  assert.equal(Object.values(budget.state.assistance!.decisions).filter(d => d.admitted).length, 1);
});
test("chain and work/check share 20 percent and two activations without expanding v2", async () => {
  const { budget } = await setup(500_000);
  assert.equal((await budget.admitRoutingChain(req)).reason, "optional-token-limit");
  const first = await budget.admitAssistance({ requestId: "check", windowId: "R2", binding: "check", childCount: 1, requiredReservationId: "verify" });
  assert.equal(first.admitted, true);
  assert.equal(first.authorizedActiveMs, 120_000);
  await budget.closeReservation(first.reservationId!);
  const second = await budget.admitRoutingChain({ ...req, requestId: "second", windowId: "R4", slots: 2 });
  assert.equal(second.admitted, true);
  await budget.closeReservation(second.reservationId!);
  assert.equal((await budget.admitRoutingChain({ ...req, requestId: "third", windowId: "R5", slots: 1 })).reason, "batch-limit");
});
test("chain requires full future capacity and rejects changed bindings or too-slow predictions", async () => {
  const { budget } = await setup(2_000_000, 600_000);
  assert.equal((await budget.admitRoutingChain(req)).reason, "time");
  const { budget: next } = await setup();
  await next.admitRoutingChain(req);
  await assert.rejects(next.admitRoutingChain({ ...req, slots: 2 }), /binding changed/);
  const { budget: slow } = await setup();
  slow.state.invocations.old = { startedAt: 0, endedAt: 90_000, tokens: 1000, estimateClass: "assistance" };
  assert.equal((await slow.admitRoutingChain(req)).reason, "time");
});
test("chain recovery validates persisted slot authority and preserves unknown occupancy", async () => {
  const { budget } = await setup(); const admitted = await budget.admitRoutingChain(req);
  await budget.startInvocation("pending", { reservationId: admitted.reservationId });
  const root = await mkdtemp(path.join(os.tmpdir(), "routing-budget-")); await mkdir(path.join(root, ".flywheel/runtime"), { recursive: true });
  await writeFile(path.join(root, ".flywheel/runtime/execution-budget.json"), JSON.stringify(budget.state));
  const recovered = await openExecutionBudget(root);
  assert.equal(recovered.state.reservations![admitted.reservationId!].componentChain!.slotsRemaining, 3);
  assert.equal(recovered.state.unknownUsageInvocations, 1);
  await assert.rejects(recovered.closeReservation(admitted.reservationId!), /interrupted/);
  assert.equal((await recovered.admitRoutingChain({ ...req, requestId: "new", windowId: "R4" })).reason, "unknown-usage");
});
