import { createHash, randomUUID } from "node:crypto";
import { embedLogo } from "./logo.ts";
import { open, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import type { InitEvent } from "../capabilities/init/protocol.ts";
import type { RunEvent } from "../capabilities/run/protocol.ts";
import type { Interaction, SessionCommand, SessionEvent, SessionSnapshot } from "../session/protocol.ts";
import type { FlywheelSession } from "../session/session.ts";
import { buildUsageLedger, USAGE_LEDGER_JSON_SCHEMA, type UsageLedger } from "../session/usage-ledger.ts";
import type { CommandReceipt } from "../session/command-inbox.ts";
import { ExecutionTreeProjection, type ExecutionNode } from "../tui/execution-tree.ts";
import { officialEvidence, resolveEvidenceFile } from "./evidence.ts";

type DomainEvent = InitEvent | RunEvent;
type GuiNode = ExecutionNode & { detailKey?: string; childCount?: number };

export interface GuiTimelineEntry {
  ordinal?: number;
  detailId?: string;
  id: string;
  timestamp: string;
  capabilityId?: string;
  operationId?: string;
  jobId?: string;
  parentJobId?: string;
  itemId?: string;
  interactionId?: string;
  interactionRevision?: number;
  requester?: Interaction["requestedBy"];
  officialTitle?: string;
  streamKey?: string;
  sdkEvent?: string;
  category: "text" | "agent" | "tool" | "command" | "file" | "runtime" | "error";
  kind: "message" | "event";
  actor: string;
  title: string;
  body?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  raw: unknown;
}

export interface SessionGuiState {
  revision: number;
  conversationInput: boolean;
  projectRoot: string;
  chain: readonly string[];
  readOnly: boolean;
  snapshot: SessionSnapshot;
  nodes: GuiNode[];
  timeline: GuiTimelineEntry[];
  history: { total: number; before: number };
  nodeHistory: { total: number; before: number };
  pendingInteractionAnswered: boolean;
  interactionRevision?: number;
  commandPending: boolean;
  commandError?: string;
  usage: UsageLedger;
  commands: CommandReceipt[];
  projectNavigation?: { recentProjects: readonly string[] };
}

export interface SessionGuiProjectNavigation {
  recentProjects: readonly string[];
  switchProject(projectPath: string): Promise<string>;
}

export interface SessionGuiOptions {
  port?: number;
  onListening?: (url: string) => void;
  readOnly?: boolean;
  startPaused?: boolean;
  projectNavigation?: SessionGuiProjectNavigation;
}

export interface SessionGuiServer {
  url: string;
  reportError(error: unknown): void;
  waitUntilSessionStops(): Promise<void>;
  close(): Promise<void>;
}

function parseInteraction(interaction: Interaction, input: unknown): string | boolean {
  if (interaction.kind === "confirm") {
    if (typeof input === "boolean") return input;
    const value = String(input ?? "").trim();
    if (["y", "yes", "是", "确认", "同意", "批准", "true"].includes(value.toLowerCase())) return true;
    if (["n", "no", "否", "不确认", "不同意", "拒绝", "false"].includes(value.toLowerCase())) return false;
    throw new Error("请使用确认按钮；如需讨论，可直接在输入框中发送消息。");
  }
  const value = String(input ?? "").trim();
  if (interaction.kind === "select") {
    const selected = interaction.options?.[Number(value) - 1];
    const match = selected ?? interaction.options?.find((option) => option.value === value);
    if (!match) throw new Error("请选择当前问题提供的有效选项。");
    return match.value;
  }
  return value;
}

function domainCapability(event: DomainEvent, fallback?: string): string {
  if ((event as InitEvent).scope === "init") return "init";
  return fallback ?? "run";
}

function eventTone(type: string, data?: Record<string, unknown>): GuiTimelineEntry["tone"] {
  const item = data?.item && typeof data.item === "object"
    ? data.item as Record<string, unknown>
    : undefined;
  const status = data?.status ?? item?.status;
  if (item?.type === "command_execution" && typeof item.exit_code === "number" && item.exit_code !== 0) return "danger";
  if (type.includes("failed") || type.includes("blocked") || status === "failed" || status === "error" || status === "blocked") return "danger";
  if (type === "runtime.budget.exhausted") return "warning";
  if (status === "paused" || status === "waiting_for_user" || status === "aborted") return "warning";
  if (type.includes("aborting") || type.includes("requested") || type.includes("opened")) return "warning";
  if (type.includes("completed") || type.includes("passed") || type.includes("resolved")) return "success";
  return "neutral";
}

function domainEventTitle(event: DomainEvent): string {
  const data = event.data ?? {};
  const job = String(data.job ?? "Agent");
  if (event.type === "job.started") return `Agent started: ${job}`;
  if (event.type === "job.completed") return `Agent completed: ${job}`;
  if (event.type === "job.event") {
    const sdkEvent = String(data.sdkEvent ?? "activity");
    if (/^assistance\.(admitted|denied|settled)$/.test(sdkEvent) && typeof data.message === "string") return data.message;
    const item = (data.item ?? {}) as Record<string, unknown>;
    if (item.type === "command_execution") {
      const lifecycle = item.status === "failed" || item.status === "error" || (typeof item.exit_code === "number" && item.exit_code !== 0)
        ? "failed"
        : sdkEvent.slice("item.".length) || sdkEvent;
      return `Command ${lifecycle}: ${String(item.command ?? "")}`;
    }
    if (item.type === "mcp_tool_call") return `Tool ${sdkEvent.slice("item.".length) || sdkEvent}: ${String(item.server ?? "tool")}.${String(item.tool ?? "unknown")}`;
    if (item.type === "web_search") return `Web search: ${String(item.query ?? "")}`;
    if (item.type === "reasoning") return `Reasoning: ${job}`;
    if (item.type === "file_change") return `File changes: ${job}`;
    if (item.type === "todo_list") return `Agent plan: ${job}`;
    return `${job}: ${sdkEvent}`;
  }
  if (event.type === "operation.started") return `Operation started: ${event.operation}`;
  if (event.type === "operation.completed") return `Operation completed: ${String(event.data?.operationId ?? event.operation)}`;
  if (event.type === "runtime.budget.exhausted") return `已暂停：${({ attempts: "候选尝试次数", time: "活跃执行时间", tokens: "已知 token", repair: "自动修复次数" } as Record<string, string>)[String(data.reason)] ?? "执行"}预算已用完，进度已保留。`;
  if (event.type === "operation.activity" && data.needsInput === true && typeof data.message === "string") return `需要你确认：${data.message}`;
  if (event.type === "operation.activity" && typeof data.retained === "boolean") return data.retained
    ? `候选已保留为正式版本${(event as RunEvent).version ? ` ${(event as RunEvent).version}` : ""}${data.target === "achieved" ? "，目标已达成" : data.target === "inconclusive" ? "（目标未判定）" : ""}`
    : "候选未保留，继续使用当前版本。";
  if (event.type === "operation.activity") return String(event.data?.message ?? "Operation activity");
  if (event.type === "runtime.blocked") return `Runtime blocked: ${String(event.data?.error ?? "unknown error")}`;
  if (event.type === "gate.opened") return `Human gate: ${String(event.data?.reason ?? "confirmation required")}`;
  if (event.type === "gate.resolved") return `Human gate resolved: ${String(event.data?.decision ?? "continue")}`;
  return event.type.replaceAll(".", " ");
}

function domainEntry(event: DomainEvent, capabilityId: string | undefined, ordinal: number): GuiTimelineEntry {
  const data = event.data ?? {};
  const item = (data.item ?? {}) as Record<string, unknown>;
  const resolvedCapability = domainCapability(event, capabilityId);
  const sdkEvent = typeof data.sdkEvent === "string" ? data.sdkEvent : undefined;
  const jobId = typeof data.jobId === "string" ? data.jobId
    : typeof event.jobId === "string" ? event.jobId : undefined;
  const operationId = typeof data.operationId === "string" ? data.operationId : event.operation;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  const streamKey = event.type === "job.event" && itemId
    ? `${resolvedCapability}:${jobId ?? String(data.job ?? "Agent")}:${itemId}`
    : undefined;
  const itemType = String(item.type ?? "");
  const category: GuiTimelineEntry["category"] = eventTone(event.type, data) === "danger" || itemType === "error"
    ? "error"
    : itemType === "command_execution" ? "command"
    : itemType === "mcp_tool_call" || itemType === "web_search" ? "tool"
    : itemType === "file_change" ? "file"
    : event.type.startsWith("job.") || itemType === "reasoning" || itemType === "todo_list" ? "agent"
    : "runtime";
  const base = {
    id: `domain:${resolvedCapability}:${event.id || `legacy-${ordinal}`}`,
    timestamp: event.timestamp,
    capabilityId: resolvedCapability,
    operationId,
    ...(jobId ? { jobId } : {}),
    ...(typeof data.parentJobId === "string" ? { parentJobId: data.parentJobId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(streamKey ? { streamKey } : {}),
    ...(sdkEvent ? { sdkEvent } : {}),
    category,
    raw: event,
  };
  if (event.type === "job.event" && ["item.updated", "item.completed"].includes(String(data.sdkEvent))
    && item.type === "agent_message") {
    return {
      ...base,
      category: "text",
      kind: "message",
      actor: String(data.job ?? "Agent"),
      title: data.audience === "user" || /(?:^|:|\s)manager$/.test(String(data.job ?? "")) ? "Conversation stream" : "Agent reply",
      body: String(item.text ?? ""),
      tone: "neutral",
    };
  }
  if (event.type === "manager.responded" && typeof data.message === "string") {
    return {
      ...base,
      category: "text",
      kind: "message",
      actor: "Manager",
      title: "Manager reply",
      body: data.message,
      tone: "neutral",
    };
  }
  return {
    ...base,
    kind: "event",
    actor: String(data.job ?? "Runtime"),
    title: domainEventTitle(event),
    tone: eventTone(event.type, data),
  };
}

function sessionEntry(event: SessionEvent, ordinal: number): GuiTimelineEntry | undefined {
  const base = {
    id: `session:${ordinal}:${event.timestamp}:${event.type}:${event.capabilityId ?? "session"}`,
    timestamp: event.timestamp,
    capabilityId: event.capabilityId,
    category: "runtime" as GuiTimelineEntry["category"],
    raw: event,
  };
  if (event.type === "intervention.submitted") {
    return {
      ...base,
      category: "text",
      kind: "message",
      actor: event.data?.source === "tui" ? "You · TUI" : event.data?.source === "gui" ? "You · GUI" : "You",
      title: "User message",
      body: String(event.data?.message ?? ""),
      tone: "neutral",
    };
  }
  if (event.type === "interaction.responded") {
    return {
      ...base,
      category: "text",
      kind: "message",
      actor: event.data?.source === "tui" ? "You · TUI" : event.data?.source === "gui" ? "You · GUI" : "You",
      title: "Interaction response",
      body: String(event.data?.displayValue ?? event.data?.value ?? ""),
      tone: "neutral",
    };
  }
  if (event.type === "interaction.requested") {
    const interaction = event.data?.interaction as Interaction | undefined;
    if (!interaction) return undefined;
    const requestedBy = interaction.requestedBy.type === "agent"
      ? interaction.requestedBy.label : "Runtime";
    return {
      ...base,
      category: "text",
      kind: "message",
      actor: requestedBy,
      title: "需要用户输入",
      interactionId: interaction.id,
      requester: interaction.requestedBy,
      body: [interaction.question, interaction.description].filter(Boolean).join("\n\n"),
      tone: "warning",
    };
  }
  if (event.type === "capability.event") return undefined;
  return {
    ...base,
    category: eventTone(event.type, event.data) === "danger" ? "error" : "runtime",
    kind: "event",
    actor: "Runtime",
    title: event.type.replaceAll(".", " "),
    tone: eventTone(event.type, event.data),
  };
}

class GuiProjection {
  private readonly tree: ExecutionTreeProjection;
  private readonly entries: GuiTimelineEntry[] = [];
  private readonly seenTimeline = new Set<string>();
  private readonly seenSessionEntries = new Set<string>();
  private readonly seenDomainEntries = new Set<string>();
  private sessionOrdinal = 0;
  private domainOrdinal = 0;
  private readonly answeredInteractions = new Set<string>();
  private readonly interactionRevisions = new Map<string, number>();

  constructor(projectRoot: string) {
    this.tree = new ExecutionTreeProjection(projectRoot);
  }

  ingestSession(event: SessionEvent): void {
    const sessionKey = JSON.stringify(event);
    if (this.seenSessionEntries.has(sessionKey)) return;
    this.seenSessionEntries.add(sessionKey);
    const requested = event.type === "interaction.requested" ? event.data?.interaction as Interaction | undefined : undefined;
    if (requested) {
      this.interactionRevisions.set(requested.id, this.interactionRevision(requested.id) + 1);
      this.answeredInteractions.delete(requested.id);
    }
    if (event.type === "interaction.responded" && typeof event.data?.interactionId === "string") {
      this.answeredInteractions.add(event.data.interactionId);
    }
    if (event.type === "capability.event") {
      const domain = event.data?.event as DomainEvent | undefined;
      if (domain) this.ingestDomain(event.capabilityId, domain);
    } else {
      this.tree.ingestSession(event);
      const entry = sessionEntry(event, this.sessionOrdinal++);
      if (entry) this.append({ ...entry, ...(requested ? { interactionRevision: this.interactionRevision(requested.id) } : {}) });
    }
  }

  ingestDomain(capabilityId: string | undefined, event: DomainEvent): void {
    const resolvedCapability = domainCapability(event, capabilityId);
    this.tree.ingestDomain(resolvedCapability, event);
    const domainKey = event.id
      ? `${resolvedCapability}:${event.id}`
      : `${resolvedCapability}:${JSON.stringify(event)}`;
    if (this.seenDomainEntries.has(domainKey)) return;
    this.seenDomainEntries.add(domainKey);
    this.append(domainEntry(event, capabilityId, this.domainOrdinal++));
  }

  private append(entry: GuiTimelineEntry): void {
    const key = `${entry.id}:${JSON.stringify(entry.raw)}`;
    if (this.seenTimeline.has(key)) return;
    this.seenTimeline.add(key);
    this.entries.push({ ...entry, ordinal: this.entries.length });
  }

  nodes(): ExecutionNode[] {
    // Keep the same Manager lane that the TUI exposes for the selected Capability.
    this.tree.jobs();
    return this.tree.nodesSnapshot();
  }
  navigationNodes(): ExecutionNode[] {
    return this.nodes().filter((node) => !["turn", "command", "tool"].includes(node.kind));
  }
  nodePage(before?: number): { nodes: GuiNode[]; total: number; before: number } {
    const all = this.navigationNodes();
    const end = Math.min(before ?? all.length, all.length);
    const start = Math.max(0, end - 200);
    const byId = new Map(all.map((node) => [node.id, node]));
    const selected = new Set<string>();
    const active = before === undefined ? ["operation", "agent", "manager"].flatMap((kind) =>
      all.filter((node) => node.kind === kind && node.status === "running")
        .sort((a, b) => (a.startedAt || "").localeCompare(b.startedAt || "")).slice(-1)) : [];
    for (const node of [...all.slice(start, end), ...active]) {
      let current: ExecutionNode | undefined = node;
      while (current && !selected.has(current.id)) {
        selected.add(current.id);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
    }
    return { nodes: all.filter((node) => selected.has(node.id)).map(wireNode), total: all.length, before: start };
  }

  timeline(): GuiTimelineEntry[] { return [...this.entries]; }
  count(): number { return this.entries.length; }
  entry(id: string): GuiTimelineEntry | undefined { return this.entries.find((entry) => entry.id === id); }
  page(before = this.entries.length, limit = 250): { timeline: GuiTimelineEntry[]; before: number } {
    const timeline: GuiTimelineEntry[] = [];
    let cursor = Math.min(before, this.entries.length);
    let bytes = 0;
    while (cursor > 0 && timeline.length < limit) {
      const entry = wireEntry(this.entries[cursor - 1]);
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (timeline.length && bytes + size > 262_144) break;
      bytes += size;
      timeline.unshift(entry);
      cursor -= 1;
    }
    return { timeline, before: cursor };
  }
  since(after: number): { timeline: GuiTimelineEntry[]; after: number } {
    const timeline: GuiTimelineEntry[] = [];
    let cursor = after;
    let bytes = 0;
    while (cursor < this.entries.length && timeline.length < 250) {
      const entry = wireEntry(this.entries[cursor]);
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (timeline.length && bytes + size > 262_144) break;
      timeline.push(entry); bytes += size; cursor += 1;
    }
    return { timeline, after: cursor };
  }
  recentConversation(): GuiTimelineEntry[] {
    return this.entries.filter((entry) => entry.kind === "message" && entry.title !== "Agent reply").slice(-6).map(wireEntry);
  }
  interactionAnswered(id: string): boolean { return this.answeredInteractions.has(id); }
  interactionRevision(id: string): number { return this.interactionRevisions.get(id) ?? 0; }
}

function nodeDetailKey(node: ExecutionNode): string {
  return createHash("sha256").update(JSON.stringify(node)).digest("hex");
}

function wireNode(node: ExecutionNode): GuiNode {
  return { ...node, label: node.label.slice(0, 240), lines: [], children: [], childCount: node.children.length,
    metadata: { jobId: node.metadata.jobId, sessionId: node.metadata.sessionId, sessionKey: node.metadata.sessionKey },
    detailKey: nodeDetailKey(node) };
}

function wireEntry(entry: GuiTimelineEntry): GuiTimelineEntry {
  const evidence = officialEvidence([entry])[0];
  if (evidence) entry = { ...entry, officialTitle: evidence.title };
  if (Buffer.byteLength(JSON.stringify(entry)) <= 4096) return entry;
  const raw = entry.raw as { type?: string; version?: string };
  return { ...entry, actor: entry.actor.slice(0, 160), title: entry.title.slice(0, 256), body: entry.body?.slice(0, 1024),
    raw: { type: raw?.type, version: raw?.version }, detailId: entry.id };
}

function assetPath(name: string): string {
  return path.resolve(import.meta.dirname, "..", "..", "system-assets", "gui", name);
}

function contentType(name: string): string {
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  return "text/javascript; charset=utf-8";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  if (!body) return {};
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

export async function startSessionGuiServer(
  session: FlywheelSession,
  options: SessionGuiOptions = {},
): Promise<SessionGuiServer> {
  const projection = new GuiProjection(session.projectRoot);
  const usageEvents: unknown[] = [];
  const receipts = new Map<string, CommandReceipt>();
  const observeUsage = (event: unknown) => {
    const raw = event as { type?: string; data?: { event?: { type?: string; data?: { sdkEvent?: string } } } };
    const domain = raw.type === "capability.event" ? raw.data?.event : raw as { type?: string; data?: { sdkEvent?: string } };
    if (raw.type?.startsWith("session.") || domain?.type === "job.started" || domain?.type === "job.completed"
      || domain?.data?.sdkEvent?.startsWith("invocation.")) usageEvents.push(event);
  };
  let commandError: string | undefined;
  let pendingCommandCount = 0;
  let commandQueue = Promise.resolve();
  let admissionQueue = Promise.resolve();
  const reservedInteractionIds = new Set<string>();
  const receiptReservations = new Map<string, string>();
  let closePromise: Promise<void> | undefined;
  const clients = new Map<ServerResponse, { cursor: number; nodes: Map<string, string> }>();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const token = randomUUID();
  let revision = 0;

  for (const event of await session.history()) { projection.ingestSession(event); observeUsage(event); }
  for (const receipt of await session.commandReceipts()) receipts.set(receipt.clientRequestId, receipt);
  for (const raw of await session.activeHistory()) {
    const domain = raw as DomainEvent;
    if (domain && typeof domain === "object" && typeof domain.type === "string") {
      projection.ingestDomain(session.snapshot().activeCapabilityId, domain);
      observeUsage(domain);
    }
  }

  const state = (): SessionGuiState => {
    const snapshot = session.snapshot();
    const page = projection.page();
    const nodePage = projection.nodePage();
    const visible = new Map([...projection.recentConversation(), ...page.timeline].map((entry) => [entry.id, entry]));
    return ({
    revision: ++revision,
    conversationInput: true,
    projectRoot: session.projectRoot,
    chain: session.chain,
    readOnly: options.readOnly === true,
    snapshot,
    nodes: nodePage.nodes,
    nodeHistory: { total: nodePage.total, before: nodePage.before },
    timeline: [...visible.values()].sort((a, b) => a.ordinal! - b.ordinal!),
    history: { total: projection.count(), before: page.before },
    pendingInteractionAnswered: snapshot.pendingInteraction
      ? projection.interactionAnswered(snapshot.pendingInteraction.id)
      : false,
    ...(snapshot.pendingInteraction ? { interactionRevision: projection.interactionRevision(snapshot.pendingInteraction.id) } : {}),
    commandPending: pendingCommandCount > 0 || [...receipts.values()].some(r => r.status === "accepted" || r.status === "running"),
    usage: buildUsageLedger(usageEvents),
    commands: [...receipts.values()].slice(-100),
    ...(commandError ? { commandError } : {}),
    ...(options.projectNavigation ? { projectNavigation: { recentProjects: options.projectNavigation.recentProjects } } : {}),
    });
  };
  const flush = () => {
    publishTimer = undefined;
    if (!clients.size) return;
    const current = state();
    const allNodes = projection.navigationNodes().map(wireNode);
    const serializedNodes = new Map(allNodes.map((node) => [node.id, JSON.stringify(node)]));
    for (const [client, previous] of clients) {
      if (client.destroyed || client.writableEnded) {
        clients.delete(client);
        continue;
      }
      // A stalled browser must not accumulate an unbounded socket buffer.
      if (client.writableLength > 4_000_000) {
        client.destroy();
        clients.delete(client);
        continue;
      }
      if (client.writableNeedDrain) continue;
      const delta = projection.since(previous.cursor);
      const timeline = delta.timeline;
      const changed = allNodes.filter((node) => previous.nodes.get(node.id) !== serializedNodes.get(node.id));
      const nodes = changed.slice(0, 200);
      const patch = { ...current, timeline, nodes, nodesPartial: true };
      client.write(`event: patch\ndata: ${JSON.stringify(patch)}\n\n`);
      for (const node of nodes) previous.nodes.set(node.id, serializedNodes.get(node.id)!);
      clients.set(client, { cursor: delta.after, nodes: previous.nodes });
      if (delta.after < projection.count() || changed.length > nodes.length) publish();
    }
  };
  const publish = () => {
    // Coalesce stream bursts, without delaying durable Session events.
    publishTimer ??= setTimeout(flush, 40);
  };

  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const unsubscribe = session.subscribe((event) => {
    projection.ingestSession(event);
    observeUsage(event);
    if (event.type === "command.updated") {
      const receipt = event.data?.receipt as CommandReceipt;
      receipts.set(receipt.clientRequestId, receipt);
      if (["failed", "interrupted"].includes(receipt.status)) commandError = receipt.error;
      if (["completed", "failed", "interrupted"].includes(receipt.status)) {
        const reserved = receiptReservations.get(receipt.clientRequestId);
        if (reserved) reservedInteractionIds.delete(reserved);
        receiptReservations.delete(receipt.clientRequestId);
      }
    }
    if (event.type === "session.stopped") {
      // Deliver the terminal snapshot before runSessionGui closes the transport.
      if (publishTimer) clearTimeout(publishTimer);
      flush();
      resolveStopped();
    }
    publish();
  });

  const sessionCommand = (command: Record<string, unknown>): SessionCommand => {
    const type = String(command.type ?? "");
    if (type === "message") {
      const message = typeof command.value === "string" ? command.value : "";
      if (!message.trim()) throw new Error("消息不能为空。");
      const current = session.snapshot().pendingInteraction;
      const interaction = current && session.snapshot().status !== "running" && !projection.interactionAnswered(current.id) ? current : undefined;
      if ((command.interactionId ?? null) !== (interaction?.id ?? null)) {
        throw new Error("问题已变化，草稿未发送。请查看最新对话后重新发送。");
      }
      // A Manager-owned question already has a semantic conversation in its Policy.
      // Do not parse free text as a confirm/select value in the GUI transport.
      if (interaction?.conversationWith?.sessionKey === "manager") {
        if (projection.interactionAnswered(interaction.id)) throw new Error("回复正在处理，请稍后再发送。");
        return { type: "interaction.respond", interactionId: interaction.id, value: message, inputKind: "text", source: "gui" };
      } else {
        return { type: "intervention.submit", message, source: "gui" };
      }
    } else if (type === "abort") return { type: "capability.abort" };
    else if (type === "resume") return { type: "capability.resume" };
    else if (type === "stop") return { type: "session.stop" };
    else if (type === "intervene") {
      const message = String(command.value ?? "");
      if (!message.trim()) throw new Error("消息不能为空。");
      return { type: "intervention.submit", message, source: "gui" };
    } else if (type === "submit") {
      const interaction = session.snapshot().pendingInteraction;
      if (typeof command.interactionId !== "string" || !interaction || command.interactionId !== interaction.id) {
        throw new Error("问题已变化，请查看最新问题后重新回复。");
      }
      if (interaction) {
        if (projection.interactionAnswered(interaction.id)) {
          throw new Error("Interaction response is already being processed");
        }
        return {
          type: "interaction.respond",
          interactionId: interaction.id,
          value: parseInteraction(interaction, command.value),
          inputKind: "choice",
          source: "gui",
        };
      }
    }
    throw new Error(`Unknown GUI command: ${type}`);
  };
  const executeCommand = async (command: Record<string, unknown>) => { await session.dispatch(sessionCommand(command)); };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && ["/", "/index.html", "/app.js", "/styles.css", "/flywheel-logo.svg"].includes(url.pathname)) {
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const logoNonce = randomUUID();
        const contentSecurityPolicy = name.endsWith(".svg")
          ? "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
          : `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${logoNonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'`;
        response.writeHead(200, {
          "content-type": contentType(name),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": contentSecurityPolicy,
        });
        let asset = await readFile(assetPath(name), name === "index.html" ? "utf8" : undefined);
        if (name === "index.html") {
          const html = await embedLogo(String(asset), logoNonce);
          asset = options.readOnly
            ? html.replace(/<!-- CONTROL_START -->[\s\S]*?<!-- CONTROL_END -->/g, "")
            : html.replaceAll("<!-- CONTROL_START -->", "").replaceAll("<!-- CONTROL_END -->", "");
        }
        response.end(asset);
        return;
      }
      if (url.searchParams.get("token") !== token) {
        sendJson(response, 403, { error: "Invalid GUI token" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/state") {
        sendJson(response, 200, state());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/usage") {
        sendJson(response, 200, buildUsageLedger(usageEvents)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/usage/schema") {
        sendJson(response, 200, USAGE_LEDGER_JSON_SCHEMA); return;
      }
      if (request.method === "GET" && url.pathname === "/api/commands") {
        sendJson(response, 200, { commands: await session.commandReceipts() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/history") {
        const before = Number(url.searchParams.get("before"));
        if (!url.searchParams.has("before") || !Number.isSafeInteger(before) || before < 0 || before > projection.count()) {
          sendJson(response, 400, { error: "Invalid history cursor" }); return;
        }
        sendJson(response, 200, projection.page(before));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/entry") {
        const entry = projection.entry(url.searchParams.get("id") ?? "");
        if (!entry) { sendJson(response, 404, { error: "Unknown event" }); return; }
        sendJson(response, 200, entry);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/node") {
        const node = projection.nodes().find((node) => node.id === url.searchParams.get("id"));
        if (!node) { sendJson(response, 404, { error: "Unknown node" }); return; }
        const detailKey = nodeDetailKey(node);
        if (url.searchParams.get("key") !== detailKey) {
          sendJson(response, 409, { error: "Node changed", node: wireNode(node) }); return;
        }
        sendJson(response, 200, { node, detailKey }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/nodes") {
        const before = Number(url.searchParams.get("before"));
        if (!url.searchParams.has("before") || !Number.isSafeInteger(before) || before < 0 || before > projection.navigationNodes().length) {
          sendJson(response, 400, { error: "Invalid node cursor" }); return;
        }
        sendJson(response, 200, projection.nodePage(before)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/context") {
        let goal: { available: boolean; preview?: string; truncated?: boolean; error?: string };
        try {
          const file = await resolveEvidenceFile(session.projectRoot, path.join(".flywheel", "goal.md"));
          const handle = await open(file, "r");
          try {
            const buffer = Buffer.alloc(16_384);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            goal = { available: true, preview: new TextDecoder().decode(buffer.subarray(0, bytesRead), { stream: bytesRead === buffer.length }),
              truncated: (await handle.stat()).size > bytesRead };
          } finally { await handle.close(); }
        } catch (error) {
          goal = { available: false, ...((error as NodeJS.ErrnoException).code === "ENOENT" ? {} : { error: "原始目标文件无法读取，请查看项目文件权限或路径。" }) };
        }
        sendJson(response, 200, { goal, results: officialEvidence(projection.timeline()).map(({ file, ...record }) => ({ ...record, hasFile: Boolean(file) })) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/evidence") {
        const id = url.searchParams.get("id");
        const file = id === "goal" ? path.join(".flywheel", "goal.md")
          : officialEvidence(projection.timeline()).find((record) => record.id === id)?.file;
        if (!file) { sendJson(response, 404, { error: "没有对应的已记录证据文件。" }); return; }
        const resolved = await resolveEvidenceFile(session.projectRoot, file);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
          "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
        await pipeline(createReadStream(resolved), response);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/stream") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const current = state();
        clients.set(response, { cursor: projection.count(), nodes: new Map(projection.navigationNodes().map(wireNode).map((node) => [node.id, JSON.stringify(node)])) });
        response.write(`event: refresh\ndata: ${JSON.stringify(current)}\n\n`);
        response.on("drain", publish);
        const removeClient = () => clients.delete(response);
        response.once("close", removeClient);
        response.once("error", removeClient);
        request.once("aborted", removeClient);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/command") {
        if (options.readOnly) {
          sendJson(response, 403, { error: "Observer GUI is read-only", state: state() });
          return;
        }
        const command = await requestJson(request);
        let releaseAdmission: (() => void) | undefined;
        if (command.clientRequestId !== undefined) {
          const previous = admissionQueue;
          admissionQueue = new Promise<void>((resolve) => { releaseAdmission = resolve; });
          await previous;
        }
        try {
        if (command.clientRequestId !== undefined) {
          if (typeof command.clientRequestId !== "string") { sendJson(response, 400, { error: "Invalid clientRequestId" }); return; }
          try {
            const previous = await session.commandReceipt(command.clientRequestId, command);
            if (previous) { sendJson(response, 202, { receipt: previous, state: state() }); return; }
          } catch (error) { sendJson(response, 409, { error: (error as Error).message, state: state() }); return; }
        }
        const currentInteraction = command.type === "submit" || command.type === "message"
          ? session.snapshot().pendingInteraction
          : undefined;
        const pendingInteraction = command.type === "message" && currentInteraction
          && (session.snapshot().status === "running" || projection.interactionAnswered(currentInteraction.id))
          ? undefined : currentInteraction;
        if (command.type === "submit" && (!pendingInteraction || command.interactionId !== pendingInteraction.id)) {
          sendJson(response, 409, { error: "问题已变化，请查看最新问题后重新回复。", state: state() });
          return;
        }
        if (command.type === "message" && (command.interactionId ?? null) !== (pendingInteraction?.id ?? null)) {
          sendJson(response, 409, { error: "问题已变化，草稿未发送。请查看最新对话后重新发送。", state: state() });
          return;
        }
        if (pendingInteraction && (
          (command.interactionRevision !== undefined || projection.interactionRevision(pendingInteraction.id) > 1)
          && command.interactionRevision !== projection.interactionRevision(pendingInteraction.id)
        )) {
          sendJson(response, 409, { error: "问题轮次已变化，请查看最新问题后重新回复。", state: state() });
          return;
        }
        if (pendingInteraction && (
          projection.interactionAnswered(pendingInteraction.id)
          || reservedInteractionIds.has(pendingInteraction.id)
        )) {
          sendJson(response, 409, {
            error: "Interaction response is already being processed",
            state: state(),
          });
          return;
        }
        const reservedInteractionId = pendingInteraction?.id;
        if (typeof command.clientRequestId === "string") {
          if (reservedInteractionId) reservedInteractionIds.add(reservedInteractionId);
          try {
            const receipt = await session.accept(sessionCommand(command), command.clientRequestId, command);
            if (reservedInteractionId) receiptReservations.set(command.clientRequestId, reservedInteractionId);
            commandError = undefined;
            receipts.set(receipt.clientRequestId, receipt);
            sendJson(response, 202, { receipt, state: state() });
            // Admission is complete; interaction replay protection remains in durable Session events.
          } catch (error) {
            if (reservedInteractionId) reservedInteractionIds.delete(reservedInteractionId);
            sendJson(response, 409, { error: (error as Error).message, state: state() });
          }
          publish(); return;
        }
        if (reservedInteractionId) reservedInteractionIds.add(reservedInteractionId);
        pendingCommandCount += 1;
        publish();
        const immediate = command.type === "abort" || command.type === "stop" || command.type === "intervene" || command.type === "message";
        const operation = immediate
          ? executeCommand(command)
          : commandQueue.then(() => executeCommand(command));
        if (!immediate) commandQueue = operation.catch(() => undefined);
        try {
          await operation;
          commandError = undefined;
          sendJson(response, 200, state());
        } catch (error) {
          commandError = error instanceof Error ? error.message : String(error);
          sendJson(response, 409, { error: commandError, state: state() });
        } finally {
          if (reservedInteractionId) reservedInteractionIds.delete(reservedInteractionId);
          pendingCommandCount -= 1;
        }
        publish();
        return;
        } finally { releaseAdmission?.(); }
      }
      if (request.method === "POST" && url.pathname === "/api/switch-project") {
        if (options.readOnly || !options.projectNavigation) {
          sendJson(response, 403, { error: "此工作台不能切换项目。" });
          return;
        }
        const input = await requestJson(request);
        if (typeof input.path !== "string") {
          sendJson(response, 400, { error: "请选择最近项目。" });
          return;
        }
        const key = process.platform === "win32" ? path.normalize(input.path).toLowerCase() : path.normalize(input.path);
        const allowed = options.projectNavigation.recentProjects.some((project) =>
          (process.platform === "win32" ? path.normalize(project).toLowerCase() : path.normalize(project)) === key);
        if (!allowed) {
          sendJson(response, 403, { error: "只能切换到已记录的最近项目。" });
          return;
        }
        sendJson(response, 200, { url: await options.projectNavigation.switchProject(input.path) });
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4317, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port ?? 4317;
  const guiUrl = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  (options.onListening ?? ((url) => console.log(`Flywheel GUI: ${url}`)))(guiUrl);

  const heartbeat = setInterval(() => {
    for (const client of clients.keys()) {
      if (client.destroyed || client.writableEnded) clients.delete(client);
      else if (!client.writableNeedDrain) client.write(": heartbeat\n\n");
    }
  }, 15_000);
  heartbeat.unref();

  if (session.snapshot().status === "stopped") resolveStopped();

  return {
    url: guiUrl,
    reportError: (error) => { commandError = error instanceof Error ? error.message : String(error); publish(); },
    waitUntilSessionStops: async () => await stoppedPromise,
    close: async () => {
      if (!closePromise) {
        closePromise = (async () => {
          await commandQueue;
          clearInterval(heartbeat);
          if (publishTimer) clearTimeout(publishTimer);
          unsubscribe();
          for (const client of clients.keys()) client.end();
          await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        })();
      }
      await closePromise;
    },
  };
}

export async function runSessionGui(
  session: FlywheelSession,
  options: SessionGuiOptions = {},
): Promise<SessionSnapshot> {
  if (options.startPaused) await session.restorePaused();
  const gui = await startSessionGuiServer(session, { ...options, readOnly: false });
  try {
    if (!options.startPaused) await session.dispatch({ type: "session.start" });
    await gui.waitUntilSessionStops();
    return session.snapshot();
  } finally {
    await gui.close();
  }
}
