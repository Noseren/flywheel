// Explicit GUI acceptance fixture. No model or user project is involved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DurableStateStore } from "../../src/services/state/index.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import { startSessionGuiServer } from "../../src/gui/server.ts";
import type { Capability, CapabilityExecutionState, CapabilityState, CapabilityStore } from "../../src/session/protocol.ts";

type State = CapabilityState & { execution: CapabilityExecutionState };
type Event = { id: string; timestamp: string; type: string; operation: string; status: string; data?: Record<string, unknown> };
class FaultStore extends DurableStateStore<State, Event> {
  locked = false;
  replacements = 0;
  protected override async renameTemporary(source: string, destination: string): Promise<void> {
    if (destination === this.statePath && this.locked) {
      this.replacements++;
      throw Object.assign(new Error(`EPERM: simulated state replacement denied: ${destination}`), { code: "EPERM" });
    }
    await super.renameTemporary(source, destination);
  }
}

const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-gui-state-recovery-"));
const durable = new FaultStore({ statePath: path.join(root, ".flywheel", "fixture-state.json"),
  eventsPath: path.join(root, ".flywheel", "fixture-events.jsonl"), validateState: value => value as State, eventId: event => event.id });
let injected = false;
let executions = 0;
let acknowledged = false;
const eventFor = (state: State, type: string, data?: Record<string, unknown>): Event => ({
  id: randomUUID(), timestamp: new Date().toISOString(), type, operation: "check", status: state.status, data,
});
const store: CapabilityStore<State> = {
  load: () => durable.load(), save: state => durable.save(state),
  emit: (state, type, data) => durable.append(eventFor(state, type, data)),
  commit: async (state, type, data) => {
    if (!injected) { injected = true; durable.locked = true; }
    await durable.commit(state, eventFor(state, type, data));
  },
  subscribe: listener => durable.subscribe(listener), history: () => durable.history(),
};
const capability: Capability<{}, State> = {
  id: "run", grants: [], store,
  createState: async () => ({ status: "running", execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} } }),
  services: () => ({}),
  // A deterministic fixture Manager, not evidence of model intent recognition.
  manager: {
    onFailure: async () => undefined,
    onIntervention: async ({ state, message }) => {
      assert.equal(message, "重试");
      assert.equal(durable.locked, false);
      assert.equal(state.status, "waiting_for_user");
      delete state.lastError;
      acknowledged = true;
      await store.emit(state, "manager.responded", { action: "stay_paused", message: "模拟恢复检查：落盘状态已恢复，已完成步骤没有重复执行。请查看恢复后的问题。" });
      return state;
    },
  },
  policySource: async () => ({ id: "state-recovery-fixture", revision: "1", operations: {
    check: async () => {
      executions++;
      return { status: "waiting_for_user", interaction: { id: "durable-result", capabilityId: "run", operationId: "check", kind: "text",
        requestedBy: { type: "runtime" }, question: "模拟检查结果已恢复。此步骤不应重复执行。", description: "这是状态故障验收，不是真实优化结果。" } };
    },
  }, decide: () => ({ type: "run", operationId: "check" }) }),
};
const registry = new CapabilityRegistry().register("run", () => capability);
let session = new FlywheelSession(root, registry, ["run"]);
let gui = await startSessionGuiServer(session, { port: 0 });
await session.dispatch({ type: "session.start" });
while (session.snapshot().status !== "idle") await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(session.snapshot().activeCapabilityStatus, "blocked");
assert.match(session.snapshot().error ?? "", /EPERM/);
assert.equal(executions, 1);
const old = JSON.parse(await readFile(durable.statePath, "utf8")) as State;
assert.equal(old.status, "running");
const pending = JSON.parse(await readFile(durable.transitionPath, "utf8")) as { eventId: string; state: State };
assert.equal(pending.state.status, "waiting_for_user");
const sessionId = session.snapshot().sessionId;
console.log(JSON.stringify({ root, phase: "locked", snapshot: session.snapshot(), replacements: durable.replacements, executions,
  instructions: "After inspecting GUI, send unlock to stdin. Then inspect restored GUI and send finish." }));
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "unlock") {
    durable.locked = false;
    await session.dispatch({ type: "session.stop" });
    await gui.close();
    session = new FlywheelSession(root, registry, ["run"]);
    await session.restorePaused();
    gui = await startSessionGuiServer(session, { port: 0 });
    assert.equal(session.snapshot().sessionId, sessionId);
    assert.equal(session.snapshot().status, "idle");
    assert.equal(executions, 1);
    assert.equal((await durable.load()).status, "waiting_for_user");
    assert.equal((await durable.history()).filter(event => event.id === pending.eventId).length, 1);
    assert.equal((await durable.history()).filter(event => event.id === pending.eventId).length, 1);
    await assert.rejects(readFile(durable.transitionPath), { code: "ENOENT" });
    console.log(JSON.stringify({ phase: "restored", snapshot: session.snapshot(), executions, completionEvents: 1,
      instructions: "In the new GUI send 重试, verify the recovered question, then send finish to stdin." }));
  } else if (line.trim() === "finish") {
    assert.equal(acknowledged, true);
    assert.equal(session.snapshot().activeCapabilityStatus, "waiting_for_user");
    assert.equal(session.snapshot().pendingInteraction?.id, "durable-result");
    assert.equal(session.snapshot().error, undefined);
    assert.equal(executions, 1);
    assert.equal((await durable.history()).filter(event => event.type === "operation.completed").length, 1);
    console.log(JSON.stringify({ phase: "accepted", snapshot: session.snapshot(), executions, completionEvents: 1 }));
    await session.dispatch({ type: "session.stop" });
    await gui.close();
    lines.close();
    break;
  }
}
