import { readFile } from "node:fs/promises";

import type { JobResult, JobSpec } from "../../services/agent/job-protocol.ts";
import { validateJobResult } from "../../services/agent/job-validation.ts";
import type { PromptAssetStore } from "../prompt/index.ts";
import { runAgentJob } from "./job-runner.ts";
import type { AgentAdapter, AgentJobResult, AgentService } from "./protocol.ts";

type AgentTurnExecutor = (job: JobSpec, signal?: AbortSignal) => Promise<AgentJobResult>;
const turnExecutors = new WeakMap<AgentService, AgentTurnExecutor>();

/** Internal session seam: public consumers only implement and receive AgentService. */
export async function executeAgentServiceTurn(
  agent: AgentService,
  job: JobSpec,
  signal?: AbortSignal,
): Promise<AgentJobResult> {
  return await (turnExecutors.get(agent) ?? agent.execute.bind(agent))(job, signal);
}

/** Capability-facing Agent service; provider adapters remain transport details. */
export class DefaultAgentService implements AgentService {
  readonly provider?: string;
  readonly model?: string;
  private readonly adapter: AgentAdapter;
  private readonly prompts: PromptAssetStore;

  constructor(adapter: AgentAdapter, prompts: PromptAssetStore) {
    this.adapter = adapter;
    this.prompts = prompts;
    this.provider = adapter.provider;
    this.model = adapter.model;
    turnExecutors.set(this, async (job, signal) => await this.run(job, signal, true));
  }

  async execute(job: JobSpec, signal?: AbortSignal): Promise<AgentJobResult> {
    return await this.run(job, signal, false);
  }

  private async run(job: JobSpec, signal: AbortSignal | undefined, deferResultValidation: boolean): Promise<AgentJobResult> {
    const result = await runAgentJob(this.adapter, this.prompts, job, signal);
    if (result.success && !result.aborted && !signal?.aborted && job.resultPath && !deferResultValidation) {
      try {
        const jobResult = await validateJobResult(
          JSON.parse(await readFile(job.resultPath, "utf8")) as JobResult,
          job,
        );
        return {
          ...jobResult,
          sessionId: result.sessionId,
          transcriptPath: result.transcriptPath,
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          artifacts: [],
          message: `JobResult protocol invalid: ${message}`,
          protocolIssues: [message],
          sessionId: result.sessionId,
          transcriptPath: result.transcriptPath,
          usage: result.usage,
          costUsd: result.costUsd,
          durationMs: result.durationMs,
        };
      }
    }
    const jobResult: AgentJobResult = {
      status: result.aborted || signal?.aborted ? "aborted" : result.success ? "completed" : "failed",
      artifacts: [],
      ...(result.error || result.summary || (!result.success && !result.aborted)
        ? { message: result.error ?? result.summary ?? "Agent transport failed without details" }
        : {}),
      sessionId: result.sessionId,
      transcriptPath: result.transcriptPath,
      usage: result.usage,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
    };
    await validateJobResult(jobResult, job);
    return jobResult;
  }
}
