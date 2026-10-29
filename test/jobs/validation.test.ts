import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { JobSpec } from "../../src/services/agent/job-protocol.ts";
import {
  validateJobSpec,
  validateJobResult,
} from "../../src/services/agent/job-validation.ts";
import { validateLifecycleAction } from "../../src/capabilities/run/validation.ts";
import { promptAsset } from "../../src/services/prompt/index.ts";

async function fixture(): Promise<{ root: string; output: string; spec: JobSpec }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-job-protocol-"));
  const output = path.join(root, "output");
  await mkdir(output);
  return {
    root,
    output,
    spec: {
      operation: "tasking",
      label: "generic-job",
      cwd: root,
      tools: ["Read", "Write"],
      readRoots: [root],
      writeRoots: [output],
      prompt: promptAsset("test.job"),
    },
  };
}

test("JobSpec validation enforces only generic path boundaries", async () => {
  const { root, spec } = await fixture();
  assert.equal(validateJobSpec(spec), spec);
  assert.throws(() => validateJobSpec({
    ...spec,
    writeRoots: [path.join(root, "..", "outside")],
  }), /escapes cwd/);
  assert.throws(() => validateJobSpec({
    ...spec,
    resultPath: path.join(root, "not-writable", "result.json"),
  }), /outside writeRoots/);
});

test("JobSpec rejects a root whose existing symlink ancestor escapes cwd", async () => {
  const { root, spec } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "flywheel-job-outside-"));
  await symlink(outside, path.join(root, "linked"), "junction");
  assert.throws(() => validateJobSpec({
    ...spec,
    writeRoots: [path.join(root, "linked", "future-output")],
  }), /escapes cwd/);
});

test("completed JobResult requires real artifacts inside write roots", async () => {
  const { output, spec } = await fixture();
  const artifact = path.join(output, "report.any");
  await writeFile(artifact, "opaque");
  assert.deepEqual(await validateJobResult({
    status: "completed", artifacts: [artifact], message: "done",
  }, spec), {
    status: "completed", artifacts: [artifact], message: "done",
  });
  await assert.rejects(validateJobResult({
    status: "completed", artifacts: [path.join(output, "missing")],
  }, spec));
  await assert.rejects(validateJobResult({
    status: "completed", artifacts: [path.join(spec.cwd, "outside.json")],
  }, spec), /outside write roots/);
});

test("failed is a valid JobResult and does not pretend an artifact exists", async () => {
  const { output, spec } = await fixture();
  assert.deepEqual(await validateJobResult({
    status: "failed",
    artifacts: [path.join(output, "diagnostic-that-may-not-exist.json")],
    message: "the task could not be completed",
  }, spec), {
    status: "failed",
    artifacts: [path.join(output, "diagnostic-that-may-not-exist.json")],
    message: "the task could not be completed",
  });
  await assert.rejects(validateJobResult({
    status: "failed",
    artifacts: [],
  }, spec), /user-routable message/);
  await assert.rejects(validateJobResult({
    status: "needs_input",
    artifacts: [],
    message: "   ",
  }, spec), /user-routable message/);
});

test("Run lifecycle action validation accepts only bounded actions", () => {
  for (const decision of ["promote", "iterate", "stop", "ask_user", "rollback"] as const) {
    assert.equal(validateLifecycleAction(decision), decision);
  }
  assert.throws(() => validateLifecycleAction("change_evaluator"), /Lifecycle action/);
});
