import path from "node:path";
import { accessSync, constants } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { runCodexAppServer, type CodexAppServerOptions } from "./codex-app-server.ts";
import { flywheelCodexHome, prepareCodexHome, sharedCodexHome } from "./codex-home.ts";

import type { AgentAdapter, AgentJob, AgentResult } from "./protocol.ts";

export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type CodexSdk = typeof import("@openai/codex-sdk");
type CodexThreadEvent = import("@openai/codex-sdk").ThreadEvent;

/**
 * Preserve the complete public Codex SDK event payload for persistence and UI
 * consumers. `sdkEvent` is kept as the stable discriminator used by Flywheel.
 */
export function serializeCodexEvent(event: CodexThreadEvent): Record<string, unknown> {
  const { type, ...payload } = event;
  return { sdkEvent: type, ...payload };
}

export async function findCodexTranscript(
  threadId: string,
  codexHome = process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
): Promise<string | undefined> {
  const sessionsRoot = path.resolve(codexHome, "sessions");
  try {
    const entries = await readdir(sessionsRoot, { recursive: true });
    const suffix = `-${threadId}.jsonl`;
    const match = entries.find((entry) => entry.endsWith(suffix));
    return match ? path.join(sessionsRoot, match) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function executableOnPath(command = process.platform === "win32" ? "codex.exe" : "codex"): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking through PATH.
    }
  }
  return undefined;
}

function executable(candidate: string): string | undefined {
  try {
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

function appBundledCodex(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const candidates = [
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    path.join(homedir(), "Applications/ChatGPT.app/Contents/Resources/codex"),
    path.join(homedir(), "Applications/Codex.app/Contents/Resources/codex"),
  ];
  return candidates.find((candidate) => executable(candidate) !== undefined);
}

function defaultCodexPath(): string | undefined {
  // The desktop app and its model cache are updated together. Prefer its CLI
  // over an arbitrary global binary, which may be too old to read that cache.
  return appBundledCodex() ?? executableOnPath() ?? npmBundledCodex();
}

function npmBundledCodex(): string | undefined {
  // Resolve from the SDK's dependency scope too (pnpm keeps optional CLI
  // packages out of the application's top-level node_modules).
  const architectures: Record<string, string> = { x64: "x86_64", arm64: "aarch64" };
  const platforms: Record<string, string> = { linux: "unknown-linux-musl", darwin: "apple-darwin", win32: "pc-windows-msvc" };
  const triple = architectures[process.arch] && platforms[process.platform]
    ? `${architectures[process.arch]}-${platforms[process.platform]}` : undefined;
  if (!triple) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const sdkRequire = createRequire(require.resolve("@openai/codex-sdk"));
    const cliRequire = createRequire(sdkRequire.resolve("@openai/codex/package.json"));
    const native = cliRequire.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const root = path.join(path.dirname(native), "vendor", triple);
    const name = process.platform === "win32" ? "codex.exe" : "codex";
    return executable(path.join(root, "bin", name)) ?? executable(path.join(root, "codex", name));
  } catch { return undefined; }
}

function explainCodexFailure(error: unknown, codexPath?: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("supports_reasoning_summaries") && message.includes("models cache")) {
    const selected = codexPath ? ` (${codexPath})` : "";
    return [
      `The selected Codex CLI${selected} is incompatible with the current Codex models cache.`,
      "Use the CLI bundled with the current ChatGPT/Codex app, update @openai/codex, or run flywheel dev with --codex-path /absolute/path/to/a-current/codex.",
      `Original error: ${message}`,
    ].join(" ");
  }
  return message;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Codex transport only: enforce the SDK sandbox envelope and normalize public events/results. */
export class CodexAgentAdapter implements AgentAdapter {
  readonly provider = "codex";
  readonly model?: string;
  readonly modelReasoningEffort: CodexReasoningEffort;
  readonly onEvent?: (label: string, event: unknown) => void;
  readonly loadSdk: () => Promise<CodexSdk>;
  readonly codexPath?: string;
  readonly codexHome: string;
  readonly resolveCodexPath: () => string | undefined;
  private readonly useSdk: boolean;
  private readonly prepareHome: boolean;
  private readonly appServerLauncher?: CodexAppServerOptions["launch"];
  private readonly explicitReasoningEffort: boolean;

  constructor(options: {
    model?: string;
    modelReasoningEffort?: CodexReasoningEffort;
    onEvent?: (label: string, event: unknown) => void;
    sdkLoader?: () => Promise<CodexSdk>;
    codexPath?: string;
    codexHome?: string;
    pathResolver?: () => string | undefined;
    appServerLauncher?: CodexAppServerOptions["launch"];
  } = {}) {
    this.model = options.model ?? "gpt-5.6-luna";
    this.modelReasoningEffort = options.modelReasoningEffort ?? "medium";
    this.explicitReasoningEffort = options.modelReasoningEffort !== undefined;
    this.onEvent = options.onEvent;
    this.loadSdk = options.sdkLoader ?? (() => import("@openai/codex-sdk"));
    this.codexPath = options.codexPath ?? process.env.FLYWHEEL_CODEX_PATH;
    this.codexHome = path.resolve(options.codexHome ?? flywheelCodexHome());
    this.resolveCodexPath = options.pathResolver ?? defaultCodexPath;
    // Explicit SDK injection remains available to existing integrations/tests.
    // Production uses app-server because exec SDK events omit real text deltas.
    this.useSdk = options.sdkLoader !== undefined;
    this.prepareHome = !options.sdkLoader && !options.appServerLauncher;
    this.appServerLauncher = options.appServerLauncher;
  }

  async run(job: AgentJob, signal?: AbortSignal): Promise<AgentResult> {
    for (const root of [...job.readRoots, ...job.writeRoots, ...(job.deniedPaths ?? [])]) {
      if (!isInside(root, job.cwd)) {
        return { success: false, error: `Codex boundary ${path.resolve(root)} is outside cwd ${path.resolve(job.cwd)}` };
      }
    }

    try { if (this.prepareHome) await prepareCodexHome(this.codexHome, sharedCodexHome(), job.resumeSessionId); }
    catch (error) { return { success: false, error: `Cannot prepare Flywheel Codex home: ${error instanceof Error ? error.message : String(error)}` }; }

    const reservationId = job.invocationReservation?.reservationId;
    const reservation = reservationId ? job.executionBudget?.state.reservations?.[reservationId] : undefined;
    const boundedAssistance = job.invocationReservation?.estimateClass === "assistance"
      && reservation?.kind === "assistance" && !reservation.closed;
    const effectiveEffort = boundedAssistance && !this.explicitReasoningEffort ? "low" : this.modelReasoningEffort;
    await job.onEvent?.({ sdkEvent: "codex.execution-profile", model: this.model,
      requestedReasoningEffort: this.modelReasoningEffort, effectiveReasoningEffort: effectiveEffort,
      source: this.explicitReasoningEffort ? "explicit" : boundedAssistance ? "assistance-default" : "default",
      boundedAssistance, transport: this.useSdk ? "sdk" : "app-server",
      ...(boundedAssistance ? { reservationId } : {}),
    });

    if (!this.useSdk) {
      const result = await runCodexAppServer(job, {
        executable: this.codexPath ?? this.resolveCodexPath() ?? "codex",
        model: this.model,
        effort: effectiveEffort,
        codexHome: this.codexHome,
        launch: this.appServerLauncher,
        onEvent: (event) => this.onEvent?.(job.label, event),
      }, signal);
      if (result.sessionId) {
        result.transcriptPath = await findCodexTranscript(result.sessionId, this.codexHome);
        if (result.transcriptPath) await job.onEvent?.({
          sdkEvent: "codex.transcript.located", thread_id: result.sessionId, transcriptPath: result.transcriptPath,
        });
      }
      return result;
    }

    let sdk: CodexSdk;
    let selectedCodexPath = this.codexPath;
    try {
      sdk = await this.loadSdk();
    } catch {
      return { success: false, error: "@openai/codex-sdk is not installed; run npm install in runtime/" };
    }

    const startedAt = Date.now();
    let sessionId: string | undefined;
    let transcriptPath: string | undefined;
    let summary: string | undefined;
    let failure: string | undefined;
    let completed = false;
    let usage: AgentResult["usage"];

    try {
      let codex: InstanceType<CodexSdk["Codex"]>;
      try {
        codex = new sdk.Codex({ ...(this.codexPath ? { codexPathOverride: this.codexPath } : {}),
          env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CODEX_HOME: this.codexHome } });
      } catch (error) {
        const fallback = this.codexPath ? undefined : this.resolveCodexPath();
        if (!fallback) throw error;
        selectedCodexPath = fallback;
        await job.onEvent?.({ sdkEvent: "codex.binary.fallback", codexPath: fallback });
        codex = new sdk.Codex({ codexPathOverride: fallback,
          env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), CODEX_HOME: this.codexHome } });
      }
      const threadOptions = {
        ...(this.model ? { model: this.model } : {}),
        workingDirectory: job.cwd,
        skipGitRepoCheck: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        modelReasoningEffort: effectiveEffort,
      } as const;
      const thread = job.resumeSessionId
        ? codex.resumeThread(job.resumeSessionId, threadOptions)
        : codex.startThread(threadOptions);
      const { events } = await thread.runStreamed(job.prompt, { signal });
      for await (const event of events) {
        this.onEvent?.(job.label, event);
        const persistedEvent = serializeCodexEvent(event);
        if (event.type === "thread.started") {
          transcriptPath = await findCodexTranscript(event.thread_id, this.codexHome);
          if (transcriptPath) persistedEvent.transcriptPath = transcriptPath;
        }
        await job.onEvent?.(persistedEvent);
        if (event.type === "thread.started") sessionId = event.thread_id;
        else if (event.type === "item.completed" && event.item.type === "agent_message") {
          summary = event.item.text.slice(0, 500);
        } else if (event.type === "turn.failed") {
          failure = event.error.message;
        } else if (event.type === "error") {
          failure = event.message;
        } else if (event.type === "turn.completed") {
          completed = true;
          usage = {
            inputTokens: event.usage.input_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
            cacheWriteInputTokens: event.usage.cache_write_input_tokens,
            outputTokens: event.usage.output_tokens,
            reasoningOutputTokens: event.usage.reasoning_output_tokens,
          };
        }
      }
      sessionId ??= thread.id ?? undefined;
      if (sessionId && !transcriptPath) {
        transcriptPath = await findCodexTranscript(sessionId, this.codexHome);
        if (transcriptPath) {
          await job.onEvent?.({ sdkEvent: "codex.transcript.located", thread_id: sessionId, transcriptPath });
        }
      }
    } catch (error) {
      failure = explainCodexFailure(error, selectedCodexPath);
    }

    return {
      success: completed && failure === undefined,
      aborted: signal?.aborted === true,
      summary,
      error: signal?.aborted
        ? "Agent operation was interrupted by the Flywheel session"
        : failure ?? (completed ? undefined : "Codex session ended without a turn.completed event"),
      sessionId,
      transcriptPath,
      usage,
      durationMs: Date.now() - startedAt,
    };
  }
}
