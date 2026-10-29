import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentService } from "../services/agent/protocol.ts";
import { readJobResult } from "../services/agent/job-validation.ts";
import type { JobSpec } from "../services/agent/job-protocol.ts";
import { promptAsset } from "../services/prompt/index.ts";
import type { ProcessService } from "../services/process/index.ts";
import type { ExecutionBudget } from "../session/execution-budget.ts";
import { requiredVerificationWork } from "./compact-assistance.ts";

/** A semantic gap is a user pause, never an automatic evaluator repair. */
export class CompactVerificationNeedsInput extends Error {
  constructor(message: string) { super(message); this.name = "CompactVerificationNeedsInput"; }
}

/** Frozen execution protocol. Business scores and sample semantics stay in the evaluator. */
export interface VerificationConfig {
  schemaVersion: 1;
  command: string;
  args: string[];
  timeoutMs: number;
  acceptance: "explicit" | "open";
  tasking?: boolean;
  judging?: boolean;
}

export interface VerificationRequest {
  schemaVersion: 1;
  mode: "baseline" | "candidate";
  subjectRoot: string;
  artifactPath: string;
  outputDir: string;
  goalPath: string;
  baselineResultPath?: string;
  trainPath?: string;
  holdoutPath?: string;
}

export interface VerificationResult {
  schemaVersion: 1;
  status: "completed" | "failed" | "needs_input";
  retention: "retain" | "reject" | "inconclusive";
  target: "achieved" | "not_achieved" | "inconclusive";
  summary: string;
  publicFeedback: string;
  evidence: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function validateVerificationConfig(value: unknown): VerificationConfig {
  if (!record(value) || value.schemaVersion !== 1
    || typeof value.command !== "string" || !value.command.trim() || value.command.includes("\0")
    || !Array.isArray(value.args) || !value.args.every((item) => typeof item === "string" && !item.includes("\0"))
    || (value.command !== "{evaluator}" && !value.args.includes("{evaluator}"))
    || value.args.length > 128 || !Number.isSafeInteger(value.timeoutMs)
    || (value.timeoutMs as number) < 1 || (value.timeoutMs as number) > 900_000
    || !["explicit", "open"].includes(String(value.acceptance))
    || (value.tasking !== undefined && typeof value.tasking !== "boolean")
    || (value.judging !== undefined && typeof value.judging !== "boolean")) {
    throw new Error("Invalid compact verification config (schema 1, argv, timeout 1..900000ms, acceptance required)");
  }
  return value as unknown as VerificationConfig;
}

export async function readVerificationConfig(file: string): Promise<VerificationConfig> {
  return validateVerificationConfig(JSON.parse(await readFile(file, "utf8")));
}

/** Validate the envelope only, never interpret scores, rubrics or sample fields. */
export function parseVerificationResult(value: unknown): VerificationResult {
  if (!record(value) || value.schemaVersion !== 1
    || !["completed", "failed", "needs_input"].includes(String(value.status))
    || !["retain", "reject", "inconclusive"].includes(String(value.retention))
    || !["achieved", "not_achieved", "inconclusive"].includes(String(value.target))
    || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 2_000
    || typeof value.publicFeedback !== "string" || value.publicFeedback.length > 12_000
    || !Array.isArray(value.evidence) || value.evidence.length > 256
    || !value.evidence.every((entry) => typeof entry === "string" && entry.trim())
    || (value.status === "completed" && value.evidence.length === 0)) {
    throw new Error("Invalid compact verification result envelope");
  }
  if (value.status !== "completed" && (value.retention !== "inconclusive" || value.target !== "inconclusive")) {
    throw new Error("Incomplete verification cannot retain a candidate or decide target achievement");
  }
  return value as unknown as VerificationResult;
}

export async function validateVerificationEvidence(result: VerificationResult, outputDir: string): Promise<void> {
  const physicalRoot = await realpath(outputDir);
  const resultPath = path.join(outputDir, "result.json");
  const physicalResult = await realpath(resultPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  for (const entry of result.evidence) {
    const file = path.resolve(outputDir, entry);
    if (path.relative(resultPath, file) === "") throw new Error("Verification result cannot be its own evidence");
    const physicalFile = await realpath(file);
    if (physicalResult && path.relative(physicalResult, physicalFile) === "") throw new Error("Verification result cannot be its own evidence");
    if (!inside(outputDir, file) || !inside(physicalRoot, physicalFile) || !(await stat(file)).isFile()) {
      throw new Error(`Verification evidence must be a real file inside its output directory: ${entry}`);
    }
  }
}

export interface CompactVerificationOptions {
  /** Host project root also contains the isolated subject and private output directories. */
  projectRoot?: string;
  configPath: string;
  evaluatorPath: string;
  taskPath: string;
  boundaryPath: string;
  taskingGuidePath?: string;
  evaluateGuidePath?: string;
  request: VerificationRequest;
  process: ProcessService;
  agent?: AgentService;
  executionBudget?: ExecutionBudget;
  /** Granted only by the new trusted compact Policy. Old tasks keep old accounting. */
  requiredReservationId?: string;
  signal?: AbortSignal;
  emit?(type: string, data?: Record<string, unknown>): Promise<void>;
}

/** Resolve existing ancestors before creating an output directory. */
async function physicalOutputPath(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await physicalOutputPath(parent), path.basename(file));
  }
}

async function sourceRoots(artifactPath: string, subjectRoot: string): Promise<string[]> {
  if (!(await stat(artifactPath)).isDirectory()) return [artifactPath];
  // Whole-project artifacts must not expose the private Runtime tree through a broad read root.
  const roots = (await readdir(artifactPath)).filter((entry) => entry !== ".git" && entry !== ".flywheel")
    .map((entry) => path.join(artifactPath, entry));
  const physicalSubject = await realpath(subjectRoot);
  for (const root of roots) if (!inside(physicalSubject, await realpath(root))) {
    throw new Error(`Verification source follows a symlink outside subject: ${root}`);
  }
  return roots;
}

async function runModelStep(options: CompactVerificationOptions, kind: "tasking" | "judging", outputsDir: string): Promise<void> {
  if (!options.agent) throw new Error(`Compact ${kind} requires AgentService; evaluators cannot make unaccounted model calls`);
  const guide = kind === "tasking" ? options.taskingGuidePath : options.evaluateGuidePath;
  if (!guide) throw new Error(`Compact ${kind} requires its frozen guide role`);
  const request = options.request;
  const projectRoot = path.resolve(options.projectRoot ?? request.subjectRoot);
  const destination = kind === "tasking" ? outputsDir : path.join(request.outputDir, "judging");
  await mkdir(destination, { recursive: true });
  const resultPath = path.join(destination, "job-result.json");
  const judgeResultPath = path.join(destination, "judge.json");
  const privatePaths = [options.configPath, options.evaluatorPath,
    ...(kind === "tasking" && options.evaluateGuidePath ? [options.evaluateGuidePath] : []),
    path.join(projectRoot, ".git")];
  const job: JobSpec = {
    operation: `verify_${kind}`,
    label: `verification:${kind}`,
    // No sessionKey: task execution and judging never inherit optimizer or each other's context.
    cwd: projectRoot,
    tools: kind === "tasking" ? ["Read", "Write", "Bash"] : ["Read", "Write"],
    readRoots: [...await sourceRoots(request.artifactPath, request.subjectRoot), request.goalPath, options.taskPath, guide,
      ...[request.trainPath, request.holdoutPath].filter((item): item is string => !!item),
      ...(kind === "judging" ? [outputsDir] : [])],
    writeRoots: [destination],
    deniedPaths: privatePaths,
    resultPath,
    executionBudget: options.executionBudget,
    ...(options.requiredReservationId && options.executionBudget ? { invocationReservation: {
      reservationId: options.requiredReservationId,
      estimatedTokens: options.executionBudget.estimateInvocation(`verification:${kind}`).tokens,
      estimatedActiveMs: options.executionBudget.estimateInvocation(`verification:${kind}`).activeMs,
      estimateClass: `verification:${kind}`,
    } } : {}),
    delegation: "disabled",
    prompt: promptAsset(`compact.${kind}`, {
      subject_root: request.subjectRoot, artifact_path: request.artifactPath,
      goal_path: request.goalPath, task_path: options.taskPath, guide_path: guide,
      train_path: request.trainPath ?? "(none)", holdout_path: request.holdoutPath ?? "(none)",
      outputs_dir: outputsDir, judge_result_path: judgeResultPath, result_path: resultPath,
    }),
  };
  options.executionBudget?.assertAvailable();
  const response = await options.agent.execute(job, options.signal);
  if (response.status === "needs_input") throw new CompactVerificationNeedsInput(response.message ?? `Verification ${kind} needs input`);
  if (response.status !== "completed") throw new Error(`Verification ${kind} ${response.status}: ${response.message ?? "no result"}`);
  const persisted = await readJobResult(job);
  if (persisted.status === "needs_input") throw new CompactVerificationNeedsInput(persisted.message ?? `Verification ${kind} needs input`);
  if (persisted.status !== "completed" || persisted.artifacts.length === 0) {
    throw new Error(`Verification ${kind} did not produce completed task evidence`);
  }
  if (kind === "judging") {
    const physical = await realpath(judgeResultPath);
    if (!inside(await realpath(destination), physical) || !(await stat(physical)).isFile()) throw new Error("Invalid judge evidence path");
    JSON.parse(await readFile(judgeResultPath, "utf8"));
  }
}

/** A shared verification operation, not another runner. Policies own retry, state and promotion. */
export async function runCompactVerification(options: CompactVerificationOptions): Promise<VerificationResult> {
  const config = await readVerificationConfig(options.configPath);
  if (config.tasking && !options.taskingGuidePath) throw new Error("Compact tasking requires its frozen guide role");
  if (config.judging && !options.evaluateGuidePath) throw new Error("Compact judging requires its frozen guide role");
  let request = options.request;
  if (request.schemaVersion !== 1 || !["baseline", "candidate"].includes(request.mode)
    || Boolean(request.trainPath) !== Boolean(request.holdoutPath)) throw new Error("Invalid verification request");
  const projectRoot = path.resolve(options.projectRoot ?? request.subjectRoot);
  const paths = [request.subjectRoot, request.artifactPath, request.outputDir, request.goalPath,
    options.configPath, options.evaluatorPath, options.taskPath, options.boundaryPath,
    ...[request.trainPath, request.holdoutPath, request.baselineResultPath, options.taskingGuidePath, options.evaluateGuidePath]
      .filter((item): item is string => !!item)];
  for (const file of paths) if (!path.isAbsolute(file) || !inside(projectRoot, file)) throw new Error(`Verification path escapes project: ${file}`);
  if (!inside(request.subjectRoot, request.artifactPath)) throw new Error("Artifact path escapes verification subject");
  const physicalProject = await realpath(projectRoot);
  for (const file of paths) {
    const physicalFile = file === request.outputDir ? await physicalOutputPath(file) : await realpath(file);
    if (!inside(physicalProject, physicalFile)) throw new Error(`Verification path follows a symlink outside project: ${file}`);
  }
  if (!inside(await realpath(request.subjectRoot), await realpath(request.artifactPath))) {
    throw new Error("Artifact path follows a symlink outside verification subject");
  }
  const outputRoot = request.outputDir;
  // Each actual execution gets fresh evidence; recovery reuses only a separately verified binding.
  request = { ...request, outputDir: path.join(outputRoot, `execution-${randomUUID()}`) };
  options = { ...options, request };
  if (options.requiredReservationId && options.executionBudget) {
    if (options.executionBudget.state.reservations?.[options.requiredReservationId]?.closed) {
      options.requiredReservationId = `${options.requiredReservationId}:${path.basename(request.outputDir)}`;
    }
    await options.executionBudget.reserveRequiredWork(options.requiredReservationId,
      requiredVerificationWork(config, options.executionBudget));
  }
  try {
  await mkdir(request.outputDir, { recursive: true });
  const outputsDir = path.join(request.outputDir, "outputs");
  await mkdir(outputsDir, { recursive: true });
  await options.emit?.("verification.started", { mode: request.mode, outputDir: request.outputDir });
  if (config.tasking) await runModelStep(options, "tasking", outputsDir);
  if (config.judging) await runModelStep(options, "judging", outputsDir);
  let comparable = false;
  if (request.mode === "candidate" && request.baselineResultPath) {
    const baseline = parseVerificationResult(JSON.parse(await readFile(request.baselineResultPath, "utf8")));
    await validateVerificationEvidence(baseline, path.dirname(request.baselineResultPath));
    comparable = baseline.status === "completed";
  }
  options.executionBudget?.assertAvailable();
  const identity = `verification:${randomUUID()}`;
  await options.executionBudget?.startProcess(identity);
  let output;
  try {
    try {
      const timeoutMs = Math.min(config.timeoutMs, options.executionBudget?.remainingActiveMs() ?? config.timeoutMs);
      if (timeoutMs < 1) options.executionBudget?.assertAvailable();
      output = await options.process.run(config.command === "{evaluator}" ? options.evaluatorPath : config.command,
        config.args.map((arg) => arg === "{evaluator}" ? options.evaluatorPath : arg), {
          cwd: request.subjectRoot,
          timeoutMs: Math.max(1, timeoutMs), signal: options.signal, maxOutputBytes: 1_048_576,
          input: JSON.stringify({ ...request, outputsDir,
            ...(config.judging ? { judgeResultPath: path.join(request.outputDir, "judging", "judge.json") } : {}) }),
        });
    } finally { await options.executionBudget?.finishProcess(identity); }
  } catch (error) {
    options.executionBudget?.assertAvailable();
    throw error;
  }
  if (output.code !== 0) throw new Error(`Verification command exited ${output.code}: ${output.stderr.slice(-2_000)}`);
  const result = parseVerificationResult(JSON.parse(output.stdout));
  await validateVerificationEvidence(result, request.outputDir);
  if (config.acceptance === "open") result.target = "inconclusive";
  if (request.mode === "baseline" || !comparable) result.retention = "inconclusive";
  result.evidence = result.evidence.map(entry => path.relative(outputRoot, path.resolve(request.outputDir, entry)));
  await writeFile(path.join(outputRoot, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  await options.emit?.("verification.completed", { mode: request.mode, status: result.status, target: result.target, retention: result.retention });
  if (result.status === "needs_input") throw new CompactVerificationNeedsInput(result.summary);
  return result;
  } finally {
    // Interrupted/uncertain invocations keep their occupancy; never mask the original result.
    if (options.requiredReservationId) await options.executionBudget?.closeReservation(options.requiredReservationId).catch(() => undefined);
  }
}
