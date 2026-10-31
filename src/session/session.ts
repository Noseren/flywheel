import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  Capability,
  CapabilityCommand,
  CapabilityFactory,
  CapabilityState,
  SessionCommand,
  SessionEvent,
  SessionSnapshot,
  SessionStatus,
} from "./protocol.ts";
import type { Interaction } from "./protocol.ts";
import { runCapability } from "./runner.ts";
import { CommandInbox, type CommandReceipt } from "./command-inbox.ts";

type SessionEventListener = (event: SessionEvent) => void;

interface PersistedSessionIdentity {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  capabilities: string[];
}

/** Lazy factories keep Session independent from concrete Init/Run implementations. */
export class CapabilityRegistry {
  private readonly factories = new Map<string, CapabilityFactory>();

  register(id: string, factory: CapabilityFactory): this {
    if (!id.trim()) throw new Error("Capability id may not be empty");
    if (this.factories.has(id)) throw new Error(`Capability already registered: ${id}`);
    this.factories.set(id, factory);
    return this;
  }

  has(id: string): boolean { return this.factories.has(id); }

  async create(id: string): Promise<Capability<any, any, any, any>> {
    const factory = this.factories.get(id);
    if (!factory) throw new Error(`Unknown capability: ${id}`);
    const capability = await factory();
    if (capability.id !== id) throw new Error(`Capability factory ${id} returned ${capability.id}`);
    return capability;
  }
}

/**
 * Owns the single user-facing lifecycle above all Capabilities.
 * Session routes commands and cancellation, but never interprets operation or task semantics.
 */
export class FlywheelSession {
  readonly projectRoot: string;
  readonly registry: CapabilityRegistry;
  readonly chain: string[];
  readonly eventsPath: string;
  readonly identityPath: string;
  private readonly listeners = new Set<SessionEventListener>();
  private activeIndex = 0;
  private active?: Capability<any, any, any, any>;
  private unsubscribeCapability?: () => void;
  private activation?: Promise<void>;
  private controller?: AbortController;
  private operation?: Promise<void>;
  private status: SessionStatus = "idle";
  private stopping = false;
  private activeState?: CapabilityState;
  private identity?: PersistedSessionIdentity;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly inbox: CommandInbox;
  private conversationQueue: Promise<void> = Promise.resolve();
  private conversationControllers = new Set<AbortController>();
  private interventionQueue: Promise<unknown> = Promise.resolve();

  constructor(
    projectRoot: string,
    registry: CapabilityRegistry,
    chain: string[],
  ) {
    this.projectRoot = projectRoot;
    this.registry = registry;
    if (!chain.length) throw new Error("Capability chain may not be empty");
    for (const id of chain) if (!registry.has(id)) throw new Error(`Capability chain references unknown capability: ${id}`);
    this.chain = [...chain];
    this.eventsPath = path.join(path.resolve(projectRoot), ".flywheel", "runtime", "session-events.jsonl");
    this.identityPath = path.join(path.resolve(projectRoot), ".flywheel", "runtime", "session.json");
    this.inbox = new CommandInbox(path.join(path.resolve(projectRoot), ".flywheel", "runtime", "commands.jsonl"),
      async (receipt) => { await this.emit("command.updated", { receipt }); });
  }

  /** Durable receipt does not wait for a model or for a business operation to finish. */
  accept(command: SessionCommand, clientRequestId: string, payload: unknown = command): Promise<CommandReceipt> {
    return this.inbox.accept(clientRequestId, payload, async () => { await this.dispatch({ ...command, clientRequestId }); });
  }

  commandReceipt(clientRequestId: string, payload?: unknown): Promise<CommandReceipt | undefined> {
    return this.inbox.lookup(clientRequestId, payload);
  }

  commandReceipts(): Promise<CommandReceipt[]> { return this.inbox.list(); }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.identity?.sessionId,
      status: this.status,
      activeCapabilityId: this.active?.id,
      activeCapabilityStatus: this.activeState?.status,
      pendingInteraction: this.activeState?.pendingInteraction,
      error: this.activeState?.lastError,
    };
  }

  async activeHistory(): Promise<unknown[]> {
    if (!this.active) await this.activate(this.activeIndex);
    return await this.active?.store.history?.() ?? [];
  }

  /** Hydrate an existing session for inspection without executing any Policy or Agent. */
  async restorePaused(): Promise<void> {
    if (this.operation || this.active) throw new Error("Session must be unopened before paused restore");
    const identity = JSON.parse(await readFile(this.identityPath, "utf8")) as PersistedSessionIdentity;
    if (identity.schemaVersion !== 1 || typeof identity.sessionId !== "string" || !identity.sessionId) throw new Error("Invalid Flywheel session identity");
    this.identity = identity;
    const history = await this.history();
    const lastCapability = history.findLast((event) => event.capabilityId && this.chain.includes(event.capabilityId));
    await this.activate(lastCapability?.capabilityId ? this.chain.indexOf(lastCapability.capabilityId) : 0);
    const restored: CapabilityState = structuredClone(await this.active!.store.load());
    this.activeState = restored;
    this.status = "idle";
    if (restored.status === "running") restored.status = "paused";
    // Session-level exceptions may not have reached the Capability state file.
    const recent = history.filter((event) => event.capabilityId === this.active!.id);
    const lastStart = recent.findLastIndex((event) => ["capability.started", "capability.resumed", "intervention.started"].includes(event.type));
    const blockedIndex = recent.findLastIndex((event, index) => index > lastStart && event.type === "capability.blocked");
    const blocked = recent[blockedIndex];
    if (blocked && typeof blocked.data?.error === "string") {
      restored.status = "blocked";
      restored.lastError = blocked.data.error;
      // Log order, not wall time, determines whether a recovery question is unanswered.
      const questionIndex = recent.findLastIndex((event, index) => index > blockedIndex && event.type === "interaction.requested");
      const question = recent[questionIndex]?.data?.interaction as Interaction | undefined;
      if (question && question.capabilityId === this.active!.id
        && !recent.slice(questionIndex + 1).some((event) => event.type === "interaction.responded"
          && event.data?.interactionId === question.id)) restored.pendingInteraction = question;
    }
  }

  async history(): Promise<SessionEvent[]> {
    // Capability forwarding queues its durable Session event synchronously.
    // A reader must observe all events accepted before this read, including
    // usage events whose append has not completed yet.
    await this.eventQueue;
    try {
      const content = await readFile(this.eventsPath, "utf8");
      return content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SessionEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async ensureIdentity(): Promise<{ identity: PersistedSessionIdentity; created: boolean }> {
    if (this.identity) return { identity: this.identity, created: false };
    try {
      const parsed = JSON.parse(await readFile(this.identityPath, "utf8")) as Partial<PersistedSessionIdentity>;
      if (parsed.schemaVersion !== 1 || typeof parsed.sessionId !== "string" || !parsed.sessionId) {
        throw new Error("Invalid Flywheel session identity");
      }
      const now = new Date().toISOString();
      const capabilities = [...new Set([
        ...(Array.isArray(parsed.capabilities)
          ? parsed.capabilities.filter((value): value is string => typeof value === "string")
          : []),
        ...this.chain,
      ])];
      this.identity = {
        schemaVersion: 1,
        sessionId: parsed.sessionId,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : now,
        updatedAt: now,
        capabilities,
      };
      await writeFile(this.identityPath, `${JSON.stringify(this.identity, null, 2)}\n`, "utf8");
      return { identity: this.identity, created: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = new Date().toISOString();
      this.identity = {
        schemaVersion: 1,
        sessionId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        capabilities: [...this.chain],
      };
      await mkdir(path.dirname(this.identityPath), { recursive: true });
      await writeFile(this.identityPath, `${JSON.stringify(this.identity, null, 2)}\n`, "utf8");
      return { identity: this.identity, created: true };
    }
  }

  private emit(type: SessionEvent["type"], data?: Record<string, unknown>): Promise<void> {
    // Capture ownership at emission, not after asynchronous disk work or a switch.
    const event: SessionEvent = {
      timestamp: new Date().toISOString(),
      type,
      capabilityId: this.active?.id,
      data,
    };
    this.eventQueue = this.eventQueue.then(async () => {
      const { identity } = await this.ensureIdentity();
      event.sessionId = identity.sessionId;
      await mkdir(path.dirname(this.eventsPath), { recursive: true });
      await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
      for (const listener of this.listeners) listener(event);
    });
    return this.eventQueue;
  }

  private async exposeBlocked(error: string, source?: "exception"): Promise<void> {
    const capabilityId = this.active?.id ?? "capability";
    const interaction: Interaction = {
      id: `session-blocked-recovery:${randomUUID()}`,
      capabilityId,
      operationId: this.activeState?.execution?.currentOperationId ?? capabilityId,
      requestedBy: { type: "runtime" },
      kind: "text",
      question: `当前步骤因以下问题暂停：${error}\n请说明处理意见，或在修复后回复“重试”。`,
      description: "只有你明确要求恢复时才会重试，不会绕过合约、评估器或工作区安全检查。输入 /stop 可停止。",
    };
    this.activeState = {
      ...(this.activeState ?? { status: "blocked" }),
      status: "blocked",
      lastError: error,
      pendingInteraction: interaction,
    };
    await this.emit("capability.blocked", { error, ...(source ? { source } : {}) });
    await this.emit("interaction.requested", { interaction });
  }

  private async activate(index: number): Promise<void> {
    if (this.activation) { await this.activation; if (this.active && this.activeIndex === index) return; }
    const activation = (async () => {
      this.unsubscribeCapability?.();
      this.activeIndex = index;
      this.active = await this.registry.create(this.chain[index]);
      this.activeState = undefined;
      this.unsubscribeCapability = this.active.store.subscribe((event) => {
        // Keep a failed audit queue rejected: the next awaited Session event fails closed.
        void this.emit("capability.event", { event }).catch(() => undefined);
      });
    })();
    this.activation = activation;
    try { await activation; } finally { if (this.activation === activation) this.activation = undefined; }
  }

  /** Run one Capability operation at a time and chain only durably completed Capabilities. */
  private async execute(
    mode: "start" | "resume" | "dispatch" | "intervene",
    payload?: CapabilityCommand | string,
  ): Promise<void> {
    if (this.operation) throw new Error("A capability operation is already running");
    this.controller = new AbortController();
    let operation!: Promise<void>;
    const release = () => {
      if (this.operation === operation) {
        this.operation = undefined;
        this.controller = undefined;
      }
    };
    operation = (async () => {
      if (!this.active) await this.activate(this.activeIndex);
      let nextMode = mode;
      let nextPayload = payload;
      let first = true;
      while (this.active) {
        const active = this.active;
        if (!first) this.controller = new AbortController();
        first = false;
        await this.emit(
          nextMode === "resume"
            ? "capability.resumed"
            : nextMode === "intervene"
              ? "intervention.started"
              : "capability.started",
          { mode: nextMode },
        );
        const signal = this.controller!.signal;
        // An abort may arrive while the durable start event is being written. Do not
        // invoke a Capability with an already-aborted signal: a third-party
        // Capability may subscribe after the abort event and otherwise wait forever.
        if (signal.aborted) {
          this.status = "idle";
          release();
          return;
        }
        const request = nextMode === "intervene"
          ? { type: "intervene" as const, message: String(nextPayload ?? "") }
          : nextMode === "dispatch"
          ? { type: "command" as const, command: nextPayload as CapabilityCommand }
          : nextMode === "resume"
            ? { type: "resume" as const }
            : { type: "start" as const };
        const capabilityOperation = runCapability(active, request, signal);
        this.status = "running";
        let activeState: CapabilityState;
        try {
          activeState = await capabilityOperation;
          this.activeState = activeState;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.status = "idle";
          release();
          await this.exposeBlocked(message, "exception");
          return;
        }

        const interaction = activeState.pendingInteraction;
        if (interaction?.capabilityId && interaction.capabilityId !== active.id) {
          this.status = "idle";
          throw new Error(
            `Interaction ${interaction.id} belongs to ${interaction.capabilityId}; active capability is ${active.id}`,
          );
        }

        if (activeState.status === "completed") {
          if (this.activeIndex + 1 < this.chain.length) {
            await this.emit("capability.completed");
            const previous = active.id;
            await this.activate(this.activeIndex + 1);
            await this.emit("capability.switched", { from: previous, to: this.active?.id });
            nextMode = "start";
            nextPayload = undefined;
            continue;
          }
          this.status = "idle";
          release();
          await this.emit("capability.completed");
          await this.emit("capability.idle", { reason: "completed" });
          return;
        }
        if (activeState.status === "blocked") {
          this.status = "idle";
          release();
          await this.exposeBlocked(activeState.lastError ?? "未知错误");
          return;
        }
        if (activeState.status === "stopped") {
          this.status = "stopped";
          release();
          await this.emit("session.stopped", { reason: activeState.lastError });
          return;
        }
        this.status = "idle";
        release();
        if (signal.aborted) return;
        if (activeState.pendingInteraction) {
          await this.emit("interaction.requested", { interaction: activeState.pendingInteraction });
        } else {
          await this.emit("capability.idle", { reason: activeState.status });
        }
        return;
      }
    })();
    this.operation = operation;
    try {
      await operation;
    } finally {
      release();
    }
  }

  async dispatch(command: SessionCommand): Promise<SessionSnapshot> {
    if ((this.stopping || this.status === "stopped") && !["session.stop", "capability.abort"].includes(command.type)) throw new Error("Session is stopped");
    if (command.type === "session.start") {
      const { identity, created } = await this.ensureIdentity();
      await this.emit(created ? "session.started" : "session.attached", {
        chain: this.chain,
        capabilities: identity.capabilities,
      });
      await this.execute("start");
    } else if (command.type === "capability.abort") {
      await this.abort();
    } else if (command.type === "capability.resume") {
      if (this.status !== "idle") throw new Error("Session is not idle");
      await this.execute("resume");
    } else if (command.type === "interaction.respond") {
      if (!this.activeState?.pendingInteraction) throw new Error("No interaction is pending");
      if (command.interactionId !== this.activeState.pendingInteraction.id) {
        throw new Error(`Unexpected interaction response: ${command.interactionId}`);
      }
      await this.emit("interaction.responded", {
        interactionId: command.interactionId,
        value: command.value,
        displayValue: typeof command.value === "boolean" ? command.value ? "确认" : "暂不确认"
          : this.activeState.pendingInteraction.options?.find(option => option.value === command.value)?.label ?? command.value,
        ...(command.inputKind ? { inputKind: command.inputKind } : {}),
        ...(command.source ? { source: command.source } : {}),
        ...(command.clientRequestId ? { clientRequestId: command.clientRequestId } : {}),
      });
      if (typeof command.value === "string" && this.active?.conversation?.canAccept(this.activeState)) {
        await this.intervene(command.value, command.source, command.clientRequestId, false);
      } else if (this.activeState.pendingInteraction.id === "session-blocked-recovery"
        || this.activeState.pendingInteraction.id.startsWith("session-blocked-recovery:")) {
        this.activeState.pendingInteraction = undefined;
        await this.intervene(String(command.value).trim() || "重试当前步骤", command.source);
      } else await this.execute("dispatch", command);
    } else if (command.type === "intervention.submit") {
      await this.intervene(command.message, command.source, command.clientRequestId);
    } else {
      this.stopping = true;
      await this.abort();
      this.status = "stopped";
      this.unsubscribeCapability?.();
      await this.emit("session.stopped");
    }
    return this.snapshot();
  }

  /** Abort is recoverable: wait for the active operation to settle before returning to idle. */
  async abort(): Promise<void> {
    for (const controller of this.conversationControllers) controller.abort(new Error("User intervention"));
    await this.conversationQueue.catch(() => undefined);
    if (!this.operation || !this.controller) return;
    if (this.status === "aborting") {
      await this.operation;
      return;
    }
    const operation = this.operation;
    const controller = this.controller;
    this.status = "aborting";
    controller.abort(new Error("User intervention"));
    await this.emit("capability.aborting");
    await operation;
    this.status = "idle";
    await this.emit("capability.idle", { reason: "aborted" });
  }

  async intervene(message: string, source?: "tui" | "gui" | "api", clientRequestId?: string, announce = true): Promise<void> {
    const value = message;
    if (!value.trim()) return;
    if (this.activation) await this.activation;
    if (this.stopping || this.status === "stopped") throw new Error("Session is stopped");
    if (this.active?.conversation?.canAccept(this.activeState)) {
      const active = this.active;
      const controller = new AbortController();
      this.conversationControllers.add(controller);
      if (announce) await this.emit("intervention.submitted", { message: value, ...(source ? { source } : {}), ...(clientRequestId ? { clientRequestId } : {}) });
      const receive = this.conversationQueue.then(async () => {
        if (controller.signal.aborted) return;
        const reply = await active.conversation!.receive({ message: value, signal: controller.signal,
          onEvent: async (type, data) => { await this.emit("capability.event", { event: {
            id: randomUUID(), timestamp: new Date().toISOString(), scope: active.id, operation: "conversation", type, data,
          } }); } });
        if (reply.message) await this.emit("capability.event", { event: {
          id: randomUUID(), timestamp: new Date().toISOString(), scope: active.id, operation: "conversation",
          type: "manager.responded", data: { message: reply.message },
        } });
      });
      this.conversationQueue = receive.catch(() => undefined);
      try { await receive; } finally { this.conversationControllers.delete(controller); }
      await this.conversationQueue;
      // Only Session resumes its runner, and only after a waiting intake has settled.
      if (!controller.signal.aborted && !this.operation && this.status === "idle"
        && this.active === active && this.activeState?.pendingInteraction?.id === "init.goal") await this.execute("resume");
      return;
    }
    // Admission stays non-blocking; conversations are ordered without racing two runner starts.
    let execution: Promise<void> | undefined;
    const admission = this.interventionQueue.then(async () => {
      if (this.stopping || this.status === "stopped") throw new Error("Session is stopped");
      if (this.operation) await this.abort();
      if (this.stopping) throw new Error("Session is stopped");
      await this.emit("intervention.submitted", { message: value, ...(source ? { source } : {}), ...(clientRequestId ? { clientRequestId } : {}) });
      execution = this.execute("intervene", value);
      // Observe immediately, even if the next admission waits for disk/cleanup.
      void execution.catch(() => undefined);
    });
    this.interventionQueue = admission.catch(() => undefined);
    await admission;
    await execution;
  }
}
