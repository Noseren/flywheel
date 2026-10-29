import { initContractDir, validateInitContract, type ValidatedInitContract } from "../artifacts.ts";
import { initGoalPath, proposalDocumentPath, proposalPath } from "../proposal.ts";
import { CompactVerificationNeedsInput, parseVerificationResult, readVerificationConfig, runCompactVerification, validateVerificationEvidence, type VerificationResult } from "../../compact-evaluation.ts";
import { COMPACT_ASSISTANCE_REVISION, compactAssistanceGuidance, requiredVerificationWork } from "../../compact-assistance.ts";
import { AgentExecutionError } from "../../../services/artifact/index.ts";
import { ExecutionBudgetExhausted } from "../../../session/execution-budget.ts";
import type { InitOperation, InitServices, InitState } from "../protocol.ts";

/** Exact content identity, including wrapper dependencies and optional guides/data. */
export async function compactPreparationInputs(services: InitServices, contract: ValidatedInitContract) {
  const files = contract.files.map(file => ({ path: services.workspace.resolve(services.projectRoot, file.path), sha256: file.sha256 }));
  for (const file of [contract.manifestPath, initGoalPath(services.projectRoot), proposalDocumentPath(services.projectRoot)]) {
    files.push({ path: file, sha256: await services.workspace.sha256(file) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function compactBaselineEvidence(services: InitServices, result: VerificationResult, outputDir: string) {
  await validateVerificationEvidence(result, outputDir);
  return await Promise.all(result.evidence.map(async entry => {
    const file = services.workspace.resolve(outputDir, entry);
    return { path: file, sha256: await services.workspace.sha256(file) };
  }));
}

export async function writeCompactBaselineBinding(services: InitServices, state: InitState): Promise<void> {
  const contract = await validateInitContract(services.projectRoot);
  const files = await compactPreparationInputs(services, contract);
  const resultPath = services.workspace.join(services.workspace.runtimeDir, "preparation-baseline", "result.json");
  if (contract.workflow !== "compact" || JSON.stringify(files) !== state.answers.preparationInputs
    || contract.manifestSha256 !== state.answers.preparationManifestSha256
    || await services.workspace.sha256(resultPath) !== state.answers.preparationBaselineSha256) {
    throw new Error("Compact preparation assets changed before baseline binding");
  }
  const result = parseVerificationResult(await services.workspace.readJson(resultPath));
  if (result.status !== "completed") throw new Error("Only completed baseline evidence can be bound to v1");
  const evidence = await compactBaselineEvidence(services, result, services.workspace.parent(resultPath));
  if (JSON.stringify(evidence) !== state.answers.preparationEvidence) throw new Error("Frozen preparation evidence changed before baseline binding");
  await services.version.assertExact("v1");
  await services.workspace.writeJson(services.workspace.join(services.workspace.parent(resultPath), "binding.json"), {
    schemaVersion: 1, treeHash: await services.version.treeHash("v1"),
    resultSha256: state.answers.preparationBaselineSha256, files, evidence,
  });
}

/** Preparation stays an Init Policy operation; its one session owns any repair. */
export const prepareCompactOperation: InitOperation = async ({ services, state, signal }) => {
  if (state.workflow !== "compact" || state.answers.summaryConfirmed !== true) {
    throw new Error("Compact preparation requires an explicitly confirmed compact proposal");
  }
  const assertApproval = async () => {
    if (await services.workspace.sha256(initGoalPath(services.projectRoot)) !== state.answers.approvedGoalSha256
      || await services.workspace.sha256(proposalDocumentPath(services.projectRoot)) !== state.answers.approvedProposalSha256) {
      throw new Error("Approved goal or evaluation proposal changed during preparation");
    }
  };
  await assertApproval();
  const contractDir = initContractDir(services.projectRoot);
  const resultPath = services.workspace.join(contractDir, "preparation-job-result.json");
  const outputDir = services.workspace.join(services.workspace.runtimeDir, "preparation-baseline");
  const baselineResultPath = services.workspace.join(outputDir, "result.json");
  const preparingDraft = state.inspection.status !== "ready"
    && !await services.workspace.exists(services.workspace.join(services.workspace.flywheelDir, "init", "manifest.json"));
  const assistanceEnabled = state.assistanceRevision === COMPACT_ASSISTANCE_REVISION && !!services.executionBudget;
  const requiredReservationId = `verification:init:${state.capabilityRunId}`;
  const assistance = assistanceEnabled ? {
    revision: COMPACT_ASSISTANCE_REVISION, windowId: `prepare:${state.capabilityRunId}`, requiredReservationId,
    resolveRequiredReservationId: async () => {
      let contract: ValidatedInitContract;
      try { contract = await validateInitContract(services.projectRoot); } catch { return undefined; }
      if (contract.workflow !== "compact" || services.workspace.resolve(services.projectRoot, state.proposal!.artifactPath) !== contract.artifactPath) return undefined;
      await guard();
      const config = await readVerificationConfig(services.workspace.resolve(services.projectRoot, contract.files.find(file => file.id === "verification")!.path));
      await services.executionBudget!.reserveRequiredWork(requiredReservationId, requiredVerificationWork(config, services.executionBudget!));
      return requiredReservationId;
    },
  } : undefined;
  const checkpoint = await services.version.createCheckpoint(`compact-preparation-${state.capabilityRunId}`);
  const guard = async () => {
    await services.version.assertCheckpoint(checkpoint);
    await assertApproval();
  };
  const job = {
    operation: "init.prepare_compact", label: "init:prepare", cwd: services.projectRoot,
    tools: ["Read", "Write", "Bash"], readRoots: [services.projectRoot], writeRoots: [contractDir],
    // Frozen goal/proposal are required read inputs. Their writes are excluded by
    // writeRoots and additionally rejected by assertApproval after every Job.
    deniedPaths: [services.workspace.runtimeDir, ...(assistanceEnabled ? [
      services.workspace.join(services.projectRoot, ".git"),
      services.workspace.join(services.workspace.flywheelDir, "history.git"),
      services.workspace.join(services.workspace.flywheelDir, "version"),
    ] : [])],
    resultPath, sessionKey: "preparation", delegation: assistance ? "enabled" as const : "disabled" as const,
    ...(assistance ? { assistance } : {}),
    prompt: services.prompt("init.compact.prepare", {
      project_root: services.projectRoot, goal_path: initGoalPath(services.projectRoot),
      proposal_path: proposalDocumentPath(services.projectRoot), proposal_ref_path: proposalPath(services.projectRoot),
      contract_dir: contractDir, manifest_path: services.workspace.join(contractDir, "manifest.json"), result_path: resultPath,
      issues: "None. Create the minimal executable preparation package.",
      assistance_guidance: compactAssistanceGuidance(assistanceEnabled),
    }),
  };
  let prepared: { contract: ValidatedInitContract; verification: VerificationResult };
  try { prepared = await services.artifact.run({
    artifactId: "init-compact-preparation", operationId: "prepare_compact", job: "preparation",
    operationState: state.execution.operationState, maxRepairs: 1, signal,
    present: async () => await services.workspace.exists(resultPath),
    classify: (error) => {
      // A mutation of the subject or approved input is a boundary failure, not repairable output.
      if (!preparingDraft || signal.aborted || error instanceof ExecutionBudgetExhausted
        || (error instanceof Error && error.name === "AbortError")
        || error instanceof CompactVerificationNeedsInput
        || (error instanceof Error && /checkpoint|Approved goal|proposal changed|frozen preparation/i.test(error.message))) return undefined;
      // This failure is created only after the draft and actual verification envelope,
      // evidence paths and immutable-input guards have passed. Repair the wrapper in
      // the same preparation session, never a frozen ready evaluator or a semantic gap.
      if (error instanceof AgentExecutionError && error.artifactId === "init-baseline"
        && error.status === "failed" && !state.answers.preparationBaselineSha256) {
        return [{ code: "preparation.baseline.infrastructure", message: error.message.slice(0, 2_000) }];
      }
      return services.artifact.issues(error);
    },
    execute: async ({ mode, issues }) => {
      if (!preparingDraft) throw new Error("Ready evaluator is frozen; preparation cannot generate or repair it");
      try {
        return await services.agent.execute({ ...job,
          label: mode === "generate" ? "init:prepare" : "init:prepare:repair",
          prompt: services.prompt("init.compact.prepare", {
            project_root: services.projectRoot, goal_path: initGoalPath(services.projectRoot),
            proposal_path: proposalDocumentPath(services.projectRoot), proposal_ref_path: proposalPath(services.projectRoot),
            contract_dir: contractDir, manifest_path: services.workspace.join(contractDir, "manifest.json"), result_path: resultPath,
            issues: mode === "generate" ? "None. Prepare the package." : JSON.stringify(issues),
            assistance_guidance: compactAssistanceGuidance(assistanceEnabled),
          }),
        }, signal);
      } finally { await guard(); }
    },
    validate: async () => {
      const execution = await services.artifact.readJobResult(job);
      if (execution.status !== "completed") throw services.artifact.jobFailure("init-preparation", execution.message ?? "Preparation failed",
        execution.status === "needs_input" ? "needs_input" : "failed");
      const contract = await validateInitContract(services.projectRoot);
      if (contract.workflow !== "compact") throw services.artifact.invalid("preparation.workflow", "Preparation requires compact manifest");
      if (services.workspace.resolve(services.projectRoot, state.proposal!.artifactPath) !== contract.artifactPath) {
        throw services.artifact.invalid("preparation.artifact", "Preparation changed the approved artifact path");
      }
      const byId = new Map(contract.files.map(file => [file.id, services.workspace.resolve(services.projectRoot, file.path)]));
      const inputs = JSON.stringify(await compactPreparationInputs(services, contract));
      let verification: VerificationResult;
      if (state.answers.preparationManifestSha256 === contract.manifestSha256
        && state.answers.preparationInputs === inputs
        && typeof state.answers.preparationBaselineSha256 === "string"
        && await services.workspace.exists(baselineResultPath)
        && await services.workspace.sha256(baselineResultPath) === state.answers.preparationBaselineSha256) {
        verification = parseVerificationResult(await services.workspace.readJson(baselineResultPath));
        if (JSON.stringify(await compactBaselineEvidence(services, verification, outputDir)) !== state.answers.preparationEvidence) {
          throw new Error("Frozen preparation evidence changed during recovery");
        }
      } else {
        try {
          verification = await runCompactVerification({
            projectRoot: services.projectRoot,
            configPath: byId.get("verification")!, evaluatorPath: byId.get("evaluator")!,
            taskPath: byId.get("task")!, boundaryPath: byId.get("boundary")!,
            taskingGuidePath: byId.get("tasking-guide"), evaluateGuidePath: byId.get("evaluate-guide"),
            process: services.process, agent: services.agent, executionBudget: services.executionBudget, signal,
            ...(assistanceEnabled ? { requiredReservationId } : {}),
            emit: services.emit,
            request: { schemaVersion: 1, mode: "baseline", subjectRoot: services.projectRoot,
              artifactPath: contract.artifactPath, outputDir, goalPath: initGoalPath(services.projectRoot),
              ...(byId.has("train") ? { trainPath: byId.get("train")!, holdoutPath: byId.get("holdout")! } : {}) },
          });
        } finally {
          await guard();
          const after = await validateInitContract(services.projectRoot);
          if (JSON.stringify(after.files) !== JSON.stringify(contract.files) || after.manifestSha256 !== contract.manifestSha256) {
            throw new Error("Evaluator changed frozen preparation assets");
          }
        }
      }
      if (verification.status !== "completed") {
        throw services.artifact.jobFailure("init-baseline", verification.summary,
          verification.status === "needs_input" ? "needs_input" : "failed");
      }
      // Persist immediately: recovery reuses the validated result without another model call.
      state.answers.preparationManifestSha256 = contract.manifestSha256;
      state.answers.preparationInputs = inputs;
      state.answers.preparationEvidence = JSON.stringify(await compactBaselineEvidence(services, verification, outputDir));
      state.answers.preparationBaselineSha256 = await services.workspace.sha256(baselineResultPath);
      await services.emit("init.preparation.verified", { manifestSha256: contract.manifestSha256,
        baselineResultPath, target: verification.target, retention: verification.retention, summary: verification.publicFeedback });
      return { contract, verification };
    },
  }); } catch (error) {
    if (error instanceof CompactVerificationNeedsInput || (error instanceof AgentExecutionError && error.status === "needs_input")) {
      await services.emit("init.preparation.needs_input", { message: error.message });
      await services.emit("operation.activity", { needsInput: true, message: error.message });
      return { status: "paused", reason: error.message };
    }
    throw error;
  }
  await guard();
  state.answers.contractManifestSha256 = prepared.contract.manifestSha256;
  state.answers.smokeConfirmed = true; // Internal chain verification; user already approved the evaluation proposal.
  await services.workspace.writeJson(services.workspace.join(services.workspace.flywheelDir, "init", "APPROVED.json"), {
    schemaVersion: 1, workflow: "compact", approvedAt: new Date().toISOString(),
    proposalSha256: state.answers.approvedProposalSha256, goalSha256: state.answers.approvedGoalSha256,
    contractManifestSha256: prepared.contract.manifestSha256,
    baselineResultPath, baselineResultSha256: state.answers.preparationBaselineSha256,
  });
  await services.emit("init.contract.approved", { workflow: "compact", baselineResultPath,
    contractManifestSha256: prepared.contract.manifestSha256 });
  return { status: "completed", data: { baselineResultPath, verified: true } };
};
