import type {
  ExecutionPolicyIdentity,
  ExecutionPolicySource,
  PolicyOutcome,
} from "./policy.ts";

export type InteractionKind = "text" | "confirm" | "select";

export type InteractionRequester =
  | { type: "runtime" }
  | { type: "agent"; label: string; sessionKey: string };

export interface Interaction {
  id: string;
  capabilityId: string;
  /** Stable operation label; retained as `operationId` in the wire format. */
  operationId: string;
  requestedBy: InteractionRequester;
  conversationWith?: { label: string; sessionKey: string };
  kind: InteractionKind;
  question: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  defaultValue?: string | boolean;
}

export interface InteractionResponseCommand {
  type: "interaction.respond";
  interactionId: string;
  value: string | boolean;
  /** Transport provenance, not inferred user intent. Omitted for legacy callers. */
  inputKind?: "text" | "choice";
}

export type SessionInputSource = "tui" | "gui" | "api";

export type CapabilityStatus = "running" | "waiting_for_user" | "paused" | "blocked" | "completed" | "stopped";
export type SessionStatus = "idle" | "running" | "aborting" | "stopped";

export interface PersistedOperationOutcome {
  operationId: string;
  status: "completed" | "waiting_for_user" | "paused" | "blocked";
  data?: Record<string, unknown>;
}

/** Durable execution state shared by every programmable Capability. */
export interface CapabilityExecutionState {
  policy: ExecutionPolicyIdentity;
  currentOperationId?: string;
  policyState: Record<string, unknown>;
  operationState: Record<string, unknown>;
  lastOutcome?: PersistedOperationOutcome;
}

export interface CapabilityState {
  status: CapabilityStatus;
  execution?: CapabilityExecutionState;
  /** Agent backend sessions owned by this Capability, keyed by their stable role. */
  agentSessions?: Record<string, string>;
  pendingInteraction?: Interaction;
  lastError?: string;
}

/** Opaque command envelope routed by Session and interpreted only by its Capability. */
export interface CapabilityCommand {
  readonly type: string;
}

export type CapabilityRequest =
  | { readonly type: "start" }
  | { readonly type: "resume" }
  | { readonly type: "command"; readonly command: CapabilityCommand }
  | { readonly type: "intervene"; readonly message: string };

export interface CapabilityStore<State extends CapabilityState> {
  load(): Promise<State>;
  save(state: State): Promise<void>;
  emit(state: State, type: string, data?: Record<string, unknown>): Promise<unknown>;
  /** Atomically recoverable state + event transition when the concrete store supports it. */
  commit?(
    state: State,
    type: string,
    data?: Record<string, unknown>,
    eventState?: State,
  ): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  history?(): Promise<unknown[]>;
}

export interface CapabilityManagerContext<State extends CapabilityState> {
  state: State;
  signal: AbortSignal;
}

export interface CapabilityManager<State extends CapabilityState> {
  /** Explain a failed operation and, only when Capability permits it, suggest retry. */
  onFailure(
    context: CapabilityManagerContext<State> & { error: unknown },
  ): Promise<{ message?: string; action?: "stay_blocked" | "retry" } | void>;
  /** Handle natural-language input without moving business flow outside the active Capability. */
  onIntervention(
    context: CapabilityManagerContext<State> & { message: string },
  ): Promise<State>;
}

/** Capability is a durable declaration and authority envelope; Session executes its Policy. */
export interface Capability<
  Services = unknown,
  State extends CapabilityState = CapabilityState,
  Command extends CapabilityCommand = CapabilityCommand,
  Result extends PolicyOutcome<Record<string, unknown>> = PolicyOutcome<Record<string, unknown>>,
> {
  readonly id: string;
  readonly grants: readonly string[];
  /** Trusted activation points; a candidate Policy cannot grant itself a reload point. */
  readonly policyReloadAt?: readonly string[];
  readonly store: CapabilityStore<State>;
  readonly policySource: ExecutionPolicySource<Services, State, Command, Result>;
  createState(signal: AbortSignal): Promise<State>;
  prepare?(state: State, request: CapabilityRequest, signal: AbortSignal): Promise<State>;
  services(state: State, signal: AbortSignal): Services;
  manager?: CapabilityManager<State>;
  /** Optional pre-freeze conversation lane. It must never save a runner's stale business state. */
  conversation?: {
    canAccept(state: State | undefined): boolean;
    receive(context: { message: string; signal: AbortSignal; onEvent?: (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => Promise<void> }): Promise<{ message: string }>;
    apply(state: State): Promise<void>;
  };
  failureMode?(error: unknown, state: State): "retryable" | "blocked";
  beforeOperation?(state: State, operationId: string, signal: AbortSignal): Promise<void>;
  afterOperation?(state: State, operationId: string, outcome: Result, signal: AbortSignal): Promise<void>;
}

export type CapabilityFactory = () => Capability<any, any, any, any> | Promise<Capability<any, any, any, any>>;

export type SessionCommand = (
  | { type: "session.start" }
  | { type: "capability.abort" }
  | { type: "capability.resume" }
  | (InteractionResponseCommand & { source?: SessionInputSource })
  | { type: "intervention.submit"; message: string; source?: SessionInputSource }
  | { type: "session.stop" }) & { clientRequestId?: string };

export interface SessionEvent {
  sessionId?: string;
  timestamp: string;
  type:
    | "session.started"
    | "session.attached"
    | "session.stopped"
    | "command.updated"
    | "capability.started"
    | "capability.resumed"
    | "capability.aborting"
    | "capability.idle"
    | "capability.completed"
    | "capability.blocked"
    | "capability.switched"
    | "capability.event"
    | "interaction.requested"
    | "interaction.responded"
    | "intervention.submitted"
    | "intervention.started";
  capabilityId?: string;
  data?: Record<string, unknown>;
}

export interface SessionSnapshot {
  sessionId?: string;
  status: SessionStatus;
  activeCapabilityId?: string;
  activeCapabilityStatus?: CapabilityStatus;
  pendingInteraction?: Interaction;
  error?: string;
}
