import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Capability, CapabilityRequest, CapabilityStore } from "../../src/session/protocol.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../src/session/policy.ts";
import type { CapabilityCommand, CapabilityExecutionState, CapabilityState } from "../../src/session/protocol.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";

interface TestState extends CapabilityState { execution: CapabilityExecutionState }

class MemoryStore implements CapabilityStore<TestState> {
  state?: TestState;
  readonly listeners = new Set<(event: unknown) => void>();
  async load(): Promise<TestState> {
    if (!this.state) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return this.state;
  }
  async save(state: TestState): Promise<void> { this.state = state; }
  async emit(_state: TestState, type: string, data?: Record<string, unknown>): Promise<void> {
    for (const listener of this.listeners) listener({ type, data });
  }
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
}

class InterruptibleCapability implements Capability<{}, TestState, CapabilityCommand> {
  readonly grants: string[] = [];
  readonly store = new MemoryStore();
  readonly id: string;
  readonly completeImmediately: boolean;
  interventions: string[] = [];
  starts = 0;
  protected request?: CapabilityRequest;
  readonly manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: TestState; message: string }) => {
      this.request = { type: "intervene", message };
      this.interventions.push(message);
      state.status = "running" as const;
      return state;
    },
  };

  constructor(id: string, completeImmediately = false) {
    this.id = id;
    this.completeImmediately = completeImmediately;
  }

  readonly policySource = async (): Promise<ExecutionPolicy<{}, TestState, CapabilityCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: `${this.id}-policy`, revision: "1", operations: { work: async ({ signal }) => await this.work(signal) },
    decide: ({ lastOutcome }) => lastOutcome?.status === "completed" ? { type: "complete" } : { type: "run", operationId: "work" },
  });

  async createState(): Promise<TestState> {
    return { status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } };
  }

  async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    this.request = request;
    state.status = "running";
    return state;
  }

  services(): {} { return {}; }

  protected async work(signal: AbortSignal): Promise<PolicyOutcome<Record<string, unknown>>> {
    if (this.request?.type === "start") {
      this.starts += 1;
      if (this.completeImmediately) return { status: "completed" };
      return await new Promise((resolve) => signal.addEventListener(
        "abort", () => resolve({ status: "paused" }), { once: true },
      ));
    }
    if (this.request?.type === "resume") return { status: "completed" };
    if (this.request?.type === "intervene") return { status: "paused" };
    throw new Error("No interaction expected");
  }
}

test("paused restore hydrates state and identity without executing or rewriting history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-paused-restore-"));
  const capability = new InterruptibleCapability("work");
  const registry = new CapabilityRegistry().register("work", () => capability);
  const first = new FlywheelSession(root, registry, ["work"]);
  const running = first.dispatch({ type: "session.start" });
  for (let attempt = 0; capability.starts === 0 && attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(capability.starts, 1);
  await first.dispatch({ type: "capability.abort" });
  await running;
  const history = await readFile(first.eventsPath, "utf8");
  const identity = await readFile(first.identityPath, "utf8");
  const second = new FlywheelSession(root, registry, ["work"]);
  await second.restorePaused();
  assert.equal(second.snapshot().sessionId, first.snapshot().sessionId);
  assert.equal(second.snapshot().status, "idle");
  assert.equal(second.snapshot().activeCapabilityStatus, "paused");
  assert.equal(capability.starts, 1);
  assert.equal(await readFile(first.eventsPath, "utf8"), history);
  assert.equal(await readFile(first.identityPath, "utf8"), identity);
});

class FailingCapability extends InterruptibleCapability {
  constructor() { super("failing"); }
  override readonly manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: TestState; message: string }) => {
      this.request = { type: "intervene", message };
      this.interventions.push(message);
      state.status = "completed" as const;
      return state;
    },
  };
  override async prepare(state: TestState, request: CapabilityRequest): Promise<TestState> {
    if (request.type === "start") throw new Error("旧状态无法加载");
    return await super.prepare(state, request);
  }
}

test("paused restore exposes a Session exception absent from persisted Capability state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-paused-exception-"));
  const capability = new FailingCapability();
  const registry = new CapabilityRegistry().register(capability.id, () => capability);
  const first = new FlywheelSession(root, registry, [capability.id]);
  const failed = await first.dispatch({ type: "session.start" });
  // Model a state-file replacement failure: only Session's append-only audit survived.
  capability.store.state!.status = "running";
  delete capability.store.state!.lastError;
  delete capability.store.state!.pendingInteraction;
  const original = structuredClone(capability.store.state);
  const before = await readFile(first.eventsPath, "utf8");
  const restored = new FlywheelSession(root, registry, [capability.id]);
  await restored.restorePaused();
  assert.equal(restored.snapshot().activeCapabilityStatus, "blocked");
  assert.equal(restored.snapshot().error, failed.error);
  assert.deepEqual(restored.snapshot().pendingInteraction, failed.pendingInteraction);
  assert.deepEqual(capability.store.state, original);
  assert.equal(await readFile(first.eventsPath, "utf8"), before);
  assert.equal(capability.starts, 0);
});

class CleanupCapability extends InterruptibleCapability {
  cleaned = false;
  managerSawCleanState = false;
  constructor() { super("cleanup"); }
  override readonly manager = {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }: { state: TestState; message: string }) => {
      this.managerSawCleanState = this.cleaned;
      this.request = { type: "intervene", message };
      this.interventions.push(message);
      state.status = "running" as const;
      return state;
    },
  };
  protected override async work(signal: AbortSignal): Promise<PolicyOutcome<Record<string, unknown>>> {
    if (this.request?.type === "intervene") return { status: "paused" };
    return await new Promise((resolve) => signal.addEventListener("abort", () => {
      setTimeout(() => { this.cleaned = true; resolve({ status: "paused" }); }, 10);
    }, { once: true }));
  }
}

class StoppedCapability extends InterruptibleCapability {
  constructor() { super("limited"); }
  override async prepare(state: TestState): Promise<TestState> {
    state.status = "stopped";
    state.lastError = "Maximum iteration limit reached (2)";
    return state;
  }
}

class CountingCapability extends InterruptibleCapability {
  executions = 0;
  constructor() { super("counting"); }
  override readonly policySource = async (): Promise<ExecutionPolicy<{}, TestState, CapabilityCommand, PolicyOutcome<Record<string, unknown>>>> => ({
    id: "counting-policy", revision: "1", operations: { work: async () => {
      this.executions += 1; return { status: "completed" };
    } },
    decide: () => this.executions === 3 ? { type: "complete" } : { type: "run", operationId: "work" },
  });
}

test("session owns the continuous loop and requests one bounded operation at a time", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-runner-"));
  const capability = new CountingCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register(capability.id, () => capability), [capability.id]);
  const snapshot = await session.dispatch({ type: "session.start" });
  assert.equal(snapshot.status, "idle");
  assert.equal(capability.executions, 3);
});

test("session aborts to idle, records intervention, resumes, and chains capabilities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-"));
  const first = new InterruptibleCapability("first");
  const second = new InterruptibleCapability("second", true);
  const registry = new CapabilityRegistry().register("first", () => first).register("second", () => second);
  const session = new FlywheelSession(root, registry, ["first", "second"]);
  const running = session.dispatch({ type: "session.start" });
  while (session.snapshot().status !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  await session.dispatch({ type: "capability.abort" });
  await running;
  await session.dispatch({ type: "intervention.submit", message: "缩小改动范围" });
  await session.dispatch({ type: "capability.resume" });
  assert.deepEqual(first.interventions, ["缩小改动范围"]);
  assert.equal(second.starts, 1);
  assert.equal(session.snapshot().status, "idle");
  const events = (await readFile(session.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const identity = JSON.parse(await readFile(session.identityPath, "utf8"));
  assert.equal(events[0].type, "session.started");
  assert.equal(events[0].sessionId, identity.sessionId);
  assert.ok(events.some((event) => event.type === "capability.aborting"));
  assert.ok(events.some((event) => event.type === "intervention.submitted"));
  assert.ok(events.some((event) => event.type === "capability.switched" && event.data.to === "second"));
});

test("session exposes capability startup failures as a visible blocked state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-failure-"));
  const capability = new FailingCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("failing", () => capability), ["failing"]);
  const snapshot = await session.dispatch({ type: "session.start" });
  assert.equal(snapshot.activeCapabilityStatus, "blocked");
  assert.equal(snapshot.error, "旧状态无法加载");
  assert.match(snapshot.pendingInteraction!.id, /^session-blocked-recovery:/);
  const recovered = await session.dispatch({
    type: "interaction.respond", interactionId: snapshot.pendingInteraction!.id, value: "已处理，请重试",
  });
  assert.equal(recovered.status, "idle");
  assert.deepEqual(capability.interventions, ["已处理，请重试"]);
});

test("session waits for active Job cleanup before opening the Capability Manager", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-clean-abort-"));
  const capability = new CleanupCapability();
  const session = new FlywheelSession(root, new CapabilityRegistry().register("cleanup", () => capability), ["cleanup"]);
  const running = session.dispatch({ type: "session.start" });
  while (session.snapshot().status !== "running") await new Promise((resolve) => setTimeout(resolve, 1));
  await session.dispatch({ type: "intervention.submit", message: "先解释状态" });
  await running;
  assert.equal(capability.managerSawCleanState, true);
  assert.equal(session.snapshot().activeCapabilityStatus, "paused");
});

test("session does not start a Capability after aborting during durable startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-start-abort-"));
  const capability = new InterruptibleCapability("startup");
  const session = new FlywheelSession(root, new CapabilityRegistry().register("startup", () => capability), ["startup"]);
  let abort: Promise<unknown> | undefined;
  session.subscribe((event) => { if (event.type === "capability.started") abort = session.dispatch({ type: "capability.abort" }); });
  await session.dispatch({ type: "session.start" });
  await abort;
  assert.equal(capability.starts, 0);
  assert.equal(session.snapshot().status, "idle");
});

test("a terminal capability stop ends the session instead of advertising resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-session-stopped-"));
  const session = new FlywheelSession(root, new CapabilityRegistry().register("limited", () => new StoppedCapability()), ["limited"]);
  const snapshot = await session.dispatch({ type: "session.start" });
  assert.equal(snapshot.status, "stopped");
  assert.equal(snapshot.activeCapabilityStatus, "stopped");
  assert.equal((await session.history()).at(-1)?.type, "session.stopped");
});
