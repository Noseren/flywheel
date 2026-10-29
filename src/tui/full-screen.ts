import {
  CombinedAutocompleteProvider,
  Editor,
  HStack,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Text,
  truncateToWidth,
  type Component,
  type Terminal,
  TuiAltScreen,
  visibleWidth,
  VStack,
} from "@earendil-works/pi-tui";

import type { RunEvent } from "../capabilities/run/protocol.ts";
import type { InitEvent } from "../capabilities/init/protocol.ts";
import type { SessionEvent, SessionSnapshot } from "../session/protocol.ts";
import { ExecutionTreeProjection, type ExecutionNode, type ExecutionNodeStatus } from "./execution-tree.ts";

export const TUI_COMMANDS = [
  { command: "/abort", description: "中断当前操作并保持界面活跃" },
  { command: "/resume", description: "恢复当前能力" },
  { command: "/usage", description: "查看时间与 Token 账本" },
  { command: "/stop", description: "停止 Session 并退出" },
  { command: "/quit", description: "停止 Session 并退出" },
] as const;

export function isNonPressKeyEvent(data: string): boolean {
  return isKeyRelease(data) || isKeyRepeat(data);
}

const identity = (value: string) => value;
const selectedStyle = (value: string) => `\u001b[7m${value}\u001b[27m`;
const SELECTED_ROW = "\u0000flywheel-selected\u0000";
const selectedRow = (value: string) => `${SELECTED_ROW}${value}`;

function icon(status: ExecutionNodeStatus): string {
  if (status === "running") return "●";
  if (status === "completed") return "✓";
  if (status === "failed" || status === "blocked") return "✗";
  if (status === "aborted") return "Ⅱ";
  if (status === "waiting") return "◐";
  if (status === "stopped") return "■";
  return "○";
}

class MutableLine implements Component {
  private value: string;
  constructor(value: string) { this.value = value; }
  setText(value: string): void { this.value = value; }
  render(width: number): string[] { return [truncateToWidth(this.value, width)]; }
  invalidate(): void {}
}

class FramedPanel implements Component {
  private lines: string[] = [];
  private focused = false;
  private readonly title: string;
  private readonly height: number;
  constructor(title: string, height = 12) { this.title = title; this.height = height; }
  setLines(lines: string[]): void { this.lines = lines; }
  setFocused(focused: boolean): void { this.focused = focused; }
  render(width: number): string[] {
    const size = Math.max(12, width);
    const inner = size - 2;
    const rawTitle = truncateToWidth(` ${this.title} `, inner);
    const title = this.focused ? selectedStyle(rawTitle) : rawTitle;
    const top = `┌${title}${"─".repeat(Math.max(0, inner - visibleWidth(rawTitle)))}┐`;
    const body = this.lines.slice(0, this.height - 2).map((line) => {
      const selected = line.startsWith(SELECTED_ROW);
      const raw = selected ? line.slice(SELECTED_ROW.length) : line;
      const clipped = truncateToWidth(raw, inner - 2);
      const content = `${clipped}${" ".repeat(Math.max(0, inner - 2 - visibleWidth(clipped)))}`;
      return `│ ${selected ? selectedStyle(content) : content} │`;
    });
    while (body.length < this.height - 2) body.push(`│${" ".repeat(inner)}│`);
    return [top, ...body, `└${"─".repeat(inner)}┘`];
  }
  invalidate(): void {}
}

function detailLines(node: ExecutionNode, offset: number): string[] {
  if (node.kind === "capability") return ["项目概览", "选择工作步骤或 Agent 查看详情"];
  const summary = [
    `${icon(node.status)} ${node.kind} · ${node.status}`,
    node.label,
  ];
  if (node.startedAt) summary.push(`开始：${node.startedAt}`);
  if (node.completedAt) summary.push(`结束：${node.completedAt}`);
  const metadata = Object.entries(node.metadata)
    .filter(([key]) => !["job", "item", "aggregated_output"].includes(key))
    .slice(0, 1)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  const fixed = [...summary, ...metadata].slice(0, 5);
  if (!node.lines.length) return fixed;
  const capacity = Math.max(1, 9 - fixed.length);
  const end = Math.max(0, node.lines.length - offset);
  const start = Math.max(0, end - capacity);
  return [...fixed, `活动 ${start + 1}-${end}/${node.lines.length}`, ...node.lines.slice(start, end)];
}

export class FullScreenView {
  readonly projection: ExecutionTreeProjection;
  readonly chain: readonly string[];
  readonly terminal: Terminal;
  readonly ui: TuiAltScreen;
  readonly editor: Editor;
  private readonly header: MutableLine;
  private readonly timelineText = new Text("", 0, 0);
  private readonly navigationPanel = new FramedPanel("工作步骤", 16);
  private readonly jobsPanel = new FramedPanel("Agent Jobs", 16);
  private readonly detailPanel = new FramedPanel("工作详情", 16);
  private readonly statusText = new MutableLine("Esc 安全中断 · ←/→ 切换三栏 · ↑/↓ 选择条目或浏览详情");
  private readonly timeline: string[] = [];
  private readonly streams = new Map<string, string>();
  private usageSummary = "";
  private snapshot: SessionSnapshot = { status: "idle" };
  private detailOffset = 0;
  private lastSelectedId?: string;
  private opened = false;

  constructor(options: {
    terminal?: Terminal;
    projection: ExecutionTreeProjection;
    chain: readonly string[];
    projectRoot: string;
    onSubmit: (line: string) => void;
    onEscape: () => void;
    onCtrlC: () => void;
  }) {
    this.projection = options.projection;
    this.chain = options.chain;
    this.terminal = options.terminal ?? new ProcessTerminal();
    this.ui = new TuiAltScreen(this.terminal, true, undefined, { mouse: true });
    this.header = new MutableLine("Flywheel · 等待开始");
    this.editor = new Editor(this.ui, {
      borderColor: identity,
      selectList: {
        selectedPrefix: selectedStyle,
        selectedText: selectedStyle,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    }, { autocompleteMaxVisible: 6 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(
      TUI_COMMANDS.map(({ command, description }) => ({ name: command.slice(1), description })),
      options.projectRoot,
    ));
    this.editor.onSubmit = (value) => {
      const line = value.trim();
      if (line) this.editor.addToHistory(line);
      this.editor.setText("");
      options.onSubmit(value);
    };

    const timeline = new ScrollView(this.timelineText, { follow: "end", primary: true, scrollbar: "auto" });
    const inspector = new HStack([
      { component: this.navigationPanel, basis: 34, grow: 0, shrink: 1, minSize: 24, maxSize: 42 },
      { component: this.jobsPanel, basis: 28, grow: 0, shrink: 1, minSize: 20, maxSize: 36 },
      { component: this.detailPanel, basis: 0, grow: 1, minSize: 30 },
    ], { gap: 1 });
    this.ui.setLayoutRoot(new VStack([
      { component: this.header, basis: 1, minSize: 1 },
      { component: inspector, basis: 16, minSize: 10, maxSize: 16 },
      { component: timeline, basis: 0, grow: 1, minSize: 2 },
      { component: this.statusText, basis: 1, minSize: 1 },
      { component: this.editor, basis: "auto", minSize: 3, maxSize: 9 },
    ], { gap: 1 }));
    this.ui.setFocus(this.editor);
    this.ui.addInputListener((data) => {
      if (isNonPressKeyEvent(data)) return { consume: true };
      if (matchesKey(data, "ctrl+c")) {
        options.onCtrlC();
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        options.onEscape();
        return { consume: true };
      }
      if (!this.editor.getText() && (matchesKey(data, "up") || matchesKey(data, "down"))) {
        const delta = matchesKey(data, "up") ? -1 : 1;
        if (this.projection.selector() === "details") {
          const maximum = Math.max(0, this.projection.selected().lines.length - 1);
          this.detailOffset = Math.min(maximum, Math.max(0, this.detailOffset - delta));
        } else if (this.projection.selector() === "jobs") this.projection.selectJob(delta);
        else this.projection.selectNavigation(delta);
        this.refreshTree();
        return { consume: true };
      }
      if (!this.editor.getText() && matchesKey(data, "right")) {
        if (this.projection.selector() === "navigation" && this.projection.jobs().length) this.projection.focusJobs();
        else this.projection.focusDetails();
        this.refreshTree();
        return { consume: true };
      }
      if (!this.editor.getText() && matchesKey(data, "left")) {
        if (this.projection.selector() === "details" && this.projection.jobs().length) this.projection.focusJobs();
        else this.projection.focusNavigation();
        this.refreshTree();
        return { consume: true };
      }
      return undefined;
    });
    this.refreshTree();
  }

  open(): void { if (!this.opened) { this.opened = true; this.ui.start(); } }
  close(): void { if (this.opened) { this.opened = false; this.ui.stop({ preserveScreen: true }); } }

  append(value: string): void {
    this.timeline.push(...value.split(/\r?\n/).filter(Boolean));
    this.renderTimeline();
    this.ui.requestRender();
  }

  private renderTimeline(): void {
    this.timelineText.setText([...this.timeline, ...this.streams.values()].join("\n"));
  }

  stream(id: string, value: string): void {
    this.streams.set(id, `Flywheel：${value}`);
    this.renderTimeline();
    this.ui.requestRender();
  }

  finishStreams(): void { this.streams.clear(); this.renderTimeline(); this.ui.requestRender(); }

  setUsage(value: string): void { this.usageSummary = value; this.setSnapshot(this.snapshot); }

  ingestSession(event: SessionEvent): void { this.projection.ingestSession(event); this.refreshTree(); }
  ingestDomain(capabilityId: string, event: InitEvent | RunEvent): void { this.projection.ingestDomain(capabilityId, event); this.refreshTree(); }

  setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
    const status = ({ idle: "等待输入", running: "处理中", aborting: "正在暂停", stopped: "已结束" })[snapshot.status];
    this.header.setText(`Flywheel · ${status}${this.usageSummary ? ` · ${this.usageSummary}` : ""}`);
    this.ui.requestRender();
  }

  setStatus(value: string): void { this.statusText.setText(value); this.ui.requestRender(); }
  flash(value: string): void { this.ui.flash(value); }

  refreshTree(): void {
    const navigation = this.projection.navigation().filter(({ node }) => node.kind !== "capability");
    const jobs = this.projection.jobs();
    const navigationSelected = this.projection.selectedNavigation();
    const jobSelected = this.projection.selectedJob();
    const selector = this.projection.selector();
    this.navigationPanel.setFocused(selector === "navigation");
    this.jobsPanel.setFocused(selector === "jobs");
    this.detailPanel.setFocused(selector === "details");
    const selectedId = this.projection.selected().id;
    if (this.lastSelectedId !== selectedId) {
      this.lastSelectedId = selectedId;
      this.detailOffset = 0;
    }
    const navigationIndex = Math.max(0, navigation.findIndex(({ node }) => node.id === navigationSelected.id));
    const navigationStart = Math.max(0, Math.min(navigationIndex - 6, navigation.length - 14));
    this.navigationPanel.setLines(navigation.slice(navigationStart, navigationStart + 14).map(({ node, depth }) => {
      const parent = node.parentId ? this.projection.get(node.parentId) : undefined;
      const iteration = node.kind === "operation" && parent?.kind === "iteration" ? `${parent.label.replace("Iteration ", "")} · ` : "";
      const cursor = selector === "navigation" && node.id === navigationSelected.id ? "›" : " ";
      const line = `${cursor} ${"  ".repeat(Math.max(0, depth - 1))}${icon(node.status)} ${iteration}${node.label}`;
      return node.id === navigationSelected.id ? selectedRow(line) : line;
    }));
    const jobIndex = Math.max(0, jobs.findIndex((node) => node.id === jobSelected?.id));
    const jobStart = Math.max(0, Math.min(jobIndex - 6, jobs.length - 14));
    this.jobsPanel.setLines(jobs.length
      ? jobs.slice(jobStart, jobStart + 14).map((node) => {
        const depth = typeof node.metadata.depth === "number" ? node.metadata.depth : 0;
        const line = `${selector === "jobs" && node.id === jobSelected?.id ? "›" : " "} ${"  ".repeat(depth)}${icon(node.status)} ${node.label}`;
        return node.id === jobSelected?.id ? selectedRow(line) : line;
      })
      : ["  当前步骤没有 Agent Job", "", "  右侧显示步骤工作详情"]);
    this.detailPanel.setLines(detailLines(this.projection.selected(), this.detailOffset));
    this.ui.requestRender();
  }
}
