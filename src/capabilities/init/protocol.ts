import type { AgentService } from "../../services/agent/protocol.ts";
import type { JobResult, JobSpec } from "../../services/agent/job-protocol.ts";
import type { ArtifactValidationIssue, ValidatedArtifactOptions } from "../../services/artifact/index.ts";
import type { VersionStore } from "../../services/version/index.ts";
import type { PromptRequest } from "../../services/prompt/index.ts";
import type { WorkspaceService } from "../../services/workspace/index.ts";
import type { ProcessService } from "../../services/process/index.ts";
import type { Interaction, InteractionResponseCommand } from "../../session/protocol.ts";
import type { PolicyOperation, PolicyOutcome } from "../../session/policy.ts";
import type { InitProposal } from "./proposal.ts";
import type { CapabilityExecutionState, CapabilityState } from "../../session/protocol.ts";
import type { InitInspection } from "./inspector.ts";
import type { ExecutionBudget } from "../../session/execution-budget.ts";

export type InitStatus = "running" | "paused" | "waiting_for_user" | "blocked" | "completed";

export interface InitState extends CapabilityState {
  /** Missing on existing sessions: never migrate their approvals or operations. */
  workflow?: "compact";
  /** Runtime-owned policy identity; absent on pre-assistance tasks. */
  assistanceRevision?: string;
  schemaVersion: 3;
  capabilityRunId: string;
  operationRunId?: string;
  execution: CapabilityExecutionState;
  projectRoot: string;
  status: InitStatus;
  inspection: InitInspection;
  answers: Record<string, string | boolean>;
  /** Missing on historic sessions: retain their explicit report-review workflow. */
  confirmationMode?: "brief" | "review";
  proposal?: InitProposal;
  pendingInteraction?: Interaction;
  /** Durable input consumed by the currently selected Policy operation. */
  pendingCommand?: InitCommand;
  eventSequence: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface InitEvent {
  id: string;
  capabilityRunId: string;
  operationRunId?: string;
  jobId?: string;
  sequence: number;
  timestamp: string;
  scope: "init";
  projectRoot: string;
  operation: string;
  type: string;
  data?: Record<string, unknown>;
}

export type InitCommand = InteractionResponseCommand;

export type InitOperationResult = PolicyOutcome<Record<string, unknown>>;

export interface InitServices {
  executionBudget?: ExecutionBudget;
  projectRoot: string;
  workspace: WorkspaceService;
  artifact: {
    run<T>(options: Omit<ValidatedArtifactOptions<T>, "emit" | "checkpoint">): Promise<T>;
    readJobResult(job: JobSpec): Promise<JobResult>;
    issues(error: unknown): ArtifactValidationIssue[] | undefined;
    jobFailure(id: string, message: string, status?: "failed" | "needs_input"): Error;
    invalid(code: string, message: string): Error;
  };
  version: VersionStore;
  process: ProcessService;
  prompt(id: string, variables: Record<string, unknown>): PromptRequest;
  decide<T>(options: {
    directory: string;
    job(decisionPath: string): JobSpec;
    parse(value: unknown): T;
    signal?: AbortSignal;
  }): Promise<{ decision: T }>;
  agent: AgentService;
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
}

export type InitOperation = PolicyOperation<
  InitServices,
  InitState,
  InitCommand,
  InitOperationResult
>;

export function currentInitOperation(state: InitState): string {
  return state.execution.currentOperationId ?? "init";
}
