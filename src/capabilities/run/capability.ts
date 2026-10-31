import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { defaultProcessService } from "../../services/process/index.ts";
import { openExecutionBudget } from "../../session/execution-budget-store.ts";
import type { ExecutionBudget, ExecutionBudgetLimits } from "../../session/execution-budget.ts";
import { createCompactRunExecutionPolicy } from "./policy/compact.ts";
import { isCompactAssistanceRevision, compactPolicyJob } from "../compact-assistance.ts";
import { COMPONENT_ROUTING_REVISION } from "../component-routing-revision.ts";

import type { AgentService } from "../../services/agent/protocol.ts";
import { executePersistentAgentJob } from "../../services/agent/session.ts";
import { readJobResult } from "../../services/agent/job-validation.ts";
import {
  runValidatedArtifact,
  resetArtifactRepairBudget,
} from "../../services/artifact/index.ts";
import { PromptAssetStore, promptAsset } from "../../services/prompt/index.ts";
import { createSearchService } from "../../services/search/index.ts";
import type { PolicyActivationPending, PolicyRevisionCandidate } from "./state.ts";
import { createVersionService, type VersionRecordStore, type VersionStore } from "../../services/version/index.ts";
import { createWorkspaceService, sha256, sha256Files } from "../../services/workspace/index.ts";
import {
  assertPolicyServiceGrants,
  loadExecutionPolicy,
  trustedModuleExecutionPolicySource,
  type ExecutionPolicySource,
  type PolicyOutcome,
} from "../../session/policy.ts";
import type { Capability, CapabilityRequest } from "../../session/protocol.ts";
import { handleRunIntervention, runManagerForFailure } from "./manager.ts";
import {
  createDefaultRunExecutionPolicy,
  type RunExecutionPolicy,
  type RunOperationResult,
  type RunPolicyServices,
} from "./policy.ts";
import { loadRuntimeBoundary, type Project } from "./project.ts";
import type { RunEvent, RunOperationId, RunState } from "./protocol.ts";
import type { RunCommand } from "./protocol.ts";
import { StateStore, now } from "./state.ts";

export class RunBlocked extends Error {}

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

/** Run is an authority envelope. Session executes Policy; this class only wires grants and guards. */
export class RunCapability implements Capability<RunPolicyServices, RunState, RunCommand> {
  readonly id = "run";
  readonly grants = ["agent", "artifact", "workspace", "state", "version", "search", "prompt", "process"] as const;
  readonly policyReloadAt = ["tasking", "evaluate", "assess_target", "propose"] as const;
  readonly project: Project;
  readonly store: StateStore;
  readonly versions: VersionStore;
  readonly records: VersionRecordStore;
  readonly policySource: ExecutionPolicySource<RunPolicyServices, RunState, RunCommand, RunOperationResult>;
  private readonly agent: AgentService;
  private readonly prompts: PromptAssetStore;
  private readonly search;
  private readonly workspace;
  private readonly maxIterations?: number;
  private readonly concurrency: number;
  private readonly allowDynamicPolicy: boolean;
  private checkpointQueue: Promise<void> = Promise.resolve();
  private operationFingerprint?: string;
  private executionBudget?: ExecutionBudget;
  private assistancePolicyRevision?: string;
  private readonly budgetLimits?: Partial<ExecutionBudgetLimits>;

  constructor(project: Project, agent: AgentService, options: {
    concurrency?: number;
    maxIterations?: number;
    budgetLimits?: Partial<ExecutionBudgetLimits>;
    policy?: RunExecutionPolicy;
    policySource?: ExecutionPolicySource<RunPolicyServices, RunState, RunCommand, RunOperationResult>;
    promptRoot?: string;
    /** Agent-authored Policy modules execute in-process and are restricted to explicit developer mode. */
    allowDynamicPolicy?: boolean;
  } = {}) {
    this.project = project;
    this.agent = agent;
    this.prompts = new PromptAssetStore({ projectRoot: project.root, configuredRoot: options.promptRoot });
    const version = createVersionService(project);
    this.versions = version.snapshots;
    this.records = version.records;
    this.store = new StateStore(project);
    this.search = createSearchService(options.concurrency ?? 8);
    this.concurrency = options.concurrency ?? 8;
    this.workspace = createWorkspaceService({ workspace: project });
    this.maxIterations = options.maxIterations;
    this.budgetLimits = options.budgetLimits;
    this.allowDynamicPolicy = options.allowDynamicPolicy === true;
    const fallback = options.policySource ?? (() => options.policy ?? (project.workflow === "compact"
      ? createCompactRunExecutionPolicy(this.assistancePolicyRevision) : createDefaultRunExecutionPolicy()));
    this.policySource = async () => await this.loadActivePolicy(fallback);
  }

  private async loadPolicyCandidate(candidate: PolicyRevisionCandidate): Promise<RunExecutionPolicy> {
    const modulePath = await this.records.resolveRef(candidate.module);
    if (!modulePath) throw new Error("Policy candidate module must be a project-local staged file");
    const policy = await loadExecutionPolicy(
      trustedModuleExecutionPolicySource<RunPolicyServices, RunState, RunCommand, RunOperationResult>(modulePath),
    );
    if (policy.id !== candidate.policyId
      || !(policy.revision === candidate.revision || policy.revision.startsWith(`${candidate.revision}+`))) {
      throw new Error(`Policy candidate identity does not match its module export`);
    }
    assertPolicyServiceGrants(policy, this.grants);
    return policy;
  }

  private async loadActivePolicy(
    fallback: ExecutionPolicySource<RunPolicyServices, RunState, RunCommand, RunOperationResult>,
  ): Promise<RunExecutionPolicy> {
    if (!this.allowDynamicPolicy) return await loadExecutionPolicy(fallback);
    const active = await this.records.active<PolicyRevisionCandidate>("policy");
    const pending = await this.records.active<PolicyActivationPending>("policy-pending");
    let candidate = active;
    let activatingPending = false;
    let activationOperation: string | undefined;
    if (pending && pending.candidateId !== active?.id) {
      try { activationOperation = (await this.store.load()).execution.currentOperationId; }
      catch { /* A newly created Run may activate an approved Policy at its entry. */ }
      if (!activationOperation || this.policyReloadAt.some((operation) => operation === activationOperation)) {
        candidate = await this.records.load<PolicyRevisionCandidate>("policy", pending.candidateId);
        activatingPending = true;
      }
    }
    if (!candidate) return await loadExecutionPolicy(fallback);
    try {
      const policy = await this.loadPolicyCandidate(candidate);
      if (activatingPending) {
        if (activationOperation && !(activationOperation in policy.operations)) {
          throw new Error(`Policy candidate cannot resume safe operation ${activationOperation}`);
        }
        await this.records.activate("policy", candidate.id);
      }
      return policy;
    } catch (error) {
      await this.records.write("policy-failure", {
        id: `activation-failure-${randomUUID()}`,
        candidateId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
        failedAt: now(),
      });
      if (activatingPending && pending) await this.records.rollback("policy-pending", pending.id);
      else await this.records.rollback("policy", candidate.id);
      const restored = await this.records.active<PolicyRevisionCandidate>("policy");
      return restored ? await this.loadPolicyCandidate(restored) : await loadExecutionPolicy(fallback);
    }
  }

  async createState(): Promise<RunState> {
    this.assistancePolicyRevision = this.project.assistanceRevision;
    if (this.project.workflow === "compact") this.executionBudget = await openExecutionBudget(this.project.root, this.budgetLimits);
    const required = [
      ...(this.project.frozenContractFiles ?? []),
      ...[this.project.goalPath].filter((item): item is string => !!item),
      this.project.taskPath, this.project.boundaryPath, this.project.taskingGuidePath,
      this.project.evaluateGuidePath, this.project.evaluatorPath,
      ...[this.project.collectorPath, this.project.collectorGuidePath].filter((item): item is string => !!item),
      ...[this.project.trainsetPath, this.project.holdoutPath].filter((item): item is string => !!item),
    ];
    for (const file of required) if (!await exists(file)) throw new Error(`Missing required Flywheel contract: ${file}`);
    if (!await this.versions.hasTag("v1")) throw new Error("Missing v1 baseline snapshot");
    const contractsDir = path.join(this.project.runtimeDir, "contracts");
    await mkdir(contractsDir, { recursive: true });
    await copyFile(this.project.evaluatorPath, this.project.frozenEvaluatorPath);
    if (this.project.goalPath) await copyFile(this.project.goalPath, path.join(contractsDir, "goal.md"));
    await copyFile(this.project.taskPath, path.join(contractsDir, "task.md"));
    await copyFile(this.project.boundaryPath, path.join(contractsDir, "boundary.json"));
    if (this.project.collectorPath) await copyFile(this.project.collectorPath, this.frozenCollectorPath());
    if (this.project.collectorGuidePath) await copyFile(this.project.collectorGuidePath, this.frozenCollectorGuidePath());
    const timestamp = now();
    return {
      ...(this.project.workflow === "compact" ? { workflow: "compact" as const, compact: {
        attempts: 0, history: [], frozenFiles: await Promise.all([...new Set([...required, this.project.verificationPath!])]
          .map(async (file) => ({ path: file, sha256: await sha256(file) }))),
      } } : {}),
      ...(this.project.assistanceRevision ? { assistanceRevision: this.project.assistanceRevision } : {}),
      schemaVersion: 3, status: "running",
      execution: { policy: { id: "", revision: "" }, policyState: {}, operationState: {} },
      iteration: 1, refineAttempt: 1,
      ...(this.maxIterations !== undefined ? { maxIterations: this.maxIterations } : {}),
      capabilityRunId: randomUUID(), episodeId: `episode-${randomUUID()}`,
      agentStateId: "", steeringRevisionId: "",
      evaluatorSha256: await sha256(this.project.evaluatorPath),
      ...(this.project.collectorPath ? { collectorSha256: await sha256(this.project.collectorPath) } : {}),
      ...(this.project.collectorGuidePath
        ? { collectorGuideSha256: await sha256(this.project.collectorGuidePath) } : {}),
      contractSha256: await sha256Files([this.project.taskPath, this.project.boundaryPath]),
      ...(this.project.goalPath ? { goalSha256: await sha256(this.project.goalPath) } : {}),
      agentSessions: {}, createdAt: timestamp, updatedAt: timestamp,
    };
  }

  async prepare(state: RunState, request: CapabilityRequest, signal: AbortSignal): Promise<RunState> {
    this.assistancePolicyRevision = state.assistanceRevision;
    if (state.workflow === "compact") {
      this.executionBudget = await openExecutionBudget(this.project.root, this.budgetLimits);
      if (request.type === "command" && ["steering.propose", "steering.resolve", "policy.activate"].includes((request.command as { type: string }).type)) {
        throw new Error("Compact tasks freeze their goal and evaluation; prepare a new task to change them. Existing history is preserved.");
      }
      if (state.assistanceRevision === COMPONENT_ROUTING_REVISION
        && (request.type === "resume" || request.type === "start") && state.status === "paused"
        && state.execution.currentOperationId === "assess_target"
        && state.compact?.routing?.assessment?.decision === "achieved") {
        state.compact.routing.next = "route_r3";
        state.compact.routing.stopRequested = false;
        state.execution.currentOperationId = "route_r3";
        delete state.execution.lastOutcome;
        state.execution.operationState = {};
      } else if (state.assistanceRevision === COMPONENT_ROUTING_REVISION
        && (request.type === "resume" || request.type === "start") && state.status === "paused"
        && state.execution.currentOperationId === "assess_target"
        && state.compact?.routing?.assessment?.decision === "not_achieved") {
        // Validate the cached binding before routing an explicitly resumed negative verdict.
        state.compact.routing.stopRequested = false;
        delete state.execution.lastOutcome;
        state.execution.operationState = {};
      } else if (state.assistanceRevision !== COMPONENT_ROUTING_REVISION
        && (request.type === "resume" || request.type === "start") && state.status === "paused"
        && !state.compact?.candidate && state.compact?.baselineResultPath
        && ["verify", "retain"].includes(state.execution.currentOperationId ?? "")) {
        state.execution.currentOperationId = "optimize";
        delete state.execution.lastOutcome;
        state.execution.operationState = {};
      }
    }
    if (request.type === "command") {
      const command = request.command as { type: string; interactionId?: unknown; value?: unknown };
      if (command.type === "policy.activate" && !this.allowDynamicPolicy) {
        throw new Error("Dynamic Policy activation is disabled outside explicit developer mode");
      }
      if (["steering.propose", "steering.resolve", "policy.activate"].includes(command.type)) {
        if (state.pendingRunCommand || state.adminReturn) throw new Error("A Run administrative command is already pending");
        const admin = command as unknown as RunCommand;
        if ((admin.type === "steering.resolve" || admin.type === "policy.activate")
          && (!("candidateId" in admin) || typeof admin.candidateId !== "string" || !admin.candidateId)) {
          throw new Error(`${admin.type} requires candidateId`);
        }
        state.adminReturn = {
          status: state.status,
          ...(state.execution.currentOperationId ? { currentOperationId: state.execution.currentOperationId } : {}),
          ...(state.execution.lastOutcome ? { lastOutcome: structuredClone(state.execution.lastOutcome) } : {}),
          operationState: structuredClone(state.execution.operationState),
          ...(state.pendingInteraction ? { pendingInteraction: structuredClone(state.pendingInteraction) } : {}),
          ...(state.lastError ? { lastError: state.lastError } : {}),
        };
        state.pendingRunCommand = admin;
        delete state.commandResult;
        delete state.pendingInteraction;
        delete state.lastError;
        state.status = "running";
        delete state.execution.currentOperationId;
        delete state.execution.lastOutcome;
        state.execution.operationState = {};
        return state;
      }
      if (command.type !== "interaction.respond" || !["run-proposal-input", "run-selection-input"].includes(String(command.interactionId))
        || state.status !== "waiting_for_user" || state.pendingInteraction?.id !== command.interactionId
        || !["propose", "select"].includes(state.execution.currentOperationId ?? "")) {
        throw new Error(`Unexpected run interaction: ${command.interactionId}`);
      }
      state.execution.operationState.managerGuidance = String(command.value).trim()
        || "请重新检查当前建议和全部证据";
      if (state.execution.currentOperationId === "propose") state.execution.operationState.proposalRetry = true;
      else state.execution.operationState.selectionRetry = true;
      resetArtifactRepairBudget(state.execution.operationState);
      delete state.pendingInteraction;
      delete state.lastError;
      state.status = "running";
      return state;
    }
    if ((request.type === "resume" || request.type === "start") && state.adminReturn) {
      const continuation = state.adminReturn;
      state.status = continuation.status;
      state.execution.currentOperationId = continuation.currentOperationId;
      state.execution.lastOutcome = continuation.lastOutcome;
      state.execution.operationState = continuation.operationState;
      state.pendingInteraction = continuation.pendingInteraction;
      state.lastError = continuation.lastError;
      delete state.adminReturn;
    }
    if (request.type === "resume" && state.status === "blocked") resetArtifactRepairBudget(state.execution.operationState);
    if ((request.type === "resume" && ["blocked", "paused"].includes(state.status))
      || (request.type === "start" && state.status === "paused")) {
      state.status = "running";
      delete state.lastError;
    }
    return state;
  }

  services(state: RunState): RunPolicyServices {
    const checkpoint = async () => {
      const save = this.checkpointQueue.then(async () => await this.store.save(state));
      this.checkpointQueue = save.catch(() => undefined);
      await save;
    };
    return {
      project: this.project,
      process: defaultProcessService,
      rawAgent: this.agent,
      executionBudget: this.executionBudget,
      agent: {
        provider: this.agent.provider,
        model: this.agent.model,
        execute: async (current, job, signal) => await executePersistentAgentJob(this.agent,
          current.workflow === "compact" ? compactPolicyJob(job, current.assistanceRevision, "optimize") : job, {
          capabilityId: this.id,
          operationId: current.execution.currentOperationId ?? "run",
          status: current.status,
          sessions: current.agentSessions ??= {},
          concurrency: this.concurrency,
          executionBudget: this.executionBudget,
          ...(current.workflow === "compact" && !(isCompactAssistanceRevision(current.assistanceRevision)
            && job.operation === "optimize" && job.assistance?.revision === current.assistanceRevision)
            ? { delegation: "disabled" as const } : {}),
          guidance: typeof current.execution.operationState.managerGuidance === "string"
            ? current.execution.operationState.managerGuidance : undefined,
          checkpoint,
          emit: async (type, data) => { await this.store.emit(current, type, data); },
        }, signal),
      },
      artifact: {
        run: async (current, options) => await runValidatedArtifact({
          artifactId: options.artifactId, operationId: options.operationId, job: options.job,
          operationState: current.execution.operationState, signal: options.signal,
          present: options.present, validate: options.validate, classify: options.classify,
          execute: options.execute,
          emit: async (type, data) => { await this.store.emit(current, type as RunEvent["type"], data); },
          checkpoint,
        }),
        readJobResult,
      },
      workspace: this.workspace,
      state: {
        id: (prefix) => `${prefix}-${randomUUID()}`,
        now,
        emit: async (current, type, data) => { await this.store.emit(current, type as RunEvent["type"], data); },
        checkpoint: async () => await checkpoint(),
      },
      version: {
        records: this.records,
        hasTag: async (tag) => await this.versions.hasTag(tag),
        assertExact: async (tag) => await this.versions.assertExact(tag),
        changedFiles: async (from, to) => await this.versions.changedFiles(from, to),
        diff: async (from, to) => await this.versions.diff(from, to),
        treeHash: async (tag) => await this.versions.treeHash(tag),
        createWorktree: async (tag, destination) => await this.versions.createWorktree(tag, destination),
        worktreeChanges: async (destination) => await this.versions.worktreeChanges(destination),
        worktreeTreeHash: async (destination) => await this.versions.worktreeTreeHash(destination),
        promoteWorktree: async (destination, tag, message) =>
          await this.versions.promoteWorktree(destination, tag, message),
        prepare: async (target) => await this.versions.prepare(target),
        tag: async (tag, message) => await this.versions.tag(tag, message),
      },
      search: this.search,
      guard: {
        project: async <T>(current: RunState, label: string, execute: () => Promise<T>) => {
          const before = await this.projectWriteSnapshot(current);
          let value: T | undefined;
          let failure: unknown;
          try { value = await execute(); } catch (error) { failure = error; }
          const after = await this.projectWriteSnapshot(current);
          const changed = this.changedSnapshotPaths(before, after);
          if (changed.length) {
            throw new RunBlocked(`Job ${label} modified the formal project outside its write roots: ${changed.join(", ")}`);
          }
          if (failure !== undefined) throw failure;
          return value as T;
        },
        worktree: async <T>(root: string, label: string, execute: () => Promise<T>) => {
          const before = await this.worktreeWriteSnapshot(root);
          let value: T | undefined;
          let failure: unknown;
          try { value = await execute(); } catch (error) { failure = error; }
          const after = await this.worktreeWriteSnapshot(root);
          if (before.diff !== after.diff) {
            const changed = this.changedSnapshotPaths(before.contents, after.contents);
            if (!changed.length) changed.push(...[...new Set([...before.contents.keys(), ...after.contents.keys()])].sort());
            throw new RunBlocked(`Job ${label} modified the candidate worktree outside its write roots: ${changed.join(", ")}`);
          }
          if (failure !== undefined) throw failure;
          return value as T;
        },
      },
      prompt: promptAsset,
      protectedPaths: () => this.protectedPaths(),
    };
  }

  manager = {
    onIntervention: async ({ state, message, signal }: { state: RunState; message: string; signal: AbortSignal }) => {
      this.assistancePolicyRevision = state.assistanceRevision;
      return await handleRunIntervention(this.managerContext(state), state, message, signal);
    },
    onFailure: async ({ state, error, signal }: { state: RunState; error: unknown; signal: AbortSignal }) =>
      state.workflow === "compact" ? { action: "stay_blocked" as const }
        : await runManagerForFailure(this.managerContext(state), state, error, signal),
  };

  async beforeOperation(state: RunState, operationId: string, signal: AbortSignal): Promise<void> {
    await this.checkFrozen(state);
    const existing = state.operationTransaction;
    if (existing) {
      if (existing.operationId !== operationId) {
        throw new RunBlocked(`Incomplete operation transaction belongs to ${existing.operationId}/v${existing.iteration}`);
      }
      state.iteration = existing.iteration;
      if (existing.refineAttempt !== undefined) state.refineAttempt = existing.refineAttempt;
      try { await this.versions.assertCheckpoint(existing.checkpoint); }
      catch { await this.versions.restoreCheckpoint(existing.checkpoint); }
      state.operationRunId = existing.id;
    } else {
      const id = randomUUID();
      state.operationRunId = id;
      state.operationTransaction = {
        id, operationId: operationId as RunOperationId, iteration: state.iteration,
        refineAttempt: state.refineAttempt,
        checkpoint: await this.versions.createCheckpoint(id), startedAt: now(),
      };
      await this.store.save(state);
    }
    this.operationFingerprint = ["select", "retain"].includes(operationId)
      ? undefined : await this.projectFingerprint(state);
    if (signal.aborted) throw signal.reason;
  }

  async afterOperation(state: RunState, operationId: string, outcome: PolicyOutcome, signal: AbortSignal): Promise<void> {
    if (this.operationFingerprint && await this.projectFingerprint(state) !== this.operationFingerprint) {
      throw new RunBlocked(`Operation ${operationId} modified the project outside an authorized writing operation`);
    }
    await this.checkFrozen(state);
    const adminCompleted = ["steering.propose", "steering.resolve", "policy.activate"].includes(operationId)
      && !state.pendingRunCommand;
    const compactPauseCompleted = state.workflow === "compact" && outcome.status === "paused"
      && ((["verify", "retain"].includes(operationId) && !state.compact?.candidate)
        || (state.assistanceRevision === COMPONENT_ROUTING_REVISION
          && ["route_r3", "route_r4", "assess_target", "review_candidate", "select_candidates"].includes(operationId)));
    if ((outcome.status === "completed" || adminCompleted || compactPauseCompleted) && state.operationTransaction) {
      const checkpoint = state.operationTransaction.checkpoint;
      delete state.operationTransaction;
      delete state.operationRunId;
      await this.versions.deleteCheckpoint(checkpoint);
    }
    if (signal.aborted) throw signal.reason;
  }

  private managerContext(state: RunState) {
    return {
      project: this.project,
      store: this.store,
      agent: this.agent,
      execute: async (job: Parameters<AgentService["execute"]>[0], signal?: AbortSignal) =>
        await this.services(state).agent.execute(state, job, signal),
    };
  }

  private protectedPaths(): string[] {
    return [
      this.project.evaluatorPath, this.project.goalPath, this.project.taskPath, this.project.boundaryPath,
      this.project.collectorPath, this.project.collectorGuidePath,
      path.dirname(this.project.frozenEvaluatorPath),
    ].filter((item): item is string => !!item);
  }

  private async checkFrozen(state: RunState): Promise<void> {
    for (const file of state.compact?.frozenFiles ?? []) {
      if (await sha256(file.path) !== file.sha256) throw new RunBlocked(`Frozen compact contract changed: ${file.path}`);
    }
    if (this.project.goalPath && state.goalSha256
      && await sha256(this.project.goalPath) !== state.goalSha256) {
      await copyFile(path.join(this.project.runtimeDir, "contracts", "goal.md"), this.project.goalPath);
      throw new RunBlocked("The frozen original goal was modified. Runtime restored it and stopped.");
    }
    if (await sha256(this.project.evaluatorPath) !== state.evaluatorSha256) {
      await copyFile(this.project.frozenEvaluatorPath, this.project.evaluatorPath);
      throw new RunBlocked("The frozen evaluator was modified. Runtime restored it and stopped.");
    }
    if (this.project.collectorPath && state.collectorSha256
      && await sha256(this.project.collectorPath) !== state.collectorSha256) {
      await copyFile(this.frozenCollectorPath(), this.project.collectorPath);
      throw new RunBlocked("The frozen collector was modified. Runtime restored it and stopped.");
    }
    if (this.project.collectorGuidePath && state.collectorGuideSha256
      && await sha256(this.project.collectorGuidePath) !== state.collectorGuideSha256) {
      await copyFile(this.frozenCollectorGuidePath(), this.project.collectorGuidePath);
      throw new RunBlocked("The frozen collector execution plan was modified. Runtime restored it and stopped.");
    }
    if (await sha256Files([this.project.taskPath, this.project.boundaryPath]) !== state.contractSha256) {
      const contracts = path.join(this.project.runtimeDir, "contracts");
      await copyFile(path.join(contracts, "task.md"), this.project.taskPath);
      await copyFile(path.join(contracts, "boundary.json"), this.project.boundaryPath);
      const boundary = await loadRuntimeBoundary(this.project.boundaryPath);
      this.project.boundary = boundary;
      throw new RunBlocked("The frozen goal or Runtime boundary was modified. Runtime restored it and stopped.");
    }
  }

  private async projectFingerprint(state: RunState): Promise<string> {
    const snapshot = await this.projectWriteSnapshot(state);
    return createHash("sha256").update(JSON.stringify([...snapshot])).digest("hex");
  }

  private frozenCollectorPath(): string {
    return path.join(this.project.runtimeDir, "contracts", `collector${path.extname(this.project.collectorPath ?? "")}`);
  }

  private frozenCollectorGuidePath(): string {
    return path.join(this.project.runtimeDir, "contracts", "collector_guide.md");
  }

  private async projectWriteSnapshot(state: RunState): Promise<Map<string, string>> {
    const version = `v${state.iteration}`;
    const changedFiles = await this.versions.changedFiles(version);
    const entries = await Promise.all(changedFiles.map(async (file): Promise<[string, string]> => {
      try {
        return [file, createHash("sha256").update(await readFile(path.join(this.project.root, file))).digest("hex")];
      } catch {
        return [file, "missing"];
      }
    }));
    return new Map(entries);
  }

  private changedSnapshotPaths(before: Map<string, string>, after: Map<string, string>): string[] {
    return [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => before.get(file) !== after.get(file))
      .sort();
  }

  private async worktreeWriteSnapshot(root: string): Promise<{ diff: string; contents: Map<string, string> }> {
    const changes = await this.versions.worktreeChanges(root);
    const entries = await Promise.all(changes.files.map(async (file): Promise<[string, string]> => {
      try {
        return [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")];
      } catch {
        return [file, "missing"];
      }
    }));
    return { diff: changes.diff, contents: new Map(entries) };
  }

  subscribe(listener: (event: RunEvent) => void): () => void { return this.store.subscribe(listener); }
  async history(): Promise<RunEvent[]> { return await this.store.history(); }
}
