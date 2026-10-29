import type { BudgetEstimate, ExecutionBudget } from "../session/execution-budget.ts";
import type { VerificationConfig } from "./compact-evaluation.ts";
import type { JobSpec } from "../services/agent/job-protocol.ts";

/** Runtime-owned marker. Missing markers keep the original compact permissions. */
export const COMPACT_ASSISTANCE_REVISION = "2026-10-24.compact.v2";

export function compactPolicyJob(job: JobSpec, revision: string | undefined, operation: string): JobSpec {
  const approved = revision === COMPACT_ASSISTANCE_REVISION && job.operation === operation
    && job.assistance?.revision === COMPACT_ASSISTANCE_REVISION;
  return approved ? { ...job, delegation: "enabled" }
    : { ...job, delegation: "disabled", assistance: undefined };
}

export function requiredVerificationWork(config: VerificationConfig, budget: ExecutionBudget): BudgetEstimate {
  const tasking = config.tasking ? budget.estimateInvocation("verification:tasking") : undefined;
  const judging = config.judging ? budget.estimateInvocation("verification:judging") : undefined;
  // Conservative admission estimates, not measured usage or an Agent cost promise.
  return { tokens: (tasking?.tokens ?? 0) + (judging?.tokens ?? 0),
    activeMs: config.timeoutMs + (tasking?.activeMs ?? 0) + (judging?.activeMs ?? 0),
    source: `frozen-verification-v1:program:${config.timeoutMs};${tasking?.source ?? "no-tasking"};${judging?.source ?? "no-judging"}` };
}

export function compactAssistanceGuidance(enabled: boolean): string {
  return enabled
    ? "默认自行完成；有具体覆盖疑点或独立问题时主动使用 Runtime 提供的有界 work/check，不必等到测试失败。准备阶段先对照原始目标与检查断言，写出有效 verification、必要 Guide 和 manifest，再以明确的要求、现有证据和疑似漏检行为请求 check。此时评价仍是草稿，可在已批准目标/范围内吸收建议、补齐检查并更新 manifest；不要因自己草稿的可修补缺口要求用户重新准备。子报告仅为建议，父 Agent 负责核对和合并，不增加候选或代替正式评价。已冻结评价遗漏要求或目标本身含糊才返回 needs_input 及具体缺口，不能静默改其含义。"
    : "本任务沿用原有权限，不得委派。";
}
