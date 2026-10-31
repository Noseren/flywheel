import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { COMPONENT_ROUTING_REVISION } from "../../component-routing-revision.ts";
import { ComponentUnavailable, runAdvisoryComponent, runComponentRouting } from "../../component-routing.ts";
import { requiredVerificationWork } from "../../compact-assistance.ts";
import { readVerificationConfig } from "../../compact-evaluation.ts";
import { ExecutionBudgetExhausted } from "../../../session/execution-budget.ts";
import type { JobSpec } from "../../../services/agent/job-protocol.ts";
import { validateInitContract, type ValidatedInitContract } from "../artifacts.ts";
import { initGoalPath, proposalDocumentPath } from "../proposal.ts";
import type { InitServices, InitState } from "../protocol.ts";

export const FINAL_TARGET_RESERVATION = "target-assess:final";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Explicit public input snapshot: never grant the Router a project/runtime root. */
export async function preparationPublicFiles(projectRoot: string, omitted: Array<{ path: string; reason: string }> = []): Promise<string[]> {
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Hidden control/credential trees, installed dependencies and symlinks are
      // not public project facts. Required goal/proposal files are added explicitly.
      if (entry.name.startsWith(".") || ["node_modules", "dist", "target"].includes(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const bytes = await readFile(file);
        let reason = bytes.length > 1_048_576 ? "exceeds 1 MiB readable-text snapshot limit" : "";
        if (!reason) {
          try { if (new TextDecoder("utf-8", { fatal: true }).decode(bytes).includes("\0")) reason = "binary/NUL content"; }
          catch { reason = "not UTF-8 text"; }
        }
        if (reason) omitted.push({ path: path.relative(projectRoot, file), reason });
        else result.push(file);
      }
    }
  };
  await visit(projectRoot);
  return result.sort();
}

async function inputs(services: InitServices, contract?: ValidatedInitContract) {
  const omitted: Array<{ path: string; reason: string }> = [];
  const publicFiles = [...await preparationPublicFiles(services.projectRoot, omitted),
    initGoalPath(services.projectRoot), proposalDocumentPath(services.projectRoot)];
  const facts = services.workspace.join(services.workspace.flywheelDir, "init", "context_card.md");
  if (await services.workspace.exists(facts)) publicFiles.push(facts);
  if (contract) for (const file of contract.files) {
    // The hidden partition and private judge instructions are never routing input.
    if (["holdout", "evaluate-guide"].includes(file.id)) continue;
    publicFiles.push(services.workspace.resolve(services.projectRoot, file.path));
  }
  const privateFiles = contract?.files.filter(file => ["holdout", "evaluate-guide"].includes(file.id))
    .map(file => services.workspace.resolve(services.projectRoot, file.path)) ?? [];
  const visible = [...new Set(publicFiles)].filter(file => !privateFiles.some(hidden => file === hidden || file.startsWith(hidden + path.sep))).sort();
  return { publicFiles: visible, deniedPaths: privateFiles,
    omissionNotice: omitted.length ? `\nThe snapshot intentionally omits these non-text/oversized files: ${JSON.stringify(omitted)}. Do not infer complete coverage of their contents; report insufficient evidence if they matter.` : "" };
}

async function draftIdentity(services: InitServices, contract: ValidatedInitContract) {
  return digest({ manifest: contract.manifestSha256, files: contract.files,
    goal: await services.workspace.sha256(initGoalPath(services.projectRoot)),
    proposal: await services.workspace.sha256(proposalDocumentPath(services.projectRoot)) });
}

function routingDirectory(services: InitServices, state: InitState, stage: string) {
  return services.workspace.join(services.workspace.runtimeDir, "component-routing", "init", state.capabilityRunId, stage);
}

export async function reservePreparationTarget(services: InitServices): Promise<void> {
  const budget = services.executionBudget!;
  const existing = budget.state.reservations?.[FINAL_TARGET_RESERVATION];
  if (!existing) await budget.reserveRequiredWork(FINAL_TARGET_RESERVATION, budget.estimateInvocation("target-assess"));
  else if (existing.closed) throw new Error("Final target assessment reservation was already consumed during initialization");
}

export async function routeBeforePreparation(services: InitServices, state: InitState, signal: AbortSignal): Promise<string> {
  if (state.assistanceRevision !== COMPONENT_ROUTING_REVISION) return "";
  const budget = services.executionBudget;
  if (!budget) throw new Error("Component routing requires the persisted task budget");
  await reservePreparationTarget(services);
  const reservationId = `preparation-minimum:${state.capabilityRunId}`;
  if (!budget.state.reservations?.[reservationId]) {
    const tasking = budget.estimateInvocation("verification:tasking"), judging = budget.estimateInvocation("verification:judging");
    await budget.reserveRequiredWork(reservationId, { tokens: tasking.tokens + judging.tokens,
      activeMs: 120_000 + tasking.activeMs + judging.activeMs, source: "pre-draft:program120s+possible-tasking+judging" });
  }
  const publicInputs = await inputs(services);
  const options = {
    revision: COMPONENT_ROUTING_REVISION, window: "R1" as const, windowId: `prepare:${state.capabilityRunId}:R1`,
    projectRoot: services.projectRoot, outputDir: routingDirectory(services, state, "R1"),
    publicContext: "The original goal and proposal are approved. Choose the preparation route using public source and assertions. Existing tests are evidence, not proof of the whole goal. Requirements/evaluation plans may clarify the approved goal, never add requirements. No draft is frozen yet." + publicInputs.omissionNotice,
    publicFiles: publicInputs.publicFiles, deniedPaths: publicInputs.deniedPaths, requiredReservationIds: [reservationId, FINAL_TARGET_RESERVATION], budget,
    execute: services.agent.execute.bind(services.agent), signal, emit: services.emit,
  };
  const route = await runComponentRouting(options);
  if (route.action === "ask_user" || route.action === "stop_search") throw services.artifact.jobFailure("init-routing-R1", route.reason, "needs_input");
  if (!route.admitted || !route.component) return "";
  let report;
  try { report = await runAdvisoryComponent({ ...options, component: route.component, question: route.reason }); }
  catch (error) {
    if (!(error instanceof ComponentUnavailable)) throw error;
    await services.emit("init.component.skipped", { window: "R1", component: error.component, reason: error.reason, jobId: error.jobId, settled: true, adopted: false });
    return JSON.stringify({ component: error.component, unavailable: error.reason, adopted: false,
      instruction: "可选组件已结束但未交付完整报告；没有可采纳的报告。继续依据原始目标完成基础准备，不得把组件失败当作验证通过。" });
  }
  // Initial preparation is mandatory independently of this optional report, not
  // an additional parent call. Release its unused optional continuation slot.
  if (report.continuationReservation) await budget.closeReservation(report.continuationReservation.reservationId);
  if (report.result.decision === "ask_user") throw services.artifact.jobFailure("init-routing-R1", report.result.summary, "needs_input");
  return JSON.stringify({ component: route.component, advisoryReport: report.reportText,
    instruction: "核对报告与原始目标，在批准语义内采纳或说明不采纳理由；在最终JobResult记录。报告不是执行或评价结果。" });
}

interface AbsorptionRecord {
  status: "running" | "returned" | "completed" | "skipped";
  unavailable?: { component: string; reason: string; jobId: string; adopted: false };
  before: string;
  after?: string;
  resultSha256?: string;
  reportPath?: string;
  invocationsBefore?: string[];
  reservationId?: string;
  requiredId?: string;
}

/** R2 never freezes a report in place of tests: the parent reconciles the draft,
 * then the caller validates and executes the final package as the actual baseline. */
export async function routePreparedDraft(options: {
  services: InitServices; state: InitState; contract: ValidatedInitContract; job: JobSpec;
  signal: AbortSignal; guard(): Promise<void>;
}): Promise<ValidatedInitContract> {
  const { services, state, job, signal, guard } = options;
  if (state.assistanceRevision !== COMPONENT_ROUTING_REVISION) return options.contract;
  const budget = services.executionBudget!;
  const indexPath = services.workspace.join(routingDirectory(services, state, "R2"), "absorption.json");
  const before = await draftIdentity(services, options.contract);
  const previous = await services.workspace.exists(indexPath) ? await services.workspace.readJson<AbsorptionRecord>(indexPath) : undefined;
  if (previous?.status === "running") throw services.artifact.jobFailure("init-routing-R2", "Preparation component absorption was interrupted; its outcome is unknown. No automatic replay.", "needs_input");
  if (previous?.status === "returned") {
    const calls = Object.entries(budget.state.invocations).filter(([id]) => !previous.invocationsBefore?.includes(id));
    if (!calls.length || calls.some(([, call]) => call.endedAt === undefined || call.tokens === undefined || call.interrupted)
      || previous.after !== before || !previous.resultSha256 || await services.workspace.sha256(job.resultPath!) !== previous.resultSha256) {
      throw services.artifact.jobFailure("init-routing-R2", "Returned preparation absorption lacks matching terminal evidence; preserve the record without replay", "needs_input");
    }
    await guard();
    if (previous.reservationId) await budget.closeReservation(previous.reservationId);
    if (previous.requiredId) await budget.closeReservation(previous.requiredId);
    await services.workspace.writeJson(indexPath, { ...previous, status: "completed" });
    await services.emit("init.component.absorbed", { window: "R2", recovered: true, reportPath: previous.reportPath });
    return options.contract;
  }
  if (previous?.status === "skipped" && previous.after !== before) throw new Error("Skipped component draft binding changed");
  if ((previous?.status === "completed" || previous?.status === "skipped") && previous.after === before) {
    if (previous.resultSha256 && await services.workspace.sha256(job.resultPath!) !== previous.resultSha256) throw new Error("Component preparation result binding changed");
    if (previous.status === "skipped" && previous.requiredId) await budget.closeReservation(previous.requiredId);
    return options.contract;
  }
  await reservePreparationTarget(services);
  await budget.closeReservation(`preparation-minimum:${state.capabilityRunId}`);
  const config = await readVerificationConfig(services.workspace.resolve(services.projectRoot, options.contract.files.find(file => file.id === "verification")!.path));
  const reservationId = `verification:init:${state.capabilityRunId}`;
  // A preparation-owned work/check may have reserved the earlier draft. Its
  // parent has now returned; replace that unexecuted obligation with this exact
  // validated draft's reservation rather than silently rebinding its estimate.
  await budget.closeReservation(reservationId);
  // A repaired draft may need a different estimate; retain prior accounting and
  // use a distinct identity for this exact draft instead of rebinding a reservation.
  const requiredId = `${reservationId}:draft:${before}`;
  await budget.reserveRequiredWork(requiredId, requiredVerificationWork(config, budget));
  const publicInputs = await inputs(services, options.contract);
  const routing = {
    revision: COMPONENT_ROUTING_REVISION, window: "R2" as const, windowId: `prepare:${state.capabilityRunId}:R2:${before}`,
    projectRoot: services.projectRoot, outputDir: routingDirectory(services, state, `R2/${before}`),
    publicContext: "Evaluation draft before freezing. Compare original requirements to actual assertions, including completeness and soundness counterexamples. Test success alone is not proof of the whole goal. Choose one bounded review only when evidence justifies it. Reports cannot modify approved semantics or act as evaluation results." + publicInputs.omissionNotice,
    publicFiles: publicInputs.publicFiles, deniedPaths: publicInputs.deniedPaths, requiredReservationIds: [requiredId, FINAL_TARGET_RESERVATION], budget,
    execute: services.agent.execute.bind(services.agent), signal, emit: services.emit,
  };
  const route = await runComponentRouting(routing);
  if (route.action === "ask_user" || route.action === "stop_search") throw services.artifact.jobFailure("init-routing-R2", route.reason, "needs_input");
  let contract = options.contract;
  if ((route.admitted || route.parentAssistanceRequired) && route.component) {
    const parentCheck = route.parentAssistanceRequired === true;
    let report;
    try {
      report = parentCheck ? { reportPath: "", reportText: route.reason, deadline: undefined, continuationReservation: undefined, result: undefined }
        : await runAdvisoryComponent({ ...routing, component: route.component, question: route.reason });
    } catch (error) {
      if (!(error instanceof ComponentUnavailable)) throw error;
      await guard();
      await services.workspace.writeJson(indexPath, { status: "skipped", before, after: before, requiredId,
        resultSha256: await services.workspace.sha256(job.resultPath!),
        unavailable: { component: error.component, reason: error.reason, jobId: error.jobId, adopted: false } } satisfies AbsorptionRecord);
      await budget.closeReservation(requiredId);
      await services.emit("init.component.skipped", { window: "R2", component: error.component, reason: error.reason, jobId: error.jobId, settled: true, adopted: false });
      return options.contract;
    }
    if (report.result?.decision === "ask_user") {
      if (report.continuationReservation) await budget.closeReservation(report.continuationReservation.reservationId);
      throw services.artifact.jobFailure("init-routing-R2", report.result.summary, "needs_input");
    }
    const absorptionRecord: AbsorptionRecord = { status: "running", before, reportPath: report.reportPath,
      invocationsBefore: Object.keys(budget.state.invocations), reservationId: report.continuationReservation?.reservationId, requiredId };
    await services.workspace.writeJson(indexPath, absorptionRecord);
    if (!parentCheck && (!report.deadline || !report.continuationReservation)) throw new Error("Component absorption requires its original bounded reservation");
    const remaining = report.deadline === undefined ? undefined : report.deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw new ExecutionBudgetExhausted("time");
    const continuationSignal = remaining === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, remaining))]);
    const assistanceEvents: Record<string, unknown>[] = [];
    try {
      const result = await services.agent.execute({ ...job, label: "init:prepare:component-absorption",
        ...(parentCheck ? { id: `init:prepare:R2-check:${before}`, delegation: "enabled" as const,
          assistance: { revision: COMPONENT_ROUTING_REVISION, windowId: `prepare:${state.capabilityRunId}:R2-check:${before}`, requiredReservationId: requiredId },
          onEvent: async (event: Record<string, unknown>) => {
            if (typeof event.sdkEvent === "string" && event.sdkEvent.startsWith("assistance.")) assistanceEvents.push(event);
            await job.onEvent?.(event);
          } } : { delegation: "disabled" as const, assistance: undefined }),
        invocationReservation: report.continuationReservation,
        prompt: services.prompt("init.compact.prepare", {
          project_root: services.projectRoot, goal_path: initGoalPath(services.projectRoot), proposal_path: proposalDocumentPath(services.projectRoot),
          proposal_ref_path: services.workspace.join(services.workspace.flywheelDir, "init", "proposal.json"),
          contract_dir: services.workspace.parent(job.resultPath!), manifest_path: options.contract.manifestPath, result_path: job.resultPath,
          issues: JSON.stringify({ component: route.component, report: report.reportText, instruction: parentCheck
            ? "独立Router选择了此具体check，请按Runtime有界协作协议请求一个真实check Child，仅提供原目标与本问题所需公开断言文件；收到报告后核对并吸收。不得自行模拟Child意见。若准入拒绝，保留拒绝事实并自行处理；合法不确定则needs_input。最终JobResult说明报告、采纳/拒绝理由。"
            : "独立组件仅提供建议。对照原始目标与真实断言核对后，在尚未冻结的草稿中采纳或说明拒绝理由。保持原目标和范围；不得把报告当实际验证。不再委派；在最终JobResult说明处理的具体发现。" }),
          assistance_guidance: parentCheck ? "本轮只执行Router指定的一次check请求，子报告由当前准备会话核对吸收；不得扩大任务。" : "本次是已经准入组件的父会话续接，不再请求协作。",
        }),
      }, continuationSignal);
      if (result.status !== "completed") throw services.artifact.jobFailure("init-component-absorption", result.message ?? "Preparation component was not reconciled", "needs_input");
      const delivered = await services.artifact.readJobResult(job);
      if (delivered.status !== "completed") throw services.artifact.jobFailure("init-component-absorption", delivered.message ?? "No completed reconciled draft was delivered", "needs_input");
      if (parentCheck && !assistanceEvents.some(event => event.sdkEvent === "assistance.settled" || event.sdkEvent === "assistance.denied")) {
        throw services.artifact.jobFailure("init-component-absorption", "Router selected check, but no completed or denied real assistance decision was recorded", "needs_input");
      }
      contract = await validateInitContract(services.projectRoot);
      await services.workspace.writeJson(indexPath, { ...absorptionRecord, status: "returned",
        after: await draftIdentity(services, contract), resultSha256: await services.workspace.sha256(job.resultPath!) } satisfies AbsorptionRecord);
      await services.emit("init.component.absorbed", { window: "R2", component: route.component, reportPath: report.reportPath, message: result.message, assistanceEvents });
    } finally { await guard(); }
    if (report.continuationReservation) await budget.closeReservation(report.continuationReservation.reservationId);
  }
  await services.workspace.writeJson(indexPath, { status: "completed", before, after: await draftIdentity(services, contract),
    resultSha256: await services.workspace.sha256(job.resultPath!) } satisfies AbsorptionRecord);
  await budget.closeReservation(requiredId);
  return contract;
}
