import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSearchService } from "../../src/services/search/index.ts";

test("parallel search bounds concurrency and isolates candidate workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-search-"));
  const search = createSearchService(2);
  let active = 0;
  let maximum = 0;

  const results = await search.run({
    workspaceRoot: root,
    items: ["a", "b", "c", "d"].map((id) => ({ id, input: id.toUpperCase() })),
    run: async ({ id, input, workspace }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(path.join(workspace, "result.txt"), `${id}:${input}\n`, "utf8");
      active -= 1;
      if (id === "c") throw new Error("candidate rejected");
      return input;
    },
  });

  assert.equal(maximum, 2);
  assert.deepEqual(results.map((result) => [result.id, result.status]), [
    ["a", "completed"], ["b", "completed"], ["c", "failed"], ["d", "completed"],
  ]);
  assert.equal(await readFile(path.join(root, "a", "result.txt"), "utf8"), "a:A\n");
  assert.equal(await readFile(path.join(root, "b", "result.txt"), "utf8"), "b:B\n");
  assert.equal((results[2] as { error: string }).error, "candidate rejected");
});

test("parallel search rejects ambiguous workspace identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-search-"));
  const search = createSearchService();
  await assert.rejects(search.run({
    workspaceRoot: root,
    items: [{ id: "same", input: 1 }, { id: "same", input: 2 }],
    async run({ input }) { return input; },
  }), /Duplicate search item id/);
});

test("parallel search cancels active runners and does not start queued candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-search-"));
  const search = createSearchService(2);
  const controller = new AbortController();
  const started: string[] = [];

  const operation = search.run({
    workspaceRoot: root,
    items: ["a", "b", "c", "d"].map((id) => ({ id, input: id })),
    signal: controller.signal,
    run: async ({ id, signal }) => {
      started.push(id);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new DOMException("Search item interrupted", "AbortError");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();

  await assert.rejects(operation, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.deepEqual(started.sort(), ["a", "b"]);
});

test("parallel search restores and persists each stable item independently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-search-"));
  const search = createSearchService(2);
  const executed: string[] = [];
  const persisted: string[] = [];

  const results = await search.run({
    workspaceRoot: root,
    items: ["restored", "new"].map((id) => ({ id, input: id })),
    restore: async ({ id, input, workspace }) => id === "restored"
      ? { id, input, workspace, status: "completed", output: "from-disk" }
      : undefined,
    persist: async (result) => { persisted.push(result.id); },
    run: async ({ id }) => { executed.push(id); return "fresh"; },
  });

  assert.deepEqual(executed, ["new"]);
  assert.deepEqual(persisted, ["new"]);
  assert.deepEqual(results.map((result) => result.status === "completed" ? result.output : result.error), [
    "from-disk", "fresh",
  ]);
});
