import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentExecutionError,
  ArtifactRepairExhausted,
  ArtifactValidationError,
  resetArtifactRepairBudget,
  runValidatedArtifact,
} from "../../src/services/artifact/index.ts";

test("validated artifact repairs in the original session and persists attempts", async () => {
  const operationState: Record<string, unknown> = {};
  const events: string[] = [];
  let artifact: { valid: boolean } | undefined;
  const value = await runValidatedArtifact({
    artifactId: "test.output", operationId: "test", job: "writer", operationState,
    present: async () => artifact !== undefined,
    validate: async () => {
      if (!artifact?.valid) throw new ArtifactValidationError({ code: "invalid", message: "invalid output" });
      return artifact;
    },
    classify: (error) => error instanceof ArtifactValidationError ? error.issues : undefined,
    execute: async ({ mode, resumeSessionId }) => {
      if (mode === "generate") artifact = { valid: false };
      else {
        assert.equal(resumeSessionId, "session-1");
        artifact = { valid: true };
      }
      return { status: "completed", artifacts: [], sessionId: "session-1" };
    },
    emit: async (type) => { events.push(type); }, checkpoint: async () => {},
  });

  assert.equal(value.valid, true);
  assert.deepEqual(events, [
    "artifact.generate.started", "artifact.generate.completed",
    "artifact.validation.failed", "artifact.repair.started",
    "artifact.repair.completed", "artifact.validation.passed",
  ]);
  assert.deepEqual((operationState.artifacts as Record<string, unknown>)["test.output"], {
    status: "validated", generationAttempts: 1, repairAttempts: 1, sessionId: "session-1",
  });
});

test("validated artifact only exhausts after bounded repairs", async () => {
  const operationState: Record<string, unknown> = {};
  let present = false;
  await assert.rejects(runValidatedArtifact({
    artifactId: "test.invalid", operationId: "test", job: "writer", operationState, maxRepairs: 2,
    present: async () => present,
    validate: async () => { throw new ArtifactValidationError({ code: "invalid", message: "still invalid" }); },
    classify: (error) => error instanceof ArtifactValidationError ? error.issues : undefined,
    execute: async () => { present = true; return { status: "completed", artifacts: [], sessionId: "session-1" }; },
    emit: async () => {}, checkpoint: async () => {},
  }), (error: unknown) => error instanceof ArtifactRepairExhausted && error.attempts === 2);
});

test("validated artifact does not send unclassified Runtime errors to the Agent", async () => {
  let executions = 0;
  await assert.rejects(runValidatedArtifact({
    artifactId: "test.runtime", operationId: "test", job: "writer", operationState: {},
    present: async () => true,
    validate: async () => { throw new Error("permission denied"); },
    classify: () => undefined,
    execute: async () => { executions += 1; return { status: "completed", artifacts: [] }; },
    emit: async () => {}, checkpoint: async () => {},
  }), /permission denied/);
  assert.equal(executions, 0);
});

test("an Agent execution failure stops immediately without consuming artifact repair attempts", async () => {
  const operationState: Record<string, unknown> = {};
  let executions = 0;
  await assert.rejects(runValidatedArtifact({
    artifactId: "test.infrastructure", operationId: "test", job: "writer", operationState,
    present: async () => false,
    validate: async () => true,
    classify: () => [{ code: "invalid", message: "invalid" }],
    execute: async () => {
      executions += 1;
      return { status: "failed", artifacts: [], message: "state database is read-only" };
    },
    emit: async () => {}, checkpoint: async () => {},
  }), (error: unknown) => error instanceof AgentExecutionError
    && /state database is read-only/.test(error.message));
  assert.equal(executions, 1);
  assert.deepEqual((operationState.artifacts as Record<string, unknown>)["test.infrastructure"], {
    status: "generating", generationAttempts: 0, repairAttempts: 0, lastIssues: [],
  });
});

test("a user retry resumes a failed generation with the original task", async () => {
  const operationState: Record<string, unknown> = {};
  let artifact: { valid: boolean } | undefined;
  let executions = 0;
  const options = () => ({
    artifactId: "test.failed", operationId: "test", job: "writer", operationState,
    present: async () => artifact !== undefined,
    validate: async () => {
      if (!artifact?.valid) throw new ArtifactValidationError({ code: "invalid", message: "incomplete output" });
      return artifact;
    },
    classify: (error: unknown) => error instanceof ArtifactValidationError ? error.issues : undefined,
    execute: async ({ mode, resumeSessionId }: { mode: "generate" | "repair"; resumeSessionId?: string }) => {
      executions += 1;
      assert.equal(mode, "generate");
      if (executions === 1) {
        assert.equal(resumeSessionId, undefined);
        artifact = { valid: false };
        return { status: "failed" as const, artifacts: [], sessionId: "session-1", message: "incomplete" };
      }
      assert.equal(resumeSessionId, "session-1");
      artifact = { valid: true };
      return { status: "completed" as const, artifacts: [], sessionId: "session-1" };
    },
    emit: async () => {}, checkpoint: async () => {},
  });

  await assert.rejects(runValidatedArtifact(options()), AgentExecutionError);
  // A previous Runtime may already have mislabeled the uncompleted attempt as a repair.
  ((operationState.artifacts as Record<string, { status: string }>)["test.failed"]).status = "repairing";
  const value = await runValidatedArtifact(options());
  assert.equal(value.valid, true);
  assert.equal(executions, 2);
});

test("validated artifact resumes repair from persisted state after restart", async () => {
  const operationState: Record<string, unknown> = {
    artifacts: {
      "test.resume": {
        status: "repairing", generationAttempts: 1, repairAttempts: 1,
        sessionId: "persisted-session", lastIssues: [{ code: "invalid", message: "old error" }],
      },
    },
  };
  let valid = false;
  await runValidatedArtifact({
    artifactId: "test.resume", operationId: "test", job: "writer", operationState,
    present: async () => true,
    validate: async () => {
      if (!valid) throw new ArtifactValidationError({ code: "invalid", message: "still invalid" });
      return true;
    },
    classify: (error) => error instanceof ArtifactValidationError ? error.issues : undefined,
    execute: async ({ mode, attempt, resumeSessionId }) => {
      assert.equal(mode, "repair");
      assert.equal(attempt, 2);
      assert.equal(resumeSessionId, "persisted-session");
      valid = true;
      return { status: "completed", artifacts: [], sessionId: resumeSessionId };
    },
    emit: async () => {}, checkpoint: async () => {},
  });
});

test("a user-requested retry resets repair budget without losing the original session", () => {
  const operationState: Record<string, unknown> = {
    artifacts: {
      "test.retry": {
        status: "repairing", generationAttempts: 1, repairAttempts: 3,
        sessionId: "persisted-session", lastIssues: [{ code: "invalid", message: "old error" }],
      },
    },
  };

  resetArtifactRepairBudget(operationState);

  assert.deepEqual((operationState.artifacts as Record<string, unknown>)["test.retry"], {
    status: "repairing", generationAttempts: 1, repairAttempts: 0,
    sessionId: "persisted-session", lastIssues: [{ code: "invalid", message: "old error" }],
  });
});

test("validated artifacts keep parallel state isolated by artifact id", async () => {
  const operationState: Record<string, unknown> = {};
  const run = async (id: string) => {
    let valid = false;
    await runValidatedArtifact({
      artifactId: id, operationId: "parallel", job: id, operationState,
      present: async () => valid,
      validate: async () => {
        if (!valid) throw new ArtifactValidationError({ code: "invalid", message: id });
        return true;
      },
      classify: (error) => error instanceof ArtifactValidationError ? error.issues : undefined,
      execute: async () => { valid = true; return { status: "completed", artifacts: [], sessionId: `session-${id}` }; },
      emit: async () => {}, checkpoint: async () => {},
    });
  };
  await Promise.all([run("sample-a"), run("sample-b")]);
  const artifacts = operationState.artifacts as Record<string, { sessionId?: string }>;
  assert.equal(artifacts["sample-a"].sessionId, "session-sample-a");
  assert.equal(artifacts["sample-b"].sessionId, "session-sample-b");
});

test("an interrupted artifact attempt keeps its session without consuming retry budget", async () => {
  const operationState: Record<string, unknown> = {};
  await assert.rejects(runValidatedArtifact({
    artifactId: "test.abort", operationId: "test", job: "writer", operationState,
    present: async () => false,
    validate: async () => true,
    classify: () => [{ code: "invalid", message: "invalid" }],
    execute: async () => ({ status: "aborted", artifacts: [], sessionId: "interrupted-session" }),
    emit: async () => {}, checkpoint: async () => {},
  }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  const artifact = (operationState.artifacts as Record<string, {
    generationAttempts: number; repairAttempts: number; sessionId?: string;
  }>)["test.abort"];
  assert.equal(artifact.generationAttempts, 0);
  assert.equal(artifact.repairAttempts, 0);
  assert.equal(artifact.sessionId, "interrupted-session");
});
