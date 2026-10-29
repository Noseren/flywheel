import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Interaction } from "./protocol.ts";

export interface PolicyResultBase {
  readonly status: string;
}


export type PolicyOutcome<OperationState = never> = { readonly data?: Record<string, unknown> } & (
  | { readonly status: "completed"; readonly state?: OperationState }
  | { readonly status: "waiting_for_user"; readonly interaction: Interaction; readonly state?: OperationState }
  | { readonly status: "paused"; readonly reason?: string; readonly state?: OperationState }
  | { readonly status: "blocked"; readonly error: string; readonly state?: OperationState }
);

export interface PolicyOperationContext<Services, State, Command = never> {
  readonly services: Services;
  readonly state: State;
  readonly signal: AbortSignal;
  /** Present only when Session is resolving an interaction for the current operation. */
  readonly command?: Command;
}

export type PolicyOperation<Services, State, Command, Result extends PolicyResultBase> = (
  context: PolicyOperationContext<Services, State, Command>,
) => Promise<Result>;

export interface ExecutionPolicy<Services, State = unknown, Command = never, Result extends PolicyResultBase = PolicyOutcome> {
  readonly id: string;
  readonly revision: string;
  /** Declarative dependencies. Capability grants remain the authority boundary. */
  readonly requires?: readonly string[];
  readonly operations: Readonly<Record<string, PolicyOperation<Services, State, Command, Result>>>;
  decide(context: ExecutionPolicyContext<State>): ExecutionPolicyDecision;
}

export interface ExecutionPolicyContext<State = unknown> {
  readonly state: Readonly<State>;
  readonly currentOperationId?: string;
  readonly lastOutcome?: {
    /** Stable operation label; `operationId` is the persisted/UI field name, not a Operation object. */
    readonly operationId: string;
    readonly status: "completed" | "waiting_for_user" | "paused" | "blocked";
    readonly data?: Record<string, unknown>;
  };
  readonly policyState: Readonly<Record<string, unknown>>;
}

type PolicyStateUpdate = { readonly policyState?: Record<string, unknown> };

export type ExecutionPolicyDecision = PolicyStateUpdate & (
  | { readonly type: "run"; readonly operationId: string }
  | { readonly type: "complete" }
  | { readonly type: "blocked"; readonly error: string }
);

export interface ExecutionPolicyIdentity {
  readonly id: string;
  readonly revision: string;
}

export type ExecutionPolicySource<Services, State = unknown, Command = never, Result extends PolicyResultBase = PolicyOutcome> =
  () => ExecutionPolicy<Services, State, Command, Result>
    | Promise<ExecutionPolicy<Services, State, Command, Result>>;

type ExecutionPolicyModule<Services, State, Command, Result extends PolicyResultBase> = {
  default?: ExecutionPolicy<Services, State, Command, Result>
    | (() => ExecutionPolicy<Services, State, Command, Result>
      | Promise<ExecutionPolicy<Services, State, Command, Result>>);
};

export function defineExecutionPolicy<Services, State = unknown, Command = never, Result extends PolicyResultBase = PolicyOutcome>(
  policy: ExecutionPolicy<Services, State, Command, Result>,
): ExecutionPolicy<Services, State, Command, Result> {
  if (!policy.id.trim()) throw new Error("Execution policy id may not be empty");
  if (!policy.revision.trim()) throw new Error("Execution policy revision may not be empty");
  if (typeof policy.decide !== "function") throw new Error("Execution policy must define decide(context)");
  const operationIds = Object.keys(policy.operations);
  if (!operationIds.length) throw new Error("Execution policy must define at least one operation");
  for (const operationId of operationIds) {
    if (!operationId.trim()) throw new Error("Policy operation id may not be empty");
    if (typeof policy.operations[operationId] !== "function") {
      throw new Error(`Policy operation ${operationId} must be executable`);
    }
  }
  const required = new Set<string>();
  for (const serviceId of policy.requires ?? []) {
    if (!serviceId.trim()) throw new Error("Required service id may not be empty");
    if (required.has(serviceId)) throw new Error(`Duplicate required service: ${serviceId}`);
    required.add(serviceId);
  }
  return policy;
}

/** Declaration never grants authority: all required Service IDs must already be Capability grants. */
export function assertPolicyServiceGrants(
  policy: Pick<ExecutionPolicy<unknown>, "id" | "revision" | "requires">,
  grantedServiceIds: readonly string[],
): void {
  const granted = new Set(grantedServiceIds);
  for (const serviceId of policy.requires ?? []) {
    if (!granted.has(serviceId)) {
      throw new Error(
        `Execution policy ${policy.id}@${policy.revision} requires ungranted service ${serviceId}`,
      );
    }
  }
}

export function decideExecutionPolicy<Services, State, Command, Result extends PolicyResultBase>(
  policy: ExecutionPolicy<Services, State, Command, Result>,
  context: ExecutionPolicyContext<State>,
): ExecutionPolicyDecision {
  const decision = policy.decide(context);
  if (decision.type === "run" && !(decision.operationId in policy.operations)) {
    throw new Error(
      `Execution policy ${policy.id}@${policy.revision} decided to run unknown operation ${decision.operationId}`,
    );
  }
  return decision;
}

/** Execute one named Policy operation. Session owns repetition and lifecycle. */
export async function executePolicyOperation<Services, State, Command, Result extends PolicyResultBase>(
  policy: ExecutionPolicy<Services, State, Command, Result>,
  operationId: string,
  context: PolicyOperationContext<Services, State, Command>,
): Promise<Result> {
  if (context.signal.aborted) throw new DOMException("Policy operation was interrupted", "AbortError");
  const operation = policy.operations[operationId];
  if (!operation) throw new Error(`Unknown policy operation: ${operationId}`);
  const result = await operation(context);
  if (context.signal.aborted) throw new DOMException("Policy operation was interrupted", "AbortError");
  return result;
}

export async function loadExecutionPolicy<Services, State = unknown, Command = never, Result extends PolicyResultBase = PolicyOutcome>(
  source: ExecutionPolicySource<Services, State, Command, Result>,
): Promise<ExecutionPolicy<Services, State, Command, Result>> {
  return defineExecutionPolicy(await source());
}

/**
 * Trusted local modules execute with Runtime process authority. Agent-authored
 * candidates must therefore pass staging and approval before this loader is used.
 */
export function trustedModuleExecutionPolicySource<Services, State = unknown, Command = never, Result extends PolicyResultBase = PolicyOutcome>(
  modulePath: string,
): ExecutionPolicySource<Services, State, Command, Result> {
  const absolute = path.resolve(modulePath);
  return async () => {
    const source = await readFile(absolute);
    const digest = createHash("sha256").update(source).digest("hex");
    const specifier = pathToFileURL(absolute);
    specifier.searchParams.set("flywheel", digest);
    const loaded = await import(specifier.href) as ExecutionPolicyModule<Services, State, Command, Result>;
    const exported = typeof loaded.default === "function" ? await loaded.default() : loaded.default;
    if (!exported) throw new Error(`Execution policy module has no default export: ${absolute}`);
    const policy = defineExecutionPolicy(exported);
    return defineExecutionPolicy({
      ...policy,
      revision: `${policy.revision}+${digest.slice(0, 12)}`,
    });
  };
}
