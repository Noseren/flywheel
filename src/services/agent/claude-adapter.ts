import path from "node:path";

import type { AgentAdapter, AgentJob, AgentResult } from "./protocol.ts";

function isInside(candidate: string, roots: string[]): boolean {
  const absolute = path.resolve(candidate);
  return roots.some((root) => {
    const relative = path.relative(path.resolve(root), absolute);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function touchesDeniedPath(candidate: string, deniedPaths: string[]): boolean {
  const absolute = path.resolve(candidate);
  return deniedPaths.some((denied) => {
    const relative = path.relative(path.resolve(denied), absolute);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function pathFromToolInput(input: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "path", "notebook_path"] as const) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

/** Claude compatibility transport; Capability state and Policy decisions stay outside the adapter. */
export class ClaudeAgentAdapter implements AgentAdapter {
  readonly provider = "claude";
  readonly model: string;
  readonly maxTurns: number;
  readonly onMessage?: (label: string, message: unknown) => void;

  constructor(options: { model?: string; maxTurns?: number; onMessage?: (label: string, message: unknown) => void } = {}) {
    this.model = options.model ?? "claude-sonnet-4-6";
    this.maxTurns = options.maxTurns ?? 40;
    this.onMessage = options.onMessage;
  }

  async run(job: AgentJob, signal?: AbortSignal): Promise<AgentResult> {
    let sdk: typeof import("@anthropic-ai/claude-agent-sdk");
    try {
      sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      return { success: false, error: "@anthropic-ai/claude-agent-sdk is not installed" };
    }

    let final: Record<string, unknown> | undefined;
    try {
      const abortController = new AbortController();
      if (signal?.aborted) abortController.abort(signal.reason);
      else signal?.addEventListener("abort", () => abortController.abort(signal.reason), { once: true });
      async function* promptStream() {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: job.prompt },
          parent_tool_use_id: null,
          session_id: job.label,
        };
      }
      const stream = sdk.query({
        // Streaming input is required for SDK permission callbacks.
        prompt: promptStream(),
        options: {
          cwd: job.cwd,
          ...(job.resumeSessionId ? { resume: job.resumeSessionId } : {}),
          model: this.model,
          maxTurns: this.maxTurns,
          abortController,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: [],
          tools: job.tools,
          allowedTools: job.tools,
          permissionMode: "dontAsk",
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            if (!job.tools.includes(toolName)) {
              return { behavior: "deny" as const, message: `${toolName} is not available in ${job.operation}` };
            }
            const target = pathFromToolInput(input);
            if (target) {
              if (touchesDeniedPath(target, job.deniedPaths ?? [])) {
                return { behavior: "deny" as const, message: "Path is outside this Job's authorized write boundary" };
              }
              const roots = toolName === "Write" || toolName === "Edit" ? job.writeRoots : job.readRoots;
              if (!isInside(target, roots)) {
                return { behavior: "deny" as const, message: `Path is outside the ${job.operation} boundary` };
              }
            }
            if (toolName === "Bash" && typeof input.command === "string") {
              const normalized = input.command.replaceAll("\\ ", " ");
              if ((job.deniedPaths ?? []).some((denied) => normalized.includes(denied))) {
                return { behavior: "deny" as const, message: "Command references a protected path" };
              }
            }
            return { behavior: "allow" as const, updatedInput: input };
          },
        },
      });
      for await (const message of stream) {
        this.onMessage?.(job.label, message);
        if ((message as { type?: string }).type === "result") final = message as unknown as Record<string, unknown>;
      }
    } catch (error) {
      return {
        success: false,
        aborted: signal?.aborted === true,
        error: signal?.aborted ? "Agent operation was interrupted by the Flywheel session" : error instanceof Error ? error.message : String(error),
      };
    }
    if (!final) return {
      success: false,
      aborted: signal?.aborted === true,
      error: signal?.aborted ? "Agent operation was interrupted by the Flywheel session" : "SDK session ended without a result event",
    };
    const success = final.subtype === "success" && final.is_error !== true;
    return {
      success,
      sessionId: typeof final.session_id === "string" ? final.session_id : job.resumeSessionId,
      summary: typeof final.result === "string" ? final.result.slice(0, 500) : undefined,
      error: success ? undefined : String(final.result ?? final.errors ?? "Agent run failed"),
      costUsd: typeof final.total_cost_usd === "number" ? final.total_cost_usd : undefined,
      durationMs: typeof final.duration_ms === "number" ? final.duration_ms : undefined,
    };
  }
}
