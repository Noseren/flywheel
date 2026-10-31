import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promptAsset } from "../services/prompt/index.ts";
import { readJobResult } from "../services/agent/job-validation.ts";
import type { JobSpec } from "../services/agent/job-protocol.ts";
import type { AgentJobResult } from "../services/agent/protocol.ts";
import { ExecutionBudgetExhausted, type ExecutionBudget } from "../session/execution-budget.ts";

import { COMPONENT_ROUTING_REVISION } from "./component-routing-revision.ts";
export { COMPONENT_ROUTING_REVISION } from "./component-routing-revision.ts";
export type RoutingWindow = "R1" | "R2" | "R3" | "R4";
export type ComponentId = "requirements" | "evaluation_plan" | "completeness" | "soundness" | "propose" | "review" | "diagnose" | "search" | "select" | "work" | "check" | "steering";
export interface RoutingOptions {
  revision: string;
  window: RoutingWindow;
  windowId: string;
  projectRoot: string;
  outputDir: string;
  /** Policy-selected public text only; never serialize a private evaluator result. */
  publicContext: string;
  /** Explicit individual public files, copied into an isolated read-only snapshot. */
  publicFiles?: string[];
  deniedPaths?: string[];
  allowedComponents?: ComponentId[];
  componentSlots?: Partial<Record<ComponentId, number>>;
  /** Trusted Policy reserves the selected route's full necessary evaluation chain before admission. */
  prepareComponent?: (component: ComponentId) => Promise<string[]>;
  requiredReservationIds: string[];
  budget: ExecutionBudget;
  execute: (job: JobSpec, signal?: AbortSignal) => Promise<AgentJobResult>;
  signal?: AbortSignal;
  emit?: (type: string, data: Record<string, unknown>) => void | Promise<void>;
}
export interface RoutingDecision {
  action: "continue_base" | "request_component" | "ask_user" | "stop_search";
  component?: ComponentId;
  reason: string;
  evidence: string[];
  admitted: boolean;
  denialReason?: string;
  reservationId?: string;
  deadline?: number;
  parentAssistanceRequired?: boolean;
}
export interface AdvisoryResult {
  schemaVersion: 1;
  summary: string;
  evidence: string[];
  decision?: "approve" | "request_changes" | "promote" | "iterate" | "ask_user";
  candidateId?: string;
  hypotheses?: Array<{ id: string; task: string }>;
}
export interface AdvisoryOptions extends RoutingOptions {
  component: ComponentId;
  question?: string;
  /** A trusted Policy may supply an already-admitted optional component chain. */
  invocationReservationId?: string;
}
export class ComponentUnavailable extends Error {
  readonly settled = true;
  readonly component: ComponentId; readonly jobId: string; readonly reservationId: string; readonly reason: string;
  constructor(component: ComponentId, jobId: string, reservationId: string, reason: string) {
    super(`Optional component ${component} unavailable: ${reason}`); this.name = "ComponentUnavailable";
    this.component = component; this.jobId = jobId; this.reservationId = reservationId; this.reason = reason;
  }
}
export interface AdvisoryReport {
  reportPath: string;
  reportText: string;
  result: AdvisoryResult;
  /** Optional parent absorption must share this original slot and deadline. */
  continuationReservation?: JobSpec["invocationReservation"];
  deadline?: number;
}

const CATALOG: Record<RoutingWindow, readonly ComponentId[]> = {
  R1: ["requirements", "evaluation_plan"],
  R2: ["completeness", "soundness", "check"],
  R3: ["propose", "review", "diagnose", "search", "work", "check"],
  R4: ["diagnose", "propose", "review", "check", "steering"],
};
const TASKS: Record<ComponentId, string> = {
  requirements: "把原始公开目标分解为可追溯要求，指出接口、继承行为和组合边界；不得增加用户未要求的约束。",
  evaluation_plan: "依据目标与真实公开API提出可执行评价构建建议，标注现有断言、缺口、oracle公开来源；不写或运行评价器。",
  completeness: "逐项核对目标与实际断言的完整性；用具体遗漏或组合行为反例说明，不能仅凭测试数或文件存在通过。",
  soundness: "核对真实API和oracle，给出满足目标却被断言误拒或不满足目标却被接受的具体反例；区分事实和推测。",
  propose: "聚合公开证据提出最多四个独立可证伪假设，用hypotheses给出安全唯一id和实现任务；不修改实现、不宣告目标完成。",
  review: "独立审查候选是否忠于公开目标与假设、有无回归或越界疑点；decision仅approve或request_changes，列证据，不代替正式评价。",
  diagnose: "定位公开失败的具体原因，区分实现回归、环境故障和评价语义错误；只给可核实诊断，不修改冻结资产。",
  search: "提出有界搜索计划及最多四个独立hypotheses。Runtime才可创建候选、安排必要Review/Verify/Select；你不能自行执行搜索。",
  select: "只比较输入中已完成正式验证的候选，decision仅promote/iterate/ask_user；promote给candidateId，组合建议给hypotheses并必须重新验证。",
  work: "完成所述独立公开问题的定向调查，给父Agent可核查的事实与建议；不修改项目、不运行任意命令。",
  check: "只检查所列一个具体疑点，优先给最小反例与明确来源，区分建议和真实执行证据。",
  steering: "说明冻结目标/评价/范围需要改变的具体公开证据及最小重新准备建议；decision只能ask_user，等待受控批准，不激活revision。",
};
type Snapshot = { binding: string; inputDir: string; contextPath: string; paths: string[]; evidence: string[]; allowed: ComponentId[] };
type Ledger<T> = { schemaVersion: 1; binding: string; phase: "running" | "completed"; result?: T; hashes?: Array<{ path: string; sha256: string }> };
const locks = new Map<string, Promise<unknown>>();
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };
async function atomic(file: string, data: unknown) { const temp = `${file}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2)); await rename(temp, file); }
async function readOptional<T>(file: string): Promise<T | undefined> { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
async function publicResult(file: string, directory: string): Promise<unknown> {
  const physical = await realpath(file), root = await realpath(directory), info = await stat(physical);
  if (!inside(root, physical) || !info.isFile() || info.size > 128_000) throw new Error("Component result escapes its bounded output workspace");
  return JSON.parse(await readFile(physical, "utf8"));
}
async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(action); locks.set(key, pending);
  try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
}
function required(options: RoutingOptions, live = true) {
  if (options.revision !== COMPONENT_ROUTING_REVISION) throw new Error("Component routing requires an explicitly trusted v3 revision");
  if (!options.windowId || !Object.hasOwn(CATALOG, options.window)) throw new Error("Invalid routing window");
  if (live && (!options.requiredReservationIds.length || options.requiredReservationIds.some(id => {
    const item = options.budget.state.reservations?.[id]; return !item || item.kind !== "required" || item.closed;
  }))) throw new Error("Routing requires live reservations for necessary evaluation and target assessment");
}
async function snapshot(options: RoutingOptions, suffix = "router"): Promise<Snapshot> {
  required(options, false);
  if (options.publicContext.length > 64_000 || (options.publicFiles?.length ?? 0) > 1024) throw new Error("Public routing context exceeds bounded input limits");
  const lexicalRoot = path.resolve(options.projectRoot);
  const root = await realpath(lexicalRoot);
  const out = path.resolve(options.outputDir);
  if (!inside(lexicalRoot, out) || out === lexicalRoot) throw new Error("Routing output must be isolated inside the project");
  await mkdir(out, { recursive: true });
  if (!inside(root, await realpath(out))) throw new Error("Routing output escapes the project through a symlink");
  const allowed = [...(options.allowedComponents ?? CATALOG[options.window])];
  if (new Set(allowed).size !== allowed.length || allowed.some(id => !CATALOG[options.window].includes(id))) throw new Error("Component is not allowed at this routing window");
  const denied = await Promise.all((options.deniedPaths ?? []).map(async file => { const abs = path.resolve(lexicalRoot, file); return { abs, physical: await realpath(abs).catch(() => abs) }; }));
  const entries: Array<{ path: string; text: string; sha256: string }> = [];
  let bytes = Buffer.byteLength(options.publicContext);
  for (const file of options.publicFiles ?? []) {
    const abs = path.resolve(lexicalRoot, file), physical = await realpath(abs);
    if (!inside(lexicalRoot, abs) || !inside(root, physical) || inside(await realpath(out), physical)
      || denied.some(d => inside(d.abs, abs) || inside(d.physical, physical)) || !(await stat(physical)).isFile()) throw new Error("Routing input is outside its public file authority");
    const content = await readFile(physical); bytes += content.length;
    if (content.length > 1_048_576 || bytes > 16_777_216) throw new Error("Public routing files exceed bounded input limits");
    entries.push({ path: path.relative(lexicalRoot, abs), text: content.toString("utf8"), sha256: hash(content) });
  }
  const binding = hash(JSON.stringify({ revision: options.revision, window: options.window, windowId: options.windowId,
    context: options.publicContext, files: entries.map(({ path, sha256 }) => ({ path, sha256 })), allowed,
    required: options.requiredReservationIds, componentSlots: options.componentSlots, suffix }));
  const inputDir = path.join(out, `${suffix}-inputs`); await mkdir(inputDir, { recursive: true });
  if (!inside(await realpath(out), await realpath(inputDir))) throw new Error("Routing snapshot directory escapes output authority");
  const contextPath = path.join(inputDir, "context.md");
  const evidence = ["context", ...entries.map((_, index) => `file:${index}`)];
  const texts = [`# Public context\n${options.publicContext}\n\n# Public evidence IDs\n${entries.map((entry, index) => `file:${index}: file-${index}.txt; original=${entry.path}; sha256=${entry.sha256}`).join("\n")}\n`, ...entries.map(entry => entry.text)];
  const paths = [contextPath, ...entries.map((_, index) => path.join(inputDir, `file-${index}.txt`))];
  const recordPath = path.join(inputDir, "binding.json");
  const old = await readOptional<{ binding: string; hashes: string[] }>(recordPath);
  for (const file of paths) if ((await lstat(file).catch(() => undefined))?.isSymbolicLink()) throw new Error("Routing snapshot cannot be a symbolic link");
  if (old) {
    if (old.binding !== binding || old.hashes.length !== paths.length) throw new Error("Routing window evidence binding changed");
    for (let index = 0; index < paths.length; index++) if (hash(await readFile(paths[index])) !== old.hashes[index]) throw new Error("Frozen public routing snapshot changed");
  } else {
    for (let index = 0; index < paths.length; index++) await writeFile(paths[index], texts[index]);
    await atomic(recordPath, { binding, hashes: texts.map(hash) });
  }
  const permittedNames = new Set([...paths.map(file => path.basename(file)), "binding.json"]);
  for (const entry of await readdir(inputDir, { withFileTypes: true })) {
    if (!permittedNames.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error("Unexpected file in isolated public snapshot");
  }
  return { binding, inputDir, contextPath, paths, evidence, allowed };
}
function evidence(value: unknown, snapshot: Snapshot): string[] {
  if (!Array.isArray(value) || value.length > 32 || !value.every(id => typeof id === "string" && snapshot.evidence.includes(id))) throw new Error("Invalid or private routing evidence reference");
  return value as string[];
}
function boundedString(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit; }
export function parseRoutingDecision(value: unknown, allowed: readonly ComponentId[], publicEvidence: string[]): Omit<RoutingDecision, "admitted"> {
  if (!object(value) || Object.keys(value).some(key => !["action", "component", "reason", "evidence"].includes(key))
    || !["continue_base", "request_component", "ask_user", "stop_search"].includes(String(value.action)) || !boundedString(value.reason, 2000)
    || !Array.isArray(value.evidence) || value.evidence.length > 32 || !value.evidence.every(id => typeof id === "string" && publicEvidence.includes(id))) throw new Error("Invalid component routing decision");
  if (value.action === "request_component") {
    if (!allowed.includes(value.component as ComponentId) || value.evidence.length === 0) throw new Error("Unknown or ungrounded component request");
  } else if (value.component !== undefined) throw new Error("Only component requests may name a component");
  return value as unknown as Omit<RoutingDecision, "admitted">;
}
function parseAdvisory(value: unknown, snapshot: Snapshot, component: ComponentId): AdvisoryResult {
  if (!object(value) || Object.keys(value).some(key => !["schemaVersion", "summary", "evidence", "decision", "candidateId", "hypotheses"].includes(key))
    || value.schemaVersion !== 1 || !boundedString(value.summary, 12_000)) throw new Error("Invalid advisory result");
  if (evidence(value.evidence, snapshot).length === 0) throw new Error("Advisory requires public evidence");
  if (value.decision !== undefined && !["approve", "request_changes", "promote", "iterate", "ask_user"].includes(String(value.decision))) throw new Error("Invalid advisory decision");
  if (component === "review" && !["approve", "request_changes"].includes(String(value.decision))) throw new Error("Review must approve or request changes");
  if (component === "select" && !["promote", "iterate", "ask_user"].includes(String(value.decision))) throw new Error("Select has no target authority");
  if (component === "steering" && value.decision !== "ask_user") throw new Error("Steering requires controlled user input");
  if (value.candidateId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(String(value.candidateId))) throw new Error("Invalid candidate identity");
  if (value.hypotheses !== undefined && (!Array.isArray(value.hypotheses) || value.hypotheses.length > 4 || value.hypotheses.some(entry => !object(entry)
    || Object.keys(entry).some(key => !["id", "task"].includes(key)) || !/^[a-zA-Z0-9_-]{1,80}$/.test(String(entry.id)) || !boundedString(entry.task, 4000))
    || new Set(value.hypotheses.map(entry => entry.id)).size !== value.hypotheses.length)) throw new Error("Invalid bounded hypotheses");
  return value as unknown as AdvisoryResult;
}
async function restore<T>(file: string, binding: string): Promise<T | undefined> {
  const ledger = await readOptional<Ledger<T>>(file);
  if (!ledger) return undefined;
  if (ledger.schemaVersion !== 1 || ledger.binding !== binding) throw new Error("Routing ledger binding changed");
  if (ledger.phase === "running") return undefined;
  if (!ledger.result || !ledger.hashes) throw new Error("Invalid routing completion ledger");
  for (const item of ledger.hashes) if (hash(await readFile(item.path)) !== item.sha256) throw new Error("Routing result evidence changed");
  return ledger.result;
}
async function executePublic<T>(options: RoutingOptions, snap: Snapshot, dir: string, jobId: string, reservation: NonNullable<JobSpec["invocationReservation"]>, prompt: JobSpec["prompt"], deadline: number | undefined, reportPath: string, parse: (value: unknown) => T): Promise<T> {
  await mkdir(dir, { recursive: true });
  if (!inside(await realpath(options.outputDir), await realpath(dir))) throw new Error("Routing Job output escapes its private workspace");
  const resultPath = path.join(dir, "job-result.json"), statePath = `${dir}.execution.json`;
  type InvocationState = { before: string[]; deadline?: number; phase: "running" | "returned"; repair: boolean; returnedStatus?: string; aborted?: boolean };
  let state = await readOptional<InvocationState>(statePath);
  if (state) deadline = state.deadline;
  const initial = await Promise.all(snap.paths.map(async file => hash(await readFile(file))));
  const job: JobSpec = { id: jobId, operation: "component_routing", label: jobId, cwd: options.projectRoot,
    tools: ["Read", "Write"], readRoots: [snap.inputDir, dir], writeRoots: [dir], resultPath,
    delegation: "disabled", executionBudget: options.budget, invocationReservation: reservation,
    sessionKey: `routing:${hash(jobId).slice(0, 24)}`, prompt };
  for (;;) {
    if (!state) {
      const remaining = deadline === undefined ? undefined : Math.ceil(deadline - Date.now());
      if (remaining !== undefined && remaining <= 0) throw new Error("Component authorization expired; recovery cannot extend it");
      state = { before: Object.keys(options.budget.state.invocations), deadline, phase: "running", repair: false };
      await atomic(statePath, state);
      const signal = remaining === undefined ? options.signal : options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
      const result = await options.execute(job, signal);
      state.returnedStatus = result.status; state.aborted = signal?.aborted === true;
      state.phase = "returned";
      await atomic(statePath, state);
    }
    const calls = Object.entries(options.budget.state.invocations).filter(([id, value]) => !state!.before.includes(id) && value.reservationId === reservation.reservationId);
    if (!calls.length || calls.some(([, value]) => value.endedAt === undefined || value.tokens === undefined || value.interrupted))
      throw new Error("Routing invocation terminal state is unknown; preserve occupancy and pause without replay");
    const expired = deadline !== undefined && calls.some(([, value]) => value.endedAt! > deadline);
    if (state.phase === "returned" && (state.returnedStatus !== "completed" || state.aborted || expired)) {
      if (reservation.estimateClass === "assistance") throw new ComponentUnavailable(jobId.split(":")[1] as ComponentId, jobId, reservation.reservationId,
        expired || state.aborted ? "authorization deadline or cancellation reached; report not accepted" : `provider returned ${state.returnedStatus}`);
      throw new Error(`Required Router did not complete: ${state.returnedStatus}`);
    }
    if (expired) throw new Error("Component completed after its persisted authorization deadline");
    for (let index = 0; index < snap.paths.length; index++) if (hash(await readFile(snap.paths[index])) !== initial[index]) throw new Error("Agent modified frozen public routing context");
    try {
      const terminal = await readJobResult(job);
      if (terminal.status !== "completed" || !terminal.artifacts.some(file => path.resolve(job.cwd, file) === path.resolve(reportPath))) throw new Error("Completed JobResult must include its actual public report");
      return parse(await publicResult(reportPath, dir));
    } catch (error) {
      if (state.repair) throw error;
      await options.budget.claimRepair();
      // Repair shares this invocation's original authority and global repair allowance.
      job.prompt = promptAsset("common.decision-repair", { decision_path: reportPath, issues: error instanceof Error ? error.message : String(error), base_prompt: prompt });
      const remaining = deadline === undefined ? undefined : Math.ceil(deadline - Date.now());
      if (remaining !== undefined && remaining <= 0) throw new Error("Component authorization expired before repair");
      state = { before: Object.keys(options.budget.state.invocations), deadline, phase: "running", repair: true };
      await atomic(statePath, state);
      const signal = remaining === undefined ? options.signal : options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
      const result = await options.execute(job, signal);
      state.returnedStatus = result.status; state.aborted = signal?.aborted === true;
      state.phase = "returned"; await atomic(statePath, state);
    }
  }
}

export async function runComponentRouting(options: RoutingOptions): Promise<RoutingDecision> {
  return await exclusive(path.resolve(options.outputDir), async () => {
    const snap = await snapshot(options);
    const ledgerPath = path.join(options.outputDir, "routing.json");
    const restored = await restore<RoutingDecision>(ledgerPath, snap.binding);
    if (restored) return restored;
    required(options);
    const reservationId = `router:${hash(options.windowId + snap.binding)}`;
    const estimate = options.budget.estimateInvocation("routing");
    const calls = options.budget.state.repairUsed ? 1 : 2;
    if (!options.budget.state.reservations?.[reservationId]) await options.budget.reserveRequiredWork(reservationId, { ...estimate, tokens: estimate.tokens * calls, activeMs: estimate.activeMs * calls });
    await atomic(ledgerPath, { schemaVersion: 1, binding: snap.binding, phase: "running" });
    const dir = path.join(options.outputDir, "router-output"), decisionPath = path.join(dir, "decision.json");
    await options.emit?.("routing.started", { window: options.window, windowId: options.windowId, binding: snap.binding });
    const parsed = await executePublic(options, snap, dir, `router:${options.window}:${options.windowId}`, { reservationId, estimateClass: "routing" }, promptAsset("routing.router", {
      window: options.window, context_path: snap.contextPath, public_files: { directory: snap.inputDir, mapping: "context -> context.md; file:N -> file-N.txt. Read context.md for original relative paths and SHA-256; select only relevant files." }, evidence_ids: "context and file:N IDs listed in context.md",
      allowed_components: snap.allowed.map(id => ({ id, task: TASKS[id] })), decision_path: decisionPath, result_path: path.join(dir, "job-result.json"),
    }), undefined, decisionPath, value => parseRoutingDecision(value, snap.allowed, snap.evidence));
    await options.budget.closeReservation(reservationId);
    const decision: RoutingDecision = { ...parsed, admitted: false };
    if (parsed.action === "request_component" && ["work", "check"].includes(parsed.component!)) {
      decision.parentAssistanceRequired = true;
      decision.denialReason = "parent-assistance-required";
    } else if (parsed.action === "request_component") {
      const beforeReservations = new Set(Object.keys(options.budget.state.reservations ?? {}));
      let requiredIds: string[] | undefined;
      try { requiredIds = options.prepareComponent ? await options.prepareComponent(parsed.component!) : options.requiredReservationIds; }
      catch (error) {
        if (!(error instanceof ExecutionBudgetExhausted)) throw error;
        // Only release untouched reservations introduced by this optional route's
        // preparation. Existing base verification and final assessment stay protected.
        for (const [id, entry] of Object.entries(options.budget.state.reservations ?? {})) {
          if (!beforeReservations.has(id) && entry.kind === "required" && !entry.closed
            && entry.tokensRemaining === entry.estimate.tokens && entry.activeMsRemaining === entry.estimate.activeMs
            && !Object.values(options.budget.state.invocations).some(call => call.reservationId === id)) await options.budget.closeReservation(id);
        }
        decision.denialReason = "necessary-chain-budget";
      }
      if (requiredIds) {
      if (!requiredIds.length || requiredIds.some(id => { const entry = options.budget.state.reservations?.[id]; return !entry || entry.kind !== "required" || entry.closed; })) throw new Error("Selected component requires live necessary evaluation reservations");
      const slots = options.componentSlots?.[parsed.component!];
      const admission = slots !== undefined ? await options.budget.admitRoutingChain({ revision: COMPONENT_ROUTING_REVISION,
        requestId: `component:${snap.binding}`, windowId: `routing:${options.windowId}`, binding: snap.binding, slots, requiredReservationIds: requiredIds,
      }) : await options.budget.admitAssistance({ requestId: `component:${snap.binding}`, windowId: `routing:${options.windowId}`,
        binding: snap.binding, childCount: 1, requiredReservationId: requiredIds[0], estimateClass: "assistance" });
      decision.admitted = admission.admitted;
      if (admission.reason) decision.denialReason = admission.reason;
      if (admission.admitted) {
        decision.reservationId = admission.reservationId;
        if (slots === undefined) decision.deadline = Date.now() + (admission.authorizedActiveMs ?? admission.estimate!.activeMs);
      }
    }
    }
    await atomic(ledgerPath, { schemaVersion: 1, binding: snap.binding, phase: "completed", result: decision,
      hashes: await Promise.all([decisionPath, path.join(dir, "job-result.json")].map(async file => ({ path: file, sha256: hash(await readFile(file)) }))) });
    await options.emit?.("routing.decided", { window: options.window, windowId: options.windowId, ...decision });
    return decision;
  });
}

export async function runAdvisoryComponent(options: AdvisoryOptions): Promise<AdvisoryReport> {
  return await exclusive(path.resolve(options.outputDir), async () => {
    if (!Object.hasOwn(TASKS, options.component) || (options.question?.length ?? 0) > 4000) throw new Error("Invalid component");
    const snap = await snapshot(options, `component-${options.component}`);
    const binding = hash(snap.binding + JSON.stringify({ component: options.component, question: options.question ?? "", reservation: options.invocationReservationId }));
    const ledgerPath = path.join(options.outputDir, `component-${options.component}.json`);
    const unavailable = await readOptional<{ binding: string; phase: string; component: ComponentId; jobId: string; reservationId: string; reason: string }>(ledgerPath);
    if (unavailable?.phase === "unavailable") {
      if (unavailable.binding !== binding) throw new Error("Unavailable component binding changed");
      await options.budget.closeReservation(unavailable.reservationId);
      throw new ComponentUnavailable(unavailable.component, unavailable.jobId, unavailable.reservationId, unavailable.reason);
    }
    const restored = await restore<AdvisoryReport>(ledgerPath, binding);
    if (restored) return restored;
    required(options);
    let reservationId = options.invocationReservationId, deadline: number | undefined;
    if (reservationId) {
      const reserved = options.budget.state.reservations?.[reservationId];
      if (!reserved || reserved.kind !== "assistance" || !reserved.componentChain || reserved.closed) throw new Error("Optional component chain was not admitted by Policy");
      deadline = Date.now() + reserved.componentChain.perInvocationMs;
    } else {
      const route = await readOptional<Ledger<RoutingDecision>>(path.join(options.outputDir, "routing.json"));
      if (route?.phase !== "completed" || !route.result?.admitted || route.result.component !== options.component) throw new Error("Component has no admitted routing decision");
      const routerSnap = await snapshot(options);
      if (route.binding !== routerSnap.binding) throw new Error("Component routing authorization binding changed");
      reservationId = route.result.reservationId!; deadline = route.result.deadline;
      const reserved = options.budget.state.reservations?.[reservationId];
      if (!reserved || reserved.kind !== "assistance" || reserved.closed) throw new Error("Component reservation is unavailable");
    }
    await atomic(ledgerPath, { schemaVersion: 1, binding, phase: "running" });
    const dir = path.join(options.outputDir, `component-${options.component}-output`), reportPath = path.join(dir, "report.json");
    const invocationReservation = { reservationId, estimateClass: "assistance" };
    await options.emit?.("routing.component.started", { component: options.component, windowId: options.windowId, reservationId });
    let result: AdvisoryResult;
    try { result = await executePublic(options, snap, dir, `component:${options.component}:${options.windowId}`, invocationReservation, promptAsset("routing.component", {
      component: options.component, task: TASKS[options.component], question: options.question ?? "按公开上下文解决已准入疑点。",
      context_path: snap.contextPath, public_files: { directory: snap.inputDir, mapping: "context -> context.md; file:N -> file-N.txt. Read context.md for original relative paths and SHA-256; select only relevant files." }, evidence_ids: "context and file:N IDs listed in context.md",
      report_path: reportPath, result_path: path.join(dir, "job-result.json"),
    }), deadline, reportPath, value => parseAdvisory(value, snap, options.component));
    } catch (error) {
      if (!(error instanceof ComponentUnavailable)) throw error;
      await atomic(ledgerPath, { schemaVersion: 1, binding, phase: "unavailable", component: error.component,
        jobId: error.jobId, reservationId: error.reservationId, reason: error.reason });
      await options.budget.closeReservation(error.reservationId);
      await options.emit?.("routing.component.unavailable", { component: error.component, windowId: options.windowId, reservationId: error.reservationId, reason: error.reason, settled: true });
      throw error;
    }
    const report: AdvisoryReport = { reportPath, reportText: result.summary, result,
      ...(!options.invocationReservationId ? { continuationReservation: invocationReservation, deadline } : {}) };
    await atomic(ledgerPath, { schemaVersion: 1, binding, phase: "completed", result: report,
      hashes: await Promise.all([reportPath, path.join(dir, "job-result.json")].map(async file => ({ path: file, sha256: hash(await readFile(file)) }))) });
    await options.emit?.("routing.component.completed", { component: options.component, windowId: options.windowId, reportPath });
    return report;
  });
}
