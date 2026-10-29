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

test("compact retains with one optimizer, pauses on target, and keeps verification private", async () => {
  const project = await fixture("achieved");
  const jobs: string[] = [];
  const agent: AgentService = { execute: async job => {
    validateJobSpec(job);
    jobs.push(job.operation);
    assert.equal(job.operation, "optimize");
    assert.equal(job.readRoots?.length, 2);
    assert.ok(job.deniedPaths?.some(file => file.endsWith(".flywheel")));
    await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    return { status: "completed" };
  } };
  const capability = new RunCapability(project, agent);
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused");
  assert.equal(state.iteration, 2);
  assert.equal(state.compact?.attempts, 1);
  assert.deepEqual(jobs, ["optimize"]);
  assert.equal(await readFile(project.artifactPath, "utf8"), "new");
  assert.equal(state.compact?.history[0]?.retained, true);
});

test("new trusted compact policy gives only its optimizer bounded assistance and preserves zero extra calls", async () => {
  const project = await fixture("achieved");
  project.assistanceRevision = COMPACT_ASSISTANCE_REVISION;
  let calls = 0;
  const agent: AgentService = { execute: async job => {
    calls += 1;
    assert.equal(job.operation, "optimize");
    assert.equal(job.delegation, "enabled");
    assert.equal(job.assistance?.revision, COMPACT_ASSISTANCE_REVISION);
    assert.ok(job.assistance?.requiredReservationId);
    validateJobSpec(job);
    const within = (root: string, file: string) => {
      const relative = path.relative(path.resolve(job.cwd, root), file);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    const permits = (roots: string[], file: string) => roots.some(root => within(root, file))
      && !(job.deniedPaths ?? []).some(root => within(root, file));
    const worktree = path.join(job.cwd, "worktree");
    const artifact = path.join(worktree, "artifact.txt");
    const publicContext = path.join(job.cwd, "context.md");
    assert.ok(permits(job.readRoots, artifact), "the permitted candidate artifact is readable through its file or ancestor root");
    assert.ok(permits(job.writeRoots, artifact), "the permitted candidate artifact is writable through its file or ancestor root");
    assert.ok(permits(job.readRoots, publicContext), "the frozen public context remains readable");
    assert.equal(permits(job.writeRoots, publicContext), false, "the optimizer cannot overwrite public context");
    assert.match(await readFile(publicContext, "utf8"), /Improve the public artifact/);
    for (const privatePath of [path.join(worktree, ".flywheel"), path.join(worktree, ".flywheel", "private.json"),
      path.join(worktree, ".git"), project.evaluatorPath, path.join(project.root, ".flywheel", "contract", "holdout.json")]) {
      assert.equal(permits(job.readRoots, privatePath), false, `private material must remain unreadable: ${privatePath}`);
      assert.equal(permits(job.writeRoots, privatePath), false, `private material must remain unwritable: ${privatePath}`);
    }
    await writeFile(artifact, "new");
    assert.equal(await readFile(artifact, "utf8"), "new");
    return { status: "completed" };
  } };
  const state = await runCapability(new RunCapability(project, agent), { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(state.iteration, 2);
  assert.equal(state.assistanceRevision, COMPACT_ASSISTANCE_REVISION);
  assert.equal(state.execution.policy.revision, COMPACT_ASSISTANCE_REVISION);
  assert.equal(calls, 1);
});

test("an old ready compact project cannot gain assistance on its first Run", async () => {
  const project = await fixture("achieved");
  const agent: AgentService = { execute: async job => {
    assert.equal(job.delegation, "disabled");
    assert.equal(job.assistance, undefined);
    await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    return { status: "completed" };
  } };
  const state = await runCapability(new RunCapability(project, agent), { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(state.assistanceRevision, undefined);
  assert.equal(state.execution.policy.revision, "compact-1");
});

test("optimizer needs_input pauses without formal evaluation, repair or promotion", async () => {
  const project = await fixture();
  project.assistanceRevision = COMPACT_ASSISTANCE_REVISION;
  let calls = 0;
  const agent: AgentService = { execute: async () => { calls += 1; return { status: "needs_input", message: "The frozen evaluation omitted an approved requirement; re-prepare it." }; } };
  const capability = new RunCapability(project, agent);
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(state.iteration, 1);
  assert.equal(state.compact?.candidate?.phase, "reserved");
  assert.equal(state.compact?.candidate?.resultPath, undefined);
  assert.equal(calls, 1);
  const history = await capability.store.history();
  assert.equal(history.some(event => event.type === "operation.completed" && event.data?.operationId === "verify_candidate"), false);
  const questions = history.filter(event => event.type === "operation.activity" && event.data?.needsInput === true);
  assert.equal(questions.length, 1);
  assert.equal(questions[0]!.data?.message, "The frozen evaluation omitted an approved requirement; re-prepare it.");
});

for (const phase of ["baseline", "candidate"] as const) {
  test(`${phase} evaluation needs_input emits its actual question once and pauses without promotion`, async () => {
    const project = await fixture("achieved", true);
    let judgeCalls = 0;
    let optimizerCalls = 0;
    const question = `Which semantic requirement should the ${phase} judge use?`;
    const agent: AgentService = { execute: async job => {
      if (job.operation === "optimize") {
        optimizerCalls += 1;
        await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
        return { status: "completed" };
      }
      assert.equal(job.operation, "verify_judging");
      judgeCalls += 1;
      if (phase === "baseline" || judgeCalls === 2) return { status: "needs_input", message: question };
      const evidence = path.join(job.writeRoots[0], "judge.json");
      await writeFile(evidence, '{"score":0}');
      await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [evidence] }));
      return { status: "completed" };
    } };
    const capability = new RunCapability(project, agent);
    const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
    assert.equal(state.status, "paused", state.lastError);
    assert.equal(state.iteration, 1);
    assert.equal(state.lastError, question);
    assert.equal(optimizerCalls, phase === "baseline" ? 0 : 1);
    assert.equal(judgeCalls, phase === "baseline" ? 1 : 2);
    assert.equal(state.compact?.candidate?.resultPath, undefined);
    const history = await capability.store.history();
    const questions = history.filter(event => event.type === "operation.activity" && event.data?.needsInput === true);
    assert.equal(questions.length, 1);
    assert.equal(questions[0]!.data?.message, question);
    assert.equal(history.some(event => event.type === "operation.started" && event.data?.operationId === "retain"), false);
    assert.equal(history.some(event => event.type === "runtime.blocked"), false);
  });
}

test("compact rejection consumes attempts without promotion and stops at budget", async () => {
  const project = await fixture();
  let calls = 0;
  const agent: AgentService = { execute: async job => {
    validateJobSpec(job);
    calls += 1;
    await writeFile(path.join(job.writeRoots[0], "artifact.txt"), `bad-${calls}`);
    return { status: "completed" };
  } };
  const capability = new RunCapability(project, agent, { budgetLimits: { candidateAttempts: 2 } });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused");
  assert.equal(state.iteration, 1);
  assert.equal(state.compact?.attempts, 2);
  assert.equal(calls, 2);
  assert.equal(await readFile(project.artifactPath, "utf8"), "old");
  assert.deepEqual(state.compact?.history.map(item => item.retained), [false, false]);
  assert.equal((await capability.store.history()).filter(event => event.type === "runtime.budget.exhausted").length, 1);
});

test("compact preserves complete bounded failure diagnostics across retries without exposing private evidence", async () => {
  const project = await fixture("not_achieved", false, "explicit", true);
  let calls = 0;
  const feedback = (mode: string, artifact: string) => `${mode}:${artifact}:${"x".repeat(11900)}:ActualError: missing deferred fragment`;
  const agent: AgentService = { execute: async job => {
    validateJobSpec(job);
    calls += 1;
    assert.equal(job.readRoots.length, 2, "no private verification roots are granted");
    assert.ok(job.deniedPaths?.some(file => file.endsWith(".flywheel")));
    const context = await readFile(job.readRoots[1], "utf8");
    assert.ok(context.includes(feedback("baseline", "old")), "baseline feedback remains complete");
    assert.ok(!context.includes("PRIVATE_SUMMARY_MARKER"));
    assert.ok(!context.includes("PRIVATE_EVIDENCE_MARKER"));
    const history = JSON.parse(context.split("# Prior attempts and public failure feedback\n")[1]);
    assert.equal(history.length, Math.min(calls - 1, 5), "only five previous attempts enter context");
    for (const entry of history) {
      const attempt = Number(entry.id.slice("attempt-".length));
      assert.ok(attempt >= Math.max(1, calls - 5));
      assert.equal(entry.publicFeedback, feedback("candidate", `bad-${attempt}`), "the late error survives intact");
      assert.ok(entry.publicFeedback.length <= 12000);
      assert.deepEqual(Object.keys(entry).sort(), ["id", "publicFeedback", "retained"]);
    }
    await writeFile(path.join(job.writeRoots[0], "artifact.txt"), `bad-${calls}`);
    return { status: "completed" };
  } };
  const state = await runCapability(new RunCapability(project, agent, { budgetLimits: { candidateAttempts: 7 } }),
    { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(calls, 7);
  assert.equal(state.iteration, 1);
  assert.equal(state.compact?.history.length, 7, "durable history remains available outside bounded context");
  assert.equal(state.compact?.history[0]?.publicFeedback, feedback("candidate", "bad-1"));
});

test("compact recovers promotion after the tag is created without repeating optimizer or verification", async () => {
  const project = await fixture("achieved");
  let optimizerCalls = 0;
  const agent: AgentService = { execute: async job => {
    validateJobSpec(job);
    if (job.operation === "optimize") {
      optimizerCalls += 1;
      await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    }
    return { status: "completed" };
  } };
  const capability = new RunCapability(project, agent);
  const promote = capability.versions.promoteWorktree.bind(capability.versions);
  let interrupt = true;
  capability.versions.promoteWorktree = async (...args) => {
    await promote(...args);
    if (interrupt) { interrupt = false; throw new Error("simulated interruption after promotion tag"); }
  };
  const blocked = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.compact?.candidate?.phase, "verified");
  const resultHash = blocked.compact?.candidate?.resultSha256;
  const resumed = await runCapability(capability, { type: "resume" }, new AbortController().signal);
  assert.equal(resumed.status, "paused", resumed.lastError);
  assert.equal(resumed.iteration, 2);
  assert.equal(optimizerCalls, 1);
  assert.equal(resumed.compact?.baselineResultSha256, resultHash);
  assert.equal(resumed.compact?.history.length, 1);
  assert.equal(await readFile(project.artifactPath, "utf8"), "new");
});

test("compact blocks optimizer attempts to overwrite its public context", async () => {
  const project = await fixture();
  const agent: AgentService = { execute: async job => {
    validateJobSpec(job);
    if (job.operation === "optimize") {
      await writeFile(job.readRoots[1], "tampered context");
      await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    }
    return { status: "completed" };
  } };
  const capability = new RunCapability(project, agent);
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "blocked");
  assert.match(state.lastError ?? "", /frozen public context/);
  assert.equal(state.iteration, 1);
  assert.equal(state.compact?.attempts, 1);
  assert.equal(await readFile(project.artifactPath, "utf8"), "old");
});

test("compact rejects changed private verification evidence before promotion", async () => {
  const project = await fixture("achieved");
  const agent: AgentService = { execute: async job => {
    validateJobSpec(job);
    if (job.operation === "optimize") await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    return { status: "completed" };
  } };
  const capability = new RunCapability(project, agent);
  const afterOperation = capability.afterOperation.bind(capability);
  capability.afterOperation = async (state, operation, outcome, signal) => {
    await afterOperation(state, operation, outcome, signal);
    if (operation === "verify_candidate") {
      const evidence = state.compact?.candidate?.evidence?.[0];
      assert.ok(evidence);
      await writeFile(evidence.path, "tampered private evidence");
    }
  };
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "blocked");
  assert.match(state.lastError ?? "", /Verification evidence changed/);
  assert.equal(state.iteration, 1);
  assert.equal(await capability.versions.hasTag("v2"), false);
});

test("compact verifier model wrapper preserves streaming and token accounting in fresh judge sessions", async () => {
  const project = await fixture("achieved", true);
  const operations: string[] = [];
  const agent = new DefaultAgentService({ run: async job => {
    validateJobSpec(job);
    operations.push(job.operation);
    await job.onEvent?.({ sdkEvent: "test.delta", text: "actual streamed content" });
    if (job.operation === "optimize") {
      const context = await readFile(job.readRoots[1], "utf8");
      assert.ok(!context.includes("SECRET_PRIVATE_MARKER"));
      await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    } else {
      assert.equal(job.operation, "verify_judging");
      assert.equal(job.sessionKey, undefined);
      assert.equal(job.resumeSessionId, undefined);
      const judgePath = path.join(job.writeRoots[0], "judge.json");
      await writeFile(judgePath, JSON.stringify({ private: "SECRET_PRIVATE_MARKER" }));
      await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [judgePath] }));
    }
    return { success: true, usage: { inputTokens: 11, outputTokens: 7 } };
  } }, new PromptAssetStore({ projectRoot: project.root }));
  const capability = new RunCapability(project, agent);
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(state.iteration, 2);
  assert.deepEqual(operations, ["verify_judging", "optimize", "verify_judging"]);
  const events = await capability.store.history();
  assert.equal(events.filter(event => event.data?.sdkEvent === "test.delta").length, 3);
  assert.equal(events.filter(event => event.data?.sdkEvent === "invocation.completed").length, 3);
  const budget = JSON.parse(await readFile(path.join(project.runtimeDir, "execution-budget.json"), "utf8"));
  assert.equal(budget.knownTokens, 54);
});

async function preparationBinding(project: Awaited<ReturnType<typeof fixture>>, complete = true) {
  const outputDir = path.join(project.runtimeDir, "preparation-baseline");
  await mkdir(outputDir, { recursive: true });
  const evidencePath = path.join(outputDir, "private-evidence.txt");
  await writeFile(evidencePath, "original private evidence");
  const resultPath = path.join(outputDir, "result.json");
  await writeFile(resultPath, JSON.stringify({ schemaVersion: 1, status: "completed", retention: "inconclusive",
    target: "achieved", summary: "prepared", publicFeedback: "public feedback", evidence: ["private-evidence.txt"] }));
  const files = await Promise.all(project.frozenContractFiles!.map(async file => ({ path: file, sha256: await sha256(file) })));
  await writeFile(path.join(outputDir, "binding.json"), JSON.stringify({ schemaVersion: 1,
    treeHash: await new VersionStore(project).treeHash("v1"), resultSha256: await sha256(resultPath), files,
    ...(complete ? { evidence: [{ path: evidencePath, sha256: await sha256(evidencePath) }] } : {}),
  }));
  return { evidencePath, resultPath };
}

test("compact blocks private preparation evidence changed between Init and Run", async () => {
  const project = await fixture("achieved");
  const prepared = await preparationBinding(project);
  await writeFile(prepared.evidencePath, "changed after Init");
  let optimizerCalls = 0;
  const capability = new RunCapability(project, { execute: async job => {
    if (job.operation === "optimize") optimizerCalls += 1;
    return { status: "completed" };
  } });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "blocked");
  assert.match(state.lastError ?? "", /Verification evidence changed/);
  assert.equal(optimizerCalls, 0);
  assert.equal(state.iteration, 1);
});

test("compact re-verifies old preparation bindings missing evidence hashes", async () => {
  const project = await fixture("achieved");
  await preparationBinding(project, false);
  let optimizerCalls = 0;
  const capability = new RunCapability(project, { execute: async job => {
    validateJobSpec(job);
    if (job.operation === "optimize") {
      optimizerCalls += 1;
      await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    }
    return { status: "completed" };
  } });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(optimizerCalls, 1);
  assert.equal(state.iteration, 2);
});

test("compact open acceptance improves a candidate before pausing on the unified attempt budget", async () => {
  const project = await fixture("achieved", false, "open");
  let optimizerCalls = 0;
  const capability = new RunCapability(project, { execute: async job => {
    validateJobSpec(job);
    assert.equal(job.operation, "optimize", "budget exhaustion must not invoke Manager");
    optimizerCalls += 1;
    await writeFile(path.join(job.writeRoots[0], "artifact.txt"), "new");
    return { status: "completed" };
  } }, { maxIterations: 1 });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused", state.lastError);
  assert.equal(optimizerCalls, 1);
  assert.equal(state.iteration, 2);
  assert.equal(state.compact?.history[0]?.retained, true);
  const result = JSON.parse(await readFile(state.compact!.baselineResultPath!, "utf8"));
  assert.equal(result.target, "inconclusive");
  assert.equal((await capability.store.history()).filter(event => event.type === "runtime.budget.exhausted").length, 1);
});

test("compact optimizer failure stays blocked without a Manager call or promotion", async () => {
  const project = await fixture("achieved");
  const calls: string[] = [];
  const capability = new RunCapability(project, { execute: async job => {
    validateJobSpec(job);
    calls.push(job.operation);
    return { status: "failed", artifacts: [], message: "original optimizer failure" };
  } });
  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "blocked");
  assert.equal(state.lastError, "original optimizer failure");
  assert.deepEqual(calls, ["optimize"]);
  assert.equal(state.iteration, 1);
  assert.equal(await capability.versions.hasTag("v2"), false);
});

test("compact Init failure hook preserves the original blocked error without a Manager call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-compact-init-failure-"));
  let calls = 0;
  const capability = new InitCapability({ projectRoot: root, workflow: "compact", agent: {
    execute: async () => { calls += 1; return { status: "failed", artifacts: [], message: "must not run" }; },
  } });
  const state = await capability.createState();
  state.status = "blocked";
  state.lastError = "original preparation failure";
  const result = await capability.manager.onFailure({ state, error: new Error(state.lastError), signal: new AbortController().signal });
  assert.deepEqual(result, { action: "stay_blocked" });
  assert.equal(calls, 0);
  assert.equal(state.status, "blocked");
  assert.equal(state.lastError, "original preparation failure");
});
