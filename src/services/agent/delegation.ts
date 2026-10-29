import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { promptAsset } from "../prompt/index.ts";
import type { AssistanceRequest, DelegateRequest, DelegateTask, JobResult, JobSpec } from "./job-protocol.ts";
import { readJobResult, validateJobResult, validateJobSpec } from "./job-validation.ts";
import type { AgentJobResult } from "./protocol.ts";
import { ExecutionBudgetExhausted } from "../../session/execution-budget.ts";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_CHILDREN = 32;
const DEFAULT_MAX_TOTAL_JOBS = 64;
const DEFAULT_CONCURRENCY = 8;
const MAX_REQUEST_REPAIRS = 3;
const ASSISTANCE_TIMEOUT_MS = 120_000;

/** Authority, frozen bindings and uncertain execution are never protocol repair. */
export class AssistanceInvariantError extends Error {
  constructor(message: string) { super(message); this.name = "AssistanceInvariantError"; }
}

export interface AgentJobTreeOptions {
  concurrency?: number;
  maxDepth?: number;
  maxChildren?: number;
  maxTotalJobs?: number;
  onJobStarted?: (job: JobSpec) => void | Promise<void>;
  onJobCompleted?: (job: JobSpec, result: AgentJobResult) => void | Promise<void>;
  onJobEvent?: (job: JobSpec, event: Record<string, unknown>) => void | Promise<void>;
}

export type AgentTurnExecutor = (job: JobSpec, signal?: AbortSignal) => Promise<AgentJobResult>;

interface TreeBudget {
  remaining: number;
}

interface ChildSummary {
  jobId: string;
  status: JobResult["status"];
  artifacts: string[];
  message?: string;
}

interface DelegationResponse {
  schemaVersion: 1;
  round: number;
  requestHash: string;
  jobsUsed: number;
  children: ChildSummary[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve existing symlink ancestors without requiring a future output path to exist. */
function physicalPath(value: string): string {
  let existing = path.resolve(value);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...missing);
}

function safeJobName(job: JobSpec): string {
  const identity = job.id ?? job.sessionKey ?? job.label;
  const readable = identity.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "job";
  return `${readable}-${sha256(identity).slice(0, 10)}`;
}

function jobControlDirectory(job: JobSpec): string | undefined {
  if (!job.tools.includes("Write")) return undefined;
  return path.join(path.resolve(job.cwd), ".flywheel", "runtime", "agent-jobs", safeJobName(job));
}

function taskLabel(task: string): string {
  const normalized = task.replace(/\s+/g, " ").trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function parseTask(value: unknown, index: number): DelegateTask {
  if (!record(value)) throw new Error(`tasks[${index}] must be an object`);
  const unknown = Object.keys(value).filter((key) => !["task", "inputs", "tools"].includes(key));
  if (unknown.length) throw new Error(`tasks[${index}] contains unsupported fields: ${unknown.join(", ")}`);
  if (typeof value.task !== "string" || !value.task.trim()) throw new Error(`tasks[${index}].task must be non-empty text`);
  const strings = (field: "inputs" | "tools"): string[] | undefined => {
    const current = value[field];
    if (current === undefined) return undefined;
    if (!Array.isArray(current) || !current.length || !current.every((item) => typeof item === "string" && item.trim())) {
      throw new Error(`tasks[${index}].${field} must be a non-empty string array`);
    }
    return [...new Set(current.map((item) => item.trim()))];
  };
  const inputs = strings("inputs");
  const tools = strings("tools");
  return { task: value.task.trim(), ...(inputs ? { inputs } : {}), ...(tools ? { tools } : {}) };
}

/** Read the only Agent-authored delegation structure. It contains no Runtime paths or identities. */
export async function readDelegateRequest(requestPath: string, maxChildren: number): Promise<DelegateRequest> {
  const value = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
  if (!record(value) || Object.keys(value).some((key) => key !== "tasks") || !Array.isArray(value.tasks)) {
    throw new Error("Delegate request must contain only a tasks array");
  }
  if (!value.tasks.length) throw new Error("Delegate request must contain at least one task");
  if (value.tasks.length > maxChildren) throw new Error(`Delegate request exceeds maxChildren=${maxChildren}`);
  return { tasks: value.tasks.map(parseTask) };
}

/** Explicit v2 is accepted only when a trusted JobSpec assistance boundary exists. */
export async function readAssistanceRequest(requestPath: string): Promise<AssistanceRequest> {
  const value = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
  if (!record(value) || Object.keys(value).some((key) => !["schemaVersion", "purpose", "reason", "evidence", "tasks"].includes(key))
    || value.schemaVersion !== 2 || !["work", "check"].includes(String(value.purpose))) {
    throw new Error("Assistance request requires schemaVersion=2 and purpose=work|check");
  }
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 1000) {
    throw new Error("Assistance reason must contain 1..1000 characters");
  }
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 16
    || !value.evidence.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("Assistance evidence must contain 1..16 actual readable file paths");
  }
  if (!Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > (value.purpose === "check" ? 1 : 2)) {
    throw new Error("Assistance work permits 1..2 tasks; check requires exactly one task");
  }
  const tasks = value.tasks.map(parseTask);
  if (tasks.some((task) => task.task.length > 8000 || !task.inputs?.length || task.inputs.length > 64 || (task.tools?.length ?? 0) > 32)) {
    throw new Error("Each assistance task requires 1..64 explicit inputs, at most 32 tools and 8000 task characters");
  }
  return { schemaVersion: 2, purpose: value.purpose as "work" | "check", reason: value.reason.trim(),
    evidence: [...new Set(value.evidence.map((item: string) => item.trim()))], tasks };
}

interface FileBinding { path: string; physical: string; sha256: string }
interface AssistanceChildState {
  jobId: string;
  state: "pending" | "running" | "finished";
  result?: ChildSummary;
  artifacts?: FileBinding[];
  resultSha256?: string;
}
interface AssistanceRecord {
  schemaVersion: 2;
  revision: string;
  windowId: string;
  parentJobId: string;
  request: AssistanceRequest;
  requestHash: string;
  bindings: FileBinding[];
  identity: string;
  decision: "admitted" | "denied";
  reason: string;
  reservationId?: string;
  invocationEstimate?: { tokens: number; activeMs: number; source: string };
  /** Elapsed wall time is persisted only while this batch is actually executing. */
  deadline: number;
  state: "children" | "continuation" | "continuation_running" | "finished";
  children: AssistanceChildState[];
  finalResult?: JobResult;
  finalResultHash?: string;
}

/** Carve denied subtrees out of broad roots before granting exact exceptions. */
async function rootsWithoutDenied(job: JobSpec, roots: string[], controlDir: string): Promise<string[]> {
  // Only carve denies that must be replaced by exact protocol exceptions.
  // Ordinary protected descendants keep their deny and their broad parent root,
  // preserving authority to create new files elsewhere in that root.
  const denied = (job.deniedPaths ?? []).map((item) => path.resolve(job.cwd, item)).filter((item) => inside(controlDir, item));
  const visit = async (root: string): Promise<string[]> => {
    const physical = physicalPath(root);
    if (denied.some((item) => inside(root, item) || inside(physical, physicalPath(item)))) return [];
    if (!denied.some((item) => inside(item, root) || inside(physicalPath(item), physical))) return [root];
    const entries = await readdir(root).catch(() => { throw new AssistanceInvariantError(`Cannot narrow Parent authority around denied paths: ${root}`); });
    return (await Promise.all(entries.map((entry) => visit(path.join(root, entry))))).flat();
  };
  return [...new Set((await Promise.all(roots.map((root) => visit(path.resolve(job.cwd, root))))).flat())];
}

async function assertReadable(parent: JobSpec, input: string, fileOnly = false): Promise<string> {
  const resolved = path.resolve(parent.cwd, input);
  const physical = physicalPath(resolved);
  const roots = [...parent.readRoots, ...parent.writeRoots].map((root) => path.resolve(parent.cwd, root));
  const denied = (parent.deniedPaths ?? []).map((item) => path.resolve(parent.cwd, item));
  if (!roots.some((root) => inside(resolved, root) && inside(physical, physicalPath(root)))
    || denied.some((item) => inside(resolved, item) || inside(physical, physicalPath(item)))) {
    throw new AssistanceInvariantError(`Assistance input exceeds Parent authority: ${input}`);
  }
  const info = await stat(resolved).catch(() => { throw new AssistanceInvariantError(`Assistance input is unavailable: ${input}`); });
  if (fileOnly && !info.isFile()) throw new AssistanceInvariantError(`Assistance evidence must be a file: ${input}`);
  if (info.isDirectory() && denied.some((item) => inside(item, resolved) || inside(physicalPath(item), physical))) {
    throw new AssistanceInvariantError(`Assistance directory contains denied material: ${input}`);
  }
  return resolved;
}

async function bindAssistanceInputs(parent: JobSpec, request: AssistanceRequest): Promise<FileBinding[]> {
  const bindings = new Map<string, FileBinding>();
  const visited = new Set<string>();
  const visit = async (input: string): Promise<void> => {
    const resolved = await assertReadable(parent, input);
    const physical = await realpath(resolved);
    if (visited.has(physical)) return;
    visited.add(physical);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      for (const entry of (await readdir(resolved)).sort()) await visit(path.join(resolved, entry));
    } else if (info.isFile()) {
      if (bindings.size >= 4096) throw new AssistanceInvariantError("Assistance inputs exceed 4096 files; narrow the input scope");
      bindings.set(resolved, { path: resolved, physical, sha256: sha256(await readFile(resolved)) });
    } else throw new AssistanceInvariantError(`Unsupported assistance input: ${input}`);
  };
  for (const evidence of request.evidence) { await assertReadable(parent, evidence, true); await visit(evidence); }
  for (const task of request.tasks) {
    if (task.tools?.some((tool) => !parent.tools.includes(tool))) throw new AssistanceInvariantError("Assistance tools exceed Parent authority");
    for (const input of task.inputs!) await visit(input);
  }
  return [...bindings.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function assertBindings(parent: JobSpec, record: AssistanceRecord): Promise<void> {
  const current = await bindAssistanceInputs(parent, record.request);
  if (JSON.stringify(current) !== JSON.stringify(record.bindings)) {
    throw new AssistanceInvariantError("Assistance inputs changed; the original authorization and reports have expired");
  }
}

async function artifactBindings(job: JobSpec, result: ChildSummary): Promise<FileBinding[]> {
  const bindings: FileBinding[] = [];
  for (const artifact of result.artifacts) {
    const resolved = path.resolve(job.cwd, artifact);
    const physical = await realpath(resolved);
    if (!job.writeRoots.some((root) => inside(resolved, path.resolve(job.cwd, root)) && inside(physical, physicalPath(path.resolve(job.cwd, root))))) {
      throw new AssistanceInvariantError(`Assistance artifact escaped its private output: ${artifact}`);
    }
    if (!(await stat(resolved)).isFile()) throw new AssistanceInvariantError(`Assistance artifact must be a file: ${artifact}`);
    bindings.push({ path: resolved, physical, sha256: sha256(await readFile(resolved)) });
  }
  return bindings;
}

async function readAssistanceRecord(file: string, job: JobSpec): Promise<AssistanceRecord | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!record(value) || value.schemaVersion !== 2 || value.revision !== job.assistance!.revision
    || value.windowId !== job.assistance!.windowId || value.parentJobId !== job.id
    || !["admitted", "denied"].includes(String(value.decision)) || !Array.isArray(value.bindings)
    || !Array.isArray(value.children) || !["children", "continuation", "continuation_running", "finished"].includes(String(value.state))
    || typeof value.identity !== "string" || typeof value.requestHash !== "string" || typeof value.reason !== "string"
    || typeof value.deadline !== "number") throw new AssistanceInvariantError("Persisted assistance authorization is invalid");
  const saved = value as unknown as AssistanceRecord;
  if (sha256(JSON.stringify(saved.request)) !== saved.requestHash) throw new AssistanceInvariantError("Persisted assistance request hash mismatch");
  if (saved.decision === "admitted" && (!saved.reservationId || !saved.invocationEstimate
    || !Number.isSafeInteger(saved.invocationEstimate.tokens) || saved.invocationEstimate.tokens < 1
    || !Number.isSafeInteger(saved.invocationEstimate.activeMs) || saved.invocationEstimate.activeMs < 1)) {
    throw new AssistanceInvariantError("Persisted assistance estimate or reservation is invalid");
  }
  const expectedIdentity = sha256(JSON.stringify({ parent: job.id, window: saved.windowId, revision: saved.revision, requestHash: saved.requestHash }));
  const decision = job.executionBudget?.state.assistance?.decisions[saved.identity];
  if (saved.identity !== expectedIdentity || (saved.decision === "admitted" && (!decision?.admitted
    || decision.reservationId !== saved.reservationId
    || decision.binding !== sha256(JSON.stringify({ requestHash: saved.requestHash, bindings: saved.bindings, revision: saved.revision }))))) {
    throw new AssistanceInvariantError("Assistance authorization does not match the shared budget binding");
  }
  return saved;
}

async function readResponse(responsePath: string): Promise<DelegationResponse | undefined> {
  try {
    const value = JSON.parse(await readFile(responsePath, "utf8")) as unknown;
    if (!record(value) || value.schemaVersion !== 1 || !Number.isInteger(value.round)
      || typeof value.requestHash !== "string" || !Number.isInteger(value.jobsUsed) || (value.jobsUsed as number) < 0
      || !Array.isArray(value.children)) throw new Error("Persisted delegation response is invalid");
    const children = value.children.map((child): ChildSummary => {
      if (!record(child) || typeof child.jobId !== "string" || !["completed", "failed", "aborted", "needs_input"].includes(String(child.status))
        || !Array.isArray(child.artifacts) || !child.artifacts.every((item) => typeof item === "string")
        || (child.message !== undefined && typeof child.message !== "string")) {
        throw new Error("Persisted Child summary is invalid");
      }
      return {
        jobId: child.jobId,
        status: child.status as JobResult["status"],
        artifacts: child.artifacts as string[],
        ...(typeof child.message === "string" ? { message: child.message } : {}),
      };
    });
    return { schemaVersion: 1, round: value.round as number, requestHash: value.requestHash, jobsUsed: value.jobsUsed as number, children };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]!, index);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, run));
  const failure = settled.find((entry) => entry.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

async function childJob(parent: JobSpec, task: DelegateTask, controlDir: string, round: number, index: number): Promise<JobSpec> {
  const inputs = await Promise.all((task.inputs ?? []).map(async (input) => {
    const resolved = path.resolve(parent.cwd, input);
    const readable = [...parent.readRoots, ...parent.writeRoots].some((root) => inside(resolved, path.resolve(parent.cwd, root)));
    if (!readable) throw new Error(`tasks[${index}].inputs exceeds Parent authority: ${input}`);
    if ((parent.deniedPaths ?? []).some((denied) => inside(resolved, path.resolve(parent.cwd, denied)))) {
      throw new Error(`tasks[${index}].inputs references a denied path: ${input}`);
    }
    await access(resolved);
    const physical = await realpath(resolved);
    const physicallyReadable = [...parent.readRoots, ...parent.writeRoots]
      .some((root) => inside(physical, physicalPath(path.resolve(parent.cwd, root))));
    if (!physicallyReadable) throw new Error(`tasks[${index}].inputs escapes Parent authority through a symlink: ${input}`);
    return resolved;
  }));
  const requestedTools = task.tools ?? parent.tools;
  if (requestedTools.some((tool) => !parent.tools.includes(tool))) {
    throw new Error(`tasks[${index}].tools exceeds Parent authority`);
  }
  const tools = [...new Set([...requestedTools, ...(parent.tools.includes("Write") ? ["Write"] : [])])];
  const requestIdentity = JSON.stringify({ round, index, task,
    ...(parent.assistance ? { windowId: parent.assistance.windowId, revision: parent.assistance.revision } : {}) });
  const suffix = `${round}-${index}-${sha256(requestIdentity).slice(0, 8)}`;
  const workspace = path.join(controlDir, "children", suffix);
  const resultPath = path.join(workspace, "job-result.json");
  const parentId = parent.id ?? parent.sessionKey ?? parent.label;
  const id = `${parentId}/${suffix}`;
  return validateJobSpec({
    executionBudget: parent.executionBudget,
    delegation: parent.assistance ? "disabled" : parent.delegation,
    id,
    parentJobId: parentId,
    depth: (parent.depth ?? 0) + 1,
    operation: parent.operation,
    label: taskLabel(task.task),
    cwd: parent.cwd,
    tools,
    readRoots: [...new Set([...inputs, workspace])],
    writeRoots: [workspace],
    deniedPaths: parent.deniedPaths?.filter((denied) => !inside(workspace, path.resolve(parent.cwd, denied))),
    resultPath,
    sessionKey: `${parent.sessionKey ?? parentId}/${suffix}`,
    prompt: promptAsset("common.delegation-child", {
      child_task: parent.assistance
        ? `${task.task}\n整批协作（含父续接）最多 120 秒，以本批实际授权和剩余时间为准；只调查所列疑点，优先产出简短可核对报告，为父续接留时间，不做全仓库巡查。\n本次只提供定向调查、建议或补丁片段，不作正式评价，不推进 Runtime 状态，不更改目标/评价含义，不再委派。所有 artifacts 引用必须为私有输出中的实际文件；message 最多 1000 字符。`
        : task.task,
      output_workspace: workspace,
      result_path: resultPath,
    }),
    onEvent: parent.onEvent,
  });
}

function withTransport(result: JobResult, transport: AgentJobResult): AgentJobResult {
  return {
    ...result,
    sessionId: transport.sessionId,
    transcriptPath: transport.transcriptPath,
    usage: transport.usage,
    costUsd: transport.costUsd,
    durationMs: transport.durationMs,
  };
}

async function finalResult(job: JobSpec, transport: AgentJobResult): Promise<AgentJobResult> {
  if (transport.status !== "completed" || !job.resultPath) return transport;
  try {
    return withTransport(await readJobResult(job), transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...withTransport({ status: "failed", artifacts: [], message: `JobResult protocol invalid: ${message}` }, transport), protocolIssues: [message] };
  }
}

function delegatePrompt(job: JobSpec, basePrompt: JobSpec["prompt"], requestPath: string, budget: TreeBudget, options: Required<Pick<AgentJobTreeOptions, "maxDepth" | "maxChildren">>): JobSpec["prompt"] {
  return promptAsset("common.delegation-capable", {
    base_prompt: basePrompt,
    request_path: requestPath,
    final_result_path: job.resultPath ?? "由原任务指定",
    max_children: Math.min(options.maxChildren, budget.remaining),
    remaining_depth: options.maxDepth - (job.depth ?? 0),
  });
}

async function executeNode(
  executeTurn: AgentTurnExecutor,
  job: JobSpec,
  signal: AbortSignal | undefined,
  options: Required<Pick<AgentJobTreeOptions, "concurrency" | "maxDepth" | "maxChildren">> & AgentJobTreeOptions,
  budget: TreeBudget,
  reuseTerminal: boolean,
): Promise<AgentJobResult> {
  await options.onJobStarted?.(job);
  if (reuseTerminal && job.resultPath) {
    try {
      const existing = await readJobResult(job);
      if (existing.status !== "aborted") {
        const restored = existing as AgentJobResult;
        await options.onJobCompleted?.(job, restored);
        return restored;
      }
    } catch {
      // An incomplete Child resumes through its own durable request/response files.
    }
  }

  const delegation = job.delegation ?? (job.executionBudget ? "disabled" : "enabled");
  const assistance = job.assistance;
  if (assistance && ((job.depth ?? 0) !== 0 || !job.executionBudget || !assistance.revision || !assistance.windowId || !assistance.requiredReservationId)) {
    throw new AssistanceInvariantError("Assistance requires a trusted top-level boundary and shared execution budget");
  }
  const controlDir = assistance || delegation !== "disabled" ? jobControlDirectory(job) : undefined;
  if (assistance && controlDir && !inside(physicalPath(controlDir), physicalPath(job.cwd))) {
    throw new AssistanceInvariantError("Assistance control directory escapes the project through a symlink");
  }
  const canDelegate = () => controlDir !== undefined && (job.depth ?? 0) < options.maxDepth && budget.remaining > 0;
  const requestPath = controlDir ? path.join(controlDir, "request.json") : undefined;
  const rejectedRequestPath = controlDir ? path.join(controlDir, "rejected-request.json") : undefined;
  const responsePath = controlDir ? path.join(controlDir, "response.json") : undefined;
  if (controlDir) await mkdir(controlDir, { recursive: true });

  const assistancePath = assistance && controlDir ? path.join(controlDir, "assistance.json") : undefined;
  let assistanceRecord = assistancePath ? await readAssistanceRecord(assistancePath, job) : undefined;
  const assistanceEvent = async (decision: "admitted" | "denied" | "settled", message: string, saved?: AssistanceRecord) => {
    const event = { sdkEvent: `assistance.${decision}`, message, audience: "user", jobId: job.id,
      windowId: assistance!.windowId, revision: assistance!.revision,
      ...(saved ? { requestId: saved.identity, purpose: saved.request.purpose, reason: saved.request.reason,
        evidence: saved.request.evidence, reservationId: saved.reservationId, childCount: saved.children.length } : {}) };
    await job.onEvent?.(event);
    await options.onJobEvent?.(job, event);
  };
  const pauseUncertain = (message: string, reason: "tokens" | "time" = "tokens"): never => {
    const error = new ExecutionBudgetExhausted(reason);
    error.message = message;
    throw error;
  };
  if (assistanceRecord && ["continuation_running", "finished"].includes(assistanceRecord.state)) {
    // A persisted response is consumed only once. If the continuation's state is
    // uncertain, a new model turn would spend the same authority a second time.
    if (assistanceRecord.state === "finished" && assistanceRecord.finalResult) {
      if (assistanceRecord.finalResultHash && (!job.resultPath || sha256(await readFile(job.resultPath)) !== assistanceRecord.finalResultHash)) {
        throw new AssistanceInvariantError("Completed assistance Parent result hash changed");
      }
      await options.onJobCompleted?.(job, assistanceRecord.finalResult);
      return assistanceRecord.finalResult;
    }
    let completed: JobResult | undefined;
    try { completed = await readJobResult(job); } catch { /* Missing terminal evidence is uncertain. */ }
    if (completed && completed.status !== "aborted") {
      if (assistanceRecord.reservationId) await job.executionBudget!.closeReservation(assistanceRecord.reservationId);
      assistanceRecord.state = "finished";
      assistanceRecord.finalResult = completed;
      assistanceRecord.finalResultHash = sha256(await readFile(job.resultPath!));
      await writeJsonAtomic(assistancePath!, assistanceRecord);
      await options.onJobCompleted?.(job, completed);
      return completed;
    }
    pauseUncertain("协作父会话已启动但终态无法核实；保留用量占位并暂停，核实原调用后才能继续。");
  }

  let response = !assistance && responsePath ? await readResponse(responsePath) : undefined;
  if (response) budget.remaining = Math.max(0, budget.remaining - response.jobsUsed);
  let basePrompt = assistanceRecord
    ? promptAsset("common.assistance-resume", { decision: assistanceRecord.decision, reason: assistanceRecord.reason,
      child_results: assistanceRecord.children.map((entry) => entry.result), final_result_path: job.resultPath ?? "由原任务指定" })
    : response
    ? promptAsset("common.delegation-resume", { child_results: { children: response.children }, final_result_path: job.resultPath ?? "由原任务指定" })
    : job.prompt;
  let repairs = 0;
  let resultRepairs = 0;
  let continuationReservation: JobSpec["invocationReservation"];
  let batchSignal = signal;
  let batchTimedOut = false;
  // A transport timeout may throw after its terminal usage event, before the
  // batch signal fires. Only a positively metered terminal call may be settled;
  // unknown/interrupted calls keep their durable running state and reservation.
  const withTimeoutEvidence = async (current: JobSpec, execute: (observed: JobSpec) => Promise<AgentJobResult>): Promise<AgentJobResult> => {
    const started = new Set<string>();
    const completed = new Set<string>();
    const terminalKnown = () => started.size > 0 && [...started].every(id => {
      const entry = job.executionBudget?.state.invocations[id];
      return completed.has(id) && entry?.endedAt !== undefined && entry.tokens !== undefined && !entry.interrupted;
    });
    let result: AgentJobResult;
    try {
      result = await execute({ ...current, onEvent: async event => {
        if (typeof event.invocationId === "string") {
          if (event.sdkEvent === "invocation.started") started.add(event.invocationId);
          if (event.sdkEvent === "invocation.completed") completed.add(event.invocationId);
        }
        await current.onEvent?.(event);
      } });
    } catch (error) {
      if (!(error instanceof ExecutionBudgetExhausted) || error.reason !== "time" || !terminalKnown()) throw error;
      batchTimedOut = true;
      const aborted: AgentJobResult = { status: "aborted", artifacts: [], message: "本批协作超过授权时限，已取消并保留真实用量与结果。" };
      if (current.parentJobId) await options.onJobCompleted?.(current, aborted);
      return aborted;
    }
    // Wall-clock authorization can expire before the active-time timer (e.g.
    // after disk work or recovery). A normal aborted return is not proof of
    // known usage, and must follow the same settlement rules as a thrown timeout.
    const wallTimeout = batchSignal?.aborted && !signal?.aborted;
    if ((wallTimeout || result.status === "aborted") && started.size > 0 && !terminalKnown())
      pauseUncertain("协作调用终态用量无法核实；保留运行记录与用量占位并暂停，不能重复执行。", wallTimeout ? "time" : "tokens");
    if (wallTimeout) {
      if (!terminalKnown()) pauseUncertain("本批协作授权已到期且终态无法核实；保留现场并暂停。", "time");
      batchTimedOut = true;
      return { status: "aborted", artifacts: [], message: "本批协作超过授权时限，已取消并保留真实用量与结果。" };
    }
    return result;
  };

  while (true) {
    if (signal?.aborted) {
      const aborted: AgentJobResult = { status: "aborted", artifacts: [] };
      await options.onJobCompleted?.(job, aborted);
      return aborted;
    }

    if (!assistance && !canDelegate() && requestPath) await rm(requestPath, { force: true });
    if (assistance && assistancePath && requestPath && (existsSync(requestPath) || assistanceRecord?.state === "children")) {
      if (existsSync(requestPath) && !inside(await realpath(requestPath), physicalPath(controlDir!))) {
        throw new AssistanceInvariantError("Assistance request path escapes its Runtime control directory");
      }
      let request: AssistanceRequest;
      try { request = existsSync(requestPath) ? await readAssistanceRequest(requestPath) : assistanceRecord!.request; }
      catch (error) {
        await job.executionBudget!.claimRepair();
        repairs += 1;
        await rm(rejectedRequestPath!, { force: true });
        await rename(requestPath, rejectedRequestPath!);
        basePrompt = promptAsset("common.delegation-repair", { issues: error instanceof Error ? error.message : String(error),
          rejected_request_path: rejectedRequestPath, request_path: requestPath, final_result_path: job.resultPath ?? "由原任务指定" });
        continue;
      }
      const requestHash = sha256(JSON.stringify(request));
      if (assistanceRecord?.state === "children" && requestHash !== assistanceRecord.requestHash) {
        throw new AssistanceInvariantError("Assistance request changed after admission");
      }
      if (assistanceRecord && assistanceRecord.state !== "children") {
        // Even an identical re-submission cannot turn a consumed authorization
        // into another admitted batch, and a legal refusal costs no repair.
        await rm(requestPath, { force: true });
        await assistanceEvent("denied", "本轮协作机会已使用，继续由当前 Agent 完成。", assistanceRecord);
        basePrompt = promptAsset("common.assistance-resume", { decision: "denied", reason: "window-used", child_results: [],
          final_result_path: job.resultPath ?? "由原任务指定" });
      } else {
        if (!assistanceRecord) {
          const bindings = await bindAssistanceInputs(job, request);
          const identity = sha256(JSON.stringify({ parent: job.id, window: assistance.windowId, revision: assistance.revision, requestHash }));
          const requiredReservationId = assistance.resolveRequiredReservationId
            ? await assistance.resolveRequiredReservationId() ?? `unavailable:${assistance.requiredReservationId}`
            : assistance.requiredReservationId;
          const admission = await job.executionBudget!.admitAssistance({ requestId: identity, windowId: assistance.windowId,
            binding: sha256(JSON.stringify({ requestHash, bindings, revision: assistance.revision })),
            childCount: request.tasks.length, requiredReservationId, estimateClass: "assistance" });
          const reservedEstimate = admission.reservationId
            ? job.executionBudget!.state.reservations?.[admission.reservationId]?.invocationEstimate : undefined;
          assistanceRecord = { schemaVersion: 2, revision: assistance.revision, windowId: assistance.windowId,
            parentJobId: job.id!, request, requestHash, identity, bindings, decision: admission.admitted ? "admitted" : "denied",
            reason: admission.reason ?? request.reason, reservationId: admission.reservationId,
            ...(reservedEstimate ? { invocationEstimate: { ...reservedEstimate } } : admission.estimate ? { invocationEstimate: { tokens: admission.estimate.tokens / (request.tasks.length + 1),
              activeMs: admission.estimate.activeMs / 2, source: admission.estimate.source } } : {}),
            deadline: Date.now() + Math.min(ASSISTANCE_TIMEOUT_MS, admission.authorizedActiveMs ?? admission.estimate?.activeMs ?? ASSISTANCE_TIMEOUT_MS),
            state: admission.admitted ? "children" : "continuation", children: [] };
          if (job.resultPath) await rm(job.resultPath, { force: true });
          if (admission.admitted) {
            const children = await Promise.all(request.tasks.map((task, index) => childJob(job, task, controlDir!, 0, index)));
            assistanceRecord.children = children.map((child) => ({ jobId: child.id!, state: "pending" }));
          }
          // Admission is durable in the shared budget before any Child starts.
          await writeJsonAtomic(assistancePath, assistanceRecord);
          await assistanceEvent(admission.admitted ? "admitted" : "denied", admission.admitted
            ? `${request.reason} 我会完成这批调查，再统一验证。`
            : `本轮协作未获准（${admission.reason}），继续由当前 Agent 完成。`, assistanceRecord);
        }
        await assertBindings(job, assistanceRecord);
        if (assistanceRecord.decision === "admitted") {
          const remainingMs = assistanceRecord.deadline - Date.now();
          if (remainingMs <= 0) pauseUncertain("本批协作的授权时间已到期，保留结果并暂停。", "time");
          batchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(remainingMs)]) : AbortSignal.timeout(remainingMs);
          const children = await Promise.all(assistanceRecord.request.tasks.map((task, index) => childJob(job, task, controlDir!, 0, index)));
          // Reconcile the whole restored batch before starting any unstarted
          // sibling. Otherwise concurrent recovery can spend while one old
          // invocation still has an unknown terminal state.
          for (let index = 0; index < children.length; index++) {
            const entry = assistanceRecord.children[index]!;
            if (entry.state !== "running") continue;
            try { await readJobResult(children[index]!); }
            catch { pauseUncertain("协作 Child 已启动但终态无法核实；保留用量占位并暂停，不能重复执行。"); }
          }
          // Child completions serialize file writes: two parallel terminal saves
          // cannot overwrite each other's state with an older JSON snapshot.
          let persistQueue = Promise.resolve();
          const persist = () => { persistQueue = persistQueue.then(() => writeJsonAtomic(assistancePath, assistanceRecord)); return persistQueue; };
          await mapLimit(children, options.concurrency, async (child, index) => {
            await assertBindings(job, assistanceRecord!);
            const entry = assistanceRecord!.children[index]!;
            if (entry.jobId !== child.id) throw new AssistanceInvariantError("Assistance Child identity mismatch");
            await mkdir(child.writeRoots[0]!, { recursive: true });
            if (entry.state === "finished") {
              const restored = entry.resultSha256 ? await readJobResult(child) : await validateJobResult(entry.result, child);
              if ((!entry.resultSha256 && entry.result?.status === "completed")
                || (entry.resultSha256 && entry.resultSha256 !== sha256(await readFile(child.resultPath!)))
                || JSON.stringify(await artifactBindings(child, entry.result!)) !== JSON.stringify(entry.artifacts)
                || restored.status !== entry.result!.status || JSON.stringify(restored.artifacts) !== JSON.stringify(entry.result!.artifacts)) {
                throw new AssistanceInvariantError("Completed assistance Child result or artifact hash changed");
              }
              return;
            }
            if (entry.state === "running") {
              let restored: JobResult | undefined;
              try { restored = await readJobResult(child); } catch { /* Do not blindly relaunch a running invocation. */ }
              if (!restored) pauseUncertain("协作 Child 已启动但终态无法核实；保留用量占位并暂停，不能重复执行。");
              entry.result = { jobId: child.id!, ...restored!, message: restored!.message?.slice(0, 1000) };
            } else {
              if (batchSignal?.aborted || batchTimedOut) return;
              entry.state = "running";
              await persist();
              const estimate = assistanceRecord!.invocationEstimate!;
              child.invocationReservation = { reservationId: assistanceRecord!.reservationId!, estimatedTokens: estimate.tokens,
                estimatedActiveMs: estimate.activeMs, estimateClass: "assistance" };
              const result = await withTimeoutEvidence(child, observed => executeNode(executeTurn, observed, batchSignal, options, budget, false));
              entry.result = { jobId: child.id!, status: result.status, artifacts: result.artifacts,
                ...(result.message ? { message: result.message.slice(0, 1000) } : {}) };
            }
            entry.artifacts = await artifactBindings(child, entry.result!);
            if (entry.result!.status !== "aborted" && existsSync(child.resultPath!)) entry.resultSha256 = sha256(await readFile(child.resultPath!));
            entry.state = "finished";
            await persist();
          });
          await persistQueue;
          if (batchSignal.aborted || batchTimedOut) {
            if (signal?.aborted) {
              const aborted: AgentJobResult = { status: "aborted", artifacts: [] };
              assistanceRecord.state = "finished";
              assistanceRecord.finalResult = aborted;
              await writeJsonAtomic(assistancePath, assistanceRecord);
              await job.executionBudget!.closeReservation(assistanceRecord.reservationId!);
              await assistanceEvent("settled", "本批协作已取消，已发生用量与结果均保留。", assistanceRecord);
              await options.onJobCompleted?.(job, aborted);
              return aborted;
            }
            await job.executionBudget!.closeReservation(assistanceRecord.reservationId!);
            assistanceRecord.state = "finished";
            assistanceRecord.finalResult = { status: "aborted", artifacts: [], message: "本批协作超过授权时限，已取消并保留真实用量与结果。" };
            await writeJsonAtomic(assistancePath, assistanceRecord);
            await assistanceEvent("settled", assistanceRecord.finalResult.message!, assistanceRecord);
            pauseUncertain(assistanceRecord.finalResult.message!, "time");
          }
          await assertBindings(job, assistanceRecord);
          assistanceRecord.state = "continuation";
          await writeJsonAtomic(assistancePath, assistanceRecord);
          const estimate = assistanceRecord.invocationEstimate!;
          continuationReservation = { reservationId: assistanceRecord.reservationId!, estimatedTokens: estimate.tokens,
            estimatedActiveMs: estimate.activeMs, estimateClass: "assistance" };
        }
        await rm(requestPath, { force: true });
        basePrompt = promptAsset("common.assistance-resume", { decision: assistanceRecord.decision, reason: assistanceRecord.reason,
          child_results: assistanceRecord.children.map((entry) => entry.result), final_result_path: job.resultPath ?? "由原任务指定" });
      }
    }
    if (!assistance && canDelegate() && requestPath && existsSync(requestPath)) {
      try {
        const request = await readDelegateRequest(requestPath, Math.min(options.maxChildren, budget.remaining));
        const round = (response?.round ?? -1) + 1;
        const previousJobsUsed = response?.jobsUsed ?? 0;
        const remainingBefore = budget.remaining;
        if (request.tasks.length > budget.remaining) throw new Error(`Delegate request exceeds remaining tree budget=${budget.remaining}`);
        budget.remaining -= request.tasks.length;
        let children: JobSpec[];
        try {
          children = await Promise.all(request.tasks.map(async (task, index) => await childJob(job, task, controlDir!, round, index)));
          await Promise.all(children.map(async (child) => await mkdir(child.writeRoots[0]!, { recursive: true })));
        } catch (error) {
          budget.remaining += request.tasks.length;
          throw error;
        }
        const results = await mapLimit(children, options.concurrency, async (child) => {
          try {
            return await executeNode(executeTurn, child, signal, options, budget, true);
          } catch (error) {
            if (error instanceof ExecutionBudgetExhausted) throw error;
            if (signal?.aborted) return { status: "aborted", artifacts: [] } as AgentJobResult;
            return { status: "failed", artifacts: [], message: error instanceof Error ? error.message : String(error) } as AgentJobResult;
          }
        });
        response = {
          schemaVersion: 1,
          round,
          requestHash: sha256(JSON.stringify(request)),
          jobsUsed: previousJobsUsed + (remainingBefore - budget.remaining),
          children: results.map((result, index) => ({
            jobId: children[index]!.id!, status: result.status, artifacts: result.artifacts,
            ...(result.message ? { message: result.message } : {}),
          })),
        };
        await writeJsonAtomic(responsePath!, response);
        await rm(requestPath, { force: true });
        if (rejectedRequestPath) await rm(rejectedRequestPath, { force: true });
        basePrompt = promptAsset("common.delegation-resume", {
          child_results: { children: response.children },
          final_result_path: job.resultPath ?? "由原任务指定",
        });
        repairs = 0;
        continue;
      } catch (error) {
        if (error instanceof ExecutionBudgetExhausted) throw error;
        if (job.executionBudget) await job.executionBudget.claimRepair();
        repairs += 1;
        await rm(rejectedRequestPath!, { force: true });
        await rename(requestPath, rejectedRequestPath!);
        if (repairs >= MAX_REQUEST_REPAIRS) {
          const message = `Delegate request remained invalid after ${MAX_REQUEST_REPAIRS} attempts: ${error instanceof Error ? error.message : String(error)}`;
          const failed: AgentJobResult = { status: "failed", artifacts: [], message, protocolIssues: [message] };
          await options.onJobCompleted?.(job, failed);
          return failed;
        }
        basePrompt = promptAsset("common.delegation-repair", {
          issues: error instanceof Error ? error.message : String(error),
          rejected_request_path: rejectedRequestPath,
          request_path: requestPath,
          final_result_path: job.resultPath ?? "由原任务指定",
        });
      }
    }

    if (assistanceRecord?.state === "continuation") {
      if (assistanceRecord.decision === "admitted" && !continuationReservation) {
        await assertBindings(job, assistanceRecord);
        const estimate = assistanceRecord.invocationEstimate!;
        continuationReservation = { reservationId: assistanceRecord.reservationId!, estimatedTokens: estimate.tokens,
          estimatedActiveMs: estimate.activeMs, estimateClass: "assistance" };
        const remaining = assistanceRecord.deadline - Date.now();
        if (remaining <= 0) pauseUncertain("本批协作授权已到期，不能通过恢复延长时间。", "time");
        batchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
      }
      assistanceRecord.state = "continuation_running";
      await writeJsonAtomic(assistancePath!, assistanceRecord);
    }
    const turnControlRoots = controlDir ? assistance ? [requestPath!] : [controlDir] : [];
    const artifactRoots = assistanceRecord?.children.flatMap((entry) => entry.result?.artifacts ?? []) ?? [];
    const readRoots = assistance && controlDir ? await rootsWithoutDenied(job, job.readRoots, controlDir) : job.readRoots;
    const writeRoots = assistance && controlDir ? await rootsWithoutDenied(job, job.writeRoots, controlDir) : job.writeRoots;
    const turnJob: JobSpec = {
      ...job,
      ...(continuationReservation ? { invocationReservation: continuationReservation } : {}),
      readRoots: [...new Set([...readRoots, ...turnControlRoots, ...artifactRoots])],
      writeRoots: [...new Set([...writeRoots, ...turnControlRoots])],
      deniedPaths: job.deniedPaths?.filter((denied) => !controlDir || !inside(controlDir, path.resolve(job.cwd, denied))),
      prompt: canDelegate() && requestPath && (!assistance || !assistanceRecord)
        ? assistance ? promptAsset("common.assistance-capable", { base_prompt: basePrompt, request_path: requestPath,
          final_result_path: job.resultPath ?? "由原任务指定" }) : delegatePrompt(job, basePrompt, requestPath, budget, options)
        : basePrompt,
    };
    const turn = continuationReservation
      ? await withTimeoutEvidence(turnJob, observed => executeTurn(observed, batchSignal))
      : await executeTurn(turnJob, batchSignal);
    if (batchTimedOut && assistanceRecord?.reservationId) {
      await job.executionBudget!.closeReservation(assistanceRecord.reservationId);
      assistanceRecord.state = "finished";
      assistanceRecord.finalResult = turn;
      await writeJsonAtomic(assistancePath!, assistanceRecord);
      await assistanceEvent("settled", turn.message!, assistanceRecord);
      pauseUncertain(turn.message!, "time");
    }
    if (requestPath && existsSync(requestPath)) continue;

    const result = await finalResult(job, turn);
    if ((job.depth ?? 0) > 0 && result.protocolIssues?.length && resultRepairs < MAX_REQUEST_REPAIRS) {
      if (job.executionBudget) await job.executionBudget.claimRepair();
      resultRepairs += 1;
      basePrompt = promptAsset("common.delegation-child-repair", {
        issues: result.protocolIssues.join("；"),
        result_path: job.resultPath ?? "由原任务指定",
        output_workspace: job.writeRoots[0] ?? job.cwd,
      });
      continue;
    }
    if (responsePath) await rm(responsePath, { force: true });
    if (rejectedRequestPath) await rm(rejectedRequestPath, { force: true });
    if (assistanceRecord) {
      if (assistanceRecord.reservationId) await job.executionBudget!.closeReservation(assistanceRecord.reservationId);
      assistanceRecord.state = "finished";
      assistanceRecord.finalResult = result;
      if (job.resultPath && existsSync(job.resultPath)) assistanceRecord.finalResultHash = sha256(await readFile(job.resultPath));
      await writeJsonAtomic(assistancePath!, assistanceRecord);
      await assistanceEvent("settled", "本批协作已结束，建议由原 Agent 合并，结果仍交给冻结评价验证。", assistanceRecord);
    }
    await options.onJobCompleted?.(job, result);
    return result;
  }
}

/** Execute one generic recursively delegated Agent Job without interpreting its business task. */
export async function executeAgentJobTree(
  executeTurn: AgentTurnExecutor,
  job: JobSpec,
  signal?: AbortSignal,
  options: AgentJobTreeOptions = {},
): Promise<AgentJobResult> {
  const resolved = {
    ...options,
    concurrency: Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY),
    maxDepth: Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH),
    maxChildren: Math.max(1, options.maxChildren ?? DEFAULT_MAX_CHILDREN),
  };
  const budget: TreeBudget = { remaining: Math.max(0, (options.maxTotalJobs ?? DEFAULT_MAX_TOTAL_JOBS) - 1) };
  return await executeNode(executeTurn, { ...job, depth: job.depth ?? 0 }, signal, resolved, budget, false);
}
