import { Writable } from "node:stream";

import type { RunEvent } from "../capabilities/run/protocol.ts";
import type { InitEvent } from "../capabilities/init/protocol.ts";
import type { SessionEvent } from "../session/protocol.ts";
import { AgentActivityRenderer } from "./renderers/agent-renderer.ts";

export type ExecutionNodeKind = "project" | "session" | "capability" | "manager" | "iteration" | "operation" | "interaction" | "gate" | "agent" | "turn" | "command" | "tool";
export type ExecutionNodeStatus = "idle" | "running" | "waiting" | "completed" | "failed" | "blocked" | "aborted" | "stopped";

export interface ExecutionNode {
  id: string;
  parentId?: string;
  kind: ExecutionNodeKind;
  label: string;
  status: ExecutionNodeStatus;
  startedAt?: string;
  completedAt?: string;
  children: string[];
  lines: string[];
  metadata: Record<string, unknown>;
  progress?: {
    starts: number;
    artifactRepairs: number;
    evaluatorReturns: number;
    lastIssue?: { eventId: string; text: string; timestamp: string };
  };
}

export interface VisibleExecutionNode {
  node: ExecutionNode;
  depth: number;
  expanded: boolean;
}

export type ExecutionSelector = "navigation" | "jobs" | "details";

function normalizeStatus(value: unknown): ExecutionNodeStatus {
  if (value === "running" || value === "completed" || value === "blocked" || value === "stopped") return value;
  if (value === "paused" || value === "waiting_for_user") return "waiting";
  return "idle";
}

function capture(renderer: AgentActivityRenderer, event: { data?: Record<string, unknown> }): string[] {
  let value = "";
  const output = new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } });
  renderer.render(event, output);
  return value.split(/\r?\n/).filter(Boolean).map((line) => line.trimStart());
}

function itemKind(item: Record<string, unknown>): ExecutionNodeKind | undefined {
  if (item.type === "command_execution") return "command";
  if (item.type === "mcp_tool_call" || item.type === "web_search") return "tool";
  return undefined;
}

function itemLabel(item: Record<string, unknown>): string {
  if (item.type === "command_execution") return String(item.command ?? "命令").replace(/\s+/g, " ").slice(0, 100);
  if (item.type === "mcp_tool_call") return `${String(item.server ?? "tool")}.${String(item.tool ?? "unknown")}`;
  if (item.type === "web_search") return `Web 搜索：${String(item.query ?? "")}`;
  return String(item.type ?? "活动");
}

function operationActivity(event: InitEvent | RunEvent): string {
  if (event.type === "interaction.requested") return `等待确认：${String(event.data?.question ?? "用户输入")}`;
  if (event.type === "interaction.resolved") return `已确认：${String(event.data?.value ?? "完成")}`;
  if (event.type === "gate.opened") return `需要人工确认：${String(event.data?.reason ?? "发现风险")}`;
  if (event.type === "gate.resolved") return `人工确认已处理：${String(event.data?.decision ?? "continue")}`;
  if (event.type === "runtime.blocked") return `已阻断：${String(event.data?.error ?? "未知错误")}`;
  if (event.type === "contract.validation.completed") return `暂存文件校验：${event.data?.valid === true ? "通过" : "失败"}`;
  if (event.type === "artifact.validation.failed") return `产物校验失败：${String(event.data?.artifactId ?? "未知产物")}`;
  if (event.type === "artifact.repair.started") return `正在修复：${String(event.data?.artifactId ?? "未知产物")}`;
  if (event.type === "artifact.validation.passed") return `产物校验通过：${String(event.data?.artifactId ?? "未知产物")}`;
  if (event.type === "artifact.repair.exhausted") return `产物修复耗尽：${String(event.data?.artifactId ?? "未知产物")}`;
  if (event.type === "smoke_test.completed") return "试运行完成";
  if (event.type === "operation.started") return "步骤开始";
  if (event.type === "operation.activity") return String(event.data?.message ?? "步骤活动");
  if (event.type === "operation.completed") return "步骤完成";
  return event.type.replaceAll(".", " ");
}

function interactionRequester(interaction: Record<string, unknown>): string {
  const requestedBy = interaction.requestedBy as Record<string, unknown> | undefined;
  return requestedBy?.type === "agent"
    ? String(requestedBy.label ?? "Agent")
    : "Runtime";
}

function managerOperationLabel(value: unknown, fallback: string): string {
  const label = String(value ?? "");
  if (label === "init:plan") return "生成初始化建议";
  if (label === "init:plan:repair") return "修复初始化建议";
  if (label === "init:confirm-proposal") return "讨论初始化方案";
  if (label === "init:confirm-smoke") return "讨论试运行报告";
  if (label === "init:manager") return "处理 Init 干预";
  if (label === "run:manager") return "处理 Run 干预";
  if (fallback === "initialization proposal") return "生成初始化建议";
  if (fallback === "initialization manager") return "初始化沟通";
  if (fallback === "run manager") return "运行沟通";
  return fallback;
}

/** Replay persisted Session/domain events into UI-only nodes without owning control flow. */
export class ExecutionTreeProjection {
  readonly rootId = "project";
  private readonly nodes = new Map<string, ExecutionNode>();
  private readonly expanded = new Set<string>();
  private readonly agentRenderers = new Map<string, AgentActivityRenderer>();
  private readonly activeAgents = new Map<string, string>();
  private readonly sessionAgents = new Map<string, string>();
  private readonly jobNodes = new Map<string, string>();
  private readonly managerJobs = new Set<string>();
  private readonly operationRuns = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  private readonly activeTurns = new Map<string, string>();
  private readonly seenSessionEvents = new Set<string>();
  private readonly seenDomainEvents = new Set<string>();
  private selectedNavigationId?: string;
  private selectedJobId?: string;
  private activeSelector: ExecutionSelector = "navigation";
  private followActive = true;

  constructor(projectLabel = "Flywheel project") {
    this.ensure(this.rootId, undefined, "project", projectLabel, "idle");
    this.expanded.add(this.rootId);
  }

  private ensure(id: string, parentId: string | undefined, kind: ExecutionNodeKind, label: string, status: ExecutionNodeStatus): ExecutionNode {
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node: ExecutionNode = { id, parentId, kind, label, status, children: [], lines: [], metadata: {} };
    this.nodes.set(id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent && !parent.children.includes(id)) parent.children.push(id);
      this.expanded.add(parentId);
    }
    return node;
  }

  private capability(capabilityId: string, timestamp?: string): ExecutionNode {
    const node = this.ensure(`capability:${capabilityId}`, this.rootId, "capability", `${capabilityId} capability`, "idle");
    node.startedAt ??= timestamp;
    this.selectedNavigationId ??= node.id;
    return node;
  }

  private operation(capabilityId: string, event: InitEvent | RunEvent, operationId = event.operation): ExecutionNode {
    const capability = this.capability(capabilityId, event.timestamp);
    let parent = capability;
    if ("version" in event) {
      parent = this.ensure(`${capability.id}/iteration:${event.version}`, capability.id, "iteration", `Iteration ${event.version}`, normalizeStatus(event.status));
    }
    return this.ensure(`${parent.id}/operation:${operationId}`, parent.id, "operation", String(operationId), normalizeStatus("status" in event ? event.status : "idle"));
  }

  private manager(capabilityId: string, timestamp?: string): ExecutionNode {
    const capability = this.capability(capabilityId, timestamp);
    const node = this.ensure(`${capability.id}/manager`, capability.id, "manager", "管理 Agent", "idle");
    node.startedAt ??= timestamp;
    return node;
  }

  private managerJobKey(capabilityId: string, job: string): string {
    return `${capabilityId}\u0000${job}`;
  }

  private isManagerJob(capabilityId: string, event: InitEvent | RunEvent, job: string): boolean {
    const key = this.managerJobKey(capabilityId, job);
    if (event.data?.sessionKey === "manager"
      || job === "initialization manager" || job === "run manager") {
      this.managerJobs.add(key);
    }
    return this.managerJobs.has(key);
  }

  private jobOwner(capabilityId: string, event: InitEvent | RunEvent, job: string): ExecutionNode {
    const parentJobId = typeof event.data?.parentJobId === "string" ? event.data.parentJobId : undefined;
    const parentNodeId = parentJobId ? this.jobNodes.get(parentJobId) : undefined;
    const parentNode = parentNodeId ? this.nodes.get(parentNodeId) : undefined;
    if (parentNode?.kind === "agent") return parentNode;
    return this.isManagerJob(capabilityId, event, job)
      ? this.manager(capabilityId, event.timestamp)
      : this.operation(capabilityId, event);
  }

  private agentKey(ownerId: string, event: InitEvent | RunEvent, job: string): string {
    const jobId = typeof event.data?.jobId === "string" ? event.data.jobId : undefined;
    return `${ownerId}\u0000${jobId ?? job}`;
  }

  private navigationOwner(node: ExecutionNode): ExecutionNode {
    let current = node;
    while ((current.kind === "agent" || current.kind === "manager") && current.parentId) {
      current = this.nodes.get(current.parentId) ?? current;
    }
    return current;
  }

  private eventSessionId(event: InitEvent | RunEvent): string | undefined {
    const value = event.data?.sessionId ?? event.data?.thread_id ?? event.data?.resumeSessionId;
    return typeof value === "string" && value ? value : undefined;
  }

  private sessionAgentKey(operationId: string, sessionId: string): string {
    return `${operationId}\u0000${sessionId}`;
  }

  private startAgent(capabilityId: string, event: InitEvent | RunEvent, job: string): ExecutionNode {
    const owner = this.jobOwner(capabilityId, event, job);
    const key = this.agentKey(owner.id, event, job);
    const sessionId = this.eventSessionId(event);
    const jobId = typeof event.data?.jobId === "string" ? event.data.jobId : undefined;
    const durableId = jobId ? this.jobNodes.get(jobId) : undefined;
    const existingId = owner.kind !== "manager" && sessionId
      ? this.sessionAgents.get(this.sessionAgentKey(owner.id, sessionId)) : durableId;
    if (existingId) {
      const existing = this.nodes.get(existingId)!;
      // A late/replayed start must not resurrect a terminal attempt. A newer
      // start still represents a legitimate resumed Job.
      if (existing.completedAt && event.timestamp <= existing.completedAt) return existing;
      existing.status = "running";
      existing.completedAt = undefined;
      existing.startedAt ??= event.timestamp;
      existing.metadata = { ...existing.metadata, ...event.data, sessionId, status: "running" };
      this.activeAgents.set(key, existing.id);
      if (jobId) this.jobNodes.set(jobId, existing.id);
      if (this.followActive) {
        this.selectedNavigationId = this.navigationOwner(owner).id;
        this.selectedJobId = owner.kind === "manager" ? owner.id : existing.id;
        this.activeSelector = "jobs";
      }
      return existing;
    }
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);
    const id = jobId
      ? `${owner.id}/job:${encodeURIComponent(jobId)}`
      : `${owner.id}/agent:${encodeURIComponent(job)}:${attempt}`;
    const node = this.ensure(id, owner.id, "agent", job, "running");
    node.startedAt = event.timestamp;
    node.metadata = { ...event.data, attempt, ...(sessionId ? { sessionId } : {}) };
    this.activeAgents.set(key, id);
    if (jobId) this.jobNodes.set(jobId, id);
    if (sessionId && owner.kind !== "manager") this.sessionAgents.set(this.sessionAgentKey(owner.id, sessionId), id);
    if (owner.kind === "manager") {
      owner.status = "running";
      owner.metadata = { ...owner.metadata, ...(sessionId ? { sessionId } : {}) };
    }
    this.agentRenderers.set(id, new AgentActivityRenderer());
    if (this.followActive) {
      this.selectedNavigationId = this.navigationOwner(owner).id;
      this.selectedJobId = owner.kind === "manager" ? owner.id : id;
      this.activeSelector = "jobs";
    }
    return node;
  }

  private bindAgentSession(capabilityId: string, event: InitEvent | RunEvent, job: string, candidate: ExecutionNode): ExecutionNode {
    const sessionId = this.eventSessionId(event);
    if (!sessionId || !candidate.parentId) return candidate;
    const parent = this.nodes.get(candidate.parentId);
    if (parent?.kind === "manager") {
      candidate.metadata = { ...candidate.metadata, sessionId };
      parent.metadata = { ...parent.metadata, sessionId };
      return candidate;
    }
    const sessionKey = this.sessionAgentKey(candidate.parentId, sessionId);
    const existingId = this.sessionAgents.get(sessionKey);
    if (!existingId || existingId === candidate.id) {
      this.sessionAgents.set(sessionKey, candidate.id);
      candidate.metadata = { ...candidate.metadata, sessionId };
      return candidate;
    }
    const existing = this.nodes.get(existingId);
    if (!existing) {
      this.sessionAgents.set(sessionKey, candidate.id);
      return candidate;
    }
    existing.status = "running";
    existing.metadata = { ...existing.metadata, ...candidate.metadata, ...event.data, sessionId };
    existing.lines.push(...candidate.lines);
    for (const childId of candidate.children) {
      const child = this.nodes.get(childId);
      if (child) child.parentId = existing.id;
      if (!existing.children.includes(childId)) existing.children.push(childId);
    }
    if (parent) parent.children = parent.children.filter((id) => id !== candidate.id);
    const activeTurn = this.activeTurns.get(candidate.id);
    if (activeTurn) this.activeTurns.set(existing.id, activeTurn);
    this.activeTurns.delete(candidate.id);
    this.agentRenderers.delete(candidate.id);
    this.expanded.delete(candidate.id);
    this.nodes.delete(candidate.id);
    if (this.selectedJobId === candidate.id) this.selectedJobId = existing.id;
    this.activeAgents.set(this.agentKey(existing.parentId!, event, job), existing.id);
    return existing;
  }

  private currentAgent(capabilityId: string, event: InitEvent | RunEvent, job: string): ExecutionNode {
    const owner = this.jobOwner(capabilityId, event, job);
    const key = this.agentKey(owner.id, event, job);
    const id = this.activeAgents.get(key);
    return id ? this.nodes.get(id)! : this.startAgent(capabilityId, event, job);
  }

  ingestSession(event: SessionEvent): void {
    const eventKey = JSON.stringify(event);
    if (this.seenSessionEvents.has(eventKey)) return;
    this.seenSessionEvents.add(eventKey);
    if (event.type === "session.started" || event.type === "session.attached") {
      const root = this.nodes.get(this.rootId)!;
      root.status = "running";
      root.startedAt ??= event.timestamp;
      root.metadata = { ...root.metadata, ...event.data, sessionId: event.sessionId ?? root.metadata.sessionId };
      return;
    }
    if (event.type === "session.stopped") {
      const root = this.nodes.get(this.rootId)!;
      root.status = "stopped";
      root.completedAt = event.timestamp;
      return;
    }
    if (!event.capabilityId) return;
    const capability = this.capability(event.capabilityId, event.timestamp);
    if (event.type === "capability.started" || event.type === "capability.resumed"
      || event.type === "intervention.started") {
      capability.status = "running";
      capability.startedAt ??= event.timestamp;
      for (const childId of capability.children) {
        const child = this.nodes.get(childId);
        if (child?.kind === "interaction" && child.status === "waiting") {
          child.status = "completed";
          child.completedAt = event.timestamp;
        }
      }
    } else if (event.type === "capability.completed") {
      capability.status = "completed";
      capability.completedAt = event.timestamp;
    } else if (event.type === "capability.blocked") {
      capability.status = "blocked";
      capability.completedAt = event.timestamp;
      capability.metadata = { ...capability.metadata, ...event.data };
    } else if (event.type === "capability.idle") {
      capability.status = event.data?.reason === "aborted" ? "aborted" : "waiting";
    } else if (event.type === "interaction.requested") {
      capability.status = "waiting";
      capability.metadata = { ...capability.metadata, interaction: event.data?.interaction };
      const interaction = (event.data?.interaction ?? {}) as Record<string, unknown>;
      const id = String(interaction.id ?? event.timestamp);
      const label = `${interactionRequester(interaction)} · ${String(interaction.question ?? "等待用户确认")}`;
      const node = this.ensure(`${capability.id}/interaction:${encodeURIComponent(id)}`, capability.id, "interaction", label, "waiting");
      node.startedAt = event.timestamp;
      node.metadata = { ...interaction };
      const requestedBy = interaction.requestedBy as Record<string, unknown> | undefined;
      if (requestedBy?.sessionKey === "manager") {
        const manager = this.manager(event.capabilityId, event.timestamp);
        manager.status = "waiting";
        manager.metadata = { ...manager.metadata, interaction };
      }
    }
  }

  ingestDomain(capabilityId: string, event: InitEvent | RunEvent): void {
    const eventKey = `${capabilityId}:${JSON.stringify(event)}`;
    if (this.seenDomainEvents.has(eventKey)) return;
    this.seenDomainEvents.add(eventKey);
    const init = "scope" in event && event.scope === "init";
    const explicitOperationId = typeof event.data?.operationId === "string" ? event.data.operationId : undefined;
    const operationId = explicitOperationId ?? event.operation;
    const operationRunId = "operationRunId" in event && typeof event.operationRunId === "string"
      ? event.operationRunId : undefined;
    const trackedOperation = operationRunId ? this.nodes.get(this.operationRuns.get(`${capabilityId}:${operationRunId}`) ?? "") : undefined;
    const legacyOperation = event.type === "operation.completed" && explicitOperationId !== undefined
      && explicitOperationId !== event.operation && !trackedOperation
      ? Array.from(this.nodes.values()).findLast((node) => node.kind === "operation"
        && node.label === explicitOperationId && node.status === "running"
        && node.id.startsWith(`capability:${capabilityId}/`))
      : undefined;
    const operation = trackedOperation ?? legacyOperation ?? this.operation(capabilityId, event, operationId);
    if (event.type === "operation.started" && operationRunId) {
      this.operationRuns.set(`${capabilityId}:${operationRunId}`, operation.id);
    }
    operation.metadata = { ...operation.metadata, ...event.data };
    const progress = operation.progress ??= { starts: 0, artifactRepairs: 0, evaluatorReturns: 0 };
    if (event.type === "artifact.repair.started") progress.artifactRepairs += 1;
    if (event.type === "init.evaluator.repair.requested") progress.evaluatorReturns += 1;
    if (["artifact.validation.failed", "artifact.repair.exhausted", "init.evaluator.repair.requested", "runtime.blocked"].includes(event.type)) {
      const data = event.data ?? {};
      const issues = Array.isArray(data.issues) ? data.issues.map((issue) =>
        typeof issue === "object" && issue !== null && "message" in issue ? String(issue.message) : String(issue)).join("；") : "";
      const reason = typeof data.error === "string" ? data.error : typeof data.issue === "string" ? data.issue : issues
        || (data.source === "independent-review" ? `独立审查要求返修${typeof data.invalidChecks === "number" ? `（${data.invalidChecks} 项检查无效）` : ""}` : "请查看来源事件中的原始诊断");
      progress.lastIssue = { eventId: `domain:${capabilityId}:${event.id}`, text: reason.slice(0, 600), timestamp: event.timestamp };
    }
    if (!event.type.startsWith("job.")) {
      operation.lines.push(`${event.timestamp} · ${operationActivity(event)}`);
    }
    if (event.type === "manager.responded") {
      const manager = this.manager(capabilityId, event.timestamp);
      manager.status = "waiting";
      manager.metadata = { ...manager.metadata, ...event.data };
      manager.lines.push(`${event.timestamp} · ${String(event.data?.message ?? "已回复用户")}`);
      return;
    }
    if (event.type === "operation.started") {
      progress.starts += 1;
      operation.status = "running";
      operation.startedAt = event.timestamp;
      delete operation.completedAt;
      return;
    }
    if (event.type === "operation.completed") {
      // Lifecycle completion means an invocation returned, not necessarily success.
      operation.status = event.data?.status === undefined ? "completed" : normalizeStatus(event.data.status);
      operation.completedAt = event.timestamp;
      return;
    }
    if (event.type === "runtime.blocked") {
      operation.status = "blocked";
      operation.metadata = { ...operation.metadata, ...event.data };
      this.capability(capabilityId).status = "blocked";
      return;
    }
    if (event.type === "gate.opened" || event.type === "gate.resolved") {
      const gate = this.ensure(`${operation.id}/gate`, operation.id, "gate", String(event.data?.reason ?? "Human gate"), event.type === "gate.opened" ? "waiting" : "completed");
      gate.status = event.type === "gate.opened" ? "waiting" : "completed";
      gate.startedAt ??= event.timestamp;
      gate.metadata = { ...gate.metadata, ...event.data };
      if (event.type === "gate.resolved") gate.completedAt = event.timestamp;
      return;
    }
    if (init && (event.type === "interaction.requested" || event.type === "interaction.resolved")) {
      const interaction = (event.data?.interaction ?? event.data ?? {}) as Record<string, unknown>;
      const id = String(interaction.id ?? event.data?.interactionId ?? event.operation);
      const label = `${interactionRequester(interaction)} · ${String(interaction.question ?? event.data?.question ?? "用户确认")}`;
      const node = this.ensure(`${operation.id}/interaction:${encodeURIComponent(id)}`, operation.id, "interaction", label, event.type === "interaction.requested" ? "waiting" : "completed");
      node.status = event.type === "interaction.requested" ? "waiting" : "completed";
      node.startedAt ??= event.timestamp;
      node.metadata = { ...node.metadata, ...event.data };
      if (event.type === "interaction.resolved") node.completedAt = event.timestamp;
      const requestedBy = interaction.requestedBy as Record<string, unknown> | undefined;
      if (requestedBy?.sessionKey === "manager") {
        const manager = this.manager(capabilityId, event.timestamp);
        manager.status = event.type === "interaction.requested" ? "waiting" : "idle";
        manager.metadata = { ...manager.metadata, interaction };
      }
      return;
    }
    const started = event.type === "job.started";
    const activity = event.type === "job.event";
    const completed = event.type === "job.completed";
    if (!started && !activity && !completed) return;
    const job = String(event.data?.job ?? "Agent");
    let agent = started ? this.startAgent(capabilityId, event, job) : this.currentAgent(capabilityId, event, job);
    if (activity || completed) agent = this.bindAgentSession(capabilityId, event, job, agent);
    if (activity) {
      const previousLineCount = agent.lines.length;
      this.ingestAgentActivity(agent, event);
      const owner = agent.parentId ? this.nodes.get(agent.parentId) : undefined;
      if (owner?.kind === "manager") owner.lines.push(...agent.lines.slice(previousLineCount));
    }
    if (completed) {
      agent.status = event.data?.status === "aborted" ? "aborted" : event.data?.status === "completed" ? "completed" : "failed";
      agent.completedAt = event.timestamp;
      agent.metadata = { ...agent.metadata, ...event.data };
      const owner = agent.parentId ? this.nodes.get(agent.parentId) : undefined;
      if (owner?.kind === "manager") {
        owner.status = agent.status === "failed" ? "failed" : "idle";
        owner.metadata = { ...owner.metadata, ...event.data };
      }
    }
  }

  private ingestAgentActivity(agent: ExecutionNode, event: InitEvent | RunEvent): void {
    const renderer = this.agentRenderers.get(agent.id) ?? new AgentActivityRenderer();
    this.agentRenderers.set(agent.id, renderer);
    agent.lines.push(...capture(renderer, event));
    const sdkEvent = String(event.data?.sdkEvent ?? "");
    if (sdkEvent === "job.started" && agent.parentId && this.nodes.get(agent.parentId)?.kind === "manager") {
      agent.label = managerOperationLabel(event.data?.label, agent.label);
    }
    if (sdkEvent === "turn.started") {
      const count = agent.children.filter((id) => this.nodes.get(id)?.kind === "turn").length + 1;
      const turn = this.ensure(`${agent.id}/turn:${count}`, agent.id, "turn", `Turn ${count}`, "running");
      turn.startedAt = event.timestamp;
      this.activeTurns.set(agent.id, turn.id);
      return;
    }
    if (sdkEvent === "turn.completed" || sdkEvent === "turn.failed") {
      const turnId = this.activeTurns.get(agent.id);
      if (turnId) {
        const turn = this.nodes.get(turnId)!;
        turn.status = sdkEvent === "turn.completed" ? "completed" : "failed";
        turn.completedAt = event.timestamp;
        turn.metadata = { ...event.data };
      }
      return;
    }
    if (!sdkEvent.startsWith("item.")) return;
    const item = (event.data?.item ?? {}) as Record<string, unknown>;
    const kind = itemKind(item);
    if (!kind) return;
    const parentId = this.activeTurns.get(agent.id) ?? agent.id;
    const itemId = String(item.id ?? `${kind}:${this.nodes.get(parentId)?.children.length ?? 0}`);
    const node = this.ensure(`${parentId}/${kind}:${encodeURIComponent(itemId)}`, parentId, kind, itemLabel(item), "running");
    const lifecycle = sdkEvent.slice("item.".length);
    node.startedAt ??= event.timestamp;
    node.lines = capture(new AgentActivityRenderer(), event);
    node.metadata = { ...item };
    if (lifecycle === "completed") {
      const failed = item.status === "failed" || (kind === "command" && item.exit_code !== undefined && item.exit_code !== 0);
      node.status = failed ? "failed" : "completed";
      node.completedAt = event.timestamp;
    }
  }

  get(id: string): ExecutionNode | undefined { return this.nodes.get(id); }
  /** Read-only serialization surface shared by terminal and browser projections. */
  nodesSnapshot(): ExecutionNode[] {
    return [...this.nodes.values()].map((node) => ({
      ...node,
      children: [...node.children],
      lines: [...node.lines],
      metadata: { ...node.metadata },
    }));
  }
  selectedNavigation(): ExecutionNode {
    const fallback = this.navigation()[0]?.node ?? this.nodes.get(this.rootId)!;
    return (this.selectedNavigationId ? this.nodes.get(this.selectedNavigationId) : undefined) ?? fallback;
  }
  selectedJob(): ExecutionNode | undefined {
    return this.selectedJobId ? this.nodes.get(this.selectedJobId) : undefined;
  }
  selected(): ExecutionNode { return this.selectedJob() ?? this.selectedNavigation(); }
  selector(): ExecutionSelector { return this.activeSelector; }
  hasKind(kind: ExecutionNodeKind): boolean { return [...this.nodes.values()].some((node) => node.kind === kind); }

  navigation(): VisibleExecutionNode[] {
    const result: VisibleExecutionNode[] = [];
    for (const capabilityId of this.nodes.get(this.rootId)?.children ?? []) {
      const capability = this.nodes.get(capabilityId);
      if (!capability || capability.kind !== "capability") continue;
      result.push({ node: capability, depth: 0, expanded: true });
      const visit = (id: string) => {
        const node = this.nodes.get(id);
        if (!node) return;
        if (node.kind === "operation") result.push({ node, depth: 1, expanded: true });
        for (const child of node.children) visit(child);
      };
      for (const child of capability.children) visit(child);
    }
    if (!this.selectedNavigationId && result[0]) this.selectedNavigationId = result[0].node.id;
    return result;
  }

  jobs(): ExecutionNode[] {
    const selected = this.selectedNavigation();
    let capability = selected;
    while (capability.kind !== "capability" && capability.parentId) {
      capability = this.nodes.get(capability.parentId) ?? capability;
    }
    if (capability.kind !== "capability") return [];
    const capabilityId = capability.id.slice("capability:".length);
    const manager = this.manager(capabilityId, capability.startedAt);
    const result: ExecutionNode[] = [manager];
    if (selected.kind !== "operation") return result;
    const visit = (id: string) => {
      const node = this.nodes.get(id);
      if (!node) return;
      if (node.kind === "agent") result.push(node);
      for (const child of node.children) if (this.nodes.get(child)?.kind === "agent") visit(child);
    };
    for (const id of selected.children) visit(id);
    return result;
  }

  visible(): VisibleExecutionNode[] {
    const result: VisibleExecutionNode[] = [];
    const visit = (id: string, depth: number) => {
      const node = this.nodes.get(id);
      if (!node) return;
      result.push({ node, depth, expanded: this.expanded.has(id) });
      if (this.expanded.has(id)) for (const child of node.children) visit(child, depth + 1);
    };
    visit(this.rootId, 0);
    return result;
  }

  selectNavigation(delta: number): void {
    const nodes = this.navigation();
    const current = Math.max(0, nodes.findIndex(({ node }) => node.id === this.selectedNavigationId));
    const next = Math.max(0, Math.min(nodes.length - 1, current + delta));
    this.selectedNavigationId = nodes[next]?.node.id;
    this.selectedJobId = undefined;
    this.followActive = false;
  }
  selectJob(delta: number): void {
    const jobs = this.jobs();
    if (!jobs.length) return;
    const current = Math.max(-1, jobs.findIndex((node) => node.id === this.selectedJobId));
    const next = Math.max(0, Math.min(jobs.length - 1, current + delta));
    this.selectedJobId = jobs[next]?.id;
    this.followActive = false;
  }
  focusNavigation(): void { this.activeSelector = "navigation"; this.selectedJobId = undefined; this.followActive = false; }
  focusJobs(): void {
    if (!this.jobs().length) return;
    this.activeSelector = "jobs";
    this.selectedJobId ??= this.jobs()[0]?.id;
    this.followActive = false;
  }
  focusDetails(): void { this.activeSelector = "details"; this.followActive = false; }
}
