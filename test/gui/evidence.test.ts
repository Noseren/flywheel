import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { officialEvidence, resolveEvidenceFile } from "../../src/gui/evidence.ts";
import type { GuiTimelineEntry } from "../../src/gui/server.ts";

function entry(type: string, data: Record<string, unknown>, overrides = {}): GuiTimelineEntry {
  return { id: "event-1", timestamp: "2026-09-08T00:00:00Z", category: "runtime", kind: "event", actor: "Runtime", title: type,
    capabilityId: "run", raw: { type, version: "v2", data }, ...overrides };
}

test("official results require explicit validated lifecycle outcomes, not Agent claims or old events", () => {
  const records = officialEvidence([
    entry("job.event", { item: { text: "目标已达成", type: "agent_message" } }),
    entry("operation.completed", { operationId: "assess_target", status: "completed" }),
    entry("operation.completed", { operationId: "assess_target", status: "paused", result: { assessment: "__proto__", reportPath: ".flywheel/report.md" } }),
    entry("operation.completed", { operationId: "assess_target", status: "blocked", result: { assessment: "achieved", reportPath: ".flywheel/report.md" } }),
    entry("operation.completed", { operationId: "assess_target", status: "paused", result: { assessment: "inconclusive", reportPath: ".flywheel/report.md" } }),
    entry("operation.completed", { operationId: "select", status: "completed", result: { action: "promote", promotedVersion: "v3" } }),
  ]);
  assert.deepEqual(records.map((record) => [record.title, record.version]), [["现有证据不足以判定", "v2"], ["候选已晋升为正式版本", "v3"]]);
});

test("compact official candidate results require booleans and preserve event version and baseline aliases", () => {
  const records = officialEvidence([
    entry("operation.activity", { retained: "true", target: "achieved" }),
    entry("job.event", { retained: true, target: "achieved" }),
    entry("operation.activity", { retained: false, target: "achieved" }, { id: "rejected" }),
    entry("operation.activity", { retained: true, target: "achieved", version: "v999" }, { id: "retained" }),
    entry("operation.activity", { retained: true, target: "inconclusive" }, { id: "uncertain" }),
    entry("init.baseline.created", { version: "v1" }, { id: "old-baseline", capabilityId: "init" }),
    entry("baseline.created", { version: "v1" }, { id: "new-baseline", capabilityId: "init" }),
  ]);
  assert.deepEqual(records.map(record => [record.id, record.title, record.version]), [
    ["rejected", "候选未保留，继续使用当前版本", "v2"],
    ["retained", "候选已保留为正式版本，目标已达成", "v2"],
    ["uncertain", "候选已保留为正式版本（目标未判定）", "v2"],
    ["old-baseline", "初始化基线已建立", "v1"],
    ["new-baseline", "初始化基线已建立", "v1"],
  ]);
});

test("evidence paths reject traversal, directories and symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-evidence-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "flywheel-evidence-outside-"));
  await mkdir(path.join(root, ".flywheel"));
  await writeFile(path.join(root, ".flywheel", "goal.md"), "原始目标");
  await writeFile(path.join(outside, "secret.md"), "not an authorized asset");
  assert.equal(await resolveEvidenceFile(root, ".flywheel/goal.md"), await realpath(path.join(root, ".flywheel", "goal.md")));
  await assert.rejects(resolveEvidenceFile(root, outside));
  await assert.rejects(resolveEvidenceFile(root, ".flywheel"));
  await symlink(outside, path.join(root, ".flywheel", "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resolveEvidenceFile(root, ".flywheel/escape/secret.md"), /outside/);
});
