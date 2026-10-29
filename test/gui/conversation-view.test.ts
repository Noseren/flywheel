import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("main conversation shows bounded assistance decisions without exposing worker evidence", async () => {
  const c = await context();
  vm.runInContext(`ui.entries = new Map([
    ["start", {id:"start",kind:"event",jobId:"optimizer",sdkEvent:"assistance.admitted",title:"开始并行处理两个独立问题。",ordinal:1}],
    ["worker", {id:"worker",kind:"event",jobId:"child",title:"internal worker evidence",raw:{type:"job.event"},ordinal:2}],
    ["denied", {id:"denied",kind:"event",jobId:"optimizer",sdkEvent:"assistance.denied",title:"本轮由当前 Agent 完成。",ordinal:3}],
    ["done", {id:"done",kind:"event",jobId:"optimizer",sdkEvent:"assistance.settled",title:"协作结束，等待完整评价。",ordinal:4}]
  ]);`, c);
  assert.equal(vm.runInContext('mainEntries().map(e=>e.id).join(",")', c), "start,denied,done");
});
test("main conversation exposes the actual clarification and keeps ordinary operation details hidden", async () => {
  const c = await context();
  vm.runInContext(`ui.entries = new Map([
    ["detail", {id:"detail",kind:"event",title:"internal detail",raw:{type:"operation.activity",data:{message:"private detail"}}}],
    ["question", {id:"question",kind:"event",title:"需要你确认：金额溢出应拒绝还是截断？",raw:{type:"operation.activity",data:{needsInput:true,message:"金额溢出应拒绝还是截断？"}}}]
  ]);`, c);
  assert.equal(vm.runInContext('mainEntries().map(e=>e.id).join(",")', c), "question");
  assert.match(vm.runInContext('mainEntries()[0].title', c), /金额溢出应拒绝还是截断/);
});

test("tree hides future business steps but retains queued child agents", async () => {
  const c = await context();
  vm.runInContext('ui.nodes=new Map([["c",{id:"c",kind:"capability",status:"idle"}],["past",{id:"past",parentId:"c",kind:"operation",status:"completed"}],["future",{id:"future",parentId:"c",kind:"operation",status:"idle"}],["a",{id:"a",parentId:"past",kind:"agent",status:"idle"}]]);',c);
  assert.equal(vm.runInContext('visibleTreeNodes().some(n=>n.id==="future")',c),false);
  assert.equal(vm.runInContext('visibleTreeNodes().some(n=>n.id==="a")',c),true);
});
test("worker links resolve stable identity, never a matching display name", async () => {
  const c = await context();
  vm.runInContext('ui.nodes.set("a",{id:"a",kind:"agent",label:"same",metadata:{jobId:"j"}});',c);
  assert.equal(vm.runInContext('actorNode({jobId:"j"}).id',c),"a");
  assert.equal(vm.runInContext('actorNode({actor:"same"})',c),null);
});
test("node status distinguishes running, paused and stale", async () => {
  const c = await context();
  vm.runInContext('ui.connected=true;ui.state={snapshot:{status:"running"}};',c);
  assert.equal(vm.runInContext('nodePhase({id:"a",status:"running"})',c),"running");
  vm.runInContext('ui.state.snapshot.status="idle";',c);
  assert.equal(vm.runInContext('nodePhase({id:"a",status:"running"})',c),"paused");
  vm.runInContext('ui.connected=false;',c);
  assert.equal(vm.runInContext('nodePhase({id:"a",status:"running"})',c),"unknown");
  assert.equal(vm.runInContext('nodePhase({id:"a",status:"failed"})',c),"failed");
  assert.equal(vm.runInContext('presentation({officialTitle:"正式评价"})',c),"result");
  vm.runInContext('ui.state.snapshot.status="stopped";',c);
  assert.equal(vm.runInContext('nodePhase({id:"a",status:"running"})',c),"stopped");
  assert.equal(vm.runInContext('effectiveStatus({id:"a",status:"running"})',c),"已结束");
});
test("execution flow reaches completed and running descendants while paused", async () => {
  const c = await context();
  vm.runInContext('ui.nodes=new Map([["c",{id:"c",kind:"capability",status:"idle"}],["op",{id:"op",parentId:"c",kind:"operation",status:"completed"}],["done",{id:"done",parentId:"op",kind:"agent",status:"completed",metadata:{jobId:"done"}}],["live",{id:"live",parentId:"done",kind:"agent",status:"running",metadata:{jobId:"live"}}]]);',c);
  assert.equal(vm.runInContext('executionPathSets([...ui.nodes.values()]).travelled.has("live")',c),true);
  assert.equal(vm.runInContext('executionPathSets([...ui.nodes.values()]).travelled.has("done")',c),true);
  assert.equal(vm.runInContext('executionPathSets([...ui.nodes.values()]).flowing.has("op")',c),true);
});

async function context() {
  const source = await readFile(new URL("../../system-assets/gui/app.js", import.meta.url), "utf8");
  const c = vm.createContext({ URLSearchParams, location: { search: "" }, setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => 1 });
  vm.runInContext(source.replace(/connect\(\);\s*$/, ""), c);
  return c;
}
test("dispatch audit keeps actual envelopes while main conversation hides worker dispatches", async () => {
  const c = await context();
  const events = [
    { id: "start", ordinal: 1, capabilityId: "run", jobId: "parent", raw: { type: "job.started" } },
    { id: "send1", ordinal: 2, capabilityId: "run", jobId: "parent", sdkEvent: "job.started", raw: { type: "job.event", data: { prompt: "  exact first\n" } } },
    { id: "child", ordinal: 3, capabilityId: "run", jobId: "child", parentJobId: "parent", sdkEvent: "job.started", raw: { type: "job.event", data: { prompt: "child task" } } },
    { id: "retry", ordinal: 4, capabilityId: "run", jobId: "parent", sdkEvent: "job.started", detailId: "retry", raw: { type: "job.event" } },
  ];
  c.events = events;
  vm.runInContext("mergeEntries(events);mergeEntries(events.slice().reverse());", c);
  assert.equal(vm.runInContext("mainEntries().length", c), 0);
  assert.equal(vm.runInContext("presentation(orderedEntries()[0])", c), "milestone");
  assert.equal(vm.runInContext('orderedEntries().filter(e=>presentation(e)==="task").length', c), 3);
  assert.equal(vm.runInContext("taskText(orderedEntries()[1])", c), "  exact first\n");
  assert.equal(vm.runInContext("taskText(orderedEntries()[2])", c), "child task");
  assert.equal(vm.runInContext("orderedEntries()[3].detailId", c), "retry");
  assert.equal(vm.runInContext('isDispatch({raw:{type:"job.event",data:{sdkEvent:"job.started",prompt:"legacy"}}})', c), true);
  assert.equal(vm.runInContext('taskText({body:"metadata, not the prompt",raw:{data:{prompt:"actual"}}})', c), "actual");
});
test("main conversation excludes worker messages and retains distinct questions", async () => {
  const c = await context();
  vm.runInContext('ui.state={snapshot:{status:"idle",pendingInteraction:{id:"q",question:"是否继续",description:"说明"}}};mergeEntries([{id:"worker",title:"Agent reply",kind:"message",jobId:"j"},{id:"manager",title:"Manager reply",kind:"message",body:"进度"}]);', c);
  assert.equal(vm.runInContext('mainEntries().length', c), 2);
  assert.equal(vm.runInContext('mainEntries()[1].body', c), "是否继续\n\n说明");
  assert.equal(vm.runInContext('mainEntries()[1].timestamp', c), undefined);
  vm.runInContext('mergeEntries([{id:"question",interactionId:"q",kind:"message",title:"需要用户输入"}]);', c);
  assert.equal(vm.runInContext('mainEntries().length', c), 2);
  vm.runInContext('ui.entries.delete("question");ui.state.pendingInteractionAnswered=true;', c);
  assert.equal(vm.runInContext('mainEntries().length', c), 1);
});
test("stale HTTP responses cannot regress live nodes or revision", async () => {
  const c = await context();
  vm.runInContext('ingest({revision:5,snapshot:{sessionId:"s"},nodes:[{id:"a",status:"completed"}]},true);ingest({revision:4,snapshot:{sessionId:"s"},nodes:[{id:"a",status:"running"}]},true);', c);
  assert.equal(vm.runInContext('ui.nodes.get("a").status', c), "completed");
  assert.equal(vm.runInContext('ui.state.revision', c), 5);
});
test("reconnect preserves selected history but labels unrefreshed nodes as uncertain", async () => {
  const c = await context();
  vm.runInContext('ingest({revision:1,snapshot:{sessionId:"s"},nodes:[{id:"a",status:"running"}]},true);ui.selected="a";ingest({revision:2,snapshot:{sessionId:"s"},nodes:[{id:"b"}]},true);', c);
  assert.equal(vm.runInContext('ui.selected', c), "a");
  assert.equal(vm.runInContext('effectiveStatus(ui.nodes.get("a"))', c), "待刷新");
});
test("streaming activity merges and older pages cannot replace latest command output", async () => {
  const c = await context();
  vm.runInContext('mergeEntries([{id:"1",streamKey:"x",ordinal:1},{id:"2",streamKey:"x",ordinal:2,body:"done"},{id:"1",streamKey:"x",ordinal:1}]);', c);
  assert.equal(vm.runInContext('ui.entries.size', c), 1);
  assert.equal(vm.runInContext('orderedEntries()[0].body', c), "done");
});
test("worker scope includes previous jobs in same persistent session, excludes unrelated jobs", async () => {
  const c = await context();
  vm.runInContext('mergeEntries([{id:"a",jobId:"old",raw:{data:{sessionId:"session"}}},{id:"b",jobId:"old",body:"older output"},{id:"c",jobId:"new"},{id:"d",jobId:"other"}]);', c);
  assert.equal(vm.runInContext('scopeEntries({metadata:{jobId:"new",sessionId:"session"}}).length', c), 3);
});
test("command output preserves full output and exit code; activity and messages remain distinct", async () => {
  const c = await context();
  assert.equal(vm.runInContext('activityText({raw:{data:{item:{type:"command_execution",command:"npm test",aggregated_output:"complete",exit_code:1}}}})', c), "npm test\n\ncomplete\n\n退出码: 1");
  assert.equal(vm.runInContext('presentation({kind:"event",category:"tool"})', c), "activity");
  assert.equal(vm.runInContext('presentation({kind:"message",title:"Agent reply"})', c), "message");
  assert.equal(vm.runInContext('presentation({raw:{type:"job.started",data:{prompt:"goal"}}})', c), "task");
});
test("offline never sends commands and preserves draft while expired token prevents retries", async () => {
  const c = await context();
  vm.runInContext('const elements=new Map();document={getElementById:id=>{if(!elements.has(id))elements.set(id,{value:"draft"});return elements.get(id)}};renderControls=()=>{};renderTree=()=>{};let timers=0;setTimeout=()=>{timers++;};ui.state={snapshot:{status:"idle"}};offline({status:403});', c);
  assert.equal(vm.runInContext('timers', c), 0);
  assert.equal(vm.runInContext('$("message").value', c), "draft");
  assert.equal(vm.runInContext('ui.connected', c), false);
  vm.runInContext('ui.state={snapshot:{status:"stopped"}};offline();', c);
  assert.equal(vm.runInContext('timers', c), 0);
  assert.equal(vm.runInContext('$("connection").textContent', c), "服务已关闭");
  assert.match(vm.runInContext('$("connection-note").textContent', c), /运行已结束/);
});
test("sending preserves newer draft and binds original question", async () => {
  const c = await context();
  vm.runInContext('const elements=new Map();document={getElementById:id=>{if(!elements.has(id))elements.set(id,{value:"original"});return elements.get(id)}};renderControls=()=>{};ui.connected=true;ui.state={snapshot:{status:"idle",pendingInteraction:{id:"q"}}};let sent;command=async(...args)=>{sent=args;$("message").value="new draft";};', c);
  await vm.runInContext('submitMessage()', c);
  assert.equal(vm.runInContext('sent[0]', c), "message");
  assert.equal(vm.runInContext('sent[2]', c), "q");
  assert.equal(vm.runInContext('$("message").value', c), "new draft");
  assert.equal(vm.runInContext('ui.submitting', c), false);
});

test("revised questions only mark the current occurrence as awaiting a reply", async () => {
  const c = await context();
  vm.runInContext('ui.state={snapshot:{status:"idle",pendingInteraction:{id:"q"}},interactionRevision:2};', c);
  assert.equal(vm.runInContext('awaitingReply({interactionId:"q",interactionRevision:1})', c), false);
  assert.equal(vm.runInContext('awaitingReply({interactionId:"q",interactionRevision:2})', c), true);
});

test("terminal stream state cancels an earlier reconnect timer and never opens another stream", async () => {
  const c = await context();
  vm.runInContext(`const elements=new Map();document={getElementById:id=>{if(!elements.has(id))elements.set(id,{value:"draft"});return elements.get(id)}};
    renderControls=()=>{};renderTree=()=>{};let cancelled=[];clearTimeout=id=>cancelled.push(id);
    let timers=0;setTimeout=()=>++timers;let requests=0;api=async()=>{requests++;};
    ui.state={revision:1,snapshot:{sessionId:"s",status:"idle"}};offline();`, c);
  assert.equal(vm.runInContext('timers', c), 1);
  vm.runInContext('ingest({revision:2,snapshot:{sessionId:"s",status:"stopped"}},true)', c);
  await vm.runInContext('connect()', c);
  assert.equal(vm.runInContext('requests', c), 0);
  assert.equal(vm.runInContext('timers', c), 1);
  assert.equal(vm.runInContext('cancelled.includes(1)', c), true);
  assert.equal(vm.runInContext('$("connection").textContent', c), "服务已关闭");
  assert.equal(vm.runInContext('$("reconnect").hidden', c), true);
  assert.equal(vm.runInContext('$("message").value', c), "draft");
});

async function optimisticContext() {
  const c = await context();
  vm.runInContext(`const elements = new Map();
    document = { getElementById: id => {
      if (!elements.has(id)) elements.set(id, { value: "original", style: {}, scrollHeight: 40 });
      return elements.get(id);
    } };
    let nextId = 0; crypto = { randomUUID: () => "request-" + ++nextId };
    let feedSnapshots = []; renderFeeds = () => feedSnapshots.push(mainEntries().map(e => ({ body:e.body,delivery:e.delivery })));
    renderControls = () => {}; renderTree = () => {};
    ui.connected = true; ui.state = {revision:1,snapshot:{sessionId:"s",status:"idle",pendingInteraction:{id:"q"}},interactionRevision:2};
    let envelopes = [], resolveApi;
    api = async (_route, _params, envelope) => { envelopes.push(envelope); return await new Promise(resolve => { resolveApi=resolve; }); };`, c);
  return c;
}

test("a client-ID message renders immediately before admission resolves and 202 clears its unchanged draft", async () => {
  const c = await optimisticContext();
  const sending = vm.runInContext("submitMessage()", c);
  assert.equal(vm.runInContext("feedSnapshots.length", c), 1);
  assert.equal(vm.runInContext('mainEntries().find(e=>e.title==="User message").body', c), "original");
  assert.equal(vm.runInContext('mainEntries().find(e=>e.title==="User message").delivery', c), "sending");
  assert.equal(vm.runInContext('envelopes[0].clientRequestId', c), "request-1");
  assert.equal(vm.runInContext('envelopes[0].interactionId', c), "q");
  assert.equal(vm.runInContext('envelopes[0].interactionRevision', c), 2);
  assert.equal(vm.runInContext('$("message").value', c), "original");
  vm.runInContext('resolveApi({receipt:{status:"accepted",clientRequestId:"request-1"},state:{revision:2,snapshot:{sessionId:"s",status:"running"}}})', c);
  await sending;
  assert.equal(vm.runInContext('$("message").value', c), "");
  assert.equal(vm.runInContext("mainEntries()[0].delivery", c), "accepted");
  assert.equal(vm.runInContext("ui.submitting", c), false);
});

test("202 admission preserves text typed after the original message was sent", async () => {
  const c = await optimisticContext();
  const sending = vm.runInContext("submitMessage()", c);
  vm.runInContext('$("message").value="a later draft";resolveApi({receipt:{status:"accepted"},state:{revision:2,snapshot:{sessionId:"s",status:"running"}}})', c);
  await sending;
  assert.equal(vm.runInContext('$("message").value', c), "a later draft");
  assert.equal(vm.runInContext("mainEntries()[0].body", c), "original");
  assert.equal(vm.runInContext("mainEntries()[0].delivery", c), "accepted");
});

test("unknown delivery preserves draft and explicit retry uses the same envelope ID until durable echo replaces it", async () => {
  const c = await optimisticContext();
  vm.runInContext(`ui.state.snapshot.pendingInteraction=undefined;let attempts=0;
    api=async (_route,_params,envelope)=>{envelopes.push(envelope);if(attempts++===0)throw new Error("connection lost");
      return {receipt:{status:"accepted"},state:{revision:2,snapshot:{sessionId:"s",status:"idle"}}};};`, c);
  await vm.runInContext("submitMessage()", c);
  assert.equal(vm.runInContext("mainEntries()[0].delivery", c), "unknown");
  assert.equal(vm.runInContext('$("message").value', c), "original");
  assert.equal(vm.runInContext("envelopes.length", c), 1);
  await vm.runInContext('sendEnvelope(ui.optimistic.get("request-1").envelope)', c);
  assert.equal(vm.runInContext("envelopes.length", c), 2);
  assert.equal(vm.runInContext("envelopes[0] === envelopes[1]", c), true);
  assert.equal(vm.runInContext("nextId", c), 1);
  assert.equal(vm.runInContext("mainEntries().length", c), 1);
  assert.equal(vm.runInContext("mainEntries()[0].delivery", c), "accepted");
  vm.runInContext('mergeEntries([{id:"persisted",ordinal:1,title:"User message",kind:"message",body:"original",raw:{data:{clientRequestId:"request-1"}}}])', c);
  assert.equal(vm.runInContext("ui.optimistic.size", c), 0);
  assert.equal(vm.runInContext("mainEntries().length", c), 1);
  assert.equal(vm.runInContext("mainEntries()[0].id", c), "persisted");
});

test("Manager cumulative stream updates keep one main bubble while worker output stays in detail", async () => {
  const c = await context();
  vm.runInContext(`ui.state={snapshot:{status:"running"}};
    mergeEntries([{id:"chunk1",ordinal:1,title:"Conversation stream",kind:"message",capabilityId:"init",jobId:"manager",streamKey:"manager:item-1",sdkEvent:"item.updated",body:"I am",raw:{type:"job.event",data:{item:{id:"item-1",type:"agent_message",text:"I am"}}}}]);`, c);
  assert.equal(vm.runInContext("mainEntries()[0].body", c), "I am");
  vm.runInContext(`mergeEntries([
    {id:"chunk2",ordinal:2,title:"Conversation stream",kind:"message",capabilityId:"init",jobId:"manager",streamKey:"manager:item-1",sdkEvent:"item.updated",body:"I am checking your goal"},
    {id:"worker",ordinal:3,title:"Agent reply",kind:"message",capabilityId:"init",jobId:"child",body:"private worker detail"},
    {id:"chunk1",ordinal:1,title:"Conversation stream",kind:"message",jobId:"manager",streamKey:"manager:item-1",body:"I am"}
  ]);`, c);
  assert.equal(vm.runInContext("mainEntries().length", c), 1);
  assert.equal(vm.runInContext("mainEntries()[0].body", c), "I am checking your goal");
  assert.equal(vm.runInContext('scopeEntries({metadata:{jobId:"child"}})[0].body', c), "private worker detail");
  vm.runInContext('mergeEntries([{id:"final",ordinal:4,title:"Manager reply",kind:"message",capabilityId:"init",body:"I am checking your goal"}])', c);
  assert.equal(vm.runInContext("mainEntries().length", c), 1);
  assert.equal(vm.runInContext("mainEntries()[0].id", c), "final");
});

test("hiding Capability retains operation ownership and recursive parent-child links", async () => {
  const c = await context();
  vm.runInContext(`ui.nodes=new Map([
    ["cap",{id:"cap",kind:"capability",status:"running"}],
    ["op",{id:"op",parentId:"cap",kind:"operation",status:"running"}],
    ["parent",{id:"parent",parentId:"op",kind:"agent",status:"running",metadata:{jobId:"parent"}}],
    ["child",{id:"child",parentId:"parent",kind:"agent",status:"running",metadata:{jobId:"child",parentJobId:"parent"}}],
    ["grandchild",{id:"grandchild",parentId:"child",kind:"agent",status:"idle",metadata:{jobId:"grandchild",parentJobId:"child"}}]
  ]);`, c);
  assert.equal(vm.runInContext('visibleTreeNodes().some(n=>n.kind==="capability")', c), false);
  assert.equal(vm.runInContext('visibleTreeNodes().find(n=>n.id==="op").parentId', c), undefined);
  assert.equal(vm.runInContext('visibleTreeNodes().find(n=>n.id==="parent").parentId', c), "op");
  assert.equal(vm.runInContext('visibleTreeNodes().find(n=>n.id==="child").parentId', c), "parent");
  assert.equal(vm.runInContext('visibleTreeNodes().find(n=>n.id==="grandchild").parentId', c), "child");
  assert.equal(vm.runInContext('ui.nodes.get("op").parentId', c), "cap");
});
