import { promptAsset } from "../prompt/index.ts";
import { executeAgentJobTree } from "./delegation.ts";
import type { JobSpec } from "./job-protocol.ts";
import type { AgentJobResult, AgentService } from "./protocol.ts";
import { executeAgentServiceTurn } from "./service.ts";
import type { ExecutionBudget } from "../../session/execution-budget.ts";

export interface PersistentAgentJobContext {
  executionBudget?: ExecutionBudget;
  delegation?: "disabled" | "enabled";
  capabilityId: string;
  operationId: string;
  status: string;
  sessions: Record<string, string>;
  /** Shared Runtime concurrency, not a Policy or Agent decision. */
  concurrency?: number;
  guidance?: string;
  checkpoint(): Promise<void>;
  emit(type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>): Promise<void>;
}

export function agentSessionIdFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.sdkEvent !== "thread.started") return undefined;
  for (const value of [event.thread_id, event.threadId, event.sessionId]) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** Execute one Agent Job with durable provider-session identity and uniform events. */
export async function executePersistentAgentJob(
  agent: AgentService,
  job: JobSpec,
  context: PersistentAgentJobContext,
  signal?: AbortSignal,
): Promise<AgentJobResult> {
  // Policy authors describe business work; the generic session boundary owns
  // the stable root identity used for recursion, recovery and TUI replay.
  const rootJob: JobSpec = {
    ...job,
    executionBudget: job.executionBudget ?? context.executionBudget,
    delegation: job.delegation ?? context.delegation,
    id: job.id ?? `${context.capabilityId}:${context.operationId}:${job.sessionKey ?? job.resultPath ?? job.label}`,
  };
  let invocationStarted = false;
  const executeTurn = async (current: JobSpec, currentSignal?: AbortSignal): Promise<AgentJobResult> => {
    const resumeSessionId = current.sessionKey ? context.sessions[current.sessionKey] : current.resumeSessionId;
    let prompt = current.prompt;
    if (current.sessionKey) {
      prompt = promptAsset("common.capability-context", {
        capability: context.capabilityId,
        operation: context.operationId,
        status: context.status,
        job_prompt: prompt,
      });
    }
    if (context.guidance && current.sessionKey !== "manager") {
      prompt = promptAsset("common.user-intervention", {
        job_prompt: prompt,
        message: context.guidance,
      });
    }
    const result = await executeAgentServiceTurn(agent, {
      ...current,
      resumeSessionId,
      prompt,
      onEvent: async (event) => {
        if (event.sdkEvent === "invocation.started") invocationStarted = true;
        const sessionId = current.sessionKey ? agentSessionIdFromEvent(event) : undefined;
        if (current.sessionKey && sessionId) {
          context.sessions[current.sessionKey] = sessionId;
          await context.checkpoint();
        }
        await current.onEvent?.(event);
        await context.emit("job.event", {
          audience: current.audience,
          job: current.label,
          jobId: current.id ?? current.label,
          parentJobId: current.parentJobId,
          depth: current.depth ?? 0,
          ...(current.episodeId ? { episodeId: current.episodeId } : {}),
          ...event,
        });
      },
    }, currentSignal);
    if (current.sessionKey && result.sessionId) {
      context.sessions[current.sessionKey] = result.sessionId;
      await context.checkpoint();
    }
    return result;
  };

  try {
    return await executeAgentJobTree(executeTurn, rootJob, signal, {
      concurrency: context.concurrency,
      onJobEvent: async (current, event) => {
        await context.emit("job.event", { job: current.label, jobId: current.id ?? current.label,
          parentJobId: current.parentJobId, depth: current.depth ?? 0, ...event });
      },
      onJobStarted: async (current) => {
        const resumeSessionId = current.sessionKey ? context.sessions[current.sessionKey] : current.resumeSessionId;
        await context.emit("job.started", {
          audience: current.audience,
          job: current.label,
          jobId: current.id ?? current.label,
          parentJobId: current.parentJobId,
          depth: current.depth ?? 0,
          sessionKey: current.sessionKey,
          resumed: resumeSessionId !== undefined,
          sessionId: resumeSessionId,
          ...(current.episodeId ? { episodeId: current.episodeId } : {}),
        });
      },
      onJobCompleted: async (current, result) => {
        await context.emit("job.completed", {
          job: current.label,
          jobId: current.id ?? current.label,
          parentJobId: current.parentJobId,
          depth: current.depth ?? 0,
          status: result.status,
          sessionId: result.sessionId,
          transcriptPath: result.transcriptPath,
          usage: result.usage,
          durationMs: result.durationMs,
          ...(result.message ? { message: result.message } : {}),
        });
      },
    });
  } catch (error) {
    const budgetRejected = !invocationStarted && error !== null && typeof error === "object"
      && "code" in error && error.code === "EXECUTION_BUDGET_EXHAUSTED";
    await context.emit("job.completed", {
      job: rootJob.label,
      jobId: rootJob.id!,
      depth: rootJob.depth ?? 0,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      ...(budgetRejected ? { errorCode: "EXECUTION_BUDGET_EXHAUSTED", invocationStarted: false } : {}),
    });
    throw error;
  }
}
