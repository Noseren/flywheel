import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CompactVerificationNeedsInput, runCompactVerification, validateVerificationConfig, validateVerificationEvidence, type CompactVerificationOptions } from "../../src/capabilities/compact-evaluation.ts";
import { validateJobSpec } from "../../src/services/agent/job-validation.ts";
import { defaultProcessService, runProcess } from "../../src/services/process/index.ts";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";

async function fixture(extra: Record<string, unknown> = {}): Promise<CompactVerificationOptions> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-compact-verifier-"));
  const contract = path.join(root, ".flywheel", "contract");
  await mkdir(contract, { recursive: true });
  const options: CompactVerificationOptions = {
    projectRoot: root,
    configPath: path.join(contract, "verification.json"), evaluatorPath: path.join(contract, "evaluate.mjs"),
    taskPath: path.join(contract, "task.md"), boundaryPath: path.join(contract, "boundary.json"),
    request: { schemaVersion: 1, mode: "baseline", subjectRoot: root, artifactPath: path.join(root, "answer.txt"),
      outputDir: path.join(root, ".flywheel", "runtime", "baseline"), goalPath: path.join(root, ".flywheel", "goal.md") },
    process: defaultProcessService,
  };
  for (const file of [options.taskPath, options.boundaryPath, options.request.goalPath, options.request.artifactPath]) await writeFile(file, "source");
  await writeFile(options.configPath, JSON.stringify({ schemaVersion: 1, command: process.execPath, args: ["{evaluator}"], timeoutMs: 5000, acceptance: "explicit", ...extra }));
  await writeFile(options.evaluatorPath, `import fs from 'node:fs/promises'; import path from 'node:path';
let raw=''; for await (const chunk of process.stdin) raw += chunk;
const request=JSON.parse(raw); const evidence=path.join(request.outputDir,'evidence.json');
await fs.writeFile(evidence, JSON.stringify({artifact:await fs.readFile(request.artifactPath,'utf8'),outputs:request.outputsDir,judge:request.judgeResultPath}));
console.log(JSON.stringify({schemaVersion:1,status:'completed',retention:'retain',target:'not_achieved',summary:'Actual artifact read',publicFeedback:'Public failing case',evidence:['evidence.json']}));`);
  return options;
}

test("compact baseline executes the actual artifact and keeps business failure separate from infrastructure failure", async () => {
  const options = await fixture();
  const state = createExecutionBudgetState();
  options.executionBudget = new ExecutionBudget(state, async () => undefined);
  const result = await runCompactVerification(options);
  assert.equal(result.status, "completed");
  assert.equal(result.target, "not_achieved");
  assert.equal(result.retention, "inconclusive");
  const evidence = JSON.parse(await readFile(path.join(options.request.outputDir, result.evidence[0]!), "utf8"));
  assert.equal(evidence.artifact, "source");
  assert.deepEqual(JSON.parse(await readFile(path.join(options.request.outputDir, "result.json"), "utf8")), result);
  assert.equal(state.unknownUsageInvocations, 0, "deterministic process is not an unknown model invocation");
  assert.ok(state.activeMs > 0);
});

test("retention requires a valid baseline; open acceptance cannot claim achievement", async () => {
  const options = await fixture();
  await runCompactVerification(options);
  const baselineResultPath = path.join(options.request.outputDir, "result.json");
  options.request = { ...options.request, mode: "candidate", outputDir: path.join(path.dirname(options.request.outputDir), "candidate") };
  assert.equal((await runCompactVerification(options)).retention, "inconclusive");
  options.request.baselineResultPath = baselineResultPath;
  assert.equal((await runCompactVerification(options)).retention, "retain");
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  await writeFile(options.configPath, JSON.stringify({ ...config, acceptance: "open" }));
  await writeFile(options.evaluatorPath, (await readFile(options.evaluatorPath, "utf8")).replace("target:'not_achieved'", "target:'achieved'"));
  assert.equal((await runCompactVerification(options)).target, "inconclusive");
});

test("promoted candidate evidence resolves relative to its result and becomes the next comparison baseline", async () => {
  const options = await fixture();
  await writeFile(options.request.artifactPath, "1");
  await writeFile(options.evaluatorPath, `import fs from 'node:fs/promises'; import path from 'node:path';
let raw=''; for await (const chunk of process.stdin) raw += chunk;
const request=JSON.parse(raw); const score=Number(await fs.readFile(request.artifactPath,'utf8'));
let previous=null;
if(request.baselineResultPath){
 const baseline=JSON.parse(await fs.readFile(request.baselineResultPath,'utf8'));
 const entry=baseline.evidence.find(entry=>path.basename(entry)==='metrics.json');
 previous=JSON.parse(await fs.readFile(path.resolve(path.dirname(request.baselineResultPath),entry),'utf8'));
 if(previous.evaluator!=='frozen-v1'||!['baseline','candidate'].includes(previous.mode)) throw Error('Incompatible comparison');
}
const metrics={evaluator:'frozen-v1',mode:request.mode,score,previousMode:previous?.mode??null,previousScore:previous?.score??null};
await fs.writeFile(path.join(request.outputDir,'metrics.json'),JSON.stringify(metrics));
console.log(JSON.stringify({schemaVersion:1,status:'completed',retention:previous&&score>previous.score?'retain':'reject',target:'not_achieved',summary:'Compared actual evidence',publicFeedback:'Public score '+score,evidence:['metrics.json']}));`);
  const baseline = await runCompactVerification(options);
  assert.ok(baseline.evidence.every(entry => !path.isAbsolute(entry)));
  const baselineResultPath = path.join(options.request.outputDir, "result.json");
  const runtimeRoot = path.dirname(options.request.outputDir);
  await writeFile(options.request.artifactPath, "2");
  options.request = { ...options.request, mode: "candidate", outputDir: path.join(runtimeRoot, "candidate-one"), baselineResultPath };
  const promoted = await runCompactVerification(options);
  assert.equal(promoted.retention, "retain");
  assert.ok(promoted.evidence.every(entry => !path.isAbsolute(entry)));
  const promotedResultPath = path.join(options.request.outputDir, "result.json");
  await writeFile(options.request.artifactPath, "3");
  options.request = { ...options.request, outputDir: path.join(runtimeRoot, "candidate-two"), baselineResultPath: promotedResultPath };
  const next = await runCompactVerification(options);
  assert.equal(next.retention, "retain");
  const metrics = JSON.parse(await readFile(path.resolve(options.request.outputDir, next.evidence[0]!), "utf8"));
  assert.equal(metrics.previousMode, "candidate");
  assert.equal(metrics.previousScore, 2);
  assert.equal(metrics.score, 3);
});

test("verification blocks nonzero commands, malformed reports and escaping evidence", async () => {
  const options = await fixture();
  options.process = { ...defaultProcessService, run: async () => ({code: 7, stdout: "", stderr: "real command failure"}) };
  await assert.rejects(runCompactVerification(options), /exited 7: real command failure/);
  options.process.run = async () => ({code: 0, stdout: "not json", stderr: ""});
  await assert.rejects(runCompactVerification(options), SyntaxError);
  options.process.run = async () => ({code: 0, stderr: "", stdout: JSON.stringify({schemaVersion:1,status:"completed",retention:"retain",target:"achieved",summary:"pass",publicFeedback:"",evidence:[options.request.artifactPath]})});
  await assert.rejects(runCompactVerification(options), /inside its output directory/);
  options.request.holdoutPath = options.request.artifactPath;
  await assert.rejects(runCompactVerification(options), /Invalid verification request/);
});

test("verification rejects symlink evidence outside the output directory", async (context) => {
  const options = await fixture();
  await mkdir(options.request.outputDir, { recursive: true });
  try { await symlink(options.request.artifactPath, path.join(options.request.outputDir, "escape.txt")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip("Windows symlink permission unavailable"); return; } throw error; }
  options.process = { ...defaultProcessService, run: async () => ({code:0,stderr:"",stdout:JSON.stringify({schemaVersion:1,status:"completed",retention:"retain",target:"achieved",summary:"pass",publicFeedback:"",evidence:[path.join(options.request.outputDir, "escape.txt")]})}) };
  await assert.rejects(runCompactVerification(options), /inside its output directory/);
});

test("optional task execution and subjective judge use separate restricted AgentService jobs", async () => {
  const options = await fixture({ tasking: true, judging: true });
  options.taskingGuidePath = path.join(path.dirname(options.taskPath), "tasking.md");
  options.evaluateGuidePath = path.join(path.dirname(options.taskPath), "judging.md");
  await writeFile(options.taskingGuidePath, "Produce actual outputs");
  await writeFile(options.evaluateGuidePath, "Judge actual outputs");
  const jobs: string[] = [];
  options.agent = { execute: async (job) => {
    validateJobSpec(job);
    jobs.push(job.operation);
    assert.equal(job.sessionKey, undefined);
    assert.equal(job.delegation, "disabled");
    assert.ok(job.deniedPaths?.includes(options.evaluatorPath));
    const file = path.join(job.writeRoots[0]!, job.operation === "verify_tasking" ? "actual.txt" : "judge.json");
    await writeFile(file, job.operation === "verify_tasking" ? "task output" : '{"score":1}');
    await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [file] }));
    return { status: "completed", artifacts: [file] };
  } };
  const result = await runCompactVerification(options);
  assert.equal(result.status, "completed");
  assert.deepEqual(jobs, ["verify_tasking", "verify_judging"]);
  options.agent = undefined;
  await assert.rejects(runCompactVerification(options), /requires AgentService/);
});

test("required tasking and judge share a complete reservation and transfer it into independent invocations", async () => {
  const options = await fixture({ tasking: true, judging: true });
  options.taskingGuidePath = path.join(path.dirname(options.taskPath), "tasking.md");
  options.evaluateGuidePath = path.join(path.dirname(options.taskPath), "judging.md");
  await writeFile(options.taskingGuidePath, "Run the frozen task");
  await writeFile(options.evaluateGuidePath, "Judge the frozen outputs");
  const budgetState = createExecutionBudgetState({ knownTokens: 70_000 });
  const budget = new ExecutionBudget(budgetState, async () => undefined);
  options.executionBudget = budget;
  options.requiredReservationId = "required-baseline";
  const calls: string[] = [];
  options.agent = { execute: async job => {
    calls.push(job.operation);
    assert.equal(job.sessionKey, undefined);
    assert.equal(job.assistance, undefined);
    assert.equal(job.delegation, "disabled");
    assert.equal(job.invocationReservation?.reservationId, "required-baseline");
    const reserve = budgetState.reservations!["required-baseline"]!;
    assert.equal(reserve.estimate.tokens, 64_000, "both necessary model steps reserved before either starts");
    await budget.startInvocation(job.operation, job.invocationReservation);
    assert.equal(reserve.tokensRemaining, calls.length === 1 ? 32_000 : 0, "transfer does not double count the required reservation");
    const file = path.join(job.writeRoots[0]!, job.operation === "verify_tasking" ? "actual.txt" : "judge.json");
    await writeFile(file, job.operation === "verify_tasking" ? "actual output" : '{"score":1}');
    await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [file] }));
    await budget.finishInvocation(job.operation, { inputTokens: 100, outputTokens: 200 });
    return { status: "completed" };
  } };
  const result = await runCompactVerification(options);
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["verify_tasking", "verify_judging"]);
  assert.equal(budgetState.knownTokens, 600);
  assert.equal(budgetState.reservations!["required-baseline"]!.closed, true);
});

test("insufficient required judge reserve pauses before model or evaluator work and cannot drop judging", async () => {
  const options = await fixture({ judging: true });
  options.evaluateGuidePath = path.join(path.dirname(options.taskPath), "judging.md");
  await writeFile(options.evaluateGuidePath, "Judge semantic quality");
  options.executionBudget = new ExecutionBudget(createExecutionBudgetState({ knownTokens: 31_999 }), async () => undefined);
  options.requiredReservationId = "required-judge";
  let calls = 0;
  options.agent = { execute: async () => { calls += 1; return { status: "completed" }; } };
  options.process = { ...defaultProcessService, run: async () => { calls += 1; throw new Error("must not run"); } };
  await assert.rejects(runCompactVerification(options), (error: unknown) => (error as { code?: string }).code === "EXECUTION_BUDGET_EXHAUSTED");
  assert.equal(calls, 0);
  options.evaluateGuidePath = undefined;
  await assert.rejects(runCompactVerification(options), /frozen guide role/);
  assert.equal(calls, 0);
});

test("semantic evaluator needs_input remains a typed pause rather than a failed verification", async () => {
  const options = await fixture();
  options.process = { ...defaultProcessService, run: async () => ({ code: 0, stderr: "", stdout: JSON.stringify({
    schemaVersion: 1, status: "needs_input", retention: "inconclusive", target: "inconclusive",
    summary: "The frozen rubric cannot distinguish the requested behavior.", publicFeedback: "Clarify the required behavior.", evidence: [],
  }) }) };
  await assert.rejects(runCompactVerification(options), CompactVerificationNeedsInput);
});

test("verification command output and execution time are bounded", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('a'.repeat(65536));setTimeout(()=>{},30000)"], {maxOutputBytes:1024,timeoutMs:3000}), /abort/i);
  await assert.rejects(runProcess(process.execPath, ["-e", "setTimeout(()=>{},30000)"], {timeoutMs:30}), /abort/i);
  assert.throws(() => validateVerificationConfig({schemaVersion:1,command:"node",args:[],timeoutMs:0,acceptance:"explicit"}), /Invalid compact/);
  assert.throws(() => validateVerificationConfig({schemaVersion:1,command:"node",args:["unfrozen.mjs"],timeoutMs:100,acceptance:"explicit"}), /Invalid compact/);
});

test("fresh execution cannot claim old evidence or its own result", async () => {
  const options = await fixture();
  const result = await runCompactVerification(options);
  const previousEvidence = path.join(options.request.outputDir, result.evidence[0]!);
  options.process = { ...defaultProcessService, run: async () => ({ code: 0, stderr: "",
    stdout: JSON.stringify({ ...result, evidence: [previousEvidence] }) }) };
  await assert.rejects(runCompactVerification(options), /inside its output directory/);
  await assert.rejects(validateVerificationEvidence({ ...result, evidence: ["result.json"] }, options.request.outputDir), /own evidence/);
});

test("candidate artifact cannot alias the formal project through a directory junction", async (context) => {
  const options = await fixture();
  const formal = path.join(options.projectRoot!, "formal");
  const candidate = path.join(options.projectRoot!, "candidate");
  await mkdir(formal);
  await mkdir(candidate);
  await writeFile(path.join(formal, "answer.txt"), "formal artifact");
  const alias = path.join(candidate, "artifact");
  try { await symlink(formal, alias, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") { context.skip("Directory symlink permission unavailable"); return; } throw error; }
  options.request = { ...options.request, mode: "candidate", subjectRoot: candidate, artifactPath: alias };
  let executed = false;
  options.process = { ...defaultProcessService, run: async () => { executed = true; throw new Error("must not execute"); } };
  await assert.rejects(runCompactVerification(options), /outside verification subject/);
  assert.equal(executed, false);
});

test("verification process budget exhaustion retains the typed pause reason", async () => {
  const options = await fixture();
  let now = 0;
  const state = createExecutionBudgetState({ activeMs: 5 });
  options.executionBudget = new ExecutionBudget(state, async () => undefined, () => now);
  options.process = { ...defaultProcessService, run: async () => {
    now = 10;
    throw new DOMException("Process timed out", "AbortError");
  } };
  await assert.rejects(runCompactVerification(options), (error: unknown) =>
    (error as { code?: string; reason?: string }).code === "EXECUTION_BUDGET_EXHAUSTED"
    && (error as { reason?: string }).reason === "time");
  assert.equal(state.activeMs, 10);
  assert.equal(state.unknownUsageInvocations, 0);
});
