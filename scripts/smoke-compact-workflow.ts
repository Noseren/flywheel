/** Explicit real-provider acceptance. Never imported by default automated tests.
 * TUI = actual readline command/render path with injected streams, not a screen test.
 * GUI = actual authenticated loopback HTTP command/state/receipt path, not browser clicks.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough, Writable } from "node:stream";
import { InitCapability } from "../src/capabilities/init/capability.ts";
import type { VerificationResult } from "../src/capabilities/compact-evaluation.ts";
import { RunCapability } from "../src/capabilities/run/capability.ts";
import { loadProject } from "../src/capabilities/run/project.ts";
import { CodexAgentAdapter } from "../src/services/agent/codex-adapter.ts";
import type { AgentAdapter } from "../src/services/agent/protocol.ts";
import { DefaultAgentService } from "../src/services/agent/service.ts";
import { PromptAssetStore } from "../src/services/prompt/index.ts";
import { CapabilityRegistry, FlywheelSession } from "../src/session/session.ts";
import { buildUsageLedger } from "../src/session/usage-ledger.ts";
import { runSessionTerminal } from "../src/tui/session-terminal.ts";
import { startSessionGuiServer, type SessionGuiServer } from "../src/gui/server.ts";
import type { ExecutionBudgetState } from "../src/session/execution-budget.ts";
import type { SessionEvent } from "../src/session/protocol.ts";

const argumentsList = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const position = argumentsList.indexOf(name);
  return position < 0 ? fallback : argumentsList[position + 1] ?? fallback;
};
const real = argumentsList.includes("--run-real");
// Experimental control arm only; production Policy and persisted permissions are unchanged.
const singleAgentControl = argumentsList.includes("--single-agent-control");
const prepareOnly = argumentsList.includes("--prepare-only");
const confirmationChoice = argumentsList.includes("--confirmation-choice");
if (!real && !prepareOnly) {
  console.log("No model calls. Use --prepare-only to inspect isolated fixtures, or --run-real to execute explicit acceptance.");
  process.exit(0);
}
if (real && prepareOnly) throw new Error("Choose --prepare-only or --run-real, not both");
const surfaceOption = option("--surface", "both");
if (!["tui", "gui", "both"].includes(surfaceOption)) throw new Error("--surface must be tui, gui, or both");
const surfaces = surfaceOption === "both" ? ["tui", "gui"] as const : [surfaceOption as "tui" | "gui"];
const model = option("--model", "gpt-6.1-sol");
const limitMs = Number(option("--max-active-ms", String(6 * 60_000)));
const maxAttempts = Number(option("--max-attempts", "1"));
const tokenLimit = Number(option("--max-tokens", "200000"));
if (!Number.isSafeInteger(tokenLimit) || tokenLimit <= 0) throw new Error("--max-tokens must be a positive safe integer");
if (!Number.isSafeInteger(limitMs) || limitMs <= 0) throw new Error("--max-active-ms must be a positive safe integer");
if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) throw new Error("--max-attempts must be a positive safe integer");
const fixtureSource = option("--fixture", "") ? path.resolve(option("--fixture", "")) : undefined;
const publicTestArgs = ["--test", "--test-reporter=tap", option("--public-test-file", fixtureSource ? "test/*.test.js" : "checks.test.mjs")];
const mutableRootOption = option("--mutable-root", fixtureSource ? "src" : "math.mjs");
if (!mutableRootOption || path.isAbsolute(mutableRootOption) || mutableRootOption.split(/[\\/]/).includes("..")) throw new Error("--mutable-root must be a project-relative path");
const mutableRoot = path.normalize(mutableRootOption);
const budgetLimits = { candidateAttempts: maxAttempts, activeMs: limitMs, knownTokens: tokenLimit };
const base = path.resolve(option("--output-root", ".test-runs/compact-workflow"));
await mkdir(base, { recursive: true });

const goal = fixtureSource ? await readFile(path.join(fixtureSource, "goal.md"), "utf8") : [
  "修复 math.mjs 导出的 add(a,b)，使两个有限数值正确相加。只允许修改 math.mjs，不修改 checks.test.mjs、README.md、goal.md 或 .flywheel 中冻结资产。",
  "已有 Node 内置测试 checks.test.mjs 是全部公开验收：使用当前环境 Node 的 node --test checks.test.mjs 实际执行，不需要网络、安装依赖或后台服务。",
  "这是确定性 Code Project 检查，全部测试公开，不合成 train/holdout，不需要任务模型或语义 judge。优先为现有测试写最小评价包装。",
  "以实际测试结果与 baseline 比较，公开反馈保留真实失败说明；完整检查通过且相对失败基线有改进才 retain，全部测试通过表示目标达成。",
  "允许失败的 baseline 建立 v1；保持评价资产冻结、候选隔离及可恢复版本。只做一次候选尝试，不做额外审计文档或 reviewer。不要读取认证文件、环境中的秘密或项目外的 verifier。",
].join("\n");

async function prepareFixture(surface: "tui" | "gui") {
  const directory = await mkdtemp(path.join(base, `${surface}-`));
  const root = path.join(directory, "project");
  await mkdir(root);
  if (fixtureSource) {
    await cp(fixtureSource, root, { recursive: true,
      filter: file => !path.relative(fixtureSource, file).split(path.sep).some(part => [".git", ".flywheel", "node_modules"].includes(part)),
    });
    // Preserve only tracking identity, never source hooks/config/history. A copy
    // that discards the index cannot distinguish tracked-but-ignored assets.
    const sourceRepo = spawnSync("git", ["-C", fixtureSource, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (sourceRepo.status === 0 && path.resolve(sourceRepo.stdout.trim()) === fixtureSource) {
      const tracked = spawnSync("git", ["-C", fixtureSource, "ls-files", "--stage", "-z"], { encoding: "utf8" });
      if (tracked.status !== 0) throw new Error(tracked.stderr);
      const copied: Array<{ file: string; mode: string }> = [];
      for (const entry of tracked.stdout.split("\0").filter(Boolean)) {
        const match = /^(100644|100755) [0-9a-f]+ 0\t([\s\S]+)$/.exec(entry);
        if (!match) throw new Error("Fixture tracking must contain only resolved regular files");
        const mode = match[1]!;
        const file = match[2]!;
        if (file.split(/[\\/]/).some(part => [".git", ".flywheel", "node_modules", ".."].includes(part)) || path.isAbsolute(file)) continue;
        try { await lstat(path.join(root, file)); copied.push({ file, mode }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      const initialized = spawnSync("git", ["-C", root, "init", "--template="], { encoding: "utf8" });
      if (initialized.status !== 0) throw new Error(initialized.stderr);
      if (copied.length) {
        if (copied.some(({ file }) => /[\r\n"]/.test(file))) throw new Error("Unsupported fixture path for stdin-paths");
        const hashed = spawnSync("git", ["-C", root, "hash-object", "-w", "--no-filters", "--stdin-paths"],
          { encoding: "utf8", input: copied.map(({ file }) => file).join("\n") + "\n", maxBuffer: 16 * 1024 * 1024 });
        if (hashed.status !== 0) throw new Error(hashed.stderr);
        const blobs = hashed.stdout.trim().split("\n");
        if (blobs.length !== copied.length) throw new Error("Fixture tracking blob count differs");
        const added = spawnSync("git", ["-C", root, "update-index", "-z", "--index-info"],
          { encoding: "utf8", input: copied.map(({ file, mode }, index) => `${mode} ${blobs[index]}\t${file}\0`).join(""), maxBuffer: 16 * 1024 * 1024 });
        if (added.status !== 0) throw new Error(added.stderr);
      }
    }
    return { directory, root };
  }
  await writeFile(path.join(root, "math.mjs"), "export function add(a, b) { return a - b; }\n");
  await writeFile(path.join(root, "checks.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './math.mjs';",
    "test('positive operands', () => assert.equal(add(2, 3), 5));",
    "test('negative operands', () => assert.equal(add(-4, -2), -6));",
    "test('zero identity', () => assert.equal(add(7, 0), 7));",
    "test('mixed signs', () => assert.equal(add(-2, 5), 3));",
  ].join("\n") + "\n");
  await writeFile(path.join(root, "README.md"), [
    "# Minimal public addition project", "",
    "The only implementation is math.mjs. The existing checks.test.mjs is the complete public test suite.",
    `Run tests without dependencies: ${process.execPath} --test checks.test.mjs`,
    "Do not change tests. Baseline failures are expected; preserve actual test output as evidence.",
  ].join("\n") + "\n");
  await writeFile(path.join(root, "goal.md"), goal);
  return { directory, root };
}

async function optionalJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function frozenInputs(root: string, relative = ""): Promise<Array<{ file: string; hash: string }>> {
  const files: Array<{ file: string; hash: string }> = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await frozenInputs(root, file));
    else if (entry.isFile()) {
      const parts = file.split(path.sep);
      const mutable = file === mutableRoot || file.startsWith(mutableRoot + path.sep);
      if (mutable && !parts.includes("tests") && !parts.includes("test") && !file.endsWith("_test.go")) continue;
      files.push({ file, hash: createHash("sha256").update(await readFile(path.join(root, file))).digest("hex") });
    }
    else throw new Error(`Fixture input must be a regular file or directory: ${file}`);
  }
  return files;
}

function publicCheck(root: string) {
  const check = spawnSync(process.execPath, publicTestArgs, { cwd: root, encoding: "utf8", timeout: 200_000, maxBuffer: 2 * 1024 * 1024 });
  return { status: check.status, signal: check.signal, error: check.error?.message,
    stdout: check.stdout, stderr: check.stderr,
    tests: Number(/^# tests (\d+)$/m.exec(check.stdout ?? "")?.[1] ?? 0),
    passed: Number(/^# pass (\d+)$/m.exec(check.stdout ?? "")?.[1] ?? 0),
    failed: Number(/^# fail (\d+)$/m.exec(check.stdout ?? "")?.[1] ?? 0) };
}

async function run(surface: "tui" | "gui") {
  const { directory, root } = await prepareFixture(surface);
  const reportPath = path.join(directory, "acceptance.json");
  const report: Record<string, unknown> = { surface, root, fixtureSource, runReal: real, model, budgetLimits, confirmationChoice, singleAgentControl,
    screenInteraction: false, entry: surface === "tui" ? "runSessionTerminal readline + Session command/event" : "startSessionGuiServer HTTP command/state/receipt + Session event",
    originalGoalLength: goal.length, startedAt: new Date().toISOString() };
  if (prepareOnly) {
    await writeFile(reportPath, JSON.stringify({ ...report, preparedOnly: true }, null, 2) + "\n");
    console.log(JSON.stringify({ stage: "prepared", surface, root, reportPath, modelCalls: 0 }));
    return true;
  }

  const preservedFiles = await frozenInputs(root);
  const baselinePublicCheck = publicCheck(root);
  report.baselinePublicCheck = baselinePublicCheck;
  assert.equal(baselinePublicCheck.error, undefined);
  assert.ok(baselinePublicCheck.tests > 0 && baselinePublicCheck.failed > 0, "Fixture must have real failing behavioral tests");

  const started = performance.now();
  const provider = new CodexAgentAdapter({ model });
  const adapter: AgentAdapter = singleAgentControl ? {
    provider: provider.provider, model: provider.model,
    run(job, signal) {
      if (job.parentJobId || (job.depth ?? 0) > 0) throw new Error("Single-agent experimental control forbids Child provider calls");
      return provider.run({ ...job, prompt: job.prompt.replace(/<bounded_assistance>[\s\S]*?<\/bounded_assistance>/g,
        "<experimental_control>This run is the single-agent control. Complete the job yourself; do not request delegation or assistance. All task, evaluation, scope and budget requirements remain unchanged.</experimental_control>") }, signal);
    },
  } : provider;
  const agent = new DefaultAgentService(adapter, new PromptAssetStore({ projectRoot: root }));
  let runCapability: RunCapability | undefined;
  const init = new InitCapability({ projectRoot: root, initialGoal: goal, agent, budgetLimits });
  const registry = new CapabilityRegistry().register("init", () => init).register("run", async () => {
    runCapability = new RunCapability(await loadProject(root), agent, { budgetLimits, maxIterations: maxAttempts });
    return runCapability;
  });
  const session = new FlywheelSession(root, registry, ["init", "run"]);
  const events: SessionEvent[] = [];
  const chunks: Array<{ elapsedMs: number; job: string; length: number; beforeJobCompletion: boolean }> = [];
  const completed = new Set<string>();
  const lastText = new Map<string, string>();
  const providerSessionIds = new Set<string>();
  const operationStarts: Array<{ capability: string | undefined; operation: string; elapsedMs: number }> = [];
  const assistanceEvents: Array<Record<string, unknown>> = [];
  let confirmationCount = 0;
  const asked = new Set<string>();
  const http: Array<{ route: string; status: number; elapsedMs: number }> = [];
  const unsubscribe = session.subscribe(event => {
    events.push(event);
    if (event.type === "interaction.requested") {
      const interaction = event.data?.interaction as { id?: string } | undefined;
      if (interaction?.id) asked.add(interaction.id);
    }
    const domain = event.type === "capability.event" ? event.data?.event as { type: string; operation?: string; jobId?: string; data?: Record<string, any> } : undefined;
    if (!domain) return;
    const data = domain.data ?? {};
    const job = String(data.jobId ?? domain.jobId ?? data.job ?? "unknown");
    if (domain.type === "operation.started") {
      const operation = { capability: event.capabilityId, operation: String(data.operationId ?? domain.operation), elapsedMs: performance.now() - started };
      operationStarts.push(operation);
      console.log(JSON.stringify({ stage: "operation", surface, ...operation }));
    }
    if (domain.type === "job.event" && String(data.sdkEvent).startsWith("assistance.")) {
      const entry = { elapsedMs: performance.now() - started, ...data };
      assistanceEvents.push(entry);
      console.log(JSON.stringify({ stage: "assistance", surface, event: data.sdkEvent, message: data.message }));
    }
    if (domain.type === "job.completed") completed.add(job);
    if (data.sdkEvent === "thread.started" && typeof data.thread_id === "string") providerSessionIds.add(data.thread_id);
    if (domain.type === "job.event" && data.sdkEvent === "item.updated" && data.item?.type === "agent_message") {
      const key = `${job}:${String(data.item.id)}`;
      const text = String(data.item.text ?? "");
      if (text && text !== lastText.get(key)) chunks.push({ elapsedMs: performance.now() - started, job,
        length: text.length, beforeJobCompletion: !completed.has(job) });
      lastText.set(key, text);
    }
  });
  let gui: SessionGuiServer | undefined;
  let terminal: Promise<unknown> | undefined;
  let starting: Promise<unknown> | undefined;
  const input = new PassThrough();
  let terminalText = "";
  const output = new Writable({ write(chunk, _encoding, callback) { terminalText += chunk.toString(); callback(); } });
  let interrupted = false;
  let deadlineReached = false;
  let stopPromise: Promise<unknown> | undefined;
  const stop = () => stopPromise ??= session.dispatch({ type: "session.stop" });
  const onInterrupt = () => { interrupted = true; void stop(); };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const timeout = setTimeout(() => { deadlineReached = true; void stop(); }, limitMs);
  const request = async (route: string, body?: Record<string, unknown>) => {
    const url = new URL(gui!.url);
    const began = performance.now();
    const response = await fetch(new URL(route + url.search, url), {
      ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    http.push({ route, status: response.status, elapsedMs: performance.now() - began });
    const value = await response.json();
    if (!response.ok) throw new Error(`GUI ${route} returned HTTP ${response.status}`);
    return value;
  };
  const waitFor = async (check: () => boolean) => {
    while (!check()) {
      if (interrupted) throw new Error("Smoke interrupted; this isolated Session was stopped");
      if (deadlineReached || performance.now() - started >= limitMs) throw new Error(`Surface deadline reached after ${limitMs}ms`);
      const snapshot = session.snapshot();
      if (snapshot.activeCapabilityStatus === "blocked" || snapshot.status === "stopped") throw new Error(snapshot.error ?? "Session stopped before acceptance completed");
      if (snapshot.pendingInteraction && snapshot.pendingInteraction.id !== "init.confirm_proposal") {
        throw new Error(`Unexpected interaction: ${snapshot.pendingInteraction.question}`);
      }
      // Run deliberately pauses on a verified target, with its reason in error.
      // Let the settled Run reach the structured outcome assertions below;
      // budget pauses and inconclusive/rejected results still cannot pass them.
      if (snapshot.status === "idle" && snapshot.activeCapabilityStatus === "paused" && snapshot.activeCapabilityId !== "run") {
        throw new Error(snapshot.error ?? "Preparation paused before acceptance completed");
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  let passed = false;
  try {
    console.log(JSON.stringify({ stage: "started", surface, root, model, timeoutSeconds: limitMs / 1000 }));
    if (surface === "tui") terminal = runSessionTerminal(session, { input, output });
    else {
      gui = await startSessionGuiServer(session, { port: 0, onListening: () => undefined });
      await writeFile(path.join(directory, "gui-connection.json"), JSON.stringify({ url: gui.url }) + "\n");
      starting = session.dispatch({ type: "session.start" });
    }
    await waitFor(() => session.snapshot().pendingInteraction?.id === "init.confirm_proposal" && session.snapshot().status !== "running");
    report.confirmationPresentedMs = performance.now() - started;
    const confirmation = "确认当前目标、评价方式和修改边界，按刚才展示的方案开始准备并继续优化。";
    confirmationCount += 1;
    if (surface === "tui") input.write((confirmationChoice ? "1" : confirmation) + "\n");
    else {
      const accepted = await request("/api/command", { type: confirmationChoice ? "submit" : "message", value: confirmationChoice ? "confirm" : confirmation,
        clientRequestId: `${surface}-compact-confirm`, interactionId: "init.confirm_proposal" });
      assert.equal(accepted.receipt?.status, "accepted");
    }
    await waitFor(() => session.snapshot().activeCapabilityId === "run" && session.snapshot().status === "idle");
    const final = await runCapability!.store.load();
    assert.equal(final.workflow, "compact");
    assert.ok(final.compact && final.compact.attempts >= 1 && final.compact.attempts <= maxAttempts, "Expected bounded actual candidate attempts");
    assert.equal(final.compact.history.length, final.compact.attempts, "Every candidate must finish actual verification and retention");
    assert.equal(confirmationCount, 1);
    assert.deepEqual([...asked].filter(id => id !== "init.confirm_proposal"), [], "Unexpected extra approval or question");
    assert.ok(operationStarts.some(event => event.operation === "verify_candidate"));
    assert.ok(chunks.some(chunk => chunk.beforeJobCompletion), "Expected an actual incremental provider text event");
    assert.equal(await readFile(path.join(root, ".flywheel/goal.md"), "utf8"), goal);
    if (surface === "gui") {
      const state = await request("/api/state");
      const receipts = await request("/api/commands");
      report.guiProjection = { status: state.snapshot?.status, commandCount: receipts.commands?.length, usage: state.usage };
      assert.deepEqual(state.usage?.totals, buildUsageLedger(events).totals, "GUI and backend must project the same usage ledger");
      assert.ok(receipts.commands?.some((receipt: { clientRequestId: string; status: string }) => receipt.clientRequestId === "gui-compact-confirm" && receipt.status === "completed"));
    } else {
      input.write("/usage\n");
      await waitFor(() => terminalText.includes("时间与 Token"));
      assert.ok(terminalText.includes("你："), "TUI must render the submitted confirmation");
      if (confirmationChoice) {
        assert.ok(events.some(event => event.type === "interaction.responded" && event.data?.inputKind === "choice"
          && event.data?.source === "tui" && event.data?.value === "confirm"), "TUI must submit its actual confirmation choice");
      } else assert.ok(terminalText.includes("已发送"), "TUI must render the submitted message receipt");
    }
    report.run = { status: final.status, iteration: final.iteration, attempts: final.compact?.attempts,
      history: final.compact?.history, pausedReason: final.execution.lastOutcome,
      versions: { v1: await runCapability!.versions.hasTag("v1"), v2: await runCapability!.versions.hasTag("v2") } };
    const baseline = await optionalJson<VerificationResult>(path.join(root, ".flywheel/runtime/preparation-baseline/result.json"));
    assert.ok(baseline, "Expected the actual preparation baseline result");
    assert.equal(baseline.status, "completed");
    assert.equal(baseline.retention, "inconclusive");
    assert.equal(baseline.target, "not_achieved", "The original implementation must fail the goal");
    assert.ok(final.compact.history.some(entry => entry.retained), "An improved candidate must actually be retained");
    assert.ok(final.iteration >= 2);
    assert.equal(await runCapability!.versions.hasTag("v2"), true);
    assert.ok(final.compact?.baselineResultPath);
    const retainedResult = await optionalJson<VerificationResult>(final.compact.baselineResultPath);
    assert.ok(retainedResult);
    assert.equal(retainedResult.status, "completed");
    assert.equal(retainedResult.retention, "retain");
    assert.equal(retainedResult.target, "achieved");
    for (const { file, hash } of preservedFiles) {
      assert.equal(createHash("sha256").update(await readFile(path.join(root, file))).digest("hex"), hash, `${file} must remain unchanged`);
    }
    const finalPublicCheck = publicCheck(root);
    report.verifiedOutcome = { baseline, retainedResult, publicCheck: finalPublicCheck, preservedFiles: preservedFiles.map(({ file }) => file) };
    assert.equal(finalPublicCheck.error, undefined);
    assert.equal(finalPublicCheck.tests, baselinePublicCheck.tests, "The same public tests must be executed");
    assert.equal(finalPublicCheck.status, 0, "The retained official version must independently pass the unchanged public tests");
    passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    report.preStopSnapshot = session.snapshot();
    try {
      if (surface === "tui" && terminal) input.write("/stop\n");
      else if (gui) await request("/api/command", { type: "stop", clientRequestId: `${surface}-compact-stop` });
    } catch { /* Direct same-Session cancellation below is the fallback. */ }
    await stop();
    await starting?.catch(() => undefined);
    await terminal?.catch(() => undefined);
    input.end();
    await gui?.close();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
    unsubscribe();
    // Preserve the Session envelope so phase/session identity matches UI replay.
    const ledger = buildUsageLedger(events);
    const budget = await optionalJson<ExecutionBudgetState>(path.join(root, ".flywheel/runtime/execution-budget.json"));
    const finalRun = await optionalJson<Record<string, unknown>>(path.join(root, ".flywheel/runtime/state.json"));
    Object.assign(report, { passed, interrupted, deadlineReached, wallMs: performance.now() - started,
      confirmationCount, interactionIds: [...asked], streamChunks: chunks, streamChunkCount: chunks.length,
      chunksBeforeJobCompletion: chunks.filter(chunk => chunk.beforeJobCompletion).length,
      providerSessionIds: [...providerSessionIds], operations: operationStarts, http, assistanceEvents,
      usage: ledger, budget: budget ? { limits: budget.limits, activeMs: budget.activeMs, knownTokens: budget.knownTokens,
        unknownUsageInvocations: budget.unknownUsageInvocations, repairUsed: budget.repairUsed, attempts: budget.attempts,
        assistance: budget.assistance, reservations: budget.reservations } : null,
      finalSnapshot: session.snapshot(), finalRunState: finalRun, receipts: await session.commandReceipts() });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    if (surface === "tui") await writeFile(path.join(directory, "tui-output.log"), terminalText);
    console.log(JSON.stringify({ stage: "stopped", surface, passed, reportPath,
      wallMs: report.wallMs, knownTokens: budget?.knownTokens ?? null, unknownUsageInvocations: budget?.unknownUsageInvocations ?? null,
      streamChunkCount: chunks.length, confirmationCount, interrupted, deadlineReached }));
  }
  return passed;
}

let passed = true;
for (const surface of surfaces) {
  if (!await run(surface)) passed = false;
}
if (!passed) process.exitCode = 1;
