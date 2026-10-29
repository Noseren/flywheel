/* GUI projection only. Session remains the sole execution and command owner. */
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token") || "";
const ui = { state: null, nodes: new Map(), entries: new Map(), streamKeys: new Map(), stale: new Set(),
  selected: null, treeOpen: false, expanded: new Map(), detailCache: new Map(), detailsInFlight: new Set(),
  connected: false, denied: false, submitting: false, stream: null, retry: null, attempts: 0, frame: null,
  historyBefore: null, nodeBefore: null, fresh: new Set(), freshTimer: null, reading: new Map(),
  treeSignature: "", projectSignature: "", projectSwitchTarget: null, projectSidebarOpen: true, switchingProject: false,
  limit: 250, audit: false, bound: false, historyBusy: false, optimistic: new Map(), actionRequests: new Map() };
const statusNames = { running: "运行中", completed: "完成", failed: "失败", blocked: "阻塞", waiting: "待确认", idle: "未运行", aborted: "已中断", stopped: "已结束", paused: "已暂停", waiting_for_user: "待确认" };
const operationNames = { inspect: "检查项目", explore: "探索需求", proposal: "确认目标与评价方式", contract: "生成评价合同", smoke: "最小检查",
  prepare_compact: "准备并验证基线", bootstrap: "载入项目", verify: "验证当前基线", optimize: "改进候选", verify_candidate: "验证候选", retain: "保留或拒绝候选",
  tasking: "执行任务", evaluate: "评价版本", assess_target: "判定目标", propose: "提出改进", refine: "优化候选", select: "选择候选", complete: "完成" };
function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function button(text, action, cls = "") { const n = el("button", cls, text); n.type = "button"; n.onclick = action; return n; }
function url(route, params = {}) { const q = new URLSearchParams({ ...params, token }); return route + "?" + q; }
async function api(route, params = {}, body) {
  const r = await fetch(url(route, params), body === undefined ? { signal: AbortSignal.timeout(15000) } :
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const data = await r.json();
  if (!r.ok) { const error = new Error(data.error || "请求失败"); error.status = r.status; error.state = data.state; error.node = data.node; throw error; }
  return data;
}
function save(key, value) { try { localStorage.setItem(key, value); } catch {} }
function saved(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
function time(value) { if (!value || !Number.isFinite(Date.parse(value))) return ""; return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function duration(ms) { if (!Number.isFinite(ms)) return "—"; const seconds = Math.round(ms / 1000); return seconds < 60 ? seconds + "秒" : Math.floor(seconds / 60) + "分" + seconds % 60 + "秒"; }
function tokenCount(value) { return value == null ? "未知" : Number(value).toLocaleString(); }
function renderUsage() {
  const ledger = ui.state?.usage, toggle = $("usage-toggle"); if (!toggle || !ledger) return;
  const t = ledger.totals;
  toggle.textContent = "模型活跃 " + duration(t.wallElapsedMs) + " · " + tokenCount(t.totalTokens) + " tokens";
  if ($("usage-panel").hidden) return;
  const contents = [el("p", "", "模型活跃时间 " + duration(t.wallElapsedMs) + " · 调用累计 " + duration(t.invocationDurationMs)),
    el("p", "", "输入 " + tokenCount(t.inputTokens) + " · 输出 " + tokenCount(t.outputTokens) + " · 合计 " + tokenCount(t.totalTokens)),
    el("p", "muted small", "缓存命中 " + tokenCount(t.cachedInputTokens) + " · 缓存写入 " + tokenCount(t.cacheWriteInputTokens) + " · 推理输出 " + tokenCount(t.reasoningOutputTokens) + "（细分不重复相加）"),
    el("p", "muted small", t.invocationCount + " 次调用 · " + t.runningInvocationCount + " 次进行中" + (t.unknownInvocationCount ? " · " + t.unknownInvocationCount + " 次用量未完整上报，合计仅含已上报值" : "") + (ledger.unknowns.legacyPrecision ? " · 含历史 Job 级估算" : ""))];
  for (const [phase, totals] of Object.entries(ledger.groups.phase)) contents.push(el("p", "", ({ init: "准备", preparation: "准备", run: "优化", optimization: "优化" })[phase] || phase), el("p", "muted small", duration(totals.wallElapsedMs) + " · " + tokenCount(totals.totalTokens) + " tokens"));
  const details = el("details", "usage-detail"), summary = el("summary", "", "按步骤、Job 与模型查看");
  details.append(summary);
  for (const key of ["operation", "job", "model"]) for (const [name, totals] of Object.entries(ledger.groups[key])) details.append(el("p", "small", name + " · " + duration(totals.wallElapsedMs) + " · " + tokenCount(totals.totalTokens) + " tokens"));
  contents.push(details);
  const download = el("a", "", "导出账本 JSON"); download.href = url("/api/usage"); download.download = "flywheel-usage.json"; contents.push(download);
  $("usage-content").replaceChildren(...contents);
}
function rawType(entry) { return entry.raw?.type || ""; }
function isDispatch(entry) {
  return (rawType(entry) === "job.event" && (entry.sdkEvent || entry.raw?.data?.sdkEvent) === "job.started") ||
    (rawType(entry) === "job.started" && typeof entry.raw?.data?.prompt === "string");
}
function taskText(entry) { return entry.raw?.data?.prompt ?? "该次派发记录未保存原文。"; }
function awaitingReply(entry) {
  const id = entry.interactionId || entry.raw?.data?.interaction?.id;
  return Boolean(id && id === ui.state?.snapshot?.pendingInteraction?.id
    && (entry.interactionRevision === undefined || entry.interactionRevision === ui.state?.interactionRevision)
    && !ui.state?.pendingInteractionAnswered && ui.state?.snapshot?.status !== "stopped");
}
function isUserConversation(e) { return e.kind === "message" && ["User message", "Interaction response", "Manager reply", "Conversation stream", "需要用户输入"].includes(e.title); }
function presentation(e) {
  if (e.title === "User message" || e.title === "Interaction response") return "user";
  if (e.interactionId || e.title === "需要用户输入") return "question";
  if (e.kind === "message") return "message";
  if (isDispatch(e)) return "task";
  if (rawType(e) === "job.started") return "milestone";
  if (e.category === "error" || e.tone === "danger") return "error";
  if (e.officialTitle) return "result";
  if (rawType(e) === "job.completed" || rawType(e).startsWith("operation.") || rawType(e).startsWith("capability.") || rawType(e).startsWith("runtime.")) return "milestone";
  return "activity";
}
function effectiveStatus(node) {
  if (ui.stale.has(node.id)) return "待刷新";
  if (node.status === "running" && ui.state?.snapshot?.status === "stopped") return "已结束";
  if (node.status === "running" && !ui.connected) return "未确认运行";
  if (node.status === "running" && ui.state?.snapshot?.status !== "running") return "已暂停";
  return statusNames[node.status] || node.status || "未知";
}
function mergeEntries(entries) {
  for (const e of entries || []) {
    if (e.raw?.data?.clientRequestId) ui.optimistic.delete(e.raw.data.clientRequestId);
    // A streamed tool command updates its existing card, rather than appending snapshots.
    const existingId = e.streamKey && ui.streamKeys.get(e.streamKey);
    const old = existingId && ui.entries.get(existingId);
    if (old && (old.ordinal ?? -1) > (e.ordinal ?? -1)) continue;
    if (existingId && existingId !== e.id) ui.entries.delete(existingId);
    if (e.streamKey) ui.streamKeys.set(e.streamKey, e.id);
    const current = ui.entries.get(e.id);
    if (!current || !e.detailId || current.detailId) ui.entries.set(e.id, e);
  }
}
function ingest(state, refresh = false) {
  if (!state) return;
  if (ui.state && state.snapshot?.sessionId === ui.state.snapshot?.sessionId && state.revision < ui.state.revision) return;
  const previousSession = ui.state?.snapshot?.sessionId, nextSession = state.snapshot?.sessionId;
  if (previousSession && nextSession && previousSession !== nextSession) {
    ui.nodes.clear(); ui.entries.clear(); ui.streamKeys.clear(); ui.detailCache.clear(); ui.selected = null; ui.historyBefore = null; ui.nodeBefore = null;
  }
  if (refresh) for (const id of ui.nodes.keys()) ui.stale.add(id);
  for (const node of state.nodes || []) { ui.nodes.set(node.id, node); ui.stale.delete(node.id); }
  mergeEntries(state.timeline);
  if (ui.historyBefore === null || refresh) ui.historyBefore = state.history?.before ?? 0;
  if (ui.nodeBefore === null || refresh) ui.nodeBefore = state.nodeHistory?.before ?? 0;
  // HTTP command responses may arrive behind a newer stream revision.
  if (!ui.state || state.revision >= ui.state.revision) ui.state = state;
  for (const receipt of state.commands || []) {
    const pending = ui.optimistic.get(receipt.clientRequestId);
    if (pending) { pending.delivery = receipt.status; pending.error = receipt.error; }
    if (["completed", "failed", "interrupted"].includes(receipt.status)) for (const [key, envelope] of ui.actionRequests) {
      if (envelope.clientRequestId === receipt.clientRequestId) ui.actionRequests.delete(key);
    }
  }
  if (ui.state.snapshot?.status === "stopped") offline();
  if (!refresh && ui.connected) {
    for (const e of state.timeline || []) if (e.jobId) {
      for (const node of ui.nodes.values()) if (node.metadata?.jobId === e.jobId) ui.fresh.add(node.id);
    }
    clearTimeout(ui.freshTimer);
    ui.freshTimer = setTimeout(() => { ui.fresh.clear(); renderTree(); }, 1300);
  }
  scheduleRender();
}
function scheduleRender() { if (!ui.frame) ui.frame = requestAnimationFrame(() => { ui.frame = null; render(); }); }
function orderedEntries() { return [...ui.entries.values()].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)); }
function mainEntries() {
  const all = orderedEntries();
  const lastReply = new Map();
  for (const e of all) if (e.title === "Manager reply") lastReply.set(e.capabilityId, e.ordinal);
  const entries = all.filter(e => (isUserConversation(e)
    && (e.title !== "Conversation stream" || (e.ordinal ?? 0) > (lastReply.get(e.capabilityId) ?? -1)))
    || /^assistance\.(admitted|denied|settled)$/.test(e.sdkEvent || e.raw?.data?.sdkEvent || "")
    || (rawType(e) === "operation.activity" && e.raw?.data?.needsInput === true)
    || (!e.jobId && (["error", "result"].includes(presentation(e)) || rawType(e) === "runtime.budget.exhausted")));
  const pending = ui.state?.pendingInteractionAnswered ? undefined : ui.state?.snapshot?.pendingInteraction;
  if (pending && !ui.state.pendingInteractionAnswered && ui.state.snapshot.status !== "stopped" &&
      !entries.some(e => (e.interactionId || e.raw?.data?.interaction?.id) === pending.id)) {
    entries.push({ id: "pending:" + pending.id, title: "需要用户输入", interactionId: pending.id, actor: pending.requestedBy?.label || "Runtime", requester: pending.requestedBy, capabilityId: pending.capabilityId,
      kind: "message", body: [pending.question, pending.description].filter(Boolean).join("\n\n") });
  }
  entries.push(...ui.optimistic.values());
  return entries;
}

function actorNode(entry) {
  const requester = entry.requester || entry.raw?.data?.interaction?.requestedBy;
  const candidates = [...ui.nodes.values()].filter(n => ["agent", "manager"].includes(n.kind));
  if (entry.jobId) {
    const node = candidates.find(n => n.metadata?.jobId === entry.jobId);
    if (node) return node;
  }
  if (!requester?.sessionKey || !entry.capabilityId) return null;
  const matches = candidates.filter(n => {
    if (n.metadata?.sessionKey !== requester.sessionKey) return false;
    let parent = n; const seen = new Set();
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      if (parent.kind === "capability") return parent.id === entry.capabilityId || parent.id === "capability:" + entry.capabilityId || parent.id.endsWith("/capability:" + entry.capabilityId);
      parent = ui.nodes.get(parent.parentId);
    }
    return false;
  });
  return matches.length === 1 ? matches[0] : null;
}
function nodePhase(node) {
  if (ui.stale.has(node.id)) return "unknown";
  if (node.status === "running" && ui.state?.snapshot?.status === "stopped") return "stopped";
  if (node.status === "running") return !ui.connected ? "unknown" : ui.state?.snapshot?.status === "running" ? "running" : "paused";
  if (["failed", "blocked"].includes(node.status)) return "failed";
  if (["aborted", "stopped"].includes(node.status)) return "stopped";
  if (node.status === "completed") return "completed";
  return node.status === "waiting" ? "waiting" : "idle";
}
function visibleTreeNodes() {
  const all = [...ui.nodes.values()].filter(n => !["turn", "tool", "command", "interaction", "gate"].includes(n.kind));
  const ids = new Set(all.filter(n => ["agent", "manager"].includes(n.kind) || n.startedAt || n.status !== "idle").map(n => n.id));
  for (const id of [...ids]) { let node = ui.nodes.get(id); const seen = new Set(); while (node?.parentId && !seen.has(node.id)) { seen.add(node.id); ids.add(node.parentId); node = ui.nodes.get(node.parentId); } }
  return all.filter(n => ids.has(n.id) && n.kind !== "capability").map(n => {
    let parent = ui.nodes.get(n.parentId);
    while (parent?.kind === "capability") parent = ui.nodes.get(parent.parentId);
    return { ...n, parentId: parent?.id };
  });
}
function hasExecuted(node) {
  return Boolean(node.startedAt || node.completedAt || node.status !== "idle" || (["agent", "manager"].includes(node.kind) && (node.metadata?.jobId || node.metadata?.sessionId)));
}
function executionPathSets(nodes) {
  const travelled = new Set(), flowing = new Set();
  for (const endpoint of nodes.filter(hasExecuted)) {
    let node = endpoint, previous; const seen = new Set();
    while (node && !seen.has(node.id)) {
      seen.add(node.id); travelled.add(node.id);
      if (previous) flowing.add(node.id);
      previous = node; node = ui.nodes.get(node.parentId);
    }
  }
  return { travelled, flowing };
}
function ownershipPath(node) {
  const labels = []; let current = node; const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (!["project", "session", "capability", "iteration"].includes(current.kind)) labels.unshift(operationNames[current.label] || current.label);
    current = ui.nodes.get(current.parentId);
  }
  return labels;
}
function renderTreeFlow(nodes, travelled, animate) {
  const content = $("tree-content"), previous = content.querySelector(".tree-flow-layer"); previous?.remove();
  const bounds = content.getBoundingClientRect(), shells = new Map([...content.querySelectorAll(".tree-shell")].map(shell => [shell.dataset.nodeId, shell]));
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("tree-flow-layer"); svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", String(Math.max(1, content.scrollWidth))); svg.setAttribute("height", String(Math.max(1, content.scrollHeight)));
  svg.setAttribute("viewBox", `0 0 ${Math.max(1, content.scrollWidth)} ${Math.max(1, content.scrollHeight)}`);
  const point = shell => {
    if (!shell || shell.closest(".branch-content:not(.expanded)")) return null;
    const marker = shell.querySelector(":scope > .node-row .node-marker, :scope > .node-row .worker-marker");
    const row = shell.querySelector(":scope > .node-row"); if (!marker || !row) return null;
    const m = marker.getBoundingClientRect(), r = row.getBoundingClientRect();
    return { x: m.left - bounds.left + m.width / 2, y: r.top - bounds.top + r.height / 2, radius: m.width / 2 };
  };
  const depthOf = node => { let depth = 0, current = node; const seen = new Set(); while (current?.parentId && !seen.has(current.id)) { seen.add(current.id); depth += 1; current = ui.nodes.get(current.parentId); } return depth; };
  for (const node of nodes) {
    if (!node.parentId || !travelled.has(node.id) || !travelled.has(node.parentId)) continue;
    const parent = point(shells.get(node.parentId)), child = point(shells.get(node.id)); if (!parent || !child) continue;
    const d = `M ${parent.x} ${parent.y + parent.radius} V ${child.y} H ${child.x - child.radius}`;
    for (const cls of ["tree-flow-track", ...(animate ? ["tree-flow-pulse"] : [])]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add(cls); path.setAttribute("d", d); path.setAttribute("pathLength", "100");
      path.style.setProperty("--flow-depth", String(Math.max(0, depthOf(node) - 1))); svg.append(path);
    }
  }
  content.prepend(svg);
}

function scopeEntries(node) {
  if (!node) return [];
  const full = ui.detailCache.get(node.id)?.node;
  const metadata = full?.metadata || node.metadata || {};
  const all = orderedEntries();
  const jobs = new Set([metadata.jobId]);
  for (const e of all) if (metadata.sessionId && e.raw?.data?.sessionId === metadata.sessionId && e.jobId) jobs.add(e.jobId);
  return all.filter(e => {
    if (e.jobId && jobs.has(e.jobId)) return true;
    const d = e.raw?.data;
    return Boolean(metadata.sessionId && d?.sessionId === metadata.sessionId && e.capabilityId === (metadata.capabilityId || e.capabilityId));
  });
}
async function fullEntry(e) {
  if (!e.detailId) return e;
  const complete = await api("/api/entry", { id: e.id }); ui.entries.set(e.id, complete); return complete;
}
async function copy(text, trigger) {
  try { await navigator.clipboard.writeText(text); trigger.textContent = "已复制完整输出"; }
  catch {
    const area = el("textarea"); area.value = text; trigger.after(area); area.focus(); area.select();
    trigger.textContent = "请按 Ctrl+C 复制"; area.onblur = () => area.remove();
  }
  setTimeout(() => { if (trigger.isConnected) trigger.textContent = "复制输出"; }, 6000);
}
function activityText(e) {
  const item = e.raw?.data?.item;
  if (item?.type === "command_execution") return [item.command, item.aggregated_output, item.exit_code !== undefined ? "退出码: " + item.exit_code : ""].filter(v => v !== undefined && v !== "").join("\n\n");
  return JSON.stringify(e.raw ?? e, null, 2);
}
function expansionControl(label, action) {
  const control = button("", action, "more-message");
  control.setAttribute("aria-label", label); control.setAttribute("aria-expanded", "false");
  control.append(el("span", "expand-arrow"), el("span", "sr-only", label));
  return control;
}
function entryCard(entry, main = false) {
  const type = presentation(entry);
  if (["activity", "error", "milestone", "result"].includes(type)) {
    const d = el("details", "activity event-" + type + " event-" + (entry.raw?.data?.item?.type || entry.category) + (type === "error" ? " error" : ""));
    d.dataset.entryId = entry.streamKey || entry.id;
    const item = entry.raw?.data?.item;
    const names = { reasoning: "推理摘要", todo_list: "工作计划", file_change: "文件变化", command_execution: "执行命令", mcp_tool_call: "工具调用", web_search: "搜索" };
    const title = rawType(entry) === "job.started" ? (entry.actor || "Agent") + " · 已启动" : entry.officialTitle || (names[item?.type] ? names[item.type] + (item.tool ? " · " + item.tool : "") + (item.status ? " · " + (statusNames[item.status] || item.status) : "") : entry.title);
    const summary = el("summary", "");
    summary.append(el("span", "event-symbol", {command:"›_",tool:"◇",file:"±",error:"!"}[entry.category] || (type === "milestone" ? "·" : "≡")),
      el("span", "event-label", title), el("time", "", time(entry.timestamp)));
    d.append(summary);
    if (type === "error") d.append(el("p", "event-preview", entry.body || entry.title));
    if (item?.command) d.append(el("code", "event-preview", item.command));
    if (type === "result") d.append(button("查看正式证据", evidence, "agent-link"));
    d.addEventListener("toggle", async () => {
      if (!d.open || d.dataset.loaded) return;
      d.dataset.loaded = "1";
      const content = el("div", "activity-body", "正在读取…"); d.append(content);
      try {
        const e = await fullEntry(entry), output = activityText(e);
        content.replaceChildren();
        if (e.raw?.data?.item?.type === "file_change") for (const change of e.raw.data.item.changes || []) content.append(el("p", "file-row", (change.kind || "修改") + " · " + change.path));
        const c = button("复制输出", () => copy(output, c), "copy"); content.append(c, el("pre", "", output));
      } catch (error) { content.textContent = error.message; delete d.dataset.loaded; }
    });
    return d;
  }
  const n = el("article", "message " + (type === "question" ? "question" : type));
  n.dataset.entryId = entry.id;
  const head = el("div", "message-head");
  const identity = actorNode(entry);
  const name = type === "user" ? "你" : main ? "Flywheel" : entry.requester?.label || entry.raw?.data?.interaction?.requestedBy?.label || entry.actor || "Flywheel";
  head.append(el("span", "actor-avatar" + (identity?.kind === "agent" ? " robot" : ""), type === "user" ? "你" : identity?.kind === "manager" ? "M" : identity?.kind === "agent" ? "🤖" : type === "question" ? "?" : "A"),
    identity ? button(name, () => selectNode(identity.id), "agent-link") : el("strong", "actor-name", name));
  head.append(el("time", "", time(entry.timestamp)));
  if (entry.delivery) head.append(el("span", "delivery", ({ sending: "发送中…", accepted: "已发送", running: "正在回复…", completed: "已处理", failed: "处理失败", interrupted: "已中断", unknown: "送达未确认" })[entry.delivery] || entry.delivery));
  if (type === "question") {
    n.classList.toggle("historical", !awaitingReply(entry));
    n.append(el("div", "question-label", awaitingReply(entry) ? "需要你回复" : "历史提问"));
  }
  if (type === "task") n.append(el("div", "task-label", "派发任务"));
  n.append(head);
  const text = el("div", "message-body", type === "task" ? (entry.detailId ? "展开查看实际派发原文。" : taskText(entry)) : entry.body || "");
  n.append(text);
  if (entry.delivery === "unknown") n.append(button("核实并重试发送", () => sendEnvelope(entry.envelope).catch(showError), "agent-link"));
  if (entry.error) n.append(el("small", "error-text", entry.error));
  if (!entry.detailId && text.textContent.length > 700) {
    n.classList.add("message-expandable", "is-collapsed"); text.classList.add("message-collapsed");
    const control = expansionControl("查看完整消息", () => {
      const collapsed = text.classList.toggle("message-collapsed");
      n.classList.toggle("is-collapsed", collapsed); control.setAttribute("aria-expanded", String(!collapsed));
      control.setAttribute("aria-label", collapsed ? "查看完整消息" : "收起消息"); control.querySelector(".sr-only").textContent = collapsed ? "查看完整消息" : "收起消息";
    });
    n.append(control);
  }
  if (entry.detailId) {
    n.classList.add("message-expandable", "is-collapsed"); text.classList.add("message-collapsed"); let loaded = false;
    const control = expansionControl("查看完整消息", async () => {
      try {
        if (!loaded) { const e = await fullEntry(entry); text.textContent = type === "task" ? taskText(e) : e.body || activityText(e); loaded = true; }
        const collapsed = !text.classList.contains("message-collapsed"); text.classList.toggle("message-collapsed", collapsed);
        n.classList.toggle("is-collapsed", collapsed); control.setAttribute("aria-expanded", String(!collapsed));
        control.setAttribute("aria-label", collapsed ? "查看完整消息" : "收起消息"); control.querySelector(".sr-only").textContent = collapsed ? "查看完整消息" : "收起消息";
      } catch (error) { text.textContent = error.message; }
    });
    n.append(control);
  }
  return n;
}
function rememberFeed(id) {
  const feed = $(id); if (!feed) return null;
  const open = [...feed.querySelectorAll("details[open]")].map(n => n.dataset.entryId);
  const anchor = [...feed.children].find(n => n.getBoundingClientRect().bottom > feed.getBoundingClientRect().top);
  return { top: feed.scrollTop, bottom: feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60,
    anchor: anchor?.dataset.entryId, offset: anchor ? anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top : 0, open };
}
function paintFeed(id, entries, key, prefix = []) {
  const feed = $(id), previous = feed.dataset.scope === key ? rememberFeed(id) : ui.reading.get(key);
  if (feed.dataset.scope && feed.dataset.scope !== key) {
    ui.reading.set(feed.dataset.scope, rememberFeed(id));
    if (ui.reading.size > 50) ui.reading.delete(ui.reading.keys().next().value);
  }
  feed.dataset.scope = key;
  const older = button(ui.historyBusy ? "正在加载…" : "加载更早的记录", () => loadHistory(), "load-more");
  older.disabled = ui.historyBusy;
  const children = [...(ui.historyBefore > 0 ? [older] : []), ...prefix];
  const start = Math.max(0, entries.length - ui.limit);
  if (start) children.push(button("显示更多已加载记录", () => { ui.limit += 250; renderFeeds(); }, "load-more"));
  const existing = new Map([...feed.children].filter(n => n.dataset.entryId).map(n => [n.dataset.entryId, n]));
  children.push(...entries.slice(start).map(entry => {
    const key = entry.streamKey || entry.id, signature = JSON.stringify(entry) + (actorNode(entry)?.id || "") + awaitingReply(entry);
    const old = existing.get(key);
    if (old?._signature === signature) return old;
    const card = entryCard(entry, id === "main-feed"); card._signature = signature; return card;
  }));
  if (!children.length) {
    const empty = el("div", "empty"); empty.append(el("h2", "", "从对话开始"), el("p", "", "在下方发送消息，查看方案、追问进度或继续任务。")); children.push(empty);
  }
  // Keep unchanged cards mounted: copying, focus and expanded output must survive live patches.
  const keep = new Set(children);
  for (const child of [...feed.children]) if (!keep.has(child)) child.remove();
  children.forEach((child, index) => { if (feed.children[index] !== child) feed.insertBefore(child, feed.children[index] || null); });
  for (const d of feed.querySelectorAll("details")) if (previous?.open?.includes(d.dataset.entryId)) d.open = true;
  if (!previous || previous.bottom) feed.scrollTop = feed.scrollHeight;
  else {
    feed.scrollTop = previous.top;
    const anchor = [...feed.children].find(n => n.dataset.entryId === previous.anchor);
    if (anchor) feed.scrollTop += anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - previous.offset;
  }
  const latest = $(id === "main-feed" ? "main-latest" : "worker-latest");
  latest.hidden = !previous || previous.bottom;
}
function renderFeeds() {
  for (const id of ["main-history","worker-history"]) { $(id).hidden = !(ui.historyBefore > 0); $(id).disabled = ui.historyBusy; }
  paintFeed("main-feed", mainEntries(), "main");
  if (!ui.selected && !ui.audit) return;
  if (ui.audit) { $("worker-title").textContent = "全部事件"; $("worker-status").textContent = "只读审计记录"; paintFeed("worker-feed", orderedEntries(), "audit"); return; }
  const node = ui.nodes.get(ui.selected); if (!node) return;
  const full = ui.detailCache.get(node.id);
  $("worker-title").textContent = full?.node.label || node.label;
  const role = node.kind === "manager" ? "Manager" : node.kind === "agent" ? "Agent Worker" : "工作节点";
  $("worker-status").textContent = role + "　" + effectiveStatus(node) + "\n所属路径：" + ownershipPath(node).join(" > ");
  const prefix = [];
  const records = scopeEntries(node);
  if (full?.node.metadata?.prompt && !records.some(e => presentation(e) === "task")) prefix.push(entryCard({
    id: "prompt:" + node.id, actor: "派发任务", kind: "event", raw: { type: "job.started", data: { prompt: full.node.metadata.prompt } }
  }));
  const children = [...ui.nodes.values()].filter(n => n.parentId === node.id && n.kind === "agent");
  if (children.length) {
    const group = el("details", "activity"); group.append(el("summary", "", "子 Agent · " + children.length));
    for (const child of children) group.append(button(child.label + " · " + effectiveStatus(child), () => selectNode(child.id), "load-more"));
    prefix.push(group);
  }
  if (!full || full.key !== node.detailKey) prefix.push(el("p", "small muted", ui.stale.has(node.id) ? "节点待重新核实，请加载更早的工作节点。" : "正在更新 Agent 详情…"));
  if (full) {
    const details = el("details", "activity"); details.append(el("summary", "", "完整工作记录与元数据"));
    details.addEventListener("toggle", () => { if (details.open && details.childElementCount === 1) details.append(el("pre", "activity-body", JSON.stringify(full.node, null, 2))); });
    prefix.push(details);
  }
  paintFeed("worker-feed", records, node.id, prefix);
  if (!ui.stale.has(node.id) && (!full || full.key !== node.detailKey)) loadNode(node);
}
async function loadNode(node) {
  if (ui.detailsInFlight.has(node.id)) return;
  ui.detailsInFlight.add(node.id);
  try {
    const data = await api("/api/node", { id: node.id, key: node.detailKey });
    ui.detailCache.set(node.id, { node: data.node, key: data.detailKey });
  } catch (error) {
    if (error.status === 409) {
      // The next patch supplies a new detail key. Do not spin retrying a hot node.
      ui.detailCache.delete(node.id);
      if (error.node) { ui.nodes.set(node.id, error.node); scheduleRender(); }
    } else if (ui.selected === node.id) $("worker-status").textContent = "详情读取失败：" + error.message;
  } finally { ui.detailsInFlight.delete(node.id); }
  if (ui.detailCache.has(node.id) && ui.selected === node.id) renderFeeds();
}

function renderTree() {
  if (!ui.treeOpen) return;
  const nodes = visibleTreeNodes(), byParent = new Map();
  const signature = JSON.stringify(nodes.map(n => [n.id,n.parentId,n.label,n.status,nodePhase(n)])) + ui.selected;
  if (ui.treeSignature !== signature) {
    const scroll = $("work-tree").scrollTop;
    for (const n of nodes) { const p = n.parentId || ""; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(n); }
    const visited = new Set();
    function branch(node) {
      if (visited.has(node.id)) return el("span");
      visited.add(node.id);
      const kids = byParent.get(node.id) || [];
      if (["project", "session"].includes(node.kind)) { const wrap = el("div"); wrap.append(...kids.map(branch)); return wrap; }
      const shell = el("div", "tree-shell kind-" + node.kind); shell.dataset.nodeId = node.id;
      const row = el("div", "node-row"), isAgent = ["agent","manager"].includes(node.kind);
      const opened = ui.expanded.has(node.id) ? ui.expanded.get(node.id) : Boolean(kids.length);
      const nested = el("div", "branch-content"), inner = el("div", "tree-children");
      inner.append(...kids.map(branch)); nested.append(inner);
      nested.classList.toggle("expanded", opened); nested.inert = !opened;
      const toggle = button("›", () => {
        const open = !nested.classList.contains("expanded"); ui.expanded.set(node.id, open);
        nested.classList.toggle("expanded", open); nested.inert = !open; toggle.setAttribute("aria-expanded", String(open));
        requestAnimationFrame(renderTree); setTimeout(renderTree, 220);
      }, "disclosure");
      toggle.setAttribute("aria-expanded", String(opened)); toggle.setAttribute("aria-label", "展开或收起 " + node.label);
      toggle.hidden = !kids.length;
      const choose = button("", isAgent ? () => selectNode(node.id) : () => toggle.click(), "select-node");
      choose.setAttribute("aria-pressed", String(ui.selected === node.id)); choose.title = node.label;
      const marker = el("span", (isAgent ? "worker-marker " : "node-marker ") + nodePhase(node), isAgent ? (node.kind === "manager" ? "M" : "🤖") : undefined); marker.setAttribute("aria-hidden","true");
      choose.append(marker, el("span", "node-label", operationNames[node.label] || node.label));
      if (isAgent) choose.append(el("span", "node-role", node.kind === "manager" ? "Manager" : "Worker"));
      choose.append(el("span", "status " + nodePhase(node), effectiveStatus(node)));
      row.append(toggle, choose); shell.append(row); if (kids.length) shell.append(nested);
      return shell;
    }
    const ids = new Set(nodes.map(n=>n.id));
    $("tree-content").replaceChildren(...nodes.filter(n => !n.parentId || !ids.has(n.parentId)).map(branch));
    $("work-tree").scrollTop = scroll; ui.treeSignature = signature;
  }
  const { travelled, flowing } = executionPathSets(nodes);
  const animatePaths = ui.connected && ui.state?.snapshot?.status !== "stopped";
  for (const shell of $("tree-content").querySelectorAll(".tree-shell")) {
    shell.classList.toggle("path-executed", travelled.has(shell.dataset.nodeId));
    shell.classList.toggle("path-flowing", animatePaths && travelled.has(shell.dataset.nodeId));
    shell.classList.toggle("fresh", ui.fresh.has(shell.dataset.nodeId));
    shell.classList.toggle("flow-active", animatePaths && flowing.has(shell.dataset.nodeId));
  }
  renderTreeFlow(nodes, travelled, animatePaths);
  $("older-nodes").hidden = !(ui.nodeBefore > 0);
  $("tree-note").textContent = ui.connected ? "蓝色轨迹表示已执行路径，状态标记表示当前状态　" + nodes.filter(n => n.kind === "agent").length + " 个 Worker" : "连接中断，显示最后记录";
}
function animatePanel(panel, open) {
  panel._animation?.cancel(); panel._visible = open;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !panel.animate) { panel.hidden = !open; return; }
  panel.hidden = false;
  const frames = [{opacity:0, transform:"translateX(10px)"},{opacity:1,transform:"translateX(0)"}];
  const animation = panel.animate(open ? frames : frames.reverse(), {duration:180,easing:"ease-out"}); panel._animation = animation;
  animation.finished.then(() => { if (!panel._visible) panel.hidden = true; }).catch(() => {});
}
function setTree(open) { if(ui.treeOpen !== open) animatePanel($("work-tree"),open); ui.treeOpen = open; $("toggle-tree").setAttribute("aria-expanded", String(open)); if (!open) closeWorker(); renderTree(); }
function selectNode(id) {
  let parent = ui.nodes.get(id); const seen = new Set();
  while (parent && !seen.has(parent.id)) { seen.add(parent.id); ui.expanded.set(parent.id,true); parent = ui.nodes.get(parent.parentId); }
  ui.treeSignature = ""; ui.selected = id; ui.audit = false; setTree(true); $("worker-panel").hidden = false; $("workspace").classList.add("worker-open"); renderTree(); renderFeeds();
  const selected = [...$("tree-content").querySelectorAll(".tree-shell")].find(n=>n.dataset.nodeId===id); selected?.scrollIntoView({block:"nearest"});
}
function closeWorker() { ui.selected = null; ui.audit = false; $("worker-panel").hidden = true; $("workspace").classList.remove("worker-open"); renderTree(); }
function renderControls() {
  const state = ui.state, snapshot = state?.snapshot || {}, pending = snapshot.pendingInteraction;
  $("observer-note").hidden = !state?.readOnly;
  if (!$("write-surface")) return;
  $("write-surface").hidden = Boolean(state?.readOnly);
  const active = ui.connected && snapshot.status !== "stopped" && Boolean(state);
  $("send").disabled = !active || ui.submitting || !($("message").value || "").trim();
  $("abort").hidden = !active || snapshot.status !== "running";
  $("resume").hidden = !active || snapshot.status === "running" || Boolean(pending);
  $("resume").disabled = ui.submitting || state?.commandPending;
  $("stop").disabled = !active;
  $("input-note").textContent = snapshot.status === "stopped" ? "运行已结束" : !ui.connected ? "离线 · 未确认的提交请在恢复连接后核实。" : ui.submitting ? "正在发送…" : state?.commandPending ? "已收到，正在处理…" : "";
  const waiting = pending && !state.pendingInteractionAnswered && snapshot.status !== "stopped";
  $("pending-interaction").hidden = !waiting;
  $("pending-interaction").textContent = waiting ? "等待你的回复" : "";
  const options = [];
  if (waiting) {
    const choices = pending.kind === "confirm" ? [{ label: "确认", value: true }, { label: "不确认", value: false }] : pending.options || [];
    for (const c of choices) { const b = button(c.label, () => command("submit", c.value, pending.id).catch(showError)); b.disabled = !active || ui.submitting || state.commandPending || [...ui.optimistic.values()].some(e => e.envelope?.interactionId === pending.id && !["failed", "interrupted"].includes(e.delivery)); options.push(b); }
  }
  $("interaction-options").replaceChildren(...options);
}
function render() {
  if (!ui.state) return;
  const state = ui.state;
  $("project-path").textContent = state.projectRoot;
  $("project-name").textContent = state.projectRoot?.split(/[\\/]/).filter(Boolean).at(-1) || "Flywheel";
  $("run-status").textContent = statusNames[["running", "aborting", "stopped"].includes(state.snapshot.status) ? state.snapshot.status : state.snapshot.activeCapabilityStatus || state.snapshot.status] || "等待运行";
  renderProjects();
  const moving = state.snapshot.status === "running" ? "running" : state.snapshot.status === "stopped" ? "stopped" : "coasting";
  document.querySelectorAll(".flywheel-mark").forEach(mark => { mark.classList.remove("running", "coasting", "stopped"); mark.classList.add(moving); });
  if (state.commandError) showError(new Error(state.commandError));
  renderControls(); renderUsage(); renderTree(); renderFeeds();
}
function projectName(project) { return project?.split(/[\\/]/).filter(Boolean).at(-1) || "项目"; }
function setProjectSidebar(open) {
  ui.projectSidebarOpen = open;
  $("workspace").classList.toggle("projects-collapsed", !open);
  $("toggle-project-sidebar").setAttribute("aria-expanded", String(open));
  $("toggle-project-sidebar").setAttribute("aria-label", open ? "收起最近项目" : "展开最近项目");
  save("flywheel-project-sidebar", open ? "open" : "closed");
}
function renderProjects() {
  const navigation = ui.state?.projectNavigation;
  const sidebar = $("project-sidebar");
  sidebar.hidden = !navigation;
  if (!navigation) return;
  const projects = navigation.recentProjects || [];
  const signature = JSON.stringify([projects, ui.state.projectRoot]);
  if (signature === ui.projectSignature) return;
  ui.projectSignature = signature;
  const items = projects.map(project => {
    const current = project === ui.state.projectRoot;
    const item = button("", () => selectProject(project), "project-item" + (current ? " current" : ""));
    item.title = project;
    item.disabled = current;
    if (current) item.setAttribute("aria-current", "page");
    const copy = el("span", "project-copy");
    copy.append(el("strong", "", projectName(project)), el("small", "", current ? "当前项目" : project));
    item.append(copy);
    return item;
  });
  $("project-list").replaceChildren(...items);
}
function selectProject(project) {
  if (ui.switchingProject || project === ui.state?.projectRoot) return;
  ui.projectSwitchTarget = project;
  $("switch-project-name").textContent = projectName(project);
  $("project-switch-confirmation").hidden = false;
  $("project-switch-error").textContent = "";
  if (!ui.projectSidebarOpen) setProjectSidebar(true);
}
async function switchProject() {
  if (!ui.projectSwitchTarget || ui.switchingProject) return;
  ui.switchingProject = true;
  $("confirm-project-switch").disabled = true;
  $("project-switch-error").textContent = "";
  try {
    const result = await api("/api/switch-project", {}, { path: ui.projectSwitchTarget });
    location.replace(result.url);
  } catch (error) {
    $("project-switch-error").textContent = error.message;
    ui.switchingProject = false;
    $("confirm-project-switch").disabled = false;
  }
}
function showError(error) { if ($("command-error")) $("command-error").textContent = error.message; }
async function command(type, value, interactionId) {
  const actionKey = JSON.stringify([type, value, interactionId, ui.state?.interactionRevision]);
  if (type !== "message" && ui.actionRequests.has(actionKey)) return sendEnvelope(ui.actionRequests.get(actionKey));
  const envelope = { type, clientRequestId: crypto.randomUUID(), ...(value === undefined ? {} : { value }),
    ...(interactionId ? { interactionId, interactionRevision: ui.state?.interactionRevision } : {}) };
  if (type !== "message") ui.actionRequests.set(actionKey, envelope);
  if (type === "message" || type === "submit") {
    const displayValue = type === "submit" ? typeof value === "boolean" ? value ? "确认" : "暂不确认"
      : ui.state?.snapshot?.pendingInteraction?.options?.find(option => option.value === value)?.label || value : value;
    ui.optimistic.set(envelope.clientRequestId, { id: "local:" + envelope.clientRequestId, title: "User message", actor: "你", kind: "message",
      body: String(displayValue), timestamp: new Date().toISOString(), delivery: "sending", envelope });
    renderFeeds();
    renderControls();
  }
  return sendEnvelope(envelope);
}
async function sendEnvelope(envelope) {
  const local = ui.optimistic.get(envelope.clientRequestId);
  if (local) { local.delivery = "sending"; delete local.error; }
  try {
    const result = await api("/api/command", {}, envelope);
    const pending = ui.optimistic.get(envelope.clientRequestId);
    if (pending) pending.delivery = result.receipt?.status || "accepted";
    ingest(result.state || result); return result;
  } catch (error) {
    const pending = ui.optimistic.get(envelope.clientRequestId);
    const rejected = error.status >= 400 && error.status < 500;
    if (pending) { pending.delivery = rejected ? "failed" : "unknown"; pending.error = error.message; }
    if (rejected) for (const [key, item] of ui.actionRequests) if (item.clientRequestId === envelope.clientRequestId) ui.actionRequests.delete(key);
    if (error.state) ingest(error.state); renderFeeds(); throw error;
  }
}
async function submitMessage() {
  const input = $("message"), value = input.value;
  if (!value.trim() || ui.submitting || !ui.connected || ui.state?.readOnly || ui.state?.snapshot?.status === "stopped") return;
  const pending = ui.state?.pendingInteractionAnswered || ui.state?.snapshot?.status === "running" ? undefined : ui.state?.snapshot?.pendingInteraction;
  ui.submitting = true; $("command-error").textContent = ""; renderControls();
  const retry = [...ui.optimistic.values()].find(e => e.delivery === "unknown" && e.envelope?.type === "message" && e.envelope.value === value);
  try { await (retry ? sendEnvelope(retry.envelope) : command("message", value, pending?.id)); if (input.value === value) { input.value = ""; resizeComposer(); } }
  catch (error) { showError(error); }
  finally { ui.submitting = false; renderControls(); }
}
function resizeComposer() {
  const input = $("message"); if (!input) return;
  input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 176) + "px";
}
async function loadHistory() {
  if (ui.historyBusy || !(ui.historyBefore > 0)) return;
  ui.historyBusy = true;
  try { const page = await api("/api/history", { before: ui.historyBefore }); mergeEntries(page.timeline); ui.historyBefore = page.before; ui.limit += 250; }
  catch (error) { $("connection-note").hidden = false; $("connection-note").textContent = error.message; }
  finally { ui.historyBusy = false; renderFeeds(); }
}
async function loadNodes() {
  $("older-nodes").disabled = true;
  try { const page = await api("/api/nodes", { before: ui.nodeBefore }); for (const n of page.nodes) { ui.nodes.set(n.id, n); ui.stale.delete(n.id); } ui.nodeBefore = page.before; renderTree(); if (ui.selected) renderFeeds(); }
  catch (error) { $("tree-note").textContent = error.message; }
  finally { $("older-nodes").disabled = false; }
}
async function evidence() {
  $("evidence-panel").hidden = false; $("evidence-toggle").setAttribute("aria-expanded", "true");
  $("evidence-content").textContent = "正在读取…";
  try {
    const context = await api("/api/context");
    const contents = [el("h3", "", "原始目标")];
    if (context.goal.available) {
      contents.push(el("pre", "", context.goal.preview));
      const a = el("a", "", context.goal.truncated ? "查看完整目标" : "打开目标原文"); a.href = url("/api/evidence", { id: "goal" }); a.target = "_blank"; a.rel = "noopener"; contents.push(a);
    } else contents.push(el("p", "muted", context.goal.error || "尚未保存原始目标"));
    contents.push(el("h3", "", "正式结果"));
    for (const result of context.results) {
      const item = el("div", "evidence-record"); item.append(el("p", "", result.title || result.type || "正式记录"), el("small", "muted", [result.version, time(result.timestamp)].filter(Boolean).join(" · ")));
      if (result.hasFile) { const a = el("a", "", "打开证据"); a.href = url("/api/evidence", { id: result.id }); a.target = "_blank"; a.rel = "noopener"; item.append(a); }
      contents.push(item);
    }
    if (!context.results.length) contents.push(el("p", "muted", "尚无正式结果。Agent 回复不代表版本已晋升。"));
    $("evidence-content").replaceChildren(...contents);
  } catch (error) { $("evidence-content").textContent = error.message; }
}
function bind() {
  if (ui.bound) return; ui.bound = true;
  document.addEventListener("keydown", e => { if (e.key === "Tab") document.documentElement.dataset.keyboard = "true"; });
  document.addEventListener("pointerdown", () => { delete document.documentElement.dataset.keyboard; });
  window.addEventListener("resize", () => { clearTimeout(ui.treeLayoutTimer); ui.treeLayoutTimer = setTimeout(renderTree, 100); });
  $("main-history").onclick = loadHistory; $("worker-history").onclick = loadHistory;
  const theme = saved("flywheel-theme", "system");
  $("theme").value = theme; document.documentElement.dataset.theme = theme;
  $("theme").onchange = () => { document.documentElement.dataset.theme = $("theme").value; save("flywheel-theme", $("theme").value); };
  ui.projectSidebarOpen = saved("flywheel-project-sidebar", matchMedia("(max-width: 760px)").matches ? "closed" : "open") !== "closed";
  setProjectSidebar(ui.projectSidebarOpen);
  $("toggle-project-sidebar").onclick = () => setProjectSidebar(!ui.projectSidebarOpen);
  $("cancel-project-switch").onclick = () => { ui.projectSwitchTarget = null; $("project-switch-confirmation").hidden = true; $("project-switch-error").textContent = ""; };
  $("confirm-project-switch").onclick = switchProject;
  $("toggle-tree").onclick = () => setTree(!ui.treeOpen); $("close-tree").onclick = () => setTree(false);
  $("close-worker").onclick = closeWorker; $("older-nodes").onclick = loadNodes;
  $("audit").onclick = () => { ui.audit = true; ui.selected = null; $("worker-panel").hidden = false; $("workspace").classList.add("worker-open"); renderFeeds(); };
  $("evidence-toggle").onclick = evidence; $("evidence-close").onclick = () => { $("evidence-panel").hidden = true; $("evidence-toggle").setAttribute("aria-expanded", "false"); };
  $("usage-toggle").onclick = () => { $("usage-panel").hidden = !$("usage-panel").hidden; $("usage-toggle").setAttribute("aria-expanded", String(!$("usage-panel").hidden)); renderUsage(); };
  $("usage-close").onclick = () => { $("usage-panel").hidden = true; $("usage-toggle").setAttribute("aria-expanded", "false"); };
  $("reconnect").onclick = connect;
  for (const prefix of ["main", "worker"]) $(prefix + "-latest").onclick = () => { const feed = $(prefix + "-feed"); feed.scrollTop = feed.scrollHeight; $(prefix + "-latest").hidden = true; };
  if ($("message-form")) {
    $("message-form").onsubmit = e => { e.preventDefault(); submitMessage(); };
    $("message").oninput = () => { resizeComposer(); renderControls(); };
    $("message").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!$("send").disabled) submitMessage(); } };
    $("abort").onclick = () => command("abort").catch(showError);
    $("resume").onclick = () => command("resume").catch(showError);
    $("stop").onclick = () => { $("stop-confirmation").hidden = false; };
    $("cancel-stop").onclick = () => { $("stop-confirmation").hidden = true; };
    $("confirm-stop").onclick = async () => { try { await command("stop"); $("stop-confirmation").hidden = true; } catch (e) { showError(e); } };
    resizeComposer();
  }
}
function offline(error) {
  clearTimeout(ui.retry); ui.retry = null;
  ui.connected = false; ui.fresh.clear(); ui.stream?.close();
  ui.denied = error?.status === 403;
  const stopped = ui.state?.snapshot?.status === "stopped";
  $("connection").textContent = stopped ? "服务已关闭" : ui.denied ? "链接失效" : "连接中断";
  $("connection-note").hidden = false;
  $("connection-note").textContent = stopped ? "运行已结束，保留最后的历史记录。重新打开项目可查看持久化历史。" : ui.denied ? "请使用服务启动时输出的最新完整链接。" : "显示最后收到的记录，正在自动重连。草稿会保留。";
  $("reconnect").hidden = stopped;
  renderControls(); renderTree();
  if (!ui.denied && ui.state?.snapshot?.status !== "stopped") ui.retry = setTimeout(connect, Math.min(30000, 2000 * 2 ** ui.attempts++));
}
async function connect() {
  if (ui.state?.snapshot?.status === "stopped") { offline(); return; }
  bind(); clearTimeout(ui.retry); ui.stream?.close();
  $("connection").textContent = "正在连接";
  try {
    const state = await api("/api/state");
    ui.connected = true; ui.denied = false; ui.attempts = 0;
    $("connection").textContent = "已连接"; $("connection-note").hidden = true; $("reconnect").hidden = true;
    ingest(state, true);
    if (ui.state?.snapshot?.status === "stopped") return;
    const stream = new EventSource(url("/api/stream")); ui.stream = stream;
    stream.addEventListener("refresh", e => { if (ui.stream === stream) ingest(JSON.parse(e.data), true); });
    stream.addEventListener("patch", e => { if (ui.stream === stream) ingest(JSON.parse(e.data)); });
    stream.onerror = () => { if (ui.stream === stream) offline(); };
  } catch (error) { offline(error); }
}
connect();
