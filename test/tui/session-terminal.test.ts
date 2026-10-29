import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import type { RunEvent } from "../../src/capabilities/run/protocol.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import type { Capability, CapabilityRequest, CapabilityStore } from "../../src/session/protocol.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../src/session/policy.ts";
import type { CapabilityExecutionState, CapabilityState } from "../../src/session/protocol.ts";
import type { Interaction, InteractionResponseCommand } from "../../src/session/protocol.ts";
import { runSessionTerminal } from "../../src/tui/session-terminal.ts";
import { FakeTerminal } from "../helpers/fake-terminal.ts";
import { ExecutionBudgetExhausted } from "../../src/session/execution-budget.ts";

interface TestState extends CapabilityState { execution: CapabilityExecutionState }

class MemoryStore implements CapabilityStore<TestState> {
  state?: TestState;
  readonly events: unknown[];
  readonly listeners = new Set<(event: unknown) => void>();
  constructor(events: unknown[] = []) { this.events = events; }
  async load(): Promise<TestState> {
    if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.state;
  }
  async save(state: TestState): Promise<void> { this.state = state; }
  async emit(_state: TestState, type: string, data?: Record<string, unknown>): Promise<void> {
    const event = { type, data }; this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  async history(): Promise<unknown[]> { return this.events; }
}

class QuestionCapability implements Capability<{}, TestState, InteractionResponseCommand> {
  readonly id = "question";
  readonly grants: string[] = [];
  readonly store = new MemoryStore();
  answer?: string | boolean;
  protected command?: InteractionResponseCommand;
  protected get operationId(): string { return "ask"; }
  readonly manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state }: { state: TestState; message: string }) => {
      state.status = "paused" as const;
      return state;
    },
  };

  protected question(): Interaction {
    return {
      id: "goal", capabilityId: this.id, operationId: "ask",
      requestedBy: { type: "agent", label: "目标访谈 Agent", sessionKey: "interviewer" },
      kind: "text", question: "目标是什么？",
    };
  }
  readonly policySource = async (): Promise<ExecutionPolicy<{}, TestState, InteractionResponseCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: `${this.id}-policy`, revision: "1",
    operations: { [this.operationId]: async ({ signal }) => await this.execute(signal) },
    decide: ({ lastOutcome }) => lastOutcome?.status === "completed"
      ? { type: "complete" } : { type: "run", operationId: this.operationId },
  });
  async createState(): Promise<TestState> {
    return { status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } };
  }
  async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    state.status = "running";
    if (request.type === "command") {
      this.command = request.command as InteractionResponseCommand;
      const value = this.command.value;
      if (typeof value !== "string" && typeof value !== "boolean") throw new Error("Invalid interaction value");
      this.answer = value;
    }
    return state;
  }
  services(): {} { return {}; }
  protected async execute(_signal: AbortSignal): Promise<PolicyOutcome<Record<string, unknown>>> {
    return this.command ? { status: "completed" } : { status: "waiting_for_user", interaction: this.question() };
  }
}

class ConfirmCapability extends QuestionCapability {
  override readonly id = "confirm";
  protected override get operationId(): string { return "approve"; }
  protected override question(): Interaction {
    return {
        id: "confirm", capabilityId: "confirm", operationId: "approve", requestedBy: { type: "runtime" },
        conversationWith: { label: "方案解释 Agent", sessionKey: "reviewer" },
        kind: "confirm", question: "是否确认当前方案？", defaultValue: false,
    };
  }
}

class HistoricalRunCapability extends QuestionCapability {
  readonly id = "run";
  override readonly store = new MemoryStore(this.historicalEvents());
  private historicalEvents(): RunEvent[] {
    const base = { timestamp: "2026-08-07T00:00:00.000Z", version: "v1", operation: "tasking" as const, status: "running" as const };
    return [
      { ...base, id: "job-started", type: "job.started", data: { job: "tasking:historical-sample" } },
      { ...base, id: "job-event", type: "job.event", data: { job: "tasking:historical-sample", sdkEvent: "item.completed", item: { type: "agent_message", text: "历史 Agent 消息" } } },
      { ...base, id: "job-completed", type: "job.completed", data: { job: "tasking:historical-sample", status: "failed" } },
      { ...base, id: "blocked", type: "runtime.blocked", status: "blocked", data: { error: "历史阻断" } },
    ];
  }
  protected override async execute(): Promise<PolicyOutcome<Record<string, unknown>>> {
    return { status: "blocked", error: "历史阻断" };
  }
}

class BlockedCapability extends QuestionCapability {
  readonly id = "blocked";
  interventions: string[] = [];
  resumes = 0;
  private first = true;
  override readonly manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: TestState; message: string }) => {
      this.interventions.push(message);
      state.status = "running" as const;
      delete state.lastError;
      return state;
    },
  };
  protected override async execute(): Promise<PolicyOutcome<Record<string, unknown>>> {
    if (this.first) { this.first = false; return { status: "blocked", error: "需要调整" }; }
    this.resumes += 1;
    return { status: "completed" };
  }
}

class DelayedReblockingCapability extends QuestionCapability {
  override readonly id = "delayed-reblocking";
  executions = 0;
  resumes = 0;
  override readonly manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state }: { state: TestState; message: string }) => {
      state.status = "running" as const;
      delete state.lastError;
      return state;
    },
  };
  override async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    if (request.type === "resume") this.resumes += 1;
    return await super.prepare(state, request);
  }
  protected override async execute(): Promise<PolicyOutcome<Record<string, unknown>>> {
    this.executions += 1;
    if (this.executions === 2) await new Promise((resolve) => setTimeout(resolve, 20));
    return this.executions < 3
      ? { status: "blocked", error: "仍需处理" }
      : { status: "completed" };
  }
}

class StartupFailureCapability extends QuestionCapability {
  override readonly id = "startup-failure";
  override async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    if (request.type === "start") throw new Error("当前 Init 状态是旧 schema 1，请重新初始化");
    return await super.prepare(state, request);
  }
}

class SlowQuestionCapability extends QuestionCapability {
  override readonly id = "slow-question";
  private commandPending = false;
  override async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    if (request.type === "command") this.commandPending = true;
    return await super.prepare(state, request);
  }
  protected override async execute(signal: AbortSignal): Promise<PolicyOutcome<Record<string, unknown>>> {
    if (!this.commandPending) return await super.execute(signal);
    return await new Promise((resolve) => {
      if (signal.aborted) resolve({ status: "paused" });
      else signal.addEventListener("abort", () => resolve({ status: "paused" }), { once: true });
    });
  }
}

class MisdirectedCapability extends QuestionCapability {
  override readonly id = "actual";
  protected override question(): Interaction {
    return {
      id: "wrong", capabilityId: "other", operationId: "ask", requestedBy: { type: "runtime" },
      kind: "text", question: "This must not be routed",
    };
  }
}

test("session rejects an interaction attributed to another Capability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-misdirected-interaction-"));
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register("actual", () => new MisdirectedCapability()),
    ["actual"],
  );

  const snapshot = await session.dispatch({ type: "session.start" });
  assert.equal(session.snapshot().status, "idle");
  assert.equal(snapshot.activeCapabilityStatus, "blocked");
  assert.match(snapshot.error ?? "", /belongs to other/);
});

test("unified terminal consumes capability interactions and completes the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-tui-"));
  const capability = new QuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("question", () => capability), ["question"]);
  const input = new PassThrough();
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } });
  session.subscribe((event) => {
    if (event.type === "interaction.requested") input.write("提高准确率\n");
    if (event.type === "capability.completed") setTimeout(() => input.write("/stop\n"), 0);
  });

  const snapshot = await runSessionTerminal(session, { input, output });

  assert.equal(snapshot.status, "stopped");
  assert.equal(capability.answer, "提高准确率");
  assert.match(rendered, /Flywheel · 输入需求开始对话/);
  assert.match(rendered, /Flywheel · 等待你的回复/);
  assert.match(rendered, /目标是什么？/);
  const requested = (await session.history()).find((event) => event.type === "interaction.requested");
  assert.deepEqual(requested?.data?.interaction, {
    id: "goal", capabilityId: "question", operationId: "ask",
    requestedBy: { type: "agent", label: "目标访谈 Agent", sessionKey: "interviewer" },
    kind: "text", question: "目标是什么？",
  });
});

test("a natural-language blocked intervention retries without a separate resume command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-blocked-tui-"));
  const capability = new BlockedCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("blocked", () => capability), ["blocked"]);
  const input = new PassThrough();
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } });
  session.subscribe((event) => {
    if (event.type === "interaction.requested") input.write("按第一轮基线继续优化\n");
    if (event.type === "capability.completed") setTimeout(() => input.write("/stop\n"), 0);
  });

  const snapshot = await runSessionTerminal(session, { input, output });

  assert.equal(snapshot.status, "stopped");
  assert.deepEqual(capability.interventions, ["按第一轮基线继续优化"]);
  assert.equal(capability.resumes, 1);
  assert.match(rendered, /请说明处理意见，或在修复后回复“重试”/);
});

test("a resume submitted during active recovery is rejected instead of replayed after a later block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-stale-resume-tui-"));
  const capability = new DelayedReblockingCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  const input = new PassThrough();
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } });
  let blocked = 0;
  session.subscribe((event) => {
    if (event.type !== "interaction.requested") return;
    blocked += 1;
    if (blocked === 1) {
      input.write("按当前契约重试\n");
      input.write("/resume\n");
    } else setTimeout(() => input.write("/stop\n"), 20);
  });

  const snapshot = await runSessionTerminal(session, { input, output });

  assert.equal(snapshot.status, "stopped");
  assert.equal(capability.executions, 2);
  assert.equal(capability.resumes, 0);
  assert.match(rendered, /Session is not idle/);
  assert.equal((await session.history()).some((event) => event.type === "capability.resumed"), false);
});

test("abort bypasses a long-running interaction queue", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-abort-tui-"));
  const capability = new SlowQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register("slow-question", () => capability),
    ["slow-question"],
  );
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  session.subscribe((event) => {
    if (event.type === "interaction.requested") input.write("开始长任务\n");
    if (event.type === "capability.started" && event.data?.mode === "dispatch") {
      setTimeout(() => input.write("/abort\n"), 5);
    }
    if (event.type === "capability.idle" && event.data?.reason === "aborted") input.write("/stop\n");
  });

  const snapshot = await runSessionTerminal(session, { input, output });

  assert.equal(snapshot.status, "stopped");
  assert.ok((await session.history()).some((event) => event.type === "capability.aborting"));
});

test("Escape aborts the active capability without closing the TUI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-escape-abort-tui-"));
  const capability = new SlowQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register("slow-question", () => capability),
    ["slow-question"],
  );
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => { input.isRaw = mode; };
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as Writable & {
    isTTY: boolean; columns: number; rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  session.subscribe((event) => {
    if (event.type === "interaction.requested") input.write("开始长任务\r");
    if (event.type === "capability.started" && event.data?.mode === "dispatch") {
      setTimeout(() => input.write("\u001b"), 5);
    }
    if (event.type === "capability.idle" && event.data?.reason === "aborted") input.write("/stop\r");
  });

  const snapshot = await runSessionTerminal(session, { input, output, terminal: new FakeTerminal(input, output) });

  assert.equal(snapshot.status, "stopped");
  assert.ok((await session.history()).some((event) => event.type === "capability.aborting"));
  assert.equal(input.isRaw, false);
});

test("TTY mode accepts raw input and restores the alternate screen", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-full-screen-tui-"));
  const capability = new QuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("question", () => capability), ["question"]);
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => { input.isRaw = mode; };
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }) as Writable & {
    isTTY: boolean; columns: number; rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  session.subscribe((event) => {
    if (event.type === "interaction.requested") input.write("提高准确率\r");
    if (event.type === "capability.completed") setTimeout(() => input.write("/stop\r"), 0);
  });

  const snapshot = await runSessionTerminal(session, { input, output, terminal: new FakeTerminal(input, output) });

  assert.equal(snapshot.status, "stopped");
  assert.equal(capability.answer, "提高准确率");
  assert.equal(input.isRaw, false);
  assert.match(rendered, /\u001b\[\?1049h/);
  assert.match(rendered, /\u001b\[\?1049l/);
  assert.match(rendered, /工作步骤/);
  assert.match(rendered, /Agent Jobs/);
  assert.match(rendered, /工作详情/);
  assert.match(rendered, /\u001b\[7m/);
  assert.match(rendered, /你：提高准确率/);
});

test("TTY keeps a capability startup error visible instead of flashing closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-startup-failure-tui-"));
  const capability = new StartupFailureCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => { input.isRaw = mode; };
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }) as Writable & {
    isTTY: boolean; columns: number; rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  session.subscribe((event) => {
    if (event.type === "capability.blocked") setTimeout(() => input.write("/stop\r"), 20);
  });

  const snapshot = await runSessionTerminal(session, { input, output, terminal: new FakeTerminal(input, output) });

  assert.equal(snapshot.status, "stopped");
  assert.equal(snapshot.activeCapabilityStatus, "blocked");
  assert.match(rendered, /当前 Init 状态是旧 schema 1，请重新初始化/);
  assert.match(rendered, /请说明处理意见，或在修复后回复“重试”/);
  assert.match(rendered, /不会绕过合约、评/);
  assert.match(rendered, /估器或工作区安全检查/);
  assert.match(rendered, /\u001b\[\?1049l/);
});

test("TTY confirm explains and applies the empty Enter default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-confirm-tui-"));
  const capability = new ConfirmCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("confirm", () => capability), ["confirm"]);
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => { input.isRaw = mode; };
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }) as Writable & {
    isTTY: boolean; columns: number; rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 30;
  session.subscribe((event) => {
    if (event.type === "interaction.requested") input.write("\r");
    if (event.type === "capability.completed") setTimeout(() => input.write("/stop\r"), 0);
  });

  const snapshot = await runSessionTerminal(session, { input, output, terminal: new FakeTerminal(input, output) });

  assert.equal(snapshot.status, "stopped");
  assert.equal(capability.answer, false);
  assert.match(rendered, /系统 · 请确认或直接补充你的想法/);
  assert.match(rendered, /系统 · 是否确认当前方案？/);
  assert.match(rendered, /系统 · 输入“确认\/是\/y”批准；输入“否\/n”不批准。直接回车：不确认。/);
  assert.match(rendered, /你：不确认（默认）/);
});

test("TTY mode rebuilds run agent activity from persisted history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-run-history-tui-"));
  const capability = new HistoricalRunCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("run", () => capability), ["run"]);
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => { input.isRaw = mode; };
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }) as Writable & {
    isTTY: boolean; columns: number; rows: number;
  };
  output.isTTY = true;
  output.columns = 100;
  output.rows = 32;
  session.subscribe((event) => {
    if (event.type === "capability.blocked") setTimeout(() => input.write("/stop\r"), 30);
  });

  const snapshot = await runSessionTerminal(session, { input, output, terminal: new FakeTerminal(input, output) });

  assert.equal(snapshot.status, "stopped");
  assert.match(rendered, /tasking:historical-sample/);
  assert.match(rendered, /历史 Agent 消息/);
});

test("live compact results and budget pauses remain visible in both terminal modes", async () => {
  class CompactStore extends MemoryStore {
    private version = "v1";
    override async emit(_state: TestState, type: string, data?: Record<string, unknown>): Promise<void> {
      if (data?.retained === true) this.version = "v2";
      const event = { id: `compact-${this.events.length}`, timestamp: new Date().toISOString(),
        version: this.version, operation: "retain", type, data };
      this.events.push(event);
      for (const listener of this.listeners) listener(event);
    }
  }
  class CompactCapability extends QuestionCapability {
    override readonly id = "run";
    override readonly store = new CompactStore();
    protected override async execute(): Promise<PolicyOutcome<Record<string, unknown>>> {
      await this.store.emit(this.store.state!, "operation.activity", { attempt: "attempt-1", retained: false });
      await this.store.emit(this.store.state!, "operation.activity", { attempt: "attempt-2", retained: true, target: "achieved" });
      throw new ExecutionBudgetExhausted("time");
    }
  }
  for (const fullScreen of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-compact-events-tui-"));
    const capability = new CompactCapability();
    const session = new FlywheelSession(root, new CapabilityRegistry().register("run", () => capability), ["run"]);
    const input = Object.assign(new PassThrough(), { isTTY: fullScreen, isRaw: false,
      setRawMode(mode: boolean) { this.isRaw = mode; } });
    let rendered = "";
    const output = Object.assign(new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } }),
      { isTTY: fullScreen, columns: 160, rows: 40 });
    session.subscribe(event => {
      if (event.type === "capability.idle" && event.data?.reason === "paused") {
        setTimeout(() => input.write(fullScreen ? "/stop\r" : "/stop\n"), 30);
      }
    });
    const result = await runSessionTerminal(session, { input, output,
      ...(fullScreen ? { terminal: new FakeTerminal(input, output) } : {}) });
    assert.equal(result.status, "stopped");
    assert.equal(result.activeCapabilityStatus, "paused");
    assert.match(rendered, /候选未保留，继续使用当前版本/);
    assert.match(rendered, /候选已保留为正式版本 v2，目标已达成/);
    assert.match(rendered, /活跃执行时间预算已用完，进度已保留/);
    const history = await session.history();
    assert.equal(history.filter(event => event.type === "capability.event"
      && (event.data?.event as { type?: string })?.type === "runtime.budget.exhausted").length, 1);
  }
});
