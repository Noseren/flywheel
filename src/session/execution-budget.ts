/** Mechanical limits shared by preparation, execution and protocol repair. */
export interface ExecutionBudgetLimits {
  candidateAttempts: number;
  activeMs: number;
  knownTokens: number;
}

export const DEFAULT_EXECUTION_BUDGET_LIMITS: ExecutionBudgetLimits = {
  candidateAttempts: 3,
  activeMs: 15 * 60_000,
  knownTokens: 500_000,
};

/** Runtime estimates, never measured usage or an Agent's cost promise. */
export interface BudgetEstimate { tokens: number; activeMs: number; source: string }
export interface BudgetReservation {
  kind: "required" | "assistance";
  estimate: BudgetEstimate;
  /** Frozen at optional admission; observations only affect future batches. */
  invocationEstimate?: BudgetEstimate;
  /** Whole-batch authority, distinct from predicted invocation duration. Absent on old reservations. */
  authorizedActiveMs?: number;
  tokensRemaining: number;
  activeMsRemaining: number;
  activeMsAtStart?: number;
  closed?: boolean;
}
export interface AssistanceAdmissionRequest {
  requestId: string;
  windowId: string;
  /** Hash binding the Runtime request, input snapshots and Policy revision. */
  binding: string;
  childCount: number;
  requiredReservationId: string;
  estimateClass?: string;
}
export interface AssistanceAdmission {
  requestId: string; windowId: string; binding: string;
  admitted: boolean; reason?: string; reservationId?: string;
  estimate?: BudgetEstimate;
  authorizedActiveMs?: number;
  requestFingerprint?: string;
}
export interface InvocationBudgetOptions {
  reservationId?: string;
  estimatedTokens?: number;
  estimatedActiveMs?: number;
  estimateClass?: string;
}
export interface BudgetInvocation {
  startedAt: number; endedAt?: number; tokens?: number;
  knownInputTokens?: number; knownOutputTokens?: number;
  estimatedTokens?: number; estimatedActiveMs?: number;
  unknownTokens?: number; reservationId?: string; estimateClass?: string;
  interrupted?: boolean;
}

export interface ExecutionBudgetState {
  schemaVersion: 1;
  limits: ExecutionBudgetLimits;
  attempts: string[];
  repairUsed: boolean;
  activeMs: number;
  knownTokens: number;
  unknownUsageInvocations: number;
  invocations: Record<string, BudgetInvocation>;
  /** Absent on old budgets: opening them never adds optional authority. */
  assistance?: { revision: 1; decisions: Record<string, AssistanceAdmission> };
  reservations?: Record<string, BudgetReservation>;
  /** Process activity shares elapsed time but carries no model/token usage. */
  processes?: Record<string, { startedAt: number; endedAt?: number }>;
  /** Last accounted wall time while at least one invocation was active. */
  activeUpdatedAt?: number;
}

export class ExecutionBudgetExhausted extends Error {
  readonly code = "EXECUTION_BUDGET_EXHAUSTED";
  readonly reason: "attempts" | "time" | "tokens" | "repair";
  constructor(reason: "attempts" | "time" | "tokens" | "repair") {
    super(`Execution budget exhausted: ${reason}`);
    this.reason = reason;
    this.name = "ExecutionBudgetExhausted";
  }
}

export function createExecutionBudgetState(limits: Partial<ExecutionBudgetLimits> = {}): ExecutionBudgetState {
  const resolved = { ...DEFAULT_EXECUTION_BUDGET_LIMITS, ...limits };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid execution budget ${key}`);
  }
  return { schemaVersion: 1, limits: resolved, attempts: [], repairUsed: false,
    activeMs: 0, knownTokens: 0, unknownUsageInvocations: 0, invocations: {},
    assistance: { revision: 1, decisions: {} }, reservations: {} };
}

/** One instance per persisted task budget. Mutations serialize across concurrent jobs.
 * Usage is a projection of actual invocation results; absent usage remains unknown.
 * Providers which report only final usage can exceed the known-token limit in flight.
 */
export class ExecutionBudget {
  private queue: Promise<void> = Promise.resolve();
  private checkpointFailed = false;
  readonly state: ExecutionBudgetState;
  private readonly checkpoint: () => Promise<void>;
  private readonly now: () => number;
  constructor(state: ExecutionBudgetState, checkpoint: () => Promise<void>, now: () => number = Date.now) {
    this.state = state;
    this.checkpoint = checkpoint;
    this.now = now;
  }

  private async mutate<T>(action: () => T): Promise<T> {
    const pending = this.queue.then(async () => {
      if (this.checkpointFailed) throw new Error("Execution budget checkpoint failed; refusing further work");
      const value = action();
      try { await this.checkpoint(); } catch (error) { this.checkpointFailed = true; throw error; }
      return value;
    });
    this.queue = pending.then(() => undefined, () => undefined);
    return await pending;
  }

  /** Conservative fallback pending same-model/context calibration. The maximum
   * observed matching invocation can increase this estimate, never lower it. */
  estimateInvocation(estimateClass = "model"): BudgetEstimate {
    const entries = Object.values(this.state.invocations).filter(entry => entry.estimateClass === estimateClass && entry.tokens !== undefined);
    return {
      tokens: Math.ceil(Math.max(32_000, ...entries.map(entry => entry.tokens! * 1.5))),
      activeMs: Math.ceil(Math.max(30_000, ...entries.map(entry => Math.max(0, (entry.endedAt ?? entry.startedAt) - entry.startedAt) * 1.5))),
      source: entries.length ? `runtime-fallback+observed-max:${estimateClass}` : `runtime-fallback:${estimateClass}`,
    };
  }

  private knownFor(entry: BudgetInvocation): number {
    return entry.tokens ?? ((entry.knownInputTokens ?? 0) + (entry.knownOutputTokens ?? 0));
  }

  private unknownFor(entry: BudgetInvocation): number {
    if (entry.tokens !== undefined) return 0;
    if (entry.estimatedTokens === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, entry.estimatedTokens - this.knownFor(entry));
  }

  /** K + U + R + E. Estimates remain separate from actual known tokens. */
  private occupiedTokens(): number {
    return this.state.knownTokens
      + Object.values(this.state.invocations).reduce((sum, entry) => sum + this.unknownFor(entry), 0)
      + Object.values(this.state.reservations ?? {}).reduce((sum, entry) => sum + entry.tokensRemaining, 0);
  }

  private optionalCommittedTokens(): number {
    return Object.values(this.state.reservations ?? {}).filter(entry => entry.kind === "assistance")
      .reduce((sum, entry) => sum + entry.tokensRemaining, 0)
      + Object.values(this.state.invocations).filter(entry => entry.reservationId && this.state.reservations?.[entry.reservationId]?.kind === "assistance")
        .reduce((sum, entry) => sum + this.knownFor(entry) + this.unknownFor(entry), 0);
  }

  private reservedActiveMs(): number {
    return Object.values(this.state.reservations ?? {}).reduce((sum, entry) => sum + entry.activeMsRemaining, 0);
  }

  private validateEstimate(estimate: BudgetEstimate): void {
    if (!Number.isSafeInteger(estimate.tokens) || estimate.tokens < 0
      || !Number.isSafeInteger(estimate.activeMs) || estimate.activeMs < 0 || !estimate.source)
      throw new Error("Invalid Runtime budget estimate");
  }

  /** Policy supplies an opaque estimate for the whole frozen evaluation. */
  async reserveRequiredWork(identity: string, estimate: BudgetEstimate): Promise<void> {
    await this.mutate(() => {
      this.validateEstimate(estimate);
      const existing = this.state.reservations?.[identity];
      if (existing) {
        if (existing.kind !== "required" || JSON.stringify(existing.estimate) !== JSON.stringify(estimate))
          throw new Error(`Required reservation binding changed: ${identity}`);
        if (existing.closed) throw new Error(`Required reservation is closed: ${identity}`);
        return;
      }
      this.assertAvailable();
      if (this.occupiedTokens() + estimate.tokens > this.state.limits.knownTokens) throw new ExecutionBudgetExhausted("tokens");
      if (this.state.activeMs + this.reservedActiveMs() + estimate.activeMs > this.state.limits.activeMs) throw new ExecutionBudgetExhausted("time");
      this.state.reservations ??= {};
      Object.defineProperty(this.state.reservations, identity, { value: {
        kind: "required", estimate: { ...estimate }, tokensRemaining: estimate.tokens, activeMsRemaining: estimate.activeMs, activeMsAtStart: this.state.activeMs,
      }, enumerable: true, configurable: true, writable: true });
    });
  }

  async admitAssistance(request: AssistanceAdmissionRequest): Promise<AssistanceAdmission> {
    return await this.mutate(() => {
      if (!request.requestId || !request.windowId || !request.binding || !request.requiredReservationId
        || !Number.isSafeInteger(request.childCount) || request.childCount < 1 || request.childCount > 2)
        throw new Error("Invalid assistance admission request");
      const decisions = this.state.assistance?.decisions;
      const previous = decisions?.[request.requestId];
      const requestFingerprint = JSON.stringify([request.windowId, request.binding, request.childCount, request.requiredReservationId, request.estimateClass ?? "model"]);
      if (previous) {
        if (previous.binding !== request.binding || previous.windowId !== request.windowId || previous.requestFingerprint !== requestFingerprint)
          throw new Error("Assistance request binding changed");
        return { ...previous, ...(previous.estimate ? { estimate: { ...previous.estimate } } : {}) };
      }
      const decision: AssistanceAdmission = { requestId: request.requestId, windowId: request.windowId, binding: request.binding, admitted: false, requestFingerprint };
      const deny = (reason: string) => {
        decision.reason = reason;
        if (decisions) Object.defineProperty(decisions, request.requestId, { value: decision, enumerable: true, configurable: true, writable: true });
        return { ...decision };
      };
      this.accountTime();
      if (!decisions) return deny("legacy-budget");
      if (Object.values(decisions).some(entry => entry.windowId === request.windowId)) return deny("window-used");
      if (Object.values(decisions).filter(entry => entry.admitted).length >= 2) return deny("batch-limit");
      const required = this.state.reservations?.[request.requiredReservationId];
      if (!required || required.kind !== "required" || required.closed) return deny("required-work-unreserved");
      if (Object.values(this.state.invocations).some(entry => entry.endedAt !== undefined && entry.tokens === undefined)) return deny("unknown-usage");
      const one = this.estimateInvocation(request.estimateClass);
      const estimate = { tokens: one.tokens * (request.childCount + 1), activeMs: one.activeMs * 2,
        source: `${one.source};children:${request.childCount};parent-continuation:1` };
      decision.estimate = estimate;
      if (this.optionalCommittedTokens() + estimate.tokens > Math.floor(this.state.limits.knownTokens * 0.2)) return deny("optional-token-limit");
      if (this.occupiedTokens() + estimate.tokens > this.state.limits.knownTokens) return deny("tokens");
      const authorizedActiveMs = 120_000;
      if (estimate.activeMs > authorizedActiveMs || this.state.activeMs + this.reservedActiveMs() + authorizedActiveMs > this.state.limits.activeMs) return deny("time");
      const reservationId = `assistance:${request.requestId}`;
      if (this.state.reservations?.[reservationId]) throw new Error("Assistance reservation identity collision");
      decision.admitted = true;
      decision.reservationId = reservationId;
      decision.authorizedActiveMs = authorizedActiveMs;
      this.state.reservations ??= {};
      Object.defineProperty(this.state.reservations, reservationId, { value: {
        kind: "assistance", estimate, invocationEstimate: { ...one }, authorizedActiveMs,
        tokensRemaining: estimate.tokens, activeMsRemaining: authorizedActiveMs, activeMsAtStart: this.state.activeMs,
      }, enumerable: true, configurable: true, writable: true });
      Object.defineProperty(decisions, request.requestId, { value: decision, enumerable: true, configurable: true, writable: true });
      return { ...decision, estimate: { ...estimate } };
    });
  }

  /** Caller confirms the batch/evaluation is terminal; only unstarted capacity is
   * released. Unknown invocation occupancy remains in U after this closes. */
  async closeReservation(identity: string): Promise<void> {
    await this.mutate(() => {
      const reservation = this.state.reservations?.[identity];
      if (!reservation || reservation.closed) return;
      if (Object.values(this.state.invocations).some(entry => entry.reservationId === identity && (entry.endedAt === undefined || entry.interrupted)))
        throw new Error("Cannot release an in-flight or interrupted reservation");
      reservation.tokensRemaining = 0;
      reservation.activeMsRemaining = 0;
      reservation.closed = true;
    });
  }

  private accountTime(): void {
    if (this.state.activeUpdatedAt !== undefined) {
      const now = this.now();
      this.state.activeMs += Math.max(0, now - this.state.activeUpdatedAt);
      this.state.activeUpdatedAt = now;
    }
  }

  private stopClockWhenIdle(): void {
    if (![...Object.values(this.state.invocations), ...Object.values(this.state.processes ?? {})]
      .some((entry) => entry.endedAt === undefined)) delete this.state.activeUpdatedAt;
  }

  async startProcess(identity: string): Promise<void> {
    await this.mutate(() => {
      this.assertAvailable();
      this.state.processes ??= {};
      if (Object.hasOwn(this.state.processes, identity)) throw new Error(`Duplicate process activity: ${identity}`);
      Object.defineProperty(this.state.processes, identity, { value: { startedAt: this.now() }, enumerable: true, configurable: true, writable: true });
      this.state.activeUpdatedAt ??= this.now();
    });
  }

  async finishProcess(identity: string): Promise<void> {
    await this.mutate(() => {
      const process = this.state.processes?.[identity];
      if (!process || process.endedAt !== undefined) return;
      this.accountTime();
      process.endedAt = this.now();
      this.stopClockWhenIdle();
    });
  }

  assertAvailable(): void {
    if (this.checkpointFailed) throw new Error("Execution budget checkpoint failed; refusing further work");
    this.accountTime();
    if (this.state.activeMs >= this.state.limits.activeMs) throw new ExecutionBudgetExhausted("time");
    if (this.state.knownTokens >= this.state.limits.knownTokens) throw new ExecutionBudgetExhausted("tokens");
  }

  remainingActiveMs(reservationId?: string): number {
    this.accountTime();
    const total = Math.max(0, this.state.limits.activeMs - this.state.activeMs);
    const reservation = reservationId ? this.state.reservations?.[reservationId] : undefined;
    if (!reservation || reservation.kind !== "assistance") return total;
    // Optional calls cannot run through the time retained for necessary work.
    // The batch limit follows active union time, so offline waiting grants none.
    const necessary = Object.values(this.state.reservations ?? {}).filter(entry => entry.kind === "required")
      .reduce((sum, entry) => sum + entry.activeMsRemaining, 0);
    const batch = (reservation.authorizedActiveMs ?? reservation.estimate.activeMs)
      - Math.max(0, this.state.activeMs - (reservation.activeMsAtStart ?? this.state.activeMs));
    return Math.max(0, Math.min(total - necessary, batch));
  }

  remainingInvocationActiveMs(identity: string): number {
    return this.remainingActiveMs(this.state.invocations[identity]?.reservationId);
  }

  async reserveAttempt(identity: string): Promise<void> {
    await this.mutate(() => {
      this.assertAvailable();
      if (this.state.attempts.includes(identity)) return;
      if (this.state.attempts.length >= this.state.limits.candidateAttempts) throw new ExecutionBudgetExhausted("attempts");
      this.state.attempts.push(identity);
    });
  }

  async claimRepair(): Promise<void> {
    await this.mutate(() => {
      this.assertAvailable();
      if (this.state.repairUsed) throw new ExecutionBudgetExhausted("repair");
      this.state.repairUsed = true;
    });
  }

  async startInvocation(identity: string, options?: InvocationBudgetOptions): Promise<void> {
    await this.mutate(() => {
      this.assertAvailable();
      if (Object.hasOwn(this.state.invocations, identity)) throw new Error(`Duplicate invocation: ${identity}`);
      const invocation: BudgetInvocation = { startedAt: this.now() };
      if (options) {
        const reservation = options.reservationId ? this.state.reservations?.[options.reservationId] : undefined;
        if (options.reservationId && (!reservation || reservation.closed)) throw new Error("Invocation reservation is unavailable");
        const fallback = this.estimateInvocation(options.estimateClass);
        // A batch's Child and parent slots retain their admission estimate even
        // when an earlier Child raises the estimate for future requests.
        const estimate = reservation?.kind === "assistance" && reservation.invocationEstimate
          ? reservation.invocationEstimate
          : { tokens: options.estimatedTokens ?? fallback.tokens, activeMs: options.estimatedActiveMs ?? fallback.activeMs, source: fallback.source };
        this.validateEstimate(estimate);
        if (reservation) {
          if (this.remainingActiveMs(options.reservationId) <= 0) throw new ExecutionBudgetExhausted("time");
          // Final provider usage can exceed its estimate in flight. Record it
          // honestly, but never start another optional call through the excess.
          if (reservation.kind === "assistance" && this.optionalCommittedTokens() > Math.floor(this.state.limits.knownTokens * 0.2))
            throw new ExecutionBudgetExhausted("tokens");
          if (reservation.tokensRemaining < estimate.tokens) throw new ExecutionBudgetExhausted("tokens");
          // R/E -> U, a transfer rather than a second charge. In-flight actual
          // overspend is recorded on completion, without rewriting estimates.
          if (this.occupiedTokens() > this.state.limits.knownTokens) throw new ExecutionBudgetExhausted("tokens");
          reservation.tokensRemaining -= estimate.tokens;
          reservation.activeMsRemaining = Math.max(0, reservation.activeMsRemaining - estimate.activeMs);
          invocation.reservationId = options.reservationId;
        } else if (this.occupiedTokens() + estimate.tokens > this.state.limits.knownTokens) throw new ExecutionBudgetExhausted("tokens");
        invocation.estimatedTokens = estimate.tokens;
        invocation.estimatedActiveMs = estimate.activeMs;
        invocation.estimateClass = options.estimateClass ?? "model";
      }
      Object.defineProperty(this.state.invocations, identity, { value: invocation, enumerable: true, configurable: true, writable: true });
      this.state.activeUpdatedAt ??= this.now();
    });
  }

  async finishInvocation(identity: string, usage?: { inputTokens?: number; outputTokens?: number } | null): Promise<void> {
    await this.mutate(() => {
      const invocation = this.state.invocations[identity];
      if (!Object.hasOwn(this.state.invocations, identity) || !invocation || invocation.tokens !== undefined) return;
      const wasUnknown = invocation.endedAt !== undefined;
      if (!wasUnknown) { this.accountTime(); invocation.endedAt = this.now(); }
      const before = this.knownFor(invocation);
      for (const [key, value] of [["knownInputTokens", usage?.inputTokens], ["knownOutputTokens", usage?.outputTokens]] as const) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0
          && invocation[key] !== undefined && invocation[key] !== value) throw new Error("Invocation usage binding changed");
      }
      for (const [key, value] of [["knownInputTokens", usage?.inputTokens], ["knownOutputTokens", usage?.outputTokens]] as const) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
          invocation[key] = value;
        }
      }
      this.state.knownTokens += this.knownFor(invocation) - before;
      if (invocation.knownInputTokens !== undefined && invocation.knownOutputTokens !== undefined) {
        invocation.tokens = invocation.knownInputTokens + invocation.knownOutputTokens;
        delete invocation.unknownTokens;
        delete invocation.interrupted;
        if (wasUnknown) this.state.unknownUsageInvocations -= 1;
      } else {
        if (!wasUnknown) this.state.unknownUsageInvocations += 1;
        const unknown = this.unknownFor(invocation);
        if (Number.isFinite(unknown)) invocation.unknownTokens = unknown;
      }
      this.stopClockWhenIdle();
    });
  }

  /** On process recovery, interrupted invocations retain unknown usage. Offline time
   * is excluded; completed ledger entries may be reconciled before this call. */
  async recoverInterrupted(): Promise<void> {
    await this.mutate(() => {
      for (const invocation of Object.values(this.state.invocations)) {
        if (invocation.endedAt === undefined) {
          invocation.endedAt = this.state.activeUpdatedAt ?? invocation.startedAt;
          invocation.interrupted = true;
          const unknown = this.unknownFor(invocation);
          if (Number.isFinite(unknown)) invocation.unknownTokens = unknown;
          this.state.unknownUsageInvocations += 1;
        }
      }
      for (const process of Object.values(this.state.processes ?? {})) {
        if (process.endedAt === undefined) process.endedAt = this.state.activeUpdatedAt ?? process.startedAt;
      }
      delete this.state.activeUpdatedAt;
    });
  }
}
