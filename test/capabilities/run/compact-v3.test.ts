import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunCapability } from "../../../src/capabilities/run/capability.ts";
import { loadProject } from "../../../src/capabilities/run/project.ts";
import { VersionStore } from "../../../src/services/version/index.ts";
import { runCapability } from "../../../src/session/runner.ts";
import type { AgentService } from "../../../src/services/agent/protocol.ts";
import { sha256 } from "../../../src/services/workspace/index.ts";
import { validateJobSpec } from "../../../src/services/agent/job-validation.ts";
import { DefaultAgentService } from "../../../src/services/agent/service.ts";
import { PromptAssetStore } from "../../../src/services/prompt/index.ts";
import { InitCapability } from "../../../src/capabilities/init/capability.ts";
import { COMPACT_ASSISTANCE_REVISION } from "../../../src/capabilities/compact-assistance.ts";

async function fixture(target = "not_achieved", judging = false, acceptance = "explicit", longDiagnostics = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-compact-run-"));
  const contract = path.join(root, ".flywheel", "contract");
  await mkdir(contract, { recursive: true });
  await mkdir(path.join(root, ".flywheel", "init"), { recursive: true });
  await writeFile(path.join(root, "artifact.txt"), "old");
  await writeFile(path.join(root, ".flywheel", "goal.md"), "Improve the artifact");
  await writeFile(path.join(contract, "task.md"), "Improve the artifact");
  if (judging) await writeFile(path.join(contract, "evaluate_guide.md"), "Independently judge evidence into judge.json.");
  await writeFile(path.join(contract, "boundary.json"), JSON.stringify({ schemaVersion: 1,
    artifact: { path: "artifact.txt" }, change_scope: { primary: ["artifact.txt"] } }));
  await writeFile(path.join(contract, "verification.json"), JSON.stringify({ schemaVersion: 1,
    command: process.execPath, args: ["{evaluator}"], timeoutMs: 10000, acceptance, ...(judging ? { judging: true } : {}) }));
  await writeFile(path.join(contract, "evaluator.mjs"), `import fs from 'node:fs/promises';
let input='';for await(const c of process.stdin)input+=c;
const r=JSON.parse(input);const good=(await fs.readFile(r.artifactPath,'utf8'))==='new';
await fs.mkdir(r.outputDir,{recursive:true});await fs.writeFile(r.outputDir+'/evidence.txt',${longDiagnostics ? "'PRIVATE_EVIDENCE_MARKER'" : "good?'good':'bad'"});
console.log(JSON.stringify({schemaVersion:1,status:'completed',retention:good?'retain':'reject',
target:good?'${target}':'not_achieved',summary:${JSON.stringify(longDiagnostics ? "PRIVATE_SUMMARY_MARKER" : "checked")},
publicFeedback:${longDiagnostics ? "r.mode+':'+await fs.readFile(r.artifactPath,'utf8')+':'+'x'.repeat(11900)+':ActualError: missing deferred fragment'" : "'Improve the public artifact'"},evidence:['evidence.txt']}));`);
  const files = await Promise.all([["goal", ".flywheel/goal.md"], ["task", ".flywheel/contract/task.md"],
    ["boundary", ".flywheel/contract/boundary.json"], ["verification", ".flywheel/contract/verification.json"],
    ["evaluator", ".flywheel/contract/evaluator.mjs"],
    ...(judging ? [["evaluate-guide", ".flywheel/contract/evaluate_guide.md"]] : []),
  ].map(async ([id, file]) => ({ id, path: file, sha256: await sha256(path.join(root, file)) })));
  await writeFile(path.join(root, ".flywheel", "init", "manifest.json"), JSON.stringify({
    schemaVersion: 4, workflow: "compact", status: "ready", baseline: "v1", files }));
  const project = await loadProject(root);
  await new VersionStore(project).tag("v1", "baseline");
  return project;
}

import { COMPONENT_ROUTING_REVISION } from "../../../src/capabilities/component-routing-revision.ts";

for (const { search, assessment, unbounded = false, stopNegative = false } of [{ search: false, assessment: "achieved" }, { search: true, assessment: "achieved" }, { search: false, assessment: "not_achieved" }, { search: false, assessment: "inconclusive" }, { search: false, assessment: "achieved", unbounded: true }, { search: false, assessment: "not_achieved", stopNegative: true }]) test(`v3 ${stopNegative ? "stop then negative " : ""}${unbounded ? 'unbounded ' : ''}${search ? 'search plus combination' : 'base'} independent ${assessment} decision controls exit and keeps Router public`, async () => {
  const project = await fixture("achieved", false, "explicit", true);
  project.assistanceRevision = COMPONENT_ROUTING_REVISION;
  const jobs: string[] = [];
  let optimizers = 0, selects = 0, reviews = 0;
  const capability = new RunCapability(project, { execute: async job => {
    validateJobSpec(job); jobs.push(job.operation); const callId = `test-call-${jobs.length}`; await job.executionBudget!.startInvocation(callId, job.invocationReservation);
    let prompt = job.prompt; while (prompt.variables?.job_prompt) prompt = prompt.variables.job_prompt as typeof prompt; const v = prompt.variables!;
    if (job.operation === "component_routing") {
      const input = await readFile(String(v.context_path), "utf8");
      assert.doesNotMatch(input, /PRIVATE_(SUMMARY|EVIDENCE|TARGET)_MARKER|USER_ONLY_TARGET_MARKER/);
      const publicContext = JSON.parse(input.split("# Public context\n")[1].split("\n\n# Public evidence IDs")[0]);
      if (v.decision_path) {
        if (unbounded) assert.equal(publicContext.remainingCandidates, "unbounded");
        else assert.ok(Number.isSafeInteger(publicContext.remainingCandidates) && publicContext.remainingCandidates >= 0, JSON.stringify(publicContext));
        await writeFile(String(v.decision_path), JSON.stringify(search && String(v.window) === "R3"
          ? { action: "request_component", component: "search", reason: "Compare independent public approaches", evidence: ["context"] }
          : { action: stopNegative && String(v.window) === "R4" ? "stop_search" : "continue_base", reason: "Use the base route", evidence: ["context"] }));
      } else {
        if (v.component === "review") reviews++;
        await writeFile(String(v.report_path), JSON.stringify({ schemaVersion: 1, summary: "Public evidence inspected", evidence: ["context"],
          ...(v.component === "review" ? { decision: "approve" } : { hypotheses: [{ id: "a", task: "First public approach" }, { id: "b", task: "Second public approach" }] }) }));
      }
    } else if (job.operation === "optimize") {
      assert.doesNotMatch(JSON.stringify(job.prompt), /PRIVATE_(SUMMARY|EVIDENCE|TARGET)_MARKER|USER_ONLY_TARGET_MARKER/);
      optimizers++; await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    } else if (job.operation === "select_candidates") {
      selects++;
      const candidates = v.candidates as {id:string}[];
      await writeFile(String(v.report_path), JSON.stringify(selects === 1
        ? { schemaVersion: 1, decision: "combine", sourceIds: candidates.map(c => c.id) }
        : { schemaVersion: 1, decision: "promote", candidateId: candidates.at(-1)!.id }));
    } else if (job.operation === "assess_target") {
      const source = job.readRoots.find(file => file.includes("formal-source") && file.endsWith("artifact.txt"));
      assert.ok(source, "independent assessor can inspect the exact formal implementation");
      assert.equal(await readFile(source, "utf8"), "new");
      assert.ok(job.readRoots.some(file => file.endsWith("evidence.txt")));
      await writeFile(String(v.report_path), JSON.stringify({ schemaVersion: 1, decision: assessment, reason: "PRIVATE_TARGET_MARKER", evidence: [source],
        ...(assessment === "inconclusive" ? { userSummary: { summary: "USER_ONLY_TARGET_MARKER：已执行检查通过，组合证据不足。", unresolved: ["尚未确认两种公开选项同时启用的行为。"] } } : {}) }));
    } else assert.fail(`Unexpected job ${job.operation}`);
    if (job.resultPath) await writeFile(job.resultPath, JSON.stringify({ status: "completed", artifacts: [v.report_path ?? v.decision_path].filter(Boolean) }));
    await job.executionBudget!.finishInvocation(callId, { inputTokens: 100, outputTokens: 100 }); return { status: "completed", usage: { inputTokens: 100, outputTokens: 100 } };
  } }, unbounded ? { budgetLimits: { mode: "unbounded", candidateAttempts: null, activeMs: null, knownTokens: null } }
    : { maxIterations: assessment === "not_achieved" && !stopNegative ? 1 : 3, budgetLimits: { candidateAttempts: 3, activeMs: 1_800_000, knownTokens: 2_000_000 } });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(state.iteration, 2, state.lastError);
  assert.equal(state.compact?.routing?.assessment?.decision, assessment, state.lastError);
  if (assessment === "inconclusive") {
    assert.match(state.lastError ?? "", /USER_ONLY_TARGET_MARKER/);
    assert.match(state.lastError ?? "", /尚未确认两种公开选项/);
    assert.match(state.lastError ?? "", /不会自动继续调用模型/);
    assert.doesNotMatch(state.lastError ?? "", /PRIVATE_TARGET_MARKER/);
  }
  assert.equal(optimizers, search ? 3 : stopNegative ? 2 : 1);
  if (stopNegative) {
    assert.equal(jobs.filter(operation => operation === "assess_target").length, 1);
    assert.equal(state.compact?.routing?.negativeRoutedBinding, state.compact?.routing?.assessment?.binding);
    const routed = jobs.filter(operation => operation === "component_routing").length;
    // Simulate a paused v3 state persisted before this field existed.
    delete state.compact!.routing!.negativeRoutedBinding;
    await capability.store.save(state);
    const resumed = await runCapability(capability, { type: "resume" }, new AbortController().signal);
    assert.equal(resumed.status, "paused", resumed.lastError);
    assert.equal(optimizers, 3);
    assert.equal(jobs.filter(operation => operation === "assess_target").length, 1);
    assert.ok(jobs.filter(operation => operation === "component_routing").length <= routed + 2);
  }
  assert.equal(selects, search ? 2 : 0);
  assert.equal(reviews, search ? 3 : 0);
  if (!stopNegative) assert.equal(jobs.at(-1), "assess_target");
  const events = await capability.store.history();
  assert.equal(events.some(event => event.type === "operation.activity" && event.data?.attempt && event.data?.target === "achieved"), false);
  assert.ok(events.some(event => event.type === "operation.completed" && event.data?.operationId === "assess_target"));
  if (!search && assessment === "achieved") {
    const assessments = jobs.filter(operation => operation === "assess_target").length;
    const resumed = await runCapability(capability, { type: "resume" }, new AbortController().signal);
    assert.equal(resumed.status, "paused", resumed.lastError);
    assert.equal(optimizers, 2, "explicit continuation must not immediately re-pause on the cached achieved assessment");
    assert.equal(jobs.filter(operation => operation === "assess_target").length, assessments, "same formal tree and evidence reuse the independent assessment");
  }
});

import { privateDecision, publicSource } from "../../../src/capabilities/run/policy/compact-v3-evidence.ts";
import { createWorkspace, createWorkspaceService } from "../../../src/services/workspace/index.ts";
import { ExecutionBudget, createExecutionBudgetState } from "../../../src/session/execution-budget.ts";
import { readJobResult } from "../../../src/services/agent/job-validation.ts";
import { promptAsset } from "../../../src/services/prompt/index.ts";
import type { Context } from "../../../src/capabilities/run/policy/compact.ts";
import type { JobSpec } from "../../../src/services/agent/job-protocol.ts";

async function privateFixture(mode: "valid" | "unknown" | "repair" = "valid") {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-private-decision-"));
  const input = path.join(root, "goal.md"), report = path.join(root, "report.json"), resultPath = path.join(root, "job-result.json");
  await writeFile(input, "original goal");
  const budget = new ExecutionBudget(createExecutionBudgetState({ knownTokens: 2_000_000 }), async () => {});
  await budget.reserveRequiredWork("target", budget.estimateInvocation("target-assess"));
  let calls = 0;
  const context = { state: {}, signal: new AbortController().signal, services: {
    workspace: createWorkspaceService({ workspace: createWorkspace(root) }), executionBudget: budget,
    artifact: { readJobResult }, prompt: promptAsset, guard: { project: async (_state: unknown, _label: string, execute: () => Promise<unknown>) => execute() },
    agent: { execute: async (_state: unknown, job: JobSpec) => {
      const id = `call-${++calls}`; await budget.startInvocation(id, job.invocationReservation);
      await writeFile(report, JSON.stringify(mode === "repair" && calls === 1 ? { invalid: true } : { decision: "achieved" }));
      await writeFile(resultPath, JSON.stringify({ status: "completed", artifacts: [report] }));
      await budget.finishInvocation(id, mode === "unknown" ? undefined : { inputTokens: 10, outputTokens: 10 });
      return { status: "completed" };
    } },
  } } as unknown as Context;
  const job: JobSpec = { id: "target", operation: "assess_target", label: "target", cwd: root, readRoots: [input], writeRoots: [report, resultPath], tools: ["Read", "Write"],
    resultPath, delegation: "disabled", invocationReservation: { reservationId: "target", estimateClass: "target-assess" }, prompt: promptAsset("run.routing.target-assess") };
  const parse = (value: unknown) => { if ((value as {decision?:string}).decision !== "achieved") throw new Error("invalid report"); return value; };
  return { root, input, report, resultPath, budget, context, job, parse, calls: () => calls };
}

test("private target decision recovers a known completed invocation before ledger commit without another model call", async () => {
  const f = await privateFixture();
  await privateDecision(f.context, f.root, f.job, f.report, f.parse, 120_000);
  const recordPath = path.join(f.root, "execution.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  record.phase = "running"; delete record.hash; delete record.resultHash;
  await writeFile(recordPath, JSON.stringify(record));
  await privateDecision(f.context, f.root, f.job, f.report, f.parse, 120_000);
  assert.equal(f.calls(), 1);
  await writeFile(f.input, "tampered goal");
  await assert.rejects(privateDecision(f.context, f.root, f.job, f.report, f.parse), /input changed/);
  assert.equal(f.budget.state.repairUsed, false);
});

test("unknown target usage remains occupied and is never replayed", async () => {
  const f = await privateFixture("unknown");
  await assert.rejects(privateDecision(f.context, f.root, f.job, f.report, f.parse), /terminal state unknown/);
  await assert.rejects(privateDecision(f.context, f.root, f.job, f.report, f.parse), /terminal state unknown/);
  assert.equal(f.calls(), 1);
});

test("private target protocol repair uses the shared one repair and reserves its actual extra invocation", async () => {
  const f = await privateFixture("repair");
  await privateDecision(f.context, f.root, f.job, f.report, f.parse);
  assert.equal(f.calls(), 2);
  assert.equal(f.budget.state.repairUsed, true);
  assert.equal(Object.values(f.budget.state.invocations).at(-1)?.reservationId, "target:protocol-repair");
});

test("public source snapshot declares binary omissions while preserving readable test source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-public-source-"));
  await writeFile(path.join(root, "test.ts"), "assert(actual === expected)");
  await writeFile(path.join(root, "image.png"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, ".env"), "SECRET=not-exposed");
  const snapshot = await publicSource(root);
  assert.deepEqual(snapshot.files, [path.join(root, "test.ts")]);
  assert.deepEqual(snapshot.omissions, { total: 1, examples: [{ path: "image.png", reason: "binary content" }] });
});

test("relocated source excludes private manifest roles even outside the runtime directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-relocated-private-"));
  await mkdir(path.join(root, "data"));
  await writeFile(path.join(root, "data", "holdout.json"), "private cases");
  await writeFile(path.join(root, "judge.mjs"), "private evaluator");
  await writeFile(path.join(root, "test.ts"), "public assertion");
  const snapshot = await publicSource(root, [path.join("data", "holdout.json"), "judge.mjs"]);
  assert.deepEqual(snapshot.files, [path.join(root, "test.ts")]);
  assert.deepEqual(snapshot.omissions, { total: 0, examples: [] });
});

test("private completed receipt outside its original persisted deadline is rejected on recovery", async () => {
  const f = await privateFixture();
  await privateDecision(f.context, f.root, f.job, f.report, f.parse, 120_000);
  const file = path.join(f.root, "execution.json"), record = JSON.parse(await readFile(file, "utf8"));
  record.phase = "running"; record.deadline = 1;
  await writeFile(file, JSON.stringify(record));
  await assert.rejects(privateDecision(f.context, f.root, f.job, f.report, f.parse, 120_000), /original authorization expired/);
  assert.equal(f.calls(), 1);
});

for (const component of ["propose", "review"] as const) test(`settled unavailable ${component} survives recovery without repeat or implicit review approval`, async () => {
  const project = await fixture("achieved"); project.assistanceRevision = COMPONENT_ROUTING_REVISION;
  let calls = 0, componentCalls = 0, optimizerCalls = 0;
  const capability = new RunCapability(project, { execute: async job => {
    const id = `unavailable-call-${++calls}`; await job.executionBudget!.startInvocation(id, job.invocationReservation);
    let prompt = job.prompt; while (prompt.variables?.job_prompt) prompt = prompt.variables.job_prompt as typeof prompt; const v = prompt.variables!;
    if (job.operation === "component_routing" && !v.decision_path) {
      componentCalls++;
      await job.executionBudget!.finishInvocation(id, { inputTokens: 20, outputTokens: 20 });
      return { status: "aborted", usage: { inputTokens: 20, outputTokens: 20 }, message: "Known terminal service abort" };
    }
    if (job.operation === "component_routing") await writeFile(String(v.decision_path), JSON.stringify(v.window === "R3"
      ? { action: "request_component", component, reason: "Need an independent public investigation", evidence: ["context"] }
      : { action: "continue_base", reason: "No further advisory needed", evidence: ["context"] }));
    else if (job.operation === "optimize") { optimizerCalls++; await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new"); }
    else if (job.operation === "assess_target") await writeFile(String(v.report_path), JSON.stringify({ schemaVersion: 1, decision: "achieved", reason: "Evidence inspected", evidence: [String(v.goal_path)] }));
    else assert.fail(`Unexpected ${job.operation}`);
    if (job.resultPath) await writeFile(job.resultPath, JSON.stringify({ status: "completed", artifacts: [v.report_path ?? v.decision_path].filter(Boolean) }));
    await job.executionBudget!.finishInvocation(id, { inputTokens: 20, outputTokens: 20 });
    return { status: "completed", usage: { inputTokens: 20, outputTokens: 20 } };
  } }, { budgetLimits: { activeMs: 1_800_000, knownTokens: 2_000_000, candidateAttempts: 3 } });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(componentCalls, 1);
  assert.equal(optimizerCalls, 1);
  if (component === "review") {
    assert.equal(state.iteration, 1);
    assert.equal(state.compact?.candidate?.phase, "optimized");
    assert.equal(state.compact?.candidate?.resultPath, undefined);
    const resumed = await runCapability(capability, { type: "resume" }, new AbortController().signal);
    assert.equal(resumed.status, "paused", resumed.lastError);
    assert.equal(componentCalls, 1, "an unavailable completed review is not invoked again");
    assert.equal(resumed.iteration, 1);
  } else {
    assert.equal(state.iteration, 2);
    assert.equal(state.compact?.routing?.assessment?.decision, "achieved");
    assert.match(state.compact?.routing?.guidance ?? "", /not a verified finding or review approval/);
    assert.match(state.compact?.routing?.guidance ?? "", /Need an independent public investigation/);
    assert.ok(state.compact?.routing?.appliedWindows?.some(id => id.startsWith("R3:")));
  }
});

for (const { component, window } of [{ component: "propose", window: "R3" }, { component: "diagnose", window: "R3" },
  { component: "search", window: "R3" }, { component: "diagnose", window: "R4" }] as const) test(`Run ${window} ${component} ask_user pauses before implementation and restores without another component call`, async () => {
  const project = await fixture("achieved"); project.assistanceRevision = COMPONENT_ROUTING_REVISION;
  let calls = 0, componentCalls = 0;
  const question = "Which of the two public interpretations should the implementation follow?";
  const capability = new RunCapability(project, { execute: async job => {
    const id = `ask-user-${++calls}`;
    await job.executionBudget!.startInvocation(id, job.invocationReservation);
    if (window === "R4" && job.operation === "optimize") {
      await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
      await job.executionBudget!.finishInvocation(id, { inputTokens: 20, outputTokens: 20 });
      return { status: "completed", usage: { inputTokens: 20, outputTokens: 20 } };
    }
    assert.equal(job.operation, "component_routing", "asking the user must not launch optimizer or target assessment");
    let prompt = job.prompt; while (prompt.variables?.job_prompt) prompt = prompt.variables.job_prompt as typeof prompt;
    const v = prompt.variables!;
    if (v.decision_path) await writeFile(String(v.decision_path), JSON.stringify(v.window === window
      ? { action: "request_component", component, reason: "Resolve a concrete ambiguity before implementation", evidence: ["context"] }
      : { action: "continue_base", reason: "Proceed to the current window", evidence: ["context"] }));
    else {
      componentCalls++;
      // In particular, Search may ask a legitimate question instead of inventing two hypotheses.
      await writeFile(String(v.report_path), JSON.stringify({ schemaVersion: 1, decision: "ask_user", summary: question, evidence: ["context"] }));
    }
    await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [v.report_path ?? v.decision_path] }));
    await job.executionBudget!.finishInvocation(id, { inputTokens: 20, outputTokens: 20 });
    return { status: "completed", usage: { inputTokens: 20, outputTokens: 20 } };
  } }, { budgetLimits: { activeMs: 1_800_000, knownTokens: 2_000_000, candidateAttempts: 3 } });
  const first = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(first.status, "paused", first.lastError);
  assert.equal(first.compact?.attempts, window === "R4" ? 1 : 0);
  assert.equal(first.compact?.routing?.search, undefined);
  assert.equal(first.compact?.routing?.guidance, undefined);
  assert.equal(first.compact?.routing?.appliedWindows?.length ?? 0, window === "R4" ? 1 : 0);
  assert.equal(componentCalls, 1);
  const beforeResume = calls;
  const resumed = await runCapability(capability, { type: "resume" }, new AbortController().signal);
  assert.equal(resumed.status, "paused", resumed.lastError);
  assert.equal(calls, beforeResume, "restoring the question must not invoke any model again");
  assert.equal(resumed.compact?.attempts, window === "R4" ? 1 : 0);
  const events = await capability.store.history();
  assert.equal(events.filter(e => e.type === "operation.activity" && e.data?.needsInput && e.data?.message === question).length, 2);
  const budget = JSON.parse(await readFile(path.join(project.runtimeDir, "execution-budget.json"), "utf8"));
  assert.equal(budget.repairUsed, false, "a valid user question is not a protocol error");
});
