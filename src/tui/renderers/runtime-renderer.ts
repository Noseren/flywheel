import type { Writable } from "node:stream";

import type { RunEvent } from "../../capabilities/run/protocol.ts";
import { AgentActivityRenderer } from "./agent-renderer.ts";

const operationLabels: Record<string, string> = {
  bootstrap: "载入项目",
  verify: "验证当前基线",
  optimize: "改进候选",
  verify_candidate: "验证候选",
  retain: "保留或拒绝候选",
  tasking: "生成样本输出",
  evaluate: "评价本轮结果",
  assess_target: "判断目标是否达成",
  propose: "聚合分析并提出建议",
  refine: "实现并验证候选",
  select: "选择候选",
  complete: "完成目标",
};

function operationLabel(operation: unknown): string {
  return operationLabels[String(operation)] ?? String(operation);
}

function jobLabel(job: unknown): string {
  const value = String(job ?? "Agent");
  if (value === "verification:tasking") return "执行验证任务";
  if (value === "verification:judging") return "独立评价结果";
  if (value.startsWith("tasking:")) return `样本执行 ${value.slice("tasking:".length)}`;
  if (value.startsWith("candidate:tasking:")) return `候选样本执行 ${value.slice("candidate:tasking:".length)}`;
  if (value.startsWith("candidate:evaluate:")) return `候选评价 ${value.slice("candidate:evaluate:".length)}`;
  if (value.startsWith("candidate:refine:")) return `候选实现 ${value.slice("candidate:refine:".length)}`;
  if (value.startsWith("candidate:review:")) return `候选复核 ${value.slice("candidate:review:".length)}`;
  if (value.startsWith("evaluate:judge:")) return `独立评价 ${value.slice("evaluate:judge:".length)}`;
  if (value.startsWith("assess-target:")) return `目标判定 ${value.slice("assess-target:".length)}`;
  if (value === "propose") return "改进建议";
  if (value === "select") return "候选选择";
  if (value === "run manager") return "运行管理 Agent";
  return value;
}

export class RuntimeEventRenderer {
  private readonly activities = new AgentActivityRenderer();
  private startedOperation?: string;

  render(event: RunEvent, output: Writable): void {
    if (event.type === "runtime.initialized") output.write(`Flywheel 运行已初始化 · ${event.version}\n`);
    else if (event.type === "operation.started") {
      this.startedOperation = event.operation;
      output.write(`\n→ ${event.version} · ${operationLabel(event.operation)}\n`);
    } else if (event.type === "operation.completed") {
      output.write(`  ✓ ${operationLabel(this.startedOperation ?? event.operation)}完成\n`);
      this.startedOperation = undefined;
    } else if (event.type === "job.started") output.write(`  → ${jobLabel(event.data?.job)}\n`);
    else if (event.type === "job.event") this.activities.render(event, output);
    else if (event.type === "job.completed") {
      output.write(`  ${event.data?.status === "completed" ? "✓" : "✗"} ${jobLabel(event.data?.job)}${event.data?.status === "completed" ? "完成" : "失败"}`);
      if (event.data?.durationMs !== undefined) output.write(` · ${Math.round(Number(event.data.durationMs) / 1000)}s`);
      output.write("\n");
    } else if (event.type === "artifact.validation.failed") {
      output.write(`  ↻ ${String(event.data?.artifactId ?? "产物")} 校验失败，交还原 Agent 修复\n`);
    } else if (event.type === "artifact.validation.passed") {
      output.write(`  ✓ ${String(event.data?.artifactId ?? "产物")} 校验通过\n`);
    } else if (event.type === "artifact.repair.exhausted") {
      output.write(`  ✗ ${String(event.data?.artifactId ?? "产物")} 自动修复次数已耗尽\n`);
    } else if (event.type === "gate.opened") output.write(`\n⚠ 需要人工确认：${String(event.data?.reason ?? "发现风险")}\n`);
    else if (event.type === "gate.resolved") output.write(`✓ 人工确认已处理：${String(event.data?.decision ?? "continue")}\n`);
    else if (event.type === "runtime.completed") {
      const finalVersion = String(event.data?.finalVersion ?? event.version);
      const versions = finalVersion === event.version
        ? finalVersion
        : `评测 ${event.version} · 晋升版本 ${finalVersion}`;
      output.write(`\n✓ Flywheel 已达到目标 · ${versions}\n`);
    }
    else if (event.type === "runtime.budget.exhausted") output.write(`\nⅡ 已暂停：${({ attempts: "候选尝试次数", time: "活跃执行时间", tokens: "已知 token", repair: "自动修复次数" } as Record<string, string>)[String(event.data?.reason)] ?? "执行"}预算已用完，进度已保留。\n`);
    else if (event.type === "runtime.stopped") output.write(`\n■ Flywheel 已停止：${String(event.data?.reason ?? "达到运行限制")}\n`);
    else if (event.type === "runtime.paused") output.write(`\nⅡ Flywheel 当前操作已中断：${String(event.data?.reason ?? "用户请求中断")}\n`);
    else if (event.type === "runtime.resumed") output.write(`\n▶ Flywheel 已恢复 · ${operationLabel(event.data?.operation ?? event.operation)}\n`);
    else if (event.type === "manager.responded") {
      output.write(`\n运行管理 Agent · ${String(event.data?.message ?? "已处理。")}\n`);
    }
    else if (event.type === "runtime.blocked") output.write(`\n✗ Flywheel 已阻断：${String(event.data?.error ?? "未知错误")}\n`);
  }
}
