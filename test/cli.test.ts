import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runProcess } from "../src/services/process/index.ts";

test("public help exits without reading goals, creating state, or launching the desktop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-help-"));
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  for (const args of [["--help"], ["-h"], ["help"], ["init", "--goal-file", "missing.md", "--help"], ["run", "--gui", "--help"], ["gui", "--help"]]) {
    const result = await runProcess(process.execPath, [cli, "--project", root, ...args], { cwd: root, timeoutMs: 10_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage: flywheel/);
    assert.match(result.stdout, /--init-only/);
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(root), []);
  }
});

test("developer help flags show developer commands without executing them", async () => {
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  for (const args of [["dev", "--help"], ["dev", "-h"], ["dev", "help"], ["dev", "init", "--gui", "--help"]]) {
    const result = await runProcess(process.execPath, [cli, ...args], { timeoutMs: 10_000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /flywheel dev check-init/);
    assert.equal(result.stderr, "");
  }
});

test("run reports an incomplete initialization without an ENOENT stack", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-preflight-"));
  const result = await runProcess(process.execPath, [
    path.resolve(import.meta.dirname, "..", "src", "cli.ts"),
    "--project", root,
    "run",
  ], { cwd: root, timeoutMs: 10_000 });

  assert.equal(result.code, 2);
  const response = JSON.parse(result.stderr);
  assert.equal(response.error, "Flywheel initialization is not complete");
  assert.equal(response.status, "not_initialized");
  assert.doesNotMatch(result.stderr, /ENOENT|node:internal/);
});

test("check-init is available only under the dev namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-check-init-"));
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  const publicResult = await runProcess(process.execPath, [cli, "--project", root, "check-init"], {
    cwd: root, timeoutMs: 10_000,
  });
  assert.notEqual(publicResult.code, 0);
  assert.match(publicResult.stderr, /Unknown argument: check-init/);

  const devResult = await runProcess(process.execPath, [cli, "dev", "--project", root, "check-init"], {
    cwd: root, timeoutMs: 10_000,
  });
  assert.equal(devResult.code, 2);
  assert.equal(JSON.parse(devResult.stdout).status, "not_initialized");
});

test("provider tuning is available only under the dev namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-provider-"));
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  const result = await runProcess(process.execPath, [
    cli, "--project", root, "--reasoning-effort", "high", "run",
  ], { cwd: root, timeoutMs: 10_000 });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /only available under `flywheel dev`/);
});

test("dev without a subcommand shows the developer command surface", async () => {
  const result = await runProcess(process.execPath, [
    path.resolve(import.meta.dirname, "..", "src", "cli.ts"), "dev",
  ], { timeoutMs: 10_000 });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /flywheel dev check-init/);
  assert.match(result.stdout, /flywheel dev prompts/);
  assert.match(result.stdout, /--observe-gui/);
});

test("GUI control and TUI observer modes are mutually exclusive", async () => {
  const result = await runProcess(process.execPath, [
    path.resolve(import.meta.dirname, "..", "src", "cli.ts"), "run", "--gui", "--observe-gui",
  ], { timeoutMs: 10_000 });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cannot be used together/);
});

test("max iterations must be a positive integer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-iterations-"));
  const result = await runProcess(process.execPath, [
    path.resolve(import.meta.dirname, "..", "src", "cli.ts"),
    "--project", root, "--max-iterations", "0", "run",
  ], { cwd: root, timeoutMs: 10_000 });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--max-iterations must be a positive integer/);
});

test("gui launcher does not silently ignore command-line goal settings", async () => {
  const result = await runProcess(process.execPath, [path.resolve(import.meta.dirname, "..", "src", "cli.ts"), "gui", "--max-iterations", "10"], { timeoutMs: 10_000 });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /enter the goal and iteration limit in the project page/);
});

test("init accepts a non-empty user goal file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-goal-"));
  const goal = path.join(root, "instruction.md");
  await writeFile(goal, "\n");
  const result = await runProcess(process.execPath, [
    path.resolve(import.meta.dirname, "..", "src", "cli.ts"),
    "--project", root, "--goal-file", goal, "init", "--init-only",
  ], { cwd: root, timeoutMs: 10_000 });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--goal-file must contain a non-empty user goal/);
});

test("compact budget flags reject invalid values and conflicting limits before touching a project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-budgets-"));
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  for (const flag of ["--max-attempts", "--max-active-ms", "--max-tokens"]) {
    const result = await runProcess(process.execPath, [cli, "--project", root, "init", flag, "9007199254740992", "--help"], { timeoutMs: 10_000 });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, new RegExp(`${flag} must be a positive safe integer`));
  }
  for (const args of [
    ["--max-attempts", "3", "--max-iterations", "4"],
    ["--max-iterations", "9007199254740992"],
  ]) {
    const result = await runProcess(process.execPath, [cli, "--project", root, "init", ...args, "--help"], { timeoutMs: 10_000 });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Use only one|safe integer range/);
  }
  const valid = await runProcess(process.execPath, [cli, "--project", root, "init", "--max-attempts", "2", "--max-active-ms", "5000", "--max-tokens", "20000", "--help"], { timeoutMs: 10_000 });
  assert.equal(valid.code, 0, valid.stderr);
  assert.match(valid.stdout, /persist across preparation, optimization and resume/);
  assert.deepEqual(await readdir(root), []);
});

test("legacy workflow cannot silently ignore compact budget caps", async () => {
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  for (const flag of ["--max-attempts", "--max-active-ms", "--max-tokens"]) {
    const result = await runProcess(process.execPath, [cli, "init", "--legacy-workflow", flag, "10", "--help"], { timeoutMs: 10_000 });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /require the compact workflow/);
  }
  const legacy = await runProcess(process.execPath, [cli, "init", "--legacy-workflow", "--max-iterations", "10", "--help"], { timeoutMs: 10_000 });
  assert.equal(legacy.code, 0, legacy.stderr);
});

test("all existing workflow markers require explicit legacy choice before init can start", async () => {
  const cli = path.resolve(import.meta.dirname, "..", "src", "cli.ts");
  for (const relative of [".flywheel/runtime/init-state.json", ".flywheel/runtime/state.json",
    ".flywheel/contract/manifest.json", ".flywheel/init/manifest.json"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-cli-legacy-"));
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    const original = JSON.stringify({ schemaVersion: 3, status: "paused" });
    await writeFile(file, original);
    const blocked = await runProcess(process.execPath, [cli, "--project", root, "init", "--init-only"], { timeoutMs: 10_000 });
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /--legacy-workflow/);
    assert.doesNotMatch(blocked.stderr, /requires a TTY/);
    assert.equal(await readFile(file, "utf8"), original);
    // Passing the opt-in reaches the terminal boundary, before any real model or state writes.
    const allowed = await runProcess(process.execPath, [cli, "--project", root, "init", "--init-only", "--legacy-workflow"], { timeoutMs: 10_000 });
    assert.match(allowed.stderr, /Interactive Flywheel session requires a TTY/);
    assert.equal(await readFile(file, "utf8"), original);
  }
});
