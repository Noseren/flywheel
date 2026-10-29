import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";
import { runAgentJob } from "../../src/services/agent/job-runner.ts";
import { PromptAssetStore, promptAsset } from "../../src/services/prompt/index.ts";
import { runStructuredDecision } from "../../src/services/agent/structured-decision.ts";
import { buildUsageLedger } from "../../src/session/usage-ledger.ts";
import { executePersistentAgentJob } from "../../src/services/agent/session.ts";
import { DefaultAgentService } from "../../src/services/agent/service.ts";

test("shared budget serializes concurrent attempts and persists repair across recovery", async () => {
  const state = createExecutionBudgetState({ candidateAttempts: 2 });
  let saves = 0;
  const budget = new ExecutionBudget(state, async () => { saves++; });
  const attempts = await Promise.allSettled([budget.reserveAttempt("a"), budget.reserveAttempt("b"), budget.reserveAttempt("c")]);
  assert.deepEqual(attempts.map((entry) => entry.status), ["fulfilled", "fulfilled", "rejected"]);
  await budget.reserveAttempt("a");
  await budget.claimRepair();
  const restored = new ExecutionBudget(JSON.parse(JSON.stringify(state)), async () => {});
  await assert.rejects(restored.claimRepair(), /repair/);
  await assert.rejects(restored.reserveAttempt("d"), /attempts/);
  assert.equal(saves, 4);
});

test("parallel invocations count elapsed union once, partial usage remains unknown and completion replay deduplicates", async () => {
  let now = 0;
  const state = createExecutionBudgetState({ activeMs: 100, knownTokens: 10 });
  const budget = new ExecutionBudget(state, async () => {}, () => now);
  await budget.startInvocation("a");
  now = 10;
  await budget.startInvocation("b");
  now = 20;
  await budget.finishInvocation("a", { inputTokens: 3, outputTokens: 2 });
  now = 30;
  await budget.finishInvocation("b", { inputTokens: 4 });
  await budget.finishInvocation("b", { inputTokens: 4 });
  assert.equal(state.activeMs, 30);
  assert.equal(state.knownTokens, 9);
  assert.equal(state.unknownUsageInvocations, 1);
  now = 1000;
  assert.equal(budget.remainingActiveMs(), 70);
  await budget.startInvocation("c");
  await budget.finishInvocation("c", { inputTokens: 1, outputTokens: 0 });
  await assert.rejects(budget.startInvocation("d"), /tokens/);
});

test("interrupted invocations survive restart as unknown without counting offline time", async () => {
  let now = 0;
  const state = createExecutionBudgetState();
  const budget = new ExecutionBudget(state, async () => {}, () => now);
  await budget.startInvocation("a");
  now = 40;
  budget.assertAvailable();
  const restoredState = JSON.parse(JSON.stringify(state));
  now = 10000;
  const restored = new ExecutionBudget(restoredState, async () => {}, () => now);
  await restored.recoverInterrupted();
  assert.equal(restoredState.activeMs, 40);
  assert.equal(restoredState.unknownUsageInvocations, 1);
  await restored.recoverInterrupted();
  assert.equal(restoredState.unknownUsageInvocations, 1);
});

test("real adapter retries consume separate invocation budget and exhaustion does not call adapter", async () => {
  const state = createExecutionBudgetState({ knownTokens: 6 });
  const executionBudget = new ExecutionBudget(state, async () => {});
  let calls = 0;
  const adapter = { async run() { calls++; return { success: false, usage: { inputTokens: 2, outputTokens: 1 } }; } };
  const job = { executionBudget, operation: "prepare", label: "budget", cwd: process.cwd(), tools: [],
    readRoots: [process.cwd()], writeRoots: [],
    prompt: promptAsset("common.capability-context", { capability: "init", operation: "prepare", status: "running", job_prompt: "inspect" }) };
  await runAgentJob(adapter, new PromptAssetStore(), job);
  await runAgentJob(adapter, new PromptAssetStore(), job);
  await assert.rejects(runAgentJob(adapter, new PromptAssetStore(), job), /tokens/);
  assert.equal(calls, 2);
  assert.equal(Object.keys(state.invocations).length, 2);
  assert.equal(state.knownTokens, 6);
});

test("process and model time overlap once without inventing process model usage", async () => {
  let now = 0;
  const state = createExecutionBudgetState({ activeMs: 40 });
  const budget = new ExecutionBudget(state, async () => {}, () => now);
  await budget.startProcess("command-a");
  now = 10;
  await budget.startInvocation("model-a");
  now = 20;
  await budget.startProcess("command-b");
  now = 25;
  await budget.finishInvocation("model-a", { inputTokens: 1, outputTokens: 2 });
  now = 30;
  await budget.finishProcess("command-a");
  now = 40;
  await budget.finishProcess("command-b");
  await budget.finishProcess("command-b");
  assert.equal(state.activeMs, 40);
  assert.equal(Object.keys(state.invocations).length, 1);
  assert.equal(state.knownTokens, 3);
  assert.equal(state.unknownUsageInvocations, 0);
  await assert.rejects(budget.startProcess("command-c"), /time/);
});

test("provider budget timeout keeps its exhaustion identity when an adapter throws AbortError", async () => {
  let now = 0;
  const state = createExecutionBudgetState({ activeMs: 1 });
  const executionBudget = new ExecutionBudget(state, async () => {}, () => now);
  const events: Record<string, unknown>[] = [];
  const adapter = { async run(_job: unknown, signal?: AbortSignal): Promise<never> {
    return await new Promise((_resolve, reject) => {
      const fail = () => { clearTimeout(keepAlive); now = 1; reject(new DOMException("provider cancelled", "AbortError")); };
      const keepAlive = setTimeout(() => reject(new Error("budget timer did not abort")), 1000);
      if (signal?.aborted) fail();
      else signal?.addEventListener("abort", fail, { once: true });
    });
  } };
  const job = { executionBudget, operation: "prepare", label: "timeout", cwd: process.cwd(), tools: [],
    readRoots: [process.cwd()], writeRoots: [],
    onEvent: (event: Record<string, unknown>) => { events.push(event); },
    prompt: promptAsset("common.capability-context", { capability: "init", operation: "prepare", status: "running", job_prompt: "inspect" }) };
  await assert.rejects(runAgentJob(adapter, new PromptAssetStore(), job), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "EXECUTION_BUDGET_EXHAUSTED");
  assert.equal(state.activeMs, 1);
  assert.equal(state.unknownUsageInvocations, 1);
  assert.equal(events.filter(event => event.sdkEvent === "invocation.completed").length, 1);
  const ledger = buildUsageLedger([...events, { type: "runtime.budget.exhausted", data: { reason: "time" } }, ...events]);
  assert.equal(ledger.totals.invocationCount, 1);
  assert.equal(ledger.totals.unknownInvocationCount, 1);
});

test("structured decision repair shares the single global repair with other layers", async () => {
  const state = createExecutionBudgetState();
  const executionBudget = new ExecutionBudget(state, async () => {});
  let calls = 0;
  const job = { operation: "decide", label: "decision", cwd: process.cwd(), tools: [],
    readRoots: [process.cwd()], writeRoots: [],
    prompt: promptAsset("common.capability-context", { capability: "init", operation: "prepare", status: "running", job_prompt: "inspect" }) };
  // The missing result forces the existing parser repair path without a model.
  await assert.rejects(runStructuredDecision({ executionBudget, job,
    decisionPath: "C:/flywheel-test-never-created/decision.json", parse: (value) => value,
    agent: { execute: async () => { calls++; return { status: "completed", artifacts: [] }; } },
  }), /repair/);
  assert.equal(calls, 2);
  assert.equal(state.repairUsed, true);
  await assert.rejects(executionBudget.claimRepair(), /repair/);
});

test("persistent Agent job marks exhausted admission without inventing a provider invocation", async () => {
  const state = createExecutionBudgetState({ knownTokens: 1 });
  state.knownTokens = 1;
  const executionBudget = new ExecutionBudget(state, async () => {});
  let adapterCalls = 0;
  const agent = new DefaultAgentService({ async run() { adapterCalls++; return { success: true }; } }, new PromptAssetStore());
  const events: Record<string, unknown>[] = [];
  await assert.rejects(executePersistentAgentJob(agent, {
    operation: "confirm_proposal", label: "init:confirm-proposal", sessionKey: "manager", cwd: process.cwd(),
    tools: [], readRoots: [process.cwd()], writeRoots: [],
    prompt: promptAsset("common.user-intervention", { job_prompt: "confirm", message: "confirm" }),
  }, { capabilityId: "init", operationId: "confirm_proposal", status: "running", sessions: {}, executionBudget,
    checkpoint: async () => {}, emit: async (type, data) => { events.push({ type, scope: "init", data }); },
  }), /tokens/);
  assert.equal(adapterCalls, 0);
  assert.equal(Object.keys(state.invocations).length, 0);
  const completed = events.filter(entry => entry.type === "job.completed");
  assert.equal(completed.length, 1);
  assert.equal((completed[0].data as Record<string, unknown>).invocationStarted, false);
  assert.equal(buildUsageLedger([...events, ...events]).totals.invocationCount, 0);
});
