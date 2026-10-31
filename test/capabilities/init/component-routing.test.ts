import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { InitCapability } from "../../../src/capabilities/init/capability.ts";
import { prepareCompactOperation } from "../../../src/capabilities/init/policy/compact.ts";
import { COMPONENT_ROUTING_REVISION } from "../../../src/capabilities/component-routing-revision.ts";
import { preparationPublicFiles } from "../../../src/capabilities/init/policy/compact-routing.ts";
import type { AgentService } from "../../../src/services/agent/protocol.ts";
import type { JobSpec } from "../../../src/services/agent/job-protocol.ts";
import type { PromptRequest } from "../../../src/services/prompt/index.ts";

function asset(prompt: PromptRequest, id: string): PromptRequest | undefined {
  if (prompt.assetId === id) return prompt;
  for (const value of Object.values(prompt.variables ?? {})) {
    if (value && typeof value === "object" && "assetId" in value) {
      const found = asset(value as PromptRequest, id);
      if (found) return found;
    }
  }
}

async function fixture(choice: "base" | "requirements" | "soundness" | "check" | "unknown" | "R1-timeout" | "R2-timeout" | "component-unknown" | "R1-ask" | "R2-ask" = "base") {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-routed-init-"));
  await writeFile(path.join(root, "subject.txt"), "Original\r\n");
  const jobs: JobSpec[] = [];
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  const execute: AgentService["execute"] = async job => {
    jobs.push(job);
    const router = asset(job.prompt, "routing.router");
    const component = asset(job.prompt, "routing.component");
    if (job.depth === 1) {
      const report = path.join(job.writeRoots[0]!, "check.md");
      await writeFile(report, "The original goal allows the good output; correct the assertion.");
      await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [report], message: "Confirmed a concrete assertion mismatch" }));
      return { status: "completed", artifacts: [report], sessionId: job.sessionKey, usage: { inputTokens: 100, outputTokens: 10 } };
    }
    const checkRequest = job.label.endsWith("component-absorption") ? asset(job.prompt, "common.assistance-capable") : undefined;
    if (checkRequest) {
      await writeFile(String(checkRequest.variables!.request_path), JSON.stringify({ schemaVersion: 2, purpose: "check", reason: "Inspect the concrete assertion mismatch", evidence: [".flywheel/goal.md"],
        tasks: [{ task: "Check the original requirement against the draft assertion, cite evidence, no execution", inputs: [".flywheel/goal.md", ".flywheel/contract/task.md"], tools: ["Read"] }] }));
      return { status: "completed", artifacts: [], sessionId: job.sessionKey, usage: { inputTokens: 100, outputTokens: 10 } };
    }
    if (router) {
      const window = router.variables!.window;
      if (choice === "unknown" && window === "R2") throw new Error("transport lost before terminal report");
      const selected = ["requirements", "R1-timeout", "R1-ask"].includes(choice) && window === "R1" ? "requirements"
        : ["R2-timeout", "component-unknown", "R2-ask"].includes(choice) && window === "R2" ? "soundness"
        : ["soundness", "check"].includes(choice) && window === "R2" ? choice : undefined;
      await writeFile(String(router.variables!.decision_path), JSON.stringify({ action: selected ? "request_component" : "continue_base",
        ...(selected ? { component: selected } : {}), reason: "A concrete public assertion concern", evidence: ["context"] }));
    } else if (component) {
      if (choice === "component-unknown") throw new Error("component transport lost before terminal report");
      if (choice.endsWith("-timeout")) return { status: "aborted", artifacts: [], message: "Optional component deadline expired", usage: { inputTokens: 100, outputTokens: 10 } };
      await writeFile(String(component.variables!.report_path), JSON.stringify({ schemaVersion: 1, summary: "The original goal allows the good output; reject only an actual failure.", evidence: ["context"], ...(choice.endsWith("-ask") ? { decision: "ask_user" } : {}) }));
    } else {
      const directory = path.join(root, ".flywheel/contract");
      await mkdir(directory, { recursive: true });
      const absorbed = job.label.endsWith("component-absorption");
      await writeFile(path.join(directory, "task.md"), absorbed ? "Corrected actual assertion\n" : "Initial assertion\n");
      await writeFile(path.join(directory, "boundary.json"), JSON.stringify({ schemaVersion: 1, artifact: { path: "subject.txt" }, change_scope: { primary: ["subject.txt"] } }));
      await writeFile(path.join(directory, "evaluator.mjs"), `import fs from 'node:fs';const r=JSON.parse(fs.readFileSync(0,'utf8'));fs.writeFileSync(r.outputDir+'/actual.txt',${JSON.stringify(absorbed ? "corrected assertion was executed" : "original assertion was executed")});console.log(JSON.stringify({schemaVersion:1,status:'completed',retention:'reject',target:'not_achieved',summary:'Actual check failed',publicFeedback:'failed',evidence:['actual.txt']}));`);
      await writeFile(path.join(directory, "verification.json"), JSON.stringify({ schemaVersion: 1, command: process.execPath, args: ["{evaluator}"], timeoutMs: 5000, acceptance: "explicit" }));
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 2, workflow: "compact", files: [
        { id: "task", path: ".flywheel/contract/task.md" }, { id: "boundary", path: ".flywheel/contract/boundary.json" },
        { id: "evaluator", path: ".flywheel/contract/evaluator.mjs" }, { id: "verification", path: ".flywheel/contract/verification.json" },
      ] }));
    }
    const artifacts = router ? [String(router.variables!.decision_path)] : component ? [String(component.variables!.report_path)] : [];
    await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts, message: "Adopted the concrete approved-goal correction" }));
    return { status: "completed", artifacts: [], message: "Adopted the concrete approved-goal correction", sessionId: job.sessionKey, usage: { inputTokens: 100, outputTokens: 10 } };
  };
  const agent: AgentService = { execute: async job => {
    const id = randomUUID();
    await job.executionBudget?.startInvocation(id, job.invocationReservation);
    try {
      const result = await execute(job);
      await job.executionBudget?.finishInvocation(id, result.usage);
      return result;
    } catch (error) { await job.executionBudget?.finishInvocation(id, null); throw error; }
  } };
  const capability = new InitCapability({ projectRoot: root, initialGoal: "Keep original semantics", agent });
  const state = await capability.createState();
  assert.equal(state.assistanceRevision, COMPONENT_ROUTING_REVISION);
  state.proposal = { artifactPath: "subject.txt", documentPath: ".flywheel/init/proposal.md" };
  const signal = new AbortController().signal, services = capability.services(state, signal);
  const originalEmit = services.emit;
  services.emit = async (type, data) => { events.push({ type, data }); await originalEmit(type, data); };
  await services.workspace.writeText(path.join(root, state.proposal.documentPath), "Use actual deterministic assertions");
  state.answers.summaryConfirmed = true;
  state.answers.approvedGoalSha256 = await services.workspace.sha256(path.join(root, ".flywheel/goal.md"));
  state.answers.approvedProposalSha256 = await services.workspace.sha256(path.join(root, state.proposal.documentPath));
  return { root, state, services, signal, jobs, events };
}

for (const choice of ["R1-ask", "R2-ask"] as const) test(`${choice} component clarification pauses before baseline and restores without another call`, async () => {
  const context = await fixture(choice);
  assert.equal((await prepareCompactOperation(context)).status, "paused");
  const calls = context.jobs.length;
  assert.equal(context.jobs.some(job => job.label.endsWith("component-absorption")), false);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
  assert.equal((await prepareCompactOperation(context)).status, "paused");
  assert.equal(context.jobs.length, calls);
  assert.equal(context.events.some(event => event.type === "baseline.created"), false);
});

test("v3 simple Init routes twice with isolated sessions, runs real baseline and restores without extra routing", async () => {
  const context = await fixture();
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  const routers = context.jobs.filter(job => !!asset(job.prompt, "routing.router"));
  assert.equal(routers.length, 2);
  assert.notEqual(routers[0]!.sessionKey, routers[1]!.sessionKey);
  for (const job of routers) {
    assert.equal(job.delegation, "disabled");
    assert.equal(job.readRoots.includes(context.root), false);
    assert.equal(job.readRoots.some(file => file.endsWith("state.json") || file.endsWith("events.jsonl")), false);
  }
  assert.equal(context.jobs.filter(job => !!asset(job.prompt, "routing.component")).length, 0);
  assert.equal(context.services.executionBudget!.state.reservations?.["target-assess:final"]?.closed, undefined);
  const count = context.jobs.length;
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, count);
});

test("R1 requirements are supplied to mandatory preparation without creating an extra repair call", async () => {
  const context = await fixture("requirements");
  await prepareCompactOperation(context);
  const preparation = context.jobs.find(job => job.label === "init:prepare")!;
  assert.match(String(asset(preparation.prompt, "init.compact.prepare")!.variables!.issues), /original goal allows/);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
});

test("R2 soundness report is reconciled in original preparation session and revised assertions actually execute", async () => {
  const context = await fixture("soundness");
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  const preparation = context.jobs.find(job => job.label === "init:prepare")!;
  const absorption = context.jobs.find(job => job.label === "init:prepare:component-absorption")!;
  assert.equal(absorption.sessionKey, preparation.sessionKey);
  assert.ok(absorption.invocationReservation);
  assert.equal(absorption.delegation, "disabled");
  const baseline = JSON.parse(await readFile(path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json"), "utf8"));
  const actual = await readFile(path.resolve(context.root, ".flywheel/runtime/preparation-baseline", baseline.evidence[0]), "utf8");
  assert.equal(actual, "corrected assertion was executed");
  assert.equal(context.events.some(event => event.type === "init.component.absorbed"), true);
  const count = context.jobs.length;
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, count);
});

test("unknown R2 transport outcome cannot re-dispatch the router or consume a repair on restore", async () => {
  const context = await fixture("unknown");
  await assert.rejects(prepareCompactOperation(context), /transport lost/);
  const routers = context.jobs.filter(job => !!asset(job.prompt, "routing.router")).length;
  await assert.rejects(prepareCompactOperation(context), /unknown|binding|reservation/i);
  assert.equal(context.jobs.filter(job => !!asset(job.prompt, "routing.router")).length, routers);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
});

test("R2 check uses an actual bounded Child and parent continuation before baseline", async () => {
  const context = await fixture("check");
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.jobs.filter(job => job.depth === 1).length, 1);
  const absorbed = context.events.find(event => event.type === "init.component.absorbed")!;
  assert.equal(absorbed.data!.component, "check");
  assert.ok((absorbed.data!.assistanceEvents as Array<Record<string, unknown>>).some(event => event.sdkEvent === "assistance.settled"));
  assert.equal(context.jobs.filter(job => !!asset(job.prompt, "routing.component")).length, 0);
});

test("known returned parent absorption resumes from matching draft and usage without rerunning its model", async () => {
  const context = await fixture("soundness");
  const emit = context.services.emit;
  let crashed = false;
  context.services.emit = async (type, data) => {
    if (type === "init.component.absorbed" && !crashed) { crashed = true; throw new Error("crash after returned absorption was persisted"); }
    await emit(type, data);
  };
  await assert.rejects(prepareCompactOperation(context), /crash after returned/);
  const count = context.jobs.length;
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.jobs.length, count);
});

test("public preparation snapshot omits binary and control files with explicit omission reasons", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-public-text-"));
  await writeFile(path.join(root, "public.txt"), "actual public assertion");
  await writeFile(path.join(root, "image.png"), Buffer.from([137, 80, 78, 71, 0]));
  await writeFile(path.join(root, ".env"), "private");
  const omitted: Array<{ path: string; reason: string }> = [];
  const publicFiles = await preparationPublicFiles(root, omitted);
  assert.deepEqual(publicFiles, [path.join(root, "public.txt")]);
  assert.equal(omitted[0]!.path, "image.png");
  assert.match(omitted[0]!.reason, /UTF-8|binary/);
});

test("v3 cannot silently reevaluate changed draft bytes after its routed baseline completed", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  const count = context.jobs.length;
  await writeFile(path.join(context.root, ".flywheel/contract/task.md"), "Changed meaning after review\n");
  await assert.rejects(prepareCompactOperation(context), /Frozen preparation assets changed/);
  assert.equal(context.jobs.length, count);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
});

for (const window of ["R1", "R2"] as const) test(`${window} settled optional timeout continues actual base verification without adopting a report`, async () => {
  const context = await fixture(`${window}-timeout`);
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.jobs.some(job => job.label.endsWith("component-absorption")), false);
  const skipped = context.events.find(event => event.type === "init.component.skipped");
  assert.equal(skipped?.data?.window, window);
  assert.equal(skipped?.data?.adopted, false);
  const baselineDir = path.join(context.root, ".flywheel/runtime/preparation-baseline");
  const baseline = JSON.parse(await readFile(path.join(baselineDir, "result.json"), "utf8"));
  assert.equal(await readFile(path.resolve(baselineDir, baseline.evidence[0]), "utf8"), "original assertion was executed");
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
  const count = context.jobs.length;
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, count);
});

test("unknown optional component outcome pauses without baseline or replay", async () => {
  const context = await fixture("component-unknown");
  await assert.rejects(prepareCompactOperation(context), /component transport lost/);
  const count = context.jobs.length;
  await assert.rejects(prepareCompactOperation(context), /unknown|binding|reservation/i);
  assert.equal(context.jobs.length, count);
  assert.equal(context.events.some(event => event.type === "init.component.skipped"), false);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
});

test("R2 skipped absorption survives interruption without repeating component or parent", async () => {
  const context = await fixture("R2-timeout");
  const emit = context.services.emit;
  let interrupted = false;
  context.services.emit = async (type, data) => {
    if (type === "init.component.skipped" && !interrupted) { interrupted = true; throw new Error("crash after skipped persisted"); }
    await emit(type, data);
  };
  await assert.rejects(prepareCompactOperation(context), /crash after skipped/);
  const count = context.jobs.length;
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.jobs.length, count);
});
