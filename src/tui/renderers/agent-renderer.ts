import type { Writable } from "node:stream";

const jobLabels: Record<string, string> = {
  "initialization manager": "初始化管理 Agent",
  "project exploration": "项目探索 Agent",
  "initialization recommendation": "初始化建议",
  "recommendation revision": "建议修改",
  "contract preparation": "契约生成",
  "trial run": "试运行",
  "independent quality review": "独立质量评审",
};

function jobLabel(value: unknown): string {
  const key = String(value ?? "Agent");
  return jobLabels[key] ?? key;
}

type SdkItem = {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  changes?: Array<{ path?: string; kind?: string }>;
  items?: Array<{ text?: string; completed?: boolean }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string };
  query?: string;
  message?: string;
};

function block(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function oneLine(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? "").replace(/\s+/g, " ").slice(0, 200);
}

function inlineDetail(value: unknown, maximum = 160): string {
  const detail = oneLine(value);
  if (!detail) return "";
  return ` · ${detail.length > maximum ? `${detail.slice(0, maximum - 1)}…` : detail}`;
}

function writeIndented(output: Writable, value: unknown, prefix = "      "): void {
  const text = block(value);
  if (!text) return;
  for (const line of text.replace(/\n$/, "").split("\n")) output.write(`${prefix}${line}\n`);
}

export class AgentActivityRenderer {
  private readonly commandOutputLengths = new Map<string, number>();
  private readonly lastTodoSnapshots = new Map<string, string>();

  render(event: { data?: Record<string, unknown> }, output: Writable): void {
    const data = event.data ?? {};
    const sdkEvent = String(data.sdkEvent ?? "");
    const job = jobLabel(data.job ?? "Agent");

    if (sdkEvent === "job.started") {
      output.write(`    Runtime → Agent · ${jobLabel(data.label ?? data.job)}\n`);
      if (Array.isArray(data.promptAssets)) {
        const assets = data.promptAssets.map((asset) => {
          const value = asset as { id?: unknown; source?: unknown; templateSha256?: unknown };
          return `${String(value.id ?? "unknown")}@${String(value.templateSha256 ?? "").slice(0, 8)} (${String(value.source ?? "unknown")})`;
        });
        output.write(`    Prompt 资产：${assets.join(" → ")}\n`);
      }
      output.write("    完整消息：\n");
      writeIndented(output, data.prompt ?? "");
      if (data.cwd) output.write(`    工作目录：${String(data.cwd)}\n`);
      if (Array.isArray(data.tools)) output.write(`    可用工具：${data.tools.join(", ") || "无"}\n`);
      if (Array.isArray(data.readRoots)) {
        output.write("    可读范围：\n");
        writeIndented(output, data.readRoots);
      }
      if (Array.isArray(data.writeRoots)) {
        output.write("    可写范围：\n");
        writeIndented(output, data.writeRoots);
      }
      if (data.resumeSessionId) output.write(`    续接 Agent 会话：${String(data.resumeSessionId)}\n`);
      return;
    }
    if (sdkEvent === "thread.started") {
      output.write(`    Agent 会话：${String(data.thread_id ?? "未知")}\n`);
      if (data.transcriptPath) output.write(`    Codex 记录：${String(data.transcriptPath)}\n`);
      return;
    }
    if (sdkEvent === "codex.transcript.located") {
      output.write(`    Codex 记录：${String(data.transcriptPath ?? "未知")}\n`);
      return;
    }
    if (sdkEvent === "turn.started") {
      output.write("    Agent 回合开始\n");
      return;
    }
    if (sdkEvent === "turn.completed") {
      const usage = data.usage as Record<string, unknown> | undefined;
      output.write("    Agent 回合完成");
      if (usage) output.write(` · 输入 ${String(usage.input_tokens ?? 0)} · 输出 ${String(usage.output_tokens ?? 0)}`);
      output.write("\n");
      return;
    }
    if (sdkEvent === "turn.failed" || sdkEvent === "error") {
      const error = data.error as { message?: string } | undefined;
      output.write(`    ✗ ${job}：${error?.message ?? String(data.message ?? "未知错误")}\n`);
      return;
    }
    if (!sdkEvent.startsWith("item.")) return;

    const lifecycle = sdkEvent.slice("item.".length);
    const item = (data.item ?? {}) as SdkItem;
    const id = `${job}:${String(item.id ?? item.type ?? "item")}`;

    if (item.type === "agent_message") {
      if (lifecycle === "completed") {
        output.write("    Agent 消息：\n");
        writeIndented(output, item.text ?? "");
      }
      return;
    }
    if (item.type === "reasoning") {
      if (lifecycle !== "started" && item.text) {
        output.write("    推理摘要：\n");
        writeIndented(output, item.text);
      }
      return;
    }
    if (item.type === "command_execution") {
      if (lifecycle === "started") output.write(`    → 命令${inlineDetail(item.command)}\n`);
      const aggregate = item.aggregated_output ?? "";
      const previousLength = this.commandOutputLengths.get(id) ?? 0;
      if (aggregate.length > previousLength) {
        output.write(`    · 输出${inlineDetail(aggregate.slice(previousLength))}\n`);
        this.commandOutputLengths.set(id, aggregate.length);
      }
      if (lifecycle === "completed") {
        const success = item.status === "completed" && item.exit_code === 0;
        output.write(`    ${success ? "✓" : "✗"} 命令${item.status === "failed" ? "失败" : "完成"}`);
        if (item.exit_code !== undefined) output.write(`（退出码 ${item.exit_code}）`);
        output.write("\n");
      }
      return;
    }
    if (item.type === "file_change") {
      if (lifecycle === "completed") {
        const changes = (item.changes ?? []).map((change) => `${change.kind ?? "update"} ${change.path ?? "未知路径"}`).join("；");
        output.write(`    ${item.status === "failed" ? "✗" : "✓"} 文件修改${item.status === "failed" ? "失败" : "完成"}${inlineDetail(changes)}\n`);
      }
      return;
    }
    if (item.type === "todo_list") {
      const snapshot = JSON.stringify(item.items ?? []);
      if (this.lastTodoSnapshots.get(id) !== snapshot) {
        const todos = (item.items ?? []).map((todo) => `${todo.completed ? "✓" : "○"} ${todo.text ?? ""}`).join("；");
        output.write(`    Agent 计划${inlineDetail(todos)}\n`);
        this.lastTodoSnapshots.set(id, snapshot);
      }
      return;
    }
    if (item.type === "mcp_tool_call") {
      if (lifecycle === "started") {
        output.write(`    → 工具 ${item.server ?? "未知"}.${item.tool ?? "未知"}${inlineDetail(item.arguments)}\n`);
      } else if (lifecycle === "completed") {
        const detail = item.error?.message ?? item.result;
        output.write(`    ${item.status === "failed" ? "✗" : "✓"} 工具 ${item.server ?? "未知"}.${item.tool ?? "未知"}${item.status === "failed" ? " 失败" : " 完成"}${inlineDetail(detail)}\n`);
      }
      return;
    }
    if (item.type === "web_search") {
      output.write(`    Web 搜索（${lifecycle}）：${item.query ?? ""}\n`);
      return;
    }
    if (item.type === "error") {
      output.write(`    ✗ Agent 错误：${item.message ?? "未知错误"}\n`);
      return;
    }
    output.write(`    Agent 活动 ${item.type ?? "未知"}（${lifecycle}）\n`);
    writeIndented(output, item);
  }
}
