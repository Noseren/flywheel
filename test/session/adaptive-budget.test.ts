import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionBudgetState, ExecutionBudget, type AssistanceAdmissionRequest } from "../../src/session/execution-budget.ts";

const evaluation = { tokens: 40_000, activeMs: 60_000, source: "frozen-test-config" };
const request = (id = "batch-1", window = "candidate-1"): AssistanceAdmissionRequest => ({
  requestId: id, windowId: window, binding: `hash:${id}`, childCount: 1, requiredReservationId: "evaluation",
});
async function setup(tokens = 500_000) {
  const state = createExecutionBudgetState({ knownTokens: tokens });
  const budget = new ExecutionBudget(state, async () => {});
  await budget.reserveRequiredWork("evaluation", evaluation);
  return { state, budget };
}

test("optional admission atomically protects required evaluation and the original 20 percent envelope", async () => {
  const { state, budget } = await setup();
  const results = await Promise.all([budget.admitAssistance(request()), budget.admitAssistance(request("batch-2", "candidate-2"))]);
  assert.equal(results[0].admitted, true);
  assert.equal(results[1].reason, "optional-token-limit");
  assert.equal(state.reservations!.evaluation.tokensRemaining, 40_000);
  assert.equal(state.reservations![results[0].reservationId!].tokensRemaining, 64_000);
  assert.equal(state.knownTokens, 0);
});

test("K + U + R + E + A includes other in-flight work and denies an otherwise affordable batch", async () => {
  const { budget, state } = await setup();
  await budget.startInvocation("busy", { estimatedTokens: 420_000, estimatedActiveMs: 1 });
  const decision = await budget.admitAssistance(request());
  assert.equal(decision.reason, "tokens");
  assert.equal(state.repairUsed, false);
  assert.equal(state.reservations!.evaluation.tokensRemaining, 40_000);
});

test("duplicate requests replay one reservation and changed bindings cannot reuse authority", async () => {
  const { budget, state } = await setup();
  const first = await budget.admitAssistance(request());
  assert.deepEqual(await budget.admitAssistance(request()), first);
  await assert.rejects(budget.admitAssistance({ ...request(), childCount: 2 }), /binding changed/);
  assert.equal(Object.keys(state.reservations!).length, 2);
  assert.equal((await budget.admitAssistance(request("renamed"))).reason, "window-used");
});

test("denied decisions use the window and resume does not reset task batch count", async () => {
  const { budget, state } = await setup();
  const noReserve = { ...request("denied", "prepare"), requiredReservationId: "missing" };
  assert.equal((await budget.admitAssistance(noReserve)).reason, "required-work-unreserved");
  assert.equal((await budget.admitAssistance(request("different", "prepare"))).reason, "window-used");
  for (let index = 0; index < 2; index++) {
    const admission = await budget.admitAssistance(request(`accepted-${index}`, `candidate-${index}`));
    assert.equal(admission.admitted, true);
    await budget.closeReservation(admission.reservationId!);
  }
  const restored = new ExecutionBudget(JSON.parse(JSON.stringify(state)), async () => {});
  await restored.recoverInterrupted();
  assert.equal((await restored.admitAssistance(request("third", "candidate-3"))).reason, "batch-limit");
});

test("reservation transfers do not double charge concurrent children or parent continuation", async () => {
  const { budget, state } = await setup();
  const admission = await budget.admitAssistance({ ...request(), childCount: 2 });
  const reservationId = admission.reservationId!;
  await Promise.all([budget.startInvocation("child-1", { reservationId }), budget.startInvocation("child-2", { reservationId })]);
  assert.equal(state.reservations![reservationId].tokensRemaining, 32_000);
  await budget.finishInvocation("child-1", { inputTokens: 10_000, outputTokens: 500 });
  await budget.finishInvocation("child-2", { inputTokens: 11_000, outputTokens: 600 });
  await budget.startInvocation("parent-continue", { reservationId });
  await budget.finishInvocation("parent-continue", { inputTokens: 12_000, outputTokens: 700 });
  await budget.closeReservation(reservationId);
  assert.equal(state.knownTokens, 34_800);
  assert.equal(state.reservations!.evaluation.tokensRemaining, 40_000);
  await budget.startInvocation("judge", { reservationId: "evaluation", estimatedTokens: 40_000, estimatedActiveMs: 60_000 });
  assert.equal(state.reservations!.evaluation.tokensRemaining, 0);
});

test("partial and delayed usage preserve unknown occupancy and reconcile each component once", async () => {
  const { budget, state } = await setup();
  await budget.startInvocation("partial", { estimatedTokens: 80_000 });
  await budget.finishInvocation("partial", { inputTokens: 12_000 });
  assert.equal(state.knownTokens, 12_000);
  assert.equal(state.invocations.partial.unknownTokens, 68_000);
  assert.equal(state.unknownUsageInvocations, 1);
  assert.equal((await budget.admitAssistance(request())).reason, "unknown-usage");
  await budget.finishInvocation("partial", { inputTokens: 12_000 });
  assert.equal(state.knownTokens, 12_000);
  await budget.finishInvocation("partial", { outputTokens: 1_234 });
  await budget.finishInvocation("partial", { inputTokens: 12_000, outputTokens: 1_234 });
  assert.equal(state.knownTokens, 13_234);
  assert.equal(state.unknownUsageInvocations, 0);
  assert.equal(state.invocations.partial.tokens, 13_234);
  assert.equal((await budget.admitAssistance(request("later", "candidate-2"))).admitted, true);
});

test("crash recovery retains interrupted placeholders and unused reservations without replaying calls", async () => {
  const { budget, state } = await setup();
  const admission = await budget.admitAssistance(request());
  await budget.startInvocation("interrupted-child", { reservationId: admission.reservationId });
  const restored = new ExecutionBudget(JSON.parse(JSON.stringify(state)), async () => {}, () => Date.now() + 1_000_000);
  await restored.recoverInterrupted();
  await restored.recoverInterrupted();
  assert.equal(restored.state.unknownUsageInvocations, 1);
  assert.equal(restored.state.invocations["interrupted-child"].unknownTokens, 32_000);
  assert.equal(restored.state.reservations![admission.reservationId!].tokensRemaining, 32_000);
  await assert.rejects(restored.startInvocation("interrupted-child", { reservationId: admission.reservationId }), /Duplicate/);
  await assert.rejects(restored.closeReservation(admission.reservationId!), /interrupted/);
  assert.equal((await restored.admitAssistance(request("another", "candidate-2"))).reason, "unknown-usage");
  await restored.finishInvocation("interrupted-child", { inputTokens: 1_000, outputTokens: 200 });
  await restored.closeReservation(admission.reservationId!);
  assert.equal(restored.state.unknownUsageInvocations, 0);
});

test("actual in-flight overage is fully recorded and closes new optional admission", async () => {
  const { budget, state } = await setup();
  const admission = await budget.admitAssistance(request());
  await budget.startInvocation("expensive", { reservationId: admission.reservationId });
  await budget.finishInvocation("expensive", { inputTokens: 120_000, outputTokens: 1_000 });
  await budget.closeReservation(admission.reservationId!);
  assert.equal(state.knownTokens, 121_000);
  assert.equal((await budget.admitAssistance(request("second", "candidate-2"))).reason, "optional-token-limit");
});

test("optional call start rechecks actual plus unknown plus remaining envelope without consuming parent reserve", async () => {
  for (const partial of [false, true]) {
    const { budget, state } = await setup();
    const admitted = await budget.admitAssistance(request());
    const reservationId = admitted.reservationId!;
    await budget.startInvocation("child", { reservationId });
    await budget.finishInvocation("child", partial ? { inputTokens: 80_000 } : { inputTokens: 79_000, outputTokens: 1_000 });
    assert.equal(state.knownTokens, 80_000);
    assert.equal(state.reservations![reservationId].tokensRemaining, 32_000);
    // Total task and actual optional use are below their limits, but the next
    // parent slot would take optional known + U + R to 112000 > 100000.
    await assert.rejects(budget.startInvocation("parent", { reservationId }), /tokens/);
    assert.equal(Object.hasOwn(state.invocations, "parent"), false);
    assert.equal(state.reservations![reservationId].tokensRemaining, 32_000);
    assert.equal(state.reservations!.evaluation.tokensRemaining, 40_000);
    assert.equal(state.unknownUsageInvocations, partial ? 1 : 0);
  }
});

test("frozen admission estimate preserves the parent slot when Child observations increase future estimates", async () => {
  const { budget, state } = await setup();
  const admitted = await budget.admitAssistance({ ...request(), estimateClass: "assistance" });
  const reservationId = admitted.reservationId!;
  await budget.startInvocation("child", { reservationId, estimateClass: "assistance" });
  await budget.finishInvocation("child", { inputTokens: 39_000, outputTokens: 1_000 });
  const newer = budget.estimateInvocation("assistance");
  assert.equal(newer.tokens, 60_000);
  const restored = new ExecutionBudget(JSON.parse(JSON.stringify(state)), async () => {});
  await restored.recoverInterrupted();
  // Delegation may still supply its newly observed estimate. The reservation
  // is the authority and transfers the original 32000-token parent slot.
  await restored.startInvocation("parent", { reservationId, estimatedTokens: newer.tokens, estimatedActiveMs: newer.activeMs, estimateClass: "assistance" });
  assert.equal(restored.state.invocations.parent.estimatedTokens, 32_000);
  assert.equal(restored.state.reservations![reservationId].tokensRemaining, 0);
  assert.equal(restored.state.reservations![reservationId].invocationEstimate!.tokens, 32_000);
});

test("concurrent Child occupancy remains in the optional envelope until its usage is known", async () => {
  const { budget, state } = await setup();
  const admitted = await budget.admitAssistance({ ...request(), childCount: 2 });
  const reservationId = admitted.reservationId!;
  await Promise.all([budget.startInvocation("first", { reservationId }), budget.startInvocation("second", { reservationId })]);
  await budget.finishInvocation("first", { inputTokens: 39_000, outputTokens: 1_000 });
  // K=40000, sibling U=32000, remaining parent R=32000 => 104000.
  await assert.rejects(budget.startInvocation("parent", { reservationId }), /tokens/);
  assert.equal(state.reservations![reservationId].tokensRemaining, 32_000);
  await budget.finishInvocation("second", { inputTokens: 1_000, outputTokens: 1_000 });
  await budget.startInvocation("parent", { reservationId });
  assert.equal(state.invocations.parent.estimatedTokens, 32_000);
});

test("old budgets are not silently granted assistance and unbounded unknown blocks required models", async () => {
  const state = createExecutionBudgetState();
  delete state.assistance;
  delete state.reservations;
  const budget = new ExecutionBudget(state, async () => {});
  assert.equal((await budget.admitAssistance(request())).reason, "legacy-budget");
  assert.equal(state.assistance, undefined);
  await budget.startInvocation("old-unknown");
  await budget.finishInvocation("old-unknown", null);
  await assert.rejects(budget.reserveRequiredWork("evaluation", evaluation), /tokens/);
});

test("time reserve protects necessary work and checkpoints fail closed", async () => {
  const state = createExecutionBudgetState({ activeMs: 100_000 });
  const budget = new ExecutionBudget(state, async () => {});
  await budget.reserveRequiredWork("evaluation", evaluation);
  assert.equal((await budget.admitAssistance(request())).reason, "time");
  const failing = new ExecutionBudget(createExecutionBudgetState(), async () => { throw new Error("disk full"); });
  await assert.rejects(failing.reserveAttempt("a"), /disk full/);
  await assert.rejects(failing.startInvocation("never-started"), /checkpoint failed/);
});

test("optional invocation timeout preserves required evaluation time and the batch active-time limit", async () => {
  let now = 0;
  const budget = new ExecutionBudget(createExecutionBudgetState({ activeMs: 240_000 }), async () => {}, () => now);
  await budget.reserveRequiredWork("evaluation", { ...evaluation, activeMs: 100_000 });
  const admitted = await budget.admitAssistance(request());
  await budget.startInvocation("child", { reservationId: admitted.reservationId });
  assert.equal(admitted.estimate!.activeMs, 60_000, "prediction stays separate from authorization");
  assert.equal(admitted.authorizedActiveMs, 120_000);
  assert.equal(budget.remainingInvocationActiveMs("child"), 120_000);
  now = 70_000;
  await budget.finishInvocation("child", { inputTokens: 1_000, outputTokens: 200 });
  await budget.startInvocation("parent", { reservationId: admitted.reservationId });
  assert.equal(budget.remainingInvocationActiveMs("parent"), 50_000);
  assert.equal(budget.state.invocations.parent.estimatedActiveMs, 30_000);
  now = 120_000;
  await budget.finishInvocation("parent", { inputTokens: 1_000, outputTokens: 200 });
  assert.equal(budget.remainingActiveMs(), 120_000);
  assert.equal(budget.remainingActiveMs(admitted.reservationId), 0);
  await assert.rejects(budget.startInvocation("late", { reservationId: admitted.reservationId }), /time/);
});

test("admission reserves the full batch ceiling and rejects predictions that cannot fit it", async () => {
  const budget = new ExecutionBudget(createExecutionBudgetState({ activeMs: 179_999, knownTokens: 2_000_000 }), async () => {});
  await budget.reserveRequiredWork("evaluation", evaluation);
  assert.equal((await budget.admitAssistance(request())).reason, "time", "60s prediction fits but 120s authority plus required work does not");
  const { budget: observed, state } = await setup(2_000_000);
  state.invocations.expensive = { startedAt: 0, endedAt: 50_000, tokens: 1000, estimateClass: "model" };
  const denied = await observed.admitAssistance(request());
  assert.equal(denied.estimate!.activeMs, 150_000);
  assert.equal(denied.reason, "time", "an over-ceiling prediction is never clamped to fit");
});

test("old 60 second authorization replays without acquiring a new batch ceiling", async () => {
  let now = 0;
  const state = createExecutionBudgetState();
  const budget = new ExecutionBudget(state, async () => {}, () => now);
  await budget.reserveRequiredWork("evaluation", evaluation);
  const admitted = await budget.admitAssistance(request());
  delete state.assistance!.decisions[admitted.requestId]!.authorizedActiveMs;
  const reservation = state.reservations![admitted.reservationId!]!;
  delete reservation.authorizedActiveMs;
  reservation.activeMsRemaining = reservation.estimate.activeMs;
  const restored = new ExecutionBudget(JSON.parse(JSON.stringify(state)), async () => {}, () => now);
  assert.equal((await restored.admitAssistance(request())).authorizedActiveMs, undefined);
  await restored.startInvocation("old-child", { reservationId: admitted.reservationId });
  assert.equal(restored.remainingInvocationActiveMs("old-child"), 60_000);
  now = 60_000;
  await restored.finishInvocation("old-child", { inputTokens: 1000, outputTokens: 100 });
  await assert.rejects(restored.startInvocation("old-parent", { reservationId: admitted.reservationId }), /time/);
});
