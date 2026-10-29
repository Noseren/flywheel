import { readFile } from "node:fs/promises";

import type { AgentJobResult, AgentService } from "./protocol.ts";
import type { JobSpec } from "../../services/agent/job-protocol.ts";
import { promptAsset } from "../prompt/index.ts";
import type { ExecutionBudget } from "../../session/execution-budget.ts";

/** Validate a small Agent-owned decision file and return malformed output to the same session. */
export async function runStructuredDecision<T>(options: {
  agent: AgentService;
  job: JobSpec;
  decisionPath: string;
  parse: (value: unknown) => T;
  signal?: AbortSignal;
  maxAttempts?: number;
  executionBudget?: ExecutionBudget;
}): Promise<{ decision: T; result: AgentJobResult }> {
  const maxAttempts = options.maxAttempts ?? 3;
  let prompt = options.job.prompt;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const executionBudget = options.executionBudget ?? options.job.executionBudget;
    if (attempt > 1) await executionBudget?.claimRepair();
    const result = await options.agent.execute({ ...options.job, executionBudget, prompt }, options.signal);
    if (result.status === "aborted" || options.signal?.aborted) throw new Error("Decision Agent was interrupted");
    if (result.status !== "completed") throw new Error(result.message ?? "Decision Agent failed");
    try {
      const value = JSON.parse(await readFile(options.decisionPath, "utf8")) as unknown;
      return { decision: options.parse(value), result };
    } catch (error) {
      lastError = error;
      prompt = promptAsset("common.decision-repair", {
        decision_path: options.decisionPath,
        issues: error instanceof Error ? error.message : String(error),
        base_prompt: options.job.prompt,
      });
    }
  }
  throw lastError;
}
