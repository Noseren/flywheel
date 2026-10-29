import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentJob, AgentResult } from "./protocol.ts";

type Json = Record<string, any>;
export interface CodexAppServerOptions {
  executable: string;
  model?: string;
  effort: string;
  codexHome?: string;
  /** Injection seam for deterministic protocol subprocesses; never an HTTP control plane. */
  launch?: (executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
  onEvent?: (event: Record<string, unknown>) => void;
}

/** One local JSONL connection per adapter invocation; stored thread identity survives it. */
export async function runCodexAppServer(job: AgentJob, options: CodexAppServerOptions, signal?: AbortSignal): Promise<AgentResult> {
  const startedAt = Date.now();
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let summary: string | undefined;
  let usage: AgentResult["usage"];
  let result: AgentResult;
  let processHandle: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<void> | undefined;
  let callbackQueue = Promise.resolve();
  let rejectCompletion: ((error: Error) => void) | undefined;
  let resolveCompletion: (() => void) | undefined;
  let nextId = 0;
  let seq = 0;
  let stderr = "";
  let turnRequested = false;
  let terminalFailure: Error | undefined;
  let callbackFailure: Error | undefined;
  const pending = new Map<number, { method: string; resolve: (value: Json) => void; reject: (error: Error) => void }>();
  const earlyNotifications: Json[] = [];
  const text = new Map<string, string>();
  let baseline: Json | undefined;
  const fail = (error: Error) => {
    terminalFailure ??= error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
    rejectCompletion?.(error);
  };
  const emit = (event: Record<string, unknown>) => {
    const normalized = { ...event, seq: ++seq };
    options.onEvent?.(normalized);
    callbackQueue = callbackQueue.then(async () => { await job.onEvent?.(normalized); });
    // Observe immediately; the awaited queue below still propagates the failure.
    void callbackQueue.catch((error) => {
      callbackFailure ??= error instanceof Error ? error : new Error(String(error));
      fail(callbackFailure);
    });
  };
  // Console errors can arrive a few characters at a time. Persist bounded batches,
  // not thousands of fsyncs; agent-message deltas never enter this buffer.
  const toolDeltas = new Map<string, { params: Json; delta: string; count: number; first: string; last: string }>();
  const flushToolDelta = (id: string) => {
    const batch = toolDeltas.get(id);
    if (!batch) return;
    toolDeltas.delete(id);
    emit({ sdkEvent: "item/commandExecution/outputDelta", ...batch.params, delta: batch.delta,
      coalescedDeltas: batch.count, firstReceivedAt: batch.first, lastReceivedAt: batch.last });
  };
  const flushToolDeltas = () => { for (const id of toolDeltas.keys()) flushToolDelta(id); };
  const send = (message: Json) => { processHandle!.stdin.write(`${JSON.stringify(message)}\n`); };
  const request = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => {
    if (terminalFailure) { reject(terminalFailure); return; }
    const id = ++nextId;
    pending.set(id, { method, resolve, reject });
    send({ id, method, params });
  });
  const abort = () => {
    flushToolDeltas();
    try {
      if (sessionId && turnId && processHandle && !processHandle.stdin.destroyed) {
        send({ id: ++nextId, method: "turn/interrupt", params: { threadId: sessionId, turnId } });
      }
    } catch { /* The connection may have closed concurrently with abort. */ }
    const error = new Error("Agent operation was interrupted by the Flywheel session");
    fail(error);
  };
  try {
    if (signal?.aborted) throw new Error("Agent operation was interrupted by the Flywheel session");
    const env = { ...process.env, ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}) };
    const args = ["app-server", "--listen", "stdio://", "-c", 'web_search="disabled"'];
    processHandle = options.launch
      ? options.launch(options.executable, args, job.cwd, env)
      : spawn(options.executable, args, { cwd: job.cwd, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const completion = new Promise<void>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
    void completion.catch(() => {});
    closed = new Promise((resolve) => processHandle!.once("close", () => resolve()));
    processHandle.on("error", fail);
    processHandle.stdin.on("error", fail);
    processHandle.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
    processHandle.once("exit", (code) => fail(new Error(`Codex app-server exited (${code})${stderr ? `: ${stderr}` : ""}`)));
    const lines = createInterface({ input: processHandle.stdout });
    const handleMessage = (message: Json) => {
      try {
        if (message.id !== undefined && !message.method) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiter?.reject(new Error(message.error.message ?? "Codex protocol request failed"));
          else {
            if (waiter?.method === "turn/start") {
              turnId = message.result?.turn?.id;
              if (!turnId) { waiter.reject(new Error("Codex app-server returned no turn identity")); return; }
              for (const notification of earlyNotifications.splice(0)) handleMessage(notification);
            }
            waiter?.resolve(message.result ?? {});
          }
          return;
        }
        // Flywheel grants no interactive provider approvals, tools, login or elicitation.
        if (message.id !== undefined) {
          send({ id: message.id, error: { code: -32601, message: "Flywheel does not authorize provider server requests" } });
          emit({ sdkEvent: "codex.request.rejected", method: message.method });
          return;
        }
        const p = message.params ?? {};
        if (p.threadId && sessionId && p.threadId !== sessionId) return;
        // Resuming may publish the previous turn's usage/status. Never bill or
        // complete this invocation from a notification before our own turn.
        if (!turnRequested && message.method !== "thread/started") return;
        if (turnRequested && !turnId) { earlyNotifications.push(message); return; }
        const eventTurn = p.turnId ?? (message.method?.startsWith("turn/") ? p.turn?.id : undefined);
        if (eventTurn && turnId && eventTurn !== turnId) return;
        if (message.method === "item/commandExecution/outputDelta" && typeof p.delta === "string" && typeof p.itemId === "string") {
          const now = new Date().toISOString();
          const batch = toolDeltas.get(p.itemId) ?? { params: p, delta: "", count: 0, first: now, last: now };
          batch.delta += p.delta;
          batch.count++;
          batch.last = now;
          toolDeltas.set(p.itemId, batch);
          if (batch.delta.length >= 16_384) flushToolDelta(p.itemId);
          if (toolDeltas.size > 64) flushToolDelta(toolDeltas.keys().next().value!);
        } else if (message.method === "item/agentMessage/delta" && typeof p.delta === "string" && typeof p.itemId === "string") {
          const value = (text.get(p.itemId) ?? "") + p.delta;
          text.set(p.itemId, value);
          emit({ sdkEvent: "item.updated", streamMode: "cumulative", item: { id: p.itemId, type: "agent_message", text: value } });
        } else if (message.method === "item/started" || message.method === "item/completed") {
          const item = normalizeItem(p.item ?? {});
          if (message.method === "item/completed") flushToolDelta(item.id);
          if (item.type === "agent_message" && typeof item.text === "string") {
            text.set(item.id, item.text);
            if (message.method === "item/completed") summary = item.text.slice(0, 500);
          }
          emit({ sdkEvent: message.method === "item/started" ? "item.started" : "item.completed", item });
        } else if (message.method === "thread/tokenUsage/updated") {
          if (!turnId || p.turnId !== turnId) return;
          const total = p.tokenUsage?.total;
          const last = p.tokenUsage?.last;
          if (total && last) {
            baseline ??= Object.fromEntries(Object.keys(total)
              .filter((key) => Number.isFinite(total[key]) && Number.isFinite(last[key]))
              .map((key) => [key, total[key] - last[key]]));
            usage = Object.fromEntries(["inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"]
              .filter((key) => Number.isFinite(total[key]) && Number.isFinite(baseline![key]) && total[key] >= baseline![key])
              .map((key) => [key, total[key] - baseline![key]])) as AgentResult["usage"];
          }
          emit({ sdkEvent: "codex.token_usage", tokenUsage: p.tokenUsage });
        } else if (message.method === "turn/completed") {
          flushToolDeltas();
          if (p.turn?.status === "completed") resolveCompletion?.();
          else rejectCompletion?.(new Error(p.turn?.error?.message ?? `Codex turn ${p.turn?.status ?? "failed"}`));
        } else {
          // Keep tool deltas, warnings and lifecycle data auditable without pretending they are replies.
          emit({ sdkEvent: message.method, ...p });
        }
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    lines.on("line", (line) => {
      try { handleMessage(JSON.parse(line) as Json); }
      catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) throw new Error("Agent operation was interrupted by the Flywheel session");
    await request("initialize", { clientInfo: { name: "flywheel_runtime", title: "Flywheel Runtime", version: "0.1.0" } });
    send({ method: "initialized", params: {} });
    const thread = await request(job.resumeSessionId ? "thread/resume" : "thread/start", {
      ...(job.resumeSessionId ? { threadId: job.resumeSessionId } : {}),
      cwd: job.cwd, model: options.model, approvalPolicy: "never", sandbox: "workspace-write",
      config: { web_search: "disabled", sandbox_workspace_write: { network_access: false } },
    });
    sessionId = thread.thread?.id;
    if (!sessionId) throw new Error("Codex app-server returned no thread identity");
    emit({ sdkEvent: "thread.started", thread_id: sessionId });
    turnRequested = true;
    const turn = await request("turn/start", {
      threadId: sessionId, cwd: job.cwd, model: options.model, effort: options.effort,
      approvalPolicy: "never",
      sandboxPolicy: { type: "workspaceWrite", writableRoots: job.writeRoots, networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true },
      input: [{ type: "text", text: job.prompt }],
    });
    turnId ??= turn.turn?.id;
    if (signal?.aborted) abort();
    await completion;
    await callbackQueue;
    if (terminalFailure) throw terminalFailure;
    if (signal?.aborted) throw new Error("Agent operation was interrupted by the Flywheel session");
    emit({ sdkEvent: "turn.completed", usage });
    await callbackQueue;
    if (terminalFailure) throw terminalFailure;
    result = { success: true, sessionId, summary, usage, durationMs: Date.now() - startedAt };
  } catch (error) {
    flushToolDeltas();
    await callbackQueue.catch(() => {});
    result = { success: false, aborted: signal?.aborted === true, sessionId, summary, usage,
      error: signal?.aborted ? "Agent operation was interrupted by the Flywheel session" : error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (processHandle) {
      // EOF lets the server shut down its tools; kill only if that shutdown stalls.
      processHandle.stdin.end();
      await waitForClose(closed!, 500);
      if (processHandle.exitCode === null && processHandle.signalCode === null) {
        if (process.platform === "win32" && processHandle.pid) {
          // Terminate only this invocation's tree, including a stuck tool child.
          await new Promise<void>((resolve) => {
            const killer = spawn("taskkill.exe", ["/PID", String(processHandle!.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            killer.once("error", () => resolve());
            killer.once("close", () => resolve());
          });
        } else if (!options.launch && processHandle.pid) {
          try { process.kill(-processHandle.pid, "SIGKILL"); } catch { /* Already exited. */ }
        }
        if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGKILL");
      }
      await closed;
      // Shutdown may deliver a final partial stdout chunk after interruption.
      // Finish its audit before the invocation is reported as completed/aborted.
      flushToolDeltas();
      await callbackQueue.catch(() => {});
    }
  }
  if (callbackFailure && result.success) {
    return { ...result, success: false, error: callbackFailure.message };
  }
  return result;
}

async function waitForClose(closed: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

function normalizeItem(item: Json): Json {
  const type = ({ agentMessage: "agent_message", commandExecution: "command_execution", fileChange: "file_change", mcpToolCall: "mcp_tool_call", webSearch: "web_search" } as Record<string, string>)[item.type] ?? item.type;
  return { ...item, type,
    ...(item.aggregatedOutput !== undefined ? { aggregated_output: item.aggregatedOutput } : {}),
    ...(item.exitCode !== undefined ? { exit_code: item.exitCode } : {}),
  };
}
