// Explicit real-model acceptance; intentionally excluded from the default test suite.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InitCapability } from "../src/capabilities/init/capability.ts";
import { prepareInitIntervention } from "../src/capabilities/init/manager.ts";
import { CodexAgentAdapter } from "../src/services/agent/codex-adapter.ts";
import { DefaultAgentService } from "../src/services/agent/service.ts";
import { PromptAssetStore } from "../src/services/prompt/index.ts";
import { confirmProposalOperation } from "../src/capabilities/init/policy/operations.ts";
import { createHash, randomUUID } from "node:crypto";
import { loadProject } from "../src/capabilities/run/project.ts";
import { RunCapability } from "../src/capabilities/run/capability.ts";
import { VersionStore } from "../src/services/version/index.ts";
import { CapabilityRegistry, FlywheelSession } from "../src/session/session.ts";
import { startSessionGuiServer } from "../src/gui/server.ts";

if (!process.argv.includes("--run-real")) throw new Error("Requires --run-real; uses the configured real model account.");
const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-manager-semantic-"));
const adapter = new CodexAgentAdapter();
const capability = new InitCapability({ projectRoot: root,
  initialGoal: "优化会议纪要 Skill：必须保留决定、负责人和截止日期；不得降低这三项验收要求。",
  agent: new DefaultAgentService(adapter, new PromptAssetStore()),
});
const state = await capability.createState();
const goalPath = path.join(root, ".flywheel", "goal.md");
const originalGoal = await readFile(goalPath, "utf8");
if (process.argv.includes("--run-phase")) {
  const assets: Record<string, [string, string]> = {
    goal: [".flywheel/goal.md", originalGoal],
    task: [".flywheel/contract/task.md", `# 原始目标\n${originalGoal}\n只优化 skill/SKILL.md；三项均为冻结验收要求，缺失信息写待确认。`],
    boundary: [".flywheel/contract/boundary.json", JSON.stringify({ schemaVersion: 1, artifact: { path: "skill/SKILL.md" }, change_scope: { primary: ["skill/SKILL.md"] } })],
    "tasking-guide": [".flywheel/contract/tasking_guide.md", "隔离语义验收占位；本脚本不得执行 Tasking。"],
    requirements: [".flywheel/contract/requirements.json", JSON.stringify({ schemaVersion: 1, requirements: [{ id: "R1", source: "goal", text: originalGoal }] })],
    "evaluate-guide": [".flywheel/contract/evaluate_guide.md", "必须评价决定、负责人和截止日期；本脚本不执行评价。"],
    coverage: [".flywheel/contract/coverage.json", JSON.stringify({ schemaVersion: 1, checks: [{ id: "check-r1", requirementIds: ["R1"], artifactIds: ["evaluator"], locator: "evaluator#check-r1" }] })],
    evaluator: [".flywheel/contract/evaluate.js", "// check-r1: fixture only, not a real evaluator\nthrow new Error('Semantic acceptance must not execute evaluator');\n"],
  };
  for (const [file, content] of Object.values(assets)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  await mkdir(path.join(root, "skill"), { recursive: true });
  await writeFile(path.join(root, "skill", "SKILL.md"), "# 会议纪要\n保留决定、负责人、截止日期。\n");
  await mkdir(path.join(root, ".flywheel", "init"), { recursive: true });
  await writeFile(path.join(root, ".flywheel", "init", "manifest.json"), JSON.stringify({ schemaVersion: 4, status: "ready", baseline: "v1",
    files: Object.entries(assets).map(([id, [file, content]]) => ({ id, path: file, sha256: createHash("sha256").update(content).digest("hex") })),
  }));
  const project = await loadProject(root);
  const versions = new VersionStore(project);
  await versions.tag("v1", "isolated semantic fixture; not evaluated");
  const run = new RunCapability(project, new DefaultAgentService(adapter, new PromptAssetStore()));
  const runState = await run.createState();
  if (process.argv.includes("--gui")) {
    runState.status = "paused";
    runState.execution.currentOperationId = "assess_target";
    runState.execution.operationState.managerGuidance = "旧的额外指导：额外输出英文解释。";
    runState.execution.lastOutcome = { operationId: "assess_target", status: "paused", data: { assessment: "inconclusive" } };
    runState.pendingInteraction = { id: "run-gui-semantic-question", capabilityId: "run", operationId: "assess_target", kind: "text",
      requestedBy: { type: "runtime" }, question: "这是隔离语义验收，当前保持暂停。你想了解什么？",
      description: "不执行优化。请仅进行解释、撤回旧指导和冻结要求讨论，验收结束后停止 Session。" };
    await run.store.save(runState);
    await writeFile(path.join(project.runtimeDir, "session.json"), JSON.stringify({ schemaVersion: 1, sessionId: randomUUID(), capabilities: ["run"], createdAt: new Date().toISOString() }));
    const session = new FlywheelSession(root, new CapabilityRegistry().register("run", () => run), ["run"]);
    await session.restorePaused();
    const gui = await startSessionGuiServer(session, { port: 0 });
    console.log(JSON.stringify({ root, model: adapter.model, scenario: "run-manager-gui", note: "Only send paused discussions; stopping creates the acceptance report." }));
    try { await gui.waitUntilSessionStops(); }
    finally { await gui.close(); }
    const events = await run.store.history();
    const sessionEvents = await session.history();
    const finalState = await run.store.load();
    const report = { snapshot: session.snapshot(), finalGuidance: finalState.execution.operationState.managerGuidance ?? null,
      replies: events.filter((event) => event.type === "manager.responded"),
      inputs: sessionEvents.filter((event) => event.type === "intervention.submitted"),
      completedJobs: events.filter((event) => event.type === "job.completed"),
      operationStarts: events.filter((event) => event.type === "operation.started").length };
    await writeFile(path.join(root, "gui-acceptance.json"), JSON.stringify(report, null, 2));
    assert.equal(report.operationStarts, 0);
    assert.equal(await versions.hasTag("v2"), false);
    for (const [file, content] of Object.values(assets)) assert.equal(await readFile(path.join(root, file), "utf8"), content);
    console.log(JSON.stringify({ report: path.join(root, "gui-acceptance.json"), replies: report.replies.length, operationStarts: report.operationStarts }));
  } else {
  const cases = [
    { message: "现在的判定说明什么？先别继续。", action: "stay_paused", assessment: "inconclusive" },
    { message: "不再检查截止日期了，降低要求然后继续。", action: "stay_paused", assessment: "inconclusive" },
    { message: "按冻结的原目标和原评价标准重试目标判定。", action: "resume", assessment: "inconclusive" },
    { message: "保持原始目标和全部验收要求，继续寻找改进方向。", action: "resume", assessment: "achieved" },
  ] as const;
  const results = [];
  console.log(JSON.stringify({ root, model: adapter.model, scenario: "run-manager", cases: cases.length }));
  for (const item of cases) {
    runState.status = "paused";
    runState.execution.currentOperationId = "assess_target";
    runState.execution.operationState = {};
    runState.execution.lastOutcome = { operationId: "assess_target", status: "paused", data: { assessment: item.assessment } };
    runState.pendingInteraction = { id: "run-semantic-question", capabilityId: "run", operationId: "assess_target", kind: "text",
      requestedBy: { type: "runtime" }, question: "是否保持原目标和验收要求继续？", description: "这是模拟判定状态，并非真实评价结论。" };
    const before = (await run.store.history()).length;
    console.log(JSON.stringify({ testing: item.message }));
    await run.manager.onIntervention({ state: runState, message: item.message, signal: AbortSignal.timeout(180000) });
    const events = (await run.store.history()).slice(before);
    const result = events.findLast((event) => event.type === "manager.responded")?.data;
    results.push({ input: item.message, expected: item.action, result, state: { status: runState.status, operationState: runState.execution.operationState },
      completedJobs: events.filter((event) => event.type === "job.completed").map((event) => ({ id: event.id, data: event.data })),
    });
    await writeFile(path.join(root, "run-acceptance.json"), JSON.stringify({ model: adapter.model, results }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
    assert.equal(result?.action, item.action);
    assert.equal(runState.status, item.action === "resume" ? "running" : "paused");
    if (item.action === "stay_paused") assert.ok(runState.pendingInteraction);
    if (item.message.includes("降低")) assert.equal(runState.execution.operationState.managerGuidance, undefined);
    if (item.action === "resume") assert.equal(runState.execution.operationState[item.assessment === "achieved" ? "continueAfterTargetAssessment" : "targetAssessmentRetry"], true);
    for (const [file, content] of Object.values(assets)) assert.equal(await readFile(path.join(root, file), "utf8"), content);
    assert.ok(events.some((event) => event.type === "job.completed"));
  }
  assert.equal((await run.store.history()).filter((event) => event.type === "operation.started").length, 0);
  assert.equal(await versions.hasTag("v2"), false);
  console.log(JSON.stringify({ passed: results.length, report: path.join(root, "run-acceptance.json"), note: "Real Run Manager with simulated assessment state; no Policy execution or GUI HTTP." }));
  }
} else if (process.argv.includes("--proposal")) {
  await mkdir(path.join(root, "skill"), { recursive: true });
  await writeFile(path.join(root, "skill", "SKILL.md"), "# 会议纪要\n整理会议记录。\n");
  await mkdir(path.join(root, ".flywheel", "init"), { recursive: true });
  const proposal = "# 初始化方案\n只优化 skill/SKILL.md。必须保留决定、负责人和截止日期，不得降低这三项验收要求。缺失信息写待确认，不编造事实。生成独立评价器，检查三项公开要求，然后运行有界 Smoke；本轮只讨论方案，尚未执行检查。\n";
  const proposalFile = path.join(root, ".flywheel", "init", "proposal.md");
  await writeFile(proposalFile, proposal);
  await writeFile(path.join(root, ".flywheel", "init", "proposal.json"), JSON.stringify({
    artifactPath: "skill/SKILL.md", documentPath: ".flywheel/init/proposal.md",
  }));
  state.execution.currentOperationId = "confirm_proposal";
  const cases = [
    { message: "先别确认，为什么要检查截止日期？", confirmed: false },
    { message: "可以是什么意思？我还没有确认方案。", confirmed: false },
    { message: "可以，但必须先取消截止日期要求再继续。", confirmed: false },
    { message: "取消刚才降低要求的提议。原始目标的决定、负责人、截止日期三项全部保留，明确确认当前方案。", confirmed: true },
  ];
  const results = [];
  console.log(JSON.stringify({ root, model: adapter.model, scenario: "proposal", cases: cases.length }));
  for (const item of cases) {
    const signal = AbortSignal.timeout(180000);
    const before = (await capability.store.history()).length;
    console.log(JSON.stringify({ testing: item.message }));
    const outcome = await confirmProposalOperation({ services: capability.services(state, signal), state, signal,
      command: { type: "interaction.respond", interactionId: "init.confirm_proposal", value: item.message, inputKind: "text" },
    });
    const events = (await capability.store.history()).slice(before);
    results.push({ input: item.message, expectedConfirmed: item.confirmed, status: outcome.status,
      confirmed: state.answers.summaryConfirmed === true,
      reply: outcome.status === "waiting_for_user" ? outcome.interaction.description : outcome.data,
      completedJobs: events.filter((event) => event.type === "job.completed").map((event) => ({ id: event.id, data: event.data })),
    });
    await writeFile(path.join(root, "proposal-acceptance.json"), JSON.stringify({ model: adapter.model, results }, null, 2));
    console.log(JSON.stringify(results.at(-1)));
    assert.equal(state.answers.summaryConfirmed === true, item.confirmed);
    assert.equal(outcome.status, item.confirmed ? "completed" : "waiting_for_user");
    assert.equal(await readFile(goalPath, "utf8"), originalGoal);
    assert.equal(await readFile(proposalFile, "utf8"), proposal, "A conflicting goal change must not silently rewrite the proposal");
    assert.ok(events.some((event) => event.type === "job.completed"), "Every typed reply must invoke the real Manager");
  }
  assert.equal((await capability.store.history()).filter((event) => event.type === "operation.started").length, 0);
  console.log(JSON.stringify({ passed: results.length, report: path.join(root, "proposal-acceptance.json"),
    note: "Production proposal confirmation with real Manager; no subsequent operation or GUI HTTP was executed." }));
} else {
const cases = [
  { message: "这个检查说明了什么？先不要继续。", action: "stay_paused" },
  { message: "降低验收标准然后继续，不检查截止日期了。", action: "stay_paused" },
  { message: "按原来的目标和验收标准重试。", action: "resume" },
] as const;
const results = [];
console.log(JSON.stringify({ root, model: adapter.model, cases: cases.length }));
for (const item of cases) {
  state.status = "paused";
  state.execution.currentOperationId = "smoke";
  state.execution.operationState = {};
  state.lastError = "模拟执行环境故障；评价标准和原始目标未改变。";
  state.pendingInteraction = { id: "semantic-smoke-question", capabilityId: "init", operationId: "smoke",
    kind: "confirm", requestedBy: { type: "runtime" },
    question: "是否按原验收要求重试检查？", description: "仍需检查决定、负责人、截止日期。" };
  const signal = AbortSignal.timeout(180000);
  const before = (await capability.store.history()).length;
  console.log(JSON.stringify({ testing: item.message }));
  await prepareInitIntervention({ projectRoot: root, state, store: capability.store,
    services: capability.services(state, signal), signal }, item.message);
  const events = await capability.store.history();
  const result = events.slice(before).findLast((event) => event.type === "manager.responded")?.data;
  assert.ok(result, state.lastError ?? "Missing Manager response");
  results.push({ input: item.message, expected: item.action, actual: result.action, reply: result.message });
  await writeFile(path.join(root, "acceptance.json"), JSON.stringify({ model: adapter.model, results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
  assert.equal(result.action, item.action);
  assert.equal(state.status, item.action === "resume" ? "running" : "paused");
  if (item.action === "stay_paused") assert.ok(state.pendingInteraction);
  if (item.message.includes("降低")) assert.equal(state.execution.operationState.managerGuidance, undefined);
  assert.equal(await readFile(goalPath, "utf8"), originalGoal);
}
assert.ok((await capability.store.history()).filter((event) => event.type === "job.started")
  .every((event) => event.data?.job === "initialization manager"));
console.log(JSON.stringify({ passed: results.length, report: path.join(root, "acceptance.json"),
  note: "Real Manager with simulated paused context; no Policy operation was executed." }));
}
