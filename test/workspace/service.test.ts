import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspace, createWorkspaceService } from "../../src/services/workspace/index.ts";

test("workspace service provides bounded filesystem controls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-workspace-"));
  const service = createWorkspaceService({ workspace: createWorkspace(root) });
  const source = service.join(root, "source", "value.json");
  const target = service.join(root, "target", "value.json");

  await service.writeJson(source, { ok: true });
  assert.deepEqual(await service.readJson(source), { ok: true });
  await service.copyFile(source, target);
  assert.equal(await readFile(target, "utf8"), '{\n  "ok": true\n}\n');
  await service.move(target, service.join(root, "target", "moved.json"));
  assert.equal(await service.exists(target), false);
});

test("workspace service rejects paths outside every granted root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-workspace-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "flywheel-outside-"));
  const service = createWorkspaceService({ workspace: createWorkspace(root) });

  assert.throws(() => service.join(outside, "escape.txt"), /outside authorized workspace roots/);
  await assert.rejects(service.readText(path.join(outside, "escape.txt")), /outside authorized workspace roots/);
});
