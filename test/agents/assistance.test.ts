import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AssistanceInvariantError, executeAgentJobTree, readAssistanceRequest } from "../../src/services/agent/delegation.ts";
import type { AssistanceRequest, JobSpec } from "../../src/services/agent/job-protocol.ts";
import type { AgentJobResult } from "../../src/services/agent/protocol.ts";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";
import { promptAsset } from "../../src/services/prompt/index.ts";
import { PromptAssetStore } from "../../src/services/prompt/index.ts";
import { DefaultAgentService } from "../../src/services/agent/service.ts";
import { executePersistentAgentJob } from "../../src/services/agent/session.ts";
import { validateJobSpec } from "../../src/services/agent/job-validation.ts";

async function fixture(tokens = 500_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-assistance-"));
  const input = path.join(root, "input.txt");
  const output = path.join(root, "output");
  await mkdir(output);
  await writeFile(input, "public input");
  const budget = new ExecutionBudget(createExecutionBudgetState({ knownTokens: tokens }), async () => {});
  await budget.reserveRequiredWork("required", { tokens: 32_000, activeMs: 30_000, source: "test" });
  const events: Record<string, unknown>[] = [];
  const job: JobSpec = { id: "prepare", operation: "prepare", label: "prepare", cwd: root,
    tools: ["Read", "Write"], readRoots: [input], writeRoots: [output], resultPath: path.join(output, "job-result.json"),
    sessionKey: "prepare", prompt: promptAsset("init.compact.prepare"), delegation: "disabled", executionBudget: budget,
    assistance: { revision: "spec12-1", windowId: "prepare:1", requiredReservationId: "required" },
    onEvent: async (event) => { events.push(event); } };
  const request: AssistanceRequest = { schemaVersion: 2, purpose: "work", reason: "Two independent input questions need isolated context",
    evidence: [input], tasks: [ { task: "inspect first aspect", inputs: [input], tools: ["Read"] },
      { task: "inspect second aspect", inputs: [input], tools: ["Read"] } ] };
  return { root, input, output, job, budget, events, request };
}

async function complete(job: JobSpec, message = "done"): Promise<AgentJobResult> {
  const artifact = path.join(job.writeRoots[0]!, "report.txt");
  await writeFile(artifact, "report");
  await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [artifact], message }));
  return { status: "completed", artifacts: [artifact], sessionId: `${job.sessionKey}-session` };
}

function requestPath(job: JobSpec): string { return job.prompt.variables?.request_path as string; }

async function controlDirectory(root: string): Promise<string> {
  const directory = path.join(root, ".flywheel", "runtime", "agent-jobs");
  return path.join(directory, (await readdir(directory))[0]!);
}

test("bounded assistance is opt-in and a self-completed job has zero extra calls", async () => {
  const { job } = await fixture();
  let calls = 0;
  const result = await executeAgentJobTree(async current => { calls++; assert.equal(current.prompt.assetId, "common.assistance-capable"); return complete(current); }, job);
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  delete job.assistance;
  await executeAgentJobTree(async current => { assert.notEqual(current.prompt.assetId, "common.assistance-capable"); return complete(current); }, job);
});

test("one bounded batch uses private Child workspaces, disabled recursion, bounded summaries and same parent session", async () => {
  const { job, request, events, budget } = await fixture();
  const calls: JobSpec[] = [];
  await executeAgentJobTree(async current => {
    calls.push(current);
    if (calls.length === 1) {
      assert.deepEqual(current.writeRoots, [...job.writeRoots, requestPath(current)]);
      await writeFile(requestPath(current), JSON.stringify(request));
      return { status: "completed", artifacts: [] };
    }
    if (current.parentJobId) {
      assert.equal(current.delegation, "disabled");
      assert.equal(current.assistance, undefined);
      assert.ok(current.invocationReservation);
      assert.deepEqual(current.readRoots.filter(root => !root.includes("children")), [request.tasks[0]!.inputs![0]]);
      return complete(current, "x".repeat(2000));
    }
    assert.equal(current.sessionKey, job.sessionKey);
    assert.equal(current.prompt.assetId, "common.assistance-resume");
    const summaries = current.prompt.variables!.child_results as Array<{ message: string }>;
    assert.equal(summaries.length, 2);
    assert.ok(summaries.every(result => result.message.length === 1000));
    return complete(current);
  }, job);
  assert.equal(calls.length, 4);
  assert.notEqual(calls[1]!.writeRoots[0], calls[2]!.writeRoots[0]);
  assert.deepEqual(events.map(event => event.sdkEvent), ["assistance.admitted", "assistance.settled"]);
  assert.equal(Object.values(budget.state.assistance!.decisions).filter(entry => entry.admitted).length, 1);
  assert.equal(budget.state.repairUsed, false);
});

test("legal budget refusal resumes parent without consuming the global protocol repair", async () => {
  const { job, request, budget, events } = await fixture(200_000);
  let calls = 0;
  await executeAgentJobTree(async current => {
    calls++;
    if (calls === 1) { await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] }; }
    assert.equal(current.prompt.assetId, "common.assistance-resume");
    assert.equal(current.prompt.variables!.decision, "denied");
    return complete(current);
  }, job);
  assert.equal(calls, 2);
  assert.equal(budget.state.repairUsed, false);
  assert.deepEqual(events.map(event => event.sdkEvent), ["assistance.denied", "assistance.settled"]);
});

test("check protocol is finite and legacy requests cannot silently enable assistance", async () => {
  const { output, request } = await fixture();
  const file = path.join(output, "request.json");
  for (const value of [{ tasks: request.tasks }, { ...request, purpose: "check" }, { ...request, workspace: output },
    { ...request, reason: "x".repeat(1001) }, { ...request, evidence: [] }]) {
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(readAssistanceRequest(file));
  }
  await writeFile(file, JSON.stringify({ ...request, purpose: "check", tasks: request.tasks.slice(0, 1) }));
  assert.equal((await readAssistanceRequest(file)).purpose, "check");
});

test("unauthorized input fails closed without using repair or admitting a batch", async () => {
  const { root, output, job, request, budget } = await fixture();
  const privateFile = path.join(output, "holdout.txt");
  await writeFile(privateFile, "private");
  job.deniedPaths = [privateFile];
  request.tasks[0]!.inputs = [privateFile];
  await assert.rejects(executeAgentJobTree(async current => {
    await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] };
  }, job), AssistanceInvariantError);
  assert.equal(budget.state.repairUsed, false);
  assert.equal(Object.keys(budget.state.assistance!.decisions).length, 0);
  assert.ok(root);
});

test("physical symlink target cannot expose denied input", async t => {
  const { root, input, output, job, request } = await fixture();
  const hidden = path.join(output, "private.txt");
  const link = path.join(root, "link.txt");
  await writeFile(hidden, "private");
  try { await symlink(hidden, link, "file"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Windows file symlink privilege unavailable"); return; }
    throw error;
  }
  job.readRoots = [root]; job.deniedPaths = [hidden];
  request.evidence = [input]; request.tasks[0]!.inputs = [link];
  await assert.rejects(executeAgentJobTree(async current => {
    await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] };
  }, job), /Parent authority/);
});

test("changed input expires a report instead of starting a replacement batch", async () => {
  const { input, job, request } = await fixture();
  let childCalls = 0;
  await assert.rejects(executeAgentJobTree(async current => {
    if (!current.parentJobId) { await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] }; }
    childCalls++;
    const result = await complete(current);
    await writeFile(input, "changed");
    return result;
  }, job, undefined, { concurrency: 1 }), /inputs changed/);
  assert.equal(childCalls, 1);
});

test("crash with an uncertain running Child pauses and never blindly re-executes it", async () => {
  const { job, request } = await fixture();
  let childCalls = 0;
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    if (!current.parentJobId) { await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] }; }
    childCalls++; throw new Error("simulated crash");
  };
  await assert.rejects(executeAgentJobTree(execute, job, undefined, { concurrency: 1 }), /simulated crash/);
  await assert.rejects(executeAgentJobTree(execute, job), /终态无法核实/);
  assert.equal(childCalls, 1);
});

test("completed batch and parent result restore without fresh authority or additional model calls", async () => {
  const { root, job, request } = await fixture();
  let calls = 0;
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    calls++;
    if (calls === 1) { await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] }; }
    return complete(current);
  };
  await executeAgentJobTree(execute, job);
  await executeAgentJobTree(execute, job);
  assert.equal(calls, 4);
  const dir = path.join(root, ".flywheel", "runtime", "agent-jobs", (await readdir(path.join(root, ".flywheel", "runtime", "agent-jobs")))[0]!);
  const saved = JSON.parse(await readFile(path.join(dir, "assistance.json"), "utf8"));
  assert.equal(saved.state, "finished");
});

test("Parent protocol exceptions never reopen a denied Runtime subtree", async () => {
  const { root, job } = await fixture();
  const runtime = path.join(root, ".flywheel", "runtime");
  await mkdir(runtime, { recursive: true });
  const hidden = path.join(runtime, "secret.txt");
  await writeFile(hidden, "private");
  job.readRoots = [root]; job.deniedPaths = [runtime];
  await executeAgentJobTree(async current => {
    const contains = (candidate: string, allowed: string) => {
      const relative = path.relative(allowed, candidate);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    assert.equal(current.readRoots.some(allowed => contains(hidden, allowed)), false);
    assert.equal(current.writeRoots.some(allowed => contains(path.join(runtime, "execution-budget.json"), allowed)), false);
    assert.ok(current.writeRoots.includes(requestPath(current)));
    return complete(current);
  }, job);
});

test("preparation and optimizer preserve new-file creation while protecting Runtime and candidate controls", async () => {
  for (const role of ["preparation", "optimizer"]) {
    const { root, job } = await fixture();
    const workspace = role === "preparation" ? path.join(root, ".flywheel", "contract") : path.join(root, "worktree");
    await mkdir(workspace, { recursive: true });
    job.writeRoots = [workspace];
    job.resultPath = path.join(workspace, "job-result.json");
    job.readRoots = role === "preparation" ? [root] : [workspace];
    job.deniedPaths = role === "preparation" ? [path.join(root, ".flywheel", "runtime")]
      : [path.join(workspace, ".git"), path.join(workspace, ".flywheel")];
    await executeAgentJobTree(async current => {
      validateJobSpec(current);
      assert.ok(current.writeRoots.includes(workspace), `${role} must retain its broad authorized write root`);
      if (role === "optimizer") assert.deepEqual(current.deniedPaths, job.deniedPaths);
      const newFile = path.join(workspace, "new-root-module.ts");
      await writeFile(newFile, "export const value = 1;\n");
      assert.equal(await readFile(newFile, "utf8"), "export const value = 1;\n");
      return complete(current);
    }, job);
  }
});

test("finished Child reports restore after a crash before parent continuation without rerunning either Child", async () => {
  const { job, request } = await fixture();
  let childCalls = 0;
  let crash = true;
  let parentCalls = 0;
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    if (current.parentJobId) { childCalls++; return complete(current); }
    parentCalls++;
    if (current.prompt.assetId === "common.assistance-capable") {
      await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] };
    }
    return complete(current);
  };
  await assert.rejects(executeAgentJobTree(execute, job, undefined, { concurrency: 1,
    onJobCompleted: async current => { if (current.parentJobId && childCalls === 2 && crash) { crash = false; throw new Error("after result crash"); } } }), /after result crash/);
  await executeAgentJobTree(execute, job);
  assert.equal(childCalls, 2);
  assert.equal(parentCalls, 2);
});

test("a changed admitted request cannot borrow the persisted authorization", async () => {
  const { root, job, request } = await fixture();
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    if (current.parentJobId) throw new Error("crash");
    await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] };
  };
  await assert.rejects(executeAgentJobTree(execute, job, undefined, { concurrency: 1 }), /crash/);
  await writeFile(path.join(await controlDirectory(root), "request.json"), JSON.stringify({ ...request, reason: "renamed request" }));
  await assert.rejects(executeAgentJobTree(execute, job), /request changed after admission/);
});

test("cancellation terminates the authorization and releases only unused confirmed capacity", async () => {
  const { job, request, budget, events } = await fixture();
  const controller = new AbortController();
  let childCalls = 0;
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    if (current.parentJobId) { childCalls++; const result = await complete(current); controller.abort(); return result; }
    await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] };
  };
  const result = await executeAgentJobTree(execute, job, controller.signal, { concurrency: 1 });
  assert.equal(result.status, "aborted");
  assert.equal(childCalls, 1);
  const restored = await executeAgentJobTree(execute, job);
  assert.equal(restored.status, "aborted");
  assert.equal(childCalls, 1);
  const admission = Object.values(budget.state.assistance!.decisions).find(value => value.admitted)!;
  assert.equal(budget.state.reservations![admission.reservationId!]!.closed, true);
  assert.equal(events.at(-1)!.sdkEvent, "assistance.settled");
});

test("expired authorization cannot obtain a fresh timeout through restart", async () => {
  const { job, request } = await fixture();
  const execute = async (current: JobSpec): Promise<AgentJobResult> => {
    if (current.parentJobId) throw new Error("crash");
    await writeFile(requestPath(current), JSON.stringify(request)); return { status: "completed", artifacts: [] };
  };
  await assert.rejects(executeAgentJobTree(execute, job, undefined, { concurrency: 1 }), /crash/);
  const previousNow = Date.now;
  Date.now = () => previousNow() + 120_001;
  try { await assert.rejects(executeAgentJobTree(execute, job), /授权时间已到期/); }
  finally { Date.now = previousNow; }
});

test("real AgentService seam meters every child and parent continuation once with the admitted frozen slot estimate", async () => {
  const { root, job, request, budget } = await fixture();
  // Use a real prompt/adapter/service boundary while keeping model output deterministic.
  job.prompt = promptAsset("common.user-intervention", { job_prompt: "prepare", message: "confirmed scope" });
  const sessions: Record<string, string> = {};
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let calls = 0;
  const resumes: Array<string | undefined> = [];
  const agent = new DefaultAgentService({ provider: "mock", model: "metered", async run(current) {
    calls++; resumes.push(current.resumeSessionId);
    if (calls === 1) {
      const matched = current.writeRoots.find(file => file.endsWith("request.json"))!;
      await writeFile(matched, JSON.stringify(request));
    } else {
      await complete({ ...current, prompt: job.prompt });
    }
    // 25k < frozen 32k, but the next observed estimate becomes 37.5k.
    // The remainder must keep using the 32k slots reserved at admission.
    return { success: true, sessionId: current.parentJobId ? `child-${calls}` : "parent",
      usage: { inputTokens: current.parentJobId ? 24_000 : 900, outputTokens: current.parentJobId ? 1_000 : 100 } };
  } }, new PromptAssetStore());
  const context = { capabilityId: "init", operationId: "prepare", status: "running", sessions,
    checkpoint: async () => {}, emit: async (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => { events.push({ type, data }); } };
  await executePersistentAgentJob(agent, job, context);
  await executePersistentAgentJob(agent, job, context);
  assert.equal(calls, 4);
  assert.deepEqual(resumes, [undefined, undefined, undefined, "parent"]);
  assert.equal(budget.state.knownTokens, 52_000);
  const optional = Object.values(budget.state.invocations).filter(entry => entry.reservationId);
  assert.equal(optional.length, 3);
  assert.ok(optional.every(entry => entry.estimatedTokens === 32_000));
  assert.ok(optional.every(entry => entry.estimatedActiveMs === 30_000), "batch authority must not inflate the per-call prediction");
  assert.equal(budget.state.reservations!.required!.tokensRemaining, 32_000);
  assert.equal(events.filter(entry => entry.type === "job.event" && entry.data.sdkEvent === "assistance.admitted").length, 1);
  assert.equal(events.filter(entry => entry.type === "job.event" && entry.data.sdkEvent === "assistance.settled").length, 1);
  assert.ok(root);
});

for (const scenario of [
  { name: "70s child leaves time for 20s parent", childMs: 70_000, parentMs: 20_000, unknown: false, timeout: false },
  { name: "120s child settles without starting parent", childMs: 120_000, parentMs: 0, unknown: false, timeout: true },
  { name: "child and parent share the 120s ceiling", childMs: 70_000, parentMs: 50_000, unknown: false, timeout: true },
  { name: "unknown timeout retains occupancy and never reruns child", childMs: 120_000, parentMs: 0, unknown: true, timeout: true },
]) {
  test(`real service timeout accounting: ${scenario.name}`, async () => {
    const { root, job, request, budget: initial } = await fixture();
    let now = 0;
    const budget = new ExecutionBudget(initial.state, async () => {}, () => now);
    job.executionBudget = budget;
    request.tasks = request.tasks.slice(0, 1);
    request.purpose = "check";
    job.prompt = promptAsset("common.user-intervention", { job_prompt: "prepare", message: "confirmed scope" });
    let calls = 0;
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const agent = new DefaultAgentService({ provider: "mock", model: "timed", async run(current) {
      calls++;
      if (calls === 1) await writeFile(current.writeRoots.find(file => file.endsWith("request.json"))!, JSON.stringify(request));
      else {
        if (current.parentJobId) {
          assert.match(current.prompt, /最多 120 秒/);
          assert.match(current.prompt, /以本批实际授权和剩余时间为准/);
        }
        now += current.parentJobId ? scenario.childMs : scenario.parentMs;
        await complete({ ...current, prompt: job.prompt });
      }
      return { success: true, usage: scenario.unknown && current.parentJobId ? null : { inputTokens: 1000, outputTokens: 100 } };
    } }, new PromptAssetStore());
    const context = { capabilityId: "init", operationId: "prepare", status: "running", sessions: {} as Record<string, string>,
      checkpoint: async () => {}, emit: async (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => { events.push({ type, data }); } };
    if (scenario.timeout) await assert.rejects(executePersistentAgentJob(agent, job, context), scenario.unknown ? /time/ : /本批协作超过授权时限/);
    else assert.equal((await executePersistentAgentJob(agent, job, context)).status, "completed");
    assert.equal(calls, scenario.childMs === 120_000 ? 2 : 3);
    const saved = JSON.parse(await readFile(path.join(await controlDirectory(root), "assistance.json"), "utf8"));
    const reservation = budget.state.reservations![saved.reservationId]!;
    assert.equal(saved.invocationEstimate.activeMs, 30_000);
    assert.equal(reservation.authorizedActiveMs, 120_000);
    assert.equal(budget.state.reservations!.required.activeMsRemaining, 30_000);
    if (scenario.unknown) {
      assert.equal(saved.state, "children");
      assert.equal(saved.children[0].state, "running");
      assert.equal(reservation.closed, undefined);
      assert.equal(reservation.tokensRemaining, 32_000);
      assert.equal(budget.state.unknownUsageInvocations, 1);
      // Even if the interrupted transport wrote output, unknown usage and the
      // exhausted authorization cannot justify another optional call.
      await assert.rejects(executePersistentAgentJob(agent, job, context), /time|tokens|终态无法核实/);
    } else {
      assert.equal(saved.state, "finished");
      assert.equal(saved.children[0].state, "finished");
      assert.equal(saved.children[0].result.status, scenario.childMs === 120_000 ? "aborted" : "completed");
      assert.equal(reservation.closed, true);
      assert.equal(reservation.tokensRemaining, 0);
      assert.equal(budget.state.unknownUsageInvocations, 0);
      assert.equal(events.filter(e => e.data.sdkEvent === "assistance.settled").length, 1);
      assert.equal((await executePersistentAgentJob(agent, job, context)).status, scenario.timeout ? "aborted" : "completed");
    }
    assert.equal(calls, scenario.childMs === 120_000 ? 2 : 3, "restore never starts a replacement invocation");
  });
}

for (const phase of ["child", "parent"] as const) for (const unknown of [false, true]) {
  test(`wall-only ${phase} timeout with ${unknown ? "unknown" : "known"} usage preserves truthful settlement`, async () => {
    const { root, job, request, budget } = await fixture();
    request.tasks = request.tasks.slice(0, 1);
    // Seed a recovery fixture with no real invocation. Its persisted wall
    // deadline is shorter than its unchanged 120s active-time authorization.
    await assert.rejects(executeAgentJobTree(async current => {
      if (current.parentJobId) throw new Error("seed stopped before transport");
      await writeFile(requestPath(current), JSON.stringify(request));
      return { status: "completed", artifacts: [] };
    }, job), /seed stopped/);
    const file = path.join(await controlDirectory(root), "assistance.json");
    const seeded = JSON.parse(await readFile(file, "utf8"));
    seeded.children[0].state = "pending";
    seeded.deadline = Date.now() + 400;
    await writeFile(file, JSON.stringify(seeded));
    let calls = 0;
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const agent = new DefaultAgentService({ provider: "mock", model: "wall-only", async run(current, signal) {
      calls++;
      const expires = phase === "child" ? !!current.parentJobId : !current.parentJobId;
      if (expires) {
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { success: false, aborted: true, usage: unknown ? null : { inputTokens: 1000, outputTokens: 100 } };
      }
      await complete({ ...current, prompt: job.prompt });
      return { success: true, usage: { inputTokens: 1000, outputTokens: 100 } };
    } }, new PromptAssetStore());
    const context = { capabilityId: "init", operationId: "prepare", status: "running", sessions: {} as Record<string, string>,
      checkpoint: async () => {}, emit: async (type: "job.started" | "job.event" | "job.completed", data: Record<string, unknown>) => { events.push({ type, data }); } };
    // AbortSignal.timeout is unref'ed, so keep the fake transport alive exactly
    // as a real provider socket would, without sleeping for the production cap.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(executePersistentAgentJob(agent, job, context), unknown ? /终态用量无法核实/ : /本批协作超过授权时限/);
    } finally { clearInterval(keepAlive); }
    assert.equal(calls, phase === "child" ? 1 : 2);
    assert.ok(budget.remainingActiveMs(seeded.reservationId) > 100_000, "only the persisted wall deadline expired");
    const saved = JSON.parse(await readFile(file, "utf8"));
    const reservation = budget.state.reservations![saved.reservationId]!;
    if (unknown) {
      assert.equal(saved.state, phase === "child" ? "children" : "continuation_running");
      if (phase === "child") assert.equal(saved.children[0].state, "running");
      assert.equal(reservation.closed, undefined);
      assert.equal(budget.state.unknownUsageInvocations, 1);
      assert.equal(events.some(e => e.data.sdkEvent === "assistance.settled"), false);
      await assert.rejects(executePersistentAgentJob(agent, job, context), /授权时间已到期|终态无法核实/);
    } else {
      assert.equal(saved.state, "finished");
      assert.equal(saved.finalResult.status, "aborted");
      assert.match(saved.finalResult.message, /本批协作超过授权时限/);
      assert.equal(reservation.closed, true);
      assert.equal(events.filter(e => e.data.sdkEvent === "assistance.settled").length, 1);
      assert.equal((await executePersistentAgentJob(agent, job, context)).status, "aborted");
    }
    assert.equal(calls, phase === "child" ? 1 : 2);
  });
}
