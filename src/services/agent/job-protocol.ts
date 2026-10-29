import type { PromptRequest } from "../prompt/index.ts";
import type { ExecutionBudget } from "../../session/execution-budget.ts";

/** Trusted Policy boundary. Never accepted from an Agent-authored request. */
export interface AssistanceBoundary {
  revision: string;
  /** Stable preparation/candidate identity; restarting never creates a new window. */
  windowId: string;
  /** Opaque reservation of the next complete required execution/evaluation. */
  requiredReservationId: string;
  /** Preparation resolves this only after its verification composition is valid. */
  resolveRequiredReservationId?: () => Promise<string | undefined>;
}

/** A generic unit of work submitted by a Capability to the Runtime. */
export interface JobSpec {
  /** Shared persisted task budget; Runtime-owned, never Agent-authored. */
  executionBudget?: ExecutionBudget;
  /** Compact jobs opt out of recursive delegation; omitted preserves legacy jobs. */
  delegation?: "disabled" | "enabled";
  assistance?: AssistanceBoundary;
  /** Runtime-owned invocation reservation transfer, including parent continuation. */
  invocationReservation?: { reservationId: string; estimatedTokens?: number; estimatedActiveMs?: number; estimateClass?: string };
  /** Presentation hint only; never grants execution or state-transition authority. */
  audience?: "user" | "worker";
  /** Stable identity may be supplied by the Capability; the Runtime creates one otherwise. */
  id?: string;
  /** Runtime-owned parent identity for a recursively delegated Job. */
  parentJobId?: string;
  /** Runtime-owned zero-based depth in the delegated Job tree. */
  depth?: number;
  /** Optional isolated Episode identity for candidate-search jobs. */
  episodeId?: string;
  operation: string;
  label: string;
  cwd: string;
  tools: string[];
  readRoots: string[];
  writeRoots: string[];
  deniedPaths?: string[];
  /** Optional path where the Agent Job must write its task-independent JobResult JSON. */
  resultPath?: string;
  prompt: PromptRequest;
  /** Keep this job on the same Agent session across operations and process restarts. */
  sessionKey?: string;
  /** Low-level backend session override; Capability operations should prefer sessionKey. */
  resumeSessionId?: string;
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>;
}

/** The complete protocol an Agent may use to request isolated Child work. */
export interface DelegateTask {
  task: string;
  inputs?: string[];
  tools?: string[];
}

export interface DelegateRequest {
  tasks: DelegateTask[];
}

export interface AssistanceRequest extends DelegateRequest {
  schemaVersion: 2;
  purpose: "work" | "check";
  reason: string;
  evidence: string[];
}

/** The only task-independent result understood by the Runtime. */
export interface JobResult {
  status: "completed" | "failed" | "aborted" | "needs_input";
  artifacts: string[];
  message?: string;
}
