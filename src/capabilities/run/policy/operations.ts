import type { AgentJobResult } from "../../../services/agent/protocol.ts";
import type { JobResult, JobSpec } from "../../../services/agent/job-protocol.ts";
import type {
  ArtifactValidationIssue,
  ValidatedArtifactContext,
} from "../../../services/artifact/index.ts";
import { AgentExecutionError, ArtifactRepairExhausted } from "../../../services/artifact/index.ts";
import type { PromptRequest } from "../../../services/prompt/index.ts";
import type { SearchResult, SearchService } from "../../../services/search/index.ts";
import type { WorkspaceService } from "../../../services/workspace/index.ts";
import type {
  ArtifactRef,
  VersionRecord,
} from "../../../services/version/index.ts";
import type {
  AgentStateManifest,
  EpisodeRecord,
  EvolutionRecord,
  SteeringRevision,
  SteeringCandidate,
  PolicyRevisionCandidate,
  PolicyActivationPending,
  ValidationAttestation,
} from "../state.ts";
import { versionOf } from "../state.ts";
import type { Project } from "../project.ts";
import type { ExecutionPolicy, PolicyOutcome } from "../../../session/policy.ts";
import type { RunCommand, RunState } from "../protocol.ts";

export type RunOperationResult = PolicyOutcome;

export interface RunPolicyServices {
  readonly process?: import("../../../services/process/index.ts").ProcessService;
  readonly rawAgent?: import("../../../services/agent/protocol.ts").AgentService;
  readonly executionBudget?: import("../../../session/execution-budget.ts").ExecutionBudget;
  readonly project: Project;
  readonly agent: {
    readonly provider?: string;
    readonly model?: string;
    execute(state: RunState, job: JobSpec, signal?: AbortSignal): Promise<AgentJobResult>;
  };
  readonly artifact: {
    run<T>(state: RunState, options: {
      artifactId: string;
      operationId: string;
      job: string;
      signal?: AbortSignal;
      present(): Promise<boolean>;
      validate(): Promise<T>;
      classify(error: unknown): ArtifactValidationIssue[] | undefined;
      execute(context: ValidatedArtifactContext): Promise<AgentJobResult>;
    }): Promise<T>;
    readJobResult(job: JobSpec): Promise<JobResult>;
  };
  readonly workspace: WorkspaceService;
  readonly state: {
    id(prefix: string): string;
    now(): string;
    emit(state: RunState, type: string, data?: Record<string, unknown>): Promise<void>;
    checkpoint(state: RunState): Promise<void>;
  };
  readonly version: {
    hasTag(tag: string): Promise<boolean>;
    assertExact(tag: string): Promise<void>;
    changedFiles(from: string, to?: string): Promise<string[]>;
    diff(from: string, to?: string): Promise<string>;
    treeHash(tag: string): Promise<string>;
    createWorktree(tag: string, destination: string): Promise<void>;
    worktreeChanges(destination: string): Promise<{ files: string[]; diff: string }>;
    worktreeTreeHash(destination: string): Promise<string>;
    promoteWorktree(destination: string, tag: string, message: string): Promise<void>;
    prepare(target: string): Promise<void>;
    tag(tag: string, message: string): Promise<void>;
    readonly records: {
      verifyRef(ref: ArtifactRef): Promise<void>;
      resolveRef(ref: ArtifactRef): Promise<string | undefined>;
      fileRef(id: string, version: string, file: string): Promise<ArtifactRef | undefined>;
      snapshotRef(version: string, treeHash: string): ArtifactRef;
      write<T extends VersionRecord>(collection: string, record: T): Promise<T>;
      load<T extends VersionRecord>(collection: string, id: string): Promise<T>;
      hashStaged(collection: string, id: string): Promise<string>;
      active<T extends VersionRecord>(collection: string): Promise<T | undefined>;
      activate(collection: string, id: string): Promise<unknown>;
      stage<T extends VersionRecord>(collection: string, record: T): Promise<T>;
      loadStaged<T extends VersionRecord>(collection: string, id: string): Promise<T>;
      commitStaged<T extends VersionRecord>(collection: string, id: string): Promise<T>;
    };
  };
  readonly search: SearchService;
  readonly guard: {
    project<T>(state: RunState, label: string, execute: () => Promise<T>): Promise<T>;
    worktree<T>(root: string, label: string, execute: () => Promise<T>): Promise<T>;
  };
  prompt(id: string, variables?: Record<string, unknown | PromptRequest>): PromptRequest;
  protectedPaths(): string[];
}

export type RunExecutionPolicy = ExecutionPolicy<RunPolicyServices, RunState, RunCommand, RunOperationResult>;

export async function bootstrap({ services, state }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const records = services.version.records;
  let agentState = await records.active<AgentStateManifest>("agent-state");
  let steering = await records.active<SteeringRevision>("steering");
  if (steering && (!steering.originalGoal || !steering.task)) {
    throw new Error("Active Steering record predates originalGoal/task separation; back up .flywheel and re-run init");
  }
  if (!agentState || !steering) {
    const [originalGoal, task, boundary, evaluator, approval] = await Promise.all([
      records.fileRef("original-goal", "v1", services.project.goalPath ?? services.project.taskPath),
      records.fileRef("task", "v1", services.project.taskPath),
      records.fileRef("boundary", "v1", services.project.boundaryPath),
      records.fileRef("evaluator", "v1", services.project.evaluatorPath),
      records.fileRef("init-approval", "v1", services.workspace.join(services.project.flywheelDir, "init", "manifest.json")),
    ]);
    if (!originalGoal || !task || !boundary || !evaluator || !approval) throw new Error("Baseline evidence is incomplete");
    for (const ref of [originalGoal, task, boundary, evaluator, approval]) await records.verifyRef(ref);
    steering ??= await records.write<SteeringRevision>("steering", {
      id: "steering-v1", originalGoal, task, boundary, evaluator, approvalEvidence: [approval],
      createdAt: services.state.now(),
    });
    if (!(await records.active("steering"))) await records.activate("steering", steering.id);
    agentState ??= await records.write<AgentStateManifest>("agent-state", {
      id: "state-v1", components: [records.snapshotRef("v1", await services.version.treeHash("v1"))],
      createdAt: services.state.now(),
    });
    if (!(await records.active("agent-state"))) await records.activate("agent-state", agentState.id);
  }
  state.agentStateId = agentState.id;
  state.steeringRevisionId = steering.id;
  const episode: EpisodeRecord = {
    id: state.episodeId, capabilityRunId: state.capabilityRunId,
    agentStateId: state.agentStateId, steeringRevisionId: state.steeringRevisionId,
    status: "running", task: steering.task,
    trajectory: { path: services.workspace.relative(services.project.root, services.project.eventsPath) },
    outputs: [], evaluations: [], failures: [], createdAt: state.createdAt, updatedAt: state.updatedAt,
  };
  await records.write("episode", episode);
  return { status: "completed" };
}

interface TaskingExecution {
  artifactId: string;
  operationId: string;
  id: string;
  operation: string;
  label: string;
  sessionKey: string;
  /** Complete candidate workspace used to execute the frozen evidence plan. */
  subjectRoot: string;
  /** Optimized artifact inside subjectRoot; this is input, not the command cwd. */
  artifactPath: string;
  outputsRoot: string;
  evidenceDir: string;
  resultPath: string;
  readRoots: string[];
  writeRoots: string[];
  deniedPaths: string[];
  immutableWorktree?: string;
}

async function executeReadOnlyAgentJob<T>(
  services: RunPolicyServices,
  state: RunState,
  label: string,
  immutableWorktree: string | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  return await services.guard.project(state, label, async () => immutableWorktree
    ? await services.guard.worktree(immutableWorktree, label, execute)
    : await execute());
}

/**
 * A terminal-but-negative JobResult is evidence of a failed attempt, not a
 * reusable operation artifact. Malformed files remain "present" so the
 * artifact validator can classify and repair their protocol in-session.
 */
async function completedJobResultPresent(
  services: RunPolicyServices,
  job: JobSpec,
): Promise<boolean> {
  if (!job.resultPath || !await services.workspace.exists(job.resultPath)) return false;
  try {
    return (await services.artifact.readJobResult(job)).status === "completed";
  } catch {
    return true;
  }
}

async function executeTasking(
  services: RunPolicyServices, state: RunState, signal: AbortSignal, execution: TaskingExecution,
): Promise<JobResult> {
  const partitioned = !!services.project.trainsetPath;
  const trainOutputsDir = services.workspace.join(execution.outputsRoot, "train");
  const holdoutOutputsDir = services.workspace.join(execution.outputsRoot, "holdout");
  const candidateOutputsDir = execution.outputsRoot;
  const job: JobSpec = {
    id: execution.id, operation: execution.operation, label: execution.label,
    cwd: services.project.root, tools: ["Read", "Write", "Bash"],
    readRoots: execution.readRoots, writeRoots: execution.writeRoots,
    deniedPaths: execution.deniedPaths, resultPath: execution.resultPath,
    sessionKey: execution.sessionKey,
    prompt: services.prompt("run.tasking.batch-generate", {
      task_path: services.project.taskPath,
      tasking_guide_path: services.project.taskingGuidePath,
      project_root: services.project.root,
      subject_root: execution.subjectRoot,
      artifact_path: execution.artifactPath,
      evaluation_topology: partitioned ? "sample" : "candidate",
      train_data_path: services.project.trainsetPath ?? "none",
      holdout_data_path: services.project.holdoutPath ?? "none",
      outputs_dir: execution.outputsRoot, train_outputs_dir: trainOutputsDir,
      holdout_outputs_dir: holdoutOutputsDir, candidate_outputs_dir: candidateOutputsDir,
      collector_path: services.project.collectorPath ?? "none",
      collector_guide_path: services.project.collectorGuidePath ?? "none",
      evidence_dir: execution.evidenceDir,
      result_path: execution.resultPath,
    }),
  };
  return await services.artifact.run(state, {
    artifactId: execution.artifactId, operationId: execution.operationId, job: job.label, signal,
    present: async () => await completedJobResultPresent(services, job),
    validate: async () => services.artifact.readJobResult(job),
    classify: (error) => [{ code: "tasking_result.invalid", message: String(error), path: execution.resultPath }],
    execute: async ({ mode, issues, resumeSessionId }) => await executeReadOnlyAgentJob(
      services, state, job.label, execution.immutableWorktree,
      async () => {
        // Tasking owns evidence materialization. A fresh/retried generation starts
        // from an absent Runtime-owned output root so collectors may create it
        // atomically and cannot accidentally reuse partial evidence.
        if (mode === "generate" && issues.length === 0) {
          await services.workspace.removeTree(execution.outputsRoot);
        }
        return await services.agent.execute(state, {
          ...job, resumeSessionId,
          prompt: mode === "generate" ? job.prompt : services.prompt("run.tasking.batch-repair", {
            issues: issues.map((issue) => issue.message).join("；"),
            outputs_dir: execution.outputsRoot, evidence_dir: execution.evidenceDir,
            result_path: execution.resultPath, base_prompt: job.prompt,
          }),
        }, signal);
      },
    ),
  });
}

interface EvaluationExecution {
  artifactId: string;
  operationId: string;
  id: string;
  operation: string;
  label: string;
  sessionKey: string;
  subjectRoot: string;
  runDir: string;
  outputsRoot: string;
  evidenceDir: string;
  evalsRoot: string;
  resultPath: string;
  readRoots: string[];
  deniedPaths: string[];
  immutableWorktree?: string;
}

async function executeEvaluation(
  services: RunPolicyServices, state: RunState, signal: AbortSignal, execution: EvaluationExecution,
): Promise<{ result: JobResult; reportPath: string; holdoutReportPath: string }> {
  const partitioned = !!services.project.trainsetPath;
  const trainEvalsDir = services.workspace.join(execution.evalsRoot, "train");
  const holdoutEvalsDir = services.workspace.join(execution.evalsRoot, "holdout");
  const reportPath = services.workspace.join(execution.evalsRoot, "evaluation-report.md");
  const holdoutReportPath = services.workspace.join(holdoutEvalsDir, "evaluation-report.md");
  await services.workspace.mkdir(partitioned ? trainEvalsDir : execution.evalsRoot);
  if (partitioned) await services.workspace.mkdir(holdoutEvalsDir);
  const job: JobSpec = {
    id: execution.id, operation: execution.operation, label: execution.label,
    cwd: services.project.root, tools: ["Read", "Write", "Bash"],
    readRoots: execution.readRoots, writeRoots: [execution.evalsRoot],
    deniedPaths: execution.deniedPaths, resultPath: execution.resultPath,
    sessionKey: execution.sessionKey,
    prompt: services.prompt("run.evaluate.generate", {
      task_path: services.project.taskPath,
      evaluate_guide_path: services.project.evaluateGuidePath,
      evaluator_path: services.project.evaluatorPath,
      evaluation_topology: partitioned ? "sample" : "candidate",
      project_root: services.project.root,
      subject_root: execution.subjectRoot, run_dir: execution.runDir,
      outputs_dir: execution.outputsRoot, evidence_dir: execution.evidenceDir,
      evals_dir: execution.evalsRoot, train_evals_dir: trainEvalsDir,
      holdout_evals_dir: holdoutEvalsDir, report_path: reportPath,
      holdout_report_path: partitioned ? holdoutReportPath : "none", result_path: execution.resultPath,
    }),
  };
  const result = await services.artifact.run(state, {
    artifactId: execution.artifactId, operationId: execution.operationId, job: job.label, signal,
    present: async () => await completedJobResultPresent(services, job),
    validate: async () => {
      const value = await services.artifact.readJobResult(job);
      const required = [reportPath, ...(services.project.holdoutPath ? [holdoutReportPath] : [])];
      if (value.status !== "completed" || required.some((artifact) => !value.artifacts.includes(artifact))) {
        throw new Error(`Completed evaluation must declare ${required.join(" and ")}`);
      }
      return value;
    },
    classify: (error) => [{ code: "evaluation_result.invalid", message: String(error), path: execution.resultPath }],
    execute: async ({ mode, issues, resumeSessionId }) => await executeReadOnlyAgentJob(
      services, state, job.label, execution.immutableWorktree,
      async () => await services.agent.execute(state, {
        ...job, resumeSessionId,
        prompt: mode === "generate" ? job.prompt : services.prompt("run.evaluate.repair", {
          issues: issues.map((issue) => issue.message).join("；"), report_path: reportPath,
          result_path: execution.resultPath, base_prompt: job.prompt,
        }),
      }, signal),
    ),
  });
  return { result, reportPath, holdoutReportPath };
}

export async function tasking({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const version = versionOf(state);
  const runDir = services.project.runDir(version);
  const outputsRoot = services.workspace.join(runDir, "outputs");
  const outputsDir = services.project.trainsetPath
    ? services.workspace.join(outputsRoot, "train") : outputsRoot;
  const evidenceDir = services.workspace.join(runDir, "evidence");
  const resultPath = services.workspace.join(outputsDir, "job-result.json");
  await services.workspace.mkdir(evidenceDir);
  const evidence = {
    schemaVersion: 1,
    candidateId: version,
    version,
    contractHash: state.contractSha256,
    candidateTreeHash: await services.version.treeHash(version),
    changedFiles: state.iteration > 1 ? await services.version.changedFiles(`v${state.iteration - 1}`, version) : [],
  };
  await services.workspace.writeJson(services.workspace.join(evidenceDir, "manifest.json"), evidence);
  const result = await executeTasking(services, state, signal, {
    artifactId: `run.tasking:${version}`, operationId: "tasking",
    id: `tasking-${version}`, operation: "tasking", label: `tasking:${version}`,
    sessionKey: `tasking:${version}`,
    subjectRoot: services.project.root,
    artifactPath: services.project.artifactPath, outputsRoot, evidenceDir, resultPath,
    readRoots: [services.project.root], writeRoots: [outputsRoot, evidenceDir],
    deniedPaths: allowContractReads(services),
  });
  return { status: "completed", data: { artifacts: result.artifacts, candidateEvidence: evidence } };
}

export async function evaluation({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const version = versionOf(state);
  const runDir = services.project.runDir(version);
  const evalsDir = services.workspace.join(runDir, "evals");
  const resultPath = services.workspace.join(evalsDir, "job-result.json");
  const { reportPath } = await executeEvaluation(services, state, signal, {
    artifactId: `run.evaluate:${version}`, operationId: "evaluate",
    id: `evaluate-${version}`, operation: "evaluate", label: `evaluate:${version}`,
    sessionKey: `evaluate:${version}`, subjectRoot: services.project.root, runDir,
    outputsRoot: services.workspace.join(runDir, "outputs"),
    evidenceDir: services.workspace.join(runDir, "evidence"), evalsRoot: evalsDir, resultPath,
    readRoots: [services.project.root],
    // Evaluate must be able to invoke the entire frozen evidence chain.  The
    // files remain outside its write roots and their hashes are verified by
    // Runtime, but denying the collector here makes an evaluator that imports
    // or invokes it impossible to run.
    deniedPaths: allowContractReads(services),
  });
  return { status: "completed", data: { evaluationReportPath: reportPath } };
}

type TargetAssessmentStatus = "achieved" | "not_achieved" | "inconclusive";

interface TargetAssessment {
  status: TargetAssessmentStatus;
  message?: string;
}

function validateTargetAssessment(value: unknown): TargetAssessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Target assessment must be an object");
  }
  const assessment = value as Record<string, unknown>;
  if (!(assessment.status === "achieved" || assessment.status === "not_achieved"
    || assessment.status === "inconclusive")
    || (assessment.message !== undefined && typeof assessment.message !== "string")) {
    throw new Error("Target assessment requires achieved, not_achieved, or inconclusive status");
  }
  return assessment as unknown as TargetAssessment;
}

export async function assessTarget({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  if (state.execution.operationState.continueAfterTargetAssessment === true) {
    delete state.execution.operationState.continueAfterTargetAssessment;
    return { status: "completed", data: { assessment: "continue" } };
  }

  const version = versionOf(state);
  const runDir = services.project.runDir(version);
  const assessmentDir = services.workspace.join(runDir, "target-assessment");
  const decisionPath = services.workspace.join(assessmentDir, "decision.json");
  const reportPath = services.workspace.join(assessmentDir, "report.md");
  const resultPath = services.workspace.join(assessmentDir, "job-result.json");
  const evaluationReportPath = services.workspace.join(runDir, "evals", "evaluation-report.md");
  const holdoutReportPath = services.workspace.join(runDir, "evals", "holdout", "evaluation-report.md");
  const goalPath = services.project.goalPath ?? services.project.taskPath;
  const hasGoal = !!services.project.goalPath;
  const hasHoldout = !!services.project.holdoutPath;
  if (hasHoldout && !await services.workspace.exists(holdoutReportPath)) {
    throw new Error(`Target Assess requires the declared holdout report: ${holdoutReportPath}`);
  }
  await services.workspace.mkdir(assessmentDir);
  const basePrompt = services.prompt("run.assess-target.generate", {
    goal_path: hasGoal ? goalPath : services.project.taskPath,
    task_path: services.project.taskPath,
    evaluate_guide_path: services.project.evaluateGuidePath,
    evaluation_report_path: evaluationReportPath,
    holdout_report_path: hasHoldout ? holdoutReportPath : "none",
    decision_path: decisionPath,
    report_path: reportPath,
    result_path: resultPath,
    current_version: version,
  });
  const job: JobSpec = {
    id: `assess-target-${version}`, operation: "assess_target", label: `assess-target:${version}`,
    cwd: services.project.root, tools: ["Read", "Write"],
    readRoots: [
      ...(hasGoal ? [goalPath] : []), services.project.taskPath, services.project.evaluateGuidePath,
      evaluationReportPath, ...(hasHoldout ? [holdoutReportPath] : []),
    ],
    writeRoots: [assessmentDir],
    deniedPaths: services.protectedPaths().filter((item) => item !== services.project.taskPath),
    resultPath, sessionKey: `assess-target:${version}`, prompt: basePrompt,
  };
  const assessment = await services.artifact.run(state, {
    artifactId: `run.assess-target:${version}`, operationId: "assess_target", job: job.label, signal,
    present: async () => state.execution.operationState.targetAssessmentRetry !== true
      && await services.workspace.exists(resultPath)
      && await services.workspace.exists(decisionPath)
      && await services.workspace.exists(reportPath),
    validate: async () => {
      const [result, decision] = await Promise.all([
        services.artifact.readJobResult(job),
        services.workspace.readJson(decisionPath).then(validateTargetAssessment),
      ]);
      if (result.status !== "completed"
        || !result.artifacts.includes(decisionPath) || !result.artifacts.includes(reportPath)) {
        throw new Error(`Completed Target Assess must declare ${decisionPath} and ${reportPath}`);
      }
      return decision;
    },
    classify: (error) => [{ code: "target_assessment.invalid", message: String(error), path: decisionPath }],
    execute: async ({ mode, issues, resumeSessionId }) => await services.agent.execute(state, {
      ...job, resumeSessionId,
      prompt: mode === "generate" ? basePrompt : services.prompt("run.assess-target.repair", {
        issues: issues.map((issue) => issue.message).join("；"),
        decision_path: decisionPath, report_path: reportPath, result_path: resultPath,
        base_prompt: basePrompt,
      }),
    }, signal),
  });
  delete state.execution.operationState.targetAssessmentRetry;
  if (assessment.status === "achieved") {
    return {
      status: "paused",
      reason: assessment.message?.trim()
        || "当前正式版本已有证据支持目标达成。你可以通过运行管理 Agent 补充新的改进方向，或输入 /stop 停止。",
      data: { assessment: assessment.status, reportPath },
    };
  }
  if (assessment.status === "inconclusive") {
    return {
      status: "paused",
      reason: assessment.message?.trim()
        || "当前证据不足以判断目标是否达成。请通过运行管理 Agent 补充信息后恢复。",
      data: { assessment: assessment.status, reportPath },
    };
  }
  return { status: "completed", data: { assessment: assessment.status, reportPath } };
}

function proposalInput(message: string, action: "ask_user" | "exhausted" = "ask_user"): RunOperationResult {
  return { status: "waiting_for_user", data: { action }, interaction: {
    id: "run-proposal-input", capabilityId: "run", operationId: "propose",
    requestedBy: { type: "agent", label: "Propose Agent", sessionKey: "propose" },
    conversationWith: { label: "Propose Agent", sessionKey: "propose" }, kind: "text",
    question: message,
    description: "你的回复会交给同一个建议会话，并自动重新运行当前步骤；输入 /stop 可停止。",
  } };
}

function selectionInput(message: string): RunOperationResult {
  return { status: "waiting_for_user", interaction: {
    id: "run-selection-input", capabilityId: "run", operationId: "select",
    requestedBy: { type: "agent", label: "Select Agent", sessionKey: "select" },
    conversationWith: { label: "Select Agent", sessionKey: "select" }, kind: "text",
    question: message,
    description: "你的回复会交给同一个候选选择会话，并自动重新运行当前步骤；输入 /stop 可停止。",
  } };
}

type ProposalAction = "iterate" | "exhausted" | "ask_user";

interface ProposalPlan {
  action: ProposalAction;
  base_state_id: string;
  steering_revision_id: string;
  hypotheses: { id: string }[];
}

function searchRound(services: RunPolicyServices, state: RunState): string {
  return services.workspace.join(services.project.runDir(versionOf(state)), "search", `round-${state.refineAttempt}`);
}

function validateProposalPlan(value: unknown, state: RunState): ProposalPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Proposal plan must be an object");
  const plan = value as Record<string, unknown>;
  if (!(["iterate", "exhausted", "ask_user"] as unknown[]).includes(plan.action)
    || plan.base_state_id !== state.agentStateId || plan.steering_revision_id !== state.steeringRevisionId
    || !Array.isArray(plan.hypotheses)) throw new Error("Proposal plan does not match the active search window");
  const items = plan.hypotheses as unknown[];
  if (plan.action === "iterate" && (items.length < 1 || items.length > 4)) {
    throw new Error("An iterate proposal must contain 1 to 4 hypotheses");
  }
  if (plan.action !== "iterate" && items.length) throw new Error("Only iterate may contain hypotheses");
  const ids = items.map((item) => item && typeof item === "object" && !Array.isArray(item)
    ? (item as Record<string, unknown>).id : undefined);
  if (ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
    || new Set(ids).size !== ids.length) throw new Error("Hypothesis ids must be safe and unique");
  return plan as unknown as ProposalPlan;
}

async function priorPublicCandidateEvidence(services: RunPolicyServices, state: RunState): Promise<string[]> {
  const runDir = services.project.runDir(versionOf(state));
  const evidence: string[] = [];
  for (let round = 1; round < state.refineAttempt; round += 1) {
    const roundDir = services.workspace.join(runDir, "search", `round-${round}`);
    const planPath = services.workspace.join(roundDir, "plan.json");
    if (!await services.workspace.exists(planPath)) continue;
    const proposalPath = services.workspace.join(roundDir, "proposal.md");
    evidence.push(planPath);
    if (await services.workspace.exists(proposalPath)) evidence.push(proposalPath);
    const plan = validateProposalPlan(await services.workspace.readJson(planPath), state);
    for (const { id } of plan.hypotheses) {
      const candidateDir = services.workspace.join(roundDir, "candidates", id);
      const resultPath = services.workspace.join(candidateDir, "result.json");
      if (!await services.workspace.exists(resultPath)) continue;
      const result = await services.workspace.readJson<PersistedCandidateResult>(resultPath);
      if (result.status === "completed" && result.output) {
        evidence.push(result.output.diffPath, result.output.reviewPath, result.output.evaluationPath);
      } else if (result.status === "failed") {
        for (const file of ["diff.patch", "review.json", "result.json"]) {
          const candidateEvidence = services.workspace.join(candidateDir, file);
          if (await services.workspace.exists(candidateEvidence)) evidence.push(candidateEvidence);
        }
      }
    }
  }
  return evidence;
}

export async function propose({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const version = versionOf(state);
  const runDir = services.project.runDir(version);
  const roundDir = searchRound(services, state);
  const planPath = services.workspace.join(roundDir, "plan.json");
  const proposalPath = services.workspace.join(roundDir, "proposal.md");
  const previousEvidence = await priorPublicCandidateEvidence(services, state);
  await services.workspace.mkdir(roundDir);
  const plan = await services.artifact.run(state, {
    artifactId: `run.propose:${version}:${state.refineAttempt}`, operationId: "propose", job: "propose", signal,
    present: async () => state.execution.operationState.proposalRetry !== true
      && await services.workspace.exists(planPath) && await services.workspace.exists(proposalPath),
    validate: async () => validateProposalPlan(await services.workspace.readJson(planPath), state),
    classify: (error) => [{ code: "proposal.invalid", message: String(error), path: planPath }],
    execute: async ({ mode, issues, resumeSessionId }) => await services.agent.execute(state, {
      operation: "propose", label: "propose", cwd: services.project.root,
      tools: ["Read", "Write", "Edit", "Bash"],
      readRoots: [services.project.taskPath, services.workspace.join(runDir, "evals", "evaluation-report.md"),
        services.workspace.join(runDir, "evals", "train"), services.workspace.join(runDir, "outputs", "train"),
        ...previousEvidence],
      writeRoots: [roundDir],
      deniedPaths: [
        services.project.holdoutPath,
        services.workspace.join(runDir, "outputs", "holdout"),
        services.workspace.join(runDir, "evals", "holdout"),
        services.workspace.join(runDir, "search", "selection-private"),
        services.project.eventsPath,
        services.project.statePath,
        ...services.protectedPaths().filter((item) => item !== services.project.taskPath),
      ].filter((v): v is string => !!v),
      sessionKey: "propose", resumeSessionId,
      prompt: mode === "generate" || state.execution.operationState.proposalRetry === true
        ? services.prompt("run.propose.generate", {
          task_path: services.project.taskPath,
          evaluation_report_path: services.workspace.join(runDir, "evals", "evaluation-report.md"),
          train_evals_dir: services.workspace.join(runDir, "evals", "train"),
          train_outputs_dir: services.workspace.join(runDir, "outputs", "train"),
          previous_rounds_dir: previousEvidence.length ? previousEvidence.join("\n") : "none",
          manager_guidance: state.pendingProposalGuidance ?? "none",
          current_version: version,
          agent_state_id: state.agentStateId, steering_revision_id: state.steeringRevisionId,
          plan_path: planPath, proposal_path: proposalPath,
        })
        : services.prompt("run.propose.repair", {
          issues: issues.map((issue) => issue.message).join("；"), output_path: planPath,
          base_prompt: services.prompt("run.propose.generate", {
            task_path: services.project.taskPath,
            evaluation_report_path: services.workspace.join(runDir, "evals", "evaluation-report.md"),
            train_evals_dir: services.workspace.join(runDir, "evals", "train"),
            train_outputs_dir: services.workspace.join(runDir, "outputs", "train"),
            previous_rounds_dir: previousEvidence.length ? previousEvidence.join("\n") : "none",
            manager_guidance: state.pendingProposalGuidance ?? "none",
            current_version: version,
            agent_state_id: state.agentStateId, steering_revision_id: state.steeringRevisionId,
            plan_path: planPath, proposal_path: proposalPath,
          }),
        }),
    }, signal),
  });
  delete state.pendingProposalGuidance;
  delete state.execution.operationState.proposalRetry;
  return plan.action === "ask_user" ? proposalInput("当前建议需要你补充信息后才能继续。")
    : plan.action === "exhausted" ? proposalInput("当前正式版本尚未被证明达到目标，但暂时没有新的可验证改进假设。请补充与冻结目标兼容的方向；若要调整目标，请重新初始化。", "exhausted")
    : { status: "completed", data: { action: plan.action, hypothesisIds: plan.hypotheses.map((item) => item.id) } };
}

interface CandidateSelection {
  action: "promote" | "iterate" | "ask_user";
  candidate_id?: string;
}

export function validateCandidateSelection(value: unknown, completedIds: string[]): CandidateSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Candidate selection must be an object");
  const selection = value as Record<string, unknown>;
  if (!(["promote", "iterate", "ask_user"] as unknown[]).includes(selection.action)) {
    throw new Error("Candidate selection action is invalid");
  }
  if (selection.action === "promote") {
    if (typeof selection.candidate_id !== "string" || !completedIds.includes(selection.candidate_id)) {
      throw new Error("Promoted candidate did not complete Review and Validate");
    }
  } else if (selection.candidate_id !== undefined) throw new Error("Only promote may select a candidate");
  return selection as unknown as CandidateSelection;
}

interface EvaluatedCandidate {
  worktree: string;
  diffPath: string;
  reviewPath: string;
  outputsPath: string;
  evalsPath: string;
  evaluationPath: string;
  holdoutEvaluationPath?: string;
  candidateTreeHash: string;
  contractSha256: string;
  evaluatorSha256: string;
  taskingGuideSha256: string;
  evaluateGuideSha256: string;
  collectorSha256?: string;
  collectorGuideSha256?: string;
  trainsetSha256?: string;
  holdoutSha256?: string;
}

interface PersistedCandidateResult {
  schemaVersion: 3;
  id: string;
  status: "completed" | "failed";
  output?: EvaluatedCandidate;
  error?: string;
}

const REVIEW_REPAIR_EXHAUSTED = "review_repair_exhausted";
const CANDIDATE_VALIDATE_FAILED = "candidate_validate_failed";

function candidateResultPath(services: RunPolicyServices, workspace: string): string {
  return services.workspace.join(workspace, "result.json");
}

async function restoreCandidateResult(
  services: RunPolicyServices,
  id: string,
  input: string,
  workspace: string,
): Promise<SearchResult<string, EvaluatedCandidate> | undefined> {
  const resultPath = candidateResultPath(services, workspace);
  if (!await services.workspace.exists(resultPath)) return undefined;
  const persisted = await services.workspace.readJson<PersistedCandidateResult>(resultPath);
  if (persisted.schemaVersion !== 3 || persisted.id !== id || !["completed", "failed"].includes(persisted.status)) {
    throw new Error(`Invalid persisted candidate result: ${id}`);
  }
  // A failed result may describe a repaired Runtime or execution condition.
  // Preserve completed work across retries, but always retry negative results.
  if (persisted.status === "failed") return undefined;
  const output = persisted.output;
  if (!output || !output.candidateTreeHash || !output.contractSha256 || !output.evaluatorSha256
    || !output.taskingGuideSha256 || !output.evaluateGuideSha256
    || (services.project.collectorPath && (!output.collectorSha256 || !output.collectorGuideSha256))
    || (services.project.trainsetPath && (!output.trainsetSha256 || !output.holdoutSha256))
    || !await services.workspace.exists(output.worktree) || !await services.workspace.exists(output.diffPath)
    || !await services.workspace.exists(output.reviewPath) || !await services.workspace.exists(output.outputsPath)
    || !await services.workspace.exists(output.evalsPath) || !await services.workspace.exists(output.evaluationPath)
    || (output.holdoutEvaluationPath && !await services.workspace.exists(output.holdoutEvaluationPath))) {
    throw new Error(`Persisted candidate evidence is incomplete: ${id}`);
  }
  return { id, input, workspace, status: "completed", output };
}

async function persistCandidateResult(services: RunPolicyServices, result: SearchResult<string, EvaluatedCandidate>): Promise<void> {
  await services.workspace.writeJson(candidateResultPath(services, result.workspace), result.status === "completed"
    ? { schemaVersion: 3, id: result.id, status: "completed", output: result.output }
    : { schemaVersion: 3, id: result.id, status: "failed", error: result.error });
}

function contractReadRoots(services: RunPolicyServices): string[] {
  return [
    services.project.taskPath, services.project.taskingGuidePath, services.project.evaluateGuidePath,
    services.project.evaluatorPath, services.project.collectorPath, services.project.collectorGuidePath,
    services.project.trainsetPath, services.project.holdoutPath,
  ].filter((item): item is string => !!item);
}

function allowContractReads(services: RunPolicyServices): string[] {
  const allowed = new Set(contractReadRoots(services));
  return services.protectedPaths().filter((item) => !allowed.has(item));
}

async function validateCandidate(
  services: RunPolicyServices, state: RunState, version: string, id: string,
  workspace: string, worktree: string, signal: AbortSignal,
): Promise<Pick<EvaluatedCandidate,
  "outputsPath" | "evalsPath" | "evaluationPath" | "holdoutEvaluationPath"
  | "candidateTreeHash" | "contractSha256" | "evaluatorSha256"
  | "taskingGuideSha256" | "evaluateGuideSha256" | "collectorSha256" | "collectorGuideSha256"
  | "trainsetSha256" | "holdoutSha256">> {
  const contractProjection = services.workspace.join(worktree, ".flywheel", "contract");
  await services.workspace.removeTree(contractProjection);
  await services.workspace.copyTree(
    services.workspace.join(services.project.flywheelDir, "contract"),
    contractProjection,
  );
  const outputsDir = services.workspace.join(workspace, "outputs");
  const taskResultPath = services.workspace.join(outputsDir, "job-result.json");
  await executeTasking(services, state, signal, {
    artifactId: `run.candidate-task:${version}:${id}`, operationId: "candidate_validate",
    id: `candidate-task-${version}-${id}`, operation: "candidate_validate", label: `candidate:tasking:${id}`,
    sessionKey: `candidate-task:${version}:${id}`,
    subjectRoot: worktree,
    artifactPath: services.workspace.join(worktree, services.project.boundary.artifact.path),
    outputsRoot: outputsDir, evidenceDir: workspace, resultPath: taskResultPath,
    readRoots: [worktree, services.project.root, ...contractReadRoots(services)], writeRoots: [outputsDir],
    deniedPaths: allowContractReads(services),
    immutableWorktree: worktree,
  });

  const evalsDir = services.workspace.join(workspace, "evals");
  const evalResultPath = services.workspace.join(evalsDir, "job-result.json");
  const { reportPath: evaluationPath, holdoutReportPath: holdoutEvaluationPath } = await executeEvaluation(
    services, state, signal, {
      artifactId: `run.candidate-evaluate:${version}:${id}`, operationId: "candidate_validate",
      id: `candidate-eval-${version}-${id}`, operation: "candidate_validate", label: `candidate:evaluate:${id}`,
      sessionKey: `candidate-eval:${version}:${id}`, subjectRoot: worktree, runDir: workspace,
      outputsRoot: outputsDir, evidenceDir: workspace, evalsRoot: evalsDir, resultPath: evalResultPath,
      readRoots: [worktree, services.project.root, outputsDir, ...contractReadRoots(services)],
      deniedPaths: allowContractReads(services),
      immutableWorktree: worktree,
    },
  );
  return {
    outputsPath: outputsDir, evalsPath: evalsDir, evaluationPath,
    ...(services.project.holdoutPath ? { holdoutEvaluationPath } : {}),
    candidateTreeHash: await services.version.worktreeTreeHash(worktree),
    contractSha256: state.contractSha256,
    evaluatorSha256: state.evaluatorSha256,
    taskingGuideSha256: await services.workspace.sha256(services.project.taskingGuidePath),
    evaluateGuideSha256: await services.workspace.sha256(services.project.evaluateGuidePath),
    ...(services.project.collectorPath
      ? { collectorSha256: await services.workspace.sha256(services.project.collectorPath) } : {}),
    ...(services.project.collectorGuidePath
      ? { collectorGuideSha256: await services.workspace.sha256(services.project.collectorGuidePath) } : {}),
    ...(services.project.trainsetPath
      ? { trainsetSha256: await services.workspace.sha256(services.project.trainsetPath) } : {}),
    ...(services.project.holdoutPath
      ? { holdoutSha256: await services.workspace.sha256(services.project.holdoutPath) } : {}),
  };
}

async function implementAndReviewCandidate(
  services: RunPolicyServices, state: RunState, version: string, id: string,
  workspace: string, proposalPath: string, signal: AbortSignal,
): Promise<{ worktree: string; diffPath: string; reviewPath: string }> {
  const worktree = services.workspace.join(workspace, "worktree");
  const diffPath = services.workspace.join(workspace, "diff.patch");
  const reviewPath = services.workspace.join(workspace, "review.json");
  const changedPathsPath = services.workspace.join(workspace, "changed-paths.json");
  await services.version.createWorktree(version, worktree);
  const contextDir = services.workspace.join(workspace, "context");
  const taskPath = services.workspace.join(contextDir, "task.md");
  const candidateProposalPath = services.workspace.join(contextDir, "proposal.md");
  await services.workspace.mkdir(contextDir);
  await services.workspace.writeText(taskPath, await services.workspace.readText(services.project.taskPath));
  await services.workspace.writeText(candidateProposalPath, await services.workspace.readText(proposalPath));
  const refineSessionKey = `candidate:${version}:${id}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const refined = await services.guard.project(state, `candidate:refine:${id}`, async () =>
      await services.agent.execute(state, {
        id: `candidate-refine-${version}-${id}`, operation: "refine", label: `candidate:refine:${id}`,
        cwd: workspace, tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        readRoots: [workspace],
        writeRoots: [worktree],
        deniedPaths: [services.workspace.join(worktree, ".git")],
        sessionKey: refineSessionKey,
        prompt: services.prompt(attempt === 1 ? "run.refine.worktree" : "run.refine.worktree-repair", {
          hypothesis_id: id, proposal_path: candidateProposalPath, task_path: taskPath,
          worktree_path: worktree, change_scope: services.project.boundary.change_scope,
          review_path: reviewPath,
        }),
      }, signal));
    if (refined.status !== "completed") throw new Error(refined.message ?? `Candidate ${id} refine failed`);
    const changes = await services.version.worktreeChanges(worktree);
    try {
      services.workspace.validateChanges(services.project.boundary.change_scope, changes.files);
      if (!changes.diff.trim()) throw new Error(`Candidate ${id} produced an empty diff`);
    } catch (error) {
      await services.workspace.writeJson(reviewPath, {
        status: "request_changes",
        message: `Runtime candidate validation failed: ${String(error)}`,
      });
      if (attempt < 3) continue;
      throw new Error(`${REVIEW_REPAIR_EXHAUSTED}: Candidate ${id} exhausted its Refine/Review repair budget: ${String(error)}`);
    }
    await services.workspace.writeText(diffPath, changes.diff);
    await services.workspace.writeJson(changedPathsPath, {
      schemaVersion: 1,
      baseVersion: version,
      candidateId: id,
      files: changes.files,
    });
    await services.workspace.remove(reviewPath);
    const basePrompt = services.prompt("run.review.candidate", {
      hypothesis_id: id, proposal_path: candidateProposalPath, task_path: taskPath,
      worktree_path: worktree, diff_path: diffPath, changed_paths_path: changedPathsPath,
      review_path: reviewPath,
    });
    const review = await services.artifact.run(state, {
      artifactId: `run.candidate-review:${version}:${id}:${attempt}`,
      operationId: "refine", job: `candidate:review:${id}`, signal,
      present: async () => await services.workspace.exists(reviewPath),
      validate: async () => {
        const value = await services.workspace.readJson<Record<string, unknown>>(reviewPath);
        if (!["approve", "request_changes"].includes(String(value.status))) {
          throw new Error(`Candidate ${id} review status is invalid`);
        }
        if (typeof value.message !== "string") throw new Error(`Candidate ${id} review message is invalid`);
        return value;
      },
      classify: (error) => [{ code: "candidate_review.invalid", message: String(error), path: reviewPath }],
      execute: async ({ mode, issues, resumeSessionId }) => await executeReadOnlyAgentJob(
        services, state, `candidate:review:${id}`, worktree,
        async () => await services.agent.execute(state, {
          id: `candidate-review-${version}-${id}`, operation: "refine", label: `candidate:review:${id}`,
          cwd: workspace, tools: ["Read", "Write", "Bash", "Glob", "Grep"],
          readRoots: [workspace], writeRoots: [reviewPath],
          deniedPaths: [services.workspace.join(worktree, ".git")],
          sessionKey: `candidate-review:${version}:${id}`, resumeSessionId,
          prompt: mode === "generate" ? basePrompt : services.prompt("common.decision-repair", {
            issues: issues.map((issue) => issue.message).join("；"),
            decision_path: reviewPath, base_prompt: basePrompt,
          }),
        }, signal),
      ),
    });
    if (review.status === "approve") return { worktree, diffPath, reviewPath };
  }
  throw new Error(`${REVIEW_REPAIR_EXHAUSTED}: Candidate ${id} exhausted its Refine/Review repair budget`);
}

export async function refine({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const version = versionOf(state);
  const roundDir = searchRound(services, state);
  const proposalPath = services.workspace.join(roundDir, "proposal.md");
  const planPath = services.workspace.join(roundDir, "plan.json");
  if (!await services.workspace.exists(planPath) || !await services.workspace.exists(proposalPath)) {
    return { status: "completed", data: { action: "repropose", candidateIds: [], failedCandidateIds: [] } };
  }
  const plan = validateProposalPlan(await services.workspace.readJson(planPath), state);
  if (plan.action !== "iterate") throw new Error("Refine requires an iterate proposal");
  // Keep Runtime-owned candidate roots shallow on Windows. Deep project roots plus
  // `runs/<version>/search/<round>/candidates/<id>/worktree` can exceed MAX_PATH
  // before Refine starts, even when every repository-relative path is valid.
  const candidateWorkspaceRoot = services.workspace.join(
    services.project.flywheelDir,
    "w",
    `${version}-r${state.refineAttempt}`,
  );
  const results = await services.search.run<string, EvaluatedCandidate>({
    workspaceRoot: candidateWorkspaceRoot,
    items: plan.hypotheses.map(({ id }) => ({ id, input: id })), signal,
    restore: async ({ id, input, workspace }) => {
      const restored = await restoreCandidateResult(services, id, input, workspace);
      if (restored) return restored;
      // Read the pre-v12 location during recovery, then normalize it into the
      // shallow workspace so an interrupted run does not repeat completed work.
      const legacyWorkspace = services.workspace.join(roundDir, "candidates", id);
      const legacyResult = candidateResultPath(services, legacyWorkspace);
      if (!await services.workspace.exists(legacyResult)) return undefined;
      await services.workspace.mkdir(workspace);
      await services.workspace.copyFile(legacyResult, candidateResultPath(services, workspace));
      return await restoreCandidateResult(services, id, input, workspace);
    },
    persist: async (result) => {
      await persistCandidateResult(services, result);
      // Keep the run-scoped audit projection stable while the heavy worktree
      // itself lives at the shallow Windows-safe path.
      const auditWorkspace = services.workspace.join(roundDir, "candidates", result.id);
      await services.workspace.mkdir(auditWorkspace);
      await services.workspace.copyFile(
        candidateResultPath(services, result.workspace),
        candidateResultPath(services, auditWorkspace),
      );
      for (const file of ["diff.patch", "changed-paths.json", "review.json"]) {
        const source = services.workspace.join(result.workspace, file);
        if (await services.workspace.exists(source)) {
          await services.workspace.copyFile(source, services.workspace.join(auditWorkspace, file));
        }
      }
    },
    run: async ({ id, workspace, signal: candidateSignal }) => {
      const implemented = await implementAndReviewCandidate(
        services, state, version, id, workspace, proposalPath, candidateSignal,
      );
      let evaluated;
      try {
        evaluated = await validateCandidate(
          services, state, version, id, workspace, implemented.worktree, candidateSignal,
        );
      } catch (error) {
        if (error instanceof ArtifactRepairExhausted || error instanceof AgentExecutionError) {
          const detail = error instanceof ArtifactRepairExhausted
            ? `exhausted its Validate repair budget: ${error.message}`
            : `failed Validate: ${error.message}`;
          throw new Error(`${CANDIDATE_VALIDATE_FAILED}: Candidate ${id} ${detail}`);
        }
        throw error;
      }
      return { ...implemented, ...evaluated };
    },
  });
  const completed = results.filter((item): item is Extract<typeof item, { status: "completed" }> => item.status === "completed");
  const failed = results.filter((item): item is Extract<typeof item, { status: "failed" }> => item.status === "failed");
  const failedCandidateIds = failed.map((item) => item.id);
  if (!completed.length) {
    if (!failed.every((item) => item.error.startsWith(`${REVIEW_REPAIR_EXHAUSTED}:`)
      || item.error.startsWith(`${CANDIDATE_VALIDATE_FAILED}:`))) {
      throw new Error(`Candidate execution failed: ${failed.map((item) => `${item.id}: ${item.error}`).join("; ")}`);
    }
    state.refineAttempt += 1;
    return { status: "completed", data: { action: "repropose", candidateIds: [], failedCandidateIds } };
  }
  return { status: "completed", data: {
    action: "select", candidateIds: completed.map((item) => item.id), failedCandidateIds,
  } };
}

function rebaseJobResult(
  services: RunPolicyServices,
  result: JobResult,
  sourceRoot: string,
  targetRoot: string,
): JobResult {
  if (result.status !== "completed") throw new Error("Only completed candidate evidence may be adopted");
  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => {
      const relative = services.workspace.relative(sourceRoot, artifact);
      if (relative === ".." || relative.startsWith("../") || relative.startsWith("..\\")) {
        throw new Error(`Candidate artifact escapes its evidence root: ${artifact}`);
      }
      return services.workspace.join(targetRoot, relative);
    }),
  };
}

async function assertCandidateEvidenceBinding(
  services: RunPolicyServices,
  state: RunState,
  candidate: EvaluatedCandidate,
): Promise<void> {
  if (candidate.contractSha256 !== state.contractSha256 || candidate.evaluatorSha256 !== state.evaluatorSha256) {
    throw new Error("Candidate evidence does not match the frozen contract or evaluator");
  }
  const [taskingGuideSha256, evaluateGuideSha256, collectorSha256, collectorGuideSha256,
    trainsetSha256, holdoutSha256] = await Promise.all([
    services.workspace.sha256(services.project.taskingGuidePath),
    services.workspace.sha256(services.project.evaluateGuidePath),
    services.project.collectorPath ? services.workspace.sha256(services.project.collectorPath) : undefined,
    services.project.collectorGuidePath ? services.workspace.sha256(services.project.collectorGuidePath) : undefined,
    services.project.trainsetPath ? services.workspace.sha256(services.project.trainsetPath) : undefined,
    services.project.holdoutPath ? services.workspace.sha256(services.project.holdoutPath) : undefined,
  ]);
  if (candidate.taskingGuideSha256 !== taskingGuideSha256
    || candidate.evaluateGuideSha256 !== evaluateGuideSha256
    || candidate.collectorSha256 !== collectorSha256
    || candidate.collectorGuideSha256 !== collectorGuideSha256
    || candidate.trainsetSha256 !== trainsetSha256 || candidate.holdoutSha256 !== holdoutSha256) {
    throw new Error("Candidate evidence inputs changed after Tasking and Evaluate completed");
  }
  if (await services.version.worktreeTreeHash(candidate.worktree) !== candidate.candidateTreeHash) {
    throw new Error("Candidate worktree changed after Tasking and Evaluate completed");
  }
}

async function adoptCandidateEvidence(
  services: RunPolicyServices,
  state: RunState,
  sourceVersion: string,
  nextVersion: string,
  candidateId: string,
  candidate: EvaluatedCandidate,
): Promise<void> {
  const promotedTreeHash = await services.version.treeHash(nextVersion);
  if (promotedTreeHash !== candidate.candidateTreeHash) {
    throw new Error("Promoted version does not match the evaluated candidate tree");
  }
  if (candidate.contractSha256 !== state.contractSha256 || candidate.evaluatorSha256 !== state.evaluatorSha256) {
    throw new Error("Candidate evidence cannot be reused under a different contract or evaluator");
  }

  const taskResult = await services.workspace.readJson<JobResult>(
    services.workspace.join(candidate.outputsPath, "job-result.json"),
  );
  const evaluationResult = await services.workspace.readJson<JobResult>(
    services.workspace.join(candidate.evalsPath, "job-result.json"),
  );
  const runDir = services.project.runDir(nextVersion);
  const outputsTarget = services.workspace.join(runDir, "outputs");
  const evalsTarget = services.workspace.join(runDir, "evals");
  const evidenceTarget = services.workspace.join(runDir, "evidence");

  await services.workspace.remove(outputsTarget);
  await services.workspace.remove(evalsTarget);
  await services.workspace.copyTree(candidate.outputsPath, outputsTarget);
  await services.workspace.copyTree(candidate.evalsPath, evalsTarget);
  await services.workspace.remove(services.workspace.join(outputsTarget, "job-result.json"));
  await services.workspace.writeJson(
    services.project.trainsetPath
      ? services.workspace.join(outputsTarget, "train", "job-result.json")
      : services.workspace.join(outputsTarget, "job-result.json"),
    rebaseJobResult(services, taskResult, candidate.outputsPath, outputsTarget),
  );
  await services.workspace.writeJson(
    services.workspace.join(evalsTarget, "job-result.json"),
    rebaseJobResult(services, evaluationResult, candidate.evalsPath, evalsTarget),
  );
  await services.workspace.writeJson(services.workspace.join(evidenceTarget, "adopted-candidate.json"), {
    schemaVersion: 1,
    candidateId,
    sourceVersion,
    promotedVersion: nextVersion,
    candidateTreeHash: candidate.candidateTreeHash,
    contractSha256: candidate.contractSha256,
    evaluatorSha256: candidate.evaluatorSha256,
    taskingGuideSha256: candidate.taskingGuideSha256,
    evaluateGuideSha256: candidate.evaluateGuideSha256,
    ...(candidate.collectorSha256 ? { collectorSha256: candidate.collectorSha256 } : {}),
    ...(candidate.collectorGuideSha256 ? { collectorGuideSha256: candidate.collectorGuideSha256 } : {}),
    ...(candidate.trainsetSha256 ? { trainsetSha256: candidate.trainsetSha256 } : {}),
    ...(candidate.holdoutSha256 ? { holdoutSha256: candidate.holdoutSha256 } : {}),
    sourceOutputs: candidate.outputsPath,
    sourceEvaluations: candidate.evalsPath,
  });
}

async function promoteCandidate(
  services: RunPolicyServices, state: RunState, candidateId: string, candidate: EvaluatedCandidate,
  proposalPath: string,
): Promise<void> {
  const nextVersion = `v${state.iteration + 1}`;
  state.promotionTransaction ??= {
    candidateId, version: nextVersion, recordId: services.state.id("evolution"),
    candidateStateId: services.state.id("state"), createdAt: services.state.now(),
  };
  const transaction = state.promotionTransaction;
  if (transaction.candidateId !== candidateId || transaction.version !== nextVersion) {
    throw new Error("Promotion transaction does not match selected candidate");
  }
  await services.state.checkpoint(state);
  await assertCandidateEvidenceBinding(services, state, candidate);
  await services.version.promoteWorktree(candidate.worktree, nextVersion, `promote ${candidateId} as ${nextVersion}`);
  await services.version.prepare(nextVersion);
  await adoptCandidateEvidence(services, state, versionOf(state), nextVersion, candidateId, candidate);
  if (!transaction.recorded) {
    const records = services.version.records;
    const base = await records.load<AgentStateManifest>("agent-state", state.agentStateId);
    const candidateState = await records.write<AgentStateManifest>("agent-state", {
      id: transaction.candidateStateId, parentStateId: base.id, evolutionRecordId: transaction.recordId,
      components: [records.snapshotRef(nextVersion, await services.version.treeHash(nextVersion))],
      createdAt: transaction.createdAt,
    });
    const refs = (await Promise.all([
      records.fileRef("proposal", nextVersion, proposalPath),
      records.fileRef("candidate-diff", nextVersion, candidate.diffPath),
      records.fileRef("candidate-review", nextVersion, candidate.reviewPath),
      records.fileRef("candidate-evaluation", nextVersion, candidate.evaluationPath),
      candidate.holdoutEvaluationPath
        ? records.fileRef("candidate-holdout-evaluation", nextVersion, candidate.holdoutEvaluationPath)
        : undefined,
    ])).filter((item): item is ArtifactRef => !!item);
    const evolution: EvolutionRecord = {
      id: transaction.recordId, baseStateId: base.id, steeringRevisionId: state.steeringRevisionId,
      evidence: refs.slice(1), proposal: refs[0], candidateStateId: candidateState.id,
      validationArtifacts: refs.slice(2), decision: "promote", approvalEvidence: [],
      createdAt: transaction.createdAt,
    };
    await records.write("evolution", evolution);
    await records.activate("agent-state", candidateState.id);
    state.agentStateId = candidateState.id;
    const previous = await records.load<EpisodeRecord>("episode", state.episodeId);
    const episode: EpisodeRecord = {
      ...previous, id: services.state.id("episode"), agentStateId: state.agentStateId,
      outputs: [...previous.outputs, records.snapshotRef(nextVersion, await services.version.treeHash(nextVersion))],
      evaluations: [...previous.evaluations, ...refs.filter((item) => item.id.includes("evaluation"))],
      updatedAt: services.state.now(),
    };
    await records.write("episode", episode);
    state.episodeId = episode.id;
    transaction.recorded = true;
    await services.state.checkpoint(state);
  }
  state.iteration += 1;
  state.refineAttempt = 1;
  delete state.promotionTransaction;
}

export async function select({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const version = versionOf(state);
  const roundDir = searchRound(services, state);
  const plan = validateProposalPlan(await services.workspace.readJson(services.workspace.join(roundDir, "plan.json")), state);
  const completed: { id: string; output: EvaluatedCandidate }[] = [];
  for (const { id } of plan.hypotheses) {
    const persisted = await services.workspace.readJson<PersistedCandidateResult>(
      candidateResultPath(services, services.workspace.join(roundDir, "candidates", id)),
    );
    if (persisted.status === "completed" && persisted.output) completed.push({ id, output: persisted.output });
  }
  if (!completed.length) throw new Error("Select has no validated candidates");
  const selectionDir = services.workspace.join(roundDir, "selection-private");
  const selectionPath = services.workspace.join(selectionDir, "selection.json");
  const decisionPath = services.workspace.join(selectionDir, "decision.md");
  const currentTrainEvaluationPath = services.workspace.join(services.project.runDir(version), "evals", "evaluation-report.md");
  await services.workspace.mkdir(selectionDir);
  const selection = await services.artifact.run(state, {
    artifactId: `run.select:${version}:${state.refineAttempt}`, operationId: "select", job: "select", signal,
    present: async () => state.execution.operationState.selectionRetry !== true
      && await services.workspace.exists(selectionPath) && await services.workspace.exists(decisionPath),
    validate: async () => validateCandidateSelection(await services.workspace.readJson(selectionPath), completed.map((item) => item.id)),
    classify: (error) => [{ code: "selection.invalid", message: String(error), path: selectionPath }],
    execute: async ({ mode, issues, resumeSessionId }) => await services.agent.execute(state, {
      id: `candidate-select-${version}-${state.refineAttempt}`, operation: "select", label: "select",
      cwd: services.project.root, tools: ["Read", "Write"],
      readRoots: [services.project.taskPath, currentTrainEvaluationPath, services.workspace.join(roundDir, "proposal.md"),
        ...completed.flatMap(({ output }) => [
          output.worktree, output.diffPath, output.reviewPath, output.outputsPath,
          output.evalsPath, output.evaluationPath, output.holdoutEvaluationPath,
        ].filter((value): value is string => !!value))],
      writeRoots: [selectionDir], deniedPaths: allowContractReads(services),
      sessionKey: `select:${version}:${state.refineAttempt}`, resumeSessionId,
      prompt: mode === "generate" ? services.prompt("run.refine.select", {
        task_path: services.project.taskPath,
        current_train_evaluation_path: currentTrainEvaluationPath,
        candidates: completed.map((item) => `- ${item.id}: diff=${item.output.diffPath}, review=${item.output.reviewPath}, train=${item.output.evaluationPath}, holdout=${item.output.holdoutEvaluationPath ?? "none"}`).join("\n"),
        selection_path: selectionPath, decision_path: decisionPath,
      }) : services.prompt("common.decision-repair", {
        issues: issues.map((issue) => issue.message).join("；"), decision_path: selectionPath,
        base_prompt: services.prompt("run.refine.select", {
          task_path: services.project.taskPath,
          current_train_evaluation_path: currentTrainEvaluationPath,
          candidates: completed.map((item) => `- ${item.id}: diff=${item.output.diffPath}, review=${item.output.reviewPath}, train=${item.output.evaluationPath}, holdout=${item.output.holdoutEvaluationPath ?? "none"}`).join("\n"),
          selection_path: selectionPath, decision_path: decisionPath,
        }),
      }),
    }, signal),
  });
  delete state.execution.operationState.selectionRetry;
  if (selection.action === "promote") {
    const chosen = completed.find((item) => item.id === selection.candidate_id)!;
    await promoteCandidate(services, state, chosen.id, chosen.output, services.workspace.join(roundDir, "proposal.md"));
  } else if (selection.action === "iterate") state.refineAttempt += 1;
  return selection.action === "ask_user" ? selectionInput("当前候选选择需要你补充信息后才能继续。")
    : { status: "completed", data: { action: selection.action, candidateId: selection.candidate_id,
      ...(selection.action === "promote" ? { promotedVersion: versionOf(state) } : {}) } };
}

function attestation(value: unknown, kind: ValidationAttestation["kind"], subjectSha256: string): ValidationAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${kind} attestation must be an object`);
  const item = value as Record<string, unknown>;
  if (item.kind !== kind || item.subjectSha256 !== subjectSha256 || item.status !== "passed"
    || !item.validator || typeof item.validator !== "object" || !item.createdAt) {
    throw new Error(`${kind} did not produce passed evidence bound to ${subjectSha256}`);
  }
  return item as unknown as ValidationAttestation;
}

function finishAdmin(
  state: RunState,
  result: Record<string, unknown>,
): RunOperationResult {
  if (!state.adminReturn) throw new Error("Administrative operation has no durable continuation");
  state.execution.currentOperationId = state.adminReturn.currentOperationId;
  state.execution.operationState = structuredClone(state.adminReturn.operationState);
  delete state.pendingRunCommand;
  state.commandResult = result;
  return { status: "paused", reason: "Administrative command completed", data: result };
}

async function writeAdminApproval(
  services: RunPolicyServices,
  kind: "steering" | "policy",
  candidateId: string,
  candidateSha256: string,
  decision: "approve" | "reject" | "activate",
): Promise<ArtifactRef> {
  const directory = services.workspace.join(services.project.runtimeDir, "approvals", kind);
  const approvalId = services.state.id(`${kind}-${decision}`);
  const file = services.workspace.join(directory, `${approvalId}.json`);
  await services.workspace.writeJson(file, {
    schemaVersion: 1,
    kind: `${kind}.${decision}`,
    candidateId,
    candidateSha256,
    decision,
    approvedBy: "user-command",
    createdAt: services.state.now(),
  });
  const ref = await services.version.records.fileRef(`${kind}-${decision}`, approvalId, file);
  if (!ref) throw new Error(`Failed to persist ${kind} ${decision} approval`);
  await services.version.records.verifyRef(ref);
  return ref;
}

async function validateAttestationRef(
  services: RunPolicyServices,
  ref: ArtifactRef,
  kind: ValidationAttestation["kind"],
  subjectSha256: string,
): Promise<void> {
  await services.version.records.verifyRef(ref);
  const file = await services.version.records.resolveRef(ref);
  if (!file) throw new Error(`${kind} evidence must be workspace-local`);
  attestation(await services.workspace.readJson(file), kind, subjectSha256);
}

async function steeringReview(
  services: RunPolicyServices,
  state: RunState,
  candidateId: string,
  role: "validate" | "anchor",
  subjectSha256: string,
  workspace: string,
  originalGoalPath: string,
  files: { task: string; boundary: string; evaluator: string; proposal: string },
  signal: AbortSignal,
): Promise<ArtifactRef> {
  const kind: ValidationAttestation["kind"] = role === "validate" ? "steering.contract" : "steering.anchor";
  const report = services.workspace.join(workspace, `${role}-report.md`);
  const evidence = services.workspace.join(workspace, `${role}-attestation.json`);
  const resultPath = services.workspace.join(workspace, `${role}-job-result.json`);
  const result = await services.agent.execute(state, {
    id: `steering-${role}-${candidateId}`, operation: "steering", label: `steering:${role}`,
    cwd: services.project.root, tools: ["Read", "Write", "Bash"],
    readRoots: [services.project.flywheelDir, workspace], writeRoots: [workspace],
    deniedPaths: services.protectedPaths(), resultPath, sessionKey: `steering:${role}:${candidateId}`,
    prompt: services.prompt(`run.steering.${role}`, {
      candidate_id: candidateId,
      original_goal_path: originalGoalPath,
      current_task_path: services.project.taskPath,
      current_boundary_path: services.project.boundaryPath,
      current_evaluator_path: services.project.evaluatorPath,
      candidate_task_path: files.task,
      candidate_boundary_path: files.boundary,
      candidate_evaluator_path: files.evaluator,
      proposal_path: files.proposal,
      episode_paths: "- none",
      report_path: report, attestation_path: evidence, result_path: resultPath,
      attestation_kind: kind, subject_sha256: subjectSha256,
    }),
  }, signal);
  if (result.status !== "completed") throw new Error(result.message ?? `Steering ${role} failed`);
  attestation(await services.workspace.readJson(evidence), kind, subjectSha256);
  const ref = await services.version.records.fileRef(kind, candidateId, evidence);
  if (!ref) throw new Error(`Steering ${role} evidence was not written`);
  return ref;
}

export async function steeringPropose({ services, state, signal }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const current = await services.version.records.active<SteeringRevision>("steering");
  if (!current) throw new Error("Steering baseline is not active");
  const originalGoalPath = await services.version.records.resolveRef(current.originalGoal);
  if (!originalGoalPath) throw new Error("Steering original goal must be a project-local frozen artifact");
  const candidateId = services.state.id("steering-candidate");
  const workspace = services.workspace.join(services.project.runtimeDir, "steering", candidateId);
  await services.workspace.mkdir(workspace);
  const suffixAt = services.project.evaluatorPath.lastIndexOf(".");
  const suffix = suffixAt >= 0 ? services.project.evaluatorPath.slice(suffixAt) : ".js";
  const files = {
    task: services.workspace.join(workspace, "task.md"),
    boundary: services.workspace.join(workspace, "boundary.json"),
    evaluator: services.workspace.join(workspace, `evaluate${suffix}`),
    proposal: services.workspace.join(workspace, "proposal.md"),
  };
  const generated = await services.agent.execute(state, {
    operation: "steering", label: "steering:propose", cwd: services.project.root,
    tools: ["Read", "Write"], readRoots: [services.project.flywheelDir], writeRoots: [workspace],
    deniedPaths: services.protectedPaths(), sessionKey: `steering:propose:${candidateId}`,
    prompt: services.prompt("run.steering.propose", {
      current_revision_id: current.id, candidate_id: candidateId,
      original_goal_path: originalGoalPath,
      current_task_path: services.project.taskPath, current_boundary_path: services.project.boundaryPath,
      current_evaluator_path: services.project.evaluatorPath, episode_paths: "- none",
      task_output_path: files.task, boundary_output_path: files.boundary,
      evaluator_output_path: files.evaluator, proposal_output_path: files.proposal,
    }),
  }, signal);
  if (generated.status !== "completed") throw new Error(generated.message ?? "Steering proposal failed");
  for (const file of Object.values(files)) {
    if (!(await services.workspace.readText(file)).trim()) throw new Error(`Steering candidate file is empty: ${file}`);
  }
  const boundary = await services.workspace.readJson(files.boundary) as Record<string, unknown>;
  if (boundary.schemaVersion !== 1 || !boundary.artifact || !boundary.change_scope) {
    throw new Error("Steering boundary candidate is not a valid Runtime boundary");
  }
  const [task, boundaryRef, evaluator, proposal] = await Promise.all([
    services.version.records.fileRef("task", candidateId, files.task),
    services.version.records.fileRef("boundary", candidateId, files.boundary),
    services.version.records.fileRef("evaluator", candidateId, files.evaluator),
    services.version.records.fileRef("steering-proposal", candidateId, files.proposal),
  ]);
  if (!task || !boundaryRef || !evaluator || !proposal) throw new Error("Steering candidate evidence is incomplete");
  const [contractEvidence, anchorEvidence] = await Promise.all([
    steeringReview(services, state, candidateId, "validate", task.sha256, workspace, originalGoalPath, files, signal),
    steeringReview(services, state, candidateId, "anchor", evaluator.sha256, workspace, originalGoalPath, files, signal),
  ]);
  const candidate: SteeringCandidate = {
    id: candidateId, parentRevisionId: current.id,
    originalGoal: current.originalGoal, task, boundary: boundaryRef, evaluator,
    proposal, approvalEvidence: [], validationArtifacts: [contractEvidence],
    anchorEvidence: [anchorEvidence], createdAt: services.state.now(),
  };
  await services.version.records.stage("steering-candidate", candidate);
  return finishAdmin(state, { candidateId, status: "staged" });
}

export async function steeringResolve({ services, state }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const command = state.pendingRunCommand;
  if (!command || command.type !== "steering.resolve") throw new Error("Missing Steering resolution command");
  const candidate = await services.version.records.loadStaged<SteeringCandidate>("steering-candidate", command.candidateId);
  const active = await services.version.records.active<SteeringRevision>("steering");
  if (!active || candidate.parentRevisionId !== active.id) throw new Error("Steering candidate parent is no longer active");
  if (command.decision === "approve") {
    if (!candidate.validationArtifacts.length || !candidate.anchorEvidence.length) throw new Error("Steering candidate has no validation evidence");
    await Promise.all([
      candidate.originalGoal, candidate.task, candidate.boundary, candidate.evaluator, candidate.proposal,
    ].map(async (ref) => await services.version.records.verifyRef(ref)));
    await Promise.all([
      ...candidate.validationArtifacts.map(async (ref) => await validateAttestationRef(services, ref, "steering.contract", candidate.task.sha256)),
      ...candidate.anchorEvidence.map(async (ref) => await validateAttestationRef(services, ref, "steering.anchor", candidate.evaluator.sha256)),
    ]);
  }
  const candidateSha256 = await services.version.records.hashStaged("steering-candidate", candidate.id);
  const approval = await writeAdminApproval(
    services, "steering", candidate.id, candidateSha256, command.decision,
  );
  await services.version.records.write("steering-resolution", {
    id: services.state.id("steering-resolution"), candidateId: candidate.id,
    candidateSha256, decision: command.decision, approvalEvidence: [approval],
    createdAt: services.state.now(),
  });
  if (command.decision === "approve") {
    const revision: SteeringRevision = {
      id: candidate.id,
      parentRevisionId: candidate.parentRevisionId,
      originalGoal: candidate.originalGoal,
      task: candidate.task,
      boundary: candidate.boundary,
      evaluator: candidate.evaluator,
      approvalEvidence: [approval],
      createdAt: candidate.createdAt,
    };
    await services.version.records.write("steering", revision);
    await services.version.records.activate("steering", revision.id);
  }
  return finishAdmin(state, { candidateId: candidate.id, decision: command.decision });
}

export async function policyActivate({ services, state }: {
  services: RunPolicyServices; state: RunState; signal: AbortSignal;
}): Promise<RunOperationResult> {
  const command = state.pendingRunCommand;
  if (!command || command.type !== "policy.activate") throw new Error("Missing Policy activation command");
  const candidate = await services.version.records.loadStaged<PolicyRevisionCandidate>("policy", command.candidateId);
  const groups = [candidate.apiValidation, candidate.contractTests, candidate.replayEvidence, candidate.smokeEvidence];
  if (groups.some((group) => !group.length)) throw new Error("Policy candidate is missing required validation evidence");
  const kinds: ValidationAttestation["kind"][] = ["policy.api", "policy.contract", "policy.replay", "policy.smoke"];
  await Promise.all(groups.flatMap((group, index) => group.map(async (ref) =>
    await validateAttestationRef(services, ref, kinds[index], candidate.module.sha256))));
  await services.version.records.verifyRef(candidate.module);
  const candidateSha256 = await services.version.records.hashStaged("policy", candidate.id);
  const approval = await writeAdminApproval(
    services, "policy", candidate.id, candidateSha256, "activate",
  );
  await services.version.records.write("policy-activation", {
    id: services.state.id("policy-activation"), candidateId: candidate.id,
    candidateSha256, moduleSha256: candidate.module.sha256,
    approvalEvidence: [approval], createdAt: services.state.now(),
  });
  await services.version.records.commitStaged("policy", candidate.id);
  const pending: PolicyActivationPending = {
    id: candidate.id,
    candidateId: candidate.id,
    candidateSha256,
    approvalEvidence: [approval],
    createdAt: services.state.now(),
  };
  await services.version.records.write("policy-pending", pending);
  await services.version.records.activate("policy-pending", pending.id);
  return finishAdmin(state, { candidateId: candidate.id, status: "approved_pending_safe_point" });
}
