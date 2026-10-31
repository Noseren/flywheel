import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { AgentAdapter, AgentJob, AgentResult } from "./protocol.ts";
import type { JobSpec } from "../../services/agent/job-protocol.ts";
import { validateJobSpec } from "../../services/agent/job-validation.ts";
import { promptAsset, type PromptAssetStore } from "../prompt/index.ts";
import { ExecutionBudgetExhausted } from "../../session/execution-budget.ts";

/** Record the exact public job envelope before handing it to an Agent backend. */
export async function runAgentJob(
  adapter: AgentAdapter,
  prompts: PromptAssetStore,
  request: JobSpec,
  signal?: AbortSignal,
): Promise<AgentResult> {
  validateJobSpec(request);
  const requestedProvider = adapter.provider?.toLowerCase();
  const provider = requestedProvider === "codex" || requestedProvider === "claude"
    ? requestedProvider
    : "generic";
  const resolved = await prompts.resolve(promptAsset(`adapter.${provider}.job`, {
    job_prompt: request.prompt,
    read_roots: request.readRoots.map((root) => `- ${root}`).join("\n"),
    write_roots: request.writeRoots.map((root) => `- ${root}`).join("\n"),
    denied_paths: (request.deniedPaths ?? []).map((item) => `- ${item}`).join("\n") || "- none",
    tools: request.tools.join(", "),
  }));
  const job: AgentJob = { ...request, prompt: resolved.text, promptAssets: resolved.assets };
  await job.onEvent?.({
    sdkEvent: "job.started",
    label: job.label,
    prompt: job.prompt,
    promptAssets: job.promptAssets,
    cwd: job.cwd,
    tools: job.tools,
    readRoots: job.readRoots,
    writeRoots: job.writeRoots,
    deniedPaths: job.deniedPaths,
    ...(job.resultPath ? { resultPath: job.resultPath } : {}),
    ...(job.sessionKey ? { sessionKey: job.sessionKey } : {}),
    resumeSessionId: job.resumeSessionId,
  });
  // One envelope per real transport call, never per aggregate JobResult. A
  // resumed parent turn and a retry each receive their own invocation identity.
  const invocationId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const identity = {
    invocationId,
    jobId: job.id ?? job.label,
    parentJobId: job.parentJobId,
    depth: job.depth ?? 0,
    operation: job.operation,
    provider: adapter.provider ?? "unknown",
    model: adapter.model ?? "unknown",
    startedAt,
  };
  await request.executionBudget?.startInvocation(invocationId, request.invocationReservation);
  const remainingMs = request.executionBudget?.remainingInvocationActiveMs(invocationId);
  const timeLimit = remainingMs !== undefined && Number.isFinite(remainingMs)
    ? AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))) : undefined;
  const invocationSignal = signal && timeLimit ? AbortSignal.any([signal, timeLimit]) : signal ?? timeLimit;
  await job.onEvent?.({ sdkEvent: "invocation.started", ...identity });
  let result: AgentResult;
  try {
    result = await adapter.run(job, invocationSignal);
  } catch (error) {
    await request.executionBudget?.finishInvocation(invocationId, null);
    await job.onEvent?.({
      sdkEvent: "invocation.completed", ...identity,
      endedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      status: invocationSignal?.aborted ? "aborted" : "failed",
      usage: null,
    });
    if (timeLimit?.aborted) throw new ExecutionBudgetExhausted("time");
    throw error;
  }
  await request.executionBudget?.finishInvocation(invocationId, result.usage);
  await job.onEvent?.({
    sdkEvent: "invocation.completed", ...identity,
    endedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    status: result.aborted || invocationSignal?.aborted ? "aborted" : result.success ? "completed" : "failed",
    usage: result.usage ?? null,
  });
  if (timeLimit?.aborted || (request.invocationReservation && request.executionBudget
    && request.executionBudget.remainingInvocationActiveMs(invocationId) <= 0)) throw new ExecutionBudgetExhausted("time");
  return result;
}
