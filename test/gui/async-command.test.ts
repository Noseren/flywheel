import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startSessionGuiServer, type SessionGuiState } from "../../src/gui/server.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import type { Capability, CapabilityExecutionState, CapabilityRequest, CapabilityState, CapabilityStore, InteractionResponseCommand } from "../../src/session/protocol.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../src/session/policy.ts";
import type { UsageLedger } from "../../src/session/usage-ledger.ts";

interface State extends CapabilityState { execution: CapabilityExecutionState }
class Store implements CapabilityStore<State> {
  state?: State;
  readonly events: unknown[] = [];
  readonly listeners = new Set<(event: unknown) => void>();
  async load() { if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return this.state; }
  async save(state: State) { this.state = state; }
  async emit(_state: State, type: string, data?: Record<string, unknown>) {
    const event = { type, data, timestamp: new Date().toISOString(), scope: "init", operation: "prepare" };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: unknown) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async history() { return this.events; }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { resolve, promise };
}
class SlowCapability implements Capability<{}, State, InteractionResponseCommand> {
  readonly id = "init";
  readonly grants: string[] = [];
  readonly store = new Store();
  readonly entered = deferred();
  readonly release = deferred();
  replies = 0;
  readonly policySource = async (): Promise<ExecutionPolicy<{}, State, InteractionResponseCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: "http-admission", revision: "1",
    operations: { prepare: async ({ signal }) => {
      if (!this.replies) return { status: "waiting_for_user", interaction: {
        id: "goal", capabilityId: this.id, operationId: "prepare", kind: "text",
        requestedBy: { type: "agent", label: "Guide", sessionKey: "guide" }, question: "What should improve?",
        conversationWith: { label: "Manager", sessionKey: "manager" },
      } };
      this.entered.resolve();
      await Promise.race([this.release.promise, new Promise<void>((resolve) => {
        if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
      })]);
      return { status: "paused" };
    } },
    decide: () => ({ type: "run", operationId: "prepare" }),
  });
  async createState(): Promise<State> { return { status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } }; }
  async prepare(state: State, request: CapabilityRequest) {
    state.status = "running";
    if (request.type === "command") this.replies++;
    return state;
  }
  services() { return {}; }
}
async function setup(readOnly = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-async-http-"));
  const capability = new SlowCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const gui = await startSessionGuiServer(session, { port: 0, readOnly, onListening: () => undefined });
  const url = new URL(gui.url);
  const send = async (body: unknown) => fetch(`${url.origin}/api/command${url.search}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  });
  await session.dispatch({ type: "session.start" });
  return { capability, session, gui, url, send, async close() {
    capability.release.resolve();
    await session.dispatch({ type: "session.stop" });
    await gui.close();
  } };
}
const message = { type: "message", clientRequestId: "goal-response", interactionId: "goal", interactionRevision: 1, value: "Improve helpfulness" };

test("HTTP clientRequestId receives 202 before slow work finishes, retries reuse receipt and changed payload conflicts", { timeout: 10000 }, async () => {
  const app = await setup();
  try {
    const response = await app.send(message);
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.receipt.status, "accepted");
    assert.ok(accepted.receipt.commandId);
    await app.capability.entered.promise;
    const duplicate = await app.send(message);
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).receipt.commandId, accepted.receipt.commandId);
    const conflict = await app.send({ ...message, value: "Different goal" });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /同一请求编号不能用于不同内容/);
    assert.equal(app.capability.replies, 1);
    const state = await fetch(`${app.url.origin}/api/state${app.url.search}`).then((r) => r.json() as Promise<SessionGuiState>);
    assert.equal(state.commands.find((entry) => entry.clientRequestId === message.clientRequestId)?.commandId, accepted.receipt.commandId);
    const stopped = await app.send({ type: "stop", clientRequestId: "stop-independent" });
    assert.equal(stopped.status, 202);
    await app.gui.waitUntilSessionStops();
  } finally { await app.close(); }
});

test("concurrent HTTP retries with the same clientRequestId admit one logical command", { timeout: 10000 }, async () => {
  const app = await setup();
  try {
    const responses = await Promise.all([app.send(message), app.send(message)]);
    assert.deepEqual(responses.map((response) => response.status), [202, 202]);
    const [first, second] = await Promise.all(responses.map((response) => response.json()));
    assert.equal(first.receipt.commandId, second.receipt.commandId);
    await app.capability.entered.promise;
    assert.equal(app.capability.replies, 1);
  } finally { await app.close(); }
});

test("usage JSON and schema require token and expose the same deduplicated totals as state", { timeout: 10000 }, async () => {
  const app = await setup(true);
  try {
    assert.equal((await fetch(`${app.url.origin}/api/usage`)).status, 403);
    assert.equal((await fetch(`${app.url.origin}/api/usage?token=invalid`)).status, 403);
    assert.equal((await fetch(`${app.url.origin}/api/usage/schema`)).status, 403);
    const state = app.capability.store.state!;
    const startedAt = new Date(Date.now() - 100).toISOString();
    const endedAt = new Date().toISOString();
    const invocation = { sdkEvent: "invocation.completed", invocationId: "metered-call", jobId: "job", depth: 0,
      provider: "fake", model: "test", startedAt, endedAt, status: "completed", durationMs: 100,
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 10 },
      prompt: "private prompt must not enter usage export",
    };
    await app.capability.store.emit(state, "job.event", invocation);
    await app.capability.store.emit(state, "job.event", invocation);
    await app.capability.store.emit(state, "job.completed", { jobId: "job", status: "completed", usage: { inputTokens: 999999, outputTokens: 1 } });
    // Session persists forwarded capability events before history returns.
    await app.session.history();
    const ledger = await fetch(`${app.url.origin}/api/usage${app.url.search}`).then((r) => r.json() as Promise<UsageLedger>);
    assert.equal(ledger.schemaVersion, 1);
    assert.equal(ledger.precision, "invocation");
    assert.equal(ledger.totals.invocationCount, 1);
    assert.equal(ledger.totals.totalTokens, 120);
    assert.equal(ledger.totals.cachedInputTokens, 80);
    assert.equal(ledger.totals.cacheWriteInputTokens, null);
    assert.equal(ledger.totals.wallElapsedMs, 100);
    assert.equal(JSON.stringify(ledger).includes("private prompt"), false);
    const projected = await fetch(`${app.url.origin}/api/state${app.url.search}`).then((r) => r.json() as Promise<SessionGuiState>);
    assert.deepEqual(projected.usage, ledger);
    const schema = await fetch(`${app.url.origin}/api/usage/schema${app.url.search}`).then((r) => r.json());
    assert.equal(schema.properties.schemaVersion.const, 1);
    assert.equal((await app.send(message)).status, 403);
  } finally { await app.close(); }
});
