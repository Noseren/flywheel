import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import type { Capability, CapabilityState, CapabilityStore } from "../../src/session/protocol.ts";
import { buildUsageLedger } from "../../src/session/usage-ledger.ts";
import { runSessionTerminal } from "../../src/tui/session-terminal.ts";
import { DefaultAgentService } from "../../src/services/agent/service.ts";
import { executePersistentAgentJob } from "../../src/services/agent/session.ts";
import { PromptAssetStore, promptAsset } from "../../src/services/prompt/index.ts";

type Receiver = NonNullable<Capability["conversation"]>["receive"];
class MemoryStore implements CapabilityStore<CapabilityState> {
  state?: CapabilityState;
  listeners = new Set<(event: unknown) => void>();
  async load() { if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return this.state; }
  async save(state: CapabilityState) { this.state = state; }
  async emit(_state: CapabilityState, type: string, data?: Record<string, unknown>) {
    const event = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), operation: "conversation", type, data };
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: unknown) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async history() { return []; }
}
function capability(receive: Receiver): Capability {
  return { id: "intake", grants: [], store: new MemoryStore(),
    createState: async () => ({ status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } }),
    services: () => ({}),
    policySource: async () => ({ id: "conversation-test", revision: "1", operations: { ready: async () => ({ status: "paused" as const }) },
      decide: () => ({ type: "run" as const, operationId: "ready" }) }),
    conversation: { canAccept: () => true, receive, apply: async () => {} },
  };
}
function gate() { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; }
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the live terminal state");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
async function harness(receive: Receiver) {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-responsive-tui-"));
  const session = new FlywheelSession(root, new CapabilityRegistry().register("intake", () => capability(receive)), ["intake"]);
  const input = new PassThrough();
  let rendered = "";
  const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } });
  const completed = runSessionTerminal(session, { input, output });
  await until(() => session.snapshot().status === "idle" && session.snapshot().activeCapabilityStatus === "paused");
  return { session, input, completed, text: () => rendered,
    close: async () => { await session.dispatch({ type: "session.stop" }); await completed; input.end(); },
  };
}

test("live TUI renders two genuine cumulative reply updates before job completion without duplicating final text", { timeout: 7000 }, async () => {
  const second = gate();
  const finish = gate();
  let jobCompleted = false;
  const h = await harness(async ({ onEvent }) => {
    const base = { job: "intake-reply", jobId: "reply-job", audience: "user" };
    await onEvent?.("job.started", base);
    await onEvent?.("job.event", { ...base, sdkEvent: "item.updated", seq: 1, streamMode: "cumulative", item: { id: "reply-item", type: "agent_message", text: "FIRST_CHUNK" } });
    await second.promise;
    await onEvent?.("job.event", { ...base, sdkEvent: "item.updated", seq: 2, streamMode: "cumulative", item: { id: "reply-item", type: "agent_message", text: "FIRST_CHUNK SECOND_CHUNK" } });
    await finish.promise;
    await onEvent?.("job.event", { ...base, sdkEvent: "item.completed", seq: 3, item: { id: "reply-item", type: "agent_message", text: "FIRST_CHUNK SECOND_CHUNK" } });
    await onEvent?.("job.completed", { ...base, status: "completed" });
    jobCompleted = true;
    return { message: "" };
  });
  try {
    h.input.write("请解释目标\n");
    await until(() => h.text().includes("FIRST_CHUNK"));
    assert.equal(jobCompleted, false);
    assert.match(h.text(), /你：请解释目标/);
    assert.match(h.text(), /已发送/);
    second.open();
    await until(() => h.text().includes("SECOND_CHUNK"));
    assert.equal(jobCompleted, false);
    assert.equal(h.text().split("FIRST_CHUNK").length - 1, 1);
    finish.open();
    await until(() => jobCompleted);
    assert.equal(h.text().split("FIRST_CHUNK").length - 1, 1, "completion must seal the existing reply, not print its entire text again");
    assert.equal(h.text().split("SECOND_CHUNK").length - 1, 1);
  } finally { second.open(); finish.open(); await h.close(); }
});

test("TUI usage command shares ledger known totals and explicitly labels wholly unknown usage", { timeout: 7000 }, async () => {
  let emitted = false;
  const h = await harness(async ({ onEvent }) => {
    const now = Date.now();
    for (const [index, usage] of [{ inputTokens: 120, outputTokens: 30, cachedInputTokens: 40 }, undefined].entries()) {
      await onEvent?.("job.event", {
        sdkEvent: "invocation.completed", invocationId: `call-${index}`, jobId: `job-${index}`, provider: "fake", model: "test",
        startedAt: new Date(now - 2000).toISOString(), endedAt: new Date(now).toISOString(), durationMs: 2000, status: "completed", usage,
      });
    }
    emitted = true;
    return { message: "" };
  });
  try {
    h.input.write("/usage\n");
    await until(() => h.text().includes("时间与 Token"));
    const empty = buildUsageLedger(await h.session.history());
    assert.equal(empty.totals.totalTokens, null);
    assert.match(h.text(), /未知 tokens/);
    assert.match(h.text(), /输入 未知 · 输出 未知/);
    h.input.write("记录两次调用\n");
    await until(() => emitted);
    const ledger = buildUsageLedger(await h.session.history());
    assert.equal(ledger.totals.totalTokens, 150);
    assert.equal(ledger.totals.unknownInvocationCount, 1);
    const before = h.text().length;
    h.input.write("/usage\n");
    await until(() => h.text().slice(before).includes("时间与 Token"));
    const report = h.text().slice(before);
    assert.match(report, new RegExp(`${ledger.totals.totalTokens} tokens（部分未知）`));
    assert.match(report, new RegExp(`输入 ${ledger.totals.inputTokens} · 输出 ${ledger.totals.outputTokens}`));
    assert.match(report, /调用累计 4秒/);
  } finally { await h.close(); }
});

test("TUI shows concise assistance decisions and keeps evidence out of the conversation", { timeout: 7000 }, async () => {
  const h = await harness(async ({ onEvent }) => {
    await onEvent?.("job.event", { job: "optimizer", jobId: "parent", audience: "user", sdkEvent: "assistance.admitted",
      message: "正在并行核对库存与金额。", evidence: ["PRIVATE_EVIDENCE_MARKER"] });
    await onEvent?.("job.event", { job: "optimizer", jobId: "parent", audience: "user", sdkEvent: "assistance.settled",
      message: "协作已结束，继续完整评价。" });
    return { message: "" };
  });
  try {
    h.input.write("继续\n");
    await until(() => h.text().includes("协作已结束"));
    assert.match(h.text(), /正在并行核对库存与金额/);
    assert.doesNotMatch(h.text(), /PRIVATE_EVIDENCE_MARKER/);
  } finally { await h.close(); }
});

test("TUI shows a paused operation's concrete clarification in the main conversation", { timeout: 7000 }, async () => {
  const h = await harness(async ({ onEvent }) => {
    await onEvent?.("operation.activity", { needsInput: true, message: "金额溢出应拒绝还是截断？", evidence: ["PRIVATE_CLARIFICATION_EVIDENCE"] });
    return { message: "" };
  });
  try {
    h.input.write("继续\n");
    await until(() => h.text().includes("需要你确认：金额溢出应拒绝还是截断？"));
    assert.doesNotMatch(h.text(), /PRIVATE_CLARIFICATION_EVIDENCE/);
  } finally { await h.close(); }
});

test("TUI stop bypasses a long conversation, preserves its visible reply and cancels the active agent", { timeout: 7000 }, async () => {
  let aborted = false;
  const h = await harness(async ({ signal, onEvent }) => {
    await onEvent?.("job.event", { job: "intake-reply", jobId: "long-reply", audience: "user", sdkEvent: "item.updated",
      item: { id: "partial-item", type: "agent_message", text: "VISIBLE_PARTIAL_REPLY" } });
    await new Promise<void>((resolve) => {
      if (signal.aborted) { aborted = true; resolve(); }
      else signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    await onEvent?.("job.completed", { job: "intake-reply", jobId: "long-reply", status: "aborted" });
    return { message: "" };
  });
  try {
    h.input.write("长时间解释\n");
    await until(() => h.text().includes("VISIBLE_PARTIAL_REPLY"));
    assert.equal(aborted, false);
    h.input.write("/stop\n");
    const snapshot = await h.completed;
    assert.equal(snapshot.status, "stopped");
    assert.equal(aborted, true);
    assert.match(h.text(), /你：长时间解释/);
    assert.match(h.text(), /VISIBLE_PARTIAL_REPLY/);
    assert.ok((await h.session.history()).some((event) => event.type === "session.stopped"));
  } finally { await h.close(); }
});

test("live optimize usage retains Session ownership and replays with identical totals and phase", { timeout: 10000 }, async () => {
  class RecordedStore extends MemoryStore {
    readonly events: unknown[] = [];
    override async emit(_state: CapabilityState, type: string, data?: Record<string, unknown>) {
      const event = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), operation: "optimize", type, data };
      this.events.push(event);
      for (const listener of this.listeners) listener(event);
    }
    override async history() { return this.events; }
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-tui-optimize-usage-"));
  const store = new RecordedStore();
  let adapterCalls = 0;
  const agent = new DefaultAgentService({ provider: "mock", model: "test", async run() {
    adapterCalls++;
    return { success: true, usage: { inputTokens: 100, outputTokens: 50 } };
  } }, new PromptAssetStore());
  const item: Capability = { id: "run", grants: [], store,
    createState: async () => ({ status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } }),
    services: () => ({}),
    policySource: async () => ({ id: "usage-owner", revision: "1", operations: { optimize: async ({ signal }) => {
      await executePersistentAgentJob(agent, { operation: "run.optimize", label: "optimizer:attempt-1",
        cwd: root, tools: [], readRoots: [root], writeRoots: [],
        prompt: promptAsset("common.user-intervention", { job_prompt: "Bounded optimization", message: "Proceed" }),
      }, { capabilityId: "run", operationId: "optimize", status: "running", sessions: {},
        checkpoint: async () => {}, emit: async (type, data) => { await store.emit(store.state!, type, data); },
      }, signal);
      return { status: "paused" as const };
    } }, decide: () => ({ type: "run" as const, operationId: "optimize" }) }),
  };
  const reports: string[] = [];
  for (const replay of [false, true]) {
    const session = new FlywheelSession(root, new CapabilityRegistry().register("run", () => item), ["run"]);
    let idleObserved = false;
    session.subscribe(event => { if (event.type === "capability.idle" && event.data?.reason === "paused") idleObserved = true; });
    const input = new PassThrough();
    let rendered = "";
    const output = new Writable({ write(chunk, _encoding, callback) { rendered += chunk.toString(); callback(); } });
    const completed = runSessionTerminal(session, { input, output });
    try {
      await until(() => idleObserved && session.snapshot().activeCapabilityStatus === "paused");
      const before = rendered.length;
      input.write("/usage\n");
      await until(() => rendered.slice(before).includes("时间与 Token"));
      const report = rendered.slice(before);
      assert.match(report, /150 tokens/);
      assert.match(report, /输入 100 · 输出 50/);
      assert.match(report, /阶段 optimization · 150 tokens/);
      assert.doesNotMatch(report, /阶段 unknown/);
      const ledger = buildUsageLedger(await session.history());
      assert.equal(ledger.totals.invocationCount, 1);
      assert.equal(ledger.totals.totalTokens, 150);
      assert.equal(ledger.groups.phase.optimization.invocationCount, 1);
      assert.equal(ledger.invocations[0].capabilityId, "run");
      assert.equal(ledger.invocations[0].sessionId, session.snapshot().sessionId);
      assert.equal(adapterCalls, 1, replay ? "history restore must not run the optimizer again" : "one real adapter invocation");
      reports.push(report);
    } finally { await session.dispatch({ type: "session.stop" }); await completed; input.end(); }
  }
  const metrics = (report: string) => report.split("\n").filter(line => /输入 |阶段 |run.optimize ·/.test(line));
  assert.deepEqual(metrics(reports[1]), metrics(reports[0]));
});
