/** Explicit, bounded real-provider test. Not part of the default test discovery. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { InitCapability } from "../src/capabilities/init/capability.ts";
import { CapabilityRegistry, FlywheelSession } from "../src/session/session.ts";
import { CodexAgentAdapter } from "../src/services/agent/codex-adapter.ts";
import { DefaultAgentService } from "../src/services/agent/service.ts";
import { PromptAssetStore } from "../src/services/prompt/index.ts";
import { startSessionGuiServer } from "../src/gui/server.ts";

if (!process.argv.includes("--run-real")) {
  console.log("Real model calls are disabled. Pass --run-real explicitly to run this bounded smoke.");
  process.exit(0);
}

const base = path.resolve(".test-runs/conversation-first-20261022");
await mkdir(base, { recursive: true });
const root = await mkdtemp(path.join(base, "run-"));
await cp(path.resolve("examples/prompt/support-reply-mock/project"), root, { recursive: true });
const originalGoal = await readFile(path.join(root, "goal.md"), "utf8");
const adapter = new CodexAgentAdapter();
const capability = new InitCapability({ projectRoot: root, confirmationMode: "brief",
  agent: new DefaultAgentService(adapter, new PromptAssetStore({ projectRoot: root })) });
const registry = new CapabilityRegistry().register("init", () => capability);
const session = new FlywheelSession(root, registry, ["init"]);
const started = performance.now();
const deadline = Date.now() + 120_000;
let exploreStarted = false;
let exploreCompleted = false;
let exploreStatus: unknown;
let managerCompletedAt: number | undefined;
let managerRespondedAt: number | undefined;
const realChunks: Array<{ elapsedMs: number; length: number; beforeJobCompletion: boolean }> = [];
let order = 0;
const lastTexts = new Map<string, string>();
const operations: string[] = [];
const report: Record<string, unknown> = { projectRoot: root, model: adapter.model, runReal: true,
  originalGoalLength: originalGoal.length, startedAt: new Date().toISOString() };
session.subscribe(event => {
  order += 1;
  const domain = event.data?.event as { type?: string; operation?: string; data?: Record<string, any> } | undefined;
  if (event.type !== "capability.event" || !domain) return;
  const data = domain.data ?? {};
  if (domain.type === "operation.started" && typeof data.operationId === "string") operations.push(data.operationId);
  if (domain.type === "job.started" && data.job === "init:explore") exploreStarted = true;
  if (domain.type === "job.completed" && data.job === "init:explore") {
    exploreCompleted = true; exploreStatus = data.status;
  }
  if (domain.type === "job.completed" && data.job === "init:manager") managerCompletedAt = order;
  if (domain.type === "manager.responded" && domain.operation === "conversation") managerRespondedAt = order;
  if (domain.type === "job.event" && data.job === "init:manager"
    && data.sdkEvent === "item.updated" && data.item?.type === "agent_message") {
    const id = String(data.item.id);
    const text = String(data.item.text ?? "");
    if (text && text !== lastTexts.get(id)) {
      realChunks.push({ elapsedMs: performance.now() - started, length: text.length,
        beforeJobCompletion: managerCompletedAt === undefined });
      lastTexts.set(id, text);
    }
  }
});
const gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
const running = session.dispatch({ type: "session.start" });
let caught: unknown;
const waitFor = async (check: () => boolean) => {
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Real preparation smoke reached its 120 second bound");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
console.log(JSON.stringify({ stage: "started", projectRoot: root, model: adapter.model, timeoutSeconds: 120 }));
try {
  await waitFor(() => exploreStarted);
  assert.equal(exploreCompleted, false, "Goal must be sent while exploration is active");
  const url = new URL(gui.url);
  const httpStarted = performance.now();
  const response = await fetch(new URL("/api/command" + url.search, url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "message", value: originalGoal, clientRequestId: "real-intake-goal", interactionId: null }),
    signal: AbortSignal.timeout(10_000),
  });
  report.httpStatus = response.status;
  report.admissionMs = performance.now() - httpStarted;
  const payload = await response.json() as { receipt?: { status: string }; error?: string };
  report.admissionReceiptStatus = payload.receipt?.status;
  if (response.status !== 202) report.httpError = payload.error;
  assert.equal(response.status, 202);
  assert.equal(payload.receipt?.status, "accepted");
  console.log(JSON.stringify({ stage: "accepted", httpStatus: response.status, admissionMs: report.admissionMs }));
  await waitFor(() => managerRespondedAt !== undefined && exploreCompleted);
  assert.equal(exploreStatus, "completed", "Ordinary goal intake must not abort exploration");
  const streamed = realChunks.filter(chunk => chunk.beforeJobCompletion);
  report.realChunksBeforeCompletion = streamed.length;
  report.firstManagerChunkMs = streamed[0]?.elapsedMs;
  assert.ok(streamed.length >= 2, "Expected at least two real provider increments before the Manager Job completed");
  console.log(JSON.stringify({ stage: "responded", realChunksBeforeCompletion: streamed.length, explorationStatus: exploreStatus }));
} catch (error) {
  caught = error;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await session.dispatch({ type: "session.stop" });
  await running;
  await gui.close();
  let frozen: string | undefined;
  try { frozen = await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  Object.assign(report, { elapsedMs: performance.now() - started, explorationStarted: exploreStarted,
    explorationStatus: exploreStatus ?? "not_finished", managerJobCompleted: managerCompletedAt !== undefined,
    managerResponded: managerRespondedAt !== undefined, realChunks,
    originalGoalFrozen: frozen !== undefined, originalGoalExact: frozen === undefined ? null : frozen === originalGoal,
    operations, snapshot: session.snapshot(), passed: caught === undefined,
    noAutomaticConfirmation: !operations.some(operation => operation === "generate_contract" || operation === "create_baseline") });
  const reportPath = path.join(root, "smoke-report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ stage: "stopped", passed: report.passed, reportPath,
    elapsedMs: report.elapsedMs, originalGoalExact: report.originalGoalExact, error: report.error }));
}
if (caught) process.exitCode = 1;
