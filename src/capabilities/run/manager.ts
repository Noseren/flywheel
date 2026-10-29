import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentJobResult, AgentService } from "../../services/agent/protocol.ts";
import type { JobSpec } from "../../services/agent/job-protocol.ts";
import { runStructuredDecision } from "../../services/agent/structured-decision.ts";
import { resetArtifactRepairBudget } from "../../services/artifact/index.ts";
import { promptAsset } from "../../services/prompt/index.ts";
import type { Project } from "./project.ts";
import type { StateStore } from "./state.ts";
import type { RunState } from "./protocol.ts";

interface RunManagerContext {
  readonly project: Project;
  readonly store: StateStore;
  readonly agent: AgentService;
  execute(job: JobSpec, signal?: AbortSignal): Promise<AgentJobResult>;
}

interface ManagerDecision {
  action: "stay_paused" | "resume";
  message: string;
  guidance?: string;
}

function parseDecision(value: unknown): ManagerDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manager decision must be an object");
  const decision = value as Record<string, unknown>;
  if (!["stay_paused", "resume"].includes(String(decision.action))
    || typeof decision.message !== "string" || !decision.message.trim()
    || (decision.guidance !== undefined && typeof decision.guidance !== "string")) {
    throw new Error("Manager decision requires action and a user-facing message");
  }
  return {
    action: decision.action as ManagerDecision["action"],
    message: decision.message.trim(),
    ...(typeof decision.guidance === "string" && decision.guidance.trim()
      ? { guidance: decision.guidance.trim() } : {}),
  };
}

async function decide(
  context: RunManagerContext,
  state: RunState,
  message: string,
  runtimeContext: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ManagerDecision> {
  const turnsDir = path.join(context.project.runtimeDir, "conversation", "run");
  const decisionPath = path.join(turnsDir, `${randomUUID()}.json`);
  await mkdir(turnsDir, { recursive: true });
  const proxy: AgentService = {
    provider: context.agent.provider,
    model: context.agent.model,
    execute: async (job, jobSignal) => await context.execute(job, jobSignal),
  };
  return (await runStructuredDecision({
    agent: proxy, decisionPath, parse: parseDecision, signal,
    job: {
      operation: "manager", label: "run:manager", audience: "user", cwd: context.project.root,
      tools: ["Write"], readRoots: [context.project.root], writeRoots: [turnsDir],
      sessionKey: "manager",
      prompt: promptAsset("common.manager-decision", {
        capability: "run", runtime_context: runtimeContext,
        message_source: "当前运行请求或错误", user_message: message, decision_path: decisionPath,
      }),
    },
  })).decision;
}

/** User conversation may request a retry; deterministic guards still run again before any operation. */
export async function handleRunIntervention(
  context: RunManagerContext,
  state: RunState,
  message: string,
  signal: AbortSignal,
): Promise<RunState> {
  const frozenTask = path.join(context.project.runtimeDir, "contracts", "task.md");
  const contract = await readFile(await readFile(frozenTask).then(() => frozenTask).catch(() => context.project.taskPath), "utf8");
  const decision = await decide(context, state, message, {
    status: state.status, operation: state.execution.currentOperationId, version: `v${state.iteration}`,
    iteration: state.iteration, refineAttempt: state.refineAttempt,
    lastOutcome: state.execution.lastOutcome, lastError: state.lastError,
    pendingInteraction: state.pendingInteraction,
    previousGuidance: state.execution.operationState.managerGuidance,
    contract: { content: contract, artifactPath: context.project.artifactPath, evaluatorPath: context.project.evaluatorPath },
    allowedActions: ["stay_paused", "resume"],
    immutableBoundaries: ["frozen goal", "frozen evaluator", "workspace scope", "version history"],
  }, signal);
  if (decision.guidance) state.execution.operationState.managerGuidance = decision.guidance;
  else delete state.execution.operationState.managerGuidance;
  if (decision.action === "resume") {
    if (state.execution.currentOperationId === "assess_target") {
      const assessment = state.execution.lastOutcome?.data?.assessment;
      if (assessment === "achieved") {
        state.execution.operationState.continueAfterTargetAssessment = true;
        state.pendingProposalGuidance = decision.guidance ?? message.trim();
      } else if (assessment === "inconclusive") {
        state.execution.operationState.targetAssessmentRetry = true;
      }
    }
    resetArtifactRepairBudget(state.execution.operationState);
    state.status = "running";
    delete state.lastError;
    delete state.pauseReason;
  } else {
    state.status = "paused";
    state.pauseReason = decision.message;
  }
  if (decision.action === "resume") delete state.pendingInteraction;
  await context.store.emit(state, "manager.responded", {
    action: decision.action, message: decision.message,
    ...(decision.guidance ? { guidance: decision.guidance } : {}),
  });
  return state;
}

/** Failure explanations are advisory: Session keeps the authoritative blocked state. */
export async function runManagerForFailure(
  context: RunManagerContext,
  state: RunState,
  error: unknown,
  signal: AbortSignal,
): Promise<{ message: string }> {
  const message = error instanceof Error ? error.message : String(error);
  const decision = await decide(context, state, message, {
    status: "blocked", operation: state.execution.currentOperationId, version: `v${state.iteration}`,
    invariantFailure: { message }, allowedActions: ["stay_paused"],
    immutableBoundaries: ["Runtime state", "frozen contract", "path and hash checks", "version boundary"],
  }, signal);
  if (decision.guidance) state.execution.operationState.managerGuidance = decision.guidance;
  await context.store.emit(state, "manager.responded", {
    source: "runtime_failure", action: "stay_paused", requestedAction: decision.action,
    message: decision.message, ...(decision.guidance ? { guidance: decision.guidance } : {}),
  });
  return { message: decision.message };
}
