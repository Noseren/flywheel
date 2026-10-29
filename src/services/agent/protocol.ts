import type { PromptAssetUse } from "../prompt/index.ts";
import type { JobSpec } from "../../services/agent/job-protocol.ts";
import type { JobResult } from "../../services/agent/job-protocol.ts";

/** Fully rendered transport job accepted by an Agent backend adapter. */
export interface AgentJob extends Omit<JobSpec, "prompt"> {
  prompt: string;
  promptAssets: PromptAssetUse[];
}

/** Provider transport result. This stays behind AgentService. */
export interface AgentResult {
  success: boolean;
  aborted?: boolean;
  summary?: string;
  error?: string;
  sessionId?: string;
  transcriptPath?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  costUsd?: number;
  durationMs?: number;
}

/** Capability-facing result for an AgentService Job. */
export interface AgentJobResult extends JobResult {
  /** Present only when transport succeeded but the JobResult protocol was damaged. */
  protocolIssues?: string[];
  sessionId?: string;
  transcriptPath?: string;
  usage?: AgentResult["usage"];
  costUsd?: number;
  durationMs?: number;
}

export interface AgentAdapter {
  readonly provider?: string;
  readonly model?: string;
  run(job: AgentJob, signal?: AbortSignal): Promise<AgentResult>;
}

/** Prompt-aware Agent capability exposed as a Service to a Capability. */
export interface AgentService {
  readonly provider?: string;
  readonly model?: string;
  execute(job: JobSpec, signal?: AbortSignal): Promise<AgentJobResult>;
}
