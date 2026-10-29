import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import type { RunEvent } from "../../src/capabilities/run/protocol.ts";
import type { InitEvent } from "../../src/capabilities/init/protocol.ts";
import { AgentActivityRenderer } from "../../src/tui/renderers/agent-renderer.ts";
import { InitEventRenderer, replayInitHistory } from "../../src/tui/renderers/init-renderer.ts";
import { RuntimeEventRenderer } from "../../src/tui/renderers/runtime-renderer.ts";

function sink(): { output: Writable; text(): string } {
  let value = "";
  return {
    output: new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } }),
    text: () => value,
  };
}

test("agent renderer keeps commands, output, files, and tools compact", () => {
  const target = sink();
  const renderer = new AgentActivityRenderer();
  const render = (sdkEvent: string, item: Record<string, unknown>) => renderer.render({
    data: { job: "explorer", sdkEvent, item },
  }, target.output);

  render("item.started", { id: "cmd-1", type: "command_execution", command: "find src", aggregated_output: "", status: "in_progress" });
  render("item.updated", { id: "cmd-1", type: "command_execution", command: "find src", aggregated_output: "src/a.ts\n", status: "in_progress" });
  render("item.completed", { id: "cmd-1", type: "command_execution", command: "find src", aggregated_output: "src/a.ts\nsrc/b.ts\n", exit_code: 0, status: "completed" });
  render("item.completed", { id: "file-1", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" });
  render("item.started", { id: "tool-1", type: "mcp_tool_call", server: "docs", tool: "search", arguments: { query: "Flywheel" }, status: "in_progress" });
  render("item.completed", { id: "tool-1", type: "mcp_tool_call", server: "docs", tool: "search", result: { count: 3 }, status: "completed" });

  const rendered = target.text();
  assert.match(rendered, /→ 命令 · find src/);
  assert.match(rendered, /· 输出 · src\/a\.ts/);
  assert.equal(rendered.match(/src\/a\.ts/g)?.length, 2);
  assert.match(rendered, /文件修改完成/);
  assert.match(rendered, /→ 工具 docs\.search · \{"query":"Flywheel"\}/);
  assert.match(rendered, /✓ 工具 docs\.search 完成 · \{"count":3\}/);
  assert.doesNotMatch(rendered, /参数：|结果：|命令：\n|输出：\n/);
});

test("agent renderer shows the complete Runtime-to-Agent message", () => {
  const target = sink();
  const renderer = new AgentActivityRenderer();
  renderer.render({ data: {
    job: "initialization manager",
    sdkEvent: "job.started",
    label: "initialization manager",
    prompt: "第一行：检查项目\n第二行：结合其他 Agent 的结论",
    promptAssets: [{ id: "init.explore.generate", source: "project", templateSha256: "1234567890abcdef" }],
    cwd: "/tmp/project",
    tools: ["Read", "Write"],
    readRoots: ["/tmp/project"],
    writeRoots: ["/tmp/project/.flywheel"],
    resumeSessionId: "session-1",
  } }, target.output);

  const rendered = target.text();
  assert.match(rendered, /Runtime → Agent · 初始化管理 Agent/);
  assert.match(rendered, /Prompt 资产：init\.explore\.generate@12345678 \(project\)/);
  assert.match(rendered, /第一行：检查项目\n      第二行：结合其他 Agent 的结论/);
  assert.match(rendered, /工作目录：\/tmp\/project/);
  assert.match(rendered, /可用工具：Read, Write/);
  assert.match(rendered, /续接 Agent 会话：session-1/);
});

test("init renderer replays completed steps and answers without Job activity", () => {
  const timestamp = new Date().toISOString();
  const base = { id: "e", sequence: 1, timestamp, scope: "init" as const, projectRoot: "/tmp/project", operation: "confirm_goal" };
  const events: InitEvent[] = [
    { ...base, type: "init.started", data: { plan: ["confirm_goal", "complete"] } },
    { ...base, id: "q", sequence: 2, type: "interaction.requested", data: {
      interactionId: "goal", question: "目标？", interaction: {
        id: "goal", capabilityId: "init", operationId: "confirm_goal",
        requestedBy: { type: "agent", label: "初始化管理 Agent", sessionKey: "manager" },
        kind: "text", question: "目标？",
      },
    } },
    { ...base, id: "a", sequence: 3, type: "interaction.resolved", data: { interactionId: "goal", value: "提高准确率" } },
    { ...base, id: "p", sequence: 4, type: "operation.completed", data: { operationId: "confirm_goal" } },
    { ...base, id: "m", sequence: 5, type: "job.event", data: { job: "explorer", sdkEvent: "item.completed", item: { type: "agent_message", text: "完成" } } },
  ];
  const target = sink();
  replayInitHistory(events, target.output);
  const rendered = target.text();
  assert.match(rendered, /继续已有的初始化/);
  assert.match(rendered, /✓ 讨论并确认目标/);
  assert.match(rendered, /初始化管理 Agent · 目标？/);
  assert.match(rendered, /目标？/);
  assert.match(rendered, /\u001b\[7m 你：提高准确率 \u001b\[27m/);
  assert.doesNotMatch(rendered, /历史 Agent 活动/);
  assert.doesNotMatch(rendered, /explorer/);
});

test("init renderer distinguishes a completed failed smoke test", () => {
  const target = sink();
  new InitEventRenderer().render({
    id: "smoke",
    sequence: 1,
    timestamp: new Date().toISOString(),
    scope: "init",
    projectRoot: "/tmp/project",
    operation: "validate_contract",
    type: "smoke_test.completed",
    data: { passed: false },
  }, target.output);
  assert.match(target.text(), /✗ 试运行未通过/);
  assert.doesNotMatch(target.text(), /试运行通过/);
});

test("manager replies are rendered as the Capability communication window", () => {
  const initTarget = sink();
  new InitEventRenderer().render({
    id: "manager",
    sequence: 1,
    timestamp: new Date().toISOString(),
    scope: "init",
    projectRoot: "/tmp/project",
    operation: "explore",
    type: "manager.responded",
    data: { action: "stay_paused", message: "初始化仍保持暂停。" },
  }, initTarget.output);
  assert.match(initTarget.text(), /初始化管理 Agent · 初始化仍保持暂停/);

  const runTarget = sink();
  new RuntimeEventRenderer().render({
    id: "manager",
    timestamp: new Date().toISOString(),
    type: "manager.responded",
    version: "v1",
    operation: "evaluate",
    status: "paused",
    data: { action: "resume", message: "将由 Runtime 尝试恢复。" },
  }, runTarget.output);
  assert.match(runTarget.text(), /运行管理 Agent · 将由 Runtime 尝试恢复/);
});

test("runtime renderer streams operations and job activity", () => {
  const target = sink();
  const renderer = new RuntimeEventRenderer();
  const event = (type: RunEvent["type"], data?: Record<string, unknown>): RunEvent => ({
    id: type, timestamp: new Date().toISOString(), type, version: "v1", operation: "tasking", status: "running", data,
  });
  renderer.render(event("operation.started"), target.output);
  renderer.render(event("job.started", { job: "tasking:s1" }), target.output);
  renderer.render(event("operation.completed"), target.output);
  const rendered = target.text();
  assert.match(rendered, /→ v1 · 生成样本输出/);
  assert.match(rendered, /→ 样本执行 s1/);
  assert.match(rendered, /✓ 生成样本输出完成/);
});

test("runtime completion distinguishes the evaluated version from its promoted version", () => {
  const target = sink();
  new RuntimeEventRenderer().render({
    id: "complete", timestamp: new Date().toISOString(), type: "runtime.completed", version: "v2",
    operation: "select", status: "completed", data: { finalVersion: "v3" },
  }, target.output);

  assert.match(target.text(), /已达到目标 · 评测 v2 · 晋升版本 v3/);
});
