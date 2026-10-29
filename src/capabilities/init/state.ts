import { randomUUID } from "node:crypto";
import path from "node:path";

import { DurableStateStore } from "../../services/state/index.ts";
import { currentInitOperation, type InitEvent, type InitState } from "./protocol.ts";

export type InitEventListener = (event: InitEvent) => void;

/** Atomically persists Init state while sharing the append-only domain event stream with Run. */
export class InitStore {
  readonly statePath: string;
  readonly eventsPath: string;
  private readonly durable: DurableStateStore<InitState, InitEvent>;

  constructor(projectRoot: string) {
    const runtimeDir = path.join(path.resolve(projectRoot), ".flywheel", "runtime");
    this.statePath = path.join(runtimeDir, "init-state.json");
    this.eventsPath = path.join(runtimeDir, "events.jsonl");
    this.durable = new DurableStateStore({
      statePath: this.statePath,
      eventsPath: this.eventsPath,
      validateState: (value) => {
        const state = value as Omit<InitState, "schemaVersion"> & { schemaVersion: number };
        if (state.schemaVersion !== 3 || !state.execution || !state.capabilityRunId) {
          throw new Error(
            `当前 Init 状态是旧 schema ${String(state.schemaVersion)}，本版本只原生支持 schema 3。`
            + "请先备份并删除项目中的 .flywheel，再重新运行 init。",
          );
        }
        return state as InitState;
      },
      selectEvent: (event) => event.scope === "init",
      eventId: (event) => event.id,
    });
  }

  subscribe(listener: InitEventListener): () => void {
    return this.durable.subscribe(listener);
  }

  async load(): Promise<InitState> {
    return await this.durable.load();
  }

  async history(): Promise<InitEvent[]> {
    return await this.durable.history();
  }

  async save(state: InitState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    await this.durable.save(state);
  }

  async emit(state: InitState, type: string, data?: Record<string, unknown>): Promise<InitEvent> {
    return await this.commit(state, type, data);
  }

  async commit(
    state: InitState,
    type: string,
    data?: Record<string, unknown>,
    eventState: InitState = state,
  ): Promise<InitEvent> {
    state.eventSequence += 1;
    const job = typeof data?.job === "string" ? data.job : undefined;
    const activeJobs = state.execution.operationState.activeJobIds && typeof state.execution.operationState.activeJobIds === "object"
      ? state.execution.operationState.activeJobIds as Record<string, string>
      : {};
    state.execution.operationState.activeJobIds = activeJobs;
    if (type === "job.started" && job) activeJobs[job] = randomUUID();
    const jobId = job ? activeJobs[job] : undefined;
    const event: InitEvent = {
      id: randomUUID(),
      capabilityRunId: eventState.capabilityRunId,
      ...(eventState.operationRunId ? { operationRunId: eventState.operationRunId } : {}),
      ...(jobId ? { jobId } : {}),
      sequence: state.eventSequence,
      timestamp: new Date().toISOString(),
      scope: "init",
      projectRoot: eventState.projectRoot,
      operation: currentInitOperation(eventState),
      type,
      data,
    };
    if (type === "job.completed" && job) delete activeJobs[job];
    await this.durable.commit(state, event);
    return event;
  }
}
