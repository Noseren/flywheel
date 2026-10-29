import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createInterface } from "node:readline";

import { runSessionGui, startSessionGuiServer } from "../../src/gui/server.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import type {
  Capability,
  CapabilityExecutionState,
  CapabilityRequest,
  CapabilityState,
  CapabilityStore,
  InteractionResponseCommand,
} from "../../src/session/protocol.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../src/session/policy.ts";

interface FixtureState extends CapabilityState { execution: CapabilityExecutionState }

class FixtureStore implements CapabilityStore<FixtureState> {
  state?: FixtureState;
  readonly events: unknown[] = [];
  readonly listeners = new Set<(event: unknown) => void>();
  async load(): Promise<FixtureState> {
    if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.state;
  }
  async save(state: FixtureState): Promise<void> { this.state = state; }
  async emit(_state: FixtureState, type: string, data?: Record<string, unknown>): Promise<void> {
    const event = {
      id: `fixture-${this.events.length + 1}`,
      timestamp: new Date().toISOString(),
      type,
      version: "fixture",
      operation: "evaluate",
      status: type === "runtime.blocked" ? "blocked" : "running",
      data,
    };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async history(): Promise<unknown[]> { return this.events; }
}

class GuiFixtureCapability implements Capability<{}, FixtureState, InteractionResponseCommand> {
  readonly id = "run";
  readonly grants: string[] = [];
  readonly store = new FixtureStore();
  private responses = 0;
  private emitted = false;
  private burstEmitted = false;
  private readonly burstMode: boolean;
  constructor(burstMode = false) { this.burstMode = burstMode; }
  readonly policySource = async (): Promise<ExecutionPolicy<{}, FixtureState, InteractionResponseCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: "gui-visual-fixture", revision: "1",
    operations: { evaluate: async () => await this.evaluate() },
    decide: ({ lastOutcome }) => lastOutcome?.status === "completed"
      ? { type: "complete" }
      : { type: "run", operationId: "evaluate" },
  });
  async createState(): Promise<FixtureState> {
    return { status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } };
  }
  async prepare(state: FixtureState, request: CapabilityRequest): Promise<FixtureState> {
    state.status = "running";
    if (request.type === "command") this.responses += 1;
    return state;
  }
  services(): {} { return {}; }
  manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: FixtureState; message: string }) => {
      if (process.argv.includes("--responsive")) {
        const jobId = randomUUID(), invocationId = randomUUID(), startedAt = new Date().toISOString();
        const identity = { job: "run:manager", jobId, invocationId, provider: "fixture", model: "delayed-fixture", startedAt };
        await this.store.emit(state, "job.started", { ...identity, sessionKey: "manager" });
        await this.store.emit(state, "job.event", { ...identity, sdkEvent: "invocation.started" });
        for (const text of ["已收到你的需求。", "已收到你的需求。正在后台准备简要的目标和评价确认。你可以继续补充，不需要等准备结束。"]) {
          await new Promise(resolve => setTimeout(resolve, 1800));
          await this.store.emit(state, "job.event", { ...identity, sdkEvent: "item.updated", seq: text.length,
            item: { id: jobId + ":message", type: "agent_message", text } });
        }
        await new Promise(resolve => setTimeout(resolve, 1200));
        await this.store.emit(state, "job.event", { ...identity, sdkEvent: "invocation.completed", status: "completed", endedAt: new Date().toISOString(),
          usage: { inputTokens: 1200, cachedInputTokens: 400, outputTokens: 80, reasoningOutputTokens: 0 } });
        await this.store.emit(state, "job.completed", { ...identity, status: "completed" });
      }
      state.status = "paused";
      state.pendingInteraction = undefined;
      await this.store.emit(state, "manager.responded", { action: "stay_paused", message: `模拟助手已收到：${message}` });
      return state;
    },
  };
  private async evaluate(): Promise<PolicyOutcome<Record<string, unknown>>> {
    if (!this.emitted) {
      this.emitted = true;
      const job = "candidate evaluation with a deliberately long Agent Job label that must wrap without truncation";
      await this.store.emit(this.store.state!, "job.started", {
        job, jobId: "candidate/evaluate", prompt: "Inspect the complete candidate evidence and report every relevant observation without truncating the Agent context.",
        cwd: "C:/workspace/candidate", tools: ["Read", "Search", "Process"], readRoots: ["C:/workspace"], writeRoots: ["C:/workspace/.flywheel/outputs"],
      });
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/evaluate", sdkEvent: "item.completed",
        item: { id: "message-1", type: "agent_message", text: "评价证据已经完成采集。文本回复保持直接显示，其余命令、工具、推理和生命周期事件可以按需展开。" },
      });
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/evaluate", sdkEvent: "item.completed",
        item: { id: "command-1", type: "command_execution", command: "python -m pytest tests/test_candidate.py -q", status: "completed", exit_code: 0, aggregated_output: "12 passed in 0.84s" },
      });
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/evaluate", sdkEvent: "item.completed",
        item: { id: "tool-1", type: "mcp_tool_call", server: "workspace", tool: "read_evidence", status: "completed", result: { files: 7, complete: true } },
      });
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/evaluate", sdkEvent: "item.completed",
        item: { id: "reasoning-1", type: "reasoning", text: "先验证边界条件，再检查恢复路径。" },
      });
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/evaluate", sdkEvent: "item.completed",
        item: { id: "file-1", type: "file_change", changes: [{ path: "src/evaluator.ts", kind: "update" }] },
      });
      const childJob = "child verifier for failure recovery";
      await this.store.emit(this.store.state!, "job.started", {
        job: childJob, jobId: "candidate/evaluate/child-verifier", parentJobId: "candidate/evaluate",
        prompt: "Reproduce the failing boundary check and preserve its complete output.",
        cwd: "C:/workspace/candidate", tools: ["Read", "Process"],
        readRoots: ["C:/workspace"], writeRoots: ["C:/workspace/.flywheel/outputs"],
      });
      await this.store.emit(this.store.state!, "job.event", {
        job: childJob, jobId: "candidate/evaluate/child-verifier", parentJobId: "candidate/evaluate",
        sdkEvent: "item.completed",
        item: {
          id: "child-command-failed", type: "command_execution",
          command: "python -m pytest tests/test_boundary.py::test_recovery -q",
          status: "failed", exit_code: 1,
          aggregated_output: "FAILED tests/test_boundary.py::test_recovery\nAssertionError: expected recovered state, received stale state\n1 failed in 0.31s",
        },
      });
      await this.store.emit(this.store.state!, "job.completed", {
        job: childJob, jobId: "candidate/evaluate/child-verifier", parentJobId: "candidate/evaluate",
        status: "failed", error: "Boundary recovery assertion failed",
      });
      await this.store.emit(this.store.state!, "job.completed", { job, jobId: "candidate/evaluate", status: "completed" });
    }
    if (this.burstMode && this.responses > 0 && !this.burstEmitted) {
      this.burstEmitted = true;
      if (process.argv.includes("--node-burst")) {
        for (let index = 0; index < 1000; index++) {
          await this.store.emit(this.store.state!, "job.started", { job: `live Agent ${index}`, jobId: `live-${index}` });
          await this.store.emit(this.store.state!, "job.completed", { job: `live Agent ${index}`, jobId: `live-${index}`, status: "completed" });
        }
      }
      const job = "streaming command evaluator";
      const itemBase = { id: "burst-command", type: "command_execution", command: "python -m pytest -q", status: "in_progress" };
      await this.store.emit(this.store.state!, "job.started", { job, jobId: "candidate/burst" });
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/burst", sdkEvent: "item.started", item: { ...itemBase, aggregated_output: "" },
      });
      for (let index = 1; index <= 120; index += 1) {
        if (process.argv.includes("--slow")) await new Promise((resolve) => setTimeout(resolve, 100));
        await this.store.emit(this.store.state!, "job.event", {
          job, jobId: "candidate/burst", sdkEvent: "item.updated",
          item: { ...itemBase, aggregated_output: `progress ${index}/120` },
        });
      }
      await this.store.emit(this.store.state!, "job.event", {
        job, jobId: "candidate/burst", sdkEvent: "item.completed",
        item: { ...itemBase, status: "completed", exit_code: 0, aggregated_output: "120 updates merged\n1 passed" },
      });
      await this.store.emit(this.store.state!, "job.completed", { job, jobId: "candidate/burst", status: "completed" });
    }
    if (this.burstMode && this.burstEmitted && this.responses < 2) {
      return {
        status: "waiting_for_user",
        interaction: {
          id: "burst-complete", capabilityId: this.id, operationId: "evaluate",
          requestedBy: { type: "agent", label: "Run Manager", sessionKey: "manager" },
          kind: "confirm", question: "流式命令已经完成，是否结束 fixture？", description: "GUI 应只显示一个完成态 command 卡片。",
        },
      };
    }
    return this.responses > 0
      ? { status: "completed" }
      : {
          status: "waiting_for_user",
          interaction: {
            id: "continue", capabilityId: this.id, operationId: "evaluate",
            requestedBy: { type: "agent", label: "Run Manager", sessionKey: "manager" },
            kind: "confirm", question: "是否继续下一轮候选优化？", description: "确认与推进仍由 Runtime 校验。",
          },
        };
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-visual-"));
const capability = new GuiFixtureCapability(process.argv.includes("--burst"));
if (process.argv.includes("--nodes")) {
  for (let index = 0; index < 1000; index++) {
    await capability.store.emit({} as FixtureState, "job.started", { job: `navigation Agent ${index}`, jobId: `navigation-${index}` });
    await capability.store.emit({} as FixtureState, "job.completed", { job: `navigation Agent ${index}`, jobId: `navigation-${index}`, status: "completed" });
  }
}
if (process.argv.includes("--stages")) {
  await capability.store.emit({} as FixtureState, "artifact.validation.failed", {
    artifactId: "fixture-evaluator", issues: [{ message: "模拟退回原因：公开边界检查缺少预期结果。" }],
  });
  await capability.store.emit({} as FixtureState, "artifact.repair.started", { artifactId: "fixture-evaluator", attempt: 1 });
  await capability.store.emit({} as FixtureState, "init.evaluator.repair.requested", { source: "independent-review", invalidChecks: 2, attempt: 1 });
}
if (process.argv.includes("--history")) {
  for (let index = 0; index < 1000; index += 1) await capability.store.emit({} as FixtureState, "job.event", {
    job: "history fixture", jobId: "history-fixture", sdkEvent: "item.completed",
    item: { id: `history-${index}`, type: "command_execution", command: `history-check ${index}`, status: "completed", exit_code: 0,
      aggregated_output: index === 999 ? "完整长日志\n".repeat(10_000) : `fixture record ${index}` },
  });
}
if (process.argv.includes("--results")) {
  const report = path.join(root, ".flywheel", "runs", "v1", "target-assessment", "report.md");
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(path.join(root, ".flywheel", "goal.md"), "模拟验收项目：验证 GUI 能区分正式事件和 Agent 自述。\n");
  await writeFile(report, "# 模拟目标判定报告\n仅用于 GUI 展示验收，不是真实模型评价。\n结论：现有证据不足。\n");
  await capability.store.emit({} as FixtureState, "operation.completed", {
    operationId: "assess_target", status: "paused", result: { assessment: "inconclusive", reportPath: report },
  });
}
const session = new FlywheelSession(root, new CapabilityRegistry().register("run", () => capability), ["run"]);
if (process.argv.includes("--connection-cycle")) {
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const upstream = new URL(gui.url);
  let online = false;
  let posts = 0;
  const streams = new Set<import("node:http").ServerResponse>();
  const proxy = createServer((request, response) => {
    if (request.method === "POST") posts++;
    if (!online && request.url?.startsWith("/api/")) {
      request.resume(); response.writeHead(503); response.end("fixture temporarily offline"); return;
    }
    if (request.url?.startsWith("/api/stream")) streams.add(response);
    const forwarded = httpRequest(new URL(request.url || "/", upstream), { method: request.method, headers: request.headers }, result => {
      response.writeHead(result.statusCode || 502, result.headers); result.pipe(response);
    });
    forwarded.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on("close", () => { streams.delete(response); forwarded.destroy(); });
    request.pipe(forwarded);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  console.log(`Flywheel connection fixture: http://127.0.0.1:${address.port}/${upstream.search}`);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    if (!["online", "offline"].includes(line.trim())) return;
    online = line.trim() === "online";
    if (!online) for (const stream of streams) stream.destroy();
    console.log(JSON.stringify({ online, posts, snapshot: session.snapshot() }));
  });
  try { await session.dispatch({ type: "session.start" }); await gui.waitUntilSessionStops(); }
  finally {
    await new Promise(resolve => setTimeout(resolve, 200));
    lines.close(); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await gui.close();
    console.log(JSON.stringify({ posts, userInputs: (await session.history()).filter(event => ["interaction.responded", "intervention.submitted"].includes(event.type)).length }));
  }
} else if (process.argv.includes("--submit-failure")) {
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const upstream = new URL(gui.url);
  let rejected = false;
  let forwardedPosts = 0;
  const proxy = createServer((request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/api/command") && !rejected) {
      rejected = true;
      request.resume();
      setTimeout(() => {
        response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "模拟提交失败：运行服务尚未接收这条消息。请保留原文并重试。" }));
      }, 2000);
      return;
    }
    if (request.method === "POST") forwardedPosts += 1;
    const forwarded = httpRequest(new URL(request.url || "/", upstream), { method: request.method, headers: request.headers }, (result) => {
      response.writeHead(result.statusCode || 502, result.headers);
      result.pipe(response);
    });
    forwarded.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.on("close", () => forwarded.destroy());
    request.pipe(forwarded);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing proxy address");
  console.log(`Flywheel failure fixture: http://127.0.0.1:${address.port}/${upstream.search}`);
  try { await session.dispatch({ type: "session.start" }); await gui.waitUntilSessionStops(); }
  finally {
    // Allow the proxied stop acknowledgement to reach the browser before shutdown.
    await new Promise((resolve) => setTimeout(resolve, 200));
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await gui.close();
    console.log(JSON.stringify({ rejectedBeforeDelivery: rejected, forwardedPosts, userInputs: (await session.history()).filter((event) => ["interaction.responded", "intervention.submitted"].includes(event.type)).length }));
  }
} else if (process.argv.includes("--snapshot-question")) {
  const restored = await capability.createState();
  restored.status = "paused";
  restored.pendingInteraction = { id: "snapshot-only", capabilityId: "run", operationId: "evaluate", kind: "text",
    requestedBy: { type: "runtime" }, question: "恢复后仍需你确认：是否保留原始验收要求？",
    description: "这条问题只存在于当前状态，没有对应历史事件。完整说明不得被省略，也不能伪造发生时间。" };
  capability.store.events.length = 0;
  await capability.store.save(restored);
  await mkdir(path.join(root, ".flywheel", "runtime"), { recursive: true });
  await writeFile(path.join(root, ".flywheel", "runtime", "session.json"), JSON.stringify({ schemaVersion: 1, sessionId: randomUUID(), capabilities: ["run"] }));
  await session.restorePaused();
  const gui = await startSessionGuiServer(session, { port: 0 });
  try { await gui.waitUntilSessionStops(); } finally { await gui.close(); }
} else if (process.argv.includes("--observe")) {
  const observer = await startSessionGuiServer(session, { port: 0, readOnly: true });
  process.once("SIGINT", () => { void session.dispatch({ type: "session.stop" }); });
  try {
    await session.dispatch({ type: "session.start" });
    await observer.waitUntilSessionStops();
  } finally {
    await observer.close();
  }
} else {
  await runSessionGui(session, { port: 0 });
}
