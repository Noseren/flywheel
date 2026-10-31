import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkedProcess } from "../../src/services/process/index.ts";
import type { Project } from "../../src/capabilities/run/project.ts";
import { VersionStore } from "../../src/services/version/index.ts";

function projectAt(root: string): Project {
  return {
    root,
    flywheelDir: path.join(root, ".flywheel"),
  } as Project;
}

async function write(root: string, relative: string, content = `${relative}\n`): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function treeFiles(store: VersionStore, tag: string): Promise<string[]> {
  const output = await checkedProcess("git", [
    `--git-dir=${store.historyDir}`, "ls-tree", "-r", "--name-only", tag,
  ]);
  return output.split(/\r?\n/).filter(Boolean).sort();
}

test("VersionStore prioritizes the project .gitignore and reapplies it for each snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-ignore-"));
  await write(root, ".gitignore", "custom-cache/\nnode_modules/\n!.flywheel/\n");
  await write(root, "src/index.ts");
  await write(root, "dist/output.js");
  await write(root, "custom-cache/result.json");
  await write(root, "node_modules/dependency/index.js");
  await write(root, ".flywheel/runtime/state.json", "{}\n");

  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "baseline");
  assert.deepEqual(await treeFiles(versions, "v1"), [
    ".gitignore",
    "dist/output.js",
    "src/index.ts",
  ]);

  await write(root, ".gitignore", "custom-cache/\nnode_modules/\ndist/\n!.flywheel/\n");
  await versions.tag("v2", "ignore dist");
  assert.deepEqual(await treeFiles(versions, "v2"), [
    ".gitignore",
    "src/index.ts",
  ]);
  await write(root, "dist/output.js", "ignored local change\n");
  await versions.assertExact("v2");
  assert.doesNotMatch(await versions.diff("v1", "v2"), /dist\/output\.js/);
});

test("VersionStore uses its default scope when the project has no .gitignore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-default-"));
  await write(root, "src/index.ts", "export const value = 1;\n");
  await write(root, "dist/output.js", "generated v1\n");
  await write(root, "node_modules/dependency/index.js");
  await write(root, "coverage/result.json");
  await write(root, ".cache/data.json");
  await write(root, ".env", "SECRET=local\n");
  await write(root, ".env.example", "SECRET=\n");
  await write(root, "debug.log");

  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "baseline");
  assert.deepEqual(await treeFiles(versions, "v1"), [
    ".env.example",
    "src/index.ts",
  ]);

  await write(root, "dist/output.js", "generated locally\n");
  await versions.assertExact("v1");
  await write(root, "src/stale.ts", "export const stale = true;\n");
  await versions.tag("v2", "add stale source");
  await versions.prepare("v1");

  assert.equal(await readFile(path.join(root, "dist/output.js"), "utf8"), "generated locally\n");
  await assert.rejects(readFile(path.join(root, "src/stale.ts"), "utf8"));
});

test("VersionStore private checkpoints restore an exact pre-Operation tree without creating a public tag", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-checkpoint-"));
  await write(root, "src/index.ts", "before\n");
  await write(root, "examples/中文.md", "before unicode\n");
  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "baseline");
  const checkpoint = await versions.createCheckpoint("operation-1");
  await write(root, "src/index.ts", "after\n");
  await write(root, "src/new.ts", "new\n");
  await write(root, "examples/中文.md", "after unicode\n");

  await assert.rejects(versions.assertCheckpoint(checkpoint));
  await versions.restoreCheckpoint(checkpoint);

  assert.equal(await readFile(path.join(root, "src/index.ts"), "utf8"), "before\n");
  assert.equal(await readFile(path.join(root, "examples/中文.md"), "utf8"), "before unicode\n");
  await assert.rejects(readFile(path.join(root, "src/new.ts"), "utf8"));
  assert.equal(await versions.hasTag("operation-1"), false);
  await versions.deleteCheckpoint(checkpoint);
});

test("VersionStore isolates a detached candidate worktree and promotes only the selected tree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-worktree-"));
  await write(root, "prompt.md", "baseline\n");
  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "baseline");
  const candidate = path.join(root, ".flywheel", "runs", "v1", "candidates", "h1", "worktree");

  await versions.createWorktree("v1", candidate);
  await writeFile(path.join(candidate, "prompt.md"), "improved\n");
  const changes = await versions.worktreeChanges(candidate);
  const candidateTreeHash = await versions.worktreeTreeHash(candidate);
  assert.deepEqual(changes.files, ["prompt.md"]);
  assert.match(changes.diff, /improved/);
  assert.equal(await readFile(path.join(root, "prompt.md"), "utf8"), "baseline\n");

  await versions.promoteWorktree(candidate, "v2", "promote h1");
  assert.equal(await versions.treeHash("v2"), candidateTreeHash);
  await versions.prepare("v2");
  assert.equal(await readFile(path.join(root, "prompt.md"), "utf8"), "improved\n");
  assert.equal(await versions.hasTag("v2"), true);
});

test("VersionStore preserves exact bytes through attributes, candidate promotion and checkpoint restore", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-bytes-"));
  await write(root, ".gitattributes", "* text eol=lf ident\n");
  await write(root, "nested/.gitattributes", "* text eol=crlf working-tree-encoding=UTF-16LE filter=required\n");
  const original = Buffer.from("frozen\r\n$Id$\r\n", "utf16le");
  await writeFile(path.join(root, "nested/frozen.txt"), original);
  const plain = Buffer.from("plain\r\n$Id$\r\n");
  await writeFile(path.join(root, "plain.txt"), plain);
  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "exact baseline");
  const checkpoint = await versions.createCheckpoint("byte-roundtrip");
  const candidate = path.join(root, ".flywheel", "candidate");
  await versions.createWorktree("v1", candidate);
  assert.deepEqual(await readFile(path.join(candidate, "nested/frozen.txt")), original);
  assert.deepEqual(await readFile(path.join(candidate, "plain.txt")), plain);
  assert.deepEqual((await versions.worktreeChanges(candidate)).files, []);
  const updated = Buffer.from("changed\r\n$Id$\r\n");
  await writeFile(path.join(candidate, "plain.txt"), updated);
  await versions.promoteWorktree(candidate, "v2", "exact candidate");
  await versions.prepare("v2");
  assert.deepEqual(await readFile(path.join(root, "plain.txt")), updated);
  assert.deepEqual(await readFile(path.join(root, "nested/frozen.txt")), original);
  await versions.restoreCheckpoint(checkpoint);
  assert.deepEqual(await readFile(path.join(root, "plain.txt")), plain);
  await versions.assertCheckpoint(checkpoint);
});

test("VersionStore preserves source-index tracked ignored files without collecting ignored secrets or caches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-source-index-"));
  await checkedProcess("git", ["init", root]);
  await write(root, ".gitignore", "fixtures/\n.env*\n.flywheel/\n");
  await write(root, "fixtures/tracked.txt", "staged source\n");
  await write(root, "fixtures/untracked.txt", "cache\n");
  await write(root, ".env", "SECRET=local\n");
  await write(root, ".flywheel/private.txt", "control\n");
  await checkedProcess("git", ["-C", root, "add", "--force", "fixtures/tracked.txt", ".env", ".flywheel/private.txt"]);
  const sourceIndex = await readFile(path.join(root, ".git/index"));
  await write(root, "fixtures/tracked.txt", "working source\r\n");
  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "source provenance");
  assert.deepEqual(await treeFiles(versions, "v1"), [".gitignore", "fixtures/tracked.txt"]);
  const candidate = path.join(root, ".flywheel/candidate");
  await versions.createWorktree("v1", candidate);
  assert.equal(await readFile(path.join(candidate, "fixtures/tracked.txt"), "utf8"), "working source\r\n");
  await write(root, "fixtures/tracked.txt", "modified\n");
  assert.deepEqual(await versions.changedFiles("v1"), ["fixtures/tracked.txt"]);
  await versions.tag("v2", "update tracked ignored source");
  assert.match(await versions.diff("v1", "v2"), /modified/);
  await versions.prepare("v1");
  assert.equal(await readFile(path.join(root, "fixtures/tracked.txt"), "utf8"), "working source\r\n");
  assert.equal(await readFile(path.join(root, "fixtures/untracked.txt"), "utf8"), "cache\n");
  assert.deepEqual(await readFile(path.join(root, ".git/index")), sourceIndex);
  await versions.assertExact("v1");
  await write(root, "fixtures/new.txt", "new tracked source\n");
  await checkedProcess("git", ["-C", root, "add", "--force", "fixtures/new.txt"]);
  assert.deepEqual(await versions.changedFiles("v1"), ["fixtures/new.txt"]);
  await versions.prepare("v1");
  await assert.rejects(readFile(path.join(root, "fixtures/new.txt")));
  await rm(path.join(root, "fixtures/tracked.txt"));
  assert.deepEqual(await versions.changedFiles("v1"), ["fixtures/tracked.txt"]);
  await versions.tag("v3", "delete tracked source");
  assert.deepEqual(await treeFiles(versions, "v3"), [".gitignore"]);
  await versions.prepare("v1");
  assert.equal(await readFile(path.join(root, "fixtures/tracked.txt"), "utf8"), "working source\r\n");
});

test("checkpoint worktrees preserve tracked ignored bytes, isolate writes and reject arbitrary refs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-checkpoint-worktree-"));
  await checkedProcess("git", ["init", root]);
  await write(root, ".gitignore", "fixtures/\n.flywheel/\n");
  await write(root, "fixtures/tracked.txt", "working bytes\r\n");
  await write(root, "fixtures/cache.txt", "ignored cache\n");
  await write(root, ".flywheel/goal.md", "private goal\n");
  await checkedProcess("git", ["-C", root, "add", "--force", "fixtures/tracked.txt"]);
  const versions = new VersionStore(projectAt(root));
  const ref = await versions.createCheckpoint("baseline");
  const subject = path.join(root, ".flywheel/subject");
  for (const invalid of ["HEAD", "v1", "refs/heads/main", `${ref}/nested`, `${ref}~1`]) {
    await assert.rejects(versions.createCheckpointWorktree(invalid, subject), /Invalid checkpoint ref/);
  }
  await versions.createCheckpointWorktree(ref, subject);
  assert.equal(await readFile(path.join(subject, "fixtures/tracked.txt"), "utf8"), "working bytes\r\n");
  await assert.rejects(readFile(path.join(subject, "fixtures/cache.txt")));
  await assert.rejects(readFile(path.join(subject, ".flywheel/goal.md")));
  assert.deepEqual((await versions.worktreeChanges(subject)).files, []);
  await write(subject, "fixtures/tracked.txt", "evaluator mutation\n");
  assert.deepEqual((await versions.worktreeChanges(subject)).files, ["fixtures/tracked.txt"]);
  await versions.assertCheckpoint(ref);
  assert.equal(await versions.hasTag("baseline"), false);
});

test("VersionStore does not inherit tracking provenance from an enclosing repository", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-parent-index-"));
  await checkedProcess("git", ["init", parent]);
  const root = path.join(parent, "project");
  await write(root, ".gitignore", "ignored.txt\n");
  await write(root, "ignored.txt", "parent tracked only\n");
  await checkedProcess("git", ["-C", parent, "add", "--force", "project/ignored.txt"]);
  const versions = new VersionStore(projectAt(root));
  await versions.tag("v1", "local scope only");
  assert.deepEqual(await treeFiles(versions, "v1"), [".gitignore"]);
});
