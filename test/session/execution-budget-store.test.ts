import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExecutionBudgetState } from "../../src/session/execution-budget.ts";
import { openExecutionBudget } from "../../src/session/execution-budget-store.ts";

test("project budget persists, reuses one concurrent instance and never replaces its limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-store-"));
  const [first, second] = await Promise.all([
    openExecutionBudget(root, { candidateAttempts: 1 }),
    openExecutionBudget(path.join(root, "."), { candidateAttempts: 100 }),
  ]);
  assert.equal(first, second);
  await first.reserveAttempt("candidate-1");
  await first.claimRepair();
  const saved = JSON.parse(await readFile(path.join(root, ".flywheel/runtime/execution-budget.json"), "utf8"));
  assert.equal(saved.limits.candidateAttempts, 1);
  assert.deepEqual(saved.attempts, ["candidate-1"]);
  assert.equal(saved.repairUsed, true);
  await assert.rejects(second.reserveAttempt("candidate-2"), /attempts/);
});

test("disk recovery closes interrupted activity once and preserves previous counters and limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-restore-"));
  const directory = path.join(root, ".flywheel/runtime");
  await mkdir(directory, { recursive: true });
  const saved = createExecutionBudgetState({ candidateAttempts: 2 });
  saved.attempts = ["rejected-1"];
  saved.repairUsed = true;
  saved.activeMs = 27;
  saved.knownTokens = 123;
  saved.invocations = { interrupted: { startedAt: 100 }, finished: { startedAt: 50, endedAt: 90, tokens: 123 } };
  saved.processes = { command: { startedAt: 120 } };
  saved.activeUpdatedAt = 127;
  await writeFile(path.join(directory, "execution-budget.json"), JSON.stringify(saved));
  const budget = await openExecutionBudget(root, { candidateAttempts: 100 });
  assert.equal(budget.state.limits.candidateAttempts, 2);
  assert.equal(budget.state.activeMs, 27);
  assert.equal(budget.state.knownTokens, 123);
  assert.equal(budget.state.unknownUsageInvocations, 1);
  assert.equal(budget.state.processes!.command!.endedAt, 127);
  await openExecutionBudget(root);
  assert.equal(budget.state.unknownUsageInvocations, 1);
  await assert.rejects(budget.claimRepair(), /repair/);
});

test("malformed persisted budget fails closed instead of resetting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-invalid-"));
  const directory = path.join(root, ".flywheel/runtime");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "execution-budget.json"), "{}");
  await assert.rejects(openExecutionBudget(root), /refusing to reset/);
  assert.equal(await readFile(path.join(directory, "execution-budget.json"), "utf8"), "{}");
});

test("physical project aliases share the same in-process budget and do not overwrite limits", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-alias-"));
  const root = path.join(parent, "project");
  const alias = path.join(parent, "alias");
  await mkdir(root);
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const [first, second] = await Promise.all([openExecutionBudget(root, { candidateAttempts: 1 }), openExecutionBudget(alias)]);
  assert.equal(first, second);
  assert.equal(first.state.limits.candidateAttempts, 1);
  await first.reserveAttempt("candidate-a");
  await assert.rejects(second.reserveAttempt("candidate-b"), /attempts/);
  if (process.platform === "win32") assert.equal(await openExecutionBudget(root.toUpperCase()), first);
});

test("the first caller selects new limits before concurrent physical aliases can select defaults", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-first-open-"));
  for (let index = 0; index < 16; index++) {
    const root = path.join(parent, `project-${index}`);
    const alias = path.join(parent, `alias-${index}`);
    await mkdir(root);
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const [firstPath, laterPath] = index % 2 ? [alias, root] : [root, alias];
    const [first, later] = await Promise.all([
      openExecutionBudget(firstPath, { candidateAttempts: 1, knownTokens: 123_456 }),
      openExecutionBudget(laterPath),
    ]);
    assert.equal(first, later);
    assert.equal(first.state.limits.candidateAttempts, 1);
    assert.equal(first.state.limits.knownTokens, 123_456);
    await first.reserveAttempt("first");
    await assert.rejects(later.reserveAttempt("cannot-raise-limit"), /attempts/);
    const persisted = JSON.parse(await readFile(path.join(root, ".flywheel/runtime/execution-budget.json"), "utf8"));
    assert.equal(persisted.limits.candidateAttempts, 1);
    assert.equal(persisted.limits.knownTokens, 123_456);
    assert.equal(await openExecutionBudget(laterPath, { candidateAttempts: 100 }), first);
    assert.equal(first.state.limits.candidateAttempts, 1);
  }
});

test("disk recovery preserves assistance decisions, evaluation reserve and unknown occupancy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-assistance-"));
  const directory = path.join(root, ".flywheel/runtime");
  await mkdir(directory, { recursive: true });
  const state = createExecutionBudgetState();
  const { ExecutionBudget } = await import("../../src/session/execution-budget.ts");
  const seed = new ExecutionBudget(state, async () => {}, () => 100);
  await seed.reserveRequiredWork("evaluation", { tokens: 20_000, activeMs: 40_000, source: "frozen-config" });
  const request = { requestId: "batch", windowId: "candidate-1", binding: "hash", childCount: 1, requiredReservationId: "evaluation" };
  const decision = await seed.admitAssistance(request);
  await seed.startInvocation("interrupted", { reservationId: decision.reservationId });
  await writeFile(path.join(directory, "execution-budget.json"), JSON.stringify(state));
  const budget = await openExecutionBudget(root);
  assert.equal(budget.state.unknownUsageInvocations, 1);
  assert.equal(budget.state.invocations.interrupted.unknownTokens, 32_000);
  assert.equal(budget.state.reservations!.evaluation.tokensRemaining, 20_000);
  assert.equal(budget.state.reservations![decision.reservationId!].authorizedActiveMs, 120_000);
  assert.equal(budget.state.reservations![decision.reservationId!].invocationEstimate!.activeMs, 30_000);
  assert.deepEqual(await budget.admitAssistance(request), decision);
  assert.equal((await budget.admitAssistance({ ...request, requestId: "renamed" })).reason, "window-used");
  await assert.rejects(budget.closeReservation(decision.reservationId!), /interrupted/);
});

test("persisted batch authority validates its bound and binding while old authorizations remain unchanged", async () => {
  for (const variant of ["legacy", "over-ceiling", "mismatched", "remaining-over-authority", "required-authority"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-authority-"));
    const directory = path.join(root, ".flywheel/runtime");
    await mkdir(directory, { recursive: true });
    const state = createExecutionBudgetState();
    const { ExecutionBudget } = await import("../../src/session/execution-budget.ts");
    const seed = new ExecutionBudget(state, async () => {});
    await seed.reserveRequiredWork("evaluation", { tokens: 20_000, activeMs: 40_000, source: "frozen-config" });
    const decision = await seed.admitAssistance({ requestId: "batch", windowId: "prepare", binding: "hash", childCount: 1, requiredReservationId: "evaluation" });
    const reservation = state.reservations![decision.reservationId!]!;
    if (variant === "legacy") {
      delete reservation.authorizedActiveMs;
      delete state.assistance!.decisions.batch.authorizedActiveMs;
      reservation.activeMsRemaining = 60_000;
    } else if (variant === "over-ceiling") reservation.authorizedActiveMs = 120_001;
    else if (variant === "mismatched") delete state.assistance!.decisions.batch.authorizedActiveMs;
    else if (variant === "required-authority") state.reservations!.evaluation.authorizedActiveMs = 120_000;
    else reservation.activeMsRemaining = 120_001;
    await writeFile(path.join(directory, "execution-budget.json"), JSON.stringify(state));
    if (variant === "legacy") {
      const restored = await openExecutionBudget(root);
      assert.equal(restored.state.reservations![decision.reservationId!].authorizedActiveMs, undefined);
      assert.equal(restored.remainingActiveMs(decision.reservationId), 60_000);
    } else await assert.rejects(openExecutionBudget(root), /reservations are invalid/);
  }
});

test("legacy disk budgets never acquire optional authority and damaged reservations fail closed", async () => {
  for (const damage of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-budget-schema-"));
    const directory = path.join(root, ".flywheel/runtime");
    await mkdir(directory, { recursive: true });
    const saved = createExecutionBudgetState();
    delete saved.assistance;
    if (damage) saved.reservations = { broken: { kind: "required", estimate: { tokens: 1, activeMs: 1, source: "config" }, tokensRemaining: 2, activeMsRemaining: 1 } };
    await writeFile(path.join(directory, "execution-budget.json"), JSON.stringify(saved));
    if (damage) await assert.rejects(openExecutionBudget(root), /reservations are invalid/);
    else {
      const budget = await openExecutionBudget(root);
      assert.equal(budget.state.assistance, undefined);
      assert.equal((await budget.admitAssistance({ requestId: "x", windowId: "prepare", binding: "h", childCount: 1, requiredReservationId: "e" })).reason, "legacy-budget");
    }
  }
});
