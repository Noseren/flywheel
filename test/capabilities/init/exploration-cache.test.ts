import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { explorationSourceFingerprint } from "../../../src/capabilities/init/exploration-cache.ts";

test("exploration cache ignores timestamp-only changes but detects same-size changed bytes with restored mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-fact-cache-"));
  const file = path.join(root, "source.txt");
  await writeFile(file, "before");
  const original = await stat(file);
  const before = await explorationSourceFingerprint(root);
  await utimes(file, new Date("2025-01-01"), new Date("2025-01-01"));
  assert.equal(await readFile(file, "utf8"), "before");
  assert.equal(await explorationSourceFingerprint(root), before, "Provider bookkeeping must not invalidate unchanged source facts");
  await writeFile(file, "after!");
  await utimes(file, original.atime, original.mtime);
  assert.notEqual(await explorationSourceFingerprint(root), before, "Restoring timestamps must not hide changed source bytes");
});

test("exploration cache excludes runtime bookkeeping and invalidates added business files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-fact-cache-"));
  await writeFile(path.join(root, "source.txt"), "source");
  const before = await explorationSourceFingerprint(root);
  await mkdir(path.join(root, ".flywheel"));
  await writeFile(path.join(root, ".flywheel", "state.json"), "runtime state");
  await mkdir(path.join(root, ".codex")); // Empty provider bookkeeping has no project content.
  assert.equal(await explorationSourceFingerprint(root), before);
  await writeFile(path.join(root, "new.txt"), "new public fact");
  assert.notEqual(await explorationSourceFingerprint(root), before);
});

test("exploration cache disables reuse for oversized files instead of reading unbounded data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-fact-cache-"));
  const file = path.join(root, "large.bin");
  await writeFile(file, "");
  await truncate(file, 8 * 1024 * 1024 + 1);
  assert.equal(await explorationSourceFingerprint(root), undefined);
});
