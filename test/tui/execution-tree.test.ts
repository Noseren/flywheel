import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import type { RunEvent } from "../../src/capabilities/run/protocol.ts";
import type { InitEvent } from "../../src/capabilities/init/protocol.ts";
import { ExecutionTreeProjection } from "../../src/tui/execution-tree.ts";
import { FullScreenView, isNonPressKeyEvent, TUI_COMMANDS } from "../../src/tui/full-screen.ts";
import { FakeTerminal } from "../helpers/fake-terminal.ts";

function runtimeEvent(type: RunEvent["type"], data?: Record<string, unknown>): RunEvent {
  return {
    id: `run-${sequence}`,
    timestamp: `2026-08-07T00:00:0${sequence++}.000Z`,
    type,
    version: "v1",
    operation: "tasking",
    status: type === "runtime.blocked" ? "blocked" : "running",
    data,
  };
}

let sequence = 0;

test("stage audit counts recorded repairs once and never presents a blocked return as success", () => {
  const tree = new ExecutionTreeProjection("mock");
  tree.ingestDomain("run", runtimeEvent("operation.started"));
  const repair = runtimeEvent("artifact.repair.started", { artifactId: "evaluator", attempt: 1 });
  tree.ingestDomain("run", repair);
  tree.ingestDomain("run", repair);
  tree.ingestDomain("run", { ...runtimeEvent("artifact.validation.failed"), type: "init.evaluator.repair.requested",
    data: { source: "independent-review", attempt: 1, invalidChecks: 2 } } as unknown as InitEvent);
  tree.ingestDomain("run", runtimeEvent("job.event", { item: { type: "agent_message", text: "修复了 99 次" } }));
  tree.ingestDomain("run", runtimeEvent("operation.completed", { status: "blocked" }));
  let node = tree.nodesSnapshot().find((node) => node.kind === "operation")!;
  assert.equal(node.status, "blocked");
  assert.equal(node.progress?.starts, 1);
  assert.equal(node.progress?.artifactRepairs, 1);
  assert.equal(node.progress?.evaluatorReturns, 1);
  assert.match(node.progress?.lastIssue?.text ?? "", /2 项检查无效/);
  tree.ingestDomain("run", runtimeEvent("operation.started"));
  node = tree.nodesSnapshot().find((node) => node.kind === "operation")!;
  assert.equal(node.progress?.starts, 2);
  assert.equal(node.completedAt, undefined);
  tree.ingestDomain("run", runtimeEvent("operation.completed", { status: "waiting_for_user" }));
  assert.equal(tree.nodesSnapshot().find((node) => node.kind === "operation")?.status, "waiting");
  tree.ingestDomain("run", runtimeEvent("operation.completed", { status: "completed" }));
  assert.equal(tree.nodesSnapshot().find((node) => node.kind === "operation")?.status, "completed");
});

test("late starts cannot resurrect completed Jobs, but newer resumes can", () => {
  const tree = new ExecutionTreeProjection("mock");
  const done = { ...runtimeEvent("job.completed", { job: "checker", jobId: "checker-1", status: "completed" }), timestamp: "2026-09-08T00:00:00.000Z" };
  tree.ingestDomain("run", done);
  tree.ingestDomain("run", { ...done, id: "late-start", type: "job.started", data: { job: "checker", jobId: "checker-1" } });
  assert.equal(tree.nodesSnapshot().find((node) => node.kind === "agent")?.status, "completed");
  tree.ingestDomain("run", { ...done, id: "resume", timestamp: "2026-09-08T00:00:01.000Z", type: "job.started", data: { job: "checker", jobId: "checker-1" } });
  const resumed = tree.nodesSnapshot().find((node) => node.kind === "agent");
  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.completedAt, undefined);
  assert.equal(resumed?.metadata.status, "running");
});

test("execution projection exposes capability/operation and jobs while retaining detailed audit nodes", () => {
  sequence = 0;
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestSession({ timestamp: "2026-08-07T00:00:00.000Z", type: "session.started", data: { chain: ["run"] } });
  tree.ingestSession({ timestamp: "2026-08-07T00:00:01.000Z", type: "capability.started", capabilityId: "run" });
  tree.ingestDomain("run", runtimeEvent("operation.started"));
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "tasking:sample-a" }));
  tree.ingestDomain("run", runtimeEvent("job.event", { job: "tasking:sample-a", sdkEvent: "turn.started" }));
  tree.ingestDomain("run", runtimeEvent("job.event", {
    job: "tasking:sample-a",
    sdkEvent: "item.started",
    item: { id: "cmd-1", type: "command_execution", command: "npm test", status: "in_progress" },
  }));
  tree.ingestDomain("run", runtimeEvent("job.event", {
    job: "tasking:sample-a",
    sdkEvent: "item.completed",
    item: { id: "cmd-1", type: "command_execution", command: "npm test", status: "completed", exit_code: 0, aggregated_output: "36 tests passed" },
  }));
  tree.ingestDomain("run", runtimeEvent("job.event", { job: "tasking:sample-a", sdkEvent: "turn.completed", usage: {} }));
  tree.ingestDomain("run", runtimeEvent("job.completed", { job: "tasking:sample-a", status: "completed" }));
  tree.ingestDomain("run", runtimeEvent("operation.completed"));

  const nodes = tree.visible().map(({ node }) => node);
  assert.deepEqual(tree.navigation().map(({ node }) => node.kind), ["capability", "operation"]);
  assert.deepEqual(tree.jobs().map((node) => node.label), ["管理 Agent", "tasking:sample-a"]);
  assert.deepEqual(nodes.map((node) => node.kind), ["project", "capability", "iteration", "operation", "agent", "turn", "command"]);
  assert.equal(nodes.find((node) => node.kind === "agent")?.status, "completed");
  assert.equal(nodes.find((node) => node.kind === "turn")?.status, "completed");
  assert.equal(nodes.find((node) => node.kind === "command")?.status, "completed");
  assert.match(nodes.find((node) => node.kind === "command")?.lines.join("\n") ?? "", /退出码 0/);
});

test("execution tree deduplicates persisted and active-history replay", () => {
  sequence = 0;
  const tree = new ExecutionTreeProjection("demo");
  const started = runtimeEvent("job.started", { job: "same-agent" });
  tree.ingestDomain("run", started);
  tree.ingestDomain("run", started);
  assert.equal(tree.visible().filter(({ node }) => node.kind === "agent").length, 1);
});

test("legacy completion identity drift closes the running operation instead of creating a false version", () => {
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestDomain("run", {
    ...runtimeEvent("operation.started", { operationId: "select" }),
    version: "v1", operation: "select", operationRunId: "select-v1",
  });
  tree.ingestDomain("run", {
    ...runtimeEvent("operation.completed", { operationId: "select", nextOperationId: "tasking" }),
    version: "v2", operation: "tasking",
  });

  const operations = tree.navigation().map(({ node }) => node).filter((node) => node.kind === "operation");
  assert.deepEqual(operations.map((node) => `${node.parentId}:${node.label}`), ["capability:run/iteration:v1:select"]);
  assert.equal(operations[0]?.status, "completed");
});

test("the Agent Job column nests delegated Child Jobs under their parent Agent", () => {
  sequence = 0;
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "tasking:v1", jobId: "root", depth: 0 }));
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "sample:a", jobId: "root/a", parentJobId: "root", depth: 1 }));
  tree.ingestDomain("run", runtimeEvent("job.completed", { job: "sample:a", jobId: "root/a", parentJobId: "root", depth: 1, status: "completed" }));
  const jobs = tree.jobs();
  assert.deepEqual(jobs.map((node) => node.label), ["管理 Agent", "tasking:v1", "sample:a"]);
  assert.equal(jobs[2]?.parentId, jobs[1]?.id);
});

test("same-label siblings remain distinct and complete by Runtime Job ID", () => {
  sequence = 0;
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "parent", jobId: "root", depth: 0 }));
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "inspect", jobId: "root/a", parentJobId: "root", depth: 1 }));
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "inspect", jobId: "root/b", parentJobId: "root", depth: 1 }));
  tree.ingestDomain("run", runtimeEvent("job.completed", { job: "inspect", jobId: "root/a", parentJobId: "root", depth: 1, status: "completed" }));
  const children = tree.jobs().filter((node) => node.metadata.depth === 1);
  assert.equal(children.length, 2);
  assert.equal(children.filter((node) => node.status === "completed").length, 1);
  assert.equal(children.find((node) => node.status === "completed")?.metadata.jobId, "root/a");
});

test("replayed Init Manager calls stay under one Capability-level Manager lane", () => {
  const tree = new ExecutionTreeProjection("demo");
  let eventSequence = 0;
  const event = (type: string, data?: Record<string, unknown>): InitEvent => ({
    id: `init-${eventSequence}`,
    sequence: eventSequence,
    timestamp: `2026-08-09T00:00:${String(eventSequence++).padStart(2, "0")}.000Z`,
    scope: "init",
    projectRoot: "/tmp/demo",
    operation: "confirm_proposal",
    type,
    data,
  });
  const job = "initialization manager";
  tree.ingestDomain("init", event("job.started", { job, sessionKey: "manager", resumed: true }));
  tree.ingestDomain("init", event("job.event", { job, sdkEvent: "thread.started", thread_id: "manager-session" }));
  tree.ingestDomain("init", event("job.event", { job, sdkEvent: "turn.started" }));
  tree.ingestDomain("init", event("job.event", { job, sdkEvent: "turn.completed" }));
  tree.ingestDomain("init", event("job.completed", { job, status: "completed", sessionId: "manager-session" }));
  tree.ingestDomain("init", event("job.started", { job, sessionKey: "manager", resumed: true }));
  tree.ingestDomain("init", event("job.event", { job, sdkEvent: "thread.started", thread_id: "manager-session" }));
  tree.ingestDomain("init", event("job.event", { job, sdkEvent: "turn.started" }));
  tree.ingestDomain("init", event("job.event", { job, sdkEvent: "turn.completed" }));
  tree.ingestDomain("init", event("job.completed", { job, status: "completed", sessionId: "manager-session" }));

  const jobs = tree.jobs();
  assert.deepEqual(tree.navigation().map(({ node }) => node.kind), ["capability", "operation"]);
  assert.equal(tree.selectedNavigation().kind, "capability");
  assert.deepEqual(jobs.map((item) => item.kind), ["manager"]);
  assert.equal(jobs[0]?.metadata.sessionId, "manager-session");
  assert.ok((jobs[0]?.lines.length ?? 0) > 0);
});

test("Manager role metadata routes a named proposal Job outside its current Operation", () => {
  const tree = new ExecutionTreeProjection("demo");
  const initEvent = (type: string, data?: Record<string, unknown>): InitEvent => ({
    id: `${type}:${sequence++}`,
    sequence,
    timestamp: new Date().toISOString(),
    scope: "init",
    projectRoot: "/tmp/demo",
    operation: "prepare_recommendation",
    type,
    data,
  });
  tree.ingestDomain("init", initEvent("job.started", { job: "initialization proposal", sessionKey: "manager" }));
  tree.ingestDomain("init", initEvent("job.event", {
    job: "initialization proposal", sessionKey: "manager", sdkEvent: "job.started", label: "init:plan",
  }));
  tree.ingestDomain("init", initEvent("job.completed", { job: "initialization proposal", status: "completed" }));

  assert.equal(tree.selectedNavigation().kind, "capability");
  assert.deepEqual(tree.jobs().map((node) => node.label), ["管理 Agent"]);
  const operation = tree.navigation().find(({ node }) => node.kind === "operation")?.node;
  assert.equal(operation?.children.some((id) => tree.get(id)?.kind === "agent"), false);
});

test("three-column selection switches between operation details and jobs", () => {
  sequence = 0;
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestDomain("run", runtimeEvent("job.started", { job: "agent-a" }));
  assert.equal(tree.selected().kind, "agent");
  tree.focusNavigation();
  assert.equal(tree.selected().kind, "operation");
  tree.focusJobs();
  assert.equal(tree.selected().kind, "manager");
  tree.selectJob(1);
  assert.equal(tree.selected().kind, "agent");
  tree.focusDetails();
  assert.equal(tree.selector(), "details");
  assert.equal(tree.selected().kind, "agent");
  tree.focusJobs();
  tree.focusNavigation();
  tree.selectNavigation(-1);
  assert.equal(tree.selected().kind, "capability");
  assert.deepEqual(tree.jobs().map((node) => node.kind), ["manager"]);
});

test("plain arrow keys move from an active job back to the previous operation", async () => {
  const tree = new ExecutionTreeProjection("demo");
  const event = (operation: string, type: RunEvent["type"], data?: Record<string, unknown>) => ({
    id: `${operation}:${type}`, timestamp: new Date().toISOString(), type, version: "v1", operation, status: "running", data,
  }) as RunEvent;
  tree.ingestDomain("run", event("inspect", "operation.started"));
  tree.ingestDomain("run", event("inspect", "operation.completed"));
  tree.ingestDomain("run", event("explore", "job.started", { job: "explorer" }));

  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as Writable & {
    columns: number; rows: number;
  };
  output.columns = 100;
  output.rows = 30;
  const screen = new FullScreenView({
    terminal: new FakeTerminal(input, output),
    projection: tree,
    chain: ["run"],
    projectRoot: "/tmp/demo",
    onSubmit: () => undefined,
    onEscape: () => undefined,
    onCtrlC: () => undefined,
  });
  screen.open();
  input.write("\u001b[D");
  input.write("\u001b[A");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(tree.selector(), "navigation");
  assert.equal(tree.selectedNavigation().label, "inspect");
  screen.close();
});

test("Escape sends one abort request instead of reaching the editor", async () => {
  const tree = new ExecutionTreeProjection("demo");
  const input = new PassThrough();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } }) as Writable & {
    columns: number; rows: number;
  };
  output.columns = 100;
  output.rows = 30;
  let aborts = 0;
  const screen = new FullScreenView({
    terminal: new FakeTerminal(input, output),
    projection: tree,
    chain: ["run"],
    projectRoot: "/tmp/demo",
    onSubmit: () => undefined,
    onEscape: () => { aborts += 1; },
    onCtrlC: () => undefined,
  });
  screen.open();

  input.write("\u001b");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(aborts, 1);
  assert.equal(screen.editor.getText(), "");
  screen.close();
});

test("panel navigation ignores terminal key repeats and releases", () => {
  assert.equal(isNonPressKeyEvent("\u001b[1;1:1A"), false);
  assert.equal(isNonPressKeyEvent("\u001b[1;1:2A"), true);
  assert.equal(isNonPressKeyEvent("\u001b[1;1:3A"), true);
});

test("repeated CLI attachments remain one logical session in the projection", () => {
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestSession({ sessionId: "stable-session", timestamp: "2026-08-07T00:00:00.000Z", type: "session.started" });
  tree.ingestSession({ sessionId: "stable-session", timestamp: "2026-08-07T00:00:01.000Z", type: "session.attached" });
  assert.equal(tree.hasKind("session"), false);
  assert.equal(tree.get(tree.rootId)?.metadata.sessionId, "stable-session");
});

test("execution tree represents human interactions and gates as first-class nodes", () => {
  sequence = 0;
  const tree = new ExecutionTreeProjection("demo");
  tree.ingestSession({ timestamp: "2026-08-07T00:00:00.000Z", type: "session.started" });
  tree.ingestSession({
    timestamp: "2026-08-07T00:00:01.000Z",
    type: "interaction.requested",
    capabilityId: "init",
    data: { interaction: {
      id: "goal", capabilityId: "init", operationId: "confirm_proposal",
      requestedBy: { type: "agent", label: "初始化管理 Agent", sessionKey: "manager" },
      question: "确认 Flywheel Goal？",
    } },
  });
  tree.ingestDomain("run", runtimeEvent("gate.opened", { reason: "风险修改需要确认" }));
  tree.ingestDomain("run", runtimeEvent("gate.resolved", { decision: "continue" }));

  const nodes = tree.visible().map(({ node }) => node);
  const interaction = nodes.find((node) => node.kind === "interaction");
  assert.equal(interaction?.status, "waiting");
  assert.match(interaction?.label ?? "", /初始化管理 Agent/);
  assert.equal(nodes.find((node) => node.kind === "gate")?.status, "completed");
});

test("slash commands remain available through the pi editor", () => {
  assert.deepEqual(TUI_COMMANDS.map((item) => item.command), ["/abort", "/resume", "/usage", "/stop", "/quit"]);
});
