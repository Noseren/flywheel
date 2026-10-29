import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InitCapability } from "../../../src/capabilities/init/capability.ts";
import { validateInitContract, writeInitManifest } from "../../../src/capabilities/init/artifacts.ts";
import { prepareCompactOperation } from "../../../src/capabilities/init/policy/compact.ts";
import { createDefaultInitExecutionPolicy } from "../../../src/capabilities/init/policy.ts";
import { createBaselineOperation, exploreOperation } from "../../../src/capabilities/init/policy/operations.ts";
import type { AgentService } from "../../../src/services/agent/protocol.ts";
import type { JobSpec } from "../../../src/services/agent/job-protocol.ts";
import { runCapability } from "../../../src/session/runner.ts";
import { RunCapability } from "../../../src/capabilities/run/capability.ts";
import { loadProject } from "../../../src/capabilities/run/project.ts";
import { defaultProcessService } from "../../../src/services/process/index.ts";
import { PromptAssetStore, promptAsset } from "../../../src/services/prompt/index.ts";
import { DefaultAgentService } from "../../../src/services/agent/service.ts";
import { COMPACT_ASSISTANCE_REVISION } from "../../../src/capabilities/compact-assistance.ts";
import { ExecutionBudgetExhausted } from "../../../src/session/execution-budget.ts";

const evaluator = `import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0,'utf8'));
fs.writeFileSync(request.outputDir+'/evidence.txt','Actual baseline is failing.');
console.log(JSON.stringify({schemaVersion:1,status:'completed',retention:'reject',target:'not_achieved',summary:'A test fails',publicFeedback:'Public check fails',evidence:['evidence.txt']}));`;

const infrastructureFailureEvaluator = `import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0,'utf8'));
let diagnostic;
try { await import('c:/invalid-local-reporter.mjs'); diagnostic = 'Unexpected module loading success'; }
catch (error) { diagnostic = (error.code + ': ' + error.message).slice(0,2000); }
fs.writeFileSync(request.outputDir+'/diagnostic.txt',diagnostic);
console.log(JSON.stringify({schemaVersion:1,status:'failed',retention:'inconclusive',target:'inconclusive',summary:diagnostic,publicFeedback:'The baseline wrapper could not load its reporter.',evidence:['diagnostic.txt']}));`;

async function fixture(options: { invalidFirst?: boolean; invalidAlways?: boolean; mutateSubject?: boolean; oversizedFactsFirst?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-compact-init-"));
  await writeFile(path.join(root, "subject.txt"), "Original subject\n");
  const jobs: JobSpec[] = [];
  const agent: AgentService = { execute: async (job) => {
    jobs.push(job);
    if (job.label.startsWith("init:explore")) {
      await mkdir(path.join(root, ".flywheel/init"), { recursive: true });
      await writeFile(path.join(root, ".flywheel/init/context_card.md"), options.oversizedFactsFirst && jobs.length === 1
        ? "x".repeat(2001) : "A deterministic subject check.");
      return { status: "completed" };
    }
    if (job.label.startsWith("init:plan")) {
      await writeFile(path.join(root, ".flywheel/init/proposal.md"), "Evaluate the subject with its real public check.");
      await writeFile(path.join(root, ".flywheel/init/proposal.json"), JSON.stringify({ artifactPath: "subject.txt",
        documentPath: ".flywheel/init/proposal.md", userFacingSummary: "目标：保持用户目标。评价：执行公开检查。" }));
      return { status: "completed" };
    }
    const directory = path.join(root, ".flywheel", "contract");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "task.md"), "Use the actual public check; retain improvements only.\n");
    await writeFile(path.join(directory, "boundary.json"), JSON.stringify({ schemaVersion: 1,
      artifact: { path: "subject.txt" }, change_scope: { primary: ["subject.txt"] } }));
    await writeFile(path.join(directory, "evaluator.mjs"), evaluator);
    await writeFile(path.join(directory, "verification.json"), JSON.stringify({ schemaVersion: 1,
      command: process.execPath, args: ["{evaluator}"], timeoutMs: 10_000, acceptance: "explicit" }));
    const files = ["task", "boundary", "evaluator", "verification"].map(id => ({ id,
      path: `.flywheel/contract/${id === "task" ? "task.md" : id === "evaluator" ? "evaluator.mjs" : `${id}.json`}` }));
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 2, workflow: "compact",
      files: options.invalidAlways || (options.invalidFirst && jobs.length === 1) ? files.filter(file => file.id !== "verification") : files }));
    if (options.mutateSubject) await writeFile(path.join(root, "subject.txt"), "Unauthorized edit\n");
    await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: files.map(file => file.path) }));
    return { status: "completed", sessionId: "preparation-session" };
  } };
  const verifications = { count: 0 };
  const capability = new InitCapability({ projectRoot: root, initialGoal: "Keep this original goal.\r\n", agent,
    process: { ...defaultProcessService, run: async (command, args, options) => {
      if (args.some(arg => arg.endsWith("evaluator.mjs"))) verifications.count += 1;
      return await defaultProcessService.run(command, args, options);
    } },
  });
  const state = await capability.createState();
  state.proposal = { artifactPath: "subject.txt", documentPath: ".flywheel/init/proposal.md" };
  const services = capability.services(state, new AbortController().signal);
  await services.workspace.writeText(path.join(root, state.proposal.documentPath), "Evaluate via the public check.");
  state.answers.summaryConfirmed = true;
  state.answers.approvedGoalSha256 = await services.workspace.sha256(path.join(root, ".flywheel", "goal.md"));
  state.answers.approvedProposalSha256 = await services.workspace.sha256(path.join(root, state.proposal.documentPath));
  return { root, state, services, jobs, agent, capability, verifications, signal: new AbortController().signal };
}

test("compact preparation runs an actual failing baseline, freezes minimal roles, and resumes without another preparation job", async () => {
  const context = await fixture();
  assert.equal(context.state.workflow, "compact");
  assert.equal(context.state.confirmationMode, "brief");
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.jobs.length, 1);
  assert.equal(context.jobs[0]!.sessionKey, "preparation");
  assert.equal(context.jobs[0]!.delegation, "enabled");
  assert.equal(context.jobs[0]!.assistance?.revision, context.state.assistanceRevision);
  const contract = await validateInitContract(context.root);
  assert.deepEqual(contract.files.map(file => file.id), ["task", "boundary", "evaluator", "verification"]);
  const result = JSON.parse(await readFile(path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json"), "utf8"));
  assert.equal(result.status, "completed");
  assert.equal(result.target, "not_achieved");
  assert.equal(await readFile(path.join(context.root, ".flywheel/goal.md"), "utf8"), "Keep this original goal.\r\n");
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, 1);
  assert.equal(context.verifications.count, 1);
  await createBaselineOperation(context);
  await writeInitManifest(context.root, context.state.assistanceRevision);
  const ready = JSON.parse(await readFile(path.join(context.root, ".flywheel/init/manifest.json"), "utf8"));
  assert.equal(ready.workflow, "compact");
  assert.equal(ready.assistanceRevision, COMPACT_ASSISTANCE_REVISION);
  assert.equal((await loadProject(context.root)).assistanceRevision, COMPACT_ASSISTANCE_REVISION);
  assert.equal(ready.files.some((file: { id: string }) => file.id === "coverage"), false);
  const binding = JSON.parse(await readFile(path.join(context.root, ".flywheel/runtime/preparation-baseline/binding.json"), "utf8"));
  assert.equal(binding.treeHash, await context.services.version.treeHash("v1"));
  assert.equal(binding.resultSha256, context.state.answers.preparationBaselineSha256);
  for (const file of binding.files) {
    assert.equal(path.isAbsolute(file.path), true);
    assert.equal(file.sha256, await context.services.workspace.sha256(file.path));
  }
  assert.equal(binding.evidence.length, 1);
  assert.equal(binding.evidence[0].sha256, await context.services.workspace.sha256(binding.evidence[0].path));
  assert.equal(binding.files.some((file: { path: string }) => file.path === path.join(context.root, ".flywheel/goal.md")), true);
  assert.equal(binding.files.length, 7);
});

test("old compact preparation retains disabled delegation after restart and ready handoff", async () => {
  const context = await fixture();
  delete context.state.assistanceRevision;
  await context.capability.prepare(context.state, { type: "resume" }, context.signal);
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, 1);
  assert.equal(context.jobs[0]!.delegation, "disabled");
  assert.equal(context.jobs[0]!.assistance, undefined);
  await createBaselineOperation(context);
  assert.equal((await loadProject(context.root)).assistanceRevision, undefined);
  assert.equal((await context.capability.policySource()).revision, "2026-10-23.compact.v1");
});

test("an Agent sandbox denial does not replace the Runtime process baseline or grant additional permissions", async () => {
  const context = await fixture();
  const prepare = context.services.agent.execute.bind(context.services.agent);
  context.services.agent = { execute: async job => {
    assert.deepEqual(job.writeRoots, [path.join(context.root, ".flywheel/contract")]);
    assert.ok(job.deniedPaths?.includes(path.join(context.root, ".flywheel/runtime")));
    const response = await prepare(job);
    await context.services.workspace.writeJson(job.resultPath!, { status: "completed",
      artifacts: [], message: "Agent probe returned EPERM; package prepared for Runtime execution, not a test verdict." });
    return response;
  } };
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.verifications.count, 1);
  assert.equal(context.jobs.length, 1);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
  const result = JSON.parse(await readFile(path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json"), "utf8"));
  assert.equal(result.status, "completed");
  assert.equal(result.target, "not_achieved");
  assert.equal(result.retention, "inconclusive");
  assert.equal(await context.services.version.hasTag("v1"), false);
  await createBaselineOperation(context);
  assert.equal(await context.services.version.hasTag("v1"), true);
});

test("preparation admits optional work only after a complete verification draft exists", async () => {
  const context = await fixture();
  context.services.agent = { execute: async job => {
    assert.ok(job.assistance?.resolveRequiredReservationId);
    assert.equal(await job.assistance.resolveRequiredReservationId(), undefined);
    const result = await context.agent.execute(job);
    const id = await job.assistance.resolveRequiredReservationId();
    assert.equal(id, job.assistance.requiredReservationId);
    const reserve = context.services.executionBudget!.state.reservations![id!];
    assert.equal(reserve.kind, "required");
    assert.equal(reserve.estimate.tokens, 0, "a deterministic evaluator needs no model reservation");
    assert.equal(reserve.estimate.activeMs, 10_000);
    return result;
  } };
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, 1, "a simple task makes no optional calls");
});

test("preparation needs_input pauses visibly without repair or baseline execution", async () => {
  const context = await fixture();
  let calls = 0;
  context.services.agent = { execute: async job => {
    calls += 1;
    await context.services.workspace.ensureDir(path.dirname(job.resultPath!));
    await context.services.workspace.writeJson(job.resultPath!, { status: "needs_input", artifacts: [], message: "The approved quality requirement needs a concrete rubric." });
    return { status: "needs_input", message: "The approved quality requirement needs a concrete rubric." };
  } };
  const result = await prepareCompactOperation(context);
  assert.equal(result.status, "paused");
  assert.equal(calls, 1);
  assert.equal(context.verifications.count, 0);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
  const questions = (await context.capability.history()).filter(event => event.type === "operation.activity" && event.data?.needsInput === true);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.data?.message, "The approved quality requirement needs a concrete rubric.");
});

test("preparation baseline needs_input emits the evaluator question without repairing the package", async () => {
  const context = await fixture();
  const question = "Which accepted behavior should the preparation baseline evaluate?";
  context.services.process = { ...context.services.process, run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({
    schemaVersion: 1, status: "needs_input", retention: "inconclusive", target: "inconclusive",
    summary: question, publicFeedback: "Clarification is required.", evidence: [],
  }) }) };
  const result = await prepareCompactOperation(context);
  assert.equal(result.status, "paused");
  assert.equal(context.jobs.length, 1);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
  const questions = (await context.capability.history()).filter(event => event.type === "operation.activity" && event.data?.needsInput === true);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.data?.message, question);
});

test("compact preparation shares one persisted repair allowance", async () => {
  const context = await fixture({ invalidFirst: true });
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, 2);
  assert.equal(context.services.executionBudget!.state.repairUsed, true);
  await assert.rejects(context.services.executionBudget!.claimRepair(), /repair/);
});

test("preparation repairs a structured evaluator infrastructure failure in its original session and executes a real baseline", async () => {
  const context = await fixture();
  const generate = context.agent.execute.bind(context.agent);
  context.agent.execute = async job => {
    const response = await generate(job);
    await writeFile(path.join(context.root, ".flywheel/contract/evaluator.mjs"), context.jobs.length === 1
      ? infrastructureFailureEvaluator : evaluator.replace("'Actual baseline is failing.'", "fs.readFileSync(request.artifactPath,'utf8')"));
    return response;
  };
  assert.equal((await prepareCompactOperation(context)).status, "completed");
  assert.equal(context.jobs.length, 2);
  assert.equal(context.verifications.count, 2);
  assert.deepEqual(context.jobs.map(job => job.sessionKey), ["preparation", "preparation"]);
  assert.equal(context.jobs[1]!.resumeSessionId, "preparation-session");
  assert.equal(context.services.executionBudget!.state.repairUsed, true);
  const repairPrompt = (await new PromptAssetStore().resolve(context.jobs[1]!.prompt)).text;
  assert.match(repairPrompt, /preparation\.baseline\.infrastructure/);
  assert.match(repairPrompt, /ERR_UNSUPPORTED_ESM_URL_SCHEME/);
  const issues = (await context.capability.history()).find(event => event.type === "artifact.validation.failed")!.data!.issues as { message: string }[];
  assert.equal(issues.length, 1);
  assert.ok(issues[0]!.message.length <= 2_000);
  assert.ok(context.jobs.every(job => !job.readRoots.includes(path.join(context.root, ".flywheel/runtime"))));
  const resultPath = path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json");
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.status, "completed");
  assert.equal(result.target, "not_achieved", "business test failure remains a valid baseline");
  assert.equal(await readFile(path.resolve(path.dirname(resultPath), result.evidence[0]), "utf8"), "Original subject\n");
});

test("preparation stops after its single repair when structured evaluator infrastructure failures persist", async () => {
  const context = await fixture();
  const generate = context.agent.execute.bind(context.agent);
  context.agent.execute = async job => {
    const response = await generate(job);
    await writeFile(path.join(context.root, ".flywheel/contract/evaluator.mjs"), infrastructureFailureEvaluator);
    return response;
  };
  await assert.rejects(prepareCompactOperation(context), /remained invalid after 1 repair attempts/);
  assert.equal(context.jobs.length, 2);
  assert.equal(context.verifications.count, 2);
  assert.equal(context.services.executionBudget!.state.repairUsed, true);
  assert.equal(context.state.answers.smokeConfirmed, undefined);
  assert.equal(await context.services.version.hasTag("v1"), false);
});

for (const failure of [new ExecutionBudgetExhausted("tokens"), new DOMException("Cancelled baseline", "AbortError")]) {
  test(`preparation does not repair ${failure.name} from baseline execution`, async () => {
    const context = await fixture();
    context.services.process = { ...context.services.process, run: async () => { throw failure; } };
    await assert.rejects(prepareCompactOperation(context), error => error === failure);
    assert.equal(context.jobs.length, 1);
    assert.equal(context.services.executionBudget!.state.repairUsed, false);
  });
}

test("preparation never regenerates or repairs an evaluator after the ready handoff is frozen", async () => {
  const context = await fixture();
  const evaluatorPath = path.join(context.root, ".flywheel/contract/evaluator.mjs");
  await mkdir(path.dirname(evaluatorPath), { recursive: true });
  await writeFile(evaluatorPath, infrastructureFailureEvaluator);
  // A persisted ready manifest is an immutable handoff even if the inspection cache is stale.
  await context.services.workspace.writeJson(path.join(context.root, ".flywheel/init/manifest.json"), { schemaVersion: 4, status: "ready" });
  await assert.rejects(prepareCompactOperation(context), /Ready evaluator is frozen/);
  assert.equal(context.jobs.length, 0);
  assert.equal(context.services.executionBudget!.state.repairUsed, false);
  assert.equal(await readFile(evaluatorPath, "utf8"), infrastructureFailureEvaluator);
});

test("compact preparation cannot repair away subject writes", async () => {
  const context = await fixture({ mutateSubject: true });
  await assert.rejects(prepareCompactOperation(context), /checkpoint/);
  assert.equal(context.jobs.length, 1);
  assert.equal(await readFile(path.join(context.root, "subject.txt"), "utf8"), "Unauthorized edit\n");
});

test("missing persisted workflow preserves the legacy confirmation transition", async () => {
  const context = await fixture();
  delete context.state.workflow;
  const decision = createDefaultInitExecutionPolicy().decide({ state: context.state, policyState: {},
    lastOutcome: { operationId: "confirm_proposal", status: "completed" } });
  assert.deepEqual(decision, { type: "run", operationId: "generate_contract" });
});

test("compact manifest requires paired sample partitions and optional model guides", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  const file = path.join(context.root, ".flywheel/contract/verification.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...config, judging: true }));
  await assert.rejects(validateInitContract(context.root), /evaluate-guide/);
  await writeFile(file, JSON.stringify(config));
  const manifestPath = path.join(context.root, ".flywheel/contract/manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(path.join(context.root, ".flywheel/contract/train.json"), "[]");
  manifest.files.push({ id: "train", path: ".flywheel/contract/train.json" });
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateInitContract(context.root), /paired/);
});

test("compact baseline creation rejects post-verification changes", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  await writeFile(path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json"), "{}");
  await assert.rejects(createBaselineOperation(context), /changed before baseline/);
});

test("preparation recovery reruns baseline after frozen input bytes change without a manifest edit", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  await writeFile(path.join(context.root, ".flywheel/contract/task.md"), "Updated evaluation explanation.");
  await prepareCompactOperation(context);
  assert.equal(context.jobs.length, 1);
  assert.equal(context.verifications.count, 2);
});

test("compact baseline creation rejects changed evaluator bytes even when manifest is unchanged", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  await writeFile(path.join(context.root, ".flywheel/contract/evaluator.mjs"), evaluator + "\n// changed after verification\n");
  await assert.rejects(createBaselineOperation(context), /changed before baseline/);
});

test("one brief confirmation proceeds through real verification and v1 without another approval", async () => {
  const { capability, root, jobs } = await fixture();
  const signal = new AbortController().signal;
  const pending = await runCapability(capability, { type: "start" }, signal);
  assert.equal(pending.status, "waiting_for_user");
  assert.equal(pending.pendingInteraction?.id, "init.confirm_proposal");
  const complete = await runCapability(capability, { type: "command", command: {
    type: "interaction.respond", interactionId: "init.confirm_proposal", inputKind: "choice", value: "confirm",
  } }, signal);
  assert.equal(complete.status, "completed");
  assert.equal(jobs.filter(job => job.label === "init:prepare").length, 1);
  const recommendation = jobs.find(job => job.label === "init:plan")!;
  assert.deepEqual(recommendation.readRoots, [path.join(root, ".flywheel/init/context_card.md"), path.join(root, ".flywheel/goal.md")]);
  assert.deepEqual(recommendation.writeRoots, [path.join(root, ".flywheel/init/proposal.md"), path.join(root, ".flywheel/init/proposal.json")]);
  const rendered = await new PromptAssetStore().resolve(recommendation.prompt);
  assert.match(rendered.text, /Do not build evaluators, wrappers, tests, reports, or baseline evidence/);
  assert.match(rendered.text, /A deterministic subject check/);
  assert.equal(rendered.text.split("Keep this original goal.\r\n").length - 1, 1);
  assert.equal(jobs.some(job => /review|smoke|init:contract|init:evaluator/.test(job.label)), false);
  const binding = JSON.parse(await readFile(path.join(root, ".flywheel/runtime/preparation-baseline/binding.json"), "utf8"));
  assert.equal(binding.schemaVersion, 1);
});

test("Run reuses the Init-bound baseline without executing its evaluator again", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  await createBaselineOperation(context);
  const project = await loadProject(context.root);
  const run = new RunCapability(project, { execute: async () => { throw new Error("No model work expected"); } }, { maxIterations: 0 });
  const state = await runCapability(run, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused");
  assert.equal(state.compact?.baselineResultPath, path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json"));
  assert.equal(context.verifications.count, 1);
  assert.equal(await context.services.workspace.exists(path.join(context.root, ".flywheel/runtime/runs/v1/verification/result.json")), false);
  assert.equal(state.compact?.baselineResultSha256, context.state.answers.preparationBaselineSha256);
});

test("default compact entry preserves a legacy pending approval when preparing restored state", async () => {
  const context = await fixture();
  delete context.state.workflow;
  context.state.confirmationMode = "review";
  context.state.status = "waiting_for_user";
  context.state.execution.currentOperationId = "validate_contract";
  const interaction = { id: "legacy-smoke", capabilityId: "init", requestedBy: { type: "runtime" as const },
    kind: "confirm" as const, operationId: "validate_contract",
    question: "Review the existing report", description: "Already presented report" };
  context.state.pendingInteraction = interaction;
  await context.capability.prepare(context.state, { type: "resume" }, context.signal);
  assert.equal(context.state.workflow, undefined);
  assert.equal(context.state.confirmationMode, "review");
  assert.equal(context.state.pendingInteraction, interaction);
  assert.equal(context.state.status, "waiting_for_user");
});

test("preparation recovery blocks changed evidence bytes before any baseline reuse", async () => {
  const context = await fixture();
  await prepareCompactOperation(context);
  const result = JSON.parse(await readFile(path.join(context.root, ".flywheel/runtime/preparation-baseline/result.json"), "utf8"));
  await writeFile(path.resolve(context.root, ".flywheel/runtime/preparation-baseline", result.evidence[0]), "Tampered evidence");
  await assert.rejects(prepareCompactOperation(context), /Frozen preparation evidence changed/);
  assert.equal(context.verifications.count, 1);
});

test("compact exploration repairs an oversized fact card within the shared allowance", async () => {
  const context = await fixture({ oversizedFactsFirst: true });
  await exploreOperation(context);
  assert.equal(context.jobs.length, 2);
  assert.equal(context.services.executionBudget!.state.repairUsed, true);
  assert.equal(await readFile(path.join(context.root, ".flywheel/init/context_card.md"), "utf8"), "A deterministic subject check.");
});

test("DefaultAgentService accepts preparation reads of the frozen goal and proposal with contract-only writes", async () => {
  const context = await fixture();
  let reads = 0;
  context.services.agent = new DefaultAgentService({ provider: "codex", model: "local-permission-regression",
    run: async job => {
      const goal = path.join(context.root, ".flywheel/goal.md");
      const proposal = path.join(context.root, ".flywheel/init/proposal.md");
      assert.deepEqual(job.writeRoots, [path.join(context.root, ".flywheel/contract")]);
      assert.ok(job.deniedPaths?.includes(path.join(context.root, ".flywheel/runtime")));
      assert.ok(job.deniedPaths?.includes(path.join(context.root, ".git")));
      assert.ok(job.deniedPaths?.includes(path.join(context.root, ".flywheel/history.git")));
      for (const file of [goal, proposal]) {
        assert.ok(job.readRoots.some(root => path.relative(root, file).split(path.sep)[0] !== ".."));
        assert.ok(!job.writeRoots.some(root => path.relative(root, file).split(path.sep)[0] !== ".."));
        assert.equal(job.deniedPaths.some(denied => file.startsWith(denied + path.sep) || file === denied), false);
        assert.ok((await readFile(file, "utf8")).length > 0);
        reads += 1;
      }
      assert.match(job.prompt, /Keep this original goal|goal\.md/);
      const result = await context.agent.execute({ ...job, prompt: promptAsset("init.compact.prepare") });
      return { success: result.status === "completed", sessionId: result.sessionId };
    },
  }, new PromptAssetStore());
  await prepareCompactOperation(context);
  assert.equal(reads, 2);
  assert.equal(context.verifications.count, 1);
  assert.equal(context.state.answers.smokeConfirmed, true);
});

for (const protectedPath of [".flywheel/goal.md", ".flywheel/init/proposal.md"]) {
  test(`preparation hash guard rejects a DefaultAgentService adapter writing ${protectedPath}`, async () => {
    const context = await fixture();
    context.services.agent = new DefaultAgentService({ provider: "codex", model: "local-permission-regression",
      run: async job => {
        const result = await context.agent.execute({ ...job, prompt: promptAsset("init.compact.prepare") });
        // Simulate an uncooperative backend: roots are not an operating-system ACL.
        await writeFile(path.join(context.root, protectedPath), "Unauthorized frozen-input replacement");
        return { success: result.status === "completed", sessionId: result.sessionId };
      },
    }, new PromptAssetStore());
    await assert.rejects(prepareCompactOperation(context), /Approved goal or evaluation proposal changed/);
    assert.equal(context.jobs.length, 1);
    assert.equal(context.verifications.count, 0);
    assert.equal(context.state.answers.smokeConfirmed, undefined);
    assert.equal(context.services.executionBudget!.state.repairUsed, false);
  });
}
