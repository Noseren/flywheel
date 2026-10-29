import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentJobResult, AgentService } from "../../../src/services/agent/protocol.ts";
import { InitCapability as DefaultInitCapability } from "../../../src/capabilities/init/capability.ts";
import { validateInitContract } from "../../../src/capabilities/init/artifacts.ts";
import { DEFAULT_INIT_POLICY_REVISION } from "../../../src/capabilities/init/policy.ts";
import { inspectInit } from "../../../src/capabilities/init/inspector.ts";
import type { JobResult, JobSpec } from "../../../src/services/agent/job-protocol.ts";
import type { PromptRequest } from "../../../src/services/prompt/index.ts";
import { loadProject } from "../../../src/capabilities/run/project.ts";
import { runCapability } from "../../../src/session/runner.ts";
import { InitIntakeStore } from "../../../src/capabilities/init/intake.ts";

// These fixtures exercise the persisted legacy approval and evaluator-review path.
class InitCapability extends DefaultInitCapability {
  constructor(options: ConstructorParameters<typeof DefaultInitCapability>[0]) {
    super({ ...options, workflow: "legacy" });
  }
}

function variable(prompt: PromptRequest, key: string): unknown {
  const direct = prompt.variables?.[key];
  if (direct !== undefined) return direct;
  for (const value of Object.values(prompt.variables ?? {})) {
    if (value && typeof value === "object" && "kind" in value) {
      const nested = variable(value as PromptRequest, key);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

async function result(job: JobSpec, value: JobResult): Promise<void> {
  if (!job.resultPath) return;
  await mkdir(path.dirname(job.resultPath), { recursive: true });
  await writeFile(job.resultPath, `${JSON.stringify(value)}\n`);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-init-kernel-"));
  await writeFile(path.join(root, "prompt.txt"), "Answer clearly.\n");
  return root;
}

class InitAgent implements AgentService {
  provider = "test";
  model = "test";
  jobs: JobSpec[] = [];
  contractAttempts = 0;
  evaluatorAttempts = 0;
  evaluatorReviewAttempts = 0;
  evaluatorReviewRepairAttempts = 0;
  failFirstContract = false;
  incompleteCoverageFirst = false;
  rejectFirstEvaluatorReview = false;
  mechanicallyInvalidFirstReviewRepair = false;
  mechanicallyInvalidFirstReviewerOutput = false;
  protocolInvalidFirstReviewRepair = false;
  wrongTaskRoleFirst = false;
  wrongBoundaryRoleFirst = false;
  staleSamplePathsFirst = false;
  topLevelForbiddenFirst = false;
  failSmoke = false;
  abortSmokeOnce = false;
  abortEvaluatorOnce = false;
  repairInterruptedManifest = false;
  smokeFailuresRemaining = 0;
  managerAction: "stay_paused" | "resume" = "stay_paused";
  conversationAction: "answer" | "retry" = "answer";
  opaqueEvaluator = "print('opaque evaluator')\n";

  async execute(job: JobSpec): Promise<AgentJobResult> {
    this.jobs.push(job);
    let smokeFailed = false;
    let protocolIssues: string[] | undefined;
    if (job.label.startsWith("init:explore")) {
      await mkdir(path.join(job.cwd, ".flywheel", "init"), { recursive: true });
      await writeFile(path.join(job.cwd, ".flywheel", "init", "context_card.md"), "# Context\nPrompt artifact.\n");
    } else if (job.label.startsWith("init:plan")) {
      const dir = path.join(job.cwd, ".flywheel", "init");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "proposal.md"), "# 初始化方案\n优化 prompt.txt；使用独立 train/holdout；由 evaluator 解释评价。\n");
      await writeFile(path.join(dir, "proposal.json"), `${JSON.stringify({
        artifactPath: "prompt.txt",
        documentPath: ".flywheel/init/proposal.md",
        userFacingSummary: "目标：改善回复质量。\n评价：用公开样例和独立评价验证实际回复。",
      })}\n`);
    } else if (job.label.startsWith("init:contract")) {
      this.contractAttempts += 1;
      await this.writeContract(
        job,
        this.failFirstContract && this.contractAttempts === 1 ? "other.txt" : "prompt.txt",
        {
          wrongTaskRole: this.wrongTaskRoleFirst && this.contractAttempts === 1,
          wrongBoundaryRole: this.wrongBoundaryRoleFirst && this.contractAttempts === 1,
          staleSamplePaths: this.staleSamplePathsFirst && this.contractAttempts === 1,
          topLevelForbidden: this.topLevelForbiddenFirst && this.contractAttempts === 1,
        },
      );
    } else if (job.label.startsWith("init:evaluator")) {
      this.evaluatorAttempts += 1;
      if (this.abortEvaluatorOnce) {
        this.abortEvaluatorOnce = false;
        this.repairInterruptedManifest = true;
        await writeFile(path.join(job.cwd, ".flywheel", "contract", "manifest.json"), '{"schemaVersion":2,"artifacts":[]');
        throw new DOMException("interrupted while writing evaluator manifest", "AbortError");
      }
      if (this.repairInterruptedManifest) {
        this.repairInterruptedManifest = false;
        const manifestPath = path.join(job.cwd, ".flywheel", "contract", "manifest.json");
        const interruptedManifest = await readFile(manifestPath, "utf8");
        assert.throws(() => JSON.parse(interruptedManifest));
        await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2, files: [
          ["task", "task.md"], ["boundary", "boundary.json"],
          ["tasking-guide", "tasking_guide.md"], ["requirements", "requirements.json"],
        ].map(([id, file]) => ({ id, path: `.flywheel/contract/${file}` })) }));
      }
      await this.writeEvaluator(job, this.incompleteCoverageFirst && this.evaluatorAttempts === 1);
      if (job.label === "init:evaluator:repair" && this.evaluatorReviewAttempts > 0) {
        this.evaluatorReviewRepairAttempts += 1;
        if (this.protocolInvalidFirstReviewRepair && this.evaluatorReviewRepairAttempts === 1) {
          protocolIssues = ["failed JobResult requires a non-empty message"];
        }
        if (this.mechanicallyInvalidFirstReviewRepair && this.evaluatorReviewRepairAttempts === 1) {
          await this.writeMechanicallyInvalidCoverage(job);
        }
      }
    } else if (job.label.startsWith("init:review-evaluator")) {
      if (job.label === "init:review-evaluator") this.evaluatorReviewAttempts += 1;
      await this.writeEvaluatorReview(job, this.rejectFirstEvaluatorReview && this.evaluatorReviewAttempts === 1);
      if (job.label === "init:review-evaluator" && this.mechanicallyInvalidFirstReviewerOutput
        && this.evaluatorReviewAttempts === 1) await this.writeStaleEvaluatorReviewLocator(job);
    } else if (job.label.startsWith("init:smoke")) {
      if (this.abortSmokeOnce) {
        this.abortSmokeOnce = false;
        throw new DOMException("user interrupted smoke", "AbortError");
      }
      smokeFailed = this.failSmoke || this.smokeFailuresRemaining > 0;
      if (this.smokeFailuresRemaining > 0) this.smokeFailuresRemaining -= 1;
      const report = path.join(job.writeRoots[0], "report.md");
      await mkdir(job.writeRoots[0], { recursive: true });
      await writeFile(report, "# Smoke\nTasking and evaluator were executed. Baseline is admissible.\n");
      await result(job, smokeFailed
        ? { status: "failed", artifacts: [], message: "contract needs repair" }
        : { status: "completed", artifacts: [report] });
    } else if (job.label === "init:confirm-proposal" || job.label === "init:confirm-smoke") {
      const decisionPath = variable(job.prompt, "decision_path") as string;
      await mkdir(path.dirname(decisionPath), { recursive: true });
      await writeFile(decisionPath, JSON.stringify({ action: this.conversationAction, message: "请澄清这条回复的指向。" }));
    } else if (job.label === "init:manager") {
      await job.onEvent?.({ sdkEvent: "thread.started", thread_id: "session-manager" });
      await job.onEvent?.({ sdkEvent: "message.completed", text: "manager explanation" });
      const decisionPath = variable(job.prompt, "decision_path");
      assert.equal(typeof decisionPath, "string");
      await mkdir(path.dirname(decisionPath as string), { recursive: true });
      await writeFile(decisionPath as string, JSON.stringify({
        action: this.managerAction,
        message: "契约试运行失败，已保留上下文；不会重复询问用户。",
      }));
    }
    return {
      status: smokeFailed || protocolIssues ? "failed" : "completed",
      artifacts: [],
      ...(smokeFailed ? { message: "contract needs repair" } : {}),
      ...(protocolIssues ? { protocolIssues } : {}),
      sessionId: `session-${job.sessionKey ?? job.label}`,
    };
  }

  private async writeContract(
    job: JobSpec,
    artifactPath: string,
    options: {
      wrongTaskRole: boolean;
      wrongBoundaryRole: boolean;
      staleSamplePaths: boolean;
      topLevelForbidden: boolean;
    } = {
      wrongTaskRole: false,
      wrongBoundaryRole: false,
      staleSamplePaths: false,
      topLevelForbidden: false,
    },
  ): Promise<void> {
    const root = job.writeRoots[0];
    const contractRoot = root;
    await mkdir(contractRoot, { recursive: true });
    if (artifactPath === "other.txt") await writeFile(path.join(job.cwd, "other.txt"), "other\n");
    const files: Array<[string, string, string]> = [
      ["task", options.wrongTaskRole ? "contract/task.md" : "task.md", "# Goal\nImprove the prompt using independent evaluation.\n"],
      ["boundary", options.wrongBoundaryRole ? "contract/boundary.json" : "boundary.json", `${JSON.stringify({
        schemaVersion: 1,
        artifact: { path: artifactPath },
        ...(options.staleSamplePaths ? { sample_sets: {
          train: { path: ".flywheel/data/train.jsonl" },
          holdout: { path: ".flywheel/data/holdout.jsonl" },
        } } : {}),
        change_scope: {
          primary: ["prompt.txt"],
          ...(!options.topLevelForbidden ? { forbidden: ["samples.jsonl"] } : {}),
        },
        ...(options.topLevelForbidden ? { forbidden: ["samples.jsonl"] } : {}),
      }, null, 2)}\n`],
      ["tasking-guide", "tasking_guide.md", "# Tasking\nExecute the prompt.\n"],
      ["requirements", "requirements.json", `${JSON.stringify({ schemaVersion: 1, requirements: [
        { id: "R1", source: "goal", text: "Improve the prompt" },
      ] })}\n`],
    ];
    for (const [, relative, content] of files) {
      await mkdir(path.dirname(path.join(contractRoot, relative)), { recursive: true });
      await writeFile(path.join(contractRoot, relative), content);
    }
    const manifest = {
      schemaVersion: 2,
      files: files.map(([id, filePath]) => ({ id, path: `.flywheel/contract/${filePath}` })),
    };
    await writeFile(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await result(job, {
      status: "completed",
      artifacts: [path.join(root, "manifest.json"), ...files.map(([, relative]) => path.join(contractRoot, relative))],
    });
  }

  private async writeEvaluator(job: JobSpec, incompleteCoverage = false): Promise<void> {
    const root = job.writeRoots[0];
    await mkdir(path.join(root, "data"), { recursive: true });
    const additions: Array<[string, string, string]> = [
      ["evaluate-guide", "evaluate_guide.md", "# Evaluate\nEvaluate R1 with executable evidence.\n"],
      ["coverage", "coverage.json", `${JSON.stringify({
        schemaVersion: 1,
        checks: incompleteCoverage
          ? [{ id: "check-other", requirementIds: ["UNKNOWN"], artifactIds: ["evaluator"], locator: "evaluator#unknown" }]
          : [{ id: "check-r1", requirementIds: ["R1"], artifactIds: ["evaluator", "train"], locator: "train#train-1" }],
      })}\n`],
      ["evaluator", "evaluate.py", this.opaqueEvaluator],
      ["train", "data/train.jsonl", '{"id":"train-1","payload":{"x":1}}\n'],
      ["holdout", "data/holdout.jsonl", '{"id":"holdout-1","payload":{"x":2}}\n'],
    ];
    for (const [, relative, content] of additions) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), content);
    }
    const manifestPath = path.join(root, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const additionIds = new Set(additions.map(([id]) => id));
    manifest.files = manifest.files.filter((item: { id: string }) => !additionIds.has(item.id));
    manifest.files.push(...additions.map(([id, filePath]) => ({ id, path: `.flywheel/contract/${filePath}` })));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await result(job, {
      status: "completed",
      artifacts: [manifestPath, ...additions.map(([, relative]) => path.join(root, relative))],
    });
  }

  private async writeMechanicallyInvalidCoverage(job: JobSpec): Promise<void> {
    await writeFile(path.join(job.writeRoots[0], "coverage.json"), `${JSON.stringify({
      schemaVersion: 1,
      checks: [{
        id: "check-r1",
        requirementIds: ["R1"],
        artifactIds: ["evaluator"],
        locator: "evaluator#missing-selector",
      }],
    })}\n`);
  }

  private async writeEvaluatorReview(job: JobSpec, reject = false): Promise<void> {
    const root = job.writeRoots[0];
    const contract = path.join(job.cwd, ".flywheel", "contract");
    const requirements = JSON.parse(await readFile(path.join(contract, "requirements.json"), "utf8")) as {
      requirements: Array<{ id: string }>;
    };
    const coverage = JSON.parse(await readFile(path.join(contract, "coverage.json"), "utf8")) as {
      checks: Array<{ requirementIds: string[]; locator: string }>;
    };
    const locators = new Map(coverage.checks.map((check) => [check.requirementIds[0], check.locator]));
    const reviewPath = path.join(root, "review.json");
    await mkdir(root, { recursive: true });
    await writeFile(reviewPath, `${JSON.stringify({
      schemaVersion: 1,
      verdict: reject ? "repair" : "accepted",
      checks: requirements.requirements.map((requirement, index) => ({
        requirementId: requirement.id,
        locator: locators.get(requirement.id),
        status: reject && index === 0 ? "invalid" : "valid",
        reason: reject && index === 0
          ? "The exact evaluator call does not match the frozen project convention."
          : "The locator resolves to independent executable evidence with the project-native call shape.",
      })),
    }, null, 2)}\n`);
    await result(job, { status: "completed", artifacts: [reviewPath] });
  }

  private async writeStaleEvaluatorReviewLocator(job: JobSpec): Promise<void> {
    const reviewPath = path.join(job.writeRoots[0], "review.json");
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.checks[0].locator = "evaluate-guide#stale-locator";
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  }
}

async function reachSmoke(root: string, agent: InitAgent) {
  const capability = new InitCapability({ projectRoot: root, agent });
  const signal = new AbortController().signal;
  let state = await runCapability(capability, { type: "start" }, signal);
  assert.equal(state.pendingInteraction?.id, "init.confirm_proposal");
  state = await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.confirm_proposal", value: true },
  }, signal);
  return { capability, state };
}

test("interrupted evaluator resumes with an incomplete manifest but still rejects frozen spec changes", async () => {
  for (const tamper of [false, true]) {
    const root = await fixture();
    const agent = new InitAgent();
    agent.abortEvaluatorOnce = true;
    const { state } = await reachSmoke(root, agent);
    assert.equal(state.status, "paused");
    assert.equal(state.execution.currentOperationId, "generate_evaluator");
    if (tamper) await writeFile(path.join(root, ".flywheel", "contract", "task.md"), "changed frozen task\n");
    const resumed = await runCapability(new InitCapability({ projectRoot: root, agent }), { type: "resume" }, new AbortController().signal);
    if (tamper) {
      assert.equal(resumed.status, "blocked");
      assert.match(resumed.lastError ?? "", /Semantic contract changed/);
      assert.equal(agent.evaluatorAttempts, 1);
    } else {
      assert.equal(resumed.status, "waiting_for_user", resumed.lastError);
      assert.equal(resumed.pendingInteraction?.id, "init.validate_contract");
      assert.equal(agent.contractAttempts, 1);
      assert.equal(agent.evaluatorAttempts, 2);
    }
  }
});

test("Init sends short typed replies to Manager instead of treating them as shortcut confirmation", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const capability = new InitCapability({ projectRoot: root, agent });
  const signal = new AbortController().signal;
  await runCapability(capability, { type: "start" }, signal);
  for (const value of ["可以", "继续", "confirm"]) {
    const state = await runCapability(capability, { type: "command", command: {
      type: "interaction.respond", interactionId: "init.confirm_proposal", value, inputKind: "text",
    } }, signal);
    assert.equal(state.status, "waiting_for_user");
    assert.notEqual(state.answers.summaryConfirmed, true);
    assert.equal(variable(agent.jobs.at(-1)!.prompt, "user_input"), value);
    assert.equal(agent.jobs.at(-1)!.label, "init:confirm-proposal");
  }
  assert.equal(agent.contractAttempts, 0);
});

test("Init smoke typed action words require Manager interpretation and cannot approve or reset directly", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { capability } = await reachSmoke(root, agent);
  const smokeJobs = agent.jobs.filter((job) => job.label.startsWith("init:smoke")).length;
  for (const value of ["可以", "confirm", "retry", "revise"]) {
    const state = await runCapability(capability, { type: "command", command: {
      type: "interaction.respond", interactionId: "init.validate_contract", value, inputKind: "text",
    } }, new AbortController().signal);
    assert.equal(state.status, "waiting_for_user");
    assert.notEqual(state.answers.smokeConfirmed, true);
    assert.equal(agent.jobs.at(-1)!.label, "init:confirm-smoke");
    assert.equal(variable(agent.jobs.at(-1)!.prompt, "user_input"), value);
  }
  assert.equal(agent.jobs.filter((job) => job.label.startsWith("init:smoke")).length, smokeJobs);
  agent.conversationAction = "retry";
  const retried = await runCapability(capability, { type: "command", command: {
    type: "interaction.respond", interactionId: "init.validate_contract", value: "按原方案重新试运行", inputKind: "text",
  } }, new AbortController().signal);
  assert.equal(retried.status, "waiting_for_user");
  assert.notEqual(retried.answers.smokeConfirmed, true);
  assert.equal(agent.jobs.filter((job) => job.label.startsWith("init:smoke")).length, smokeJobs + 1);
});

test("brief preparation explores without a fake goal and freezes original intake before one confirmation", async () => {
  const root = await fixture();
  const base = new InitAgent();
  const events: string[] = [];
  const agent: AgentService = { execute: async job => {
    if (job.label !== "init:manager") return await base.execute(job);
    const messages = variable(job.prompt, "messages") as Array<{ id: string; text: string }>;
    const target = messages.filter(m => m.text.startsWith("  改善"));
    await job.onEvent?.({ sdkEvent: "thread.started", thread_id: "intake-manager-session" });
    await job.onEvent?.({ sdkEvent: "message.delta", itemId: "reply", delta: "收到" });
    await writeFile(variable(job.prompt, "decision_path") as string,
      JSON.stringify({ message: target.length ? "收到目标，正在确认评价方式。" : "你好，请说说目标。", goalMessageIds: target.map(m => m.id) }));
    return { status: "completed", artifacts: [], sessionId: "intake-manager-session" };
  } };
  const capability = new InitCapability({ projectRoot: root, agent, confirmationMode: "brief" });
  const signal = new AbortController().signal;
  const waiting = await runCapability(capability, { type: "start" }, signal);
  assert.equal(waiting.pendingInteraction?.id, "init.goal");
  await assert.rejects(readFile(path.join(root, ".flywheel", "goal.md")), { code: "ENOENT" });
  const originalGoal = "  改善客服回复，保留 ExactField。\n";
  await Promise.all(["你好", originalGoal].map(message => capability.conversation.receive({ message, signal,
    onEvent: async (type) => { events.push(type); } })));
  assert.equal((await new InitIntakeStore(root).load()).revision, 2);
  assert.ok(events.includes("job.event"));
  const proposal = await runCapability(capability, { type: "resume" }, signal);
  assert.equal(proposal.pendingInteraction?.id, "init.confirm_proposal");
  assert.equal(await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"), originalGoal);
  assert.equal(base.jobs.filter(j => j.label === "init:explore").length, 1);
  assert.equal(base.jobs.find(j => j.label === "init:plan")?.resumeSessionId, "intake-manager-session");
  assert.match(proposal.pendingInteraction?.description ?? "", /目标：改善回复质量/);
  assert.doesNotMatch(proposal.pendingInteraction?.description ?? "", /初始化方案|train\/holdout/);
  const completed = await runCapability(capability, { type: "command", command: {
    type: "interaction.respond", interactionId: "init.confirm_proposal", value: true,
  } }, signal);
  assert.equal(completed.status, "completed");
  assert.equal((await inspectInit(root)).status, "ready");
  assert.equal((await capability.history()).filter(e => e.type === "interaction.requested"
    && (e.data?.interaction as { id?: string })?.id === "init.validate_contract").length, 0);
  await assert.rejects(capability.conversation.receive({ message: "替换冻结目标", signal }), /sealed/);
});

test("historic review sessions retain their pending report confirmation when reopened by a brief entry", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { capability } = await reachSmoke(root, agent);
  const historic = await capability.store.load();
  delete historic.confirmationMode;
  await capability.store.save(historic);
  const reopened = new InitCapability({ projectRoot: root, agent, confirmationMode: "brief" });
  const state = await runCapability(reopened, { type: "resume" }, new AbortController().signal);
  assert.equal(state.confirmationMode, undefined);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.notEqual(state.answers.smokeConfirmed, true);
});

test("brief confirmation still blocks failed Smoke instead of creating a baseline", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.failSmoke = true;
  const capability = new InitCapability({ projectRoot: root, agent, confirmationMode: "brief", initialGoal: "Improve actual replies." });
  const signal = new AbortController().signal;
  await runCapability(capability, { type: "start" }, signal);
  const state = await runCapability(capability, { type: "command", command: {
    type: "interaction.respond", interactionId: "init.confirm_proposal", value: true,
  } }, signal);
  assert.equal(state.status, "blocked");
  assert.notEqual(state.answers.smokeConfirmed, true);
  assert.notEqual((await inspectInit(root)).status, "ready");
});

test("brief preparation refreshes project facts after a source change while retaining the received goal", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const capability = new InitCapability({ projectRoot: root, agent, confirmationMode: "brief" });
  const signal = new AbortController().signal;
  await runCapability(capability, { type: "start" }, signal);
  const intake = new InitIntakeStore(root);
  const { draft, message } = await intake.receive("Improve the actual replies.");
  draft.goalMessageIds = [message.id];
  await intake.save(draft);
  await writeFile(path.join(root, "prompt.txt"), "Changed project facts while waiting for the user.\n");
  const state = await runCapability(capability, { type: "resume" }, signal);
  assert.equal(state.pendingInteraction?.id, "init.confirm_proposal");
  assert.equal(agent.jobs.filter(j => j.label === "init:explore").length, 2);
  assert.equal(await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"), message.text);
});

test("Init preserves the initial user goal and gives it to Explore and Manager", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const initialGoal = "Implement arrays, maps, closures, and continue from instruction.md.";
  const capability = new InitCapability({ projectRoot: root, agent, initialGoal });

  const state = await runCapability(capability, { type: "start" }, new AbortController().signal);

  assert.equal(state.answers.initialGoal, initialGoal);
  assert.equal(await readFile(path.join(root, ".flywheel", "goal.md"), "utf8"), `${initialGoal}\n`);
  assert.equal(variable(agent.jobs.find((job) => job.label === "init:explore")!.prompt, "user_goal"), initialGoal);
  assert.equal(variable(agent.jobs.find((job) => job.label === "init:plan")!.prompt, "user_goal"), initialGoal);
  assert.equal(
    variable(agent.jobs.find((job) => job.label === "init:plan")!.prompt, "goal_path"),
    path.join(root, ".flywheel", "goal.md"),
  );
  assert.equal(state.pendingInteraction?.id, "init.confirm_proposal");
});

test("Init rejects mutation of the Runtime-owned original goal", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const initialGoal = "Keep ExactClass and exact_field unchanged.";
  const capability = new InitCapability({ projectRoot: root, agent, initialGoal });
  const signal = new AbortController().signal;
  const state = await runCapability(capability, { type: "start" }, signal);
  assert.equal(state.pendingInteraction?.id, "init.confirm_proposal");
  await writeFile(path.join(root, ".flywheel", "goal.md"), "changed\n");

  const blocked = await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.confirm_proposal", value: true },
  }, signal);

  assert.equal(blocked.status, "blocked");
  assert.match(blocked.lastError ?? "", /Frozen initialization goal changed/);
});

test("Init compiles an Agent-owned plan into hash-bound assets and v1", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { capability, state: smokeState } = await reachSmoke(root, agent);
  assert.equal(smokeState.pendingInteraction?.id, "init.validate_contract");
  const completed = await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.validate_contract", value: "confirm" },
  }, new AbortController().signal);
  assert.equal(completed.status, "completed");
  assert.equal((await inspectInit(root)).status, "ready");
  const manifest = JSON.parse(await readFile(path.join(root, ".flywheel", "init", "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.files.some((item: { id: string }) => item.id === "evaluator"), true);
  assert.equal(manifest.files.some((item: { id: string }) => item.id === "goal"), true);
  const approval = JSON.parse(await readFile(path.join(root, ".flywheel", "init", "APPROVED.json"), "utf8"));
  assert.match(approval.goalSha256, /^[a-f0-9]{64}$/);
  const contractJob = agent.jobs.find((job) => job.label === "init:contract")!;
  const evaluatorJob = agent.jobs.find((job) => job.label === "init:evaluator")!;
  const smokeJob = agent.jobs.find((job) => job.label === "init:smoke")!;
  assert.equal(variable(contractJob.prompt, "goal_path"), path.join(root, ".flywheel", "goal.md"));
  assert.equal(variable(contractJob.prompt, "proposal_ref_path"), path.join(root, ".flywheel", "init", "proposal.json"));
  assert.equal(variable(contractJob.prompt, "result_path"), contractJob.resultPath);
  assert.equal(variable(evaluatorJob.prompt, "requirements_path"), path.join(root, ".flywheel", "contract", "requirements.json"));
  assert.equal(variable(smokeJob.prompt, "goal_path"), path.join(root, ".flywheel", "goal.md"));
  const project = await loadProject(root);
  assert.equal(project.evaluatorPath, path.join(root, ".flywheel", "contract", "evaluate.py"));
  assert.equal("evaluate" in project.boundary, false);
});

test("Runtime does not parse evaluator, sample, rubric, or score semantics", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.opaqueEvaluator = "THIS IS DOMAIN-OWNED AND NOT A RUNTIME SCHEMA\n";
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.status, "waiting_for_user");
  assert.match(await readFile(path.join(root, ".flywheel", "contract", "evaluate.py"), "utf8"), /DOMAIN-OWNED/);
});

test("an incomplete requirement coverage map repairs in the independent Evaluator session", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.incompleteCoverageFirst = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  const repair = agent.jobs.find((job) => job.label === "init:evaluator:repair")!;
  assert.equal(repair.resumeSessionId, "session-evaluator");
  assert.equal(agent.jobs.filter((job) => job.label.startsWith("init:contract")).length, 1);
});

test("an independent Reviewer audits every evaluator requirement before Smoke", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  const reviewer = agent.jobs.find((job) => job.label === "init:review-evaluator")!;
  assert.equal(reviewer.sessionKey, "evaluator-review");
  assert.notEqual(reviewer.sessionKey, agent.jobs.find((job) => job.label === "init:evaluator")!.sessionKey);
  assert.equal(reviewer.writeRoots[0], path.join(root, ".flywheel", "init", "evaluator-review"));
  assert.equal(reviewer.writeRoots.includes(path.join(root, ".flywheel", "contract")), false);
  const review = JSON.parse(await readFile(path.join(reviewer.writeRoots[0], "review.json"), "utf8"));
  assert.equal(review.verdict, "accepted");
  assert.deepEqual(review.checks.map((check: { requirementId: string }) => check.requirementId), ["R1"]);
});

test("a semantic Reviewer rejection repairs the same Evaluator session and is reviewed again", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.rejectFirstEvaluatorReview = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.filter((job) => job.label === "init:review-evaluator").length, 2);
  const repair = agent.jobs.find((job) => job.label === "init:evaluator:repair")!;
  assert.equal(repair.resumeSessionId, "session-evaluator");
  assert.match(JSON.stringify(variable(repair.prompt, "issues")), /independent-evaluator-review/);
  assert.equal(agent.jobs.filter((job) => job.label.startsWith("init:contract")).length, 1);
});

test("a mechanically invalid post-Review repair stays in the Evaluator repair loop", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.rejectFirstEvaluatorReview = true;
  agent.mechanicallyInvalidFirstReviewRepair = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.filter((job) => job.label === "init:review-evaluator").length, 2);
  const repairs = agent.jobs.filter((job) => job.label === "init:evaluator:repair");
  assert.equal(repairs.length, 2);
  assert.equal(repairs.every((job) => job.resumeSessionId === "session-evaluator"), true);
  assert.match(JSON.stringify(variable(repairs[0].prompt, "issues")), /independent-evaluator-review/);
  assert.match(JSON.stringify(variable(repairs[1].prompt, "issues")), /post-review-mechanical-validation/);
  assert.match(JSON.stringify(variable(repairs[1].prompt, "issues")), /missing-selector/);
  assert.equal(state.lastError, undefined);
});

test("a mechanically invalid Reviewer result repairs in the same Reviewer session", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.rejectFirstEvaluatorReview = true;
  agent.mechanicallyInvalidFirstReviewerOutput = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  const reviewerRepair = agent.jobs.find((job) => job.label === "init:review-evaluator:repair")!;
  assert.equal(reviewerRepair.resumeSessionId, "session-evaluator-review");
  assert.match(JSON.stringify(variable(reviewerRepair.prompt, "issues")), /review-mechanical-validation/);
  assert.match(JSON.stringify(variable(reviewerRepair.prompt, "issues")), /exact coverage locator/);
  assert.equal(agent.jobs.filter((job) => job.label === "init:review-evaluator").length, 2);
  assert.equal(state.lastError, undefined);
});

test("a damaged post-Review Builder JobResult repairs in the same Evaluator session", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.rejectFirstEvaluatorReview = true;
  agent.protocolInvalidFirstReviewRepair = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  const repairs = agent.jobs.filter((job) => job.label === "init:evaluator:repair");
  assert.equal(repairs.length, 2);
  assert.equal(repairs.every((job) => job.resumeSessionId === "session-evaluator"), true);
  assert.match(JSON.stringify(variable(repairs[1].prompt, "issues")), /post-review-job-result-protocol/);
  assert.match(JSON.stringify(variable(repairs[1].prompt, "issues")), /non-empty message/);
  assert.equal(state.lastError, undefined);
});

test("coverage rejects grouping multiple frozen requirements behind one check", async () => {
  const root = await fixture();
  await reachSmoke(root, new InitAgent());
  const contract = path.join(root, ".flywheel", "contract");
  await writeFile(path.join(contract, "requirements.json"), `${JSON.stringify({
    schemaVersion: 1,
    requirements: [
      { id: "R1", source: "goal", text: "Improve the prompt" },
      { id: "R2", source: "proposal", text: "Preserve compatibility" },
    ],
  })}\n`);
  await writeFile(path.join(contract, "coverage.json"), `${JSON.stringify({
    schemaVersion: 1,
    checks: [{
      id: "check-grouped", requirementIds: ["R1", "R2"],
      artifactIds: ["evaluator"], locator: "evaluator#check-grouped",
    }],
  })}\n`);
  await assert.rejects(validateInitContract(root), /one known requirement/);
});

test("coverage requires a distinct artifact-prefixed locator per requirement", async () => {
  const root = await fixture();
  await reachSmoke(root, new InitAgent());
  const contract = path.join(root, ".flywheel", "contract");
  await writeFile(path.join(contract, "requirements.json"), `${JSON.stringify({
    schemaVersion: 1,
    requirements: [
      { id: "R1", source: "goal", text: "Improve the prompt" },
      { id: "R2", source: "proposal", text: "Preserve compatibility" },
    ],
  })}\n`);
  await writeFile(path.join(contract, "coverage.json"), `${JSON.stringify({
    schemaVersion: 1,
    checks: [
      { id: "check-r1", requirementIds: ["R1"], artifactIds: ["evaluator"], locator: "evaluator#shared" },
      { id: "check-r2", requirementIds: ["R2"], artifactIds: ["evaluator"], locator: "evaluator#shared" },
    ],
  })}\n`);
  await writeFile(path.join(contract, "evaluate.py"), "shared\n");
  await assert.rejects(validateInitContract(root), /unique artifact-prefixed locator/);
});

test("coverage locator selectors must exist verbatim in the referenced artifact", async () => {
  const root = await fixture();
  await reachSmoke(root, new InitAgent());
  const contract = path.join(root, ".flywheel", "contract");
  await writeFile(path.join(contract, "coverage.json"), `${JSON.stringify({
    schemaVersion: 1,
    checks: [{
      id: "check-r1", requirementIds: ["R1"], artifactIds: ["train"], locator: "train#invented-suffix",
    }],
  })}\n`);
  await assert.rejects(validateInitContract(root), /selector is not present/);
});

async function addFrozenCollector(contract: string): Promise<void> {
  await writeFile(path.join(contract, "collect.js"), "// frozen collector\n");
  await writeFile(path.join(contract, "collector_guide.md"), "Run collect.js with isolated caches.\n");
  const manifestPath = path.join(contract, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.push(
    { id: "collector", path: ".flywheel/contract/collect.js" },
    { id: "collector-guide", path: ".flywheel/contract/collector_guide.md" },
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("coverage v2 rejects an exact oracle without expected-value provenance", async () => {
  const root = await fixture();
  await reachSmoke(root, new InitAgent());
  const contract = path.join(root, ".flywheel", "contract");
  await addFrozenCollector(contract);
  await writeFile(path.join(contract, "coverage.json"), `${JSON.stringify({
    schemaVersion: 2,
    checks: [{
      id: "check-r1", requirementIds: ["R1"], artifactIds: ["evaluator"],
      locator: "evaluator#check-r1", oracle: { kind: "exact", expected: "first error" },
    }],
  })}\n`);
  await assert.rejects(validateInitContract(root), /oracle requires kind, source\.type\/source\.locator/);
});

test("coverage v2 accepts a mechanically complete semantic oracle while v1 remains compatible", async () => {
  const root = await fixture();
  await reachSmoke(root, new InitAgent());
  const contract = path.join(root, ".flywheel", "contract");
  await addFrozenCollector(contract);
  await writeFile(path.join(contract, "coverage.json"), `${JSON.stringify({
    schemaVersion: 2,
    checks: [{
      id: "check-r1", requirementIds: ["R1"], artifactIds: ["evaluator", "train"],
      locator: "train#train-1",
      oracle: {
        kind: "semantic",
        source: { type: "contract", locator: "requirements.json#R1" },
        derivation: "The goal does not determine a single exact output value.",
      },
    }],
  })}\n`);
  await validateInitContract(root);
});

test("a structurally invalid Contract result returns to the same Contract session", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.failFirstContract = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.status, "waiting_for_user");
  assert.equal(agent.jobs.some((job) => job.label === "init:contract:repair"), true);
  const repair = agent.jobs.find((job) => job.label === "init:contract:repair")!;
  assert.equal(repair.resumeSessionId, "session-contract");
});

test("a Contract role mapped away from the fixed Runtime entry is repaired before Smoke", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.wrongTaskRoleFirst = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.some((job) => job.label === "init:contract:repair"), true);
  assert.equal(agent.jobs.some((job) => job.label.startsWith("init:smoke")), true);
});

test("a boundary role mapped away from the fixed Runtime entry is repaired before Smoke", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.wrongBoundaryRoleFirst = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.some((job) => job.label === "init:contract:repair"), true);
  assert.equal(agent.jobs.some((job) => job.label.startsWith("init:smoke")), true);
});

test("sample paths are removed from boundary and manifest roles publish unchanged", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.staleSamplePathsFirst = true;
  const { capability, state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.some((job) => job.label === "init:contract:repair"), true);
  const completed = await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.validate_contract", value: "confirm" },
  }, new AbortController().signal);
  assert.equal(completed.status, "completed");
  const project = await loadProject(root);
  assert.equal(project.trainsetPath, path.join(root, ".flywheel", "contract", "data", "train.jsonl"));
  assert.equal(project.holdoutPath, path.join(root, ".flywheel", "contract", "data", "holdout.jsonl"));
  assert.equal(await readFile(project.trainsetPath!, "utf8"), '{"id":"train-1","payload":{"x":1}}\n');
});

test("a top-level forbidden field is repaired instead of being silently ignored", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.topLevelForbiddenFirst = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.some((job) => job.label === "init:contract:repair"), true);
  const boundary = JSON.parse(await readFile(path.join(root, ".flywheel", "contract", "boundary.json"), "utf8"));
  assert.equal(boundary.forbidden, undefined);
  assert.deepEqual(boundary.change_scope.forbidden, ["samples.jsonl"]);
});

test("task.md is natural language and evaluator identity comes only from manifest", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  const task = await readFile(path.join(root, ".flywheel", "contract", "task.md"), "utf8");
  assert.doesNotMatch(task, /```yaml|evaluate\.path|change_scope/);
  const boundary = JSON.parse(await readFile(path.join(root, ".flywheel", "contract", "boundary.json"), "utf8"));
  assert.equal(boundary.evaluate, undefined);
});

test("Init Manager discussion preserves the pending question and receives its full context", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { capability, state } = await reachSmoke(root, agent);
  const pending = structuredClone(state.pendingInteraction);
  assert.ok(pending);
  state.execution.operationState.managerGuidance = "旧指导：暂停等待外部输入";
  await capability.store.save(state);
  const jobsBefore = agent.jobs.length;
  const discussed = await runCapability(capability, {
    type: "intervene", message: "这个检查说明了什么？先不要继续。",
  }, new AbortController().signal);
  assert.equal(discussed.status, "paused");
  assert.deepEqual(discussed.pendingInteraction, pending);
  assert.equal(discussed.execution.operationState.managerGuidance, undefined);
  const jobs = agent.jobs.slice(jobsBefore);
  assert.deepEqual(jobs.map((job) => job.label), ["init:manager"]);
  const context = variable(jobs[0].prompt, "runtime_context") as Record<string, unknown>;
  assert.deepEqual(context.pendingInteraction, pending);
  assert.equal(context.previousGuidance, "旧指导：暂停等待外部输入");
});

test("a legal failed Smoke result is routed to Manager without duplicating the question", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.failSmoke = true;
  const { capability, state } = await reachSmoke(root, agent);
  assert.equal(state.status, "blocked");
  assert.match(state.lastError ?? "", /不会重复询问/);
  assert.equal(state.pendingInteraction, undefined);
  assert.equal(agent.jobs.filter((job) => job.label === "init:manager").length, 1);
  const managerEvents = (await capability.history()).filter((event) => event.data?.job === "initialization manager");
  assert.deepEqual(managerEvents.map((event) => event.type), [
    "job.started", "job.event", "job.event", "job.completed",
  ]);
});

test("a Smoke-discovered evaluation issue returns to Evaluator Agent before involving Manager", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.smokeFailuresRemaining = 1;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.status, "waiting_for_user");
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  assert.equal(agent.jobs.filter((job) => job.label === "init:evaluator:repair").length, 1);
  assert.equal(agent.jobs.filter((job) => job.label === "init:contract:repair").length, 0);
  assert.equal(agent.jobs.filter((job) => job.label === "init:smoke").length, 2);
  assert.equal(agent.jobs.filter((job) => job.label === "init:manager").length, 0);
});

test("an interrupted Smoke pauses without invoking Contract repair or Manager", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.abortSmokeOnce = true;
  const { state } = await reachSmoke(root, agent);
  assert.equal(state.status, "paused");
  assert.equal(state.lastError, "用户请求中断");
  assert.equal(agent.jobs.filter((job) => job.label === "init:contract:repair").length, 0);
  assert.equal(agent.jobs.filter((job) => job.label === "init:manager").length, 0);
});

test("a persisted older Init Policy safely reloads while waiting at contract validation", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { capability, state } = await reachSmoke(root, agent);
  assert.equal(state.pendingInteraction?.id, "init.validate_contract");
  const statePath = path.join(root, ".flywheel", "runtime", "init-state.json");
  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  persisted.execution.policy.revision = "2026-08-19.v10";
  await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
  const completed = await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.validate_contract", value: "confirm" },
  }, new AbortController().signal);
  assert.equal(completed.status, "completed");
  assert.equal(completed.execution.policy.revision, DEFAULT_INIT_POLICY_REVISION);
});

test("approval fails closed when the presented Smoke report is changed", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  agent.managerAction = "resume";
  const { capability, state } = await reachSmoke(root, agent);
  assert.equal(state.status, "waiting_for_user");
  await writeFile(path.join(root, ".flywheel", "init", "smoke", "report.md"), "tampered\n");
  const blocked = await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.validate_contract", value: "confirm" },
  }, new AbortController().signal);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.lastError ?? "", /changed after it was presented/);
  assert.equal(agent.jobs.filter((job) => job.label === "init:manager").length, 1);
  const response = (await capability.history()).find((event) => event.type === "manager.responded"
    && event.data?.source === "invariant_failure");
  assert.equal(response?.data?.action, "stay_paused");
  assert.equal(response?.data?.requestedAction, "resume");
});

test("inspector rejects a ready manifest whose frozen file hash no longer matches", async () => {
  const root = await fixture();
  const agent = new InitAgent();
  const { capability } = await reachSmoke(root, agent);
  await runCapability(capability, {
    type: "command",
    command: { type: "interaction.respond", interactionId: "init.validate_contract", value: "confirm" },
  }, new AbortController().signal);
  await writeFile(path.join(root, ".flywheel", "contract", "task.md"), "tampered\n");
  const inspection = await inspectInit(root);
  assert.equal(inspection.status, "invalid");
  assert.equal(inspection.problems.some((problem) => problem.includes("hash mismatch")), true);
});
