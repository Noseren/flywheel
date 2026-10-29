import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareCodexHome } from "../../src/services/agent/codex-home.ts";
import { CodexAgentAdapter } from "../../src/services/agent/codex-adapter.ts";

test("isolated home imports only the requested legacy session, including archived history, without replacing newer history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-home-test-"));
  try {
    const legacy = path.join(root, "legacy");
    const home = path.join(root, "isolated");
    await mkdir(path.join(legacy, "archived_sessions"), { recursive: true });
    await writeFile(path.join(legacy, "auth.json"), "test-auth");
    await writeFile(path.join(legacy, "config.toml"), "test-config");
    await writeFile(path.join(legacy, "archived_sessions", "rollout-old-requested.jsonl"), "old-history");
    await writeFile(path.join(legacy, "archived_sessions", "rollout-old-personal.jsonl"), "personal");
    await prepareCodexHome(home, legacy, "requested");
    assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), "test-auth");
    assert.deepEqual(await readdir(path.join(home, "sessions")), ["rollout-old-requested.jsonl"]);
    const imported = path.join(home, "sessions", "rollout-old-requested.jsonl");
    await writeFile(imported, "continued-history");
    await writeFile(path.join(home, "auth.json"), "refreshed-auth");
    await prepareCodexHome(home, legacy, "requested");
    assert.equal(await readFile(imported, "utf8"), "continued-history");
    assert.equal(await readFile(path.join(home, "auth.json"), "utf8"), "refreshed-auth");
    assert.equal(await readFile(path.join(legacy, "archived_sessions", "rollout-old-requested.jsonl"), "utf8"), "old-history");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex defaults to a persistent isolated home", () => {
  const adapter = new CodexAgentAdapter();
  assert.equal(adapter.codexHome, path.resolve(process.env.FLYWHEEL_CODEX_HOME ?? path.join(os.homedir(), ".flywheel", "codex")));
});

test("new jobs do not copy personal history and active legacy history is imported on resume", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-home-test-"));
  try {
    const legacy = path.join(root, "legacy");
    const home = path.join(root, "isolated");
    const sessions = path.join(legacy, "sessions", "2026", "10", "23");
    await mkdir(sessions, { recursive: true });
    await writeFile(path.join(sessions, "rollout-now-existing.jsonl"), "active-history");
    await prepareCodexHome(home, legacy);
    assert.deepEqual(await readdir(home), []);
    await prepareCodexHome(home, legacy, "existing");
    assert.equal(await readFile(path.join(home, "sessions", "rollout-now-existing.jsonl"), "utf8"), "active-history");
  } finally { await rm(root, { recursive: true, force: true }); }
});
