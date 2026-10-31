import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutionBudgetState, ExecutionBudget, UNBOUNDED_EXECUTION_BUDGET_LIMITS as unlimited } from "../../src/session/execution-budget.ts";
import { openExecutionBudget } from "../../src/session/execution-budget-store.ts";
import { runAgentJob } from "../../src/services/agent/job-runner.ts";
import { PromptAssetStore, promptAsset } from "../../src/services/prompt/index.ts";

async function persisted(state: ReturnType<typeof createExecutionBudgetState>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "unbounded-budget-"));
  await mkdir(path.join(root, ".flywheel/runtime"), { recursive: true });
  await writeFile(path.join(root, ".flywheel/runtime/execution-budget.json"), JSON.stringify(state));
  return root;
}

test("unbounded limits require explicit mode and three null fields, never implicit Infinity", () => {
  assert.deepEqual(createExecutionBudgetState(unlimited).limits, unlimited);
  for (const limits of [{ mode: "unbounded" as const }, { knownTokens: null }, { ...unlimited, activeMs: 120 }, { knownTokens: Infinity }]) assert.throws(() => createExecutionBudgetState(limits), /Invalid execution budget/);
});

test("unbounded counts actual costs beyond old ceilings without lifting per-batch or repair boundaries", async () => {
  let now = 0; const budget = new ExecutionBudget(createExecutionBudgetState(unlimited), async () => {}, () => now);
  for (let i = 0; i < 6; i++) await budget.reserveAttempt(`attempt-${i}`);
  await budget.startInvocation("large"); now += 2_000_000;
  await budget.finishInvocation("large", { inputTokens: 3_000_000, outputTokens: 100 });
  budget.assertAvailable(); assert.equal(budget.remainingActiveMs(), Infinity);
  assert.equal(budget.state.knownTokens, 3_000_100); assert.equal(budget.state.activeMs, 2_000_000);
  await budget.reserveRequiredWork("verify", { tokens: 100, activeMs: 100, source: "fixed" });
  for (let i = 0; i < 4; i++) {
    const admitted = await budget.admitAssistance({ requestId: `req-${i}`, windowId: `window-${i}`, binding: "same", childCount: 1, requiredReservationId: "verify" });
    assert.equal(admitted.admitted, true); assert.equal(admitted.authorizedActiveMs, 120_000);
    assert.equal(budget.remainingActiveMs(admitted.reservationId), 120_000);
    await budget.closeReservation(admitted.reservationId!);
  }
  assert.equal((await budget.admitAssistance({ requestId: "duplicate-window", windowId: "window-0", binding: "same", childCount: 1, requiredReservationId: "verify" })).reason, "window-used");
  await budget.claimRepair(); await assert.rejects(budget.claimRepair(), /repair/);
  const recovered = await openExecutionBudget(await persisted(budget.state));
  assert.equal(recovered.limit("knownTokens"), Infinity); assert.equal(recovered.state.knownTokens, 3_000_100);
  assert.equal(Object.values(recovered.state.assistance!.decisions).filter(d => d.admitted).length, 4);
});

test("unknown usage still blocks unlimited calls and recovers without replay or free occupancy", async () => {
  const budget = new ExecutionBudget(createExecutionBudgetState(unlimited), async () => {});
  await budget.startInvocation("lost", { estimatedTokens: 32000, estimatedActiveMs: 30000 });
  await budget.finishInvocation("lost", null);
  await assert.rejects(budget.startInvocation("next"), /Unknown invocation/);
  const recovered = await openExecutionBudget(await persisted(budget.state));
  assert.equal(recovered.state.unknownUsageInvocations, 1);
  await assert.rejects(recovered.reserveAttempt("next"), /Unknown invocation/);
  assert.equal(Object.keys(recovered.state.invocations).length, 1);
});

test("opening existing budgets with unbounded defaults never expands old authorization", async () => {
  const root = await persisted(createExecutionBudgetState({ candidateAttempts: 1 }));
  const budget = await openExecutionBudget(root, unlimited);
  assert.equal(budget.limit("candidateAttempts"), 1);
  await budget.reserveAttempt("one"); await assert.rejects(budget.reserveAttempt("two"), /attempts/);
});

test("audited explicit expansion preserves counters and slots, is idempotent and rejects changed authority", async () => {
  const state = createExecutionBudgetState({ candidateAttempts: 1 }); const budget = new ExecutionBudget(state, async () => {});
  await budget.reserveAttempt("one"); await budget.claimRepair();
  await budget.reserveRequiredWork("frozen-eval", { tokens: 100, activeMs: 100, source: "frozen" });
  await budget.startInvocation("paid"); await budget.finishInvocation("paid", { inputTokens: 600000, outputTokens: 1 });
  const expectedLimits = { ...state.limits }, before = JSON.parse(JSON.stringify(state));
  const request = { authorizationId: "user-request-1", reason: "User explicitly requested removal of total execution limits", expectedLimits };
  await budget.authorizeUnbounded(request); await budget.authorizeUnbounded(request);
  assert.equal(state.limitChanges!.length, 1); assert.equal(state.knownTokens, 600001);
  assert.deepEqual(state.attempts, before.attempts); assert.deepEqual(state.reservations, before.reservations); assert.equal(state.repairUsed, true);
  await assert.rejects(budget.authorizeUnbounded({ ...request, reason: "changed" }), /binding changed/);
  await assert.rejects(budget.authorizeUnbounded({ ...request, authorizationId: "another" }), /limits changed/);
  await budget.reserveAttempt("two"); await assert.rejects(budget.claimRepair(), /repair/);
  const restored = await openExecutionBudget(await persisted(state)); assert.equal(restored.state.limitChanges!.length, 1);
});

test("expansion refuses unknown activity and malformed persisted null limits", async () => {
  const state = createExecutionBudgetState(); const budget = new ExecutionBudget(state, async () => {});
  await budget.startInvocation("lost"); await budget.finishInvocation("lost", null);
  await assert.rejects(budget.authorizeUnbounded({ authorizationId: "auth", reason: "user", expectedLimits: state.limits }), /unknown activity/);
  const damaged = createExecutionBudgetState(); damaged.limits.knownTokens = null;
  await assert.rejects(openExecutionBudget(await persisted(damaged)), /invalid/);
});

test("job runner omits infinite global timer but preserves finite optional job timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "unbounded-job-"));
  const budget = new ExecutionBudget(createExecutionBudgetState(unlimited), async () => {});
  let hasSignal = false;
  const adapter = { async run(_job: unknown, signal?: AbortSignal) { hasSignal = !!signal; return { success: true, usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const job = { operation: "test", label: "test", cwd: root, tools: ["Read"], readRoots: [root], writeRoots: [], executionBudget: budget,
    prompt: promptAsset("common.decision-repair", { decision_path: root, issues: "test", base_prompt: "test" }) };
  await runAgentJob(adapter, new PromptAssetStore(), job); assert.equal(hasSignal, false);
  await budget.reserveRequiredWork("verify", { tokens: 1, activeMs: 1, source: "test" });
  const admission = await budget.admitAssistance({ requestId: "check", windowId: "window", binding: "x", childCount: 1, requiredReservationId: "verify" });
  await runAgentJob(adapter, new PromptAssetStore(), { ...job, invocationReservation: { reservationId: admission.reservationId, estimateClass: "assistance" } });
  assert.equal(hasSignal, true);
});

test("unbounded optional authorization still expires at 120 seconds and rejects oversized predictions", async () => {
  let now = 0; const budget = new ExecutionBudget(createExecutionBudgetState(unlimited), async () => {}, () => now);
  await budget.reserveRequiredWork("verify", { tokens: 1, activeMs: 1, source: "test" });
  const request = { requestId: "check", windowId: "window", binding: "x", childCount: 1, requiredReservationId: "verify", estimateClass: "assistance" };
  const admission = await budget.admitAssistance(request);
  await budget.startInvocation("child", { reservationId: admission.reservationId, estimateClass: "assistance" });
  now = 120_000; assert.equal(budget.remainingInvocationActiveMs("child"), 0);
  await budget.finishInvocation("child", { inputTokens: 2000000, outputTokens: 1 });
  await assert.rejects(budget.startInvocation("parent", { reservationId: admission.reservationId }), /time/);
  await budget.closeReservation(admission.reservationId!);
  const slow = await budget.admitAssistance({ ...request, requestId: "slow", windowId: "next" });
  assert.equal(slow.admitted, false); assert.equal(slow.reason, "time");
  budget.assertAvailable(); assert.equal(budget.remainingActiveMs(), Infinity);
});
