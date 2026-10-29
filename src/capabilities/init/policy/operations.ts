import type { Interaction } from "../../../session/protocol.ts";
import type { JobSpec } from "../../../services/agent/job-protocol.ts";
import type { PromptRequest } from "../../../services/prompt/index.ts";
import { AgentExecutionError } from "../../../services/artifact/index.ts";
import {
  initContractDir,
  validateInitContract,
  validateInitContractSpec,
  validateInitContractSpecFiles,
  type ValidatedInitContract,
  type ValidatedInitContractSpec,
  writeInitManifest,
} from "../artifacts.ts";
import { inspectInit } from "../inspector.ts";
import type {
  InitCommand,
  InitOperation,
  InitOperationResult,
  InitServices,
  InitState,
} from "../protocol.ts";
import {
  initGoalPath,
  loadProposal,
  proposalDocumentPath,
  proposalPath,
  proposalSchemaPrompt,
  proposalSummary,
  revisionPrompt,
  ensureInitGoal,
  type InitProposal,
} from "../proposal.ts";
import { InitIntakeStore, originalGoalFromDraft } from "../intake.ts";
import { explorationSourceFingerprint } from "../exploration-cache.ts";
import { compactPreparationInputs, writeCompactBaselineBinding } from "./compact.ts";
const MAX_EVALUATOR_SMOKE_REPAIRS = 3;
const MAX_EVALUATOR_REVIEW_REPAIRS = 3;

interface EvaluatorReviewCheck {
  requirementId: string;
  locator: string;
  status: "valid" | "invalid";
  completeness?: "valid" | "invalid";
  soundness?: "valid" | "invalid";
  reason: string;
}

interface EvaluatorReview {
  schemaVersion: 1 | 2;
  verdict: "accepted" | "repair";
  checks: EvaluatorReviewCheck[];
}

interface InitConversationDecision {
  action: "confirm" | "revise" | "answer" | "reject" | "retry";
  message?: string;
}

function parseConversationDecision(value: unknown): InitConversationDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Init conversation decision must be an object");
  }
  const decision = value as Record<string, unknown>;
  if (!["confirm", "revise", "answer", "reject", "retry"].includes(String(decision.action))) {
    throw new Error("Init conversation returned an unsupported action");
  }
  if (decision.message !== undefined && typeof decision.message !== "string") {
    throw new Error("Init conversation message must be text");
  }
  return {
    action: decision.action as InitConversationDecision["action"],
    ...(typeof decision.message === "string" ? { message: decision.message } : {}),
  };
}

async function runInitConversation(options: {
  services: InitServices;
  sessionKey: string;
  label: string;
  prompt: PromptRequest;
  writeRoots?: string[];
  allowRetry?: boolean;
  signal?: AbortSignal;
}): Promise<{ decision: InitConversationDecision }> {
  const turnsDir = options.services.workspace.join(
    options.services.workspace.flywheelDir,
    "init",
    "conversation",
  );
  return await options.services.decide({
    directory: turnsDir,
    parse: (value) => {
      const decision = parseConversationDecision(value);
      if (decision.action === "retry" && !options.allowRetry) throw new Error("Retry is not allowed at this confirmation point");
      return decision;
    },
    signal: options.signal,
    job: (decisionPath) => ({
      operation: "init",
      label: options.label,
      audience: "user",
      cwd: options.services.projectRoot,
      tools: ["Read", "Write"],
      readRoots: [options.services.projectRoot],
      writeRoots: [turnsDir, ...(options.writeRoots ?? [])],
      sessionKey: options.sessionKey,
      prompt: options.services.prompt("common.conversation-decision", {
        conversation_prompt: options.prompt,
        decision_path: decisionPath,
      }),
    }),
  });
}

function confirmed(value: string | boolean): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return /^(确认|同意|可以|继续|通过|confirm|yes|y)$/i.test(value.trim());
}

function choice(value: string | boolean): string {
  return typeof value === "string" ? value.trim() : value ? "confirm" : "reject";
}

function managerInteraction(options: {
  id: string;
  operationId: string;
  question: string;
  description?: string;
  options?: Interaction["options"];
}): Interaction {
  return {
    id: options.id,
    capabilityId: "init",
    operationId: options.operationId,
    requestedBy: { type: "agent", label: "初始化管理 Agent", sessionKey: "manager" },
    conversationWith: { label: "初始化管理 Agent", sessionKey: "manager" },
    kind: options.options ? "select" : "text",
    question: options.question,
    ...(options.description ? { description: options.description } : {}),
    ...(options.options ? { options: options.options } : {}),
  };
}

export const inspectOperation: InitOperation = async ({ services, state }): Promise<InitOperationResult> => {
  state.inspection = await inspectInit(services.projectRoot, services.process);
  await services.emit("init.inspected", {
    status: state.inspection.status,
    checks: state.inspection.checks,
    problems: state.inspection.problems,
  });
  return { status: "completed", data: { inspectionStatus: state.inspection.status } };
};

export const exploreOperation: InitOperation = async ({ services, state, signal }): Promise<InitOperationResult> => {
      const contextPath = services.workspace.join(services.workspace.flywheelDir, "init", "context_card.md");
      const fingerprint = state.confirmationMode === "brief" ? await explorationSourceFingerprint(services.projectRoot) : undefined;
      const cachePath = services.workspace.join(services.workspace.parent(contextPath), "context-source.json");
      const cached = await services.workspace.exists(cachePath)
        ? await services.workspace.readText(cachePath).then(text => JSON.parse(text) as {
          sourceFingerprint?: string; contextSha256?: string;
        }).catch(() => undefined) : undefined;
      const reusable = state.confirmationMode !== "brief" || (!!fingerprint && cached?.sourceFingerprint === fingerprint
        && await services.workspace.exists(contextPath) && cached.contextSha256 === await services.workspace.sha256(contextPath));
      await services.workspace.ensureDir(services.workspace.parent(contextPath));
      await services.artifact.run({
        artifactId: "init-context-card",
        operationId: "explore",
        job: "project exploration",
        operationState: state.execution.operationState,
        signal,
        present: async () => reusable && await services.workspace.exists(contextPath),
        validate: async () => {
          const text = await services.workspace.readText(contextPath);
          if (!text.trim()) throw services.artifact.invalid("context.empty", "Context card is empty");
          if (state.workflow === "compact" && text.length > 2000) {
            throw services.artifact.invalid("context.too_long", "Compact project facts must fit within 2000 characters; keep only paths, the existing check command, dependencies, and material uncertainty");
          }
          return text;
        },
        classify: services.artifact.issues,
        execute: async ({ mode, issues }) => await services.agent.execute({
          operation: "init.explore",
          label: mode === "generate" ? "init:explore" : "init:explore:repair",
          cwd: services.projectRoot,
          tools: ["Read", "Write"],
          readRoots: [services.projectRoot],
          writeRoots: [services.workspace.parent(contextPath)],
          deniedPaths: [services.workspace.runtimeDir],
          sessionKey: "explorer",
          prompt: services.prompt(state.workflow === "compact" ? "init.compact.explore" : mode === "generate" ? "init.explore.generate" : "init.explore.repair", {
            project_root: services.projectRoot,
            context_card_path: contextPath,
            user_goal: state.confirmationMode === "brief" ? "只记录项目事实；目标由独立对话接收，探索结果不依赖目标。"
              : String(state.answers.initialGoal ?? "用户尚未提供初始目标，请仅记录项目证据，不要替用户发明目标。"),
            issues,
          }),
        }, signal),
      });
      if (state.confirmationMode === "brief") {
        // Detect source mutation during exploration instead of certifying stale facts.
        const after = await explorationSourceFingerprint(services.projectRoot);
        if (fingerprint !== after) throw new Error("Project changed during exploration; retry to refresh project facts");
        await services.workspace.writeText(cachePath, JSON.stringify({ schemaVersion: 1,
          sourceFingerprint: fingerprint, contextSha256: await services.workspace.sha256(contextPath) }));
      }
      state.answers.contextCardPath = contextPath;
  return { status: "completed", data: { contextCardPath: contextPath } };
};

export const awaitGoalOperation: InitOperation = async ({ services, state }): Promise<InitOperationResult> => {
  const intake = new InitIntakeStore(services.projectRoot);
  return await intake.exclusive(async () => {
  const draft = await intake.load();
  const goal = typeof state.answers.initialGoal === "string" ? state.answers.initialGoal : originalGoalFromDraft(draft);
  if (!goal) return { status: "waiting_for_user", interaction: managerInteraction({
    id: "init.goal", operationId: "await_goal", question: "你希望这个项目达到什么目标？",
    description: "项目已经在后台探索。直接说出你希望改善的结果即可。",
  }) };
  const cachePath = services.workspace.join(services.workspace.flywheelDir, "init", "context-source.json");
  if (await services.workspace.exists(cachePath)) {
    const cache = JSON.parse(await services.workspace.readText(cachePath)) as { sourceFingerprint?: string };
    if (cache.sourceFingerprint && cache.sourceFingerprint !== await explorationSourceFingerprint(services.projectRoot)) {
      return { status: "completed", data: { refreshContext: true } };
    }
  }
  await ensureInitGoal(services.projectRoot, goal, true);
  draft.sealed = true;
  await intake.save(draft);
  state.answers.initialGoal = goal;
  if (draft.agentSessions.manager) (state.agentSessions ??= {}).manager = draft.agentSessions.manager;
  state.answers.goalDraftRevision = String(draft.revision);
  return { status: "completed" };
  });
};

export const proposalOperation: InitOperation = async ({ services, state, signal }): Promise<InitOperationResult> => {
      const contextPath = String(state.answers.contextCardPath ?? services.workspace.join(
        services.workspace.flywheelDir, "init", "context_card.md",
      ));
      const refPath = proposalPath(services.projectRoot);
      const documentPath = proposalDocumentPath(services.projectRoot);
      await services.workspace.ensureDir(services.workspace.parent(refPath));
      const proposal = await services.artifact.run({
        artifactId: "init-proposal",
        operationId: "prepare_recommendation",
        job: "initialization proposal",
        operationState: state.execution.operationState,
        signal,
        present: async () => await services.workspace.exists(refPath) && await services.workspace.exists(documentPath),
        validate: async () => {
          const proposal = await loadProposal(services.projectRoot);
          if (state.confirmationMode === "brief" && !proposal.userFacingSummary) {
            throw services.artifact.invalid("proposal.summary_missing", "Generate userFacingSummary: concise goal and evaluation only; scope only if authorization needs it");
          }
          return proposal;
        },
        classify: services.artifact.issues,
        execute: async ({ mode, issues }) => await services.agent.execute({
          operation: "init.prepare_recommendation",
          label: mode === "generate" ? "init:plan" : "init:plan:repair",
          cwd: services.projectRoot,
          tools: ["Read", "Write"],
          readRoots: state.workflow === "compact" ? [contextPath, initGoalPath(services.projectRoot)] : [services.projectRoot],
          writeRoots: state.workflow === "compact" ? [documentPath, refPath] : [services.workspace.parent(refPath)],
          deniedPaths: [services.workspace.runtimeDir],
          sessionKey: "manager",
          prompt: services.prompt(state.workflow === "compact" ? "init.compact.proposal" : mode === "generate" ? "init.proposal.generate" : "init.proposal.repair", {
            context_card_path: contextPath,
            goal_path: initGoalPath(services.projectRoot),
            proposal_path: refPath,
            destination: refPath,
            document_path: documentPath,
            user_goal: String(state.answers.initialGoal ?? "用户尚未提供初始目标，请基于项目证据提出建议并明确需要用户确认的目标。"),
            schema_prompt: proposalSchemaPrompt(services.projectRoot),
            issues,
            ...(state.workflow === "compact" ? {
              context_card_text: await services.workspace.readText(contextPath),
              goal_text: await services.workspace.readText(initGoalPath(services.projectRoot)),
            } : {}),
          }),
        }, signal),
      });
      state.proposal = proposal;
      delete state.answers.summaryConfirmed;
  return { status: "completed", data: { proposalPath: proposal.documentPath } };
};

async function proposalConfirmation(
  services: InitServices,
  state: InitState,
  command?: InitCommand,
  signal?: AbortSignal,
): Promise<InitOperationResult> {
  if (!state.proposal) state.proposal = await loadProposal(services.projectRoot);
  if (state.confirmationMode === "brief" && !state.proposal.userFacingSummary) {
    throw services.artifact.jobFailure("init-proposal", "The proposal needs a short userFacingSummary of goal and evaluation before confirmation");
  }
  const presentedHash = await services.workspace.sha256(
    services.workspace.resolve(services.projectRoot, state.proposal.documentPath));
  if (command && typeof state.answers.presentedProposalSha256 === "string"
    && state.answers.presentedProposalSha256 !== presentedHash) {
    throw new Error("Proposal changed after its confirmation summary was presented");
  }
  state.answers.presentedProposalSha256 = presentedHash;
  const summary = state.confirmationMode === "brief" && state.proposal.userFacingSummary
    ? state.proposal.userFacingSummary : await proposalSummary(state.proposal, services.projectRoot);
  const compactOptions = state.workflow === "compact"
    ? [{ value: "confirm", label: "确认目标与评价方式，开始准备" }] : undefined;
  if (!command) {
    return {
      status: "waiting_for_user",
      interaction: managerInteraction({
        id: "init.confirm_proposal",
        operationId: "confirm_proposal",
        question: state.confirmationMode === "brief" ? "目标和评价方式是否符合你的想法？" : "这套初始化方案是否符合你的目标？",
        description: `${summary.trim()}\n\n请确认、提出修改意见或继续提问。`,
        ...(compactOptions ? { options: compactOptions } : {}),
      }),
    };
  }
  if (command.inputKind !== "text" && confirmed(command.value)) {
    state.answers.summaryConfirmed = true;
    state.answers.approvedGoalSha256 = await services.workspace.sha256(initGoalPath(services.projectRoot));
    state.answers.approvedProposalSha256 = await services.workspace.sha256(
      services.workspace.resolve(services.projectRoot, state.proposal.documentPath),
    );
    return { status: "completed", data: { confirmed: true } };
  }
  const before = await services.workspace.sha256(
    services.workspace.resolve(services.projectRoot, state.proposal.documentPath),
  );
  const { decision } = state.workflow === "compact" ? await compactProposalConversation(services, state, String(command.value), summary, signal) : await runInitConversation({
    services,
    sessionKey: "manager",
    label: "init:confirm-proposal",
    writeRoots: [services.workspace.join(services.workspace.flywheelDir, "init")],
    signal,
    prompt: services.prompt("init.proposal.discuss", {
      proposal_summary: summary,
      user_input: String(command.value),
      revision_prompt: revisionPrompt(state.proposal, services.projectRoot, String(command.value)),
    }),
  });
  if (decision.action === "confirm") {
    state.answers.summaryConfirmed = true;
    state.answers.approvedGoalSha256 = await services.workspace.sha256(initGoalPath(services.projectRoot));
    state.answers.approvedProposalSha256 = before;
    return { status: "completed", data: { confirmed: true } };
  }
  if (decision.action === "revise") {
    state.proposal = await loadProposal(services.projectRoot);
    if (state.confirmationMode === "brief" && !state.proposal.userFacingSummary) {
      throw services.artifact.jobFailure("init-proposal", "The revised proposal must include a concise userFacingSummary");
    }
    const after = await services.workspace.sha256(
      services.workspace.resolve(services.projectRoot, state.proposal.documentPath),
    );
    if (after === before) {
      throw services.artifact.jobFailure(
        "init-proposal",
        "Manager requested revision but did not update the proposal",
      );
    }
    delete state.answers.summaryConfirmed;
    delete state.answers.approvedGoalSha256;
    delete state.answers.approvedProposalSha256;
    state.answers.presentedProposalSha256 = after;
  }
  return {
    status: "waiting_for_user",
    interaction: managerInteraction({
      id: "init.confirm_proposal",
      operationId: "confirm_proposal",
      question: decision.action === "revise" ? "我已经更新方案，现在是否符合你的目标？" : "是否继续确认这套初始化方案？",
      description: `${decision.message ?? ""}\n\n${state.confirmationMode === "brief" && state.proposal.userFacingSummary
        ? state.proposal.userFacingSummary : await proposalSummary(state.proposal, services.projectRoot)}`.trim(),
      ...(compactOptions ? { options: compactOptions } : {}),
    }),
  };
}

async function compactProposalConversation(
  services: InitServices, state: InitState, input: string, summary: string, signal?: AbortSignal,
): Promise<{ decision: InitConversationDecision }> {
  const documentPath = services.workspace.resolve(services.projectRoot, state.proposal!.documentPath);
  const refPath = proposalPath(services.projectRoot);
  const goalPath = initGoalPath(services.projectRoot);
  const goal = await services.workspace.readText(goalPath);
  const goalHash = await services.workspace.sha256(goalPath);
  const documentHash = await services.workspace.sha256(documentPath);
  const referenceHash = await services.workspace.sha256(refPath);
  const directory = services.workspace.join(services.workspace.flywheelDir, "init", "confirmation");
  let response: { decision: InitConversationDecision };
  try {
    response = await services.decide({ directory, signal,
      parse: (value) => {
        const decision = parseConversationDecision(value);
        if (decision.action === "retry") throw new Error("Retry is not allowed at proposal confirmation");
        return decision;
      },
      job: (decisionPath) => ({
        operation: "init.confirm_proposal", label: "init:confirm-proposal", audience: "user",
        cwd: services.projectRoot, tools: ["Read", "Write"],
        readRoots: [goalPath, documentPath, refPath], writeRoots: [directory, documentPath, refPath],
        deniedPaths: [goalPath, services.workspace.runtimeDir],
        // No sessionKey: confirmation never inherits exploration/proposal history.
        prompt: services.prompt("init.compact.confirm", { goal_path: goalPath, proposal_path: documentPath,
          proposal_ref_path: refPath, proposal_summary: summary, user_input: input, decision_path: decisionPath }),
      }),
    });
  } finally {
    if (await services.workspace.sha256(goalPath) !== goalHash) {
      await services.workspace.writeText(goalPath, goal);
      throw new Error("Confirmation modified the frozen original goal; Runtime restored it");
    }
  }
  if (response.decision.action !== "revise" && (await services.workspace.sha256(documentPath) !== documentHash
    || await services.workspace.sha256(refPath) !== referenceHash)) {
    throw new Error("Confirmation changed the proposal without a controlled revision");
  }
  if (response.decision.action === "revise") {
    const proposal = await loadProposal(services.projectRoot);
    if (proposal.documentPath !== state.proposal!.documentPath) throw new Error("Proposal revision changed its authorized document path");
  }
  return response;
}

export const confirmProposalOperation: InitOperation = async ({ services, state, command, signal }) =>
  await proposalConfirmation(services, state, command, signal);

function contractJob(services: InitServices): JobSpec {
  const contractDir = initContractDir(services.projectRoot);
  const resultPath = services.workspace.join(contractDir, "contract-job-result.json");
  return {
    operation: "init.generate_contract",
    label: "init:contract",
    cwd: services.projectRoot,
    tools: ["Read", "Write", "Bash"],
    readRoots: [services.projectRoot],
    writeRoots: [contractDir],
    deniedPaths: [services.workspace.runtimeDir],
    resultPath,
    sessionKey: "contract",
    prompt: services.prompt("init.contract.generate", {
      project_root: services.projectRoot,
      goal_path: initGoalPath(services.projectRoot),
      context_card_path: services.workspace.join(services.workspace.flywheelDir, "init", "context_card.md"),
      proposal_path: proposalDocumentPath(services.projectRoot),
      proposal_ref_path: proposalPath(services.projectRoot),
      contract_dir: contractDir,
      manifest_path: services.workspace.join(contractDir, "manifest.json"),
      result_path: resultPath,
    }),
  };
}

async function contractPresent(services: InitServices, job: JobSpec): Promise<boolean> {
  try {
    if (!await services.workspace.exists(job.resultPath!)) return false;
    const result = await services.artifact.readJobResult(job);
    if (result.status !== "completed") return false;
    await validateInitContractSpec(services.projectRoot);
    return true;
  } catch { return false; }
}

async function validateContractCandidate(
  services: InitServices,
  state: InitState,
  job = contractJob(services),
): Promise<ValidatedInitContractSpec> {
  const result = await services.artifact.readJobResult(job);
  if (result.status !== "completed") {
    throw services.artifact.jobFailure(
      "init-contract",
      result.message ?? `Contract builder returned ${result.status}`,
      result.status === "needs_input" ? "needs_input" : "failed",
    );
  }
  const validated = await validateInitContractSpec(services.projectRoot);
  const proposal = state.proposal ?? await loadProposal(services.projectRoot);
  if (services.workspace.resolve(services.projectRoot, proposal.artifactPath) !== validated.artifactPath) {
    throw services.artifact.invalid(
      "contract.artifact_mismatch",
      "boundary.json artifact.path differs from the approved proposal",
    );
  }
  return validated;
}

export const generateContractOperation: InitOperation = async ({ services, state, signal }): Promise<InitOperationResult> => {
      if (state.answers.summaryConfirmed !== true || typeof state.answers.approvedProposalSha256 !== "string"
        || typeof state.answers.approvedGoalSha256 !== "string") {
        throw new Error("Contract generation requires an approved proposal");
      }
      const goalHash = await services.workspace.sha256(initGoalPath(services.projectRoot));
      if (goalHash !== state.answers.approvedGoalSha256) throw new Error("Approved goal changed before contract generation");
      const approvedHash = await services.workspace.sha256(proposalDocumentPath(services.projectRoot));
      if (approvedHash !== state.answers.approvedProposalSha256) throw new Error("Approved proposal changed before contract generation");
      const baseJob = contractJob(services);
      const contract = await services.artifact.run({
        artifactId: "init-contract",
        operationId: "generate_contract",
        job: "contract builder",
        operationState: state.execution.operationState,
        signal,
        present: async () => await contractPresent(services, baseJob),
        validate: async () => await validateContractCandidate(services, state, baseJob),
        classify: services.artifact.issues,
        execute: async ({ mode, issues }) => await services.agent.execute({
          ...baseJob,
          label: mode === "generate" ? "init:contract" : "init:contract:repair",
          prompt: mode === "generate" ? baseJob.prompt : services.prompt("init.contract.repair", {
            goal_path: initGoalPath(services.projectRoot),
            context_card_path: services.workspace.join(services.workspace.flywheelDir, "init", "context_card.md"),
            proposal_path: proposalDocumentPath(services.projectRoot),
            proposal_ref_path: proposalPath(services.projectRoot),
            contract_dir: initContractDir(services.projectRoot),
            manifest_path: services.workspace.join(initContractDir(services.projectRoot), "manifest.json"),
            result_path: baseJob.resultPath!,
            issues,
          }),
        }, signal),
      });
      state.answers.contractSpecSha256 = contract.specSha256;
      delete state.answers.contractManifestSha256;
      delete state.answers.evaluatorReviewManifestSha256;
      delete state.answers.smokeConfirmed;
      delete state.answers.smokeReportPath;
      delete state.answers.smokeReportSha256;
      delete state.execution.operationState.contractSmokeRepairAttempts;
  return { status: "completed", data: { manifestPath: contract.manifestPath } };
};

function evaluatorJob(services: InitServices): JobSpec {
  const contractDir = initContractDir(services.projectRoot);
  return {
    operation: "init.generate_evaluator",
    label: "init:evaluator",
    cwd: services.projectRoot,
    tools: ["Read", "Write", "Bash"],
    readRoots: [services.projectRoot],
    writeRoots: [contractDir],
    deniedPaths: [
      services.workspace.runtimeDir,
      services.workspace.join(contractDir, "task.md"),
      services.workspace.join(contractDir, "boundary.json"),
      services.workspace.join(contractDir, "tasking_guide.md"),
      services.workspace.join(contractDir, "requirements.json"),
    ],
    resultPath: services.workspace.join(contractDir, "job-result.json"),
    sessionKey: "evaluator",
    prompt: services.prompt("init.evaluator.generate", {
      project_root: services.projectRoot,
      goal_path: initGoalPath(services.projectRoot),
      proposal_path: proposalDocumentPath(services.projectRoot),
      contract_dir: contractDir,
      task_path: services.workspace.join(contractDir, "task.md"),
      requirements_path: services.workspace.join(contractDir, "requirements.json"),
      tasking_guide_path: services.workspace.join(contractDir, "tasking_guide.md"),
      manifest_path: services.workspace.join(contractDir, "manifest.json"),
      result_path: services.workspace.join(contractDir, "job-result.json"),
      project_native_strategy: services.prompt("init.evaluator.project-native", {}),
    }),
  };
}

async function evaluatorPresent(services: InitServices, state: InitState, job: JobSpec): Promise<boolean> {
  try {
    if (!await services.workspace.exists(job.resultPath!)) return false;
    const result = await services.artifact.readJobResult(job);
    if (result.status !== "completed") return false;
    const spec = await validateInitContractSpec(services.projectRoot);
    if (state.answers.contractSpecSha256 !== spec.specSha256) return false;
    await validateInitContract(services.projectRoot);
    return true;
  } catch { return false; }
}

async function validateEvaluatorCandidate(
  services: InitServices,
  state: InitState,
  job = evaluatorJob(services),
): Promise<ValidatedInitContract> {
  const result = await services.artifact.readJobResult(job);
  if (result.status !== "completed") {
    throw services.artifact.jobFailure(
      "init-evaluator",
      result.message ?? `Evaluator builder returned ${result.status}`,
      result.status === "needs_input" ? "needs_input" : "failed",
    );
  }
  const spec = await validateInitContractSpec(services.projectRoot);
  if (state.answers.contractSpecSha256 !== spec.specSha256) {
    throw services.artifact.invalid("evaluator.spec_changed", "Evaluator generation modified the frozen semantic contract");
  }
  return await validateInitContract(services.projectRoot);
}

export const generateEvaluatorOperation: InitOperation = async ({ services, state, signal }): Promise<InitOperationResult> => {
  const spec = await validateInitContractSpecFiles(services.projectRoot);
  if (state.answers.contractSpecSha256 !== spec.specSha256) {
    throw new Error("Semantic contract changed before evaluator generation");
  }
  const baseJob = evaluatorJob(services);
  const contract = await services.artifact.run({
    artifactId: "init-evaluator",
    operationId: "generate_evaluator",
    job: "evaluator builder",
    operationState: state.execution.operationState,
    signal,
    present: async () => await evaluatorPresent(services, state, baseJob),
    validate: async () => await validateEvaluatorCandidate(services, state, baseJob),
    classify: services.artifact.issues,
    execute: async ({ mode, issues }) => await services.agent.execute({
      ...baseJob,
      label: mode === "generate" ? "init:evaluator" : "init:evaluator:repair",
      prompt: mode === "generate" ? baseJob.prompt : services.prompt("init.evaluator.repair", {
        goal_path: initGoalPath(services.projectRoot),
        proposal_path: proposalDocumentPath(services.projectRoot),
        contract_dir: initContractDir(services.projectRoot),
        task_path: services.workspace.join(initContractDir(services.projectRoot), "task.md"),
        requirements_path: services.workspace.join(initContractDir(services.projectRoot), "requirements.json"),
        tasking_guide_path: services.workspace.join(initContractDir(services.projectRoot), "tasking_guide.md"),
        manifest_path: services.workspace.join(initContractDir(services.projectRoot), "manifest.json"),
        result_path: baseJob.resultPath!,
        issues,
        project_native_strategy: services.prompt("init.evaluator.project-native", {}),
      }),
    }, signal),
  });
  state.answers.contractManifestSha256 = contract.manifestSha256;
  delete state.answers.evaluatorReviewManifestSha256;
  delete state.answers.smokeConfirmed;
  delete state.answers.smokeReportPath;
  delete state.answers.smokeReportSha256;
  delete state.execution.operationState.evaluatorSmokeRepairAttempts;
  return { status: "completed", data: { manifestPath: contract.manifestPath } };
};

function evaluatorReviewPaths(services: InitServices): { root: string; review: string; result: string } {
  const root = services.workspace.join(services.workspace.flywheelDir, "init", "evaluator-review");
  return {
    root,
    review: services.workspace.join(root, "review.json"),
    result: services.workspace.join(root, "job-result.json"),
  };
}

function evaluatorReviewJob(services: InitServices, issues = "[]"): JobSpec {
  const paths = evaluatorReviewPaths(services);
  const contractDir = initContractDir(services.projectRoot);
  return {
    operation: "init.review_evaluator",
    label: "init:review-evaluator",
    cwd: services.projectRoot,
    tools: ["Read", "Write", "Bash"],
    readRoots: [services.projectRoot],
    writeRoots: [paths.root],
    deniedPaths: [services.workspace.runtimeDir],
    resultPath: paths.result,
    sessionKey: "evaluator-review",
    prompt: services.prompt("init.evaluator.review", {
      project_root: services.projectRoot,
      goal_path: initGoalPath(services.projectRoot),
      proposal_path: proposalDocumentPath(services.projectRoot),
      contract_dir: contractDir,
      task_path: services.workspace.join(contractDir, "task.md"),
      requirements_path: services.workspace.join(contractDir, "requirements.json"),
      coverage_path: services.workspace.join(contractDir, "coverage.json"),
      manifest_path: services.workspace.join(contractDir, "manifest.json"),
      review_path: paths.review,
      result_path: paths.result,
      issues,
    }),
  };
}

async function runEvaluatorReviewAgent(
  services: InitServices,
  signal: AbortSignal,
): Promise<EvaluatorReview> {
  let issues = "[]";
  for (let attempt = 0; attempt <= MAX_EVALUATOR_REVIEW_REPAIRS; attempt += 1) {
    const paths = evaluatorReviewPaths(services);
    await services.workspace.removeTree(paths.root);
    await services.workspace.ensureDir(paths.root);
    const job = evaluatorReviewJob(services, issues);
    const execution = await services.agent.execute({
      ...job,
      label: attempt === 0 ? job.label : "init:review-evaluator:repair",
    }, signal);
    if (execution.protocolIssues?.length) {
      const classified = execution.protocolIssues.map((message) => ({ code: "job_result.invalid", message }));
      if (attempt >= MAX_EVALUATOR_REVIEW_REPAIRS) {
        throw new AgentExecutionError(
          "init-evaluator-review",
          `Evaluator review JobResult remained invalid after ${MAX_EVALUATOR_REVIEW_REPAIRS} repairs: ${execution.protocolIssues.join("; ")}`,
        );
      }
      await services.emit("artifact.validation.failed", {
        artifactId: "init-evaluator-review",
        operationId: "review_evaluator",
        job: "evaluator reviewer",
        attempt: attempt + 1,
        issues: classified,
      });
      issues = JSON.stringify({ source: "review-job-result-protocol", issues: classified }, null, 2);
      continue;
    }
    if (execution.status !== "completed") {
      throw new AgentExecutionError(
        "init-evaluator-review",
        execution.message ?? `Evaluator reviewer returned ${execution.status}`,
        execution.status === "needs_input" ? "needs_input" : "failed",
      );
    }
    try {
      return await validateEvaluatorReview(services, job);
    } catch (error) {
      const classified = services.artifact.issues(error);
      if (!classified) throw error;
      if (attempt >= MAX_EVALUATOR_REVIEW_REPAIRS) {
        throw new AgentExecutionError(
          "init-evaluator-review",
          `Evaluator review remained mechanically invalid after ${MAX_EVALUATOR_REVIEW_REPAIRS} repairs: ${classified.map((issue) => issue.message).join("; ")}`,
        );
      }
      await services.emit("artifact.validation.failed", {
        artifactId: "init-evaluator-review",
        operationId: "review_evaluator",
        job: "evaluator reviewer",
        attempt: attempt + 1,
        issues: classified,
      });
      issues = JSON.stringify({ source: "review-mechanical-validation", issues: classified }, null, 2);
    }
  }
  throw new Error("Evaluator review repair loop exited without a result");
}

async function validateEvaluatorReview(
  services: InitServices,
  job = evaluatorReviewJob(services),
): Promise<EvaluatorReview> {
  const paths = evaluatorReviewPaths(services);
  const result = await services.artifact.readJobResult(job);
  if (result.status !== "completed") {
    throw services.artifact.jobFailure(
      "init-evaluator-review",
      result.message ?? `Evaluator reviewer returned ${result.status}`,
      result.status === "needs_input" ? "needs_input" : "failed",
    );
  }
  const resolvedReview = services.workspace.resolve(paths.review);
  if (!result.artifacts.some((item) => services.workspace.resolve(job.cwd, item) === resolvedReview)) {
    throw services.artifact.invalid("evaluator.review_missing", "Evaluator reviewer JobResult does not declare review.json");
  }
  const parsed = JSON.parse(await services.workspace.readText(paths.review)) as Partial<EvaluatorReview>;
  if (![1, 2].includes(Number(parsed.schemaVersion)) || !["accepted", "repair"].includes(String(parsed.verdict))
    || !Array.isArray(parsed.checks) || parsed.checks.length === 0) {
    throw services.artifact.invalid("evaluator.review_invalid", "review.json requires schemaVersion 1, verdict, and checks");
  }
  const contractDir = initContractDir(services.projectRoot);
  const requirements = JSON.parse(await services.workspace.readText(
    services.workspace.join(contractDir, "requirements.json"),
  )) as { requirements?: Array<{ id?: unknown }> };
  const coverage = JSON.parse(await services.workspace.readText(
    services.workspace.join(contractDir, "coverage.json"),
  )) as { schemaVersion?: unknown; checks?: Array<{ requirementIds?: unknown; locator?: unknown }> };
  if (coverage.schemaVersion === 2 && parsed.schemaVersion !== 2) {
    throw services.artifact.invalid(
      "evaluator.review_version",
      "coverage schemaVersion 2 requires a schemaVersion 2 Completeness and Soundness review",
    );
  }
  const requirementIds = (requirements.requirements ?? []).map((item) => String(item.id));
  const expectedLocators = new Map<string, string>();
  for (const check of coverage.checks ?? []) {
    if (Array.isArray(check.requirementIds) && check.requirementIds.length === 1
      && typeof check.requirementIds[0] === "string" && typeof check.locator === "string") {
      expectedLocators.set(check.requirementIds[0], check.locator);
    }
  }
  const seen = new Set<string>();
  let invalid = 0;
  for (const item of parsed.checks) {
    if (!item || typeof item !== "object" || typeof item.requirementId !== "string"
      || seen.has(item.requirementId) || expectedLocators.get(item.requirementId) !== item.locator
      || !["valid", "invalid"].includes(String(item.status))
      || typeof item.reason !== "string" || !item.reason.trim()) {
      throw services.artifact.invalid(
        "evaluator.review_check_invalid",
        "Every evaluator review check must uniquely match one frozen requirement and its exact coverage locator",
      );
    }
    if (parsed.schemaVersion === 2 && (!["valid", "invalid"].includes(String(item.completeness))
      || !["valid", "invalid"].includes(String(item.soundness))
      || (item.status === "valid") !== (item.completeness === "valid" && item.soundness === "valid"))) {
      throw services.artifact.invalid(
        "evaluator.review_soundness_invalid",
        "Every schemaVersion 2 review check must report Completeness and Soundness and agree with status",
      );
    }
    seen.add(item.requirementId);
    if (item.status === "invalid") invalid += 1;
  }
  if (requirementIds.length !== seen.size || requirementIds.some((id) => !seen.has(id))) {
    throw services.artifact.invalid("evaluator.review_incomplete", "Evaluator review must assess every frozen requirement exactly once");
  }
  if ((parsed.verdict === "accepted") !== (invalid === 0)) {
    throw services.artifact.invalid("evaluator.review_verdict", "Evaluator review verdict must agree with its per-requirement checks");
  }
  return parsed as EvaluatorReview;
}

async function recoverableEvaluatorRepairReview(
  services: InitServices,
  job = evaluatorReviewJob(services),
): Promise<EvaluatorReview | undefined> {
  try {
    const paths = evaluatorReviewPaths(services);
    const result = await services.artifact.readJobResult(job);
    if (result.status !== "completed") return undefined;
    const resolvedReview = services.workspace.resolve(paths.review);
    if (!result.artifacts.some((item) => services.workspace.resolve(job.cwd, item) === resolvedReview)) {
      return undefined;
    }
    const parsed = JSON.parse(await services.workspace.readText(paths.review)) as Partial<EvaluatorReview>;
    if (![1, 2].includes(Number(parsed.schemaVersion)) || parsed.verdict !== "repair"
      || !Array.isArray(parsed.checks) || parsed.checks.length === 0) return undefined;
    const requirements = JSON.parse(await services.workspace.readText(
      services.workspace.join(initContractDir(services.projectRoot), "requirements.json"),
    )) as { requirements?: Array<{ id?: unknown }> };
    const requirementIds = (requirements.requirements ?? []).map((item) => String(item.id));
    const seen = new Set<string>();
    for (const item of parsed.checks) {
      if (!item || typeof item !== "object" || typeof item.requirementId !== "string"
        || seen.has(item.requirementId) || !requirementIds.includes(item.requirementId)
        || typeof item.locator !== "string" || !item.locator.trim()
        || !["valid", "invalid"].includes(String(item.status))
        || typeof item.reason !== "string" || !item.reason.trim()) return undefined;
      seen.add(item.requirementId);
    }
    if (requirementIds.length !== seen.size || requirementIds.some((id) => !seen.has(id))
      || !parsed.checks.some((check) => check.status === "invalid")) return undefined;
    return parsed as EvaluatorReview;
  } catch {
    return undefined;
  }
}

async function repairEvaluatorAfterReview(
  services: InitServices,
  state: InitState,
  review: EvaluatorReview,
  signal: AbortSignal,
): Promise<void> {
  const invalid = review.checks.filter((check) => check.status === "invalid");
  const baseJob = evaluatorJob(services);
  let issues = JSON.stringify({ source: "independent-evaluator-review", checks: invalid }, null, 2);
  for (let attempt = 0; attempt <= MAX_EVALUATOR_REVIEW_REPAIRS; attempt += 1) {
    const execution = await services.agent.execute({
      ...baseJob,
      label: "init:evaluator:repair",
      prompt: services.prompt("init.evaluator.repair", {
        goal_path: initGoalPath(services.projectRoot),
        proposal_path: proposalDocumentPath(services.projectRoot),
        contract_dir: initContractDir(services.projectRoot),
        task_path: services.workspace.join(initContractDir(services.projectRoot), "task.md"),
        requirements_path: services.workspace.join(initContractDir(services.projectRoot), "requirements.json"),
        tasking_guide_path: services.workspace.join(initContractDir(services.projectRoot), "tasking_guide.md"),
        manifest_path: services.workspace.join(initContractDir(services.projectRoot), "manifest.json"),
        result_path: baseJob.resultPath!,
        issues,
        project_native_strategy: services.prompt("init.evaluator.project-native", {}),
      }),
    }, signal);
    if (execution.protocolIssues?.length) {
      const classified = execution.protocolIssues.map((message) => ({ code: "job_result.invalid", message }));
      if (attempt >= MAX_EVALUATOR_REVIEW_REPAIRS) {
        throw new AgentExecutionError(
          "init-evaluator",
          `Evaluator repair JobResult remained invalid after ${MAX_EVALUATOR_REVIEW_REPAIRS} repairs: ${execution.protocolIssues.join("; ")}`,
        );
      }
      await services.emit("artifact.validation.failed", {
        artifactId: "init-evaluator",
        operationId: "review_evaluator",
        job: "evaluator builder",
        attempt: attempt + 1,
        issues: classified,
      });
      issues = JSON.stringify({ source: "post-review-job-result-protocol", issues: classified }, null, 2);
      continue;
    }
    if (execution.status !== "completed") {
      throw new AgentExecutionError(
        "init-evaluator",
        execution.message ?? `Evaluator repair returned ${execution.status}`,
        execution.status === "needs_input" ? "needs_input" : "failed",
      );
    }
    try {
      const repaired = await validateEvaluatorCandidate(services, state, baseJob);
      state.answers.contractManifestSha256 = repaired.manifestSha256;
      delete state.answers.evaluatorReviewManifestSha256;
      delete state.answers.smokeConfirmed;
      delete state.answers.smokeReportPath;
      delete state.answers.smokeReportSha256;
      return;
    } catch (error) {
      const classified = services.artifact.issues(error);
      if (!classified) throw error;
      if (attempt >= MAX_EVALUATOR_REVIEW_REPAIRS) {
        throw new AgentExecutionError(
          "init-evaluator",
          `Evaluator review repair remained mechanically invalid after ${MAX_EVALUATOR_REVIEW_REPAIRS} repairs: ${classified.map((issue) => issue.message).join("; ")}`,
        );
      }
      await services.emit("artifact.validation.failed", {
        artifactId: "init-evaluator",
        operationId: "review_evaluator",
        job: "evaluator builder",
        attempt: attempt + 1,
        issues: classified,
      });
      issues = JSON.stringify({ source: "post-review-mechanical-validation", issues: classified }, null, 2);
    }
  }
}

async function ensureEvaluatorReview(
  services: InitServices,
  state: InitState,
  signal: AbortSignal,
): Promise<void> {
  // Independent Reviewer/Builder convergence accepts only frozen assets,
  // Reviewer evidence, and Runtime mechanical validation feedback.
  delete state.execution.operationState.managerGuidance;
  let current: ValidatedInitContract;
  try {
    current = await validateInitContract(services.projectRoot);
  } catch (error) {
    const classified = services.artifact.issues(error);
    const pendingReview = classified ? await recoverableEvaluatorRepairReview(services) : undefined;
    if (!classified || !pendingReview) throw error;
    await services.emit("init.evaluator.repair.recovered", {
      source: "persisted-independent-review",
      invalidChecks: pendingReview.checks.filter((check) => check.status === "invalid").length,
      issues: classified,
    });
    await repairEvaluatorAfterReview(services, state, pendingReview, signal);
    current = await validateInitContract(services.projectRoot);
  }
  if (state.answers.evaluatorReviewManifestSha256 === current.manifestSha256) {
    const existing = await validateEvaluatorReview(services).catch(() => undefined);
    if (existing?.verdict === "accepted") return;
  }
  for (let attempt = 0; attempt <= MAX_EVALUATOR_REVIEW_REPAIRS; attempt += 1) {
    const review = await runEvaluatorReviewAgent(services, signal);
    await services.emit("init.evaluator.review.completed", {
      verdict: review.verdict,
      attempt: attempt + 1,
      invalidChecks: review.checks.filter((check) => check.status === "invalid").length,
    });
    if (review.verdict === "accepted") {
      const accepted = await validateInitContract(services.projectRoot);
      state.answers.evaluatorReviewManifestSha256 = accepted.manifestSha256;
      return;
    }
    if (attempt >= MAX_EVALUATOR_REVIEW_REPAIRS) {
      throw new AgentExecutionError(
        "init-evaluator-review",
        `Evaluator remained semantically invalid after ${MAX_EVALUATOR_REVIEW_REPAIRS} repairs`,
      );
    }
    await services.emit("init.evaluator.repair.requested", {
      source: "independent-review",
      attempt: attempt + 1,
      invalidChecks: review.checks.filter((check) => check.status === "invalid").length,
    });
    await repairEvaluatorAfterReview(services, state, review, signal);
  }
}

export const reviewEvaluatorOperation: InitOperation = async ({ services, state, signal }): Promise<InitOperationResult> => {
  await ensureEvaluatorReview(services, state, signal);
  return { status: "completed", data: { reviewed: true } };
};

function smokePaths(services: InitServices): { root: string; report: string; result: string } {
  const root = services.workspace.join(services.workspace.flywheelDir, "init", "smoke");
  return {
    root,
    report: services.workspace.join(root, "report.md"),
    result: services.workspace.join(root, "job-result.json"),
  };
}

function smokeJob(services: InitServices): JobSpec {
  const paths = smokePaths(services);
  return {
    operation: "init.validate_contract",
    label: "init:smoke",
    cwd: services.projectRoot,
    tools: ["Read", "Write", "Bash"],
    readRoots: [services.projectRoot],
    writeRoots: [paths.root],
    deniedPaths: [services.workspace.runtimeDir],
    resultPath: paths.result,
    sessionKey: "smoke",
    prompt: services.prompt("init.smoke.validate", {
      goal_path: initGoalPath(services.projectRoot),
      proposal_path: proposalDocumentPath(services.projectRoot),
      contract_manifest_path: services.workspace.join(initContractDir(services.projectRoot), "manifest.json"),
      contract_dir: initContractDir(services.projectRoot),
      report_path: paths.report,
      result_path: paths.result,
    }),
  };
}

async function validateSmoke(services: InitServices, job: JobSpec, reportPath: string): Promise<string> {
  const result = await services.artifact.readJobResult(job);
  if (result.status !== "completed") {
    throw services.artifact.jobFailure(
      "init-smoke",
      result.message ?? `Smoke returned ${result.status}`,
      result.status === "needs_input" ? "needs_input" : "failed",
    );
  }
  const resolvedReport = services.workspace.resolve(reportPath);
  if (!result.artifacts.some((item) => services.workspace.resolve(job.cwd, item) === resolvedReport)) {
    throw services.artifact.invalid("smoke.report_missing", "Smoke JobResult does not declare its report");
  }
  const report = await services.workspace.readText(reportPath);
  if (!report.trim()) throw services.artifact.invalid("smoke.report_empty", "Smoke report is empty");
  return report;
}

async function runSmoke(services: InitServices, state: InitState, signal: AbortSignal): Promise<string> {
  const paths = smokePaths(services);
  const job = smokeJob(services);
  await services.workspace.ensureDir(paths.root);
  return await services.artifact.run({
    artifactId: "init-smoke",
    operationId: "validate_contract",
    job: "contract smoke",
    operationState: state.execution.operationState,
    signal,
    present: async () => {
      try { return await validateSmoke(services, job, paths.report).then(() => true); } catch { return false; }
    },
    validate: async () => await validateSmoke(services, job, paths.report),
    classify: services.artifact.issues,
    execute: async ({ mode, issues }) => await services.agent.execute({
      ...job,
      label: mode === "generate" ? "init:smoke" : "init:smoke:repair",
      prompt: mode === "generate" ? job.prompt : services.prompt("init.smoke.repair", {
        goal_path: initGoalPath(services.projectRoot),
        proposal_path: proposalDocumentPath(services.projectRoot),
        contract_manifest_path: services.workspace.join(initContractDir(services.projectRoot), "manifest.json"),
        contract_dir: initContractDir(services.projectRoot),
        report_path: paths.report,
        result_path: paths.result,
        issues,
      }),
    }, signal),
  });
}

function resetSmokeAttempt(state: InitState): void {
  delete state.agentSessions?.smoke;
  const artifacts = state.execution.operationState.artifacts;
  if (artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)) {
    delete (artifacts as Record<string, unknown>)["init-smoke"];
  }
}

async function repairEvaluatorAfterSmoke(
  services: InitServices,
  state: InitState,
  issue: unknown,
  signal: AbortSignal,
): Promise<void> {
  const current = Number(state.execution.operationState.evaluatorSmokeRepairAttempts ?? 0);
  if (current >= MAX_EVALUATOR_SMOKE_REPAIRS) {
    throw new AgentExecutionError(
      "init-smoke",
      `Evaluator remained invalid after ${current} Smoke-driven repairs: ${issue instanceof Error ? issue.message : String(issue)}`,
    );
  }
  const paths = smokePaths(services);
  let report = "";
  if (await services.workspace.exists(paths.report)) report = await services.workspace.readText(paths.report);
  const message = [
    issue instanceof Error ? issue.message : String(issue),
    report.trim() ? `Smoke report:\n${report.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  state.execution.operationState.evaluatorSmokeRepairAttempts = current + 1;
  await services.emit("init.evaluator.repair.requested", {
    source: "smoke",
    attempt: current + 1,
    issue: message,
  });
  const baseJob = evaluatorJob(services);
  const execution = await services.agent.execute({
    ...baseJob,
    label: "init:evaluator:repair",
    prompt: services.prompt("init.evaluator.repair", {
      goal_path: initGoalPath(services.projectRoot),
      proposal_path: proposalDocumentPath(services.projectRoot),
      contract_dir: initContractDir(services.projectRoot),
      task_path: services.workspace.join(initContractDir(services.projectRoot), "task.md"),
      requirements_path: services.workspace.join(initContractDir(services.projectRoot), "requirements.json"),
      tasking_guide_path: services.workspace.join(initContractDir(services.projectRoot), "tasking_guide.md"),
      manifest_path: services.workspace.join(initContractDir(services.projectRoot), "manifest.json"),
      result_path: baseJob.resultPath!,
      issues: message,
      project_native_strategy: services.prompt("init.evaluator.project-native", {}),
    }),
  }, signal);
  if (execution.status !== "completed") {
    throw new AgentExecutionError(
      "init-evaluator",
      execution.message ?? `Evaluator repair returned ${execution.status}`,
      execution.status === "needs_input" ? "needs_input" : "failed",
    );
  }
  const repaired = await validateEvaluatorCandidate(services, state, baseJob);
  state.answers.contractManifestSha256 = repaired.manifestSha256;
  delete state.answers.evaluatorReviewManifestSha256;
  delete state.answers.smokeConfirmed;
  delete state.answers.smokeReportPath;
  delete state.answers.smokeReportSha256;
  resetSmokeAttempt(state);
  await services.workspace.removeTree(paths.root);
  await services.emit("init.evaluator.repair.completed", { source: "smoke", attempt: current + 1 });
}

async function runSmokeWithContractRepairs(
  services: InitServices,
  state: InitState,
  signal: AbortSignal,
): Promise<string> {
  while (true) {
    try {
      await validateContractCandidate(services, state);
      await ensureEvaluatorReview(services, state, signal);
      const report = await runSmoke(services, state, signal);
      delete state.execution.operationState.evaluatorSmokeRepairAttempts;
      return report;
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      if (error instanceof AgentExecutionError && error.status === "needs_input") throw error;
      await repairEvaluatorAfterSmoke(services, state, error, signal);
    }
  }
}

async function resetToProposal(services: InitServices, state: InitState): Promise<InitOperationResult> {
  await services.workspace.removeTree(initContractDir(services.projectRoot));
  await services.workspace.removeTree(smokePaths(services).root);
  await services.workspace.removeTree(evaluatorReviewPaths(services).root);
  for (const key of [
    "summaryConfirmed", "approvedGoalSha256", "approvedProposalSha256", "contractSpecSha256", "contractManifestSha256",
    "evaluatorReviewManifestSha256", "smokeConfirmed", "smokeReportPath", "smokeReportSha256",
  ]) delete state.answers[key];
  state.execution.operationState = {};
  return { status: "completed", data: { reviseProposal: true } };
}

async function approveSmoke(services: InitServices, state: InitState): Promise<InitOperationResult> {
  const paths = smokePaths(services);
  const reportHash = await services.workspace.sha256(paths.report);
  if (state.answers.smokeReportSha256 !== reportHash) throw new Error("Smoke report changed after it was presented");
  const contract = await validateInitContract(services.projectRoot);
  if (state.answers.contractManifestSha256 !== contract.manifestSha256) throw new Error("Contract changed after smoke validation");
  if (state.answers.evaluatorReviewManifestSha256 !== contract.manifestSha256) {
    throw new Error("Contract does not have an accepted independent evaluator review");
  }
  const goalHash = await services.workspace.sha256(initGoalPath(services.projectRoot));
  if (state.answers.approvedGoalSha256 !== goalHash) throw new Error("Approved goal changed after contract validation");
  const approval = {
    schemaVersion: 1,
    approvedAt: new Date().toISOString(),
    proposalSha256: state.answers.approvedProposalSha256,
    goalSha256: goalHash,
    contractManifestSha256: contract.manifestSha256,
    smokeReportSha256: reportHash,
  };
  await services.workspace.writeText(
    services.workspace.join(services.workspace.flywheelDir, "init", "APPROVED.json"),
    `${JSON.stringify(approval, null, 2)}\n`,
  );
  state.answers.smokeConfirmed = true;
  await services.emit("init.contract.approved", approval);
  return { status: "completed", data: { confirmed: true } };
}

async function smokeConfirmation(
  services: InitServices,
  state: InitState,
  command?: InitCommand,
  signal?: AbortSignal,
): Promise<InitOperationResult> {
  const paths = smokePaths(services);
  if (!command) {
    const report = await runSmokeWithContractRepairs(services, state, signal!);
    state.answers.smokeReportPath = paths.report;
    state.answers.smokeReportSha256 = await services.workspace.sha256(paths.report);
    // This mode is persisted only for new sessions. Historic pending reviews
    // remain explicit; all of approveSmoke's frozen-asset checks still run.
    if (state.confirmationMode === "brief") return await approveSmoke(services, state);
    return {
      status: "waiting_for_user",
      interaction: managerInteraction({
        id: "init.validate_contract",
        operationId: "validate_contract",
        question: "这份初始化试运行报告是否可以作为 v1 基线？",
        description: `${report.trim()}\n\n你可以确认、要求重试、返回修改方案，或继续提问。`,
        options: [
          { value: "confirm", label: "确认并创建 v1" },
          { value: "retry", label: "重新试运行" },
          { value: "revise", label: "修改初始化方案" },
          { value: "reject", label: "暂不继续" },
        ],
      }),
    };
  }
  const value = choice(command.value);
  if (command.inputKind !== "text" && (confirmed(command.value) || value === "confirm")) return await approveSmoke(services, state);
  const retrySmoke = async () => {
    await services.workspace.removeTree(paths.root);
    delete state.answers.smokeReportPath;
    delete state.answers.smokeReportSha256;
    state.execution.operationState = {};
    return await smokeConfirmation(services, state, undefined, signal);
  };
  if (command.inputKind !== "text" && value === "retry") return await retrySmoke();
  if (command.inputKind !== "text" && value === "revise") return await resetToProposal(services, state);
  const report = await services.workspace.readText(paths.report);
  const { decision } = await runInitConversation({
    services,
    sessionKey: "manager",
    label: "init:confirm-smoke",
    allowRetry: true,
    signal,
    prompt: services.prompt("init.smoke.discuss", {
      validation_context: `报告路径：${paths.report}\n\n${report}`,
      user_input: String(command.value),
    }),
  });
  if (decision.action === "confirm") return await approveSmoke(services, state);
  if (decision.action === "retry") return await retrySmoke();
  if (decision.action === "revise") return await resetToProposal(services, state);
  return {
    status: "waiting_for_user",
    interaction: managerInteraction({
      id: "init.validate_contract",
      operationId: "validate_contract",
      question: "是否继续确认这份试运行报告？",
      description: `${decision.message ?? ""}\n\n${report}`.trim(),
      options: [
        { value: "confirm", label: "确认并创建 v1" },
        { value: "retry", label: "重新试运行" },
        { value: "revise", label: "修改初始化方案" },
        { value: "reject", label: "暂不继续" },
      ],
    }),
  };
}

export const validateContractOperation: InitOperation = async ({ services, state, command, signal }) =>
  await smokeConfirmation(services, state, command, signal);

export const createBaselineOperation: InitOperation = async ({ services, state }): Promise<InitOperationResult> => {
      state.inspection = await inspectInit(services.projectRoot, services.process);
      if (state.inspection.status === "ready") {
        // Complete a crash-interrupted binding only for this verified preparation.
        if (state.workflow === "compact" && state.answers.preparationInputs) await writeCompactBaselineBinding(services, state);
        return { status: "completed", data: { baseline: "v1", existing: true } };
      }
      if (state.answers.smokeConfirmed !== true) throw new Error("A confirmed smoke report is required before creating v1");
      if (state.workflow === "compact") {
        const contract = await validateInitContract(services.projectRoot);
        const baselineResult = services.workspace.join(services.workspace.runtimeDir, "preparation-baseline", "result.json");
        if (contract.workflow !== "compact" || contract.manifestSha256 !== state.answers.preparationManifestSha256
          || JSON.stringify(await compactPreparationInputs(services, contract)) !== state.answers.preparationInputs
          || contract.manifestSha256 !== state.answers.contractManifestSha256
          || await services.workspace.sha256(baselineResult) !== state.answers.preparationBaselineSha256
          || await services.workspace.sha256(initGoalPath(services.projectRoot)) !== state.answers.approvedGoalSha256
          || await services.workspace.sha256(proposalDocumentPath(services.projectRoot)) !== state.answers.approvedProposalSha256) {
          throw new Error("Compact preparation assets changed before baseline creation");
        }
      }
      await writeInitManifest(services.projectRoot, state.assistanceRevision);
      if (!await services.version.hasTag("v1")) {
        await services.version.tag("v1", "baseline: init complete");
      }
      if (state.workflow === "compact") await writeCompactBaselineBinding(services, state);
      state.inspection = await inspectInit(services.projectRoot, services.process);
      if (state.inspection.status !== "ready") {
        throw new Error(`Initialization did not become ready: ${state.inspection.problems.join("; ")}`);
      }
      await services.emit("init.baseline.created", { version: "v1" });
  return { status: "completed", data: { baseline: "v1" } };
};
