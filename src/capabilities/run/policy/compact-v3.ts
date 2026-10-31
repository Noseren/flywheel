import { createHash } from "node:crypto";
import path from "node:path";
import { defineExecutionPolicy } from "../../../session/policy.ts";
import { ExecutionBudgetExhausted } from "../../../session/execution-budget.ts";
import { requiredVerificationWork } from "../../compact-assistance.ts";
import { parseVerificationResult, readVerificationConfig, validateVerificationEvidence } from "../../compact-evaluation.ts";
import { versionOf } from "../state.ts";
import type { RunState } from "../protocol.ts";
import { bootstrap, type RunExecutionPolicy } from "./operations.ts";
import { COMPONENT_ROUTING_REVISION } from "../../component-routing-revision.ts";
import { runComponentRouting, runAdvisoryComponent, ComponentUnavailable, type AdvisoryReport, type RoutingOptions, type ComponentId } from "../../component-routing.ts";
import { baseline, optimize, retain, verifyCandidate, type Context } from "./compact.ts";
import { formalSource, publicSource, privateDecision } from "./compact-v3-evidence.ts";
import { targetSummaryText, type TargetUserSummary } from "../target-summary.ts";

export const ROUTED_COMPACT_REVISION = COMPONENT_ROUTING_REVISION;
type Candidate = NonNullable<NonNullable<RunState["compact"]>["candidate"]>;
export interface CompactRunRoutingState {
  next: string;
  guidance?: string;
  reviewRequired?: boolean;
  reviewedTreeHash?: string;
  reviewFeedback?: string;
  reviewReservationId?: string;
  reviewDeadline?: number;
  reviewRepairAttempt?: string;
  assessment?: { binding: string; decision: "achieved" | "not_achieved" | "inconclusive"; resultPath: string; resultSha256: string };
  targetReservationId?: string;
  verificationReservations?: Record<string, string>;
  stopRequested?: boolean;
  negativeRoutedBinding?: string;
  windows?: Record<string, RoutingOptionsSnapshot>;
  appliedWindows?: string[];
  search?: {
    id: string; baseVersion: string; hypotheses: { id: string; task: string }[];
    candidates: Candidate[]; cursor: number; auxiliaryReservationId: string;
    combination?: { sourceIds: string[]; task: string };
    selected?: string;
  };
}
interface RoutingOptionsSnapshot { publicContext: string; publicFiles: string[]; requiredReservationIds: string[]; allowedComponents: ComponentId[]; componentSlots: Partial<Record<ComponentId, number>> }

function privateSourcePaths(context: Context): string[] {
  const project = context.services.project;
  const publicRoles = new Set([project.goalPath, project.taskPath, project.trainsetPath, project.taskingGuidePath]);
  return (project.frozenContractFiles ?? []).filter(file => !publicRoles.has(file))
    .map(file => path.relative(project.root, file));
}

const done = { status: "completed" as const };
function data(context: Context) {
  if (!context.state.compact) throw new Error("Routed compact state is missing");
  context.state.compact.routing ??= { next: "route_r3" };
  return context.state.compact.routing;
}
async function transition(context: Context, next: string) {
  data(context).next = next;
  await context.services.state.checkpoint(context.state);
  return done;
}
async function pause(context: Context, message: string) {
  await context.services.state.emit(context.state, "operation.activity", { needsInput: true, message });
  return { status: "paused" as const, reason: message };
}
async function checkFiles(context: Context, files: { path: string; sha256: string }[]) {
  for (const file of files) if (await context.services.workspace.sha256(file.path) !== file.sha256) throw new Error(`Bound evidence changed: ${file.path}`);
}
async function formal(context: Context) {
  const { services, state } = context, compact = state.compact!;
  await services.version.assertExact(versionOf(state));
  await checkFiles(context, compact.frozenFiles);
  if (!compact.baselineResultPath || !compact.baselineResultSha256) throw new Error("Formal verification is missing");
  await checkFiles(context, [{ path: compact.baselineResultPath, sha256: compact.baselineResultSha256 }, ...(compact.baselineEvidence ?? [])]);
  const result = parseVerificationResult(await services.workspace.readJson(compact.baselineResultPath));
  await validateVerificationEvidence(result, services.workspace.parent(compact.baselineResultPath));
  const treeHash = await services.version.treeHash(versionOf(state));
  const source = await formalSource(context, versionOf(state), treeHash);
  const binding = createHash("sha256").update(JSON.stringify({ revision: ROUTED_COMPACT_REVISION, treeHash,
    frozen: compact.frozenFiles, result: compact.baselineResultSha256, evidence: compact.baselineEvidence, source })).digest("hex");
  return { result, treeHash, binding, source };
}

async function reserveTarget(context: Context) {
  const { services } = context, route = data(context), budget = services.executionBudget;
  if (!budget) throw new Error("Routed compact requires its persistent execution budget");
  const bound = await formal(context);
  const initial = budget.state.reservations?.["target-assess:final"];
  const id = route.targetReservationId && !budget.state.reservations?.[route.targetReservationId]?.closed
    ? route.targetReservationId : initial && !initial.closed ? "target-assess:final" : `target-assess:${bound.binding}:${context.state.compact!.attempts}`;
  await budget.reserveRequiredWork(id, budget.state.reservations?.[id]?.estimate ?? budget.estimateInvocation("target-assess"));
  route.targetReservationId = id;
  await services.state.checkpoint(context.state);
}

async function reserveVerification(context: Context, attempt: number) {
  const { services, state } = context;
  const route = data(context), key = `attempt-${attempt}`, base = `verification:run:${state.capabilityRunId}:${key}`;
  let id = route.verificationReservations?.[key] ?? base;
  if (services.executionBudget!.state.reservations?.[id]?.closed) {
    let generation = 1;
    while (services.executionBudget!.state.reservations?.[`${base}:reservation-${generation}`]) generation++;
    id = `${base}:reservation-${generation}`;
  }
  const config = await readVerificationConfig(services.project.verificationPath!);
  await services.executionBudget!.reserveRequiredWork(id, services.executionBudget!.state.reservations?.[id]?.estimate ?? requiredVerificationWork(config, services.executionBudget!));
  route.verificationReservations ??= {};
  route.verificationReservations[key] = id;
  await services.state.checkpoint(state);
  return id;
}

interface Assessment { schemaVersion: 1; decision: "achieved" | "not_achieved" | "inconclusive"; reason: string; evidence: string[]; userSummary?: TargetUserSummary }
function parseAssessment(value: unknown): Assessment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid target assessment");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["schemaVersion", "decision", "reason", "evidence", "userSummary"].includes(k)) || v.schemaVersion !== 1
    || !["achieved", "not_achieved", "inconclusive"].includes(String(v.decision))
    || typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 4000
    || !Array.isArray(v.evidence) || !v.evidence.length || v.evidence.length > 32 || !v.evidence.every(e => typeof e === "string" && e.length <= 2000)
    || (v.userSummary !== undefined && !targetSummaryText(v.userSummary))) throw new Error("Invalid target assessment protocol");
  return v as unknown as Assessment;
}

async function assess(context: Context) {
  const { services, state, signal } = context, route = data(context), bound = await formal(context);
  if (route.assessment?.binding === bound.binding) {
    await checkFiles(context, [{ path: route.assessment.resultPath, sha256: route.assessment.resultSha256 }]);
  } else {
    await reserveTarget(context);
    const directory = services.workspace.join(services.project.runtimeDir, "components", "target", bound.binding);
    await services.workspace.mkdir(directory);
    const reportPath = services.workspace.join(directory, "assessment.json"), resultPath = services.workspace.join(directory, "job-result.json");
    const reads = [...state.compact!.frozenFiles.map(f => f.path), state.compact!.baselineResultPath!, ...(state.compact!.baselineEvidence ?? []).map(f => f.path), ...bound.source.map(f => f.path)];
    const report = await privateDecision(context, directory, {
      id: `target-assess:${bound.binding}`, operation: "assess_target", label: "independent-target-assess", cwd: services.project.root,
      tools: ["Read", "Write"], readRoots: reads, writeRoots: [reportPath, resultPath], delegation: "disabled",
      sessionKey: `target-assess:${bound.binding}`, resultPath,
      invocationReservation: { reservationId: route.targetReservationId!, estimateClass: "target-assess" },
      prompt: services.prompt("run.routing.target-assess", { goal_path: services.project.goalPath, evidence_paths: reads,
        version: versionOf(state), tree_hash: bound.treeHash, report_path: reportPath, result_path: resultPath, repair: "" }),
    }, reportPath, value => {
      const parsed = parseAssessment(value);
      if (!parsed.evidence.every(e => reads.includes(e.split("#")[0]!))) throw new Error("Target assessment evidence outside authority");
      return parsed;
    });
    if ((await formal(context)).binding !== bound.binding) throw new Error("Formal target inputs changed during assessment");
    await services.executionBudget!.closeReservation(route.targetReservationId!);
    route.assessment = { binding: bound.binding, decision: report.decision, resultPath: reportPath, resultSha256: await services.workspace.sha256(reportPath) };
    await services.state.checkpoint(state);
  }
  const decision = route.assessment.decision;
  // Only the enum crosses into routing/public search context, never this report's reason or evidence.
  await services.state.emit(state, "operation.activity", { independentTarget: decision, version: versionOf(state), binding: bound.binding });
  route.next = "route_r3";
  await services.state.checkpoint(state);
  // This projection is for the user only. Router/optimizer contexts remain explicitly constructed above/below.
  const report = parseAssessment(await services.workspace.readJson(route.assessment.resultPath));
  const userSummary = report.userSummary ?? {
    summary: report.reason.length > 1100 ? `${report.reason.slice(0, 1100)}…（完整理由见报告）` : report.reason,
    unresolved: decision === "achieved" ? [] : ["此旧版报告未单列未决事项，请查看完整判定报告。"],
  };
  const publicDecision = { assessment: decision, reportPath: route.assessment.resultPath, userSummary };
  if (decision === "not_achieved" && route.negativeRoutedBinding !== bound.binding) {
    // A Router stop predates this independent fact; consume it once without exposing private findings.
    route.negativeRoutedBinding = bound.binding;
    route.stopRequested = false;
    const publicQuestion = "The independent target verdict is not_achieved. Independently inspect the original public goal and public implementation for a falsifiable counterexample; no private assessment findings are available.";
    route.guidance = route.guidance ? `${publicQuestion}\n\nEarlier public investigation guidance (verify against the current source):\n${route.guidance}` : publicQuestion;
    await services.state.checkpoint(state);
  }
  if (decision !== "not_achieved" || route.stopRequested) {
    const status = decision === "achieved" ? "目标已达成，等待确认" : decision === "inconclusive" ? "证据不足，已暂停" : "目标尚未达成，已暂停";
    const next = decision === "inconclusive" ? "当前版本和评价记录已保留。继续前需补充证据或明确验收口径；本次暂停不会自动继续调用模型。"
      : decision === "achieved" ? "当前正式版本已保留。可以结束任务，或明确新的改进方向。" : "当前正式版本已保留。可查看报告，再决定是否继续调查。";
    return { ...await pause(context, `${versionOf(state)} · ${status}\n${targetSummaryText(userSummary)}\n${next}`), data: publicDecision };
  }
  return { ...done, data: publicDecision };
}

async function routingOptions(context: Context, window: "R3" | "R4"): Promise<RoutingOptions> {
  const { services, state, signal } = context, route = data(context), bound = await formal(context);
  const currentAssessment = route.assessment?.binding === bound.binding ? route.assessment.decision : undefined;
  const negativeWindow = window === "R3" && currentAssessment === "not_achieved" && route.negativeRoutedBinding === bound.binding;
  const windowId = `${window}:${bound.binding}:${state.compact!.history.at(-1)?.id ?? "initial"}${negativeWindow ? ":negative-target" : ""}`;
  route.windows ??= {};
  if (!route.windows[windowId]) {
    await reserveTarget(context);
    const remaining = Math.min(state.maxIterations ?? Infinity, services.executionBudget!.limit("candidateAttempts")) - state.compact!.attempts;
    const required = [route.targetReservationId!];
    // Search may consume two independent candidates and one combination; all verification is reserved before admission.
    const count = window === "R3" && remaining >= 2 ? Math.min(3, remaining) : Math.min(1, remaining);
    if (count) required.push(await reserveVerification(context, state.compact!.attempts + 1));
    const allowed: ComponentId[] = window === "R3" ? ["propose", "review", "diagnose", "work", "check", ...(count >= 2 ? ["search" as const] : [])] : ["diagnose", "propose", "steering"];
    const publicFiles = await publicSource(services.workspace.join(services.project.runtimeDir, "components", "formal-source", bound.treeHash), privateSourcePaths(context));
    route.windows[windowId] = {
      publicContext: JSON.stringify({ version: versionOf(state), treeHash: bound.treeHash, publicFeedback: bound.result.publicFeedback,
        latestAttempt: state.compact!.history.at(-1), priorAttempts: state.compact!.history.slice(-5).map(({ id, retained }) => ({ id, retained })),
        sourceOmissions: publicFiles.omissions, independentTarget: currentAssessment,
        remainingCandidates: Number.isFinite(remaining) ? remaining : "unbounded" }),
      publicFiles: [services.project.goalPath!, services.project.taskPath, ...publicFiles.files],
      requiredReservationIds: required, allowedComponents: allowed,
      componentSlots: { propose: 1, diagnose: 1, review: 2, steering: 1, search: count === 3 ? 7 : 5 },
    };
    await services.state.checkpoint(state);
  }
  return { ...route.windows[windowId]!, revision: ROUTED_COMPACT_REVISION, window, windowId,
    projectRoot: services.project.root, outputDir: services.workspace.join(services.project.runtimeDir, "components", "windows", windowId.replaceAll(":", "-")),
    prepareComponent: async component => {
      const ids = [...route.windows![windowId]!.requiredReservationIds];
      if (component === "search") {
        const count = Math.min(3, Math.min(state.maxIterations ?? Infinity, services.executionBudget!.limit("candidateAttempts")) - state.compact!.attempts);
        for (let index = 2; index <= count; index++) ids.push(await reserveVerification(context, state.compact!.attempts + index));
      }
      return ids;
    },
    budget: services.executionBudget!, execute: async (job, jobSignal) => await services.guard.project(state, job.label, async () => await services.agent.execute(state, job, jobSignal)), signal,
    emit: async (type, event) => await services.state.emit(state, "operation.activity", { routingEvent: type, ...event }) };
}

async function routeWindow(context: Context, window: "R3" | "R4") {
  if (window === "R3" && context.state.compact!.attempts >= Math.min(context.state.maxIterations ?? Infinity, context.services.executionBudget!.limit("candidateAttempts"))) throw new ExecutionBudgetExhausted("attempts");
  const route = data(context), options = await routingOptions(context, window), decision = await runComponentRouting(options);
  const baseNext = window === "R4" ? "assess_target" : "optimize";
  if (route.appliedWindows?.includes(options.windowId)) return await transition(context, baseNext);
  if (decision.action === "ask_user") return await pause(context, decision.reason);
  if (decision.action === "stop_search") { route.stopRequested = true; return await transition(context, "assess_target"); }
  const fallbackQuestion = () => `Optional ${decision.component} did not provide an accepted report. Independently inspect this public Router question; it is not a verified finding or review approval: ${decision.reason}`;
  if (!decision.admitted && decision.action === "request_component" && ["diagnose", "propose"].includes(decision.component ?? "")) {
    route.guidance = fallbackQuestion();
  }
  if (decision.parentAssistanceRequired) route.guidance = `Consider native ${decision.component} assistance for this public question: ${decision.reason}. Request it only through the existing assistance protocol and honor denial.`;
  if (decision.admitted && decision.component) {
    if (decision.component === "review") {
      route.reviewRequired = true; route.reviewReservationId = decision.reservationId;
    } else {
      let report: AdvisoryReport;
      try {
        report = await runAdvisoryComponent({ ...options, component: decision.component, question: decision.reason, invocationReservationId: decision.reservationId });
      } catch (error) {
        if (!(error instanceof ComponentUnavailable)) throw error;
        // A settled optional suggestion is unavailable, not an implicit approval or a new window.
        if (["diagnose", "propose"].includes(decision.component)) route.guidance = fallbackQuestion();
        route.appliedWindows ??= [];
        if (!route.appliedWindows.includes(options.windowId)) route.appliedWindows.push(options.windowId);
        await context.services.state.emit(context.state, "operation.activity", { componentUnavailable: decision.component, reason: error.reason, fallback: baseNext });
        return await transition(context, baseNext);
      }
      if (report.result.decision === "ask_user") {
        await options.budget.closeReservation(decision.reservationId!);
        return await pause(context, report.result.summary);
      }
      if (decision.component === "steering") {
        await options.budget.closeReservation(decision.reservationId!);
        return await pause(context, `Controlled steering requires re-preparation: ${report.result.summary}`);
      }
      if (decision.component === "search") {
        const hypotheses = report.result.hypotheses?.slice(0, 2);
        if (!hypotheses || hypotheses.length < 2) throw new Error("Admitted search requires two independent public hypotheses");
        route.search = { id: options.windowId, baseVersion: versionOf(context.state), hypotheses, candidates: [], cursor: 0, auxiliaryReservationId: decision.reservationId! };
        route.guidance = hypotheses[0]!.task; route.reviewRequired = true;
      } else {
        route.guidance = report.result.hypotheses?.[0]?.task ?? report.result.summary;
        await options.budget.closeReservation(decision.reservationId!);
      }
    }
  }
  route.appliedWindows ??= [];
  route.appliedWindows.push(options.windowId);
  return await transition(context, baseNext);
}

async function reviewCandidate(context: Context) {
  const route = data(context), item = context.state.compact!.candidate!;
  if (!route.reviewRequired) return await transition(context, "verify_candidate");
  const treeHash = await context.services.version.worktreeTreeHash(item.worktree);
  if (route.reviewedTreeHash === treeHash) return await transition(context, "verify_candidate");
  const options = await routingOptions(context, "R3");
  const reservationId = route.search?.auxiliaryReservationId ?? route.reviewReservationId;
  if (!reservationId) throw new Error("Review lacks admitted optional budget");
  const publicFiles = await publicSource(item.worktree, privateSourcePaths(context));
  let report: AdvisoryReport;
  try {
    report = await runAdvisoryComponent({ ...options, outputDir: context.services.workspace.join(item.workspace, "review", treeHash),
    requiredReservationIds: [route.targetReservationId!, await reserveVerification(context, Number(item.id.replace("attempt-", "")))],
    windowId: `review:${item.id}:${treeHash}`, component: "review", invocationReservationId: reservationId,
    publicContext: JSON.stringify({ hypothesis: route.guidance, baseVersion: item.baseVersion, candidateId: item.id, sourceOmissions: publicFiles.omissions }),
      publicFiles: [context.services.project.goalPath!, context.services.workspace.join(item.workspace, "diff.patch"), ...publicFiles.files] });
  } catch (error) {
    if (!(error instanceof ComponentUnavailable)) throw error;
    return await pause(context, `Required candidate review is unavailable: ${error.reason}. Candidate is preserved without verification or promotion.`);
  }
  if (report.result.decision !== "approve") {
    route.reviewFeedback = report.result.summary;
    if (route.reviewRepairAttempt === item.id) return await pause(context, `Candidate review still requests changes: ${report.result.summary}`);
    await context.services.executionBudget!.claimRepair();
    route.reviewRepairAttempt = item.id;
    route.guidance = `${route.guidance ?? ""}\nPublic candidate review: ${report.result.summary}`;
    item.phase = "reserved";
    return await transition(context, "optimize");
  }
  if (await context.services.version.worktreeTreeHash(item.worktree) !== treeHash) throw new Error("Candidate changed during review");
  route.reviewedTreeHash = treeHash;
  if (!route.search) { await options.budget.closeReservation(reservationId); route.reviewRequired = false; }
  return await transition(context, "verify_candidate");
}

async function verifiedCandidate(context: Context) {
  const outcome = await verifyCandidate(context);
  if (outcome.status !== "completed") return outcome;
  const route = data(context), compact = context.state.compact!;
  if (!route.search) return await transition(context, "retain");
  const search = route.search, item = compact.candidate!;
  if (!search.candidates.some(candidate => candidate.id === item.id)) search.candidates.push({ ...item });
  delete compact.candidate; delete route.reviewedTreeHash;
  search.cursor = search.candidates.length;
  const hypothesis = search.hypotheses[search.cursor];
  if (hypothesis) { route.guidance = hypothesis.task; return await transition(context, "optimize"); }
  return await transition(context, "select_candidates");
}

interface Selection { schemaVersion: 1; decision: "promote" | "iterate" | "ask_user" | "combine"; candidateId?: string; sourceIds?: string[] }
function parseSelection(value: unknown, candidates: Candidate[]): Selection {
  const v = value as Selection;
  if (!v || v.schemaVersion !== 1 || !["promote", "iterate", "ask_user", "combine"].includes(v.decision)
    || Object.keys(v).some(key => !["schemaVersion", "decision", "candidateId", "sourceIds"].includes(key))) throw new Error("Invalid private Select protocol");
  if (v.decision === "promote" && !candidates.some(c => c.id === v.candidateId)) throw new Error("Select named an unknown candidate");
  if (v.decision === "combine" && (!Array.isArray(v.sourceIds) || v.sourceIds.length !== 2 || new Set(v.sourceIds).size !== 2 || v.sourceIds.some(id => !candidates.some(c => c.id === id)))) throw new Error("Invalid combination sources");
  return v;
}

async function selectCandidates(context: Context) {
  const { services, state, signal } = context, route = data(context), search = route.search!;
  if (!search || versionOf(state) !== search.baseVersion) throw new Error("Search base changed");
  const reads = [services.project.goalPath!];
  for (const candidate of search.candidates) {
    if (!candidate.resultPath || !candidate.resultSha256 || !candidate.treeHash) throw new Error("Unverified search candidate");
    await checkFiles(context, [{ path: candidate.resultPath, sha256: candidate.resultSha256 }, ...(candidate.evidence ?? [])]);
    if (await services.version.worktreeTreeHash(candidate.worktree) !== candidate.treeHash) throw new Error("Search candidate tree changed");
    reads.push(candidate.resultPath, ...(candidate.evidence ?? []).map(f => f.path), services.workspace.join(candidate.workspace, "diff.patch"));
  }
  const binding = createHash("sha256").update(JSON.stringify({ revision: ROUTED_COMPACT_REVISION, base: await formal(context), candidates: search.candidates.map(c => [c.id, c.treeHash, c.resultSha256, c.evidence]) })).digest("hex");
  const directory = services.workspace.join(services.project.runtimeDir, "components", "select", binding);
  await services.workspace.mkdir(directory);
  const reportPath = services.workspace.join(directory, "selection.json"), resultPath = services.workspace.join(directory, "job-result.json");
  const selection = await privateDecision(context, directory, {
    id: `select:${binding}`, operation: "select_candidates", label: "private-select", cwd: services.project.root, tools: ["Read", "Write"],
    readRoots: reads, writeRoots: [reportPath, resultPath], delegation: "disabled", sessionKey: `select:${binding}`, resultPath,
    invocationReservation: { reservationId: search.auxiliaryReservationId, estimateClass: "assistance" },
    prompt: services.prompt("run.routing.select", { candidates: search.candidates.map(c => ({ id: c.id, resultPath: c.resultPath, evidence: c.evidence, diff: services.workspace.join(c.workspace, "diff.patch") })),
      goal_path: services.project.goalPath, report_path: reportPath, result_path: resultPath,
      combination_allowed: !search.combination && state.compact!.attempts < Math.min(state.maxIterations ?? Infinity, services.executionBudget!.limit("candidateAttempts")) }),
  }, reportPath, value => parseSelection(value, search.candidates), 120_000);
  if (selection.decision === "ask_user") return await pause(context, "Candidate selection requires user clarification.");
  if (selection.decision === "combine") {
    if (search.combination || state.compact!.attempts >= Math.min(state.maxIterations ?? Infinity, services.executionBudget!.limit("candidateAttempts"))) throw new Error("Combination exceeds reserved search route");
    // Private Select may choose identities, but cannot leak private feedback into a new implementation task.
    const tasks = selection.sourceIds!.map(id => search.hypotheses[search.candidates.findIndex(c => c.id === id)]!.task);
    search.combination = { sourceIds: selection.sourceIds!, task: tasks.join("\n\n") };
    search.hypotheses.push({ id: "combined", task: search.combination.task });
    route.guidance = search.combination.task; route.reviewRequired = true;
    return await transition(context, "optimize");
  }
  for (const item of search.candidates.filter(c => c.id !== selection.candidateId)) {
    const result = parseVerificationResult(await services.workspace.readJson(item.resultPath!));
    if (!state.compact!.history.some(entry => entry.id === item.id)) state.compact!.history.push({ id: item.id, retained: false, publicFeedback: result.publicFeedback });
  }
  if (selection.decision === "promote") {
    const selected = search.candidates.find(c => c.id === selection.candidateId)!;
    if (parseVerificationResult(await services.workspace.readJson(selected.resultPath!)).retention !== "retain") throw new Error("Select cannot promote rejected evaluation");
    state.compact!.candidate = selected;
  }
  await services.executionBudget!.closeReservation(search.auxiliaryReservationId);
  delete route.search; route.reviewRequired = false;
  return await transition(context, selection.decision === "promote" ? "retain" : "route_r4");
}


export function createRoutedCompactRunPolicy(): RunExecutionPolicy {
  return defineExecutionPolicy({ id: "flywheel.run", revision: ROUTED_COMPACT_REVISION,
    requires: ["agent", "workspace", "state", "version", "prompt", "process"],
    operations: { bootstrap, verify: async context => {
      const outcome = await baseline(context);
      if (outcome.status !== "completed") return outcome;
      await reserveTarget(context);
      const bound = await formal(context);
      return await transition(context, bound.result.target === "achieved" ? "assess_target" : "route_r3");
    }, assess_target: assess,
    route_r3: async context => await routeWindow(context, "R3"),
    route_r4: async context => await routeWindow(context, "R4"),
    optimize: async context => {
      const outcome = await optimize(context);
      return outcome.status === "completed" ? await transition(context, "review_candidate") : outcome;
    }, review_candidate: reviewCandidate, verify_candidate: verifiedCandidate, select_candidates: selectCandidates,
    retain: async context => {
      const outcome = await retain(context);
      if (outcome.status !== "completed") return outcome;
      await reserveTarget(context);
      return await transition(context, "route_r4");
    } },
    decide({ state, lastOutcome }) {
      if (!lastOutcome) return { type: "run", operationId: "bootstrap" };
      if (lastOutcome.operationId === "bootstrap") return { type: "run", operationId: "verify" };
      return { type: "run", operationId: state.compact?.routing?.next ?? "route_r3" };
    },
  });
}
