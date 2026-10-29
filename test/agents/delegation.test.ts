import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeAgentJobTree, readDelegateRequest } from "../../src/services/agent/delegation.ts";
import type { JobSpec } from "../../src/services/agent/job-protocol.ts";
import type { AgentJobResult, AgentService } from "../../src/services/agent/protocol.ts";
import { executePersistentAgentJob } from "../../src/services/agent/session.ts";
import { promptAsset, type PromptRequest } from "../../src/services/prompt/index.ts";

async function fixture(): Promise<{ root: string; input: string; output: string; job: JobSpec }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-delegation-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, ".flywheel", "runs", "v1", "outputs");
  await mkdir(output, { recursive: true });
  await writeFile(input, "input");
  return {
    root,
    input,
    output,
    job: {
      id: "root", operation: "tasking", label: "root", cwd: root,
      tools: ["Read", "Write", "Bash"], readRoots: [root], writeRoots: [output],
      resultPath: path.join(output, "job-result.json"), sessionKey: "root",
      prompt: promptAsset("run.tasking.batch-generate"),
    },
  };
}

function variable(prompt: PromptRequest, key: string): unknown {
  return prompt.variables?.[key];
}

function basePrompt(job: JobSpec): PromptRequest | undefined {
  const value = variable(job.prompt, "base_prompt");
  return typeof value === "object" && value !== null && (value as PromptRequest).kind === "prompt-asset"
    ? value as PromptRequest : undefined;
}

function findPrompt(prompt: PromptRequest, assetId: string): PromptRequest | undefined {
  if (prompt.assetId === assetId) return prompt;
  for (const value of Object.values(prompt.variables ?? {})) {
    if (typeof value === "object" && value !== null && (value as PromptRequest).kind === "prompt-asset") {
      const found = findPrompt(value as PromptRequest, assetId);
      if (found) return found;
    }
  }
  return undefined;
}

async function complete(job: JobSpec, message = "done"): Promise<AgentJobResult> {
  if (job.resultPath) await writeFile(job.resultPath, JSON.stringify({ status: "completed", artifacts: [], message }));
  return { status: "completed", artifacts: [], sessionId: `${job.sessionKey}-session` };
}

test("an Agent that does not request delegation completes its own Job", async () => {
  const { job } = await fixture();
  const calls: JobSpec[] = [];
  const result = await executeAgentJobTree(async (current) => {
    calls.push(current);
    return await complete(current);
  }, job);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.prompt.assetId, "common.delegation-capable");
});

test("a parent Agent requests minimal Child tasks and resumes the same session", async () => {
  const { input, job } = await fixture();
  const calls: JobSpec[] = [];
  const result = await executeAgentJobTree(async (current) => {
    calls.push(current);
    if (current.id === "root" && basePrompt(current)?.assetId !== "common.delegation-resume") {
      await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
        tasks: [{ task: "inspect input", inputs: [input], tools: ["Read"] }],
      }));
      return { status: "completed", artifacts: [], sessionId: "root-session" };
    }
    return await complete(current, current.id === "root" ? "aggregated" : "inspected");
  }, job);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 3);
  assert.equal(calls[1]?.parentJobId, "root");
  assert.notEqual(calls[1]?.sessionKey, "root");
  assert.equal(calls[2]?.sessionKey, "root");
  assert.equal(basePrompt(calls[2]!)?.assetId, "common.delegation-resume");
});

test("a Child repairs a damaged JobResult in its original session before Parent resumes", async () => {
  const { input, job } = await fixture();
  const childSessions: Array<string | undefined> = [];
  let childTurns = 0;
  const result = await executeAgentJobTree(async (current) => {
    if (current.id === "root" && basePrompt(current)?.assetId !== "common.delegation-resume") {
      await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
        tasks: [{ task: "inspect input", inputs: [input] }],
      }));
      return { status: "completed", artifacts: [], sessionId: "root-session" };
    }
    if (current.id !== "root") {
      childTurns += 1;
      childSessions.push(current.sessionKey);
      if (childTurns === 1) return { status: "completed", artifacts: [], sessionId: "child-session" };
      assert.equal(basePrompt(current)?.assetId, "common.delegation-child-repair");
    }
    return await complete(current);
  }, job);
  assert.equal(result.status, "completed");
  assert.equal(childTurns, 2);
  assert.equal(new Set(childSessions).size, 1);
});

test("the same parent session may delegate additional work after observing Child results", async () => {
  const { input, job } = await fixture();
  let parentTurns = 0;
  const parentSessions: Array<string | undefined> = [];
  const result = await executeAgentJobTree(async (current) => {
    if (current.id === "root") {
      parentTurns += 1;
      parentSessions.push(current.sessionKey);
      if (parentTurns <= 2) {
        await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
          tasks: [{ task: `round ${parentTurns}`, inputs: [input] }],
        }));
        return { status: "completed", artifacts: [], sessionId: "root-session" };
      }
    }
    return await complete(current);
  }, job);
  assert.equal(result.status, "completed");
  assert.equal(parentTurns, 3);
  assert.deepEqual(parentSessions, ["root", "root", "root"]);
});

test("persistent AgentService resumes the original provider session after Child work", async () => {
  const { input, job } = await fixture();
  const resumes: Array<string | undefined> = [];
  const sessions: Record<string, string> = {};
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let parentTurns = 0;
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    resumes.push(current.resumeSessionId);
    const delegation = findPrompt(current.prompt, "common.delegation-capable");
    if ((current.depth ?? 0) === 0) {
      parentTurns += 1;
      await current.onEvent?.({ sdkEvent: "thread.started", thread_id: "parent-session" });
      if (parentTurns === 1) {
        await writeFile(variable(delegation!, "request_path") as string, JSON.stringify({ tasks: [{ task: "child", inputs: [input] }] }));
        return { status: "completed", artifacts: [], sessionId: "parent-session" };
      }
      if (current.resultPath) await writeFile(current.resultPath, JSON.stringify({ status: "completed", artifacts: [] }));
      return { status: "completed", artifacts: [], sessionId: "parent-session" };
    }
    await current.onEvent?.({ sdkEvent: "thread.started", thread_id: "child-session" });
    if (current.resultPath) await writeFile(current.resultPath, JSON.stringify({ status: "completed", artifacts: [] }));
    return { status: "completed", artifacts: [], sessionId: "child-session" };
  };
  const agent: AgentService = { execute };
  const result = await executePersistentAgentJob(agent, job, {
    capabilityId: "run", operationId: "tasking", status: "running", sessions,
    checkpoint: async () => undefined,
    emit: async (type, data) => { events.push({ type, data }); },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(resumes, [undefined, undefined, "parent-session"]);
  assert.equal(Object.values(sessions).includes("child-session"), true);
  assert.deepEqual(events.filter((event) => event.type === "job.started").map((event) => event.data.depth), [0, 1]);
  assert.deepEqual(events.filter((event) => event.type === "job.completed").map((event) => event.data.depth), [1, 0]);
});

test("Agent-authored requests contain no Runtime workspace or identity fields", async () => {
  const { output } = await fixture();
  const requestPath = path.join(output, "request.json");
  await writeFile(requestPath, JSON.stringify({ tasks: [{ task: "work", workspace: output }] }));
  await assert.rejects(readDelegateRequest(requestPath, 32), /unsupported fields: workspace/);
});

test("Child input authority cannot exceed its Parent", async () => {
  const { root, job } = await fixture();
  let repaired = false;
  let controlDir = "";
  const result = await executeAgentJobTree(async (current) => {
    if (basePrompt(current)?.assetId === "common.delegation-repair") {
      repaired = true;
      const rejected = variable(basePrompt(current)!, "rejected_request_path") as string;
      controlDir = path.dirname(rejected);
      assert.equal(JSON.parse(await readFile(rejected, "utf8")).tasks[0].task, "escape");
      return await complete(current);
    }
    await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
      tasks: [{ task: "escape", inputs: [path.dirname(root)] }],
    }));
    return { status: "completed", artifacts: [] };
  }, job);
  assert.equal(result.status, "completed");
  assert.equal(repaired, true);
  assert.equal(await readdir(controlDir).then((entries) => entries.includes("children")).catch(() => false), false);
});

test("Child tools can only inherit or narrow Parent tools", async () => {
  const { input, job } = await fixture();
  let repaired = false;
  const result = await executeAgentJobTree(async (current) => {
    if (basePrompt(current)?.assetId === "common.delegation-repair") {
      repaired = true;
      return await complete(current);
    }
    await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
      tasks: [{ task: "use unavailable tool", inputs: [input], tools: ["WebSearch"] }],
    }));
    return { status: "completed", artifacts: [] };
  }, job);
  assert.equal(result.status, "completed");
  assert.equal(repaired, true);
});

test("siblings receive distinct Runtime-owned write workspaces", async () => {
  const { input, job } = await fixture();
  const children: JobSpec[] = [];
  await executeAgentJobTree(async (current) => {
    if (current.id === "root" && basePrompt(current)?.assetId !== "common.delegation-resume") {
      await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
        tasks: [
          { task: "first", inputs: [input] },
          { task: "second", inputs: [input] },
        ],
      }));
      return { status: "completed", artifacts: [] };
    }
    if (current.id !== "root") children.push(current);
    return await complete(current);
  }, job);
  assert.equal(children.length, 2);
  assert.notEqual(children[0]?.writeRoots[0], children[1]?.writeRoots[0]);
  assert.equal(children[0]?.writeRoots.some((root) => children[1]?.writeRoots.includes(root)), false);
});

test("every Child may recursively use the same delegation protocol", async () => {
  const { input, job } = await fixture();
  const delegated = new Set<string>();
  const calls: JobSpec[] = [];
  await executeAgentJobTree(async (current) => {
    calls.push(current);
    const resumed = basePrompt(current)?.assetId === "common.delegation-resume";
    if (!resumed && (current.depth ?? 0) < 2 && !delegated.has(current.id!)) {
      delegated.add(current.id!);
      await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
        tasks: [{ task: `child of ${current.id}`, inputs: [input] }],
      }));
      return { status: "completed", artifacts: [] };
    }
    return await complete(current);
  }, job, undefined, { maxDepth: 2 });
  assert.deepEqual(calls.map((call) => call.depth), [0, 1, 2, 1, 0]);
});

test("the shared tree budget returns an oversized request to the same Agent", async () => {
  const { input, job } = await fixture();
  let repaired = false;
  const result = await executeAgentJobTree(async (current) => {
    if (basePrompt(current)?.assetId === "common.delegation-repair") {
      repaired = true;
      return await complete(current);
    }
    await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
      tasks: [{ task: "one", inputs: [input] }, { task: "two", inputs: [input] }],
    }));
    return { status: "completed", artifacts: [] };
  }, job, undefined, { maxTotalJobs: 2 });
  assert.equal(result.status, "completed");
  assert.equal(repaired, true);
});

test("delegated Child concurrency never exceeds the Runtime limit", async () => {
  const { input, job } = await fixture();
  let active = 0;
  let peak = 0;
  await executeAgentJobTree(async (current) => {
    if (current.id === "root" && basePrompt(current)?.assetId !== "common.delegation-resume") {
      await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({
        tasks: ["one", "two", "three"].map((task) => ({ task, inputs: [input] })),
      }));
      return { status: "completed", artifacts: [] };
    }
    if (current.id !== "root") {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }
    return await complete(current);
  }, job, undefined, { concurrency: 1 });
  assert.equal(peak, 1);
});

test("abort stops the tree before launching requested Children", async () => {
  const { input, job } = await fixture();
  const controller = new AbortController();
  let calls = 0;
  const result = await executeAgentJobTree(async (current) => {
    calls += 1;
    await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({ tasks: [{ task: "child", inputs: [input] }] }));
    controller.abort();
    return { status: "aborted", artifacts: [] };
  }, job, controller.signal);
  assert.equal(result.status, "aborted");
  assert.equal(calls, 1);
});

test("completed Children are restored after interruption without running them again", async () => {
  const { input, job } = await fixture();
  const first = new AbortController();
  let childCalls = 0;
  const executor = async (current: JobSpec): Promise<AgentJobResult> => {
    if (current.id === "root" && basePrompt(current)?.assetId !== "common.delegation-resume") {
      await writeFile(variable(current.prompt, "request_path") as string, JSON.stringify({ tasks: [{ task: "child", inputs: [input] }] }));
      return { status: "completed", artifacts: [], sessionId: "root-session" };
    }
    if (current.id !== "root") {
      childCalls += 1;
      const result = await complete(current);
      first.abort();
      return result;
    }
    return await complete(current);
  };
  const interrupted = await executeAgentJobTree(executor, job, first.signal);
  assert.equal(interrupted.status, "aborted");
  const resumed = await executeAgentJobTree(executor, job);
  assert.equal(resumed.status, "completed");
  assert.equal(childCalls, 1);
});
