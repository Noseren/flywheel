import { createInterface, type Interface } from "node:readline";
import { Writable, type Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { buildUsageLedger } from "../session/usage-ledger.ts";
import { targetSummaryText } from "../capabilities/run/target-summary.ts";

import type { Terminal } from "@earendil-works/pi-tui";

import type { RunEvent } from "../capabilities/run/protocol.ts";
import type { InitEvent } from "../capabilities/init/protocol.ts";
import type { Interaction } from "../session/protocol.ts";
import type { SessionEvent, SessionSnapshot } from "../session/protocol.ts";
import type { FlywheelSession } from "../session/session.ts";
import { ExecutionTreeProjection } from "./execution-tree.ts";
import { FullScreenView } from "./full-screen.ts";
import { InitEventRenderer, replayInitHistory } from "./renderers/init-renderer.ts";
import { RuntimeEventRenderer } from "./renderers/runtime-renderer.ts";

function highlightedUserAnswer(value: string): string {
  return `\u001b[7m 你：${value} \u001b[27m`;
}

function systemTimeline(value: string): string {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return lines.length ? `${lines.map((line) => `系统 · ${line}`).join("\n")}\n` : "";
}

function sourcedHistory(value: string): string {
  const lines = value.split(/\r?\n/).filter(Boolean);
  return lines.length ? `${lines.map((line) => line.includes("你：") ? line : `系统 · ${line}`).join("\n")}\n` : "";
}

function parseInteraction(interaction: Interaction, input: string): string | boolean {
  const value = input.trim();
  if (interaction.kind === "confirm") {
    if (!value) return interaction.defaultValue === true;
    return ["y", "yes", "是", "确认", "同意", "批准"].includes(value.toLowerCase());
  }
  if (interaction.kind === "select") {
    const selected = interaction.options?.[Number(value) - 1];
    return selected?.value ?? value;
  }
  return value;
}

function interactionSource(interaction: Interaction): string[] {
  return [interaction.requestedBy?.type === "agent" ? "Flywheel · 等待你的回复" : "请确认或直接补充你的想法"];
}

function interactionText(interaction: Interaction): string {
  const lines = [`\n${interactionSource(interaction).join("\n")}`, interaction.question];
  if (interaction.description) lines.push(interaction.description);
  if (interaction.kind === "confirm") {
    const defaultLabel = interaction.defaultValue === true ? "确认" : "不确认";
    lines.push(`输入“确认/是/y”批准；输入“否/n”不批准。直接回车：${defaultLabel}。`);
  }
  for (const [index, option] of (interaction.options ?? []).entries()) lines.push(`  ${index + 1}. ${option.label}`);
  return `${lines.join("\n")}\n`;
}

function interactionAnswer(interaction: Interaction, input: string, parsed: string | boolean): string {
  if (interaction.kind !== "confirm") return input.trim() || String(parsed);
  const decision = parsed === true ? "确认" : "不确认";
  return input.trim() ? decision : `${decision}（默认）`;
}

function capture(render: (output: Writable) => void): string {
  let value = "";
  const output = new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } });
  render(output);
  return value;
}

export async function runSessionTerminal(
  session: FlywheelSession,
  options: { input?: Readable; output?: Writable; terminal?: Terminal; observerUrl?: string } = {},
): Promise<SessionSnapshot> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input === process.stdin && !process.stdin.isTTY) throw new Error("Interactive Flywheel session requires a TTY");

  const fullScreen = (input as Readable & { isTTY?: boolean }).isTTY === true
    && (output as Writable & { isTTY?: boolean }).isTTY === true;
  const projection = new ExecutionTreeProjection(session.projectRoot);
  let screen: FullScreenView | undefined;
  const initRenderer = new InitEventRenderer();
  const runtimeRenderer = new RuntimeEventRenderer();

  let pending: Interaction | undefined;
  let queue = Promise.resolve();
  let controlQueue = Promise.resolve();
  let finished = false;
  let terminal: Interface | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  let lastCtrlC = 0;
  let queuedMessages = 0;
  const usageEvents: unknown[] = [];
  const streamLengths = new Map<string, number>();
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  const usage = () => buildUsageLedger(usageEvents);
  const usageSummary = () => {
    const totals = usage().totals;
    return `${Math.round(totals.wallElapsedMs / 1000)}秒模型活跃 · ${totals.totalTokens?.toLocaleString() ?? "未知"} tokens${totals.unknownInvocationCount ? "（部分未知）" : ""}`;
  };

  const refresh = () => {
    if (screen) {
      screen.setSnapshot(session.snapshot());
      screen.setUsage(usageSummary());
    } else if (!finished) terminal?.prompt();
  };
  const append = (value: string) => {
    if (!value) return;
    if (screen) screen.append(value); else output.write(value);
  };
  const appendSystem = (value: string) => append(systemTimeline(value));
  const finish = () => {
    if (finished) return;
    finished = true;
    if (usageTimer) clearInterval(usageTimer);
    terminal?.close();
    if (fullScreen) {
      screen?.close();
      output.write(`Flywheel Session 已结束 · ${session.snapshot().status}\n`);
    }
    resolveClosed();
  };

  const renderDomainEvent = (capabilityId: string | undefined, domain: InitEvent | RunEvent) => {
    const init = (domain as InitEvent).scope === "init";
    const data = domain.data ?? {};
    const item = data.item as { id?: string; type?: string; text?: string } | undefined;
    if (domain.type === "job.event" && (data.audience === "user" || /(?:^|:|\s)manager$/.test(String(data.job ?? "")))
      && item?.type === "agent_message" && ["item.updated", "item.completed"].includes(String(data.sdkEvent))) {
      const key = `${data.jobId}:${item.id}`;
      const text = item.text ?? "";
      if (screen) screen.stream(key, text);
      else {
        const previous = streamLengths.get(key) ?? 0;
        if (!previous && text) output.write("Flywheel：");
        output.write(text.slice(previous));
        if (data.sdkEvent === "item.completed") output.write("\n");
      }
      streamLengths.set(key, text.length);
      if (!screen) { refresh(); return; }
    }
    if (domain.type === "manager.responded" && typeof data.message === "string") {
      screen?.finishStreams();
      append(`Flywheel：${data.message}\n`);
      refresh(); return;
    }
    const result = data.result as Record<string, unknown> | undefined;
    const operation = data.operationId ?? domain.operation;
    let formalResult: string | undefined;
    if (["init.baseline.created", "baseline.created"].includes(domain.type) && data.version === "v1") formalResult = "✓ 基线 v1 已建立";
    else if (domain.type === "job.event" && /^assistance\.(admitted|denied|settled)$/.test(String(data.sdkEvent)) && typeof data.message === "string") formalResult = data.message;
    else if (domain.type === "operation.activity" && data.needsInput === true && typeof data.message === "string") formalResult = `需要你确认：${data.message}`;
    else if (domain.type === "runtime.budget.exhausted") formalResult = `Ⅱ 已暂停：${({ attempts: "候选尝试次数", time: "活跃执行时间", tokens: "已知 token", repair: "自动修复次数" } as Record<string, string>)[String(data.reason)] ?? "执行"}预算已用完，进度已保留。`;
    else if (domain.type === "operation.activity" && typeof data.retained === "boolean") formalResult = data.retained
      ? `✓ 候选已保留为正式版本${(domain as RunEvent).version ? ` ${(domain as RunEvent).version}` : ""}${data.target === "achieved" ? "，目标已达成" : data.target === "inconclusive" ? "（目标未判定）" : ""}`
      : "候选未保留，继续使用当前版本。";
    if (domain.type === "operation.completed" && ["completed", "paused"].includes(String(data.status)) && result) {
      if (operation === "assess_target" && typeof result.reportPath === "string") formalResult = new Map([
        ["achieved", "✓ 目标已达成"], ["not_achieved", "目标尚未达成"], ["inconclusive", "现有证据不足以判定目标"],
      ]).get(String(result.assessment));
      else if (operation === "evaluate" && typeof result.evaluationReportPath === "string") formalResult = "✓ 正式版本评价已完成（不代表目标达成）";
      else if (operation === "select" && result.action === "promote" && typeof result.promotedVersion === "string") formalResult = `✓ 候选已晋升为 ${result.promotedVersion}`;
    }
      if (formalResult) {
        const summary = operation === "assess_target" && domain.type === "operation.completed" ? targetSummaryText(result?.userSummary) : undefined;
        appendSystem(`${formalResult}\n${summary ? `${summary}\n` : ""}`); refresh(); return;
      }
    if (screen) {
      screen.ingestDomain(capabilityId ?? (init ? "init" : "run"), domain);
      const started = domain.type === "job.started";
      const activity = domain.type === "job.event";
      const completed = domain.type === "job.completed";
      if (started || activity || completed) { refresh(); return; }
      if (!domain.type.includes("blocked") && !["version.promoted", "init.completed", "target.assessed"].includes(domain.type)) { refresh(); return; }
    }
    const rendered = capture((target) => init
      ? initRenderer.render(domain as InitEvent, target)
      : runtimeRenderer.render(domain as RunEvent, target));
    appendSystem(rendered);
    refresh();
  };

  const unsubscribe = session.subscribe((event: SessionEvent) => {
    if (event.type.startsWith("session.") || event.type === "capability.event") usageEvents.push(event);
    if (event.type === "command.updated") {
      const receipt = event.data?.receipt as { status?: string; error?: string } | undefined;
      if (receipt?.status === "failed" || receipt?.status === "interrupted") appendSystem(`✗ ${receipt.error}\n`);
      refresh(); return;
    }
    if (event.type === "capability.event") {
      renderDomainEvent(event.capabilityId, event.data?.event as InitEvent | RunEvent);
      return;
    }
    screen?.ingestSession(event);
    if (event.type === "capability.aborting") {
      screen?.setStatus("正在安全中断当前操作…");
      appendSystem("Ⅱ 正在中断当前操作；界面会保持打开。\n");
    }
    else if (event.type === "capability.idle") {
      const completed = event.data?.reason === "completed";
      screen?.setStatus(completed
        ? "本轮已完成 · 可继续与管理 Agent 对话 · /stop 退出"
        : "当前已暂停 · 可直接继续对话 · /resume 恢复 · /stop 退出");
      appendSystem(completed
        ? "✓ 本轮已完成。可继续输入问题、修改意见或新目标与管理 Agent 对话。\n"
        : "Ⅱ 当前已暂停。可直接输入问题或修改意见；输入 /resume 可恢复。\n");
    } else if (event.type === "intervention.submitted") {
      appendSystem("→ 已发送，Flywheel 正在回复…\n");
    }
    else if (event.type === "interaction.requested") {
      pending = event.data?.interaction as Interaction;
      screen?.setStatus(interactionSource(pending).join(" · "));
      appendSystem(interactionText(pending));
    } else if (event.type === "capability.blocked") {
      appendSystem(`✗ 已暂停：${String(event.data?.error ?? "未知错误")}\n`);
    } else if (event.type === "session.stopped") finish();
    refresh();
  });

  const handleLine = async (line: string) => {
    const value = line.trim();
    if (value === "/usage") {
      const ledger = usage();
      appendSystem(`时间与 Token · ${usageSummary()}\n输入 ${ledger.totals.inputTokens ?? "未知"} · 输出 ${ledger.totals.outputTokens ?? "未知"} · 调用累计 ${Math.round(ledger.totals.invocationDurationMs / 1000)}秒\n`);
      for (const [name, totals] of Object.entries(ledger.groups.operation)) appendSystem(`${name} · ${totals.totalTokens ?? "未知"} tokens · ${Math.round(totals.wallElapsedMs / 1000)}秒\n`);
      for (const [group, title] of [["phase", "阶段"], ["model", "模型"], ["job", "Job"]] as const) {
        for (const [name, totals] of Object.entries(ledger.groups[group])) appendSystem(`${title} ${name} · ${totals.totalTokens ?? "未知"} tokens · ${Math.round(totals.wallElapsedMs / 1000)}秒\n`);
      }
      return;
    }
    if (value === "/stop" || value === "/quit") {
      await session.accept({ type: "session.stop" }, randomUUID());
      return;
    }
    if (value === "/abort") {
      await session.accept({ type: "capability.abort" }, randomUUID());
      return;
    }
    if (value === "/resume") {
      await session.accept({ type: "capability.resume" }, randomUUID());
      return;
    }
    if (value.startsWith("/")) {
      appendSystem(`未知命令：${value}\n`);
      return;
    }
    if (pending) {
      const interaction = pending;
      pending = undefined;
      const selectedOption = interaction.kind === "select" && /^\d+$/.test(value)
        && interaction.options?.[Number(value) - 1];
      const conversational = interaction.conversationWith?.sessionKey === "manager" && !selectedOption;
      const parsed = conversational ? line : parseInteraction(interaction, line);
      append(`${highlightedUserAnswer(interactionAnswer(interaction, line, parsed))}\n`);
      await session.accept({
        type: "interaction.respond",
        interactionId: interaction.id,
        value: parsed,
        inputKind: conversational ? "text" : "choice",
        source: "tui",
      }, randomUUID());
      return;
    }
    if (value) {
      append(`${highlightedUserAnswer(value)}\n`);
      await session.accept({ type: "intervention.submit", message: line, source: "tui" }, randomUUID());
    }
  };

  const submit = (line: string) => {
    const value = line.trim();
    const control = ["/abort", "/resume", "/stop", "/quit"].includes(value);
    if (value === "/resume" && (queuedMessages > 0 || session.snapshot().status !== "idle")) {
      appendSystem("✗ Session is not idle\n");
      refresh();
      return;
    }
    if (!control) queuedMessages += 1;
    const activeQueue = control ? controlQueue : queue;
    const next = activeQueue.then(() => handleLine(line)).catch((error) => {
      appendSystem(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => {
      if (!control) queuedMessages -= 1;
      refresh();
    });
    if (control) controlQueue = next;
    else queue = next;
  };

  if (fullScreen) {
    screen = new FullScreenView({
      terminal: options.terminal,
      projection,
      chain: session.chain,
      projectRoot: session.projectRoot,
      onSubmit: submit,
      onEscape: () => {
        submit("/abort");
        screen?.flash("已请求安全中断");
      },
      onCtrlC: () => {
        const now = Date.now();
        if (now - lastCtrlC < 500) {
          submit("/stop");
          return;
        }
        lastCtrlC = now;
        if (["running", "aborting"].includes(session.snapshot().status)) {
          submit("/abort");
          screen?.flash("已请求安全中断；再次 Ctrl+C 退出");
        } else {
          screen?.flash("再次 Ctrl+C 退出");
        }
      },
    });
    screen.open();
    usageTimer = setInterval(refresh, 1000);
    usageTimer.unref();
  } else {
    terminal = createInterface({ input, output, terminal: false });
    terminal.on("line", submit);
    terminal.on("SIGINT", () => submit("/abort"));
    terminal.once("close", () => { if (!finished) finish(); });
    output.write("Flywheel · 输入需求开始对话 · /usage 查看用量\n");
    terminal.prompt();
  }

  if (options.observerUrl) {
    appendSystem(`只读观察 GUI：${options.observerUrl}\n所有输入仍请在 TUI 中提交。\n`);
  }

  const sessionHistory = await session.history();
  for (const event of sessionHistory) {
    usageEvents.push(event);
    if (event.type === "capability.event") {
      const domain = event.data?.event as InitEvent | RunEvent | undefined;
      if (domain) screen?.ingestDomain(event.capabilityId ?? ((domain as InitEvent).scope === "init" ? "init" : "run"), domain);
    } else {
      screen?.ingestSession(event);
      if (event.type === "intervention.submitted" && typeof event.data?.message === "string") {
        append(`${highlightedUserAnswer(event.data.message)}\n`);
      }
    }
  }

  const previous = await session.activeHistory();
  const activeCapabilityId = session.snapshot().activeCapabilityId;
  const usageSessionId = session.snapshot().sessionId ?? sessionHistory.findLast(event => event.sessionId)?.sessionId;
  // Older Capability history may not yet have a Session projection. Preserve its
  // known owner without dropping envelope identity; ledger replay deduplicates
  // the same domain IDs already present in sessionHistory.
  for (const event of previous) usageEvents.push({
    type: "capability.event", capabilityId: activeCapabilityId, sessionId: usageSessionId, data: { event },
  });
  if (activeCapabilityId === "init") {
    const previousInit = previous.filter((event) => (event as InitEvent).scope === "init") as InitEvent[];
    if (previousInit.length) append(sourcedHistory(capture((target) => replayInitHistory(previousInit, target))));
    for (const event of previousInit) {
      if (["job.started", "job.event", "job.completed"].includes(event.type)) renderDomainEvent("init", event);
    }
  } else {
    for (const event of previous as RunEvent[]) renderDomainEvent(activeCapabilityId, event);
  }
  screen?.refreshTree();

  void session.dispatch({ type: "session.start" }).catch((error) => {
    appendSystem(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    finish();
  });
  refresh();
  await closed;
  await Promise.all([queue, controlQueue]);
  unsubscribe();
  return session.snapshot();
}
