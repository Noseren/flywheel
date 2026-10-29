import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAgentAdapter } from "../../src/services/agent/codex-adapter.ts";
import type { AgentJob } from "../../src/services/agent/protocol.ts";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";

const job: AgentJob = {
  operation: "analyze",
  label: "analyze",
  prompt: "Write iteration.md",
  cwd: "/tmp/project",
  tools: ["Read", "Write"],
  readRoots: ["/tmp/project/.flywheel"],
  writeRoots: ["/tmp/project/.flywheel/runs/v1"],
  deniedPaths: ["/tmp/project/.flywheel/evaluate.py"],
  promptAssets: [],
};

test("Codex adapter maps streamed events into an auditable result", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "flywheel-codex-home-"));
  const transcriptPath = path.join(codexHome, "sessions", "2026", "08", "06", "rollout-now-thread-1.jsonl");
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, "{}\n", "utf8");
  let receivedPrompt = "";
  let receivedHome: unknown;
  let receivedOptions: Record<string, unknown> | undefined;
  const auditEvents: Record<string, unknown>[] = [];
  class FakeCodex {
    constructor(options?: { env?: Record<string, string> }) { receivedHome = options?.env?.CODEX_HOME; }
    startThread(options: Record<string, unknown>) {
      receivedOptions = options;
      return {
        id: "thread-1",
        async runStreamed(prompt: string) {
          receivedPrompt = prompt;
          async function* events() {
            yield { type: "thread.started", thread_id: "thread-1" };
            yield {
              type: "item.started",
              item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" },
            };
            yield {
              type: "item.completed",
              item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" },
            };
            yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 0,
                output_tokens: 4, reasoning_output_tokens: 2,
              },
            };
          }
          return { events: events() };
        },
      };
    }
  }
  const adapter = new CodexAgentAdapter({
    model: "test-model",
    modelReasoningEffort: "low",
    codexHome,
    sdkLoader: async () => ({ Codex: FakeCodex } as unknown as typeof import("@openai/codex-sdk")),
  });

  const result = await adapter.run({ ...job, onEvent: (event) => { auditEvents.push(event); } });

  assert.equal(result.success, true);
  assert.equal(result.sessionId, "thread-1");
  assert.equal(result.transcriptPath, transcriptPath);
  assert.equal(result.summary, "done");
  assert.equal(result.usage?.inputTokens, 10);
  assert.equal(receivedOptions?.approvalPolicy, "never");
  assert.equal(receivedOptions?.networkAccessEnabled, false);
  assert.equal(receivedOptions?.modelReasoningEffort, "low");
  assert.equal(auditEvents[0].sdkEvent, "codex.execution-profile");
  assert.deepEqual(auditEvents[1], {
    sdkEvent: "thread.started", thread_id: "thread-1", transcriptPath,
  });
  assert.deepEqual(auditEvents[2], {
    sdkEvent: "item.started",
    item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" },
  });
  assert.deepEqual(auditEvents[3], {
    sdkEvent: "item.completed",
    item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "ok\n", exit_code: 0, status: "completed" },
  });
  assert.equal(receivedPrompt, "Write iteration.md");
  assert.equal(receivedHome, codexHome);
});

test("Codex adapter fails closed when a boundary escapes cwd", async () => {
  let loaded = false;
  const adapter = new CodexAgentAdapter({
    sdkLoader: async () => {
      loaded = true;
      throw new Error("must not load");
    },
  });

  const result = await adapter.run({ ...job, writeRoots: ["/tmp/outside"] });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /outside cwd/);
  assert.equal(loaded, false);
});

test("Codex adapter defaults to GPT-5.6 Luna", () => {
  const adapter = new CodexAgentAdapter();
  assert.equal(adapter.model, "gpt-5.6-luna");
});

test("Codex SDK lowers only default effort for a live Runtime assistance reservation", async () => {
  for (const kind of ["child", "parent", "explicit-medium", "explicit-high", "missing", "closed", "required", "ordinary"]) {
    const budget = new ExecutionBudget(createExecutionBudgetState(), async () => {});
    await budget.reserveRequiredWork("verification", { tokens: 1000, activeMs: 1000, source: "test" });
    const admitted = await budget.admitAssistance({ requestId: "batch", windowId: "prepare", binding: "test", childCount: 1, requiredReservationId: "verification" });
    if (kind === "closed") await budget.closeReservation(admitted.reservationId!);
    const reservationId = kind === "missing" ? "missing" : kind === "required" ? "verification" : admitted.reservationId!;
    const expected = ["child", "parent"].includes(kind) ? "low" : kind === "explicit-high" ? "high" : "medium";
    const audit: Record<string, unknown>[] = [];
    let received: Record<string, unknown> | undefined;
    let resumed: string | undefined;
    class FakeCodex {
      startThread(options: Record<string, unknown>) {
        received = options;
        return { id: "profile-thread", async runStreamed() {
          async function* events() {
            yield { type: "thread.started", thread_id: "profile-thread" };
            yield { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } };
          }
          return { events: events() };
        } };
      }
      resumeThread(id: string, options: Record<string, unknown>) { resumed = id; return this.startThread(options); }
    }
    const adapter = new CodexAgentAdapter({ model: "same-model",
      ...(kind === "explicit-medium" ? { modelReasoningEffort: "medium" as const } : kind === "explicit-high" ? { modelReasoningEffort: "high" as const } : {}),
      sdkLoader: async () => ({ Codex: FakeCodex } as unknown as typeof import("@openai/codex-sdk")),
    });
    const result = await adapter.run({ ...job, executionBudget: budget,
      ...(kind === "ordinary" ? {} : { invocationReservation: { reservationId, estimateClass: "assistance" } }),
      ...(kind === "child" ? { parentJobId: "parent", depth: 1 } : {}),
      ...(kind === "parent" ? { resumeSessionId: "original-parent" } : {}),
      onEvent: event => { audit.push(event); },
    });
    assert.equal(result.success, true, kind);
    assert.equal(received?.model, "same-model");
    assert.equal(received?.modelReasoningEffort, expected, kind);
    if (kind === "parent") assert.equal(resumed, "original-parent");
    const profile = audit.find(event => event.sdkEvent === "codex.execution-profile")!;
    assert.equal(profile.effectiveReasoningEffort, expected);
    assert.equal(profile.requestedReasoningEffort, kind === "explicit-high" ? "high" : "medium");
    assert.equal(profile.boundedAssistance, ["child", "parent", "explicit-medium", "explicit-high"].includes(kind));
    assert.equal(profile.source, kind.startsWith("explicit") ? "explicit" : ["child", "parent"].includes(kind) ? "assistance-default" : "default");
    assert.equal(profile.transport, "sdk");
    assert.equal(budget.state.knownTokens, 0, "profile selection does not rewrite budget accounting");
  }
});

test("Codex adapter resumes the delegated session when requested", async () => {
  let resumedId: string | undefined;
  class FakeCodex {
    startThread() { throw new Error("must resume instead of starting a new thread"); }
    resumeThread(id: string) {
      resumedId = id;
      return {
        id,
        async runStreamed() {
          async function* events() {
            yield { type: "thread.started", thread_id: id };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
                output_tokens: 1, reasoning_output_tokens: 0,
              },
            };
          }
          return { events: events() };
        },
      };
    }
  }
  const adapter = new CodexAgentAdapter({
    sdkLoader: async () => ({ Codex: FakeCodex } as unknown as typeof import("@openai/codex-sdk")),
  });

  const result = await adapter.run({ ...job, resumeSessionId: "thread-existing" });

  assert.equal(result.success, true);
  assert.equal(result.sessionId, "thread-existing");
  assert.equal(resumedId, "thread-existing");
});

test("Codex adapter falls back to a resolved Codex executable when optional binaries are missing", async () => {
  const constructorOptions: Array<Record<string, unknown> | undefined> = [];
  const auditEvents: Record<string, unknown>[] = [];
  class FakeCodex {
    constructor(options?: Record<string, unknown>) {
      constructorOptions.push(options);
      if (!options?.codexPathOverride) throw new Error("Unable to locate Codex CLI binaries");
    }

    startThread() {
      return {
        id: "fallback-thread",
        async runStreamed() {
          async function* events() {
            yield { type: "thread.started", thread_id: "fallback-thread" };
            yield {
              type: "turn.completed",
              usage: {
                input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0,
                output_tokens: 1, reasoning_output_tokens: 0,
              },
            };
          }
          return { events: events() };
        },
      };
    }
  }
  const adapter = new CodexAgentAdapter({
    pathResolver: () => "/usr/local/bin/codex",
    sdkLoader: async () => ({ Codex: FakeCodex } as unknown as typeof import("@openai/codex-sdk")),
  });

  const result = await adapter.run({ ...job, onEvent: (event) => { auditEvents.push(event); } });

  assert.equal(result.success, true);
  assert.equal(constructorOptions.length, 2);
  assert.equal(constructorOptions[1]?.codexPathOverride, "/usr/local/bin/codex");
  assert.deepEqual(auditEvents[1], {
    sdkEvent: "codex.binary.fallback",
    codexPath: "/usr/local/bin/codex",
  });
});
