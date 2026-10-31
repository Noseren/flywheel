import type {
  CapabilityExecutionState,
  CapabilityState,
  CapabilityStatus,
  PersistedOperationOutcome,
} from "../../session/protocol.ts";
import type { Interaction } from "../../session/protocol.ts";
import type { CompactRunRoutingState } from "./policy/compact-v3.ts";

export const RUN_OPERATIONS = [
  "tasking",
  "evaluate",
  "assess_target",
  "propose",
  "refine",
  "select",
  "complete",
] as const;

export type BuiltinRunOperationId = (typeof RUN_OPERATIONS)[number];
export type RunOperationId = BuiltinRunOperationId | (string & {});
export type RunStatus = CapabilityStatus;

export interface RunState extends CapabilityState {
  workflow?: "compact";
  assistanceRevision?: string;
  compact?: {
    routing?: CompactRunRoutingState;
    attempts: number;
    baselineResultPath?: string;
    baselineResultSha256?: string;
    baselineEvidence?: { path: string; sha256: string }[];
    retainedOutcome?: { iteration: number; pauseReason?: string };
    candidate?: { id: string; baseVersion: string; workspace: string; worktree: string; phase: "reserved" | "optimized" | "verified"; treeHash?: string; resultPath?: string; resultSha256?: string; evidence?: { path: string; sha256: string }[] };
    history: { id: string; retained: boolean; publicFeedback?: string }[];
    frozenFiles: { path: string; sha256: string }[];
  };
  schemaVersion: 3;
  status: RunStatus;
  execution: CapabilityExecutionState;
  capabilityRunId: string;
  operationRunId?: string;
  operationTransaction?: {
    id: string;
    operationId: RunOperationId;
    iteration: number;
    refineAttempt?: number;
    checkpoint: string;
    startedAt: string;
  };
  promotionTransaction?: {
    candidateId: string;
    version: string;
    recordId: string;
    candidateStateId: string;
    createdAt: string;
    recorded?: boolean;
  };
  episodeId: string;
  agentStateId: string;
  steeringRevisionId: string;
  iteration: number;
  maxIterations?: number;
  refineAttempt: number;
  evaluatorSha256: string;
  collectorSha256?: string;
  collectorGuideSha256?: string;
  contractSha256: string;
  goalSha256?: string;
  /** User guidance recorded after an achieved target when they explicitly continue searching. */
  pendingProposalGuidance?: string;
  pauseReason?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  pendingRunCommand?: RunCommand;
  commandResult?: Record<string, unknown>;
  /** Durable continuation captured while an administrative Policy operation runs beside the main loop. */
  adminReturn?: {
    status: CapabilityStatus;
    currentOperationId?: string;
    lastOutcome?: PersistedOperationOutcome;
    operationState: Record<string, unknown>;
    pendingInteraction?: Interaction;
    lastError?: string;
  };
}

export type RunCommand =
  | { type: "steering.propose" }
  | { type: "steering.resolve"; candidateId: string; decision: "approve" | "reject" }
  | { type: "policy.activate"; candidateId: string };

export type LifecycleAction = "promote" | "iterate" | "stop" | "ask_user" | "rollback";

export interface RunEvent {
  id: string;
  capabilityRunId: string;
  operationRunId?: string;
  jobId?: string;
  episodeId: string;
  agentStateId: string;
  steeringRevisionId: string;
  timestamp: string;
  type:
    | "runtime.initialized"
    | "runtime.blocked"
    | "runtime.completed"
    | "runtime.stopped"
    | "runtime.paused"
    | "runtime.budget.exhausted"
    | "runtime.resumed"
    | "manager.responded"
    | "runtime.policy.loaded"
    | "runtime.policy.activated"
    | "runtime.policy.rollback"
    | "steering.candidate.staged"
    | "steering.candidate.resolved"
    | "operation.started"
    | "operation.recovered"
    | "operation.activity"
    | "operation.completed"
    | "job.started"
    | "job.event"
    | "job.completed"
    | "artifact.generate.started"
    | "artifact.generate.completed"
    | "artifact.repair.started"
    | "artifact.repair.completed"
    | "artifact.validation.failed"
    | "artifact.validation.passed"
    | "artifact.repair.exhausted"
    | "gate.opened"
    | "gate.resolved";
  version: string;
  /** Stable operation label retained as `operation` in the event wire format. */
  operation: RunOperationId;
  status: RunStatus;
  data?: Record<string, unknown>;
}
