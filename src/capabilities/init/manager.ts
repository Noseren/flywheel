import { AgentExecutionError } from "../../services/artifact/index.ts";
import type { InitStore } from "../../capabilities/init/state.ts";
import { proposalSummary } from "./proposal.ts";
import { existingOriginalGoal } from "./intake.ts";
import { currentInitOperation, type InitServices, type InitState } from "./protocol.ts";

interface InitManagerDecision {
  action: "stay_paused" | "resume";
  message: string;
  guidance?: string;
}

function parseManagerDecision(value: unknown): InitManagerDecision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Init Manager decision must be an object");
  }
  const decision = value as Record<string, unknown>;
  if (!["stay_paused", "resume"].includes(String(decision.action))) {
    throw new Error("Init Manager returned an unsupported action");
  }
  if (typeof decision.message !== "string" || !decision.message.trim()) {
    throw new Error("Init Manager must provide a user-facing message");
  }
  const guidance = typeof decision.guidance === "string" ? decision.guidance.trim() : "";
  return {
    action: decision.action as InitManagerDecision["action"],
    message: decision.message.trim(),
    ...(guidance ? { guidance } : {}),
  };
}

async function runInitManager(options: {
  services: InitServices;
  projectRoot: string;
  context: Record<string, unknown>;
  messageSource?: string;
  userMessage: string;
  signal: AbortSignal;
}): Promise<{ decision: InitManagerDecision }> {
  const turnsDir = options.services.workspace.join(
    options.services.workspace.runtimeDir,
    "conversation",
    "init",
  );
  return await options.services.decide({
    directory: turnsDir,
    parse: parseManagerDecision,
    signal: options.signal,
    job: (decisionPath) => ({
      operation: "manager",
      label: "init:manager",
      audience: "user",
      cwd: options.projectRoot,
      tools: ["Write"],
      readRoots: [options.projectRoot],
      writeRoots: [turnsDir],
      sessionKey: "manager",
      prompt: options.services.prompt("common.manager-decision", {
        capability: "init",
        runtime_context: options.context,
        message_source: options.messageSource ?? "用户刚才说",
        user_message: options.userMessage,
        decision_path: decisionPath,
      }),
    }),
  });
}

interface InitManagerContext {
  projectRoot: string;
  store: InitStore;
  state: InitState;
  services: InitServices;
  signal: AbortSignal;
}

export async function prepareInitIntervention(
  context: InitManagerContext,
  message: string,
): Promise<InitState> {
  const { projectRoot, state, store, services, signal } = context;
  const proposal = state.proposal;
  const proposalText = proposal
    ? await proposalSummary(proposal, projectRoot).catch(() => undefined)
    : undefined;
  const originalGoal = await existingOriginalGoal(projectRoot);
  try {
    const { decision } = await runInitManager({
      services,
      projectRoot,
      signal,
      userMessage: message,
      context: {
        status: state.status,
        operation: currentInitOperation(state),
        lastOutcome: state.execution.lastOutcome,
        lastError: state.lastError,
        pendingInteraction: state.pendingInteraction,
        previousGuidance: state.execution.operationState.managerGuidance,
        inspection: { status: state.inspection.status, problems: state.inspection.problems },
        originalGoal,
        proposal: proposal ? {
          artifactPath: proposal.artifactPath,
          documentPath: proposal.documentPath,
          content: proposalText,
        } : undefined,
        allowedActions: ["stay_paused", "resume"],
        immutableBoundaries: ["Runtime operation", "validated proposal and contract", "evaluation", "red lines"],
      },
    });
    if (decision.guidance) state.execution.operationState.managerGuidance = decision.guidance;
    else delete state.execution.operationState.managerGuidance;
    state.status = "paused";
    if (decision.action === "resume") delete state.pendingInteraction;
    await store.emit(state, "manager.responded", {
      job: "initialization manager",
      action: decision.action,
      message: decision.message,
      ...(decision.guidance ? { guidance: decision.guidance } : {}),
    });
    await store.save(state);
    if (decision.action === "resume") {
      state.status = "running";
      delete state.lastError;
      await store.save(state);
    }
    return state;
  } catch (error) {
    if (signal.aborted) {
      state.status = "paused";
      state.execution.lastOutcome = {
        operationId: currentInitOperation(state),
        status: "paused",
      };
      await store.emit(state, "init.paused", { reason: "用户请求中断" });
      await store.save(state);
      return state;
    }
    state.status = "blocked";
    state.lastError = `初始化管理 Agent 无法处理这条消息：${error instanceof Error ? error.message : String(error)}`;
    await store.emit(state, "init.blocked", { error: state.lastError, source: "manager" });
    await store.save(state);
    return state;
  }
}

/** A valid failed/needs_input result may receive Manager guidance and retry. */
export async function routeInitAgentError(
  context: InitManagerContext,
  error: AgentExecutionError,
): Promise<boolean> {
  const { projectRoot, state, store, services, signal } = context;
  const { decision } = await runInitManager({
    services,
    projectRoot,
    signal,
    messageSource: "Runtime 刚刚路由的 Service 结果",
    userMessage: `${error.status}: ${error.message}`,
    context: {
      status: state.status,
      operation: currentInitOperation(state),
      serviceResult: { status: error.status, message: error.message },
      originalGoal: await existingOriginalGoal(projectRoot),
      inspection: { status: state.inspection.status, problems: state.inspection.problems },
      allowedActions: ["stay_paused", "resume"],
      immutableBoundaries: ["Runtime operation", "validated proposal and contract", "evaluation", "red lines"],
    },
  });
  if (decision.guidance) state.execution.operationState.managerGuidance = decision.guidance;
  if (decision.action === "resume") {
    await store.emit(state, "manager.responded", {
      source: "service_result", action: "resume", status: error.status, message: decision.message,
    });
    await store.save(state);
    return true;
  }
  state.status = "blocked";
  state.lastError = decision.message;
  await store.emit(state, "manager.responded", {
    source: "service_result",
    action: "stay_paused",
    status: error.status,
    message: decision.message,
    ...(decision.guidance ? { guidance: decision.guidance } : {}),
  });
  await store.emit(state, "init.blocked", {
    error: decision.message, source: "capability_manager", serviceStatus: error.status,
  });
  await store.save(state);
  return false;
}

/** Manager explains an invariant failure but cannot change its authoritative blocked state. */
export async function routeInitBlockedError(
  context: InitManagerContext,
  error: unknown,
  source = "runtime",
  alreadyRecorded = false,
): Promise<void> {
  const { projectRoot, state, store, services, signal } = context;
  const message = error instanceof Error ? error.message : String(error);
  state.status = "blocked";
  state.lastError = message;
  if (!alreadyRecorded) await store.emit(state, "init.blocked", { error: message, source });
  await store.save(state);
  try {
    const { decision } = await runInitManager({
      services,
      projectRoot,
      signal,
      messageSource: "Runtime 刚刚判定的不可自动恢复错误",
      userMessage: message,
      context: {
        status: "blocked",
        operation: currentInitOperation(state),
        invariantFailure: { source, message },
        originalGoal: await existingOriginalGoal(projectRoot),
        allowedActions: ["stay_paused"],
        immutableBoundaries: ["Runtime state", "validated contract", "path and hash checks", "version boundary"],
      },
    });
    if (decision.guidance) state.execution.operationState.managerGuidance = decision.guidance;
    await store.emit(state, "manager.responded", {
      source: "invariant_failure",
      action: "stay_paused",
      requestedAction: decision.action,
      message: decision.message,
      ...(decision.guidance ? { guidance: decision.guidance } : {}),
    });
  } catch {
    // The Runtime error is already durable; a Manager failure cannot replace it.
  }
  state.status = "blocked";
  state.lastError = message;
  await store.save(state);
}
