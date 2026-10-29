import type { Writable } from "node:stream";

import type { InitEvent } from "../../capabilities/init/protocol.ts";
import { AgentActivityRenderer } from "./agent-renderer.ts";

const operationLabels: Record<string, string> = {
  inspect: "检查项目",
  explore: "理解项目",
  prepare_compact: "准备评价方式并验证基线",
  prepare_recommendation: "准备配置建议",
  confirm_proposal: "确认目标与评价方式",
  // Legacy operation IDs remain readable when replaying older event logs.
  confirm_target: "确认优化对象与运行方式",
  confirm_goal: "讨论并确认目标",
  collect_goal: "讨论并确认目标",
  confirm_evaluation: "讨论评价设计",
  confirm_samples: "确认正式测试集方案",
  confirm_red_lines: "确认红线与非退化要求",
  review_summary: "确认完整方案",
  generate_contract: "生成任务契约",
  generate_evaluator: "独立生成评价器与测试",
  validate_contract: "试运行、评价并确认报告",
  smoke_test: "执行试运行",
  confirm_smoke: "确认试运行报告",
  promote_contract: "正式写入契约",
  create_baseline: "创建基线 v1",
  complete: "完成初始化",
};

const jobLabels: Record<string, string> = {
  "initialization manager": "初始化管理 Agent",
  "project exploration": "项目探索 Agent",
  "initialization recommendation": "初始化建议",
  "recommendation revision": "建议修改",
  "contract preparation": "契约生成",
  "trial run": "试运行",
  "independent quality review": "独立质量评审",
};

function operationLabel(id: unknown): string {
  const key = String(id);
  return operationLabels[key] ?? key.replaceAll("_", " ");
}

function jobLabel(value: unknown): string {
  const key = String(value ?? "Agent");
  return jobLabels[key] ?? key;
}

function oneLine(value: unknown): string {
  if (value === true) return "确认";
  if (value === false) return "不确认";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replace(/\s+/g, " ").slice(0, 200);
}

function highlightedAnswer(value: unknown): string {
  return `\u001b[7m 你：${oneLine(value) || "空输入"} \u001b[27m`;
}

function requesterLabel(data: Record<string, unknown> | undefined): string {
  const interaction = (data?.interaction ?? {}) as Record<string, unknown>;
  const requestedBy = interaction.requestedBy as Record<string, unknown> | undefined;
  return requestedBy?.type === "agent" ? String(requestedBy.label ?? "Agent") : "Runtime";
}

function renderEvent(event: InitEvent, output: Writable, activities: AgentActivityRenderer): void {
  if (event.type === "init.started") {
    output.write("初始化步骤\n\n");
    for (const operation of (event.data?.plan as string[] | undefined) ?? []) output.write(`○ ${operationLabel(operation)}\n`);
  } else if (event.type === "operation.started") output.write(`\n→ ${operationLabel(event.data?.operationId ?? event.operation)}\n`);
  else if (event.type === "operation.completed") output.write(`  ✓ ${operationLabel(event.data?.operationId ?? event.operation)}\n`);
  else if (event.type === "job.started") output.write(`  正在执行：${jobLabel(event.data?.job ?? "准备下一步结果")}…\n`);
  else if (event.type === "job.completed") output.write(`  ${event.data?.status === "completed" ? "✓" : "✗"} ${jobLabel(event.data?.job ?? "Agent 工作")}完成\n`);
  else if (event.type === "contract.validation.completed") output.write(`  ${event.data?.valid === true ? "✓" : "✗"} 暂存文件校验完成\n`);
  else if (event.type === "artifact.validation.failed") output.write(`  ↻ ${String(event.data?.artifactId ?? "产物")} 校验失败，交还原 Agent 修复\n`);
  else if (event.type === "artifact.validation.passed") output.write(`  ✓ ${String(event.data?.artifactId ?? "产物")} 校验通过\n`);
  else if (event.type === "artifact.repair.exhausted") output.write(`  ✗ ${String(event.data?.artifactId ?? "产物")} 自动修复次数已耗尽\n`);
  else if (event.type === "smoke_test.completed") {
    output.write(event.data?.passed === true ? "  ✓ 试运行通过\n" : "  ✗ 试运行未通过\n");
  }
  else if (event.type === "contract.promoted") output.write("  ✓ 契约已正式写入 .flywheel/\n");
  else if (event.type === "baseline.created") output.write("  ✓ 基线 v1 已创建\n");
  else if (event.type === "runtime.budget.exhausted") output.write(`\nⅡ 已暂停：${({ attempts: "候选尝试次数", time: "活跃执行时间", tokens: "已知 token", repair: "自动修复次数" } as Record<string, string>)[String(event.data?.reason)] ?? "执行"}预算已用完，进度已保留。\n`);
  else if (event.type === "manager.responded") {
    output.write(`\n初始化管理 Agent · ${String(event.data?.message ?? "已处理。")}\n`);
  }
  else if (event.type === "job.event") activities.render(event, output);
}

export class InitEventRenderer {
  private readonly activities = new AgentActivityRenderer();

  render(event: InitEvent, output: Writable): void {
    renderEvent(event, output, this.activities);
  }
}

export function replayInitHistory(events: InitEvent[], output: Writable): void {
  if (!events.length) return;
  const plan = [...events].reverse().find((event) => event.type === "init.started")?.data?.plan as string[] | undefined;
  const completed = new Set(events.filter((event) => event.type === "operation.completed").map((event) => String(event.data?.operationId ?? event.operation)));
  if (plan) {
    output.write("继续已有的初始化\n\n");
    for (const operation of plan) output.write(`${completed.has(operation) ? "✓" : "○"} ${operationLabel(operation)}\n`);
  }
  output.write("\n已有回答\n");
  const questions = new Map<string, { question: string; requester: string }>();
  for (const event of events) {
    if (event.type === "interaction.requested") questions.set(String(event.data?.interactionId), {
      question: String(event.data?.question ?? "Input"),
      requester: requesterLabel(event.data),
    });
    else if (event.type === "interaction.resolved") {
      const id = String(event.data?.interactionId);
      const request = questions.get(id);
      output.write(`  ${request ? `${request.requester} · ${request.question}` : id}\n${highlightedAnswer(event.data?.value)}\n`);
    }
  }
}
