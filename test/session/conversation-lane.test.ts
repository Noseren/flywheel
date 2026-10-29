import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InitCapability } from "../../src/capabilities/init/capability.ts";
import { CapabilityRegistry, FlywheelSession } from "../../src/session/session.ts";
import type { AgentJobResult, AgentService } from "../../src/services/agent/protocol.ts";
import type { JobSpec } from "../../src/services/agent/job-protocol.ts";
import type { PromptRequest } from "../../src/services/prompt/index.ts";
import type { SessionEvent } from "../../src/session/protocol.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for observable session state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function hold(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException("Cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
  });
}

function variable(prompt: PromptRequest, key: string): unknown {
  if (prompt.variables?.[key] !== undefined) return prompt.variables[key];
  for (const value of Object.values(prompt.variables ?? {})) {
    if (value && typeof value === "object" && "kind" in value) {
      const nested = variable(value as PromptRequest, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

class PreparationAgent implements AgentService {
  readonly explorer = deferred();
  readonly reply = deferred();
  exploreStarted = false;
  exploreFinished = false;
  exploreAborted = false;
  replyStarted = false;
  replyFinished = false;
  replyAborted = false;
  exploreCount = 0;
  async execute(job: JobSpec, signal?: AbortSignal): Promise<AgentJobResult> {
    if (job.label.startsWith("init:explore")) {
      this.exploreStarted = true;
      this.exploreCount += 1;
      try { await hold(this.explorer.promise, signal); }
      catch (error) { this.exploreAborted = true; throw error; }
      this.exploreFinished = true;
      const context = variable(job.prompt, "context_card_path") as string;
      await mkdir(path.dirname(context), { recursive: true });
      await writeFile(context, "公开项目事实：prompt.txt 是待改善对象。\n");
    } else if (job.label === "init:manager") {
      this.replyStarted = true;
      await job.onEvent?.({ sdkEvent: "thread.started", thread_id: "intake-provider-session" });
      await job.onEvent?.({ sdkEvent: "message.delta", itemId: "manager-reply", sequence: 1, delta: "收到目标，" });
      await job.onEvent?.({ sdkEvent: "message.delta", itemId: "manager-reply", sequence: 2, delta: "正在检查评价方式。" });
      try { await hold(this.reply.promise, signal); }
      catch (error) { this.replyAborted = true; throw error; }
      const messages = variable(job.prompt, "messages") as Array<{ id: string; text: string }>;
      const file = variable(job.prompt, "decision_path") as string;
      await writeFile(file, JSON.stringify({ message: "收到目标，正在检查评价方式。",
        goalMessageIds: messages.filter(m => m.text.includes("改善")).map(m => m.id) }));
      this.replyFinished = true;
      return { status: "completed", artifacts: [], sessionId: "intake-provider-session" };
    } else if (job.label.startsWith("init:plan")) {
      const directory = path.join(job.cwd, ".flywheel", "init");
      await writeFile(path.join(directory, "proposal.md"), "项目完整计划，保留所有要求与权限。\n");
      await writeFile(path.join(directory, "proposal.json"), JSON.stringify({
        artifactPath: "prompt.txt", documentPath: ".flywheel/init/proposal.md",
        userFacingSummary: "目标：改善真实回复。\n评价：检查公开样例中的实际输出。",
      }));
    } else throw new Error(`Unexpected Job: ${job.label}`);
    return { status: "completed", artifacts: [] };
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-conversation-lane-"));
  await writeFile(path.join(root, "prompt.txt"), "Answer accurately.\n");
  const agent = new PreparationAgent();
  const capability = new InitCapability({ projectRoot: root, agent, confirmationMode: "brief" });
  const registry = new CapabilityRegistry().register("init", () => capability);
  const session = new FlywheelSession(root, registry, ["init"]);
  const events: SessionEvent[] = [];
  session.subscribe(event => events.push(event));
  return { root, agent, capability, registry, session, events };
}

test("Session durably accepts and streams intake while project exploration continues independently", async () => {
  const { root, session, agent, capability, events } = await fixture();
  const running = session.dispatch({ type: "session.start" });
  try {
    await until(() => agent.exploreStarted);
    const receipt = await session.accept({ type: "intervention.submit", message: "改善客服回复。", source: "gui" }, "during-exploration");
    assert.equal(receipt.status, "accepted");
    assert.match(await readFile(path.join(root, ".flywheel", "runtime", "commands.jsonl"), "utf8"), /during-exploration/);
    await until(() => agent.replyStarted && events.filter(event => {
      const domain = event.data?.event as { type?: string; data?: { sdkEvent?: string } } | undefined;
      return event.type === "capability.event" && domain?.type === "job.event" && domain.data?.sdkEvent === "message.delta";
    }).length === 2);
    assert.equal(agent.replyFinished, false);
    assert.equal(agent.exploreFinished, false);
    assert.equal(agent.exploreAborted, false);
    assert.equal(session.snapshot().status, "running");
    const stateBefore = await capability.store.load();
    assert.equal(stateBefore.execution.currentOperationId, "explore");
    agent.reply.resolve();
    await until(async () => (await session.commandReceipt("during-exploration"))?.status === "completed");
    assert.equal((await capability.store.load()).execution.currentOperationId, "explore");
    assert.equal(agent.exploreAborted, false);
    agent.explorer.resolve();
    await running;
    assert.equal(session.snapshot().pendingInteraction?.id, "init.confirm_proposal");
    assert.equal((await capability.store.load()).execution.currentOperationId, "confirm_proposal");
    assert.equal(agent.exploreCount, 1);
    assert.equal(await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"), "改善客服回复。");
    assert.equal(capability.conversation.canAccept(undefined), false,
      "a stale or absent Session snapshot must not reopen intake after the goal was frozen");
  } finally { agent.explorer.resolve(); agent.reply.resolve(); await session.dispatch({ type: "session.stop" }); await running; }
});

test("a message arriving while the project Capability is activating joins intake without replacing the runner", async () => {
  const { root, capability, agent } = await fixture();
  const activating = deferred();
  let entered = false;
  const registry = new CapabilityRegistry().register("init", async () => {
    entered = true;
    await activating.promise;
    return capability;
  });
  const session = new FlywheelSession(root, registry, ["init"]);
  const running = session.dispatch({ type: "session.start" });
  agent.reply.resolve();
  try {
    await until(() => entered);
    await session.accept({ type: "intervention.submit", message: "改善项目实际回复。" }, "during-activation");
    // Observe durable admission/execution while the factory remains unavailable.
    await until(async () => (await session.commandReceipt("during-activation"))?.status !== "accepted");
    activating.resolve();
    await until(async () => ["completed", "failed"].includes((await session.commandReceipt("during-activation"))?.status ?? ""));
    const receipt = await session.commandReceipt("during-activation");
    assert.equal(receipt?.status, "completed", receipt?.error);
    assert.equal(agent.exploreAborted, false);
    agent.explorer.resolve();
    await running;
    assert.equal(session.snapshot().pendingInteraction?.id, "init.confirm_proposal");
    assert.equal(agent.exploreCount, 1);
  } finally { activating.resolve(); agent.explorer.resolve(); agent.reply.resolve(); await running; await session.dispatch({ type: "session.stop" }); }
});

test("waiting goal replies use the conversation lane and preserve exact original text across restore", async () => {
  const { root, session, agent, registry, capability } = await fixture();
  agent.explorer.resolve();
  agent.reply.resolve();
  try {
    await session.dispatch({ type: "session.start" });
    assert.equal(session.snapshot().pendingInteraction?.id, "init.goal");
    const original = "  改善客服回复，保留 ExactField。\n\n";
    const receipt = await session.accept({ type: "interaction.respond", interactionId: "init.goal", value: original,
      inputKind: "text", source: "tui" }, "waiting-goal");
    assert.equal(receipt.status, "accepted");
    await until(async () => (await session.commandReceipt("waiting-goal"))?.status === "completed");
    assert.equal(session.snapshot().pendingInteraction?.id, "init.confirm_proposal");
    assert.equal(await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"), original);
    assert.equal((await capability.store.load()).answers.initialGoal, original);
    const restored = new FlywheelSession(root, registry, ["init"]);
    await restored.restorePaused();
    assert.equal(restored.snapshot().pendingInteraction?.id, "init.confirm_proposal");
    assert.equal(restored.snapshot().sessionId, session.snapshot().sessionId);
    assert.equal(agent.exploreCount, 1);
    await restored.dispatch({ type: "session.stop" });
  } finally { await session.dispatch({ type: "session.stop" }); }
});

test("stop during Capability activation cannot launch an Agent after reporting stopped", async () => {
  const { root, capability, agent } = await fixture();
  const activating = deferred();
  let entered = false;
  const registry = new CapabilityRegistry().register("init", async () => {
    entered = true;
    await activating.promise;
    return capability;
  });
  const session = new FlywheelSession(root, registry, ["init"]);
  const running = session.dispatch({ type: "session.start" });
  try {
    await until(() => entered);
    const stopping = session.dispatch({ type: "session.stop" });
    activating.resolve();
    agent.explorer.resolve();
    await stopping;
    await running;
    assert.equal(session.snapshot().status, "stopped");
    assert.equal(agent.exploreStarted, false, "an activation cancelled before its provider call must not launch exploration");
  } finally { activating.resolve(); agent.explorer.resolve(); agent.reply.resolve(); await running; await session.dispatch({ type: "session.stop" }); }
});

test("exploration completing during intake waits for the current goal instead of freezing an earlier draft", async () => {
  const { root, session, agent, capability } = await fixture();
  const running = session.dispatch({ type: "session.start" });
  try {
    await until(() => agent.exploreStarted);
    await session.accept({ type: "intervention.submit", message: "改善回复并保留 ExactField。" }, "overlap-completion");
    await until(() => agent.replyStarted);
    agent.explorer.resolve();
    await until(async () => (await capability.store.load()).execution.currentOperationId === "await_goal");
    assert.equal(agent.replyFinished, false);
    await assert.rejects(readFile(path.join(root, ".flywheel", "goal.md")), { code: "ENOENT" });
    assert.equal(session.snapshot().status, "running");
    agent.reply.resolve();
    await running;
    await until(async () => (await session.commandReceipt("overlap-completion"))?.status === "completed");
    assert.equal(session.snapshot().pendingInteraction?.id, "init.confirm_proposal");
    assert.equal(await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"), "改善回复并保留 ExactField。");
    assert.equal(agent.exploreCount, 1);
  } finally { agent.explorer.resolve(); agent.reply.resolve(); await session.dispatch({ type: "session.stop" }); await running; }
});

test("stop cancels intake while the runner is waiting to apply the draft", async () => {
  const { root, session, agent, capability } = await fixture();
  const running = session.dispatch({ type: "session.start" });
  try {
    await until(() => agent.exploreStarted);
    await session.accept({ type: "intervention.submit", message: "改善回复。" }, "stop-at-apply");
    await until(() => agent.replyStarted);
    agent.explorer.resolve();
    await until(async () => (await capability.store.load()).execution.currentOperationId === "await_goal");
    await session.dispatch({ type: "session.stop" });
    await running;
    assert.equal(agent.replyAborted, true);
    assert.equal(session.snapshot().status, "stopped");
    await assert.rejects(readFile(path.join(root, ".flywheel", "goal.md")), { code: "ENOENT" });
    assert.equal((await capability.store.load()).status, "paused");
  } finally { agent.explorer.resolve(); agent.reply.resolve(); await session.dispatch({ type: "session.stop" }); await running; }
});

test("stopping Session cancels both the live intake and explorer before returning", async () => {
  const { session, agent, capability, events } = await fixture();
  const running = session.dispatch({ type: "session.start" });
  try {
    await until(() => agent.exploreStarted);
    await session.accept({ type: "intervention.submit", message: "改善回复。" }, "cancel-intake");
    await until(() => agent.replyStarted);
    await session.dispatch({ type: "session.stop" });
    await running;
    assert.equal(agent.replyAborted, true);
    assert.equal(agent.exploreAborted, true);
    assert.equal(session.snapshot().status, "stopped");
    assert.equal((await capability.store.load()).status, "paused");
    assert.equal(events.at(-1)?.type, "session.stopped");
    await until(async () => (await session.commandReceipt("cancel-intake"))?.status === "failed");
    assert.equal(events.filter(event => event.type === "capability.resumed").length, 0);
  } finally { agent.explorer.resolve(); agent.reply.resolve(); await session.dispatch({ type: "session.stop" }); await running; }
});
