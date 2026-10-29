import { mkdir } from "node:fs/promises";
import path from "node:path";

export interface SearchItem<Input> {
  id: string;
  input: Input;
}

export interface SearchExecution<Input> extends SearchItem<Input> {
  workspace: string;
  signal: AbortSignal;
}

export type SearchResult<Input, Output> =
  | (SearchItem<Input> & { status: "completed"; workspace: string; output: Output })
  | (SearchItem<Input> & { status: "failed"; workspace: string; error: string });

export interface SearchOptions<Input, Output> {
  workspaceRoot: string;
  items: readonly SearchItem<Input>[];
  run(execution: SearchExecution<Input>): Promise<Output>;
  /** Return a previously persisted terminal result to skip this item on resume. */
  restore?(execution: SearchExecution<Input>): Promise<SearchResult<Input, Output> | undefined>;
  /** Persist each terminal item independently before another item is scheduled. */
  persist?(result: SearchResult<Input, Output>): Promise<void>;
  signal?: AbortSignal;
  concurrency?: number;
}

function validateId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid search item id: ${JSON.stringify(id)}`);
}

/**
 * A small, policy-neutral search primitive. It expands independent inputs
 * into isolated workspaces, runs a bounded concurrent runner pool, and preserves input
 * order in the returned evidence. The active execution policy owns selection
 * and promotion.
 */
export interface SearchService {
  run<Input, Output>(options: SearchOptions<Input, Output>): Promise<SearchResult<Input, Output>[]>;
}

class IsolatedSearchService implements SearchService {
  readonly concurrency: number;

  constructor(concurrency = 8) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be >= 1");
    this.concurrency = concurrency;
  }

  async run<Input, Output>(options: SearchOptions<Input, Output>): Promise<SearchResult<Input, Output>[]> {
    const concurrency = options.concurrency ?? this.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be >= 1");
    const seen = new Set<string>();
    for (const item of options.items) {
      validateId(item.id);
      if (seen.has(item.id)) throw new Error(`Duplicate search item id: ${item.id}`);
      seen.add(item.id);
    }
    if (!options.items.length) return [];

    await mkdir(options.workspaceRoot, { recursive: true });
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const signal = controller.signal;
    const results = new Array<SearchResult<Input, Output>>(options.items.length);
    let cursor = 0;
    const runners = Array.from({ length: Math.min(concurrency, options.items.length) }, async () => {
      while (true) {
        if (signal.aborted) throw new DOMException("Search was interrupted", "AbortError");
        const index = cursor++;
        if (index >= options.items.length) return;
        const item = options.items[index];
        const workspace = path.join(path.resolve(options.workspaceRoot), item.id);
        await mkdir(workspace, { recursive: true });
        try {
          const restored = await options.restore?.({ ...item, workspace, signal });
          if (restored) {
            if (restored.id !== item.id || path.resolve(restored.workspace) !== workspace) {
              throw new Error(`Restored search result identity mismatch: ${item.id}`);
            }
            results[index] = restored;
            continue;
          }
          const output = await options.run({ ...item, workspace, signal });
          if (signal.aborted) throw new DOMException("Search was interrupted", "AbortError");
          results[index] = { ...item, status: "completed", workspace, output };
        } catch (error) {
          if ((error instanceof DOMException && error.name === "AbortError") || signal.aborted) {
            controller.abort(error);
            throw new DOMException("Search was interrupted", "AbortError");
          }
          results[index] = {
            ...item,
            status: "failed",
            workspace,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await options.persist?.(results[index]);
      }
    });
    const settled = await Promise.allSettled(runners);
    options.signal?.removeEventListener("abort", abort);
    const rejected = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) {
      if (signal.aborted
        || (rejected.reason instanceof DOMException && rejected.reason.name === "AbortError")) {
        throw new DOMException("Search was interrupted", "AbortError");
      }
      throw rejected.reason;
    }
    return results;
  }
}

export function createSearchService(concurrency = 8): SearchService {
  return new IsolatedSearchService(concurrency);
}
