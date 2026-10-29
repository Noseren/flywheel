import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runAgentJob } from "../../src/services/agent/job-runner.ts";
import { DefaultAgentService, executeAgentServiceTurn } from "../../src/services/agent/service.ts";
import type { AgentAdapter } from "../../src/services/agent/protocol.ts";
import type { JobSpec } from "../../src/services/agent/job-protocol.ts";
import { PromptAssetStore, promptAsset } from "../../src/services/prompt/index.ts";

test("job runner resolves assets and records the exact public message before adapter events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-job-prompts-"));
  await mkdir(path.join(root, "adapter", "generic"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "adapter", "generic", "job.md"), "ENVELOPE\n{{job_prompt}}\n");
  await writeFile(path.join(root, "test", "message.md"), "完整的\n{{detail}}");
  const prompts = new PromptAssetStore({ builtinRoot: root });
  const events: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const adapter: AgentAdapter = {
    async run(job) {
      order.push("adapter");
      assert.equal(job.prompt, "ENVELOPE\n完整的\n多行消息\n");
      assert.deepEqual(job.promptAssets.map((asset) => asset.id), ["adapter.generic.job", "test.message"]);
      return { success: true };
    },
  };
  const job: JobSpec = {
    operation: "init",
    label: "manager",
    prompt: promptAsset("test.message", { detail: "多行消息" }),
    cwd: "/tmp/project",
    tools: ["Read"],
    readRoots: ["/tmp/project"],
    writeRoots: ["/tmp/project/.flywheel"],
    resumeSessionId: "session-1",
    onEvent: (event) => { order.push(String(event.sdkEvent)); events.push(event); },
  };

  await runAgentJob(adapter, prompts, job);

  assert.deepEqual(order, ["job.started", "invocation.started", "adapter", "invocation.completed"]);
  assert.equal(events[1].invocationId, events[2].invocationId);
  assert.equal(events[2].usage, null);
  assert.equal(events[0].sdkEvent, "job.started");
  assert.equal(events[0].prompt, "ENVELOPE\n完整的\n多行消息\n");
  assert.deepEqual(
    (events[0].promptAssets as Array<{ id: string }>).map((asset) => asset.id),
    ["adapter.generic.job", "test.message"],
  );
});

test("invocation accounting preserves partial usage, retry identity and thrown cancellation", async () => {
  const events: Record<string, unknown>[] = [];
  const controller = new AbortController();
  let attempt = 0;
  const adapter: AgentAdapter = { provider: "mock", model: "metered", async run() {
    if (attempt++ === 0) return { success: false, usage: { inputTokens: 15, outputTokens: 2 } };
    controller.abort();
    throw new Error("cancelled");
  } };
  const job: JobSpec = { id: "parent/child", parentJobId: "parent", depth: 1,
    operation: "inspect", label: "meter", cwd: process.cwd(), tools: [],
    readRoots: [process.cwd()], writeRoots: [],
    prompt: promptAsset("common.capability-context", { capability: "init", operation: "inspect", status: "running", job_prompt: "inspect" }),
    onEvent: (event) => { events.push(event); },
  };
  await runAgentJob(adapter, new PromptAssetStore(), job);
  await assert.rejects(runAgentJob(adapter, new PromptAssetStore(), job, controller.signal), /cancelled/);
  const completed = events.filter((event) => event.sdkEvent === "invocation.completed");
  assert.equal(completed.length, 2);
  assert.notEqual(completed[0].invocationId, completed[1].invocationId);
  assert.deepEqual(completed[0].usage, { inputTokens: 15, outputTokens: 2 });
  assert.equal(completed[1].status, "aborted");
  assert.equal(completed[1].usage, null);
  assert.equal(completed[0].parentJobId, "parent");
});

test("AgentService maps provider transport outcomes to the generic JobResult protocol", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-agent-service-"));
  const prompts = new PromptAssetStore();
  const job: JobSpec = {
    operation: "init",
    label: "manager",
    prompt: { assetId: "common.capability-context", variables: {
      capability: "init", operation: "inspect", status: "running", job_prompt: "hello",
    } },
    cwd: root,
    tools: [],
    readRoots: [root],
    writeRoots: [root],
  };
  const completed = await new DefaultAgentService({
    async run() { return { success: true, sessionId: "session-1" }; },
  }, prompts).execute(job);
  const failed = await new DefaultAgentService({
    async run() { return { success: false, error: "provider unavailable" }; },
  }, prompts).execute(job);
  const unspecifiedFailure = await new DefaultAgentService({
    async run() { return { success: false }; },
  }, prompts).execute(job);

  assert.deepEqual({ status: completed.status, artifacts: completed.artifacts }, {
    status: "completed", artifacts: [],
  });
  assert.equal(completed.sessionId, "session-1");
  assert.equal(failed.status, "failed");
  assert.equal(failed.message, "provider unavailable");
  assert.equal(unspecifiedFailure.message, "Agent transport failed without details");
});

test("AgentService returns the Agent-authored JobResult instead of transport success", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-worker-result-"));
  const resultPath = path.join(root, "output", "result.json");
  const artifactPath = path.join(root, "output", "artifact.txt");
  const job: JobSpec = {
    operation: "tasking",
    label: "tasking:s1",
    prompt: { assetId: "common.capability-context", variables: {
      capability: "run", operation: "tasking", status: "running", job_prompt: "do the task",
    } },
    cwd: root,
    tools: ["Write"],
    readRoots: [root],
    writeRoots: [path.dirname(resultPath)],
    resultPath,
  };
  const service = new DefaultAgentService({
    async run() {
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(artifactPath, "done\n");
      await writeFile(resultPath, JSON.stringify({
        status: "needs_input", artifacts: [], message: "source workbook is missing",
      }));
      return { success: true, sessionId: "worker-session" };
    },
  }, new PromptAssetStore());

  const result = await service.execute(job);

  assert.equal(result.status, "needs_input");
  assert.equal(result.message, "source workbook is missing");
  assert.equal(result.sessionId, "worker-session");
});

test("AgentService classifies a damaged JobResult as repairable protocol evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-worker-protocol-"));
  const resultPath = path.join(root, "output", "result.json");
  const service = new DefaultAgentService({
    async run() {
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultPath, "not-json\n");
      return { success: true, sessionId: "repair-session" };
    },
  }, new PromptAssetStore());

  const result = await service.execute({
    operation: "tasking", label: "tasking:s1",
    prompt: { assetId: "common.capability-context", variables: {
      capability: "run", operation: "tasking", status: "running", job_prompt: "do the task",
    } },
    cwd: root, tools: ["Write"], readRoots: [root], writeRoots: [path.dirname(resultPath)], resultPath,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.protocolIssues?.length, 1);
  assert.equal(result.sessionId, "repair-session");
});

test("AgentService may defer final JobResult validation while a recursive Job is between turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-agent-turn-"));
  const resultPath = path.join(root, "output", "result.json");
  const service = new DefaultAgentService({
    async run() { return { success: true, sessionId: "recursive-session" }; },
  }, new PromptAssetStore());
  const result = await executeAgentServiceTurn(service, {
    operation: "tasking", label: "tasking:v1", cwd: root,
    tools: ["Write"], readRoots: [root], writeRoots: [path.dirname(resultPath)], resultPath,
    prompt: promptAsset("common.capability-context", {
      capability: "run", operation: "tasking", status: "running", job_prompt: "work",
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.protocolIssues, undefined);
});
