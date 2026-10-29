import assert from "node:assert/strict";
import test from "node:test";
import { buildUsageLedger } from "../../src/session/usage-ledger.ts";

const time = (ms: number) => new Date(Date.UTC(2026, 9, 22) + ms).toISOString();
function call(id: string, jobId: string, start: number, end: number, parentJobId?: string) {
  return { type: "capability.event", sessionId: "s", capabilityId: "run", timestamp: time(end), data: { event: {
    id, scope: "run", timestamp: time(end), type: "job.event", operation: "tasking", data: {
      sdkEvent: "invocation.completed", invocationId: id, jobId, parentJobId, depth: parentJobId ? 1 : 0,
      provider: "mock", model: "test", startedAt: time(start), endedAt: time(end), durationMs: end - start,
      status: "completed", usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 10 },
    },
  } } };
}
test("ledger counts real parent turns and children once, ignoring aggregate/replay", () => {
  const calls = [call("p1", "parent", 0, 100), call("c1", "child1", 100, 300, "parent"), call("c2", "child2", 100, 300, "parent"), call("p2", "parent", 300, 400)];
  const aggregate = { scope: "run", timestamp: time(400), type: "job.completed", data: { jobId: "parent", usage: { inputTokens: 400, outputTokens: 80 } } };
  const ledger = buildUsageLedger([...calls, ...calls, { type: "capability.event", sessionId: "s", capabilityId: "run", data: { event: aggregate } }], { now: time(1000) });
  assert.equal(ledger.precision, "invocation");
  assert.equal(ledger.totals.invocationCount, 4);
  assert.equal(ledger.totals.totalTokens, 480);
  assert.equal(ledger.totals.cachedInputTokens, 320);
  assert.equal(ledger.totals.cacheWriteInputTokens, null);
  assert.equal(ledger.totals.wallElapsedMs, 400);
  assert.equal(ledger.totals.invocationDurationMs, 600);
  assert.equal(ledger.groups.phase.optimization.invocationCount, 4);
  assert.equal(ledger.groups.model["mock/test"].totalTokens, 480);
});
test("partial failed usage stays known with unknown attempts and excludes offline gaps", () => {
  const started = { sdkEvent: "invocation.started", invocationId: "pending", startedAt: time(0), jobId: "pending" };
  const stopped = { type: "session.stopped", timestamp: time(200) };
  const later = call("next", "next", 10000, 10100);
  const ledger = buildUsageLedger([started, stopped, later, started], { now: time(20000) });
  assert.equal(ledger.totals.invocationCount, 2);
  assert.equal(ledger.totals.unknownInvocationCount, 1);
  assert.equal(ledger.totals.wallElapsedMs, 300);
  assert.equal(ledger.totals.invocationDurationMs, 300);
  assert.equal(ledger.totals.totalTokens, 120);
  assert.equal(ledger.invocations[0].status, "interrupted");
  assert.equal(ledger.invocations[0].usage.inputTokens, null);
  assert.equal(JSON.stringify(ledger).includes("prompt"), false);
});
test("legacy job roots provide explicitly approximate totals without child double counting", () => {
  const root = { id: "root", type: "job.completed", scope: "init", timestamp: time(300), data: { jobId: "root", durationMs: 300, status: "completed", usage: { inputTokens: 30, outputTokens: 5 } } };
  const child = { ...root, id: "child", data: { ...root.data, jobId: "child", parentJobId: "root", depth: 1 } };
  const ledger = buildUsageLedger([root, child, root], { now: time(400) });
  assert.equal(ledger.precision, "legacy-job");
  assert.equal(ledger.totals.invocationCount, 1);
  assert.equal(ledger.totals.totalTokens, 35);
  assert.equal(ledger.unknowns.legacyPrecision, true);
  assert.equal(ledger.groups.phase.preparation.totalTokens, 35);
});
test("missing token fields remain null and invalid provider counts are not accepted", () => {
  const event = { sdkEvent: "invocation.completed", invocationId: "failed", status: "failed", startedAt: time(0), endedAt: time(10), usage: { inputTokens: -1, outputTokens: 5 } };
  const ledger = buildUsageLedger([event]);
  assert.equal(ledger.totals.inputTokens, null);
  assert.equal(ledger.totals.totalTokens, 5);
  assert.equal(ledger.totals.unknownInvocationCount, 1);
  assert.equal(ledger.invocations[0].status, "failed");
});
test("process restart bounds unclosed work at last observation instead of charging offline hours", () => {
  const events = [
    { sdkEvent: "invocation.started", invocationId: "crashed", startedAt: time(0) },
    { type: "job.event", timestamp: time(100), data: { sdkEvent: "item.updated" } },
    { type: "session.attached", timestamp: time(3600000) },
    call("resumed", "resumed", 3600000, 3600100),
  ];
  const ledger = buildUsageLedger(events, { now: time(4000000) });
  assert.equal(ledger.totals.wallElapsedMs, 200);
  assert.equal(ledger.invocations[0].endedAt, time(100));
});
test("unrelated legacy history remains visible alongside modern invocations", () => {
  const historical = { type: "capability.event", capabilityId: "run", sessionId: "s", data: { event: {
    id: "old-event", type: "job.completed", timestamp: time(50), operation: "assess_target",
    data: { jobId: "old-root", status: "completed", durationMs: 50, usage: { inputTokens: 10, outputTokens: 5 } },
  } } };
  const ledger = buildUsageLedger([historical, call("new", "new-root", 100, 200)]);
  assert.equal(ledger.precision, "mixed");
  assert.equal(ledger.totals.totalTokens, 135);
  assert.equal(ledger.unknowns.legacyPrecision, true);
});

test("pre-invocation budget rejections do not fabricate unknown calls while genuine legacy failures remain", () => {
  const completed = (id: string, data: Record<string, unknown>) => ({ type: "capability.event", sessionId: "s", capabilityId: "init",
    timestamp: time(300), data: { event: { id, type: "job.completed", scope: "init", timestamp: time(300), operation: "confirm_proposal",
      data: { jobId: id, status: "failed", ...data } } } });
  const rejected = completed("rejected", { errorCode: "EXECUTION_BUDGET_EXHAUSTED", invocationStarted: false,
    error: "Execution budget exhausted: tokens" });
  const earlyTrace = completed("early-budget-trace", { error: "Execution budget exhausted: tokens" });
  const historical = completed("historical-failed", { error: "Provider unavailable" });
  const actualUnknown = completed("actual-unknown", { error: "Execution budget exhausted: time", durationMs: 30 });
  const actualStarted = completed("actual-started", { error: "Execution budget exhausted: tokens", invocationStarted: true });
  const modern = call("real", "actual", 0, 100);
  const ledger = buildUsageLedger([modern, rejected, earlyTrace, historical, actualUnknown, actualStarted, rejected]);
  assert.equal(ledger.totals.invocationCount, 4);
  assert.equal(ledger.totals.unknownInvocationCount, 3);
  assert.equal(ledger.totals.totalTokens, 120);
  assert.deepEqual(ledger.invocations.filter(entry => entry.precision === "legacy-job").map(entry => entry.jobId).sort(),
    ["actual-started", "actual-unknown", "historical-failed"]);
  assert.equal(ledger.unknowns.legacyPrecision, true);
});
