import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createExecutionBudgetState, validExecutionBudgetLimits, ExecutionBudget, type ExecutionBudgetLimits, type ExecutionBudgetState } from "./execution-budget.ts";

const budgets = new Map<string, Promise<ExecutionBudget>>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseState(value: unknown): ExecutionBudgetState {
  const limits = record(value) && record(value.limits) ? value.limits : {};
  if (!record(value) || value.schemaVersion !== 1 || !record(value.limits)
    || !validExecutionBudgetLimits(limits as unknown as ExecutionBudgetLimits)
    || !Array.isArray(value.attempts) || !value.attempts.every((entry) => typeof entry === "string")
    || new Set(value.attempts).size !== value.attempts.length || typeof value.repairUsed !== "boolean"
    || !count(value.activeMs) || !count(value.knownTokens) || !Number.isSafeInteger(value.unknownUsageInvocations)
    || Number(value.unknownUsageInvocations) < 0 || !record(value.invocations)
    || (value.activeUpdatedAt !== undefined && !count(value.activeUpdatedAt))
    || (value.processes !== undefined && !record(value.processes))) {
    throw new Error("Persisted execution budget is invalid; refusing to reset it");
  }
  if (value.limitChanges !== undefined) {
    if (!Array.isArray(value.limitChanges) || new Set(value.limitChanges.map(change => record(change) ? change.authorizationId : undefined)).size !== value.limitChanges.length) throw new Error("Invalid budget authorization history");
    for (const change of value.limitChanges) {
      if (!record(change) || typeof change.authorizationId !== "string" || !change.authorizationId.trim()
        || typeof change.reason !== "string" || !change.reason.trim() || !count(change.at)
        || !record(change.previous) || !validExecutionBudgetLimits(change.previous as unknown as ExecutionBudgetLimits)
        || !record(change.next) || change.next.mode !== "unbounded" || !validExecutionBudgetLimits(change.next as unknown as ExecutionBudgetLimits)) throw new Error("Invalid budget authorization history");
    }
    if (value.limitChanges.length && limits.mode !== "unbounded") throw new Error("Budget authorization history does not match current limits");
  }
  for (const entry of [...Object.values(value.invocations), ...Object.values(value.processes ?? {})]) {
    if (!record(entry) || !count(entry.startedAt) || (entry.endedAt !== undefined && !count(entry.endedAt))
      || (entry.tokens !== undefined && !count(entry.tokens))) throw new Error("Persisted execution budget activity is invalid");
  }
  const invalid = () => { throw new Error("Persisted execution budget reservations are invalid; refusing to reset them"); };
  const estimate = (entry: unknown): boolean => record(entry) && Number.isSafeInteger(entry.tokens) && Number(entry.tokens) >= 0
    && Number.isSafeInteger(entry.activeMs) && Number(entry.activeMs) >= 0 && typeof entry.source === "string" && !!entry.source;
  const authorization = (entry: unknown): boolean => Number.isSafeInteger(entry) && Number(entry) > 0 && Number(entry) <= 120_000;
  const chain = (entry: unknown): boolean => record(entry) && entry.revision === "2026-10-29.compact.v3"
    && Number.isSafeInteger(entry.slots) && Number(entry.slots) >= 1 && Number(entry.slots) <= 16
    && Number.isSafeInteger(entry.slotsRemaining) && Number(entry.slotsRemaining) >= 0 && Number(entry.slotsRemaining) <= Number(entry.slots)
    && entry.perInvocationMs === 120_000;
  if (value.reservations !== undefined) {
    if (!record(value.reservations)) invalid();
    for (const entry of Object.values(value.reservations as Record<string, unknown>)) {
      if (!record(entry) || !["required", "assistance"].includes(String(entry.kind)) || !estimate(entry.estimate)
        || (entry.kind === "assistance" && !estimate(entry.invocationEstimate))
        || (entry.invocationEstimate !== undefined && !estimate(entry.invocationEstimate))
        || (entry.componentChain !== undefined && (entry.kind !== "assistance" || !chain(entry.componentChain)
          || entry.authorizedActiveMs !== Number((entry.componentChain as Record<string, unknown>).slots) * 120_000
          || Number(entry.activeMsRemaining) !== Number((entry.componentChain as Record<string, unknown>).slotsRemaining) * 120_000))
        || (entry.authorizedActiveMs !== undefined && (entry.kind !== "assistance" || (!entry.componentChain && !authorization(entry.authorizedActiveMs))
          || Number((entry.estimate as Record<string, unknown>).activeMs) > Number(entry.authorizedActiveMs)))
        || !count(entry.tokensRemaining) || !count(entry.activeMsRemaining)
        || (entry.activeMsAtStart !== undefined && !count(entry.activeMsAtStart))
        || Number(entry.tokensRemaining) > Number((entry.estimate as Record<string, unknown>).tokens)
        || Number(entry.activeMsRemaining) > Number(entry.authorizedActiveMs ?? (entry.estimate as Record<string, unknown>).activeMs)
        || (entry.closed !== undefined && typeof entry.closed !== "boolean")
        || (entry.closed === true && (entry.tokensRemaining !== 0 || entry.activeMsRemaining !== 0))) invalid();
    }
  }
  if (value.assistance !== undefined) {
    if (!record(value.assistance) || value.assistance.revision !== 1 || !record(value.assistance.decisions)) invalid();
    const decisions = (value.assistance as { decisions: Record<string, unknown> }).decisions;
    const admittedWindows = new Set<string>();
    let admittedCount = 0;
    for (const [key, entry] of Object.entries(decisions)) {
      if (!record(entry) || entry.requestId !== key || typeof entry.windowId !== "string" || !entry.windowId
        || typeof entry.binding !== "string" || !entry.binding || typeof entry.admitted !== "boolean"
        || typeof entry.requestFingerprint !== "string" || (entry.reason !== undefined && typeof entry.reason !== "string")
        || (entry.estimate !== undefined && !estimate(entry.estimate))
        || (entry.authorizedActiveMs !== undefined && (!entry.admitted || !Number.isSafeInteger(entry.authorizedActiveMs) || Number(entry.authorizedActiveMs) <= 0))) invalid();
      const decision = entry as Record<string, unknown>;
      if (decision.admitted) {
        const reservations = value.reservations as Record<string, unknown> | undefined;
        if (typeof decision.reservationId !== "string" || !record(reservations?.[decision.reservationId])
          || (reservations![decision.reservationId] as Record<string, unknown>).kind !== "assistance" || !estimate(decision.estimate)
          || (reservations![decision.reservationId] as Record<string, unknown>).authorizedActiveMs !== decision.authorizedActiveMs
          || (!(reservations![decision.reservationId] as Record<string, unknown>).componentChain && decision.authorizedActiveMs !== undefined && !authorization(decision.authorizedActiveMs))
          || admittedWindows.has(String(decision.windowId))) invalid();
        admittedWindows.add(String(decision.windowId));
        admittedCount++;
      }
    }
    if (limits.mode !== "unbounded" && admittedCount > 2) invalid();
  }
  for (const entry of Object.values(value.invocations)) {
    const invocation = entry as Record<string, unknown>;
    for (const key of ["knownInputTokens", "knownOutputTokens", "estimatedTokens", "estimatedActiveMs", "unknownTokens"]) {
      if (invocation[key] !== undefined && !count(invocation[key])) invalid();
    }
    if ((invocation.estimateClass !== undefined && typeof invocation.estimateClass !== "string")
      || (invocation.interrupted !== undefined && typeof invocation.interrupted !== "boolean")
      || (invocation.reservationId !== undefined && (typeof invocation.reservationId !== "string"
        || !Object.hasOwn(value.reservations ?? {}, String(invocation.reservationId))))) invalid();
  }
  return value as unknown as ExecutionBudgetState;
}

/** Same project shares one durable budget across Init, Run and concurrent entrypoints.
 * Supplied limits apply only to first creation. Existing state fails closed on damage.
 * This is process-local reuse, not a cross-process project lock.
 */
export async function openExecutionBudget(projectRoot: string, limits?: Partial<ExecutionBudgetLimits>): Promise<ExecutionBudget> {
  // Resolve aliases before selecting a cache entry: two spellings of one project
  // must never own independent in-memory counters which overwrite the same file.
  // Do this before yielding so the first caller's creation limits cannot lose
  // to a later alias whose asynchronous realpath happens to complete first.
  const canonicalRoot = realpathSync(path.resolve(projectRoot));
  const file = path.join(canonicalRoot, ".flywheel", "runtime", "execution-budget.json");
  const key = process.platform === "win32" ? file.toLowerCase() : file;
  const existing = budgets.get(key);
  if (existing) return await existing;
  const pending = (async () => {
    let state: ExecutionBudgetState;
    let restored = false;
    try {
      state = parseState(JSON.parse(await readFile(file, "utf8")));
      restored = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = createExecutionBudgetState(limits);
    }
    const checkpoint = async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
    };
    const budget = new ExecutionBudget(state, checkpoint);
    if (restored) await budget.recoverInterrupted();
    else await checkpoint();
    return budget;
  })();
  budgets.set(key, pending);
  try { return await pending; }
  catch (error) { if (budgets.get(key) === pending) budgets.delete(key); throw error; }
}
