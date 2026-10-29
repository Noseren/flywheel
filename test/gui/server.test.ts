import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import { ExecutionBudgetExhausted } from "../../src/session/execution-budget.ts";

import { runSessionGui, startSessionGuiServer, type SessionGuiState } from "../../src/gui/server.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import { runSessionTerminal } from "../../src/tui/session-terminal.ts";
import type {
  Capability,
  CapabilityExecutionState,
  CapabilityRequest,
  CapabilityState,
  CapabilityStore,
  InteractionResponseCommand,
} from "../../src/session/protocol.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../src/session/policy.ts";

interface TestState extends CapabilityState { execution: CapabilityExecutionState }

class MemoryStore implements CapabilityStore<TestState> {
  state?: TestState;
  readonly events: unknown[] = [];
  readonly listeners = new Set<(event: unknown) => void>();
  async load(): Promise<TestState> {
    if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.state;
  }
  async save(state: TestState): Promise<void> { this.state = state; }
  async emit(_state: TestState, type: string, data?: Record<string, unknown>): Promise<void> {
    const event = { type, data };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async history(): Promise<unknown[]> { return this.events; }
}

class GuiQuestionCapability implements Capability<{}, TestState, InteractionResponseCommand> {
  readonly id = "question";
  readonly grants: string[] = [];
  readonly store = new MemoryStore();
  answer?: string | boolean;
  managerQuestion = false;
  protected command?: InteractionResponseCommand;
  readonly policySource = async (): Promise<ExecutionPolicy<{}, TestState, InteractionResponseCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: "gui-question", revision: "1",
    operations: { ask: async () => this.command
      ? { status: "completed" }
      : {
          status: "waiting_for_user",
          interaction: {
            id: "goal", capabilityId: this.id, operationId: "ask",
            requestedBy: { type: "agent", label: "Goal Agent", sessionKey: "interviewer" },
            kind: "text", question: "What should Flywheel optimize?",
            ...(this.managerQuestion ? { conversationWith: { label: "Manager", sessionKey: "manager" } } : {}),
          },
        } },
    decide: ({ lastOutcome }) => lastOutcome?.status === "completed"
      ? { type: "complete" }
      : { type: "run", operationId: "ask" },
  });
  async createState(): Promise<TestState> {
    return { status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } };
  }
  async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    state.status = "running";
    if (request.type === "command") {
      this.command = request.command as InteractionResponseCommand;
      this.answer = this.command.value;
    }
    return state;
  }
  services(): {} { return {}; }
}

class GuiSlowResponseCapability extends GuiQuestionCapability {
  override readonly policySource = async (): Promise<ExecutionPolicy<{}, TestState, InteractionResponseCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: "gui-slow-response", revision: "1",
    operations: { ask: async ({ signal }) => this.command
      ? await new Promise<PolicyOutcome<Record<string, unknown>>>((resolve) => {
          signal.addEventListener("abort", () => resolve({ status: "paused" }), { once: true });
        })
      : {
          status: "waiting_for_user",
          interaction: {
            id: "goal", capabilityId: this.id, operationId: "ask",
            requestedBy: { type: "agent", label: "Goal Agent", sessionKey: "interviewer" },
            kind: "text", question: "What should Flywheel optimize?",
          },
        } },
    decide: ({ lastOutcome }) => lastOutcome?.status === "completed"
      ? { type: "complete" }
      : { type: "run", operationId: "ask" },
  });
}

test("GUI reopens reused question IDs after revision and rejects replies from previous rounds after replay", async () => {
  class RevisingCapability extends GuiQuestionCapability {
    override readonly policySource = async (): Promise<ExecutionPolicy<{}, TestState, InteractionResponseCommand, PolicyOutcome<Record<string, unknown>>>> => ({
      id: "revising-question", revision: "1",
      operations: { ask: async () => this.command?.value === "confirm" ? { status: "completed" } : {
        status: "waiting_for_user", interaction: {
          id: "goal", capabilityId: this.id, operationId: "ask", kind: "text",
          requestedBy: { type: "runtime" },
          conversationWith: { label: "Manager", sessionKey: "manager" },
          question: this.command ? "Confirm the revised proposal?" : "Confirm proposal?",
        },
      } },
      decide: ({ lastOutcome }) => lastOutcome?.status === "completed" ? { type: "complete" } : { type: "run", operationId: "ask" },
    });
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-revise-"));
  const capability = new RevisingCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  let gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const send = async (interactionRevision: number | undefined, value: string) => {
    const url = new URL(gui.url);
    return await fetch(`${url.origin}/api/command${url.search}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "message", interactionId: "goal", interactionRevision, value }) });
  };
  try {
    await session.dispatch({ type: "session.start" });
    const revised = await send(1, "revise");
    assert.equal(revised.status, 200);
    const state = await revised.json() as SessionGuiState;
    assert.equal(state.interactionRevision, 2);
    assert.equal(state.pendingInteractionAnswered, false);
    assert.deepEqual(state.timeline.filter(e => e.title === "需要用户输入").map(e => e.interactionRevision), [1, 2]);
    await gui.close();
    gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
    assert.equal((await send(1, "stale confirm")).status, 409);
    assert.equal((await send(undefined, "ambiguous confirm")).status, 409);
    assert.equal(capability.answer, "revise");
    assert.equal((await send(2, "confirm")).status, 200);
    assert.equal(capability.answer, "confirm");
  } finally { await session.dispatch({ type: "session.stop" }); await gui.close(); }
});

async function waitForPending(stateUrl: string): Promise<SessionGuiState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await fetch(stateUrl).then(async (response) => await response.json() as SessionGuiState);
    if (state.snapshot.pendingInteraction
      && state.nodes.some((node) => node.kind === "operation")
      && state.timeline.some((entry) => entry.title === "需要用户输入")) return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("GUI did not expose the pending interaction");
}

test("GUI context exposes the original goal with bounded preview and token-protected exact evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-evidence-"));
  await mkdir(path.join(root, ".flywheel"));
  const goal = "# 原始要求\n" + "完整保留要求。\n".repeat(5000);
  await writeFile(path.join(root, ".flywheel", "goal.md"), goal);
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, readOnly: true, onListening: () => undefined });
  const url = new URL(gui.url);
  try {
    assert.equal((await fetch(`${url.origin}/api/context`)).status, 403);
    const context = await fetch(`${url.origin}/api/context${url.search}`).then((response) => response.json());
    assert.equal(context.goal.truncated, true);
    assert.ok(Buffer.byteLength(context.goal.preview) <= 16_384);
    assert.ok(goal.startsWith(context.goal.preview));
    assert.deepEqual(context.results, []);
    const file = await fetch(`${url.origin}/api/evidence${url.search}&id=goal`);
    assert.match(file.headers.get("content-type")!, /text\/plain/);
    assert.equal(await file.text(), goal);
    assert.equal((await fetch(`${url.origin}/api/evidence${url.search}&id=../secret`)).status, 404);
  } finally { await gui.close(); }
});

test("live compact Session results and budget exhaustion reach GUI main chat and official context", async () => {
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
  class CompactCapability extends GuiQuestionCapability {
    override readonly id = "run";
    override readonly store = new CompactStore();
    override readonly policySource = async () => ({ id: "compact-ui-events", revision: "1",
      operations: { retain: async () => {
        await this.store.emit(this.store.state!, "operation.activity", { attempt: "attempt-1", retained: false });
        await this.store.emit(this.store.state!, "operation.activity", { attempt: "attempt-2", retained: true, target: "achieved" });
        throw new ExecutionBudgetExhausted("tokens");
      } },
      decide: () => ({ type: "run" as const, operationId: "retain" }),
    });
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-compact-events-"));
  const capability = new CompactCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("run", () => capability), ["run"]);
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  try {
    await session.dispatch({ type: "session.start" });
    const state = await fetch(`${url.origin}/api/state${url.search}`).then(response => response.json() as Promise<SessionGuiState>);
    assert.equal(state.snapshot.activeCapabilityStatus, "paused");
    const budget = state.timeline.filter(entry => (entry.raw as { type?: string }).type === "runtime.budget.exhausted");
    assert.equal(budget.length, 1);
    assert.equal(budget[0].tone, "warning");
    assert.match(budget[0].title, /已知 token预算已用完，进度已保留/);
    const candidates = state.timeline.filter(entry => (entry.raw as { type?: string }).type === "operation.activity");
    assert.deepEqual(candidates.map(entry => entry.officialTitle), [
      "候选未保留，继续使用当前版本", "候选已保留为正式版本，目标已达成",
    ]);
    assert.match(candidates[1].title, /正式版本 v2，目标已达成/);
    const context = await fetch(`${url.origin}/api/context${url.search}`).then(response => response.json());
    assert.deepEqual(context.results.map((entry: { title: string; version: string }) => [entry.title, entry.version]), [
      ["候选未保留，继续使用当前版本", "v1"], ["候选已保留为正式版本，目标已达成", "v2"],
    ]);
    // Exercise the actual browser main-chat filter on the server's projected payload.
    const source = await readFile(new URL("../../system-assets/gui/app.js", import.meta.url), "utf8");
    const browser = vm.createContext({ URLSearchParams, location: { search: "" }, payload: state,
      setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1 });
    vm.runInContext(source.replace(/connect\(\);\s*$/, ""), browser);
    vm.runInContext("ui.state=payload;mergeEntries(payload.timeline);mergeEntries(payload.timeline);", browser);
    const visible = JSON.parse(vm.runInContext("JSON.stringify(mainEntries().map(entry=>entry.id))", browser)) as string[];
    assert.deepEqual(visible, [...candidates.map(entry => entry.id), budget[0].id]);
  } finally { await session.dispatch({ type: "session.stop" }); await gui.close(); }
});

test("GUI binds replies to the displayed question and rejects ambiguous structured answers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-binding-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  const endpoint = `${url.origin}/api/command${url.search}`;
  const send = async (body: unknown) => await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await session.dispatch({ type: "session.start" });
    assert.equal((await send({ type: "submit", value: "old page" })).status, 409);
    assert.equal((await send({ type: "submit", interactionId: "old-goal", value: "old page" })).status, 409);
    const interaction = capability.store.state!.pendingInteraction!;
    interaction.kind = "confirm";
    assert.equal((await send({ type: "submit", interactionId: "goal", value: "can you explain?" })).status, 409);
    assert.equal(capability.answer, undefined);
    interaction.kind = "select";
    interaction.options = [{ value: "a", label: "Choice A" }];
    assert.equal((await send({ type: "submit", interactionId: "goal", value: "unknown" })).status, 409);
    assert.equal((await send({ type: "submit", interactionId: "goal", value: "a" })).status, 200);
    assert.equal(capability.answer, "a");
    assert.equal((await send({ type: "submit", interactionId: "goal", value: "stale" })).status, 409);
  } finally {
    await session.dispatch({ type: "session.stop" });
    await gui.close();
  }
});

test("TUI Manager replies preserve free text and audit its input provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-tui-conversation-"));
  const capability = new GuiQuestionCapability();
  capability.managerQuestion = true;
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const running = runSessionTerminal(session, { input, output });
  try {
    await waitFor(() => Boolean(session.snapshot().pendingInteraction));
    input.write("可以\n");
    await waitFor(() => capability.answer === "可以");
    input.write("/stop\n");
    await running;
    const response = (await session.history()).find((event) => event.type === "interaction.responded");
    assert.equal(response?.data?.inputKind, "text");
    assert.equal(response?.data?.source, "tui");
  } finally {
    if (session.snapshot().status !== "stopped") await session.dispatch({ type: "session.stop" });
    await running;
  }
});

test("GUI natural messages preserve Manager question context without parsing select answers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-conversation-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  const send = async (body: unknown) => await fetch(`${url.origin}/api/command${url.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await session.dispatch({ type: "session.start" });
    const pending = capability.store.state!.pendingInteraction!;
    pending.kind = "select";
    pending.conversationWith = { label: "Manager", sessionKey: "manager" };
    pending.options = [{ label: "确认", value: "confirm" }];
    assert.equal((await send({ type: "message", interactionId: "old", value: "这个评价方式可靠吗？" })).status, 409);
    assert.equal(capability.answer, undefined);
    assert.equal((await send({ type: "message", interactionId: "goal", value: "这个评价方式可靠吗？" })).status, 200);
    assert.equal(capability.answer, "这个评价方式可靠吗？");
    const responseEvent = (await session.history()).find((event) => event.type === "interaction.responded");
    assert.equal(responseEvent?.data?.inputKind, "text");
  } finally { await session.dispatch({ type: "session.stop" }); await gui.close(); }
});

test("Session serializes burst events identically for live observation and replay", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-order-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const live: string[] = [];
  session.subscribe((event) => { if (event.type === "capability.event" && typeof (event.data?.event as any)?.id === "string") live.push((event.data!.event as any).id); });
  await session.dispatch({ type: "session.start" });
  const expected = Array.from({ length: 100 }, (_, index) => `ordered-${index}`);
  for (const id of expected) for (const listener of capability.store.listeners) listener({ id, timestamp: "2026-09-08T00:00:00.000Z", type: "job.event", data: {} });
  await session.dispatch({ type: "session.stop" });
  const replay = (await session.history()).filter((event) => event.type === "capability.event" && typeof (event.data?.event as any)?.id === "string").map((event) => (event.data!.event as any).id);
  assert.deepEqual(live, expected);
  assert.deepEqual(replay, expected);
});

test("GUI accepts Manager interventions during questions and repeated blocked recovery replies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-recovery-"));
  const capability = new GuiQuestionCapability();
  const messages: string[] = [];
  const recovering = Object.assign(capability, { manager: {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: TestState; message: string }) => {
      messages.push(message);
      state.status = "blocked";
      state.lastError = "test blocker";
      return state;
    },
  } });
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => recovering), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  const send = async (body: unknown) => await fetch(`${url.origin}/api/command${url.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await session.dispatch({ type: "session.start" });
    assert.equal((await send({ type: "message", interactionId: "goal", value: "explain" })).status, 200);
    assert.equal(capability.answer, undefined);
    const firstId = session.snapshot().pendingInteraction!.id;
    assert.match(firstId, /^session-blocked-recovery:/);
    assert.equal((await send({ type: "submit", interactionId: firstId, value: "retry one" })).status, 200);
    const secondId = session.snapshot().pendingInteraction!.id;
    assert.notEqual(secondId, firstId);
    assert.equal((await send({ type: "submit", interactionId: secondId, value: "retry two" })).status, 200);
    assert.deepEqual(messages, ["explain", "retry one", "retry two"]);
  } finally {
    await session.dispatch({ type: "session.stop" });
    await gui.close();
  }
});

test("GUI Manager input preempts an in-flight reply instead of waiting behind it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-interrupt-"));
  const messages: string[] = [];
  const capability = Object.assign(new GuiSlowResponseCapability(), { manager: {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: TestState; message: string }) => {
      messages.push(message); state.status = "paused"; state.pendingInteraction = undefined; return state;
    },
  } });
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  const send = async (body: unknown) => await fetch(`${url.origin}/api/command${url.search}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await session.dispatch({ type: "session.start" });
    const original = send({ type: "submit", interactionId: "goal", value: "start" });
    await waitFor(() => session.snapshot().status === "running");
    const reply = await send({ type: "intervene", value: "explain progress" });
    assert.equal(reply.status, 200);
    const state = await reply.json() as SessionGuiState;
    assert.ok(state.revision > 0);
    assert.equal((await original).status, 200);
    assert.deepEqual(messages, ["explain progress"]);
    assert.equal(session.snapshot().activeCapabilityStatus, "paused");
  } finally {
    await session.dispatch({ type: "session.stop" }); await gui.close();
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for GUI fixture state");
}

const sseBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, { decoder: TextDecoder; buffer: string }>();
test("GUI flushes the stopped snapshot before immediate transport shutdown", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-stop-flush-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  const response = await fetch(`${url.origin}/api/stream${url.search}`);
  const reader = response.body!.getReader();
  try {
    await readSseEvent(reader, "refresh");
    await session.dispatch({ type: "session.stop" });
    const closing = gui.close();
    const terminal = await readSseEvent(reader, "patch");
    assert.equal((terminal.snapshot as { status: string }).status, "stopped");
    await reader.cancel();
    await closing;
  } finally { await reader.cancel(); await gui.close(); }
});
test("SSE test reader retains coalesced and split network packets", async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: patch\ndata: {"n":1}\n\nevent: patch\ndata: {"n":'));
    controller.enqueue(new TextEncoder().encode('2}\n\nevent: patch\ndata: {"n":3}\n\n'));
    controller.close();
  } });
  const reader = stream.getReader();
  assert.equal((await readSseEvent(reader, "patch")).n, 1);
  assert.equal((await readSseEvent(reader, "patch")).n, 2);
  assert.equal((await readSseEvent(reader, "patch")).n, 3);
});
async function readSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>, eventName: string): Promise<Record<string, unknown>> {
  let state = sseBuffers.get(reader);
  if (!state) { state = { decoder: new TextDecoder(), buffer: "" }; sseBuffers.set(reader, state); }
  while (true) {
    let end: number;
    while ((end = state.buffer.indexOf("\n\n")) >= 0) {
      const block = state.buffer.slice(0, end);
      state.buffer = state.buffer.slice(end + 2);
      if (!block.startsWith(`event: ${eventName}\n`)) continue;
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) return JSON.parse(data) as Record<string, unknown>;
    }
    const result = await reader.read();
    if (result.done) break;
    state.buffer += state.decoder.decode(result.value, { stream: true });
  }
  throw new Error(`SSE did not emit ${eventName}`);
}

test("GUI exposes event projection and routes the same interaction controls as the TUI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  let resolveUrl!: (value: string) => void;
  const listening = new Promise<string>((resolve) => { resolveUrl = resolve; });
  const running = runSessionGui(session, { port: 0, onListening: resolveUrl });
  const guiUrl = await listening;
  const parsed = new URL(guiUrl);
  const token = parsed.searchParams.get("token")!;
  const api = (name: string) => `${parsed.origin}${name}?token=${encodeURIComponent(token)}`;

  try {
    const unauthorized = await fetch(`${parsed.origin}/api/state`);
    assert.equal(unauthorized.status, 403);

    const controlHtml = await fetch(`${parsed.origin}/`).then(async (response) => await response.text());
    assert.match(controlHtml, /id="work-tree"[^>]*hidden/);
    assert.match(controlHtml, /class="main-chat"/);
    assert.match(controlHtml, /id="write-surface"/);
    assert.match(controlHtml, /id="stop"/);

    const state = await waitForPending(api("/api/state"));
    assert.equal(state.snapshot.pendingInteraction?.question, "What should Flywheel optimize?");
    assert.ok(state.timeline.some((entry) => entry.kind === "message" && entry.title === "需要用户输入"));
    assert.equal(state.timeline.find((entry) => entry.title === "需要用户输入")?.interactionId, state.snapshot.pendingInteraction?.id);

    const response = await fetch(api("/api/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "submit", interactionId: "goal", value: "Evaluator quality" }),
    });
    assert.equal(response.status, 200);
    assert.equal(capability.answer, "Evaluator quality");
  } finally {
    if (session.snapshot().status !== "stopped") {
      await fetch(api("/api/command"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "stop" }),
      });
    }
  }
  const final = await running;
  assert.equal(final.status, "stopped");
});

test("SSE drains a thousand Job updates in bounded node batches with every terminal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-live-nodes-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  await session.dispatch({ type: "session.start" });
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  const response = await fetch(`${url.origin}/api/stream${url.search}`, { signal: AbortSignal.timeout(30000) });
  const reader = response.body!.getReader();
  try {
    await readSseEvent(reader, "refresh");
    for (let index = 0; index < 1000; index++) for (const type of ["job.started", "job.completed"]) {
      const event = { id: `burst-${index}-${type}`, timestamp: new Date().toISOString(), type, operation: "ask",
        data: { job: `burst ${index}`, jobId: `burst-${index}`, status: type === "job.completed" ? "completed" : "running" } };
      capability.store.events.push(event);
      for (const listener of capability.store.listeners) listener(event);
    }
    const terminal = new Set<string>();
    const evidence = new Set<string>();
    let batches = 0;
    while (terminal.size < 1000 || evidence.size < 2000) {
      const patch = await readSseEvent(reader, "patch");
      const nodes = patch.nodes as SessionGuiState["nodes"];
      assert.ok(nodes.length <= 200);
      batches++;
      for (const node of nodes) if (node.kind === "agent" && node.status === "completed") terminal.add(String(node.metadata.jobId));
      for (const entry of patch.timeline as SessionGuiState["timeline"]) {
        if (entry.id.includes(":burst-")) evidence.add(entry.id);
      }
    }
    assert.equal(terminal.size, 1000);
    assert.equal(evidence.size, 2000);
    assert.ok(batches >= 5);
    await reader.cancel();
    const reconnected = await fetch(`${url.origin}/api/stream${url.search}`, { signal: AbortSignal.timeout(10000) });
    const nextReader = reconnected.body!.getReader();
    try {
      const refresh = await readSseEvent(nextReader, "refresh");
      assert.ok((refresh.nodes as unknown[]).length <= 206);
      assert.ok((refresh.timeline as unknown[]).length <= 256);
      const event = { id: "after-reconnect", timestamp: new Date().toISOString(), type: "operation.activity", operation: "ask", data: { message: "still connected" } };
      capability.store.events.push(event);
      for (const listener of capability.store.listeners) listener(event);
      const patch = await readSseEvent(nextReader, "patch");
      assert.ok((patch.nodes as unknown[]).length < 10, "Unloaded unchanged nodes must not be replayed after reconnect");
    } finally { await nextReader.cancel(); }
  } finally {
    await reader.cancel().catch(() => undefined);
    await session.dispatch({ type: "session.stop" });
    await gui.close();
  }
});

test("GUI marks submitted interactions as processing and lets stop preempt a long command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-preempt-"));
  const capability = new GuiSlowResponseCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  let resolveUrl!: (value: string) => void;
  const listening = new Promise<string>((resolve) => { resolveUrl = resolve; });
  const running = runSessionGui(session, { port: 0, onListening: resolveUrl });
  const guiUrl = await listening;
  const parsed = new URL(guiUrl);
  const token = parsed.searchParams.get("token")!;
  const api = (name: string) => `${parsed.origin}${name}?token=${encodeURIComponent(token)}`;

  try {
    await waitForPending(api("/api/state"));
    const submission = fetch(api("/api/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "submit", interactionId: "goal", value: "Evaluator quality" }),
    });

    let processing: SessionGuiState | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      processing = await fetch(api("/api/state"))
        .then(async (response) => await response.json() as SessionGuiState);
      if (processing.commandPending && processing.pendingInteractionAnswered) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(processing?.commandPending, true);
    assert.equal(processing?.pendingInteractionAnswered, true);

    const duplicate = await fetch(api("/api/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "submit", interactionId: "goal", value: "duplicate" }),
    });
    assert.equal(duplicate.status, 409);

    const started = performance.now();
    const stopped = await fetch(api("/api/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "stop" }),
    });
    assert.equal(stopped.status, 200);
    assert.ok(performance.now() - started < 1_000);
    assert.equal((await stopped.json() as SessionGuiState).snapshot.status, "stopped");
    assert.equal((await submission).status, 200);
  } finally {
    if (session.snapshot().status !== "stopped") await session.dispatch({ type: "session.stop" });
  }
  assert.equal((await running).status, "stopped");
});

test("observer GUI follows the TUI session and exposes TUI answers without accepting commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-observer-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  const observer = await startSessionGuiServer(session, {
    port: 0,
    readOnly: true,
    onListening: () => undefined,
  });
  const parsed = new URL(observer.url);
  const token = parsed.searchParams.get("token")!;
  const api = (name: string) => `${parsed.origin}${name}?token=${encodeURIComponent(token)}`;
  const input = new PassThrough();
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk) => { transcript += chunk.toString(); });

  const running = runSessionTerminal(session, { input, output, observerUrl: observer.url });
  try {
    const observerHtml = await fetch(`${parsed.origin}/`).then(async (response) => await response.text());
    assert.match(observerHtml, /id="work-tree"[^>]*hidden/);
    assert.match(observerHtml, /class="main-chat"/);
    assert.doesNotMatch(observerHtml, /id="write-surface"/);
    assert.doesNotMatch(observerHtml, /id="message"/);
    assert.doesNotMatch(observerHtml, /id="abort"|id="resume"|id="stop"/);

    const pending = await waitForPending(api("/api/state"));
    assert.equal(pending.readOnly, true);

    const forbidden = await fetch(api("/api/command"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "submit", value: "must not be accepted" }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(capability.answer, undefined);

    input.write("Evaluator quality\n");
    await waitFor(() => capability.answer === "Evaluator quality");
    input.write("/stop\n");
    const final = await running;
    assert.equal(final.status, "stopped");

    const observed = await fetch(api("/api/state")).then(async (response) => await response.json() as SessionGuiState);
    assert.ok(observed.timeline.some((entry) => entry.kind === "message"
      && entry.actor === "You · TUI"
      && entry.title === "Interaction response"
      && entry.body === "Evaluator quality"));
    assert.match(transcript, /只读观察 GUI/);
    assert.match(transcript, new RegExp(observer.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    if (session.snapshot().status !== "stopped") await session.dispatch({ type: "session.stop" });
    await running;
    await observer.close();
  }
});

test("GUI assets keep long histories bounded and support incremental Live and Inspect updates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-assets-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const parsed = new URL(gui.url);
  try {
    const script = await fetch(`${parsed.origin}/app.js`).then(async (response) => await response.text());
    assert.match(script, /requestAnimationFrame/);
    assert.match(script, /navigator\.clipboard\.writeText/);
    assert.match(script, /addEventListener\("patch"/);
    assert.match(script, /expansionControl\("查看完整消息"/);
    const html = await fetch(gui.url).then(response => response.text());
    assert.match(html, /aria-label="Agent 只读对话" hidden/);
    assert.match(html, /class="send"/);
    assert.match(html, /class="composer-footer"/);
    assert.match(html, /id="project-sidebar"/);
    assert.match(html, /class="flywheel-mark"/);
    assert.match(html, /<svg class="flywheel-mark"/);
    assert.doesNotMatch(html, /<img class="flywheel-mark"/);
    assert.match(html, /Shift \+ Enter 换行/);
    assert.doesNotMatch(html, /detail-section|overview-section|view-mode/);
    const styles = await fetch(`${parsed.origin}/styles.css`).then(response => response.text());
    assert.match(styles, /prefers-reduced-motion: reduce/);
    assert.match(styles, /worker-open/);
    assert.match(script, /renderTreeFlow\(nodes, travelled, animatePaths\)/);
    assert.match(styles, /\.tree-flow-layer/);
    assert.match(styles, /animation:tree-path-flow/);
    assert.match(styles, /mask-image:linear-gradient/);
    assert.match(styles, /\.expand-arrow/);
    assert.match(styles, /\.projects-collapsed/);
    const logoResponse = await fetch(`${parsed.origin}/flywheel-logo.svg`);
    assert.match(logoResponse.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(logoResponse.headers.get("content-security-policy") ?? "", /style-src 'unsafe-inline'/);
    assert.match(logoResponse.headers.get("content-security-policy") ?? "", /script-src 'none'/);
    const logo = await logoResponse.text();
    assert.match(logo, /@keyframes side-flow/);
    assert.match(logo, /@keyframes hub-flow/);
    assert.match(logo, /prefers-reduced-motion:reduce/);
    assert.doesNotMatch(script, /project-glyph/);
    assert.match(script, /\/api\/switch-project/);
  } finally {
    await gui.close();
  }
});

test("GUI SSE reconnects with a recent history window and publishes later changes as deduplicated patches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-sse-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const parsed = new URL(gui.url);
  const token = parsed.searchParams.get("token")!;
  const streamUrl = `${parsed.origin}/api/stream?token=${encodeURIComponent(token)}`;
  const first = await fetch(streamUrl);
  const firstReader = first.body!.getReader();
  try {
    const initial = await readSseEvent(firstReader, "refresh");
    assert.deepEqual(initial.timeline, []);

    const running = session.dispatch({ type: "session.start" });
    const patch = await readSseEvent(firstReader, "patch");
    assert.ok(Array.isArray(patch.timeline));
    assert.ok((patch.timeline as unknown[]).length > 0);
    await running;
    await firstReader.cancel();

    const second = await fetch(streamUrl);
    const secondReader = second.body!.getReader();
    const replay = await readSseEvent(secondReader, "refresh");
    const ids = (replay.timeline as Array<{ id: string }>).map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(patch.nodesPartial, true);
    const patchIds = (patch.timeline as Array<{ id: string }>).map((entry) => entry.id);
    assert.ok(patchIds.every((id) => ids.includes(id)));
    assert.ok(ids.length >= patchIds.length);
    await secondReader.cancel();

    assert.equal(session.snapshot().status, "idle");
  } finally {
    if (session.snapshot().status !== "stopped") await session.dispatch({ type: "session.stop" });
    await gui.close();
  }
});

test("GUI pages ten thousand events without losing older evidence and bounds reconnect history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-pressure-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  const events = Array.from({ length: 10_000 }, (_, index) => ({
    id: `pressure-${index}`,
    episodeId: "pressure",
    agentStateId: "pressure",
    steeringRevisionId: "pressure",
    timestamp: new Date(1_800_000_000_000 + index).toISOString(),
    type: "job.event",
    version: "pressure",
    operation: "evaluate",
    status: "running",
    data: {
      job: "pressure evaluator",
      jobId: "pressure/evaluate",
      sdkEvent: "item.completed",
      item: { id: `message-${index}`, type: "agent_message", text: `event ${index}` },
    },
  }));
  Object.defineProperty(session, "activeHistory", { value: async () => [...events, events.at(-1)!] });
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const parsed = new URL(gui.url);
  const token = parsed.searchParams.get("token")!;
  try {
    const state = await fetch(`${parsed.origin}/api/state?token=${encodeURIComponent(token)}`)
      .then(async (response) => await response.json() as SessionGuiState);
    assert.equal(state.history.total, 10_000);
    assert.ok(state.timeline.length <= 250);
    assert.ok(Buffer.byteLength(JSON.stringify(state.timeline)) < 263_000);
    const seen = new Set(state.timeline.map((entry) => entry.id));
    let before = state.history.before;
    while (before > 0) {
      const page = await fetch(`${parsed.origin}/api/history?token=${encodeURIComponent(token)}&before=${before}`).then((response) => response.json());
      assert.ok(page.before < before);
      assert.ok(page.timeline.length <= 250);
      for (const entry of page.timeline) { assert.equal(seen.has(entry.id), false); seen.add(entry.id); }
      before = page.before;
    }
    assert.equal(seen.size, 10_000);
    assert.equal((await fetch(`${parsed.origin}/api/history?token=${encodeURIComponent(token)}&before=-1`)).status, 400);
    const stream = await fetch(`${parsed.origin}/api/stream?token=${encodeURIComponent(token)}`);
    const reader = stream.body!.getReader();
    const replay = await readSseEvent(reader, "refresh");
    assert.ok((replay.timeline as unknown[]).length <= 250);
    await reader.cancel();
    assert.equal(state.timeline.at(-1)?.category, "text");
    assert.equal(state.timeline.at(-1)?.jobId, "pressure/evaluate");
    assert.equal(state.timeline.at(-1)?.streamKey, "run:pressure/evaluate:message-9999");
  } finally {
    await gui.close();
  }
});

test("operation return colors distinguish waiting and blocking from successful completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-status-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  Object.defineProperty(session, "activeHistory", { value: async () => ["blocked", "waiting_for_user", "paused", "completed"].map((status) => ({
    id: status, timestamp: new Date().toISOString(), type: "operation.completed", operation: status, data: { status },
  })) });
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  try {
    const state: SessionGuiState = await fetch(`${url.origin}/api/state${url.search}`).then((response) => response.json());
    assert.deepEqual(state.timeline.map((entry) => entry.tone), ["danger", "warning", "warning", "success"]);
    assert.deepEqual(state.nodes.filter((node) => node.kind === "operation").map((node) => node.status), ["blocked", "waiting", "waiting", "completed"]);
  } finally { await gui.close(); }
});

test("navigation pages retain ancestors and reach every Agent without an initial full tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-node-pages-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  Object.defineProperty(session, "activeHistory", { value: async () => Array.from({ length: 1000 }, (_, index) => ({
    id: `job-${index}`, timestamp: new Date().toISOString(), type: "job.started", operation: "evaluate",
    data: { job: `Agent ${index}`, jobId: `job-${index}`,
      ...(index > 1 ? { parentJobId: "job-1" } : index === 1 ? { parentJobId: "job-0" } : {}) },
  })) });
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  try {
    const state: SessionGuiState = await fetch(`${url.origin}/api/state${url.search}`).then((response) => response.json());
    assert.ok(state.nodes.length <= 206);
    assert.ok(Buffer.byteLength(JSON.stringify(state.nodes)) < 200000);
    const seen = new Map(state.nodes.map((node) => [node.id, node]));
    let before = state.nodeHistory.before;
    while (before > 0) {
      const page = await fetch(`${url.origin}/api/nodes${url.search}&before=${before}`).then((response) => response.json());
      assert.ok(page.before < before);
      assert.ok(page.nodes.length <= 206);
      for (const node of page.nodes) {
        assert.ok(!node.parentId || page.nodes.some((parent: any) => parent.id === node.parentId));
        seen.set(node.id, node);
      }
      before = page.before;
    }
    assert.equal(seen.size, state.nodeHistory.total);
    assert.equal([...seen.values()].filter((node) => node.kind === "agent").length, 1000);
    assert.equal((await fetch(`${url.origin}/api/nodes${url.search}&before=-1`)).status, 400);
    assert.equal((await fetch(`${url.origin}/api/nodes?before=100`)).status, 403);
  } finally { await gui.close(); }
});

test("large timeline events are deferred but full content stays token-protected and retrievable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-large-event-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const output = "完整日志\n".repeat(100_000);
  Object.defineProperty(session, "activeHistory", { value: async () => [{ id: "large", timestamp: new Date().toISOString(), type: "job.event", operation: "evaluate",
    data: { job: "large", jobId: "large", sdkEvent: "item.completed", item: { id: "large-command", type: "command_execution", command: "test", aggregated_output: output, status: "completed", exit_code: 0 } } }] });
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const url = new URL(gui.url);
  try {
    const state = await fetch(`${url.origin}/api/state${url.search}`).then((response) => response.json());
    const summary = state.timeline[0];
    const deferredNode = state.nodes.find((node: any) => node.kind === "operation" && node.detailKey);
    assert.ok(deferredNode, "Operation should defer full metadata and output");
    assert.ok(state.nodes.every((node: any) => !["command", "tool", "turn"].includes(node.kind)));
    assert.ok(Buffer.byteLength(JSON.stringify(state.nodes)) < 20000);
    assert.equal((await fetch(`${url.origin}/api/node?id=${encodeURIComponent(deferredNode.id)}&key=${deferredNode.detailKey}`)).status, 403);
    const detailUrl = `${url.origin}/api/node${url.search}&id=${encodeURIComponent(deferredNode.id)}`;
    assert.equal((await fetch(`${detailUrl}&key=stale`)).status, 409);
    const detail = await fetch(`${detailUrl}&key=${deferredNode.detailKey}`).then((response) => response.json());
    assert.equal(detail.node.metadata.item.aggregated_output, output);
    assert.equal(detail.detailKey, deferredNode.detailKey);
    assert.ok(summary.detailId);
    assert.ok(Buffer.byteLength(JSON.stringify(state.timeline)) < 4096);
    assert.equal((await fetch(`${url.origin}/api/entry?id=${encodeURIComponent(summary.detailId)}`)).status, 403);
    const full = await fetch(`${url.origin}/api/entry${url.search}&id=${encodeURIComponent(summary.detailId)}`).then((response) => response.json());
    assert.equal(full.raw.data.item.aggregated_output, output);
  } finally { await gui.close(); }
});

for (const commandStatus of ["failed", "completed"]) test(`GUI classifies nonzero exit with ${commandStatus} status as an error`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-failed-command-"));
  const capability = new GuiQuestionCapability();
  const session = new FlywheelSession(
    root,
    new CapabilityRegistry().register(capability.id, () => capability),
    [capability.id],
  );
  Object.defineProperty(session, "activeHistory", { value: async () => [{
    id: "failed-command-event",
    episodeId: "failure",
    agentStateId: "failure",
    steeringRevisionId: "failure",
    timestamp: new Date(1_800_000_000_000).toISOString(),
    type: "job.event",
    version: "fixture",
    operation: "evaluate",
    status: "running",
    data: {
      job: "child verifier",
      jobId: "candidate/evaluate/child-verifier",
      parentJobId: "candidate/evaluate",
      sdkEvent: "item.completed",
      item: {
        id: "failed-command", type: "command_execution",
        command: "python -m pytest test_boundary.py -q",
        status: commandStatus, exit_code: 1, aggregated_output: "1 failed",
      },
    },
  }] });
  const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
  const parsed = new URL(gui.url);
  const token = parsed.searchParams.get("token")!;
  try {
    const state = await fetch(`${parsed.origin}/api/state?token=${encodeURIComponent(token)}`)
      .then(async (response) => await response.json() as SessionGuiState);
    assert.equal(state.timeline[0]?.category, "error");
    assert.equal(state.timeline[0]?.tone, "danger");
    assert.match(state.timeline[0]?.title ?? "", /^Command failed:/);
    assert.equal(state.timeline[0]?.parentJobId, "candidate/evaluate");
  } finally {
    await gui.close();
  }
});
