import assert from "node:assert/strict";
import test from "node:test";

import type { Capability, CapabilityStore } from "../../src/session/protocol.ts";
import { PolicyBlockedError, runCapability } from "../../src/session/runner.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../src/session/policy.ts";
import type { CapabilityCommand, CapabilityExecutionState, CapabilityState } from "../../src/session/protocol.ts";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";

interface State extends CapabilityState {
  execution: CapabilityExecutionState;
  version?: number;
}

class Store implements CapabilityStore<State> {
  state?: State;
  readonly events: string[] = [];
  readonly eventData: Array<{ type: string; data?: Record<string, unknown> }> = [];
  readonly eventStates: Array<{
    type: string;
    version?: number;
    operation?: string;
    status: CapabilityState["status"];
  }> = [];
  async load(): Promise<State> {
    if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.state;
  }
  async save(state: State): Promise<void> { this.state = state; }
  async emit(state: State, type: string, data?: Record<string, unknown>): Promise<void> {
    this.events.push(type);
    this.eventData.push({ type, data });
    this.eventStates.push({
      type,
      version: state.version,
      operation: state.execution.currentOperationId,
      status: state.status,
    });
  }
  subscribe(): () => void { return () => undefined; }
}

function state(policy = { id: "", revision: "" }): State {
  return { status: "running", execution: { policy, policyState: {}, operationState: {} } };
}

function capability(
  store: Store,
  operation: () => Promise<PolicyOutcome<Record<string, unknown>>>,
): Capability<{}, State, CapabilityCommand> {
  const policy: ExecutionPolicy<{}, State, CapabilityCommand, PolicyOutcome<Record<string, unknown>>> = {
    id: "test", revision: "1", operations: { work: operation },
    decide: ({ lastOutcome }) => lastOutcome?.status === "completed"
      ? { type: "complete" } : { type: "run", operationId: "work" },
  };
  return {
    id: "test", grants: [], store, policySource: async () => policy,
    createState: async () => state(), services: () => ({}),
  };
}

test("validated outcome data is preserved as opaque audit evidence", async () => {
  const store = new Store();
  const result = { assessment: "inconclusive", reportPath: ".flywheel/report.md" };
  await runCapability(capability(store, async () => ({ status: "paused", data: result })), { type: "start" }, new AbortController().signal);
  assert.deepEqual(store.eventData.findLast((event) => event.type === "operation.completed")?.data?.result, result);
});

test("blocked outcomes always reach Manager but Manager cannot self-authorize retry", async () => {
  const store = new Store();
  let managerCalls = 0;
  const item = {
    ...capability(store, async () => ({ status: "blocked", error: "invalid evidence" })),
    manager: {
      onFailure: async () => { managerCalls += 1; return { action: "retry" as const, message: "explain only" }; },
      onIntervention: async ({ state }) => state,
    },
  };
  const result = await runCapability(item, { type: "start" }, new AbortController().signal);
  assert.equal(result.status, "blocked");
  assert.equal(managerCalls, 1);
  assert.equal(result.lastError, "explain only");
});

test("Capability may classify a legitimate failure for one Manager-directed retry", async () => {
  const store = new Store();
  let executions = 0;
  const item = {
    ...capability(store, async () => ++executions === 1
      ? { status: "blocked", error: "worker temporarily failed" }
      : { status: "completed" }),
    failureMode: (error: unknown) => error instanceof PolicyBlockedError ? "retryable" as const : "blocked" as const,
    manager: {
      onFailure: async () => ({ action: "retry" as const }),
      onIntervention: async ({ state }) => state,
    },
  };
  const result = await runCapability(item, { type: "start" }, new AbortController().signal);
  assert.equal(result.status, "completed");
  assert.equal(executions, 2);
  assert.ok(store.events.includes("runtime.retrying"));
});

test("waiting interactions are mechanically bound to the active Capability and operation", async () => {
  const store = new Store();
  const item = capability(store, async () => ({ status: "waiting_for_user", interaction: {
    id: "wrong", capabilityId: "other", operationId: "work", requestedBy: { type: "runtime" },
    kind: "text", question: "wrong target",
  } }));
  const result = await runCapability(item, { type: "start" }, new AbortController().signal);
  assert.equal(result.status, "blocked");
  assert.match(result.lastError ?? "", /belongs to other/);
});

test("a dynamically loaded Policy cannot return an invalid Outcome", async () => {
  const store = new Store();
  const item = capability(store, async () => ({ status: "invented" } as unknown as PolicyOutcome<Record<string, unknown>>));
  const result = await runCapability(item, { type: "start" }, new AbortController().signal);
  assert.equal(result.status, "blocked");
  assert.match(result.lastError ?? "", /invalid Outcome status/);
});

test("a candidate Policy cannot grant itself a reload point", async () => {
  const store = new Store();
  store.state = state({ id: "old", revision: "1" });
  store.state.execution.currentOperationId = "work";
  const item = {
    ...capability(store, async () => ({ status: "completed" })),
    policySource: async () => ({
      id: "new", revision: "1", reloadAt: ["work"],
      operations: { work: async () => ({ status: "completed" as const }) },
      decide: () => ({ type: "run" as const, operationId: "work" }),
    }),
  };
  const result = await runCapability(item, { type: "resume" }, new AbortController().signal);
  assert.equal(result.status, "blocked");
  assert.match(result.lastError ?? "", /may not replace/);
});

test("operation completion keeps the identity captured when the operation started", async () => {
  const store = new Store();
  store.state = state({ id: "test", revision: "1" });
  store.state.version = 1;
  const item = capability(store, async () => {
    store.state!.version = 2;
    return { status: "completed" };
  });

  const result = await runCapability(item, { type: "resume" }, new AbortController().signal);
  const started = store.eventStates.find((event) => event.type === "operation.started");
  const completed = store.eventStates.find((event) => event.type === "operation.completed");

  assert.equal(result.version, 2);
  assert.deepEqual(started, { type: "operation.started", version: 1, operation: "work", status: "running" });
  assert.deepEqual(completed, { type: "operation.completed", version: 1, operation: "work", status: "completed" });
});

test("budget exhaustion pauses mechanically without Manager, classification, or reset on resume", async () => {
  const store = new Store();
  const budgetState = createExecutionBudgetState({ knownTokens: 1 });
  budgetState.knownTokens = 1;
  budgetState.repairUsed = true;
  const budget = new ExecutionBudget(budgetState, async () => {});
  let managerCalls = 0;
  let classifications = 0;
  const item = capability(store, async () => { budget.assertAvailable(); return { status: "completed" }; });
  item.failureMode = () => { classifications++; return "retryable"; };
  item.manager = { onFailure: async () => { managerCalls++; return { action: "retry" }; },
    onIntervention: async ({ state }) => state };
  item.prepare = async (state) => { state.status = "running"; return state; };
  for (const type of ["start", "resume"] as const) {
    const result = await runCapability(item, { type }, new AbortController().signal);
    assert.equal(result.status, "paused");
    assert.match(result.lastError!, /tokens/);
    assert.equal(result.execution.currentOperationId, "work");
  }
  assert.equal(managerCalls, 0);
  assert.equal(classifications, 0);
  assert.equal(budgetState.repairUsed, true);
  assert.equal(store.eventData.filter((entry) => entry.type === "runtime.budget.exhausted").length, 2);
  assert.ok(!store.events.includes("runtime.blocked"));
  assert.ok(!store.events.includes("runtime.retrying"));
});
