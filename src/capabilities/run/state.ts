import { randomUUID } from "node:crypto";

import type { RunEvent, RunState } from "./protocol.ts";
import { DurableStateStore } from "../../services/state/index.ts";
import type { ArtifactRef } from "../../services/version/index.ts";
import type { Project } from "./project.ts";

export interface AgentStateManifest {
  id: string;
  parentStateId?: string;
  components: ArtifactRef[];
  createdAt: string;
  evolutionRecordId?: string;
}

export interface SteeringRevision {
  id: string;
  parentRevisionId?: string;
  /** Immutable verbatim user request captured by Init. */
  originalGoal: ArtifactRef;
  /** Executable task package compiled from the original goal. */
  task: ArtifactRef;
  evaluator: ArtifactRef;
  boundary: ArtifactRef;
  approvalEvidence: ArtifactRef[];
  createdAt: string;
}

export interface EpisodeRecord {
  id: string;
  capabilityRunId: string;
  agentStateId: string;
  steeringRevisionId: string;
  status: "running" | "completed" | "failed" | "aborted";
  task: ArtifactRef;
  trajectory: { path: string; startEventId?: string; endEventId?: string };
  outputs: ArtifactRef[];
  evaluations: ArtifactRef[];
  failures: ArtifactRef[];
  createdAt: string;
  updatedAt: string;
}

export interface EvolutionRecord {
  id: string;
  baseStateId: string;
  steeringRevisionId: string;
  evidence: ArtifactRef[];
  proposal: ArtifactRef;
  candidateStateId: string;
  validationArtifacts: ArtifactRef[];
  decision: "select" | "promote" | "reject" | "rollback";
  approvalEvidence: ArtifactRef[];
  createdAt: string;
}

export interface SteeringCandidate extends SteeringRevision {
  proposal: ArtifactRef;
  validationArtifacts: ArtifactRef[];
  anchorEvidence: ArtifactRef[];
}

export interface PolicyRevisionCandidate {
  id: string;
  policyId: string;
  revision: string;
  module: ArtifactRef;
  apiValidation: ArtifactRef[];
  contractTests: ArtifactRef[];
  replayEvidence: ArtifactRef[];
  smokeEvidence: ArtifactRef[];
  createdAt: string;
}

export interface PolicyActivationPending {
  id: string;
  candidateId: string;
  candidateSha256: string;
  approvalEvidence: ArtifactRef[];
  createdAt: string;
}

export interface ValidationAttestation {
  kind: "steering.contract" | "steering.anchor" | "policy.api" | "policy.contract" | "policy.replay" | "policy.smoke";
  subjectSha256: string;
  status: "passed" | "failed";
  validator: { id: string; version: string };
  createdAt: string;
  details?: Record<string, unknown>;
}

export type RunEventListener = (event: RunEvent) => void;

export function now(): string {
  return new Date().toISOString();
}

export function versionOf(state: RunState): string {
  return `v${state.iteration}`;
}

/** Atomically persists Run state and appends replayable events with stable execution identities. */
export class StateStore {
  readonly project: Project;
  private readonly durable: DurableStateStore<RunState, RunEvent>;

  constructor(project: Project) {
    this.project = project;
    this.durable = new DurableStateStore({
      statePath: project.statePath,
      eventsPath: project.eventsPath,
      validateState: (value) => {
        const state = value as Omit<RunState, "schemaVersion"> & { schemaVersion: number };
        if (state.schemaVersion !== 3 || !state.execution || !state.capabilityRunId
          || !state.episodeId || typeof state.agentStateId !== "string"
          || typeof state.steeringRevisionId !== "string" || !state.contractSha256) {
          throw new Error(
            `当前 Run 状态是旧 schema ${String(state.schemaVersion)}，本版本只原生支持完整 schema 3。`
            + "请先备份并删除项目中的 .flywheel，再重新运行 init。",
          );
        }
        return state as RunState;
      },
      selectEvent: (event) => {
        const persisted = event as RunEvent & { scope?: string };
        return persisted.scope !== "init" && typeof persisted.version === "string";
      },
      eventId: (event) => event.id,
    });
  }

  subscribe(listener: RunEventListener): () => void {
    return this.durable.subscribe(listener);
  }

  async load(): Promise<RunState> {
    return await this.durable.load();
  }

  async history(): Promise<RunEvent[]> {
    return await this.durable.history();
  }

  async save(state: RunState): Promise<void> {
    state.updatedAt = now();
    await this.durable.save(state);
  }

  /** Append first, then notify in-process listeners; persisted history remains the replay source. */
  async emit(state: RunState, type: RunEvent["type"], data?: Record<string, unknown>): Promise<void> {
    await this.commit(state, type, data);
  }

  async commit(
    state: RunState,
    type: RunEvent["type"],
    data?: Record<string, unknown>,
    eventState: RunState = state,
  ): Promise<void> {
    const job = typeof data?.job === "string" ? data.job : undefined;
    const activeJobs = state.execution.operationState.activeJobIds && typeof state.execution.operationState.activeJobIds === "object"
      ? state.execution.operationState.activeJobIds as Record<string, string>
      : {};
    state.execution.operationState.activeJobIds = activeJobs;
    if (type === "job.started" && job) activeJobs[job] = randomUUID();
    const jobId = job ? activeJobs[job] : undefined;
    const event: RunEvent = {
      id: randomUUID(),
      capabilityRunId: eventState.capabilityRunId,
      ...(eventState.operationRunId ? { operationRunId: eventState.operationRunId } : {}),
      ...(jobId ? { jobId } : {}),
      episodeId: typeof data?.episodeId === "string" ? data.episodeId : eventState.episodeId,
      agentStateId: eventState.agentStateId,
      steeringRevisionId: eventState.steeringRevisionId,
      timestamp: now(), type, version: versionOf(eventState),
      operation: eventState.execution.currentOperationId ?? "run", status: eventState.status, data,
    };
    if (type === "job.completed" && job) delete activeJobs[job];
    await this.durable.commit(state, event);
  }
}
