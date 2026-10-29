import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { CodexAgentAdapter } from "../../src/services/agent/codex-adapter.ts";
import type { AgentJob } from "../../src/services/agent/protocol.ts";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";

const job: AgentJob = { operation: "test", label: "stream", cwd: process.cwd(), prompt: "reply", promptAssets: [],
  tools: ["Read"], readRoots: [process.cwd()], writeRoots: [], deniedPaths: [] };

// A real subprocess exercises JSONL framing, ordering, server requests and EOF cleanup.
function fakeServer(mode: "complete" | "abort" | "fail" | "stubborn" | "flood" | "flood-abort" = "complete", expectedEffort = "medium", expectedModel?: string) {
  const code = `
    import { createInterface } from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const notify = (method,params) => send({method,params});
    const rl=createInterface({input:process.stdin});
    rl.on('close',()=>${JSON.stringify(mode)}==='stubborn'?setInterval(()=>{},1000):process.exit(0));
    rl.on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') send({id:m.id,result:{}});
      if(m.method==='thread/resume'||m.method==='thread/start') {
        if(m.params.approvalPolicy!=='never'||m.params.sandbox!=='workspace-write') process.exit(8);
        send({id:m.id,result:{thread:{id:'thread-test'}}});
        notify('thread/tokenUsage/updated',{threadId:'thread-test',turnId:'old-turn',tokenUsage:{
          total:{inputTokens:100,cachedInputTokens:3,outputTokens:10,reasoningOutputTokens:1},
          last:{inputTokens:100,cachedInputTokens:3,outputTokens:10,reasoningOutputTokens:1}}});
      }
      if(m.method==='turn/start') {
        if(m.params.effort!==${JSON.stringify(expectedEffort)}) process.exit(10);
        if(${JSON.stringify(expectedModel)} && m.params.model!==${JSON.stringify(expectedModel)}) process.exit(11);
        if(m.params.sandboxPolicy.networkAccess!==false||m.params.sandboxPolicy.writableRoots.length!==0) process.exit(9);
        notify('turn/started',{threadId:'thread-test',turn:{id:'old-turn'}});
        notify('turn/completed',{threadId:'thread-test',turn:{id:'old-turn',status:'failed',error:{message:'must ignore old turn'}}});
        send({id:m.id,result:{turn:{id:'turn-test'}}});
        notify('turn/started',{threadId:'thread-test',turn:{id:'turn-test'}});
        notify('thread/tokenUsage/updated',{threadId:'thread-test',turnId:'turn-test',tokenUsage:{
          total:{inputTokens:110,cachedInputTokens:4,outputTokens:11,reasoningOutputTokens:2,cacheWriteInputTokens:4},
          last:{inputTokens:10,cachedInputTokens:1,outputTokens:1,reasoningOutputTokens:1}}});
        send({id:900,method:'item/commandExecution/requestApproval',params:{}});
        if(${JSON.stringify(mode)}.startsWith('flood')) {
          for(let n=0;n<10000;n++) notify('item/commandExecution/outputDelta',{threadId:'thread-test',turnId:'turn-test',itemId:'tool-flood',delta:'x'});
          if(${JSON.stringify(mode)}==='flood') notify('item/completed',{threadId:'thread-test',item:{id:'tool-flood',type:'commandExecution',command:'fixture',status:'completed',aggregatedOutput:'x'.repeat(10000),exitCode:0}});
        }
        notify('item/started',{threadId:'thread-test',item:{id:'message-1',type:'agentMessage',text:''}});
        notify('item/agentMessage/delta',{threadId:'thread-test',itemId:'message-1',delta:'hello'});
        notify('item/agentMessage/delta',{threadId:'thread-test',itemId:'message-1',delta:' world'});
        if(['abort','flood-abort'].includes(${JSON.stringify(mode)})) return;
        if(${JSON.stringify(mode)}==='fail') {
          notify('turn/completed',{turn:{id:'turn-test',status:'failed',error:{message:'provider failed'}}}); return;
        }
        for(const [total,last] of [[110,10],[130,20]]) notify('thread/tokenUsage/updated',{
          threadId:'thread-test',turnId:'turn-test',tokenUsage:{
            total:{inputTokens:total,cachedInputTokens:4,outputTokens:total/10,reasoningOutputTokens:2},
            last:{inputTokens:last,cachedInputTokens:1,outputTokens:last/10,reasoningOutputTokens:1}}});
        notify('item/completed',{threadId:'thread-test',item:{id:'message-1',type:'agentMessage',text:'hello world'}});
        // Completion waits for the client to reject the server approval request.
      }
      if(m.id===900 && m.error) notify('turn/completed',{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}});
      if(m.method==='turn/interrupt') {
        send({id:m.id,result:{}});
        notify('turn/completed',{turn:{id:'turn-test',status:'interrupted'}});
      }
    });`;
  let child: ReturnType<typeof spawn>;
  const received: unknown[][] = [];
  return { received,
    get child() { return child; },
    launch: (executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
      received.push([executable, args, cwd, env.CODEX_HOME]);
      child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      return child as import("node:child_process").ChildProcessWithoutNullStreams;
    },
  };
}

test("Codex app-server forwards genuine cumulative deltas before result and only this invocation's usage", async () => {
  const server = fakeServer();
  const events: Record<string, any>[] = [];
  let finished = false;
  const adapter = new CodexAgentAdapter({ codexPath: "selected-codex", codexHome: "not-a-real-codex-home", appServerLauncher: server.launch });
  const result = await adapter.run({ ...job, resumeSessionId: "thread-test", onEvent: (event) => {
    events.push(event);
    if (event.sdkEvent === "item.updated") assert.equal(finished, false);
  } });
  finished = true;
  assert.equal(result.success, true);
  assert.equal(result.sessionId, "thread-test");
  assert.equal(result.summary, "hello world");
  const updates = events.filter(event => event.sdkEvent === "item.updated");
  assert.deepEqual(updates.map(event => [event.item.id, event.item.text, event.streamMode]), [
    ["message-1", "hello", "cumulative"], ["message-1", "hello world", "cumulative"],
  ]);
  assert.ok(updates[1].seq > updates[0].seq);
  assert.ok(events.some(event => event.sdkEvent === "codex.request.rejected"));
  assert.equal(events.filter(event => event.sdkEvent === "item.completed").length, 1);
  assert.deepEqual(result.usage, { inputTokens: 30, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 1 });
  assert.equal(server.received[0][0], "selected-codex");
  assert.equal(server.received[0][3], path.resolve("not-a-real-codex-home"));
  assert.notEqual(server.child.exitCode, null);
});

test("Codex app-server sends the same bounded assistance profile on Child and resumed parent turns", async () => {
  for (const kind of ["child", "parent", "explicit-medium"]) {
    const budget = new ExecutionBudget(createExecutionBudgetState(), async () => {});
    await budget.reserveRequiredWork("verification", { tokens: 1000, activeMs: 1000, source: "test" });
    const admitted = await budget.admitAssistance({ requestId: "batch", windowId: "prepare", binding: "test", childCount: 1, requiredReservationId: "verification" });
    const expected = kind === "explicit-medium" ? "medium" : "low";
    const server = fakeServer("complete", expected, "same-model");
    const events: Record<string, unknown>[] = [];
    const adapter = new CodexAgentAdapter({ model: "same-model", appServerLauncher: server.launch,
      ...(kind === "explicit-medium" ? { modelReasoningEffort: "medium" as const } : {}) });
    const result = await adapter.run({ ...job, executionBudget: budget,
      invocationReservation: { reservationId: admitted.reservationId!, estimateClass: "assistance" },
      ...(kind === "child" ? { parentJobId: "parent", depth: 1 } : { resumeSessionId: "thread-test" }),
      onEvent: event => { events.push(event); } });
    assert.equal(result.success, true, result.error);
    assert.deepEqual(events.find(event => event.sdkEvent === "codex.execution-profile"), {
      sdkEvent: "codex.execution-profile", model: "same-model", requestedReasoningEffort: "medium",
      effectiveReasoningEffort: expected, boundedAssistance: true, transport: "app-server",
      source: kind === "explicit-medium" ? "explicit" : "assistance-default", reservationId: admitted.reservationId,
    });
  }
});

test("Codex app-server coalesces a tool output flood without batching real agent replies or losing bytes", async () => {
  const events: Record<string, any>[] = [];
  const result = await new CodexAgentAdapter({ appServerLauncher: fakeServer("flood").launch })
    .run({ ...job, onEvent: event => { events.push(event); } });
  assert.equal(result.success, true);
  const batches = events.filter(e => e.sdkEvent === "item/commandExecution/outputDelta");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].delta, "x".repeat(10000));
  assert.equal(batches[0].coalescedDeltas, 10000);
  assert.ok(Date.parse(batches[0].firstReceivedAt) <= Date.parse(batches[0].lastReceivedAt));
  assert.ok(batches[0].seq < events.find(e => e.sdkEvent === "item.completed" && e.item.id === "tool-flood")!.seq);
  assert.deepEqual(events.filter(e => e.sdkEvent === "item.updated").map(e => e.item.text), ["hello", "hello world"]);
  const controller = new AbortController();
  const partial: Record<string, any>[] = [];
  const aborted = await new CodexAgentAdapter({ appServerLauncher: fakeServer("flood-abort").launch })
    .run({ ...job, onEvent: event => { partial.push(event); if (event.sdkEvent === "item.updated") controller.abort(); } }, controller.signal);
  assert.equal(aborted.aborted, true);
  assert.equal(partial.filter(e => e.sdkEvent === "item/commandExecution/outputDelta").map(e => e.delta).join(""), "x".repeat(10000), "abort must flush partial tool evidence too");
});

test("Codex app-server interrupts active turn, returns partial reply and closes subprocess on abort", async () => {
  const server = fakeServer("abort");
  const controller = new AbortController();
  const adapter = new CodexAgentAdapter({ appServerLauncher: server.launch });
  const result = await adapter.run({ ...job, onEvent: (event) => {
    if (event.sdkEvent === "item.updated") controller.abort();
  } }, controller.signal);
  assert.equal(result.success, false);
  assert.equal(result.aborted, true);
  assert.match(result.error ?? "", /interrupted/);
  assert.equal(result.usage?.inputTokens, 10);
  assert.ok(server.child.exitCode !== null || server.child.signalCode !== null);
});

test("Codex app-server never reports failed provider turn as successful", async () => {
  const server = fakeServer("fail");
  const result = await new CodexAgentAdapter({ appServerLauncher: server.launch }).run(job);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /provider failed/);
  assert.equal(result.usage?.inputTokens, 10);
  assert.equal(result.usage?.cacheWriteInputTokens, undefined);
});

test("Codex app-server observes asynchronous event sink rejection and retains received usage", async () => {
  const server = fakeServer("abort");
  const result = await new CodexAgentAdapter({ appServerLauncher: server.launch }).run({ ...job, onEvent: async (event) => {
    if (event.sdkEvent === "item.updated") throw new Error("audit sink failed");
  } });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /audit sink failed/);
  assert.equal(result.usage?.inputTokens, 10);
  assert.ok(server.child.exitCode !== null || server.child.signalCode !== null);
});

test("Codex app-server force closes a subprocess that ignores stdin EOF", async () => {
  const server = fakeServer("stubborn");
  const result = await new CodexAgentAdapter({ appServerLauncher: server.launch }).run(job);
  assert.equal(result.success, true);
  assert.ok(server.child.exitCode !== null || server.child.signalCode !== null);
});

test("Codex app-server returns launch/early exit failure without waiting for a protocol reply", async () => {
  const result = await new CodexAgentAdapter({ appServerLauncher: () => spawn(process.execPath, ["-e", "process.exit(7)"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }) }).run(job);
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /exited \(7\)/);
});
