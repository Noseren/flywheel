/** Replayable accounting projection. No prompts, paths, credentials or reports. */
export const USAGE_TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;
type TokenField = typeof USAGE_TOKEN_FIELDS[number];
export type LedgerUsage = Record<TokenField, number | null>;
export interface UsageInvocation {
  invocationId: string;
  precision: "invocation" | "legacy-job";
  sessionId?: string;
  capabilityId?: string;
  phase: string;
  operation: string;
  jobId: string;
  parentJobId?: string;
  depth: number;
  provider: string;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "completed" | "failed" | "aborted" | "interrupted";
  durationMs: number;
  usage: LedgerUsage;
}
export interface UsageTotals extends LedgerUsage {
  invocationCount: number;
  runningInvocationCount: number;
  unknownInvocationCount: number;
  totalTokens: number | null;
  /** Union of observed call intervals, excluding idle/offline gaps. */
  wallElapsedMs: number;
  /** Sum of call elapsed durations; may exceed wall time due to concurrency. */
  invocationDurationMs: number;
}
export interface UsageLedger {
  schemaVersion: 1;
  precision: "invocation" | "legacy-job" | "mixed" | "empty";
  totals: UsageTotals;
  groups: Record<"phase" | "operation" | "job" | "model", Record<string, UsageTotals>>;
  invocations: UsageInvocation[];
  unknowns: { invocationIds: string[]; legacyPrecision: boolean };
}

/** Machine-readable export contract; schema does not expose event payloads. */
export const USAGE_LEDGER_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Flywheel usage ledger v1",
  type: "object",
  required: ["schemaVersion", "precision", "totals", "groups", "invocations", "unknowns"],
  properties: {
    schemaVersion: { const: 1 },
    precision: { enum: ["invocation", "legacy-job", "mixed", "empty"] },
    totals: { $ref: "#/$defs/totals" },
    groups: { type: "object", required: ["phase", "operation", "job", "model"], properties: Object.fromEntries(
      ["phase", "operation", "job", "model"].map((key) => [key, { type: "object", additionalProperties: { $ref: "#/$defs/totals" } }]),
    ) },
    invocations: { type: "array", items: { $ref: "#/$defs/invocation" } },
    unknowns: { type: "object", required: ["invocationIds", "legacyPrecision"], properties: {
      invocationIds: { type: "array", items: { type: "string" } }, legacyPrecision: { type: "boolean" },
    } },
  },
  $defs: {
    usage: { type: "object", required: [...USAGE_TOKEN_FIELDS], properties: Object.fromEntries(
      USAGE_TOKEN_FIELDS.map((key) => [key, { type: ["number", "null"], minimum: 0 }]),
    ) },
    totals: { allOf: [{ $ref: "#/$defs/usage" }, { type: "object", required: [
      "invocationCount", "runningInvocationCount", "unknownInvocationCount", "totalTokens", "wallElapsedMs", "invocationDurationMs",
    ], properties: {
      ...Object.fromEntries(["invocationCount", "runningInvocationCount", "unknownInvocationCount", "wallElapsedMs", "invocationDurationMs"].map((key) => [key, { type: "number", minimum: 0 }])),
      totalTokens: { type: ["number", "null"], minimum: 0 },
    } }] },
    invocation: { type: "object", required: ["invocationId", "precision", "phase", "operation", "jobId", "depth", "provider", "model", "startedAt", "status", "durationMs", "usage"], properties: {
      ...Object.fromEntries(["invocationId", "sessionId", "capabilityId", "phase", "operation", "jobId", "parentJobId", "provider", "model", "startedAt", "endedAt"].map((key) => [key, { type: "string" }])),
      precision: { enum: ["invocation", "legacy-job"] },
      depth: { type: "integer", minimum: 0 }, durationMs: { type: "number", minimum: 0 },
      status: { enum: ["running", "completed", "failed", "aborted", "interrupted"] },
      usage: { $ref: "#/$defs/usage" },
    } },
  },
} as const;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" ? value as ObjectValue : {};
}
function string(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value ? value : fallback;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function tokens(value: unknown): LedgerUsage {
  const raw = object(value);
  return Object.fromEntries(USAGE_TOKEN_FIELDS.map((key) => [key, number(raw[key])])) as LedgerUsage;
}
function instant(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
function unknownUsage(usage: LedgerUsage): boolean {
  return usage.inputTokens === null || usage.outputTokens === null;
}
function summarize(invocations: UsageInvocation[], now: number): UsageTotals {
  const usage = tokens(null);
  for (const field of USAGE_TOKEN_FIELDS) {
    const reported = invocations.flatMap((entry) => entry.usage[field] === null ? [] : [entry.usage[field]!]);
    usage[field] = reported.length ? reported.reduce((a, b) => a + b, 0) : null;
  }
  const intervals = invocations.map((entry) => {
    const start = instant(entry.startedAt) ?? now;
    return [start, Math.max(start, instant(entry.endedAt) ?? now)] as [number, number];
  }).sort((a, b) => a[0] - b[0]);
  let wallElapsedMs = 0;
  let previousEnd = -Infinity;
  for (const [start, end] of intervals) {
    wallElapsedMs += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return {
    ...usage,
    invocationCount: invocations.length,
    runningInvocationCount: invocations.filter((entry) => entry.status === "running").length,
    unknownInvocationCount: invocations.filter((entry) => unknownUsage(entry.usage)).length,
    // Cache and reasoning are subsets, never independent token additions.
    totalTokens: usage.inputTokens === null && usage.outputTokens === null ? null : (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    wallElapsedMs,
    invocationDurationMs: invocations.reduce((sum, entry) => sum + (entry.status === "running"
      ? Math.max(0, now - (instant(entry.startedAt) ?? now)) : entry.durationMs), 0),
  };
}

/** Accepts raw domain events, Session capability.event envelopes, or sdk events.
 * Recompute is deliberate: late replay of invocation events replaces legacy
 * aggregate estimates rather than incrementing both sources.
 */
export function buildUsageLedger(events: readonly unknown[], options: { now?: string | number } = {}): UsageLedger {
  const now = typeof options.now === "number" ? options.now : instant(options.now) ?? Date.now();
  const calls = new Map<string, UsageInvocation>();
  const legacy = new Map<string, UsageInvocation>();
  const seen = new Set<string>();
  let lastObservedAt: number | undefined;
  for (const value of events) {
    const outer = object(value);
    const event = outer.type === "capability.event" ? object(object(outer.data).event) : outer;
    const data = event.sdkEvent ? event : object(event.data);
    const timestamp = string(event.timestamp, string(outer.timestamp,
      string(data.endedAt, string(data.startedAt, new Date(now).toISOString()))));
    if (event.id && seen.has(String(event.id))) continue;
    if (event.id) seen.add(String(event.id));
    // A clean stop/reopen closes otherwise unreported attempts. Completed calls
    // replayed later still replace these interrupted placeholders.
    if (["session.stopped", "session.started", "session.attached"].includes(String(event.type))) {
      // A restart only proves the preceding process is gone, not that it was
      // processing throughout the offline gap. Bound unclosed work by the last
      // recorded activity instead of charging until the new process attaches.
      const boundary = event.type === "session.stopped" ? instant(timestamp) ?? now
        : lastObservedAt ?? instant(timestamp) ?? now;
      for (const call of calls.values()) if (call.status === "running" && (instant(call.startedAt) ?? now) <= boundary) {
        call.status = "interrupted";
        call.endedAt = new Date(boundary).toISOString();
        call.durationMs = Math.max(0, boundary - (instant(call.startedAt) ?? boundary));
      }
    }
    lastObservedAt = Math.max(lastObservedAt ?? -Infinity, instant(timestamp) ?? now);
    const sdkEvent = string(data.sdkEvent, "");
    const isInvocation = sdkEvent === "invocation.started" || sdkEvent === "invocation.completed";
    const isLegacy = event.type === "job.completed";
    if (!isInvocation && !isLegacy) continue;
    // A rejected provider admission is a Job lifecycle event, not model work.
    // Early compact traces predate the explicit marker but contain this exact
    // Runtime error with no transport usage or duration. Other historical
    // failures still retain their approximate unknown-usage entry.
    if (isLegacy && ((data.errorCode === "EXECUTION_BUDGET_EXHAUSTED" && data.invocationStarted === false)
      || (data.status === "failed" && data.invocationStarted === undefined && data.usage == null && data.durationMs === undefined
        && typeof data.error === "string" && /^Execution budget exhausted: (attempts|time|tokens|repair)$/.test(data.error)))) continue;
    const capabilityId = string(outer.capabilityId, string(event.scope, ""));
    const jobId = string(data.jobId, string(event.jobId, string(data.job)));
    const operation = string(data.operation, string(event.operation));
    const sessionId = string(outer.sessionId, "");
    const identity = isInvocation ? string(data.invocationId, "")
      : string(event.id, `${sessionId}:${capabilityId}:${string(event.operationRunId, operation)}:${jobId}`);
    if (!identity) continue;
    const target = isInvocation ? calls : legacy;
    const previous = target.get(identity);
    // Start replay cannot roll back a completed invocation.
    if (previous && sdkEvent === "invocation.started") continue;
    const endedAt = sdkEvent === "invocation.started" ? undefined : string(data.endedAt, timestamp);
    const durationMs = number(data.durationMs) ?? Math.max(0,
      (instant(endedAt) ?? now) - (instant(data.startedAt) ?? instant(previous?.startedAt) ?? now));
    const startedAt = string(data.startedAt, previous?.startedAt ?? new Date(Math.max(0, (instant(endedAt) ?? now) - durationMs)).toISOString());
    const status = sdkEvent === "invocation.started" ? "running"
      : ["completed", "failed", "aborted"].includes(String(data.status)) ? data.status as "completed" | "failed" | "aborted" : "failed";
    target.set(identity, {
      invocationId: isInvocation ? identity : `legacy:${identity}`,
      precision: isInvocation ? "invocation" : "legacy-job",
      ...(sessionId ? { sessionId } : {}), ...(capabilityId ? { capabilityId } : {}),
      phase: capabilityId === "init" || event.scope === "init" ? "preparation" : capabilityId === "run" || event.scope === "run" ? "optimization" : "unknown",
      operation, jobId,
      ...(typeof data.parentJobId === "string" ? { parentJobId: data.parentJobId } : {}),
      depth: number(data.depth) ?? 0,
      provider: string(data.provider), model: string(data.model), startedAt, ...(endedAt ? { endedAt } : {}), status,
      durationMs, usage: tokens(data.usage),
    });
  }
  // Legacy parent JobResult includes its descendants. Only root estimates are
  // usable, and legacy roots with modern calls are suppressed to avoid
  // mixing parent aggregates with invocation facts. Unknown historical work is
  // represented by precision, not fabricated exact invocation counts.
  const scopeKey = (call: UsageInvocation) => `${call.sessionId ?? ""}:${call.capabilityId ?? ""}`;
  const modernJobs = new Set([...calls.values()].flatMap((entry) => [
    `${scopeKey(entry)}:${entry.jobId}`,
    ...(entry.parentJobId ? [`${scopeKey(entry)}:${entry.parentJobId}`] : []),
  ]));
  const estimates = [...legacy.values()].filter((entry) => !entry.parentJobId && entry.depth === 0 && !modernJobs.has(`${scopeKey(entry)}:${entry.jobId}`));
  const invocations = [...calls.values(), ...estimates].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.invocationId.localeCompare(b.invocationId));
  const groups = Object.fromEntries((["phase", "operation", "job", "model"] as const).map((key) => {
    const grouped = new Map<string, UsageInvocation[]>();
    for (const call of invocations) {
      const name = key === "job" ? call.jobId : key === "model" ? `${call.provider}/${call.model}` : call[key];
      grouped.set(name, [...grouped.get(name) ?? [], call]);
    }
    return [key, Object.fromEntries([...grouped].map(([name, entries]) => [name, summarize(entries, now)]))];
  })) as UsageLedger["groups"];
  return {
    schemaVersion: 1,
    precision: calls.size ? estimates.length ? "mixed" : "invocation" : estimates.length ? "legacy-job" : "empty",
    totals: summarize(invocations, now), groups, invocations,
    unknowns: { invocationIds: invocations.filter((entry) => unknownUsage(entry.usage)).map((entry) => entry.invocationId), legacyPrecision: estimates.length > 0 },
  };
}
