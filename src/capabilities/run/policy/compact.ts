import { defineExecutionPolicy } from "../../../session/policy.ts";
import { ExecutionBudgetExhausted } from "../../../session/execution-budget.ts";
import { CompactVerificationNeedsInput, runCompactVerification, readVerificationConfig, parseVerificationResult, validateVerificationEvidence, type VerificationResult } from "../../compact-evaluation.ts";
import { COMPACT_ASSISTANCE_REVISION, isCompactAssistanceRevision, compactAssistanceGuidance, requiredVerificationWork } from "../../compact-assistance.ts";
import type { AgentStateManifest, EvolutionRecord } from "../state.ts";
import { versionOf } from "../state.ts";
import { bootstrap, type RunExecutionPolicy, type RunPolicyServices, type RunOperationResult } from "./operations.ts";
import type { RunState, RunCommand } from "../protocol.ts";
import { createRoutedCompactRunPolicy, ROUTED_COMPACT_REVISION } from "./compact-v3.ts";

export type Context = { services: RunPolicyServices; state: RunState; signal: AbortSignal };

async function pauseForInput({ services, state }: Pick<Context, "services" | "state">, message: string) {
  await services.state.emit(state, "operation.activity", { needsInput: true, message });
  return { status: "paused" as const, reason: message };
}

function compact(state: RunState) {
  if (!state.compact) throw new Error("Compact Run state is missing");
  return state.compact;
}

async function assertHashes(services: RunPolicyServices, files: { path: string; sha256: string }[] = []) {
  for (const file of files) if (await services.workspace.sha256(file.path) !== file.sha256) throw new Error(`Verification evidence changed: ${file.path}`);
}

async function evidenceHashes(services: RunPolicyServices, result: VerificationResult, outputDir: string) {
  return await Promise.all(result.evidence.map(async entry => {
    const path = services.workspace.resolve(outputDir, entry);
    return { path, sha256: await services.workspace.sha256(path) };
  }));
}

async function verify({ services, state, signal }: Context, candidate: boolean): Promise<VerificationResult> {
  const data = compact(state);
  const item = candidate ? data.candidate : undefined;
  if (!services.process || !services.project.verificationPath || !services.project.goalPath) throw new Error("Compact verifier services or frozen assets are missing");
  const subjectRoot = item?.worktree ?? services.project.root;
  if (!item) await services.version.assertExact(versionOf(state));
  const outputDir = services.workspace.join(item?.workspace ?? services.project.runDir(versionOf(state)), "verification");
  if (data.baselineResultPath && data.baselineResultSha256
    && await services.workspace.sha256(data.baselineResultPath) !== data.baselineResultSha256) throw new Error("Baseline verification evidence changed");
  await assertHashes(services, data.baselineEvidence);
  const execute = async () => await runCompactVerification({
    projectRoot: services.project.root,
    configPath: services.project.verificationPath!, evaluatorPath: services.project.evaluatorPath,
    taskPath: services.project.taskPath, boundaryPath: services.project.boundaryPath,
    taskingGuidePath: services.project.taskingGuidePath, evaluateGuidePath: services.project.evaluateGuidePath,
    request: { schemaVersion: 1, mode: candidate ? "candidate" : "baseline", subjectRoot,
      artifactPath: services.workspace.join(subjectRoot, services.project.boundary.artifact.path),
      outputDir, goalPath: services.project.goalPath!,
      ...(candidate && data.baselineResultPath ? { baselineResultPath: data.baselineResultPath } : {}),
      ...(services.project.trainsetPath ? { trainPath: services.project.trainsetPath, holdoutPath: services.project.holdoutPath } : {}),
    }, process: services.process!, agent: {
      provider: services.agent.provider, model: services.agent.model,
      execute: async (job, jobSignal) => await services.agent.execute(state, job, jobSignal),
    }, executionBudget: services.executionBudget, signal,
    ...(isCompactAssistanceRevision(state.assistanceRevision) ? {
      requiredReservationId: (item && data.routing?.verificationReservations?.[item.id]) ?? `verification:run:${state.capabilityRunId}:${item?.id ?? versionOf(state)}`,
    } : {}),
    emit: async (type, event) => await services.state.emit(state, "operation.activity", { verificationEvent: type, ...event }),
  });
  const result = await services.guard.project(state, "verify", async () => item
    ? await services.guard.worktree(item.worktree, "verify", execute) : await execute());
  if (result.status !== "completed") throw new Error(`Verification ${result.status}: ${result.summary}`);
  if (item) {
    item.treeHash = await services.version.worktreeTreeHash(item.worktree);
    item.resultPath = services.workspace.join(outputDir, "result.json");
    item.resultSha256 = await services.workspace.sha256(item.resultPath);
    item.evidence = await evidenceHashes(services, result, outputDir);
    item.phase = "verified";
  } else {
    data.baselineResultPath = services.workspace.join(outputDir, "result.json");
    data.baselineResultSha256 = await services.workspace.sha256(data.baselineResultPath);
    data.baselineEvidence = await evidenceHashes(services, result, outputDir);
  }
  await services.state.checkpoint(state);
  return result;
}

export async function baseline(context: Context) {
  const data = compact(context.state);
  const { services } = context;
  const preparedDir = services.workspace.join(services.project.runtimeDir, "preparation-baseline");
  const bindingPath = services.workspace.join(preparedDir, "binding.json");
  if (!data.baselineResultPath && await services.workspace.exists(bindingPath)) {
    const binding = await services.workspace.readJson<{ schemaVersion: number; treeHash: string; resultSha256: string; files: { path: string; sha256: string }[]; evidence?: { path: string; sha256: string }[] }>(bindingPath);
    const preparedResult = services.workspace.join(preparedDir, "result.json");
    const files = data.frozenFiles;
    if (binding.schemaVersion === 1 && binding.treeHash === await services.version.treeHash(versionOf(context.state))
      && Array.isArray(binding.files) && files.every(file => binding.files.some(bound => bound.path === file.path && bound.sha256 === file.sha256))) {
      if (binding.resultSha256 !== await services.workspace.sha256(preparedResult)) throw new Error("Preparation baseline result changed after binding");
      const prepared = parseVerificationResult(await services.workspace.readJson(preparedResult));
      const expectedPaths = prepared.evidence.map(entry => services.workspace.resolve(preparedDir, entry));
      const evidence = binding.evidence;
      const complete = Array.isArray(evidence) && evidence.length === expectedPaths.length
        && expectedPaths.every(file => evidence.filter(bound => bound?.path === file
          && typeof bound.sha256 === "string" && /^[a-f0-9]{64}$/i.test(bound.sha256)).length === 1);
      // Old bindings without a complete evidence identity cannot authorize reuse.
      if (complete) {
        await validateVerificationEvidence(prepared, preparedDir);
        await assertHashes(services, evidence);
        await services.version.assertExact(versionOf(context.state));
        data.baselineResultPath = preparedResult;
        data.baselineResultSha256 = binding.resultSha256;
        data.baselineEvidence = evidence;
        await services.state.checkpoint(context.state);
      }
    }
  }
  let result: VerificationResult;
  if (data.baselineResultPath && data.baselineResultSha256) {
    await context.services.version.assertExact(versionOf(context.state));
    if (await context.services.workspace.sha256(data.baselineResultPath) !== data.baselineResultSha256) throw new Error("Baseline evidence changed");
    result = parseVerificationResult(await context.services.workspace.readJson(data.baselineResultPath));
    await validateVerificationEvidence(result, context.services.workspace.parent(data.baselineResultPath));
    if (!data.baselineEvidence) data.baselineEvidence = await evidenceHashes(services, result, services.workspace.parent(data.baselineResultPath));
    await assertHashes(services, data.baselineEvidence);
  } else {
    try { result = await verify(context, false); }
    catch (error) {
      if (error instanceof CompactVerificationNeedsInput) return await pauseForInput(context, error.message);
      throw error;
    }
  }
  const config = await readVerificationConfig(services.project.verificationPath!);
  if (context.state.assistanceRevision !== ROUTED_COMPACT_REVISION && (result.target === "achieved" || (result.target === "inconclusive" && config.acceptance !== "open"))) {
    return { status: "paused" as const, reason: `Verification target: ${result.target}. ${result.summary}` };
  }
  return { status: "completed" as const };
}

export async function optimize({ services, state, signal }: Context) {
  const data = compact(state);
  if (!data.candidate) {
    if (state.maxIterations !== undefined && data.attempts >= state.maxIterations) throw new ExecutionBudgetExhausted("attempts");
    const id = `attempt-${data.attempts + 1}`;
    await services.executionBudget?.reserveAttempt(id);
    const workspace = services.workspace.join(services.project.runtimeDir, "compact", id);
    data.attempts += 1;
    delete data.retainedOutcome;
    data.candidate = { id, baseVersion: versionOf(state), workspace,
      worktree: services.workspace.join(workspace, "worktree"), phase: "reserved" };
    await services.state.checkpoint(state);
  }
  const item = data.candidate;
  if (item.phase !== "reserved") return { status: "completed" as const };
  await services.version.createWorktree(item.baseVersion, item.worktree);
  const contextPath = services.workspace.join(item.workspace, "context.md");
  const baseline = await services.workspace.readJson<VerificationResult>(data.baselineResultPath!);
  if (await services.workspace.sha256(data.baselineResultPath!) !== data.baselineResultSha256) throw new Error("Baseline evidence changed");
  await assertHashes(services, data.baselineEvidence);
  await services.workspace.writeText(contextPath, [
    "# Frozen goal", await services.workspace.readText(services.project.goalPath!),
    `# Current version\n${item.baseVersion}`,
    `# Public verification feedback\n${baseline.publicFeedback}`,
    `# Prior attempts and public failure feedback\n${JSON.stringify(data.history.slice(-5))}`,
    ...(data.routing?.guidance ? [`# Public component guidance\n${data.routing.guidance}`] : []),
  ].join("\n\n"));
  const contextHash = await services.workspace.sha256(contextPath);
  const assistanceEnabled = isCompactAssistanceRevision(state.assistanceRevision) && !!services.executionBudget;
  const requiredReservationId = data.routing?.verificationReservations?.[item.id] ?? `verification:run:${state.capabilityRunId}:${item.id}`;
  if (assistanceEnabled) {
    const config = await readVerificationConfig(services.project.verificationPath!);
    await services.executionBudget!.reserveRequiredWork(requiredReservationId,
      services.executionBudget!.state.reservations?.[requiredReservationId]?.estimate ?? requiredVerificationWork(config, services.executionBudget!));
  }
  const result = await services.guard.project(state, `optimize:${item.id}`, async () => await services.agent.execute(state, {
    id: `compact-${item.id}${data.routing?.reviewRepairAttempt === item.id ? ":review-repair" : ""}`, operation: "optimize", label: `optimizer:${item.id}`,
    cwd: item.workspace, tools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    readRoots: [item.worktree, contextPath], writeRoots: [item.worktree],
    deniedPaths: [services.workspace.join(item.worktree, ".git"), services.workspace.join(item.worktree, ".flywheel")],
    sessionKey: `compact:${item.id}`,
    delegation: assistanceEnabled ? "enabled" : "disabled",
    ...(assistanceEnabled ? { assistance: { revision: state.assistanceRevision!,
      windowId: `optimize:${state.capabilityRunId}:${item.id}`, requiredReservationId } } : {}),
    prompt: services.prompt("run.compact.optimize", { context_path: contextPath, worktree_path: item.worktree,
      change_scope: services.project.boundary.change_scope, assistance_guidance: compactAssistanceGuidance(assistanceEnabled) }),
  }, signal));
  if (await services.workspace.sha256(contextPath) !== contextHash) throw new Error("Optimizer modified its frozen public context");
  if (result.status === "needs_input") return await pauseForInput({ services, state },
    result.message ?? "Optimization needs clarification of the frozen evaluation; controlled preparation is required.");
  if (result.status !== "completed") throw new Error(result.message ?? "Optimizer did not complete");
  const changes = await services.version.worktreeChanges(item.worktree);
  services.workspace.validateChanges(services.project.boundary.change_scope, changes.files);
  await services.workspace.writeText(services.workspace.join(item.workspace, "diff.patch"), changes.diff);
  item.phase = "optimized";
  await services.state.checkpoint(state);
  return { status: "completed" as const };
}

export async function verifyCandidate(context: Context) {
  const item = compact(context.state).candidate;
  if (!item) throw new Error("No reserved candidate");
  if (item.phase !== "verified") {
    try { await verify(context, true); }
    catch (error) {
      if (error instanceof CompactVerificationNeedsInput) return await pauseForInput(context, error.message);
      throw error;
    }
  }
  return { status: "completed" as const };
}

export async function retain({ services, state }: Context) {
  const data = compact(state);
  const item = data.candidate;
  if (!item && data.retainedOutcome) {
    await services.version.prepare(`v${data.retainedOutcome.iteration}`);
    state.iteration = data.retainedOutcome.iteration;
    return data.retainedOutcome.pauseReason
      ? { status: "paused" as const, reason: data.retainedOutcome.pauseReason } : { status: "completed" as const };
  }
  if (!item?.resultPath || item.phase !== "verified") throw new Error("Candidate has no completed verification");
  if (await services.workspace.sha256(item.resultPath) !== item.resultSha256) throw new Error("Candidate verification evidence changed");
  const result = parseVerificationResult(await services.workspace.readJson(item.resultPath));
  await validateVerificationEvidence(result, services.workspace.parent(item.resultPath));
  await assertHashes(services, item.evidence);
  if (result.status !== "completed") throw new Error("Incomplete verification cannot retain a candidate");
  const changes = await services.version.worktreeChanges(item.worktree);
  services.workspace.validateChanges(services.project.boundary.change_scope, changes.files);
  if (await services.version.worktreeTreeHash(item.worktree) !== item.treeHash) throw new Error("Candidate changed after verification");
  const retained = result.retention === "retain" && (!!changes.diff.trim() || state.promotionTransaction?.candidateId === item.id);
  if (retained) {
    const nextVersion = `v${Number(item.baseVersion.slice(1)) + 1}`;
    state.promotionTransaction ??= { candidateId: item.id, version: nextVersion,
      recordId: services.state.id("evolution"), candidateStateId: services.state.id("state"), createdAt: services.state.now() };
    const transaction = state.promotionTransaction;
    if (transaction.candidateId !== item.id || transaction.version !== nextVersion) throw new Error("Promotion transaction mismatch");
    await services.state.checkpoint(state);
    await services.version.promoteWorktree(item.worktree, nextVersion, `retain ${item.id} as ${nextVersion}`);
    await services.version.prepare(nextVersion);
    const records = services.version.records;
    const base = await records.load<AgentStateManifest>("agent-state", state.agentStateId);
    const baseStateId = base.id === transaction.candidateStateId ? base.parentStateId! : base.id;
    const agentState = await records.write<AgentStateManifest>("agent-state", {
      id: transaction.candidateStateId, parentStateId: baseStateId, evolutionRecordId: transaction.recordId,
      components: [records.snapshotRef(nextVersion, await services.version.treeHash(nextVersion))], createdAt: transaction.createdAt,
    });
    const proposal = await records.fileRef("optimizer-context", nextVersion, services.workspace.join(item.workspace, "context.md"));
    const evidence = await records.fileRef("verification", nextVersion, item.resultPath);
    if (!proposal || !evidence) throw new Error("Promotion evidence is missing");
    await records.write<EvolutionRecord>("evolution", { id: transaction.recordId, baseStateId,
      steeringRevisionId: state.steeringRevisionId, evidence: [evidence], proposal,
      candidateStateId: agentState.id, validationArtifacts: [evidence], decision: "promote", approvalEvidence: [], createdAt: transaction.createdAt });
    await records.activate("agent-state", agentState.id);
    state.agentStateId = agentState.id;
    state.iteration = Number(nextVersion.slice(1));
    data.baselineResultPath = item.resultPath;
    data.baselineResultSha256 = item.resultSha256;
    data.baselineEvidence = item.evidence;
    delete state.promotionTransaction;
  }
  // The verified envelope already bounds publicFeedback to 12,000 characters.
  // Preserve late diagnostics; optimize exposes only the latest five public entries.
  data.history.push({ id: item.id, retained, publicFeedback: result.publicFeedback });
  delete data.candidate;
  const config = await readVerificationConfig(services.project.verificationPath!);
  const pauseReason = state.assistanceRevision !== ROUTED_COMPACT_REVISION && retained && (result.target === "achieved" || (result.target === "inconclusive" && config.acceptance !== "open"))
    ? `Verification target: ${result.target}. ${result.summary}`
    : result.retention === "inconclusive" ? `Retention inconclusive. ${result.summary}` : undefined;
  data.retainedOutcome = { iteration: state.iteration, ...(pauseReason ? { pauseReason } : {}) };
  await services.state.checkpoint(state);
  await services.state.emit(state, "operation.activity", { attempt: item.id, retained,
    ...(state.assistanceRevision === ROUTED_COMPACT_REVISION ? { evaluationTarget: retained ? result.target : undefined }
      : { target: retained ? result.target : undefined }) });
  if (pauseReason) return { status: "paused" as const, reason: pauseReason };
  return { status: "completed" as const };
}

/** Compact operations run under the existing Session scheduler and transaction guards. */
export function createCompactRunExecutionPolicy(assistanceRevision?: string): RunExecutionPolicy {
  if (assistanceRevision === ROUTED_COMPACT_REVISION) return createRoutedCompactRunPolicy();
  return defineExecutionPolicy<RunPolicyServices, RunState, RunCommand, RunOperationResult>({ id: "flywheel.run", revision: assistanceRevision === COMPACT_ASSISTANCE_REVISION ? COMPACT_ASSISTANCE_REVISION : "compact-1",
    requires: ["agent", "workspace", "state", "version", "prompt", "process"],
    operations: { bootstrap, verify: baseline, optimize, verify_candidate: verifyCandidate, retain },
    decide({ lastOutcome }) {
      const next: Record<string, string> = { bootstrap: "verify", verify: "optimize", optimize: "verify_candidate", verify_candidate: "retain", retain: "optimize" };
      if (!lastOutcome) return { type: "run", operationId: "bootstrap" };
      const operationId = next[lastOutcome.operationId];
      return operationId ? { type: "run", operationId } : { type: "blocked", error: `Unknown compact operation: ${lastOutcome.operationId}` };
    },
  });
}
