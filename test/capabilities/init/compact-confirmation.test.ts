import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InitCapability } from "../../../src/capabilities/init/capability.ts";
import { confirmProposalOperation } from "../../../src/capabilities/init/policy/operations.ts";
import { createDefaultInitExecutionPolicy } from "../../../src/capabilities/init/policy.ts";
import { validateJobSpec } from "../../../src/services/agent/job-validation.ts";
import { DefaultAgentService } from "../../../src/services/agent/service.ts";
import { PromptAssetStore } from "../../../src/services/prompt/index.ts";
import type { AgentJob } from "../../../src/services/agent/protocol.ts";

async function fixture(action: "confirm" | "answer" | "revise") {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-compact-confirm-"));
  await writeFile(path.join(root, "subject.txt"), "subject");
  const calls: AgentJob[] = [];
  const agent = new DefaultAgentService({ run: async job => {
    validateJobSpec(job);
    calls.push(job);
    assert.equal(job.sessionKey, undefined);
    assert.equal(job.resumeSessionId, undefined);
    assert.equal(job.readRoots.length, 3);
    assert.ok(!job.readRoots.includes(root));
    assert.ok(!job.writeRoots.includes(path.join(root, ".flywheel/init")));
    assert.ok(job.deniedPaths?.includes(path.join(root, ".flywheel/goal.md")));
    const decisionPath = job.prompt.match(/Decision file: ([^\r\n]+)/)?.[1];
    assert.ok(decisionPath);
    if (action === "revise") {
      await writeFile(job.readRoots[1], "Revised evaluation, still awaiting approval.");
      const reference = JSON.parse(await readFile(job.readRoots[2], "utf8"));
      reference.userFacingSummary = "修改后的公开评价方案，等待确认。";
      await writeFile(job.readRoots[2], JSON.stringify(reference));
    }
    await writeFile(decisionPath, JSON.stringify({ action, message: "Interpreted the actual user request." }));
    return { success: true, usage: { inputTokens: 1, outputTokens: 1 } };
  } }, new PromptAssetStore({ projectRoot: root }));
  const capability = new InitCapability({ projectRoot: root, agent, initialGoal: "Keep the original goal exactly.\r\n" });
  const state = await capability.createState();
  state.agentSessions = { manager: "huge-prior-manager-session" };
  state.proposal = { artifactPath: "subject.txt", documentPath: ".flywheel/init/proposal.md", userFacingSummary: "保持目标，执行公开检查。" };
  const signal = new AbortController().signal;
  const services = capability.services(state, signal);
  await services.workspace.writeText(path.join(root, state.proposal.documentPath), "Original evaluation proposal.");
  await services.workspace.writeJson(path.join(root, ".flywheel/init/proposal.json"), state.proposal);
  const context = { services, state, signal };
  const initial = await confirmProposalOperation(context);
  assert.equal(initial.status, "waiting_for_user");
  if (initial.status === "waiting_for_user") {
    assert.equal(initial.interaction.kind, "select");
    assert.equal(initial.interaction.options?.[0]?.value, "confirm");
  }
  return { ...context, root, calls };
}

test("compact explicit confirmation choice starts preparation without another model call", async () => {
  const context = await fixture("confirm");
  const result = await confirmProposalOperation({ ...context, command: { type: "interaction.respond", interactionId: "init.confirm_proposal", inputKind: "choice", value: "confirm" } });
  assert.equal(result.status, "completed");
  assert.equal(context.calls.length, 0);
  assert.equal(context.state.answers.summaryConfirmed, true);
  const next = createDefaultInitExecutionPolicy().decide({ state: context.state, policyState: {}, lastOutcome: { operationId: "confirm_proposal", status: "completed", data: result.data } });
  assert.deepEqual(next, { type: "run", operationId: "prepare_compact" });
});

test("compact natural confirmation uses a real scoped model invocation without prior Manager history", async () => {
  const context = await fixture("confirm");
  const result = await confirmProposalOperation({ ...context, command: { type: "interaction.respond", interactionId: "init.confirm_proposal", inputKind: "text", value: "That evaluation captures what I meant. Please proceed." } });
  assert.equal(result.status, "completed");
  assert.equal(context.calls.length, 1);
  assert.equal(context.state.answers.summaryConfirmed, true);
  assert.ok(context.calls[0].prompt.includes("That evaluation captures what I meant"));
  assert.equal(context.state.agentSessions?.manager, "huge-prior-manager-session");
});

for (const action of ["answer", "revise"] as const) test(`compact natural ${action} stays unapproved and preserves the frozen goal`, async () => {
  const context = await fixture(action);
  const result = await confirmProposalOperation({ ...context, command: { type: "interaction.respond", interactionId: "init.confirm_proposal", inputKind: "text", value: action === "answer" ? "Yes, but why is this check appropriate?" : "Use a stricter comparison before I approve." } });
  assert.equal(result.status, "waiting_for_user");
  assert.equal(context.calls.length, 1);
  assert.notEqual(context.state.answers.summaryConfirmed, true);
  assert.equal(context.state.answers.approvedProposalSha256, undefined);
  assert.equal(await readFile(path.join(context.root, ".flywheel/goal.md"), "utf8"), "Keep the original goal exactly.\r\n");
});
