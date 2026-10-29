import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DurableStateStore } from "../../services/state/index.ts";

export interface GoalDraftMessage {
  id: string;
  text: string;
  receivedAt: string;
}

export interface GoalDraft {
  schemaVersion: 1;
  revision: number;
  messages: GoalDraftMessage[];
  /** IDs chosen by Agent semantics; values always come from original user text. */
  goalMessageIds: string[];
  agentSessions: Record<string, string>;
  sealed?: boolean;
}

const intakeQueues = new Map<string, Promise<unknown>>();

/** Separate durable lane: never saves Init's mutable runner state. Session serializes its callers. */
export class InitIntakeStore {
  readonly path: string;
  private readonly store: DurableStateStore<GoalDraft, unknown>;
  constructor(projectRoot: string) {
    this.path = path.join(projectRoot, ".flywheel", "runtime", "init-intake.json");
    this.store = new DurableStateStore({ statePath: this.path, eventsPath: `${this.path}.events.jsonl`,
      validateState: value => {
        const draft = value as GoalDraft;
        if (draft.schemaVersion !== 1 || !Array.isArray(draft.messages) || !Array.isArray(draft.goalMessageIds)) {
          throw new Error("Invalid initialization goal draft");
        }
        return draft;
      } });
  }
  async load(): Promise<GoalDraft> {
    try { return await this.store.load(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { schemaVersion: 1, revision: 0, messages: [], goalMessageIds: [], agentSessions: {} };
    }
  }
  async save(draft: GoalDraft): Promise<void> { await this.store.save(draft); }
  /** Includes a complete Agent turn or the atomic freeze, never just its file write. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = intakeQueues.get(this.path) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    intakeQueues.set(this.path, run);
    try { return await run; }
    finally { if (intakeQueues.get(this.path) === run) intakeQueues.delete(this.path); }
  }
  async receive(text: string): Promise<{ draft: GoalDraft; message: GoalDraftMessage }> {
    if (!text.trim()) throw new Error("A message cannot be empty");
    const draft = await this.load();
    if (draft.sealed) throw new Error("Original goal draft is already sealed; use controlled goal change");
    const message = { id: randomUUID(), text, receivedAt: new Date().toISOString() };
    draft.messages.push(message);
    draft.revision += 1;
    await this.save(draft);
    return { draft, message };
  }
}

export function originalGoalFromDraft(draft: GoalDraft): string | undefined {
  if (!draft.goalMessageIds.length) return undefined;
  const chosen = new Set(draft.goalMessageIds);
  if (chosen.size !== draft.goalMessageIds.length || [...chosen].some(id => !draft.messages.some(m => m.id === id))) {
    throw new Error("Goal references an unknown or duplicated user message");
  }
  return draft.messages.filter(m => chosen.has(m.id)).map(m => m.text).join("\n\n");
}

export async function existingOriginalGoal(projectRoot: string): Promise<string | undefined> {
  try { return await readFile(path.join(projectRoot, ".flywheel", "goal.md"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
