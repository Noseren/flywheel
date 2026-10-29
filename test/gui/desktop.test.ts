import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopLaunchSpec } from "../../src/gui/desktop.ts";

test("desktop entry fails clearly without silently falling back to a browser", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-desktop-missing-"));
  await assert.rejects(desktopLaunchSpec(root, ["gui"]), /pnpm desktop:build/);
});

test("desktop entry forwards project and paused launch arguments without shell interpolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-desktop-spec-"));
  const release = path.join(root, "src-tauri", "target", "release");
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, "flywheel-desktop.exe"), "");
  const args = ["run", "--gui-paused", "--project", "project with spaces & symbols"];
  const spec = await desktopLaunchSpec(root, args, "win32");
  assert.deepEqual(spec.args, [...args, "--gui-port", "0"]);
  assert.equal(args.length, 4);
  assert.equal(spec.binary, path.join(release, "flywheel-desktop.exe"));
  assert.deepEqual((await desktopLaunchSpec(root, ["gui", "--gui-port", "1234"], "win32")).args, ["gui", "--gui-port", "1234"]);
});
