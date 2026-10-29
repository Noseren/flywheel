import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PatchValidationError,
  validatePatchPlan,
} from "../../src/services/workspace/validation.ts";
import { validateChangedFiles, validateDeclaredAndActual } from "../../src/services/workspace/scope.ts";
import type { ChangeScope } from "../../src/services/workspace/protocol.ts";

async function fixture(): Promise<{ root: string; testset: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "flywheel-runtime-"));
  const root = path.join(base, "artifact");
  await mkdir(root);
  await writeFile(path.join(root, "main.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "helper.ts"), "export const y = 2;\n");
  const testset = path.join(root, "testset.jsonl");
  await writeFile(testset, '{"id":"s1","input":"x"}\n');
  return { root, testset };
}

test("workspace patch accepts a bounded modification", async () => {
  const { root, testset } = await fixture();
  const patch = await validatePatchPlan({
    modified_files: ["main.ts"], added_files: [], deleted_files: [],
  }, { root, protectedPaths: [testset], maxFiles: 5, maxAddedDeletedRatio: 0.5 });
  assert.deepEqual(patch.modified_files, ["main.ts"]);
});

test("workspace patch enforces caller-provided hard gates", async () => {
  const { root, testset } = await fixture();
  await assert.rejects(validatePatchPlan({
    modified_files: ["missing.ts", "main.ts", "helper.ts", "main.ts", "helper.ts", "main.ts"],
    added_files: ["main.ts", "new-a.ts", "new-b.ts"],
    deleted_files: ["../escape.ts", "testset.jsonl", "main.ts"],
  }, { root, protectedPaths: [testset], maxFiles: 5, maxAddedDeletedRatio: 0.5 }), (error: unknown) => {
    assert.ok(error instanceof PatchValidationError);
    const message = error.errors.join("\n");
    assert.match(message, /does not exist/);
    assert.match(message, /already exists/);
    assert.match(message, /escapes workspace root/);
    assert.match(message, /multiple lists/);
    assert.match(message, /protected path/);
    assert.match(message, /too many files/);
    assert.match(message, /ratio violation/);
    return true;
  });
});

test("workspace patch rejects an existing symlink that escapes the root", async () => {
  const { root, testset } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "flywheel-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(outside, path.join(root, "linked"), "junction");
  await assert.rejects(validatePatchPlan({
    modified_files: ["linked/secret.txt"], added_files: [], deleted_files: [],
  }, { root, protectedPaths: [testset] }), /escapes workspace root/);
});

test("candidate scope requires actual changes to be allowed and declared", () => {
  const change_scope: ChangeScope = {
    primary: ["src/capabilities/run/**"],
    auxiliary: ["test/**"],
    forbidden: ["src/capabilities/run/generated/**"],
  };
  const task = { change_scope };
  validateDeclaredAndActual(task, ["src/capabilities/run/capability.ts", "test/run.test.ts"], ["src/capabilities/run/capability.ts", "test/run.test.ts"]);
  assert.throws(() => validateDeclaredAndActual(task, ["src/capabilities/run/capability.ts"], ["src/capabilities/run/capability.ts", "README.md"]), /outside/);
  assert.throws(() => validateDeclaredAndActual(task, ["src/capabilities/run/capability.ts"], ["src/capabilities/run/capability.ts", "src/capabilities/run/policy.ts"]), /undeclared/);
});

test("a trailing slash in change scope authorizes the directory tree", () => {
  const boundary = {
    change_scope: {
      primary: ["src/"],
      forbidden: ["src/generated/"],
    },
  };

  assert.doesNotThrow(() => validateDeclaredAndActual(boundary, ["src/index.ts"], ["src/index.ts"]));
  assert.throws(
    () => validateDeclaredAndActual(boundary, ["src/generated/code.ts"], ["src/generated/code.ts"]),
    /forbidden/,
  );
});

test("a recursive glob includes files directly inside its base directory", () => {
  validateChangedFiles({
    change_scope: { primary: ["ark/json-schema/**/*.ts"] },
  }, [
    "ark/json-schema/object.ts",
    "ark/json-schema/__tests__/object.test.ts",
  ]);
});
