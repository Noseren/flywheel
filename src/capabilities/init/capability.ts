import { randomUUID } from "node:crypto";
import { COMPACT_ASSISTANCE_REVISION, compactPolicyJob } from "../compact-assistance.ts";
import { openExecutionBudget } from "../../session/execution-budget-store.ts";
import type { ExecutionBudget, ExecutionBudgetLimits } from "../../session/execution-budget.ts";
import path from "node:path";

import type { AgentService } from "../../services/agent/protocol.ts";
import { readJobResult } from "../../services/agent/job-validation.ts";
import { executePersistentAgentJob } from "../../services/agent/session.ts";
import { runStructuredDecision } from "../../services/agent/structured-decision.ts";
import { defaultProcessService, type ProcessService } from "../../services/process/index.ts";
import {
  AgentExecutionError,
  ArtifactValidationError,
  resetArtifactRepairBudget,
  runValidatedArtifact,
  type ArtifactValidationIssue,
} from "../../services/artifact/index.ts";
import { promptAsset } from "../../services/prompt/index.ts";
import { VersionStore } from "../../services/version/index.ts";
import { createWorkspace, createWorkspaceService } from "../../services/workspace/index.ts";
import type { Capability, CapabilityRequest } from "../../session/protocol.ts";
import type { ExecutionPolicy, ExecutionPolicySource } from "../../session/policy.ts";
import { inspectInit } from "./inspector.ts";
import {
  prepareInitIntervention,
  routeInitAgentError,
  routeInitBlockedError,
} from "./manager.ts";
import { createDefaultInitExecutionPolicy } from "./policy.ts";
import type { InitCommand, InitEvent, InitOperationResult, InitServices, InitState } from "./protocol.ts";
import { currentInitOperation } from "./protocol.ts";
import { InitIntakeStore, existingOriginalGoal, originalGoalFromDraft } from "./intake.ts";
import { ensureInitGoal } from "./proposal.ts";
import { InitStore, type InitEventListener } from "./state.ts";

type InitExecutionPolicy = ExecutionPolicy<InitServices, InitState, InitCommand, InitOperationResult>;
type IntakeManagerContext = {
  lane: "intake";
  message: string;
  signal: AbortSignal;
  onEvent?: (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => Promise<void>;
};
type BusinessManagerContext = { state: InitState; message: string; signal: AbortSignal };

const INIT_SERVICE_GRANTS = [
  "agent",
  "artifact",
  "version",
  "workspace",
  "state",
  "prompt",
  "process",
] as const;

/** Bind generic controls to one durable Init state; business sequencing remains in Policy. */
function createInitServices(options: {
  projectRoot: string;
  pluginRoot: string;
  agent: AgentService;
  store: InitStore;
  state: InitState;
  process: ProcessService;
  signal: AbortSignal;
  executionBudget?: ExecutionBudget;
}): InitServices {
  const { projectRoot, pluginRoot, agent, store, state, signal } = options;
  const workspace = createWorkspaceService({ workspace: createWorkspace(projectRoot, pluginRoot) });
  const persistentAgent: AgentService = {
    provider: agent.provider,
    model: agent.model,
    execute: async (job, jobSignal) => await executePersistentAgentJob(agent,
      state.workflow === "compact" ? compactPolicyJob(job, state.assistanceRevision, "init.prepare_compact") : job, {
      capabilityId: "init",
      executionBudget: options.executionBudget,
      delegation: state.workflow === "compact" && !(state.assistanceRevision === COMPACT_ASSISTANCE_REVISION
        && job.operation === "init.prepare_compact" && job.assistance?.revision === COMPACT_ASSISTANCE_REVISION) ? "disabled" : undefined,
      operationId: currentInitOperation(state),
      status: state.status,
      sessions: state.agentSessions ??= {},
      guidance: typeof state.execution.operationState.managerGuidance === "string"
        ? state.execution.operationState.managerGuidance
        : undefined,
      checkpoint: async () => await store.save(state),
      emit: async (type, data) => {
        await store.emit(state, type, data.job === "init:manager"
          ? { ...data, job: "initialization manager" }
          : data);
        await store.save(state);
      },
    }, jobSignal ?? signal),
  };
  return {
    executionBudget: options.executionBudget,
    projectRoot,
    workspace,
    artifact: {
      run: async (request) => await runValidatedArtifact({
        ...request,
        executionBudget: options.executionBudget,
        emit: async (type, data) => {
          await store.emit(state, type, data);
          await store.save(state);
        },
        checkpoint: async () => await store.save(state),
      }),
      readJobResult,
      issues: (error): ArtifactValidationIssue[] | undefined => {
        if (error instanceof AgentExecutionError) return undefined;
        if (error instanceof Error) return [{ code: "artifact.invalid", message: error.message }];
        return [{ code: "artifact.invalid", message: String(error) }];
      },
      jobFailure: (id, message, status = "failed") => new AgentExecutionError(id, message, status),
      invalid: (code, message) => new ArtifactValidationError({ code, message }),
    },
    version: new VersionStore(workspace),
    process: options.process,
    prompt: promptAsset,
    decide: async (request) => {
      await workspace.ensureDir(request.directory);
      const decisionPath = workspace.join(request.directory, `${randomUUID()}.json`);
      return await runStructuredDecision({
        agent: persistentAgent,
        executionBudget: options.executionBudget,
        decisionPath,
        parse: request.parse,
        signal: request.signal,
        job: request.job(decisionPath),
      });
    },
    agent: persistentAgent,
    emit: async (type, data) => {
      await store.emit(state, type, data);
      await store.save(state);
    },
  };
}

/** Init's durable authority envelope. Session owns Policy execution and lifecycle. */
export class InitCapability implements Capability<InitServices, InitState, InitCommand, InitOperationResult> {
  readonly id = "init";
  readonly grants = INIT_SERVICE_GRANTS;
  readonly policyReloadAt = ["inspect", "generate_evaluator", "review_evaluator", "validate_contract"] as const;
  readonly projectRoot: string;
  readonly pluginRoot: string;
  readonly agent: AgentService;
  readonly process: ProcessService;
  readonly store: InitStore;
  readonly initialGoal?: string;
  readonly confirmationMode: "brief" | "review";
  readonly workflow: "compact" | "legacy";
  readonly budgetLimits?: Partial<ExecutionBudgetLimits>;
  private executionBudget?: ExecutionBudget;
  private assistancePolicyRevision?: string;
  private intakeTail: Promise<unknown> = Promise.resolve();
  private intakeSealed = false;
  readonly policySource: ExecutionPolicySource<InitServices, InitState, InitCommand, InitOperationResult>;

  constructor(options: {
    projectRoot: string;
    agent: AgentService;
    pluginRoot?: string;
    process?: ProcessService;
    promptRoot?: string;
    initialGoal?: string;
    confirmationMode?: "brief" | "review";
    workflow?: "compact" | "legacy";
    budgetLimits?: Partial<ExecutionBudgetLimits>;
    policy?: InitExecutionPolicy;
    policySource?: ExecutionPolicySource<InitServices, InitState, InitCommand, InitOperationResult>;
  }) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.pluginRoot = path.resolve(options.pluginRoot ?? path.join(import.meta.dirname, "..", "..", "..", ".."));
    this.agent = options.agent;
    this.initialGoal = options.initialGoal?.trim() ? options.initialGoal : undefined;
    this.workflow = options.workflow ?? "compact";
    this.confirmationMode = options.confirmationMode ?? (this.workflow === "compact" ? "brief" : "review");
    this.budgetLimits = options.budgetLimits;
    this.process = options.process ?? defaultProcessService;
    this.store = new InitStore(this.projectRoot);
    this.policySource = options.policySource ?? (options.policy
      ? () => options.policy!
      : () => createDefaultInitExecutionPolicy(this.assistancePolicyRevision));
  }

  async createState(): Promise<InitState> {
    this.assistancePolicyRevision = this.workflow === "compact" ? COMPACT_ASSISTANCE_REVISION : undefined;
    if (this.workflow === "compact") this.executionBudget = await openExecutionBudget(this.projectRoot, this.budgetLimits);
    const timestamp = new Date().toISOString();
    if (this.confirmationMode !== "brief" || this.initialGoal) {
      await ensureInitGoal(this.projectRoot, this.initialGoal, this.confirmationMode === "brief");
    }
    return {
      schemaVersion: 3,
      ...(this.workflow === "compact" ? { workflow: "compact" as const, assistanceRevision: COMPACT_ASSISTANCE_REVISION } : {}),
      capabilityRunId: randomUUID(),
      projectRoot: this.projectRoot,
      status: "running",
      inspection: await inspectInit(this.projectRoot, this.process),
      execution: {
        policy: { id: "", revision: "" },
        policyState: {},
        operationState: {},
      },
      answers: this.initialGoal ? { initialGoal: this.initialGoal } : {},
      confirmationMode: this.confirmationMode,
      agentSessions: {},
      eventSequence: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  async prepare(state: InitState, request: CapabilityRequest, signal: AbortSignal): Promise<InitState> {
    this.assistancePolicyRevision = state.assistanceRevision;
    if (state.workflow === "compact") this.executionBudget = await openExecutionBudget(this.projectRoot, this.budgetLimits);
    if (state.projectRoot !== this.projectRoot) {
      throw new Error("Init state belongs to a different project root");
    }
    if (state.confirmationMode !== "brief" || typeof state.answers.initialGoal === "string") {
      await ensureInitGoal(this.projectRoot,
        typeof state.answers.initialGoal === "string" ? state.answers.initialGoal : undefined,
        state.confirmationMode === "brief");
    }
    if (request.type === "command") {
      if (state.status !== "waiting_for_user" || !state.pendingInteraction) {
        throw new Error("Init is not waiting for user input");
      }
      const command = request.command as InitCommand;
      if (command.type !== "interaction.respond" || command.interactionId !== state.pendingInteraction.id) {
        throw new Error(`Unexpected interaction response: ${command.interactionId}`);
      }
      const interaction = state.pendingInteraction;
      state.status = "running";
      delete state.pendingInteraction;
      await this.store.emit(state, "interaction.resolved", {
        interactionId: command.interactionId,
        interaction,
        value: command.value,
      });
      return state;
    }
    if (state.status === "completed") {
      const inspection = await inspectInit(this.projectRoot, this.process);
      if (inspection.status !== "ready") {
        throw new Error(`Completed init is no longer valid:\n${inspection.problems.join("\n")}`);
      }
      return state;
    }
    if (request.type === "resume" && state.pendingInteraction?.id === "init.goal") {
      const draft = await new InitIntakeStore(this.projectRoot).load();
      if (originalGoalFromDraft(draft)) {
        state.status = "running";
        delete state.pendingInteraction;
      }
    }
    if (state.status === "blocked" || state.status === "paused") {
      state.status = "running";
      resetArtifactRepairBudget(state.execution.operationState);
      delete state.lastError;
      await this.store.emit(state, "init.retrying", { operationId: currentInitOperation(state) });
    }
    return state;
  }

  services(state: InitState, signal: AbortSignal): InitServices {
    return createInitServices({
      projectRoot: this.projectRoot,
      pluginRoot: this.pluginRoot,
      agent: this.agent,
      store: this.store,
      state,
      process: this.process,
      signal,
      executionBudget: state.workflow === "compact" ? this.executionBudget : undefined,
    });
  }

  /** Only the pre-contract conversation lane may run beside read-only exploration. */
  readonly conversation = {
    canAccept: (state?: InitState): boolean => (state ? state.confirmationMode : this.confirmationMode) === "brief"
      && !(state?.answers.initialGoal ?? this.initialGoal) && !this.intakeSealed,
    receive: async ({ message, signal, onEvent }: {
      message: string;
      signal: AbortSignal;
      onEvent?: (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => Promise<void>;
    }): Promise<{ message: string }> => {
      const run = this.intakeTail.then(async () => await new InitIntakeStore(this.projectRoot).exclusive(
        async () => await this.manager.onIntervention({ lane: "intake", message, signal, onEvent })));
      this.intakeTail = run.catch(() => undefined);
      return await run;
    },
    apply: async (state: InitState): Promise<void> => {
      if (state.confirmationMode !== "brief") return;
      if (state.answers.initialGoal) { this.intakeSealed = true; return; }
      await this.intakeTail;
      const draft = await new InitIntakeStore(this.projectRoot).load();
      this.intakeSealed = draft.sealed === true;
      if (draft.agentSessions.manager) (state.agentSessions ??= {}).manager = draft.agentSessions.manager;
    },
  };

  private async receiveIntake(message: string, signal: AbortSignal,
    onEvent?: (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => Promise<void>,
  ): Promise<{ message: string }> {
      signal.throwIfAborted();
      const intake = new InitIntakeStore(this.projectRoot);
      const executionBudget = await openExecutionBudget(this.projectRoot, this.budgetLimits);
      const { draft } = await intake.receive(message);
      const directory = path.join(this.projectRoot, ".flywheel", "init", "intake");
      const workspace = createWorkspaceService({ workspace: createWorkspace(this.projectRoot, this.pluginRoot) });
      await workspace.ensureDir(directory);
      const decisionPath = path.join(directory, `${randomUUID()}.json`);
      const agent: AgentService = {
        execute: async (job, jobSignal) => await executePersistentAgentJob(this.agent, job, {
          capabilityId: "init", operationId: "intake", status: "running", sessions: draft.agentSessions,
          executionBudget, delegation: "disabled",
          checkpoint: async () => await intake.save(draft),
          emit: async (type, data) => { await onEvent?.(type, data); },
        }, jobSignal),
      };
      const { decision } = await runStructuredDecision({
        agent, decisionPath, signal, executionBudget,
        parse: value => {
          const data = value as { message?: unknown; goalMessageIds?: unknown };
          if (!data || typeof data.message !== "string" || !data.message.trim()
            || !Array.isArray(data.goalMessageIds) || !data.goalMessageIds.every(id => typeof id === "string")) {
            throw new Error("Intake requires a reply and original goal message IDs");
          }
          const next = { ...draft, goalMessageIds: data.goalMessageIds as string[] };
          originalGoalFromDraft(next); // Reject invented references without interpreting intent.
          return { message: data.message, goalMessageIds: next.goalMessageIds };
        },
        job: {
          operation: "manager", label: "init:manager", audience: "user", cwd: this.projectRoot,
          tools: ["Read", "Write"], readRoots: [this.projectRoot], writeRoots: [directory],
          deniedPaths: [workspace.runtimeDir], sessionKey: "manager",
          prompt: promptAsset("init.intake.discuss", {
            messages: draft.messages, previous_goal_message_ids: draft.goalMessageIds,
            frozen_goal: await existingOriginalGoal(this.projectRoot), decision_path: decisionPath,
          }),
        },
      });
      signal.throwIfAborted();
      // An initial goal supplied through another authorized entry cannot be replaced.
      if (await existingOriginalGoal(this.projectRoot) !== undefined) {
        throw new Error("Original goal has already been frozen; use controlled goal change");
      }
      draft.goalMessageIds = decision.goalMessageIds;
      await intake.save(draft);
      return { message: decision.message };
  }

  private onManagerIntervention(context: BusinessManagerContext): Promise<InitState>;
  private onManagerIntervention(context: IntakeManagerContext): Promise<{ message: string }>;
  private async onManagerIntervention(context: BusinessManagerContext | IntakeManagerContext): Promise<InitState | { message: string }> {
    // Both input lanes enter the same Manager lifecycle hook. The intake lane has
    // no business-state reference and cannot save a stale runner snapshot.
    if ("lane" in context) return await this.receiveIntake(context.message, context.signal, context.onEvent);
    this.assistancePolicyRevision = context.state.assistanceRevision;
    return await prepareInitIntervention(this.managerContext(context.state, context.signal), context.message);
  }

  readonly manager = {
    onIntervention: this.onManagerIntervention.bind(this),
    onFailure: async ({ state, error, signal }: {
      state: InitState;
      error: unknown;
      signal: AbortSignal;
    }): Promise<{ message?: string; action?: "stay_blocked" | "retry" }> => {
      if (state.workflow === "compact") return { action: "stay_blocked" };
      if (error instanceof AgentExecutionError) {
        const retry = await routeInitAgentError(this.managerContext(state, signal), error);
        return {
          ...(state.lastError ? { message: state.lastError } : {}),
          action: retry ? "retry" : "stay_blocked",
        };
      }
      await routeInitBlockedError(this.managerContext(state, signal), error, "runtime", true);
      return state.lastError ? { message: state.lastError } : {};
    },
  };

  failureMode(error: unknown): "retryable" | "blocked" {
    return error instanceof AgentExecutionError ? "retryable" : "blocked";
  }

  subscribe(listener: InitEventListener): () => void {
    return this.store.subscribe(listener);
  }

  async history(): Promise<InitEvent[]> {
    return await this.store.history();
  }

  private managerContext(state: InitState, signal: AbortSignal) {
    return {
      projectRoot: this.projectRoot,
      store: this.store,
      state,
      services: this.services(state, signal),
      signal,
    };
  }
}
