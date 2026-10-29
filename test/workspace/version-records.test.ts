import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { VersionRecordStore } from "../../src/services/version/records.ts";
import { createWorkspace } from "../../src/services/workspace/index.ts";

async function fixture(): Promise<{ root: string; store: VersionRecordStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-version-records-"));
  return { root, store: new VersionRecordStore(createWorkspace(root)) };
}

test("version records are immutable and active pointers are hash-bound", async () => {
  const { store } = await fixture();
  await store.write("policy", { id: "one", revision: 1 });
  await store.activate("policy", "one");
  assert.deepEqual(await store.active("policy"), { id: "one", revision: 1 });
  await assert.rejects(store.write("policy", { id: "one", revision: 2 }), /different content/);

  const recordPath = path.join(store.root, "policy", "immutable", "one.json");
  await writeFile(recordPath, `${await readFile(recordPath, "utf8")} `);
  await assert.rejects(store.active("policy"), /pointer hash mismatch/);
});

test("staging is inert until the caller commits and activates it", async () => {
  const { store } = await fixture();
  await store.write("policy", { id: "one", revision: 1 });
  await store.activate("policy", "one");
  await store.stage("policy", { id: "two", revision: 2, evidence: ["opaque"] });
  assert.equal((await store.active("policy"))?.id, "one");
  await store.commitStaged("policy", "two");
  assert.equal((await store.active("policy"))?.id, "one");
  await store.activate("policy", "two");
  assert.equal((await store.active("policy"))?.id, "two");
  assert.equal(await store.rollback("policy", "two"), "one");
  assert.equal((await store.active("policy"))?.id, "one");
});

test("artifact references verify workspace containment and content hashes", async () => {
  const { root, store } = await fixture();
  const file = path.join(root, "artifact.txt");
  await writeFile(file, "evidence\n");
  const ref = await store.fileRef("evidence", "v1", file);
  assert.ok(ref);
  await store.verifyRef(ref);
  await writeFile(file, "changed\n");
  await assert.rejects(store.verifyRef(ref), /hash mismatch/);
  await assert.rejects(store.fileRef("escape", "v1", path.join(root, "..", "escape")), /escapes workspace/);
});
