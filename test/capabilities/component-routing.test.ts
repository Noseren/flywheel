import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ComponentUnavailable, COMPONENT_ROUTING_REVISION, parseRoutingDecision, runAdvisoryComponent, runComponentRouting, type RoutingOptions } from "../../src/capabilities/component-routing.ts";
import { createExecutionBudgetState, ExecutionBudget } from "../../src/session/execution-budget.ts";
import type { JobSpec } from "../../src/services/agent/job-protocol.ts";
import { validateJobSpec } from "../../src/services/agent/job-validation.ts";

async function fixture(tokens = 2_000_000) {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-routing-"));
  const publicFile = path.join(root, "source.py"), privateFile = path.join(root, "holdout.txt");
  await writeFile(publicFile, "public implementation"); await writeFile(privateFile, "PRIVATE_HOLDOUT");
  const budget = new ExecutionBudget(createExecutionBudgetState({ knownTokens: tokens, activeMs: 1_800_000 }), async () => {});
  await budget.reserveRequiredWork("verification", { tokens: 1000, activeMs: 10_000, source: "frozen" });
  await budget.reserveRequiredWork("target-assess:final", { tokens: 32_000, activeMs: 30_000, source: "target" });
  let calls = 0;
  const jobs: JobSpec[] = [];
  let decision: unknown = { action: "request_component", component: "soundness", reason: "A concrete public assertion may reject the supported API", evidence: ["file:0"] };
  let report: unknown = { schemaVersion: 1, summary: "The public API returns a wrapper; the assertion expects a raw node.", evidence: ["file:0"] };
  const options: RoutingOptions = { revision: COMPONENT_ROUTING_REVISION, window: "R2", windowId: "draft-v1", projectRoot: root,
    outputDir: path.join(root, ".flywheel/runtime/routing/R2"), publicContext: "Original public goal", publicFiles: [publicFile], deniedPaths: [privateFile],
    requiredReservationIds: ["verification", "target-assess:final"], budget,
    execute: async job => {
      validateJobSpec(job); calls++; jobs.push(job);
      await budget.startInvocation(`call-${calls}`, job.invocationReservation);
      const variables = job.prompt.variables!;
      const file = String(variables.decision_path ?? variables.report_path);
      await writeFile(file, JSON.stringify(variables.decision_path ? decision : report));
      await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [file] }));
      await budget.finishInvocation(`call-${calls}`, { inputTokens: 1000, outputTokens: 100 });
      return { status: "completed", artifacts: [file] };
    },
  };
  return { options, root, publicFile, privateFile, budget, jobs, calls: () => calls, decision: (value: unknown) => { decision = value; }, report: (value: unknown) => { report = value; } };
}

test("router does not reserve an unavailable second repair after the shared repair is consumed", async () => {
  const f = await fixture();
  await f.budget.claimRepair();
  f.decision({ action: "continue_base", reason: "Public evidence is sufficient", evidence: ["context"] });
  const estimate = f.budget.estimateInvocation("routing");
  await runComponentRouting(f.options);
  const reservation = f.budget.state.reservations![f.jobs[0]!.invocationReservation!.reservationId]!;
  assert.equal(reservation.estimate.tokens, estimate.tokens);
  assert.equal(reservation.estimate.activeMs, estimate.activeMs);
  assert.equal(f.budget.state.repairUsed, true);
});

test("independent router and advisory execute on immutable public snapshots, then restore without calls", async () => {
  const f = await fixture();
  const decision = await runComponentRouting(f.options);
  assert.equal(decision.admitted, true);
  assert.equal(decision.component, "soundness");
  const report = await runAdvisoryComponent({ ...f.options, component: "soundness" });
  assert.match(report.reportText, /wrapper/);
  assert.equal(report.continuationReservation?.reservationId, decision.reservationId);
  assert.equal(report.deadline, decision.deadline);
  assert.equal(f.calls(), 2);
  assert.notEqual(f.jobs[0].sessionKey, f.jobs[1].sessionKey);
  for (const job of f.jobs) {
    assert.equal(job.delegation, "disabled");
    assert.deepEqual(job.tools, ["Read", "Write"]);
    assert.ok(!job.readRoots.includes(f.root));
    assert.ok(!job.readRoots.includes(f.privateFile));
    assert.ok(job.writeRoots.every(file => file.startsWith(f.options.outputDir)));
    assert.ok(!(await readFile(String(job.prompt.variables!.context_path), "utf8")).includes("PRIVATE_HOLDOUT"));
  }
  await f.budget.closeReservation(decision.reservationId!);
  await f.budget.closeReservation("verification");
  await f.budget.closeReservation("target-assess:final");
  assert.deepEqual(await runComponentRouting(f.options), decision);
  assert.deepEqual(await runAdvisoryComponent({ ...f.options, component: "soundness" }), report);
  assert.equal(f.calls(), 2, "completed restoration does not require live consumed reservations");
});

test("a router does not force optional components and repeated simultaneous requests execute once", async () => {
  const f = await fixture();
  f.decision({ action: "continue_base", reason: "Public deterministic checks cover this small task", evidence: ["context"] });
  const decisions = await Promise.all([runComponentRouting(f.options), runComponentRouting(f.options)]);
  assert.deepEqual(decisions[0], decisions[1]);
  assert.equal(f.calls(), 1);
  assert.equal(Object.keys(f.budget.state.assistance!.decisions).length, 0);
});

test("work/check routes defer admission to the actual parent Child tree without consuming a batch", async () => {
  const f = await fixture();
  f.decision({ action: "request_component", component: "check", reason: "One AST placement doubt", evidence: ["file:0"] });
  const result = await runComponentRouting(f.options);
  assert.equal(result.parentAssistanceRequired, true);
  assert.equal(result.admitted, false);
  assert.equal(result.reservationId, undefined);
  assert.equal(Object.keys(f.budget.state.assistance!.decisions).length, 0);
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "check" }), /no admitted/);
});

test("budget refusal preserves necessary reservations and never launches an advisory", async () => {
  const f = await fixture(200_000);
  const result = await runComponentRouting(f.options);
  assert.equal(result.admitted, false);
  assert.equal(result.denialReason, "optional-token-limit");
  assert.equal(f.budget.state.reservations!.verification.tokensRemaining, 1000);
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), /no admitted/);
  assert.equal(f.calls(), 1);
});

test("invalid IDs, private references, extra authority and self-declared achievement are rejected", () => {
  for (const value of [
    { action: "target_achieved", reason: "done", evidence: [] },
    { action: "request_component", component: "shell", reason: "run", evidence: ["context"] },
    { action: "request_component", component: "soundness", reason: "check", evidence: ["holdout"] },
    { action: "continue_base", reason: "okay", evidence: [], command: "anything" },
  ]) assert.throws(() => parseRoutingDecision(value, ["soundness"], ["context"]));
});

test("unknown running router preserves reservations and is never silently replayed", async () => {
  const f = await fixture(); let calls = 0;
  f.options.execute = async job => {
    calls++; await f.budget.startInvocation("uncertain", job.invocationReservation);
    await f.budget.finishInvocation("uncertain", null);
    throw new Error("transport lost");
  };
  await assert.rejects(runComponentRouting(f.options), /transport lost/);
  await assert.rejects(runComponentRouting(f.options), /terminal state is unknown/);
  assert.equal(calls, 1);
  assert.equal(f.budget.state.unknownUsageInvocations, 1);
  assert.equal(f.budget.state.reservations!["verification"].closed, undefined);
});

test("public input, completed report and revision changes invalidate reuse", async () => {
  for (const change of ["input", "report", "revision"]) {
    const f = await fixture(); await runComponentRouting(f.options);
    if (change === "input") await writeFile(f.publicFile, "changed source");
    if (change === "report") await writeFile(path.join(f.options.outputDir, "router-output/decision.json"), "{}");
    if (change === "revision") f.options.revision = "2026-10-24.compact.v2";
    await assert.rejects(runComponentRouting(f.options), /binding changed|evidence changed|trusted v3/);
    assert.equal(f.calls(), 1);
  }
});

test("denied public inputs and unimplemented window components fail before model execution", async () => {
  const f = await fixture();
  await assert.rejects(runComponentRouting({ ...f.options, publicFiles: [f.privateFile] }), /public file authority/);
  await assert.rejects(runComponentRouting({ ...f.options, allowedComponents: ["search"] }), /not allowed/);
  assert.equal(f.calls(), 0);
});

test("search admission reserves one optional chain and component jobs consume its original slots", async () => {
  const f = await fixture(); f.options.window = "R3"; f.options.componentSlots = { search: 4 };
  f.decision({ action: "request_component", component: "search", reason: "Two independent hypotheses", evidence: ["context"] });
  const route = await runComponentRouting(f.options);
  assert.equal(route.admitted, true);
  assert.equal(route.deadline, undefined, "a chain does not claim a single 120-second batch");
  const reservation = f.budget.state.reservations![route.reservationId!]!;
  assert.equal(reservation.componentChain?.slots, 4);
  const proposalDir = path.join(f.options.outputDir, "proposal");
  f.report({ schemaVersion: 1, summary: "Two hypotheses", evidence: ["context"], hypotheses: [{ id: "one", task: "Fix public parser" }, { id: "two", task: "Fix independent transport" }] });
  await runAdvisoryComponent({ ...f.options, outputDir: proposalDir, component: "propose", invocationReservationId: route.reservationId });
  assert.equal(reservation.componentChain?.slotsRemaining, 3);
  assert.equal(Object.values(f.budget.state.assistance!.decisions).filter(d => d.admitted).length, 1);
  assert.equal(f.budget.state.invocations["call-2"].estimatedTokens, 32_000);
  assert.equal(f.budget.state.invocations["call-2"].estimatedActiveMs, 30_000);
});

test("known completed invocation recovers a report after a crash without calling the model twice", async () => {
  const f = await fixture(); const execute = f.options.execute;
  f.options.execute = async (job, signal) => { await execute(job, signal); throw new Error("crash after provider terminal"); };
  await assert.rejects(runComponentRouting(f.options), /crash after provider/);
  const route = await runComponentRouting(f.options);
  assert.equal(route.admitted, true); assert.equal(f.calls(), 1);
});

test("malformed decisions repair once in the same session and consume the shared allowance", async () => {
  const f = await fixture(); const execute = f.options.execute;
  f.decision({ action: "target_achieved" });
  f.options.execute = async (job, signal) => {
    if (f.calls()) {
      f.decision({ action: "continue_base", reason: "No public concern", evidence: ["context"] });
      // Repair uses the original decision path, while the model receives the repair prompt.
      return execute({ ...job, prompt: f.jobs[0].prompt }, signal);
    }
    return execute(job, signal);
  };
  assert.equal((await runComponentRouting(f.options)).action, "continue_base");
  assert.equal(f.calls(), 2); assert.equal(f.jobs[0].sessionKey, f.jobs[1].sessionKey);
  await assert.rejects(f.budget.claimRepair());
});

test("a forged completed status without matching JobResult artifact cannot authorize a route", async () => {
  const f = await fixture(); const execute = f.options.execute;
  f.options.execute = async (job, signal) => {
    const answer = await execute(job.prompt.variables?.decision_path ? job : { ...job, prompt: f.jobs[0].prompt }, signal);
    await writeFile(job.resultPath!, JSON.stringify({ status: "completed", artifacts: [] }));
    return answer;
  };
  await assert.rejects(runComponentRouting(f.options), /actual public report/);
  assert.equal(f.calls(), 2);
  assert.equal(Object.values(f.budget.state.reservations ?? {}).filter(r => r.kind === "assistance").length, 0);
});

test("completed reports after the persisted deadline cannot be recovered by extending authorization", async () => {
  const f = await fixture(); const route = await runComponentRouting(f.options);
  const execute = f.options.execute;
  f.options.execute = async (job, signal) => { await execute(job, signal); throw new Error("after component terminal"); };
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), /after component terminal/);
  const file = path.join(f.options.outputDir, "component-soundness-output.execution.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.deadline = 1; await writeFile(file, JSON.stringify(state));
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), /persisted authorization deadline/);
  assert.equal(f.calls(), 2); assert.ok(route.reservationId);
});

test("partial optional preparation budget refusal releases only new untouched reservations and restores base", async () => {
  const f = await fixture(200_000);
  let preparations = 0;
  f.options.prepareComponent = async () => {
    preparations++;
    await f.budget.reserveRequiredWork("extra-evaluation", { tokens: 20_000, activeMs: 5000, source: "optional-chain" });
    await f.budget.reserveRequiredWork("too-expensive", { tokens: 200_000, activeMs: 5000, source: "optional-chain" });
    return [];
  };
  const decision = await runComponentRouting(f.options);
  assert.equal(decision.admitted, false); assert.equal(decision.denialReason, "necessary-chain-budget");
  assert.equal(f.budget.state.reservations!["extra-evaluation"].closed, true);
  assert.ok(!f.budget.state.reservations!["verification"].closed);
  assert.ok(!f.budget.state.reservations!["target-assess:final"].closed);
  assert.deepEqual(await runComponentRouting(f.options), decision);
  assert.equal(preparations, 1); assert.equal(f.calls(), 1);
});

test("optional preparation does not swallow non-budget failures", async () => {
  const f = await fixture();
  f.options.prepareComponent = async () => { throw new Error("contract binding changed"); };
  await assert.rejects(runComponentRouting(f.options), /contract binding changed/);
});

test("routing grants only the isolated public directory and uses compact file mapping", async () => {
  const f = await fixture();
  await runComponentRouting(f.options);
  const job = f.jobs[0];
  assert.equal(job.readRoots.length, 2);
  assert.equal(job.readRoots[0], path.dirname(String(job.prompt.variables!.context_path)));
  const files = job.prompt.variables!.public_files as { directory: string; mapping: string };
  assert.equal(files.directory, job.readRoots[0]);
  assert.match(files.mapping, /file:N -> file-N.txt/);
  const context = await readFile(String(job.prompt.variables!.context_path), "utf8");
  assert.match(context, /original=source.py; sha256=[a-f0-9]{64}/);
  await writeFile(path.join(job.readRoots[0], "unexpected-private.txt"), "must never become authorized");
  await assert.rejects(runComponentRouting(f.options), /Unexpected file in isolated public snapshot/);
});

test("known aborted optional component settles without accepting report and never replays", async () => {
  const f = await fixture(); const route = await runComponentRouting(f.options); const execute = f.options.execute;
  f.options.execute = async (job, signal) => { const result = await execute(job, signal); return { ...result, status: "aborted" }; };
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), error => error instanceof ComponentUnavailable && error.settled && error.reservationId === route.reservationId);
  const spent = f.budget.state.knownTokens;
  assert.ok(f.budget.state.reservations![route.reservationId!].closed);
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), ComponentUnavailable);
  assert.equal(f.calls(), 2); assert.equal(f.budget.state.knownTokens, spent);
});

test("thrown unknown optional transport keeps occupancy and cannot fall back or replay", async () => {
  const f = await fixture(); const route = await runComponentRouting(f.options);
  let calls = 0;
  f.options.execute = async job => {
    calls++; await f.budget.startInvocation("unknown-optional", job.invocationReservation);
    await f.budget.finishInvocation("unknown-optional", null);
    throw new Error("transport lost with unknown usage");
  };
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), /transport lost/);
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), error => !(error instanceof ComponentUnavailable) && /unknown/.test(String(error)));
  assert.equal(calls, 1); assert.ok(!f.budget.state.reservations![route.reservationId!].closed);
  assert.equal(f.budget.state.unknownUsageInvocations, 1);
});

test("returned aborted with unknown usage cannot settle optional authority", async () => {
  const f = await fixture(); const route = await runComponentRouting(f.options);
  f.options.execute = async job => { await f.budget.startInvocation("partial-abort", job.invocationReservation); await f.budget.finishInvocation("partial-abort", { inputTokens: 2 }); return { status: "aborted", artifacts: [] }; };
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), error => !(error instanceof ComponentUnavailable) && /unknown/.test(String(error)));
  assert.ok(!f.budget.state.reservations![route.reservationId!].closed);
});

test("known aborted receipt survives a crash before the unavailable ledger commit", async () => {
  const f = await fixture(); const route = await runComponentRouting(f.options); const execute = f.options.execute;
  f.options.execute = async (job, signal) => { const result = await execute(job, signal); return { ...result, status: "aborted" }; };
  const close = f.budget.closeReservation.bind(f.budget);
  // Simulate process loss after persisting the unavailable decision, before release.
  f.budget.closeReservation = async id => { if (id === route.reservationId) throw new Error("crash before release"); return close(id); };
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), /crash before release/);
  assert.ok(!f.budget.state.reservations![route.reservationId!].closed);
  f.budget.closeReservation = close;
  await assert.rejects(runAdvisoryComponent({ ...f.options, component: "soundness" }), ComponentUnavailable);
  assert.equal(f.calls(), 2); assert.ok(f.budget.state.reservations![route.reservationId!].closed);
});
