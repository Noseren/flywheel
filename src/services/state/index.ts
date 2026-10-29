import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DurableStateOptions<State, Event> {
  statePath: string;
  eventsPath: string;
  validateState(value: unknown): State;
  selectEvent?(event: Event): boolean;
  eventId?(event: Event): string;
}

interface PendingTransition<State, Event> {
  schemaVersion: 1;
  eventId: string;
  state: State;
  event: Event;
}

/** Generic atomic JSON state plus append-only JSONL events. */
export class DurableStateStore<State, Event> {
  readonly statePath: string;
  readonly eventsPath: string;
  readonly transitionPath: string;
  private readonly validateState: (value: unknown) => State;
  private readonly selectEvent?: (event: Event) => boolean;
  private readonly eventId?: (event: Event) => string;
  private readonly listeners = new Set<(event: Event) => void>();
  private transitionQueue: Promise<void> = Promise.resolve();

  constructor(options: DurableStateOptions<State, Event>) {
    this.statePath = options.statePath;
    this.eventsPath = options.eventsPath;
    this.transitionPath = `${options.statePath}.pending-transition.json`;
    this.validateState = options.validateState;
    this.selectEvent = options.selectEvent;
    this.eventId = options.eventId;
  }

  subscribe(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<State> {
    await this.transitionQueue;
    await this.recoverPendingTransition();
    return this.validateState(JSON.parse(await readFile(this.statePath, "utf8")) as unknown);
  }

  async save(state: State): Promise<void> {
    const snapshot = structuredClone(state);
    const queued = this.transitionQueue.then(async () => await this.saveNow(snapshot));
    this.transitionQueue = queued.catch(() => undefined);
    await queued;
  }

  private async saveNow(state: State): Promise<void> {
    await this.writeAtomic(this.statePath, state);
  }

  async history(): Promise<Event[]> {
    await this.transitionQueue;
    await this.recoverPendingTransition();
    const events = await this.readEvents();
    return this.selectEvent ? events.filter(this.selectEvent) : events;
  }

  private async readEvents(): Promise<Event[]> {
    try {
      return (await readFile(this.eventsPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async append(event: Event): Promise<void> {
    const queued = this.transitionQueue.then(async () => await this.appendNow(event));
    this.transitionQueue = queued.catch(() => undefined);
    await queued;
  }

  private async appendNow(event: Event): Promise<void> {
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    for (const listener of this.listeners) listener(event);
  }

  /**
   * Persist one state transition and its audit event through a tiny write-ahead record.
   * Recovery completes either side and de-duplicates the event by its stable identity.
   */
  async commit(state: State, event: Event): Promise<void> {
    if (!this.eventId) throw new Error("Durable state commit requires an eventId selector");
    const stateSnapshot = structuredClone(state);
    const eventSnapshot = structuredClone(event);
    const eventId = this.eventId(eventSnapshot);
    if (!eventId) throw new Error("Durable state commit event identity may not be empty");
    const queued = this.transitionQueue.then(async () => {
      const transition: PendingTransition<State, Event> = {
        schemaVersion: 1, eventId, state: stateSnapshot, event: eventSnapshot,
      };
      await this.writeAtomic(this.transitionPath, transition);
      await this.saveNow(stateSnapshot);
      if (!(await this.readEvents()).some((item) => this.eventId!(item) === eventId)) {
        await this.appendNow(eventSnapshot);
      }
      await rm(this.transitionPath, { force: true });
    });
    this.transitionQueue = queued.catch(() => undefined);
    await queued;
  }

  private async recoverPendingTransition(): Promise<void> {
    let transition: PendingTransition<State, Event>;
    try {
      transition = JSON.parse(await readFile(this.transitionPath, "utf8")) as PendingTransition<State, Event>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!this.eventId || transition.schemaVersion !== 1 || !transition.eventId
      || this.eventId(transition.event) !== transition.eventId) {
      throw new Error(`Invalid pending state transition: ${this.transitionPath}`);
    }
    const state = this.validateState(transition.state);
    await this.saveNow(state);
    if (!(await this.readEvents()).some((item) => this.eventId!(item) === transition.eventId)) {
      await this.appendNow(transition.event);
    }
    await rm(this.transitionPath, { force: true });
  }

  private async writeAtomic(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.renameTemporary(temporary, file);
          return;
        } catch (error) {
          // Windows file scanners/readers can briefly deny replacement. Never unlink
          // the destination: readers must see either the old or the new complete state.
          const code = (error as NodeJS.ErrnoException).code;
          if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
          await delay(20 * 2 ** attempt);
        }
      }
    } finally {
      // Only this call's scratch file; leave the write-ahead transition for recovery.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  protected async renameTemporary(source: string, destination: string): Promise<void> {
    await rename(source, destination);
  }
}
