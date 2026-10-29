import type { Capability, CapabilityRequest } from "./protocol.ts";
import {
  assertPolicyServiceGrants,
  decideExecutionPolicy,
  executePolicyOperation,
  loadExecutionPolicy,
  type ExecutionPolicy,
  type PolicyOutcome,
} from "./policy.ts";
import type { CapabilityCommand, CapabilityExecutionState, CapabilityState } from "./protocol.ts";

type ExecutableState = CapabilityState & { execution: CapabilityExecutionState };

function missingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function interrupted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof DOMException && error.name === "AbortError");
}

async function policyFor<Services, State extends ExecutableState, Command extends CapabilityCommand>(
  capability: Capability<Services, State, Command>,
  state: State,
  created: boolean,
): Promise<ExecutionPolicy<Services, State, Command, PolicyOutcome<Record<string, unknown>>>> {
  const policy = await loadExecutionPolicy(capability.policySource);
  assertPolicyServiceGrants(policy, capability.grants);
  const active = state.execution.policy;
  if (created || !active?.id || !active.revision) {
    state.execution.policy = { id: policy.id, revision: policy.revision };
  } else if (active.id !== policy.id || active.revision !== policy.revision) {
    const operationId = state.execution.currentOperationId;
    if (!operationId || !(capability.policyReloadAt ?? []).includes(operationId)) {
      throw new Error(
        `Policy ${policy.id}@${policy.revision} may not replace ${active.id}@${active.revision} at ${operationId ?? "entry"}`,
      );
    }
    if (active.id !== policy.id) state.execution.policyState = {};
    state.execution.policy = { id: policy.id, revision: policy.revision };
    await capability.store.emit(state, "runtime.policy.loaded", {
      policyId: policy.id,
      policyRevision: policy.revision,
      operationId,
    });
  }
  return policy;
}

/** A valid Policy result which still blocks progress; Capability alone may classify it as retryable. */
export class PolicyBlockedError extends Error {
  readonly operationId: string;

  constructor(operationId: string, message: string) {
    super(message);
    this.name = "PolicyBlockedError";
    this.operationId = operationId;
  }
}

function assertInteractionBinding(
  capabilityId: string,
  operationId: string,
  outcome: PolicyOutcome<Record<string, unknown>>,
): void {
  if (outcome.status !== "waiting_for_user") return;
  if (outcome.interaction.capabilityId !== capabilityId) {
    throw new Error(
      `Interaction ${outcome.interaction.id} belongs to ${outcome.interaction.capabilityId}, expected ${capabilityId}`,
    );
  }
  if (outcome.interaction.operationId !== operationId) {
    throw new Error(
      `Interaction ${outcome.interaction.id} belongs to operation ${outcome.interaction.operationId}, expected ${operationId}`,
    );
  }
}

/** TypeScript types do not protect Runtime from a dynamically loaded Policy module. */
function assertPolicyOutcome(
  operationId: string,
  value: unknown,
): asserts value is PolicyOutcome<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Policy operation ${operationId} returned a non-object Outcome`);
  }
  const outcome = value as Record<string, unknown>;
  if (!["completed", "waiting_for_user", "paused", "blocked"].includes(String(outcome.status))) {
    throw new Error(`Policy operation ${operationId} returned invalid Outcome status: ${String(outcome.status)}`);
  }
  if (outcome.data !== undefined && (!outcome.data || typeof outcome.data !== "object" || Array.isArray(outcome.data))) {
    throw new Error(`Policy operation ${operationId} returned invalid Outcome data`);
  }
  if (outcome.state !== undefined && (!outcome.state || typeof outcome.state !== "object" || Array.isArray(outcome.state))) {
    throw new Error(`Policy operation ${operationId} returned invalid operation state`);
  }
  if (outcome.status === "waiting_for_user"
    && (!outcome.interaction || typeof outcome.interaction !== "object" || Array.isArray(outcome.interaction))) {
    throw new Error(`Policy operation ${operationId} returned no interaction`);
  }
  if (outcome.status === "blocked" && (typeof outcome.error !== "string" || !outcome.error.trim())) {
    throw new Error(`Policy operation ${operationId} returned no blocking error`);
  }
  if (outcome.status === "paused" && outcome.reason !== undefined && typeof outcome.reason !== "string") {
    throw new Error(`Policy operation ${operationId} returned invalid pause reason`);
  }
}

function applyDecision<State extends ExecutableState, Services, Command extends CapabilityCommand>(
  state: State,
  policy: ExecutionPolicy<Services, State, Command, PolicyOutcome<Record<string, unknown>>>,
): void {
  const previous = state.execution.currentOperationId;
  const decision = decideExecutionPolicy(policy, {
    state,
    currentOperationId: previous,
    lastOutcome: state.execution.lastOutcome,
    policyState: state.execution.policyState,
  });
  if (decision.policyState) state.execution.policyState = decision.policyState;
  if (decision.type === "run") {
    state.execution.currentOperationId = decision.operationId;
    if (decision.operationId !== previous) state.execution.operationState = {};
    state.status = "running";
    return;
  }
  delete state.execution.currentOperationId;
  if (decision.type === "complete") state.status = "completed";
  else {
    state.status = "blocked";
    state.lastError = decision.error;
  }
}

function applyOutcome<State extends ExecutableState, Services, Command extends CapabilityCommand>(
  state: State,
  policy: ExecutionPolicy<Services, State, Command, PolicyOutcome<Record<string, unknown>>>,
  operationId: string,
  outcome: PolicyOutcome<Record<string, unknown>>,
): void {
  state.execution.lastOutcome = {
    operationId: operationId,
    status: outcome.status,
    ...(outcome.data ? { data: outcome.data } : {}),
  };
  if (outcome.state) state.execution.operationState = outcome.state;
  delete state.pendingInteraction;
  if (outcome.status === "completed") {
    applyDecision(state, policy);
  } else if (outcome.status === "waiting_for_user") {
    state.status = "waiting_for_user";
    state.pendingInteraction = outcome.interaction;
  } else if (outcome.status === "paused") {
    state.status = "paused";
    if (outcome.reason) state.lastError = outcome.reason;
  } else {
    state.status = "blocked";
    state.lastError = outcome.error;
  }
}

async function routeFailure<State extends ExecutableState>(
  capability: Capability<unknown, State>,
  state: State,
  error: unknown,
  signal: AbortSignal,
): Promise<State> {
  const failureMode = capability.failureMode?.(error, state) ?? "blocked";
  state.status = "blocked";
  state.lastError = errorMessage(error);
  await capability.store.save(state);
  await capability.store.emit(state, "runtime.blocked", { error: state.lastError });
  if (capability.manager) {
    try {
      const response = await capability.manager.onFailure({ state, error, signal });
      if (response?.message) state.lastError = response.message;
      if (response?.action === "retry" && failureMode === "retryable") {
        state.status = "running";
        delete state.lastError;
        await capability.store.emit(state, "runtime.retrying", {});
        await capability.store.save(state);
        return state;
      }
    } catch (managerError) {
      state.lastError = `${state.lastError}; Manager failed: ${errorMessage(managerError)}`;
    }
  }
  // Manager is advisory and cannot turn an invariant failure into success.
  state.status = "blocked";
  await capability.store.save(state);
  return state;
}

/** Session's only Policy interpreter and continuous Capability loop. */
export async function runCapability<
  Services,
  State extends ExecutableState,
  Command extends CapabilityCommand = CapabilityCommand,
>(
  capability: Capability<Services, State, Command>,
  request: CapabilityRequest,
  signal: AbortSignal,
): Promise<State> {
  let created = false;
  let state: State;
  try {
    state = await capability.store.load();
  } catch (error) {
    if (request.type !== "start" || !missingFile(error)) throw error;
    state = await capability.createState(signal);
    created = true;
  }

  let command = request.type === "command" ? request.command as Command : undefined;
  let prepared = false;
  while (true) {
    try {
      if (!prepared && request.type === "intervene") {
        if (!capability.manager) throw new Error(`Capability ${capability.id} has no Manager for intervention`);
        state = await capability.manager.onIntervention({ state, message: request.message, signal });
      } else if (!prepared && capability.prepare) {
        state = await capability.prepare(state, request, signal);
      }
      prepared = true;
      let policy = await policyFor(capability, state, created);
      created = false;
      if (state.status === "running" && !state.execution.currentOperationId) applyDecision(state, policy);
      await capability.store.save(state);
      while (true) {
        if (state.status === "blocked") {
          const routed = await routeFailure(
            capability as Capability<unknown, State>,
            state,
            new PolicyBlockedError(
              state.execution.currentOperationId ?? "policy",
              state.lastError ?? "Policy blocked execution",
            ),
            signal,
          );
          if (routed.status !== "running") return routed;
        }
        if (state.status !== "running") return state;
        if (signal.aborted) throw new DOMException("Capability execution was interrupted", "AbortError");
        policy = await policyFor(capability, state, false);
        if (!state.execution.currentOperationId) applyDecision(state, policy);
        if (state.status !== "running") continue;
        const operationId = state.execution.currentOperationId;
        if (!operationId) throw new Error("Policy did not select an operation");
        await capability.conversation?.apply(state);
        await capability.beforeOperation?.(state, operationId, signal);
        await capability.store.emit(state, "operation.started", {
          operationId: operationId,
          policyId: policy.id,
          policyRevision: policy.revision,
        });
        // An operation may promote a version or otherwise replace its active identity.
        // Keep lifecycle events attached to the identity under which the operation began.
        const operationEventState = structuredClone(state);
        const outcome = await executePolicyOperation(policy, operationId, {
          services: capability.services(state, signal),
          state,
          signal,
          ...(command ? { command } : {}),
        });
        command = undefined;
        assertPolicyOutcome(operationId, outcome);
        assertInteractionBinding(capability.id, operationId, outcome);
        await capability.afterOperation?.(state, operationId, outcome, signal);
        applyOutcome(state, policy, operationId, outcome);
        operationEventState.status = state.status;
        const completion = {
          operationId: operationId,
          status: outcome.status,
          nextOperationId: state.execution.currentOperationId,
          ...(outcome.data ? { result: structuredClone(outcome.data) } : {}),
        };
        if (capability.store.commit) {
          await capability.store.commit(state, "operation.completed", completion, operationEventState);
        } else {
          await capability.store.emit(operationEventState, "operation.completed", completion);
          await capability.store.save(state);
        }
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EXECUTION_BUDGET_EXHAUSTED") {
        state.status = "paused";
        state.lastError = errorMessage(error);
        delete state.pendingInteraction;
        await capability.store.save(state);
        await capability.store.emit(state, "runtime.budget.exhausted", {
          error: state.lastError,
          ...( "reason" in error ? { reason: error.reason } : {}),
          operationId: state.execution.currentOperationId,
        });
        return state;
      }
      if (interrupted(error, signal)) {
        state.status = "paused";
        state.lastError = "用户请求中断";
        await capability.store.save(state);
        return state;
      }
      const routed = await routeFailure(capability as Capability<unknown, State>, state, error, signal);
      if (routed.status !== "running") return routed;
    }
  }
}
