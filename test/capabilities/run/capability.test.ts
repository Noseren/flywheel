import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentJobResult, AgentService } from "../../../src/services/agent/protocol.ts";
import { RunCapability } from "../../../src/capabilities/run/capability.ts";
import type { PolicyRevisionCandidate, SteeringRevision, ValidationAttestation } from "../../../src/capabilities/run/state.ts";
import type { JobResult, JobSpec } from "../../../src/services/agent/job-protocol.ts";
import type { PromptRequest } from "../../../src/services/prompt/index.ts";
import { loadProject, type Project } from "../../../src/capabilities/run/project.ts";
import { VersionStore } from "../../../src/services/version/index.ts";
import { runCapability } from "../../../src/session/runner.ts";

function variable(prompt: PromptRequest, key: string): unknown {
  const direct = prompt.variables?.[key];
  if (direct !== undefined) return direct;
  for (const value of Object.values(prompt.variables ?? {})) {
    if (value && typeof value === "object" && "kind" in value) {
      const nested = variable(value as PromptRequest, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function portablePath(value: string): string {
  return value.replaceAll(path.sep, "/");
}

async function writeResult(job: JobSpec, value: JobResult): Promise<void> {
  assert.ok(job.resultPath);
  await mkdir(path.dirname(job.resultPath), { recursive: true });
  await writeFile(job.resultPath, `${JSON.stringify(value)}\n`);
}

async function fixture(options: { partitioned?: boolean; collector?: boolean } = {}): Promise<Project> {
  const partitioned = options.partitioned ?? true;
  const collector = options.collector ?? false;
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-run-kernel-"));
  const flywheel = path.join(root, ".flywheel");
  const contract = path.join(flywheel, "contract");
  await mkdir(path.join(contract, "data"), { recursive: true });
  await writeFile(path.join(flywheel, "goal.md"), "Improve answer quality.\n");
  await writeFile(path.join(root, "prompt.txt"), "Answer clearly.\n");
  if (partitioned) {
    await writeFile(path.join(contract, "data", "train.jsonl"), '{"id":"train-1","input":"one"}\n');
    await writeFile(path.join(contract, "data", "holdout.jsonl"), '{"id":"holdout-1","input":"two"}\n');
  }
  await writeFile(path.join(contract, "task.md"), "# Goal\nThe Evaluate and Analyze services own task semantics.\n");
  await writeFile(path.join(contract, "boundary.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifact: { path: "prompt.txt" },
    change_scope: { primary: ["prompt.txt"] },
  })}\n`);
  await writeFile(path.join(contract, "tasking_guide.md"), "Run the artifact.\n");
  await writeFile(path.join(contract, "requirements.json"), `${JSON.stringify({
    schemaVersion: 1,
    requirements: [{ id: "R1", source: "goal", text: "Evaluate the artifact" }],
  })}\n`);
  await writeFile(path.join(contract, "evaluate_guide.md"), "Evaluator defines its own report.\n");
  await writeFile(path.join(contract, "coverage.json"), `${JSON.stringify({
    schemaVersion: 1,
    checks: [{ id: "check-r1", requirementIds: ["R1"], artifactIds: ["evaluator"], locator: "evaluator#check-r1" }],
  })}\n`);
  await writeFile(path.join(contract, "evaluate.py"), "print('domain evaluator')\n");
  if (collector) {
    await writeFile(path.join(contract, "collect.js"), "// frozen collector\n");
    await writeFile(path.join(contract, "collector_guide.md"), "Run the frozen collector with isolated caches.\n");
  }
  await mkdir(path.join(flywheel, "init"), { recursive: true });
  await writeFile(path.join(flywheel, "init", "manifest.json"), `${JSON.stringify({
    schemaVersion: 4,
    status: "ready",
    baseline: "v1",
    files: [
      ["task", ".flywheel/contract/task.md"],
      ["boundary", ".flywheel/contract/boundary.json"],
      ["tasking-guide", ".flywheel/contract/tasking_guide.md"],
      ["requirements", ".flywheel/contract/requirements.json"],
      ["evaluate-guide", ".flywheel/contract/evaluate_guide.md"],
      ["coverage", ".flywheel/contract/coverage.json"],
      ["evaluator", ".flywheel/contract/evaluate.py"],
      ...(collector ? [
        ["collector", ".flywheel/contract/collect.js"],
        ["collector-guide", ".flywheel/contract/collector_guide.md"],
      ] : []),
      ["goal", ".flywheel/goal.md"],
      ...(partitioned ? [
        ["train", ".flywheel/contract/data/train.jsonl"],
        ["holdout", ".flywheel/contract/data/holdout.jsonl"],
      ] : []),
    ].map(([id, filePath]) => ({ id, path: filePath, sha256: "0".repeat(64) })),
  })}\n`);
  const project = await loadProject(root);
  await new VersionStore(project).tag("v1", "baseline v1");
  return project;
}

class RunAgent implements AgentService {
  provider = "test";
  model = "test";
  jobs: JobSpec[] = [];
  taskingAttempts = 0;
  evaluationAttempts = 0;
  candidateTaskingAttempts = 0;
  candidateEvaluationAttempts = 0;
  assessmentAttempts = 0;
  proposalAttempts = 0;
  missingFirstReport = false;
  invalidFirstCandidateTaskResult = false;
  missingFirstCandidateReport = false;
  missingCandidateReportAlways = false;
  invalidFirstDecision = false;
  invalidFirstAssessment = false;
  invalidFirstReview = false;
  expectTaskingOutputAbsent = false;
  failTasking = false;
  failEvaluation = false;
  failCandidateEvaluation = false;
  managerAction: "stay_paused" | "resume" = "stay_paused";
  assessment: "achieved" | "not_achieved" | "inconclusive" = "achieved";
  decision: "exhausted" | "ask_user" | "iterate" = "exhausted";
  selectionAction: "promote" | "iterate" = "promote";
  requestChangesFirst = false;
  requestChangesAlways = false;
  exhaustAfterFailedRound = false;
  targetAfterPromotion = false;
  tamperCandidateBeforePromotion = false;
  failCandidateRefine = false;
  invalidScopeFirst = false;
  writeRootCacheDuringCandidateTasking = false;
  writeWorktreeCacheDuringCandidateTasking = false;
  candidateRefineAttempts = 0;
  reviewAttempts = 0;
  report = "# Opaque report\nboolean, score, rubric, and coverage may use any domain format.\n";

  async execute(job: JobSpec): Promise<AgentJobResult> {
    this.jobs.push(job);
    if (job.label.startsWith("tasking:") || job.label.startsWith("candidate:tasking:")) {
      const candidate = job.label.startsWith("candidate:tasking:");
      if (candidate) this.candidateTaskingAttempts += 1;
      else this.taskingAttempts += 1;
      if (this.expectTaskingOutputAbsent) await assert.rejects(access(job.writeRoots[0]));
      if (!candidate && this.failTasking) {
        await writeResult(job, { status: "failed", artifacts: [], message: "tasking unavailable" });
        return {
          status: "failed", artifacts: [], message: "tasking unavailable",
          sessionId: `${job.sessionKey ?? job.label}-session`,
        };
      }
      if (candidate && this.writeRootCacheDuringCandidateTasking) {
        const projectRoot = variable(job.prompt, "project_root");
        assert.equal(typeof projectRoot, "string");
        const cacheFile = path.join(projectRoot as string, "v", "cache", "nodeids");
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, "implicit cache write\n");
      }
      if (candidate && this.writeWorktreeCacheDuringCandidateTasking) {
        const worktree = job.readRoots.find((root) => portablePath(root).endsWith("/worktree"));
        assert.ok(worktree);
        const cacheFile = path.join(worktree, "v", "cache", "nodeids");
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, "implicit cache write\n");
      }
      const sample = job.label.split(":").at(-1)!;
      const output = path.join(job.writeRoots[0], `${sample}.json`);
      await mkdir(job.writeRoots[0], { recursive: true });
      await writeFile(output, JSON.stringify({ output: sample }));
      if (!(candidate && this.invalidFirstCandidateTaskResult && this.candidateTaskingAttempts === 1)) {
        await writeResult(job, { status: "completed", artifacts: [output] });
      }
    } else if (job.label.startsWith("evaluate") || job.label.startsWith("candidate:evaluate:")) {
      this.evaluationAttempts += 1;
      const candidate = job.label.startsWith("candidate:evaluate:");
      if (candidate) this.candidateEvaluationAttempts += 1;
      if (this.failEvaluation || (candidate && this.failCandidateEvaluation)) {
        await writeResult(job, { status: "failed", artifacts: [], message: "evaluator unavailable" });
        return { status: "failed", artifacts: [], message: "evaluator unavailable", sessionId: "evaluation-session" };
      }
      const reportPath = path.join(job.writeRoots[0], "evaluation-report.md");
      const holdoutReportPath = variable(job.prompt, "holdout_report_path");
      await mkdir(job.writeRoots[0], { recursive: true });
      const missingReport = (this.missingFirstReport && this.evaluationAttempts === 1)
        || (candidate && (this.missingCandidateReportAlways
          || (this.missingFirstCandidateReport && this.candidateEvaluationAttempts === 1)));
      if (!missingReport) await writeFile(reportPath, this.report);
      if (!missingReport && typeof holdoutReportPath === "string" && holdoutReportPath !== "none") {
        await mkdir(path.dirname(holdoutReportPath), { recursive: true });
        await writeFile(holdoutReportPath, "# Private holdout report\nall held-out checks passed.\n");
      }
      await writeResult(job, {
        status: "completed",
        artifacts: missingReport ? [] : [
          reportPath,
          ...(typeof holdoutReportPath === "string" && holdoutReportPath !== "none" ? [holdoutReportPath] : []),
        ],
      });
    } else if (job.label.startsWith("assess-target:")) {
      this.assessmentAttempts += 1;
      const status = this.targetAfterPromotion
        ? (this.assessmentAttempts > 1 ? "achieved" : "not_achieved")
        : this.assessment;
      const decisionPath = variable(job.prompt, "decision_path");
      const reportPath = variable(job.prompt, "report_path");
      assert.equal(typeof decisionPath, "string");
      assert.equal(typeof reportPath, "string");
      await mkdir(path.dirname(decisionPath as string), { recursive: true });
      await writeFile(decisionPath as string, JSON.stringify({
        status: this.invalidFirstAssessment && this.assessmentAttempts === 1 ? "looks_good" : status,
        message: `assessment: ${status}`,
      }));
      await writeFile(reportPath as string, `# Target assessment\n${status}\n`);
      await writeResult(job, { status: "completed", artifacts: [decisionPath as string, reportPath as string] });
    } else if (job.label === "propose") {
      this.proposalAttempts += 1;
      const requested = this.exhaustAfterFailedRound && this.proposalAttempts > 1
          ? "exhausted"
          : this.decision;
      const decision = this.invalidFirstDecision && this.proposalAttempts === 1 ? "target_achieved" : requested;
      const planPath = variable(job.prompt, "plan_path");
      const proposalPath = variable(job.prompt, "proposal_path");
      assert.equal(typeof planPath, "string");
      assert.equal(typeof proposalPath, "string");
      await mkdir(path.dirname(planPath as string), { recursive: true });
      await writeFile(planPath as string, JSON.stringify({
        action: decision,
        base_state_id: variable(job.prompt, "agent_state_id"),
        steering_revision_id: variable(job.prompt, "steering_revision_id"),
        hypotheses: decision === "iterate" ? [{ id: "h1" }] : [],
      }));
      await writeFile(proposalPath as string, "# Proposal\nRead the opaque train report.\n");
    } else if (job.label.startsWith("candidate:refine:")) {
      this.candidateRefineAttempts += 1;
      if (this.failCandidateRefine) {
        return {
          status: "failed", artifacts: [], message: "refine executor unavailable",
          sessionId: `${job.sessionKey ?? job.label}-session`,
        };
      }
      const worktree = variable(job.prompt, "worktree_path");
      assert.equal(typeof worktree, "string");
      await writeFile(path.join(worktree as string, "prompt.txt"), "Answer clearly and safely.\n");
      if (this.invalidScopeFirst) {
        const outside = path.join(worktree as string, "outside.txt");
        if (this.candidateRefineAttempts === 1) await writeFile(outside, "outside scope\n");
        else await unlink(outside);
      }
    } else if (job.label.startsWith("candidate:review:")) {
      this.reviewAttempts += 1;
      const reviewPath = variable(job.prompt, "review_path");
      assert.equal(typeof reviewPath, "string");
      if (this.invalidFirstReview && this.reviewAttempts === 1) {
        await writeFile(reviewPath as string, '{"status":"approve","message":"invalid \\multicolumn"}');
        return { status: "completed", artifacts: [], sessionId: `${job.sessionKey ?? job.label}-session` };
      }
      const requestChanges = this.requestChangesAlways || (this.requestChangesFirst && this.reviewAttempts === 1);
      await writeFile(reviewPath as string, JSON.stringify({
        status: requestChanges ? "request_changes" : "approve",
        message: requestChanges ? "请收紧实现后原地复审" : "忠实实现假设",
      }));
    } else if (job.label === "select") {
      if (this.tamperCandidateBeforePromotion) {
        const worktree = job.readRoots.find((root) => portablePath(root).endsWith("/worktree"));
        assert.ok(worktree);
        await writeFile(path.join(worktree, "prompt.txt"), "changed after validation\n");
      }
      const selectionPath = variable(job.prompt, "selection_path");
      const decisionPath = variable(job.prompt, "decision_path");
      assert.equal(typeof selectionPath, "string");
      assert.equal(typeof decisionPath, "string");
      await writeFile(selectionPath as string, JSON.stringify({
        action: this.selectionAction,
        ...(this.selectionAction === "promote" ? { candidate_id: "h1" } : {}),
      }));
      await writeFile(decisionPath as string, "# Selection\nOnly validated evidence was compared.\n");
    } else if (job.label === "run:manager") {
      await job.onEvent?.({ sdkEvent: "thread.started", thread_id: "manager-session" });
      const decisionPath = variable(job.prompt, "decision_path");
      assert.equal(typeof decisionPath, "string");
      await mkdir(path.dirname(decisionPath as string), { recursive: true });
      await writeFile(decisionPath as string, JSON.stringify({
        action: this.managerAction,
        message: "评价服务失败，证据已保留。",
      }));
    }
    return { status: "completed", artifacts: [], sessionId: `${job.sessionKey ?? job.label}-session` };
  }

}

async function stagePolicyCandidate(
  runtime: RunCapability,
  id: string,
  source: string,
): Promise<void> {
  const directory = path.join(runtime.project.runtimeDir, "policy-fixtures", id);
  await mkdir(directory, { recursive: true });
  const modulePath = path.join(directory, "policy.mjs");
  await writeFile(modulePath, source);
  const module = await runtime.records.fileRef("policy-module", id, modulePath);
  assert.ok(module);
  const kinds: ValidationAttestation["kind"][] = [
    "policy.api", "policy.contract", "policy.replay", "policy.smoke",
  ];
  const evidence = await Promise.all(kinds.map(async (kind) => {
    const file = path.join(directory, `${kind}.json`);
    await writeFile(file, `${JSON.stringify({
      kind, subjectSha256: module.sha256, status: "passed",
      validator: { id: "test", version: "1" }, createdAt: new Date().toISOString(),
    })}\n`);
    const ref = await runtime.records.fileRef(kind, id, file);
    assert.ok(ref);
    return ref;
  }));
  const candidate: PolicyRevisionCandidate = {
    id, policyId: "candidate.run", revision: "2", module,
    apiValidation: [evidence[0]], contractTests: [evidence[1]],
    replayEvidence: [evidence[2]], smokeEvidence: [evidence[3]],
    createdAt: new Date().toISOString(),
  };
  await runtime.records.stage("policy", candidate);
}

test("Run keeps evaluation opaque and lets independent Target Assess decide achievement", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.report = "# Report\nresult = {ok:true}; no numeric score exists.\n";
  const runtime = new RunCapability(project, agent);
  const state = await runCapability(
    runtime,
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "paused");
  assert.equal(state.execution.lastOutcome?.data?.assessment, "achieved");
  assert.equal(await readFile(path.join(project.runDir("v1"), "evals", "evaluation-report.md"), "utf8"), agent.report);
  assert.equal(agent.jobs.some((job) => job.label.startsWith("evaluate")), true);
  const tasking = agent.jobs.find((job) => job.label.startsWith("tasking:"));
  const evaluate = agent.jobs.find((job) => job.label.startsWith("evaluate"));
  const assess = agent.jobs.find((job) => job.label === "assess-target:v1");
  assert.equal(tasking?.readRoots[0], project.root);
  assert.equal(evaluate?.readRoots[0], project.root);
  assert.match(portablePath(tasking?.readRoots[1] ?? ""), /\.flywheel\/runtime\/agent-jobs/);
  assert.match(portablePath(evaluate?.readRoots[1] ?? ""), /\.flywheel\/runtime\/agent-jobs/);
  assert.equal(tasking?.deniedPaths?.includes(project.evaluatorPath), false);
  assert.equal(evaluate?.deniedPaths?.includes(project.evaluatorPath), false);
  assert.equal(variable(tasking!.prompt, "holdout_data_path"), project.holdoutPath);
  assert.match(portablePath(String(variable(tasking!.prompt, "train_outputs_dir"))), /outputs\/train$/);
  assert.match(portablePath(String(variable(tasking!.prompt, "holdout_outputs_dir"))), /outputs\/holdout$/);
  assert.match(portablePath(String(variable(evaluate!.prompt, "holdout_report_path"))), /evals\/holdout\/evaluation-report\.md$/);
  assert.equal(assess?.readRoots.includes(path.join(project.runDir("v1"), "evals", "holdout", "evaluation-report.md")), true);
  assert.equal(agent.jobs.some((job) => job.label === "propose"), false);
  const steering = await runtime.records.active<SteeringRevision>("steering");
  assert.equal(steering?.originalGoal.path, path.relative(project.root, project.goalPath!));
  assert.equal(steering?.task.path, path.relative(project.root, project.taskPath));
  assert.notEqual(steering?.originalGoal.sha256, steering?.task.sha256);
});

test("candidate topology runs without synthetic train or holdout roles", async () => {
  const project = await fixture({ partitioned: false });
  const agent = new RunAgent();
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "paused");
  assert.equal(project.trainsetPath, undefined);
  assert.equal(project.holdoutPath, undefined);
  const tasking = agent.jobs.find((job) => job.label === "tasking:v1");
  const assess = agent.jobs.find((job) => job.label === "assess-target:v1");
  assert.equal(variable(tasking!.prompt, "train_data_path"), "none");
  assert.equal(variable(tasking!.prompt, "holdout_data_path"), "none");
  assert.equal(variable(tasking!.prompt, "evaluation_topology"), "candidate");
  assert.equal(variable(tasking!.prompt, "candidate_outputs_dir"), path.join(project.runDir("v1"), "outputs"));
  assert.equal(variable(assess!.prompt, "holdout_report_path"), "none");
  await assert.rejects(access(path.join(project.runDir("v1"), "outputs", "train")));
  await assert.rejects(access(path.join(project.runDir("v1"), "outputs", "holdout")));
  await assert.rejects(access(path.join(project.runDir("v1"), "evals", "train")));
  await assert.rejects(access(path.join(project.runDir("v1"), "evals", "holdout")));
});

test("Tasking owns the frozen evidence entrypoint and keeps subject root distinct from artifact", async () => {
  const project = await fixture({ partitioned: false, collector: true });
  const agent = new RunAgent();
  const runtime = new RunCapability(project, agent);
  const state = await runCapability(runtime, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused");
  const tasking = agent.jobs.find((job) => job.label === "tasking:v1")!;
  assert.equal(variable(tasking.prompt, "collector_path"), project.collectorPath);
  assert.equal(variable(tasking.prompt, "collector_guide_path"), project.collectorGuidePath);
  assert.equal(variable(tasking.prompt, "subject_root"), project.root);
  assert.equal(variable(tasking.prompt, "artifact_path"), project.artifactPath);
  assert.notEqual(variable(tasking.prompt, "subject_root"), variable(tasking.prompt, "artifact_path"));
  assert.equal(typeof state.collectorSha256, "string");
  assert.equal(typeof state.collectorGuideSha256, "string");
});

test("candidate topology keeps Refine validation and adopted evidence unpartitioned", async () => {
  const project = await fixture({ partitioned: false });
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.targetAfterPromotion = true;
  const runtime = new RunCapability(project, agent);
  const state = await runCapability(runtime, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "paused");
  assert.equal(state.iteration, 2);
  const candidateTask = agent.jobs.find((job) => job.label === "candidate:tasking:h1")!;
  assert.equal(variable(candidateTask.prompt, "evaluation_topology"), "candidate");
  const candidateSubjectRoot = String(variable(candidateTask.prompt, "subject_root"));
  assert.match(portablePath(candidateSubjectRoot), /\/worktree$/);
  assert.equal(variable(candidateTask.prompt, "artifact_path"), path.join(candidateSubjectRoot, "prompt.txt"));
  await assert.rejects(access(path.join(candidateTask.writeRoots[0], "train")));
  await assert.rejects(access(path.join(candidateTask.writeRoots[0], "holdout")));
  await access(path.join(project.runDir("v2"), "outputs", "job-result.json"));
  await assert.rejects(access(path.join(project.runDir("v2"), "outputs", "train")));
});

test("an achieved target pauses for Manager and an explicit continuation reaches Propose without leaking assessment", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.managerAction = "resume";
  const runtime = new RunCapability(project, agent);
  const signal = new AbortController().signal;
  const achieved = await runCapability(runtime, { type: "start" }, signal);
  assert.equal(achieved.status, "paused");

  const continued = await runCapability(runtime, {
    type: "intervene", message: "继续优化错误信息的可读性",
  }, signal);

  assert.equal(continued.status, "waiting_for_user");
  assert.equal(continued.execution.lastOutcome?.data?.action, "exhausted");
  assert.equal(agent.assessmentAttempts, 1);
  const propose = agent.jobs.find((job) => job.label === "propose");
  assert.equal(variable(propose!.prompt, "manager_guidance"), "继续优化错误信息的可读性");
  assert.equal(propose?.readRoots.some((root) => root.includes("target-assessment")), false);
});

test("an inconclusive target assessment pauses and retries in the same session after Manager guidance", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.assessment = "inconclusive";
  agent.managerAction = "resume";
  const runtime = new RunCapability(project, agent);
  const signal = new AbortController().signal;
  const inconclusive = await runCapability(runtime, { type: "start" }, signal);
  assert.equal(inconclusive.status, "paused");
  assert.equal(inconclusive.execution.lastOutcome?.data?.assessment, "inconclusive");

  agent.assessment = "not_achieved";
  const continued = await runCapability(runtime, {
    type: "intervene", message: "现有评价报告已经覆盖全部冻结目标，请重新判断",
  }, signal);

  assert.equal(continued.status, "waiting_for_user");
  assert.equal(agent.assessmentAttempts, 2);
  const assessments = agent.jobs.filter((job) => job.label === "assess-target:v1");
  assert.equal(assessments[1].resumeSessionId, "assess-target:v1-session");
});

test("Evaluate repairs only a damaged JobResult/report protocol in the same session", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.missingFirstReport = true;
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "paused");
  assert.equal(agent.evaluationAttempts, 2);
  const evaluations = agent.jobs.filter((job) => job.label.startsWith("evaluate"));
  assert.equal(evaluations[1].resumeSessionId, "evaluate:v1-session");
});

test("Target Assess repairs an invalid finite decision in its original session", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.invalidFirstAssessment = true;
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "paused");
  assert.equal(agent.assessmentAttempts, 2);
  const assessments = agent.jobs.filter((job) => job.label === "assess-target:v1");
  assert.equal(assessments[1].resumeSessionId, "assess-target:v1-session");
});

test("Candidate Validate reuses Tasking and Evaluate artifact repair in the same sessions", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.targetAfterPromotion = true;
  agent.invalidFirstCandidateTaskResult = true;
  agent.missingFirstCandidateReport = true;

  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "paused");
  const taskingJobs = agent.jobs.filter((job) => job.label === "candidate:tasking:h1");
  const evaluationJobs = agent.jobs.filter((job) => job.label === "candidate:evaluate:h1");
  assert.equal(taskingJobs.length, 2);
  assert.equal(evaluationJobs.length, 2);
  assert.equal(taskingJobs[1].resumeSessionId, "candidate-task:v1:h1-session");
  assert.equal(evaluationJobs[1].resumeSessionId, "candidate-eval:v1:h1-session");
  assert.match(portablePath(String(variable(taskingJobs[1].prompt, "outputs_dir"))), /\/outputs$/);
});

test("Propose rejects the legacy target_achieved action and repairs in the original session", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.invalidFirstDecision = true;
  agent.assessment = "not_achieved";
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "waiting_for_user");
  assert.equal(agent.proposalAttempts, 2);
  assert.equal(agent.jobs.filter((job) => job.label === "propose")[1].resumeSessionId, "propose-session");
});

test("Run Manager discussion preserves an unanswered question without advancing operations", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.assessment = "not_achieved";
  agent.decision = "ask_user";
  const runtime = new RunCapability(project, agent);
  const signal = new AbortController().signal;
  const waiting = await runCapability(runtime, { type: "start" }, signal);
  const pending = structuredClone(waiting.pendingInteraction);
  assert.ok(pending);
  waiting.execution.operationState.managerGuidance = "旧指导：暂停等待外部输入";
  await runtime.store.save(waiting);
  const jobsBefore = agent.jobs.length;
  const discussed = await runCapability(runtime, {
    type: "intervene", message: "为什么需要我确认？先解释，不要继续。",
  }, signal);
  assert.equal(discussed.status, "paused");
  assert.deepEqual(discussed.pendingInteraction, pending);
  assert.equal(discussed.execution.operationState.managerGuidance, undefined);
  assert.equal(discussed.iteration, waiting.iteration);
  const jobs = agent.jobs.slice(jobsBefore);
  assert.deepEqual(jobs.map((job) => job.label), ["run:manager"]);
  const context = variable(jobs[0].prompt, "runtime_context") as Record<string, unknown>;
  assert.deepEqual(context.pendingInteraction, pending);
  assert.equal(context.previousGuidance, "旧指导：暂停等待外部输入");
});

test("a legal failed evaluation is routed to Capability Manager", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.failEvaluation = true;
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "blocked");
  assert.match(state.lastError ?? "", /证据已保留/);
  assert.equal(agent.jobs.filter((job) => job.label === "run:manager").length, 1);
});

test("a failed Tasking JobResult is rerun in the original session instead of being reused", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.expectTaskingOutputAbsent = true;
  agent.failTasking = true;
  const runtime = new RunCapability(project, agent);
  const signal = new AbortController().signal;

  const failed = await runCapability(runtime, { type: "start" }, signal);
  assert.equal(failed.status, "blocked");
  assert.equal(failed.execution.currentOperationId, "tasking");
  assert.equal(agent.taskingAttempts, 1);
  assert.equal(agent.evaluationAttempts, 0);

  agent.failTasking = false;
  agent.managerAction = "resume";
  const retried = await runCapability(runtime, {
    type: "intervene", message: "请重试当前 Tasking",
  }, signal);

  assert.equal(retried.status, "paused");
  assert.equal(agent.taskingAttempts, 2);
  assert.equal(agent.evaluationAttempts, 1);
  const taskingJobs = agent.jobs.filter((job) => job.label === "tasking:v1");
  assert.equal(taskingJobs[1].resumeSessionId, "tasking:v1-session");
});

test("Runtime restores a modified frozen evaluator and blocks before another operation", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.managerAction = "resume";
  const runtime = new RunCapability(project, agent);
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  await runtime.store.save(state);
  await writeFile(project.evaluatorPath, "tampered\n");
  const result = await runCapability(runtime, { type: "resume" }, signal);
  assert.equal(result.status, "blocked");
  const blocked = await runtime.store.load();
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.lastError ?? "", /证据已保留/);
  assert.equal(agent.jobs.filter((job) => job.label === "run:manager").length, 1);
  const response = (await runtime.history()).find((event) => event.type === "manager.responded"
    && event.data?.source === "runtime_failure");
  assert.equal(response?.data?.action, "stay_paused");
  assert.equal(response?.data?.requestedAction, "resume");
  assert.equal(await readFile(project.evaluatorPath, "utf8"), "print('domain evaluator')\n");
});

test("Runtime restores a modified frozen goal and boundary and blocks", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent());
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  await runtime.store.save(state);
  await writeFile(project.taskPath, "tampered\n");
  const result = await runCapability(runtime, { type: "resume" }, signal);
  assert.equal(result.status, "blocked");
  assert.match(await readFile(project.taskPath, "utf8"), /Evaluate and Analyze/);
});

test("Runtime restores a modified original user goal and blocks", async () => {
  const project = await fixture();
  assert.ok(project.goalPath);
  const runtime = new RunCapability(project, new RunAgent());
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  await runtime.store.save(state);
  await writeFile(project.goalPath, "changed\n");
  const result = await runCapability(runtime, { type: "resume" }, signal);
  assert.equal(result.status, "blocked");
  assert.equal(await readFile(project.goalPath, "utf8"), "Improve answer quality.\n");
});

test("Runtime restores a modified machine boundary and blocks", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent());
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  await runtime.store.save(state);
  await writeFile(project.boundaryPath, '{"schemaVersion":1,"artifact":{"path":"other.txt"},"change_scope":{"primary":["other.txt"]}}\n');
  const result = await runCapability(runtime, { type: "resume" }, signal);
  assert.equal(result.status, "blocked");
  assert.match(await readFile(project.boundaryPath, "utf8"), /prompt\.txt/);
});

test("an incomplete Operation restores its Run cursors and project checkpoint before retry", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent());
  const state = await runtime.createState(new AbortController().signal);
  const signal = new AbortController().signal;
  state.refineAttempt = 2;
  await runtime.beforeOperation(state, "refine", signal);

  state.iteration = 7;
  state.refineAttempt = 9;
  await writeFile(path.join(project.root, "prompt.txt"), "escaped operation\n");
  await runtime.beforeOperation(state, "refine", signal);

  assert.equal(state.iteration, 1);
  assert.equal(state.refineAttempt, 2);
  assert.equal(await readFile(path.join(project.root, "prompt.txt"), "utf8"), "Answer clearly.\n");
});

test("Refine returns to Propose when a legacy cursor has no proposal artifacts", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "ask_user";
  agent.assessment = "not_achieved";
  const runtime = new RunCapability(project, agent);
  const signal = new AbortController().signal;
  const state = await runCapability(runtime, { type: "start" }, signal);
  assert.equal(state.status, "waiting_for_user");
  agent.decision = "iterate";
  agent.targetAfterPromotion = true;
  agent.proposalAttempts = 0;
  state.status = "paused";
  state.refineAttempt = 2;
  state.execution.currentOperationId = "refine";
  state.execution.lastOutcome = {
    operationId: "propose", status: "completed", data: { action: "iterate", hypothesisIds: ["missing"] },
  };
  delete state.operationTransaction;
  delete state.operationRunId;
  await runtime.store.save(state);

  const resumed = await runCapability(runtime, { type: "start" }, signal);

  const blocked = (await runtime.history()).findLast((event) => event.type === "runtime.blocked");
  assert.equal(resumed.status, "paused", String(blocked?.data?.error));
  assert.equal(resumed.iteration, 2);
  assert.equal(agent.proposalAttempts, 1);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:refine:missing"), false);
  const recoveredPlan = JSON.parse(await readFile(
    path.join(project.runDir("v1"), "search", "round-2", "plan.json"), "utf8",
  ));
  assert.equal(recoveredPlan.action, "iterate");
});

test("Propose can request user input through its own persistent Agent session", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "ask_user";
  agent.assessment = "not_achieved";
  const runtime = new RunCapability(project, agent);
  const state = await runCapability(runtime, { type: "start" }, new AbortController().signal);
  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.pendingInteraction?.requestedBy.type, "agent");
  assert.equal(state.pendingInteraction?.conversationWith?.sessionKey, "propose");
});

test("Propose reports exhausted search only after Target Assess says the goal is not achieved", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "exhausted";
  agent.assessment = "not_achieved";
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.execution.lastOutcome?.data?.action, "exhausted");
  assert.match(state.pendingInteraction?.question ?? "", /尚未被证明达到目标/);
});

test("Run refines in a detached worktree, independently reviews, validates, selects, and promotes", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.requestChangesFirst = true;
  agent.targetAfterPromotion = true;
  const runtime = new RunCapability(project, agent);
  const state = await runCapability(
    runtime,
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "paused");
  assert.equal(state.iteration, 2);
  assert.equal(state.execution.lastOutcome?.operationId, "assess_target");
  assert.equal(state.execution.lastOutcome?.data?.assessment, "achieved");
  assert.equal(agent.proposalAttempts, 1);
  assert.equal(await readFile(path.join(project.root, "prompt.txt"), "utf8"), "Answer clearly and safely.\n");
  assert.equal(await new VersionStore(project).hasTag("v2"), true);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:refine:h1"), true);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:review:h1"), true);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:tasking:h1"), true);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:evaluate:h1"), true);
  assert.equal(agent.jobs.some((job) => job.label === "select"), true);
  const select = agent.jobs.find((job) => job.label === "select");
  assert.equal(select?.readRoots.every((root) => path.isAbsolute(root)), true);
  assert.equal(variable(select!.prompt, "current_train_evaluation_path"), path.join(project.runDir("v1"), "evals", "evaluation-report.md"));
  assert.equal(select?.readRoots.includes(path.join(project.runDir("v1"), "evals", "evaluation-report.md")), true);
  const candidateTask = agent.jobs.find((job) => job.label === "candidate:tasking:h1");
  assert.equal(candidateTask?.sessionKey, "candidate-task:v1:h1");
  assert.equal(candidateTask?.readRoots.includes(project.root), true);
  assert.equal(variable(candidateTask!.prompt, "project_root"), project.root);
  const candidateEvaluate = agent.jobs.find((job) => job.label === "candidate:evaluate:h1");
  assert.equal(candidateEvaluate?.readRoots.includes(project.root), true);
  assert.equal(variable(candidateEvaluate!.prompt, "project_root"), project.root);
  const candidateArtifact = variable(candidateTask!.prompt, "artifact_path");
  assert.equal(typeof candidateArtifact, "string");
  assert.equal(
    await readFile(path.join(path.dirname(candidateArtifact as string), ".flywheel", "contract", "task.md"), "utf8"),
    "# Goal\nThe Evaluate and Analyze services own task semantics.\n",
  );
  assert.equal(agent.jobs.some((job) => job.label === "tasking:v2"), false);
  assert.equal(agent.jobs.some((job) => job.label === "evaluate:v2"), false);
  const v2Operations = (await runtime.history())
    .filter((event) => event.type === "operation.started" && event.version === "v2")
    .map((event) => event.operation);
  assert.deepEqual(v2Operations, ["assess_target"]);
  const adopted = JSON.parse(await readFile(path.join(project.runDir("v2"), "evidence", "adopted-candidate.json"), "utf8"));
  assert.equal(adopted.candidateId, "h1");
  const adoptedTask = JSON.parse(await readFile(path.join(project.runDir("v2"), "outputs", "train", "job-result.json"), "utf8"));
  assert.equal(adoptedTask.artifacts.every((artifact: string) => portablePath(artifact).includes("/.flywheel/runs/v2/outputs/")), true);
  const adoptedEvaluation = JSON.parse(await readFile(path.join(project.runDir("v2"), "evals", "job-result.json"), "utf8"));
  assert.equal(adoptedEvaluation.artifacts.every((artifact: string) => portablePath(artifact).includes("/.flywheel/runs/v2/evals/")), true);
  const refines = agent.jobs.filter((job) => job.label === "candidate:refine:h1");
  assert.equal(refines.length, 2);
  assert.equal(refines.every((job) => job.cwd !== project.root), true);
  assert.match(portablePath(refines[0].cwd), /\/\.flywheel\/w\/v1-r1\/h1$/);
  assert.equal(portablePath(refines[0].cwd).includes("/runs/v1/search/"), false);
  assert.equal(refines.every((job) => job.readRoots.every((root) => root.startsWith(job.cwd))), true);
  const reviews = agent.jobs.filter((job) => job.label === "candidate:review:h1");
  assert.equal(reviews.every((job) => job.cwd === refines[0]?.cwd), true);
  assert.equal(refines[1].resumeSessionId, "candidate:v1:h1-session");
  assert.equal(String(variable(refines[1].prompt, "review_path")).startsWith(refines[1].cwd), true);
  const changedPathsPath = variable(reviews[0].prompt, "changed_paths_path");
  assert.equal(typeof changedPathsPath, "string");
  const changedPaths = JSON.parse(await readFile(changedPathsPath as string, "utf8"));
  assert.deepEqual(changedPaths.files, ["prompt.txt"]);
});

test("candidate Tasking root cache writes are blocked immediately with the Job label and path", async () => {
  const project = await fixture({ partitioned: false });
  const agent = new RunAgent();
  agent.assessment = "not_achieved";
  agent.decision = "iterate";
  agent.writeRootCacheDuringCandidateTasking = true;
  const runtime = new RunCapability(project, agent);
  await runCapability(runtime, { type: "start" }, new AbortController().signal);
  const blocked = (await runtime.history()).findLast((event) => event.type === "runtime.blocked");
  assert.match(String(blocked?.data?.error), /Job candidate:tasking:h1 modified the formal project/);
  assert.match(String(blocked?.data?.error), /v\/cache\/nodeids/);
});

test("candidate Tasking worktree cache writes are blocked before Evaluate with accurate attribution", async () => {
  const project = await fixture({ partitioned: false });
  const agent = new RunAgent();
  agent.assessment = "not_achieved";
  agent.decision = "iterate";
  agent.writeWorktreeCacheDuringCandidateTasking = true;
  const runtime = new RunCapability(project, agent);
  await runCapability(runtime, { type: "start" }, new AbortController().signal);
  const blocked = (await runtime.history()).findLast((event) => event.type === "runtime.blocked");
  assert.match(String(blocked?.data?.error), /Job candidate:tasking:h1 modified the candidate worktree/);
  assert.match(String(blocked?.data?.error), /v\/cache\/nodeids/);
  assert.doesNotMatch(String(blocked?.data?.error), /prompt\.txt/);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:evaluate:h1"), false);
});

test("Candidate Review repairs invalid JSON in the original Child session", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.invalidFirstReview = true;
  agent.targetAfterPromotion = true;
  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );
  assert.equal(state.status, "paused");
  const reviews = agent.jobs.filter((job) => job.label === "candidate:review:h1");
  assert.equal(reviews.length, 2);
  assert.equal(reviews[1].resumeSessionId, "candidate-review:v1:h1-session");
});

test("Candidate Refine repairs change-scope violations in the original Child session", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.invalidScopeFirst = true;
  agent.targetAfterPromotion = true;

  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "paused");
  const refines = agent.jobs.filter((job) => job.label === "candidate:refine:h1");
  assert.equal(refines.length, 2);
  assert.equal(refines[1].resumeSessionId, "candidate:v1:h1-session");
  assert.match(String(variable(refines[1].prompt, "review_path")), /review\.json$/);
  assert.equal(agent.reviewAttempts, 1);
});

test("Review repair exhaustion returns failed evidence to the next Propose round", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.assessment = "not_achieved";
  agent.requestChangesAlways = true;
  agent.exhaustAfterFailedRound = true;

  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.execution.lastOutcome?.data?.action, "exhausted");
  assert.equal(state.iteration, 1);
  assert.equal(state.refineAttempt, 2);
  assert.equal(agent.reviewAttempts, 3);
  assert.equal(agent.proposalAttempts, 2);
  assert.equal(agent.jobs.some((job) => job.label === "select"), false);
  assert.equal(agent.jobs.some((job) => job.label === "candidate:tasking:h1"), false);
  const resultPath = path.join(project.runDir("v1"), "search", "round-1", "candidates", "h1", "result.json");
  const failed = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /exhausted its Refine\/Review repair budget/);
  const secondProposal = agent.jobs.filter((job) => job.label === "propose")[1];
  assert.equal(secondProposal.readRoots.includes(resultPath), true);
  assert.equal(secondProposal.readRoots.some((root) => portablePath(root).endsWith("/review.json")), true);
  assert.equal(secondProposal.readRoots.some((root) => portablePath(root).endsWith("/diff.patch")), true);
});

test("Candidate Validate repair exhaustion returns failed evidence to the next Propose round", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.assessment = "not_achieved";
  agent.missingCandidateReportAlways = true;
  agent.exhaustAfterFailedRound = true;

  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.execution.lastOutcome?.data?.action, "exhausted");
  assert.equal(state.refineAttempt, 2);
  assert.equal(agent.candidateEvaluationAttempts, 4);
  assert.equal(agent.proposalAttempts, 2);
  assert.equal(agent.jobs.some((job) => job.label === "select"), false);
  const resultPath = path.join(project.runDir("v1"), "search", "round-1", "candidates", "h1", "result.json");
  const failed = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /exhausted its Validate repair budget/);
  const secondProposal = agent.jobs.filter((job) => job.label === "propose")[1];
  assert.equal(secondProposal.readRoots.includes(resultPath), true);
});

test("a legal Candidate Validate failure returns failed evidence to the next Propose round", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.assessment = "not_achieved";
  agent.failCandidateEvaluation = true;
  agent.exhaustAfterFailedRound = true;

  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.execution.lastOutcome?.data?.action, "exhausted");
  assert.equal(state.refineAttempt, 2);
  assert.equal(agent.candidateEvaluationAttempts, 1);
  assert.equal(agent.proposalAttempts, 2);
  assert.equal(agent.jobs.some((job) => job.label === "select"), false);
  const resultPath = path.join(project.runDir("v1"), "search", "round-1", "candidates", "h1", "result.json");
  const failed = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Candidate h1 failed Validate: evaluator unavailable/);
});

test("candidate execution failures remain blocked for Manager instead of being reframed as hypotheses", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.assessment = "not_achieved";
  agent.failCandidateRefine = true;

  const state = await runCapability(
    new RunCapability(project, agent),
    { type: "start" },
    new AbortController().signal,
  );

  assert.equal(state.status, "blocked");
  assert.equal(agent.proposalAttempts, 1);
  assert.equal(agent.jobs.some((job) => job.label === "select"), false);
  const failed = JSON.parse(await readFile(path.join(
    project.runDir("v1"), "search", "round-1", "candidates", "h1", "result.json",
  ), "utf8"));
  assert.match(failed.error, /refine executor unavailable/);
});

test("promotion rejects a candidate worktree changed after its evaluation", async () => {
  const project = await fixture();
  const agent = new RunAgent();
  agent.decision = "iterate";
  agent.assessment = "not_achieved";
  agent.tamperCandidateBeforePromotion = true;
  const runtime = new RunCapability(project, agent);

  const state = await runCapability(runtime, { type: "start" }, new AbortController().signal);

  assert.equal(state.status, "blocked");
  assert.equal(await new VersionStore(project).hasTag("v2"), false);
  const blocked = (await runtime.history()).findLast((event) => event.type === "runtime.blocked");
  assert.match(String(blocked?.data?.error), /changed after Tasking and Evaluate/);
});

test("an administrative command preserves and resumes the main Run continuation", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent());
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  state.status = "paused";
  state.execution.currentOperationId = "evaluate";
  state.execution.lastOutcome = { operationId: "tasking", status: "completed" };
  state.execution.operationState = { durable: "main-loop" };

  await runtime.prepare(state, {
    type: "command",
    command: { type: "steering.propose" },
  }, signal);
  assert.equal(state.adminReturn?.currentOperationId, "evaluate");
  assert.deepEqual(state.adminReturn?.operationState, { durable: "main-loop" });

  // Model the successful admin operation boundary; the next start restores the
  // captured search window instead of treating the Capability as completed.
  delete state.pendingRunCommand;
  state.status = "paused";
  state.execution.currentOperationId = "steering.propose";
  state.execution.lastOutcome = { operationId: "steering.propose", status: "paused" };
  state.execution.operationState = {};
  await runtime.prepare(state, { type: "start" }, signal);
  assert.equal(state.status, "running");
  assert.equal(state.execution.currentOperationId, "evaluate");
  assert.deepEqual(state.execution.lastOutcome, { operationId: "tasking", status: "completed" });
  assert.deepEqual(state.execution.operationState, { durable: "main-loop" });
  assert.equal(state.adminReturn, undefined);
});

test("an approved Policy waits at an unsafe operation and activates at a trusted safe point", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent(), { allowDynamicPolicy: true });
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  state.status = "paused";
  state.execution.currentOperationId = "refine";
  await runtime.store.save(state);
  await stagePolicyCandidate(runtime, "policy-good", `export default {
    id: "candidate.run", revision: "2", operations: {
      tasking: async () => ({ status: "completed" })
    }, decide() { return { type: "complete" }; }
  };\n`);

  const approved = await runCapability(runtime, {
    type: "command", command: { type: "policy.activate", candidateId: "policy-good" },
  }, signal);
  assert.equal(approved.status, "paused");
  assert.equal(approved.commandResult?.status, "approved_pending_safe_point");
  assert.equal(approved.operationTransaction, undefined);

  const oldPolicy = await runtime.policySource();
  assert.equal(oldPolicy.id, "flywheel.run");
  assert.equal(await runtime.records.active("policy"), undefined);

  const safe = await runtime.store.load();
  safe.execution.currentOperationId = "tasking";
  await runtime.store.save(safe);
  const activated = await runtime.policySource();
  assert.equal(activated.id, "candidate.run");
  assert.equal((await runtime.records.active<PolicyRevisionCandidate>("policy"))?.id, "policy-good");
});

test("a broken approved Policy rolls back at activation without replacing the effective Policy", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent(), { allowDynamicPolicy: true });
  const signal = new AbortController().signal;
  const state = await runtime.createState(signal);
  state.status = "paused";
  state.execution.currentOperationId = "refine";
  await runtime.store.save(state);
  await stagePolicyCandidate(runtime, "policy-broken", "this is not valid javascript\n");
  await runCapability(runtime, {
    type: "command", command: { type: "policy.activate", candidateId: "policy-broken" },
  }, signal);
  const safe = await runtime.store.load();
  safe.execution.currentOperationId = "tasking";
  await runtime.store.save(safe);

  const restored = await runtime.policySource();
  assert.equal(restored.id, "flywheel.run");
  assert.equal(await runtime.records.active("policy"), undefined);
  assert.equal(await runtime.records.active("policy-pending"), undefined);
});

test("formal Run rejects Agent-authored Policy activation", async () => {
  const project = await fixture();
  const runtime = new RunCapability(project, new RunAgent());
  const state = await runtime.createState(new AbortController().signal);
  await assert.rejects(runtime.prepare(state, {
    type: "command", command: { type: "policy.activate", candidateId: "candidate" },
  }, new AbortController().signal), /disabled outside explicit developer mode/);
});
