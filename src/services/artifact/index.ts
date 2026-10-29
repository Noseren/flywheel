import type { AgentJobResult } from "../agent/protocol.ts";
import type { ExecutionBudget } from "../../session/execution-budget.ts";

export interface ArtifactValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export class ArtifactValidationError extends Error {
  readonly issues: ArtifactValidationIssue[];

  constructor(issues: ArtifactValidationIssue | ArtifactValidationIssue[]) {
    const normalized = Array.isArray(issues) ? issues : [issues];
    super(normalized.map((issue) => issue.message).join("; "));
    this.name = "ArtifactValidationError";
    this.issues = normalized;
  }
}

export class ArtifactRepairExhausted extends Error {
  readonly artifactId: string;
  readonly attempts: number;
  readonly issues: ArtifactValidationIssue[];

  constructor(artifactId: string, attempts: number, issues: ArtifactValidationIssue[]) {
    super(`${artifactId} remained invalid after ${attempts} repair attempts: ${issues.map((issue) => issue.message).join("; ")}`);
    this.name = "ArtifactRepairExhausted";
    this.artifactId = artifactId;
    this.attempts = attempts;
    this.issues = issues;
  }
}

export class AgentExecutionError extends Error {
  readonly artifactId: string;
  readonly status: "failed" | "needs_input";

  constructor(artifactId: string, message: string, status: "failed" | "needs_input" = "failed") {
    super(message);
    this.name = "AgentExecutionError";
    this.artifactId = artifactId;
    this.status = status;
  }
}

export interface ArtifactAttemptState {
  status: "generating" | "repairing" | "validated";
  generationAttempts: number;
  repairAttempts: number;
  sessionId?: string;
  lastIssues?: ArtifactValidationIssue[];
}

export interface ValidatedArtifactContext {
  attempt: number;
  mode: "generate" | "repair";
  issues: ArtifactValidationIssue[];
  resumeSessionId?: string;
}

export type ValidatedArtifactExecutionResult = AgentJobResult & {
  validationIssues?: ArtifactValidationIssue[];
};

export interface ValidatedArtifactOptions<T> {
  executionBudget?: ExecutionBudget;
  artifactId: string;
  operationId: string;
  job: string;
  operationState: Record<string, unknown>;
  maxRepairs?: number;
  signal?: AbortSignal;
  present(): Promise<boolean>;
  validate(): Promise<T>;
  classify(error: unknown): ArtifactValidationIssue[] | undefined;
  execute(context: ValidatedArtifactContext): Promise<ValidatedArtifactExecutionResult>;
  emit(type: string, data?: Record<string, unknown>): Promise<void>;
  checkpoint(): Promise<void>;
}

function artifactStates(operationState: Record<string, unknown>): Record<string, ArtifactAttemptState> {
  const current = operationState.artifacts;
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, ArtifactAttemptState>;
  }
  const created: Record<string, ArtifactAttemptState> = {};
  operationState.artifacts = created;
  return created;
}

/** Gives a user-requested retry a fresh bounded repair window without losing its Agent session or evidence. */
export function resetArtifactRepairBudget(operationState: Record<string, unknown>): void {
  const artifacts = operationState.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) return;
  for (const state of Object.values(artifacts as Record<string, ArtifactAttemptState>)) {
    if (state && typeof state === "object") state.repairAttempts = 0;
  }
}

function interrupted(signal?: AbortSignal, result?: AgentJobResult): boolean {
  return signal?.aborted === true || result?.status === "aborted";
}

/**
 * Runs an Agent-owned artifact through generate/validate/repair with durable state.
 * Validators must classify only errors that the owning Agent can repair. Unknown
 * errors are rethrown for the Capability to treat as Runtime/infrastructure faults.
 */
export async function runValidatedArtifact<T>(options: ValidatedArtifactOptions<T>): Promise<T> {
  const states = artifactStates(options.operationState);
  const state = states[options.artifactId] ?? {
    status: "generating",
    generationAttempts: 0,
    repairAttempts: 0,
  };
  states[options.artifactId] = state;
  const maxRepairs = options.maxRepairs ?? 3;

  let issues: ArtifactValidationIssue[] = [];
  if (await options.present()) {
    try {
      const value = await options.validate();
      state.status = "validated";
      delete state.lastIssues;
      await options.checkpoint();
      await options.emit("artifact.validation.passed", {
        artifactId: options.artifactId, operationId: options.operationId, job: options.job,
        generationAttempts: state.generationAttempts, repairAttempts: state.repairAttempts,
      });
      return value;
    } catch (error) {
      const classified = options.classify(error);
      if (!classified) throw error;
      issues = classified;
    }
  }

  while (true) {
    const present = await options.present();
    const mode = state.generationAttempts === 0 ? "generate" as const : "repair" as const;
    if (mode === "repair" && state.repairAttempts >= maxRepairs) {
      await options.emit("artifact.repair.exhausted", {
        artifactId: options.artifactId, operationId: options.operationId, job: options.job,
        attempts: state.repairAttempts, issues,
      });
      throw new ArtifactRepairExhausted(options.artifactId, state.repairAttempts, issues);
    }
    if (issues.length) {
      await options.emit("artifact.validation.failed", {
        artifactId: options.artifactId, operationId: options.operationId, job: options.job,
        attempt: state.repairAttempts + 1, issues,
      });
    }
    const attempt = mode === "generate" ? state.generationAttempts + 1 : state.repairAttempts + 1;
    if (mode === "repair") await options.executionBudget?.claimRepair();
    state.status = mode === "generate" ? "generating" : "repairing";
    state.lastIssues = issues;
    await options.checkpoint();
    await options.emit(`artifact.${mode}.started`, {
      artifactId: options.artifactId, operationId: options.operationId, job: options.job,
      attempt, sessionId: state.sessionId, issues,
    });

    const result = await options.execute({
      attempt, mode, issues, resumeSessionId: state.sessionId,
    });
    if (result.sessionId) {
      state.sessionId = result.sessionId;
      await options.checkpoint();
    }
    if (interrupted(options.signal, result)) throw new DOMException("Artifact execution was interrupted", "AbortError");
    await options.emit(`artifact.${mode}.completed`, {
      artifactId: options.artifactId, operationId: options.operationId, job: options.job,
      attempt, status: result.status, sessionId: result.sessionId,
      transcriptPath: result.transcriptPath, usage: result.usage, durationMs: result.durationMs,
      ...(result.message ? { message: result.message } : {}),
    });

    if (result.protocolIssues?.length) {
      if (mode === "generate") state.generationAttempts += 1;
      else state.repairAttempts += 1;
      issues = result.protocolIssues.map((message) => ({ code: "job_result.invalid", message }));
      state.lastIssues = issues;
      await options.checkpoint();
      continue;
    }

    if (result.status !== "completed") {
      throw new AgentExecutionError(
        options.artifactId,
        result.message ?? `${options.job} ${result.status}`,
        result.status === "needs_input" ? "needs_input" : "failed",
      );
    }

    if (mode === "generate") state.generationAttempts += 1;
    else state.repairAttempts += 1;
    await options.checkpoint();

    if (result.validationIssues?.length) {
      issues = result.validationIssues;
      state.lastIssues = issues;
      await options.checkpoint();
      continue;
    }

    try {
      const value = await options.validate();
      state.status = "validated";
      delete state.lastIssues;
      await options.checkpoint();
      await options.emit("artifact.validation.passed", {
        artifactId: options.artifactId, operationId: options.operationId, job: options.job,
        generationAttempts: state.generationAttempts, repairAttempts: state.repairAttempts,
      });
      return value;
    } catch (error) {
      const classified = options.classify(error);
      if (!classified) throw error;
      issues = classified;
      state.lastIssues = issues;
      await options.checkpoint();
    }
  }
}
