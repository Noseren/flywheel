import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DurableStateStore } from "../../src/services/state/index.ts";

class ContendedStore extends DurableStateStore<{ count: number }, { id: string }> {
  failures = 0;
  attempts = 0;
  code = "EPERM";
  protected override async renameTemporary(source: string, destination: string): Promise<void> {
    if (destination === this.statePath) {
      this.attempts += 1;
      if (this.failures-- > 0) throw Object.assign(new Error(`Cannot replace ${destination}`), { code: this.code });
    }
    await super.renameTemporary(source, destination);
  }
}

async function contendedFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-state-contention-"));
  const store = new ContendedStore({ statePath: path.join(root, "state.json"),
    eventsPath: path.join(root, "events.jsonl"), validateState: (value) => value as { count: number },
    eventId: (event) => event.id });
  await store.save({ count: 1 });
  store.attempts = 0;
  return { root, store };
}

test("atomic state replacement retries transient contention without losing the old file", async () => {
  const { root, store } = await contendedFixture();
  store.failures = 2;
  const saving = store.save({ count: 2 });
  assert.deepEqual(JSON.parse(await readFile(store.statePath, "utf8")), { count: 1 });
  await saving;
  assert.equal(store.attempts, 3);
  assert.deepEqual(await store.load(), { count: 2 });
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("exhausted replacement retains the old state and write-ahead record for recovery", async () => {
  const { root, store } = await contendedFixture();
  store.failures = 10;
  await assert.rejects(store.commit({ count: 2 }, { id: "second" }), { code: "EPERM" });
  assert.equal(store.attempts, 5);
  assert.deepEqual(JSON.parse(await readFile(store.statePath, "utf8")), { count: 1 });
  assert.equal(JSON.parse(await readFile(store.transitionPath, "utf8")).eventId, "second");
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
  store.failures = 0;
  assert.deepEqual(await store.load(), { count: 2 });
  assert.deepEqual(await store.history(), [{ id: "second" }]);
  assert.deepEqual(await store.history(), [{ id: "second" }]);
});

test("non-contention errors fail immediately and leave authoritative state intact", async () => {
  const { store } = await contendedFixture();
  store.failures = 10;
  store.code = "ENOSPC";
  await assert.rejects(store.save({ count: 2 }), { code: "ENOSPC" });
  assert.equal(store.attempts, 1);
  assert.deepEqual(await store.load(), { count: 1 });
});

test("durable state atomically saves state and appends observable events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-state-"));
  const store = new DurableStateStore<{ count: number }, { scope: string; value: number }>({
    statePath: path.join(root, "state.json"),
    eventsPath: path.join(root, "events.jsonl"),
    validateState(value) {
      if (!value || typeof value !== "object" || typeof (value as { count?: unknown }).count !== "number") {
        throw new Error("invalid state");
      }
      return value as { count: number };
    },
    selectEvent: (event) => event.scope === "current",
    eventId: (event) => `${event.scope}:${event.value}`,
  });
  const observed: number[] = [];
  store.subscribe((event) => observed.push(event.value));

  await store.save({ count: 2 });
  await store.append({ scope: "old", value: 1 });
  await store.append({ scope: "current", value: 2 });

  assert.deepEqual(await store.load(), { count: 2 });
  assert.deepEqual(await store.history(), [{ scope: "current", value: 2 }]);
  assert.deepEqual(observed, [1, 2]);
});

test("durable state recovers a pending state and event transition exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-state-recovery-"));
  const store = new DurableStateStore<{ count: number }, { id: string; value: number }>({
    statePath: path.join(root, "state.json"),
    eventsPath: path.join(root, "events.jsonl"),
    validateState: (value) => value as { count: number },
    eventId: (event) => event.id,
  });
  await store.save({ count: 1 });
  await writeFile(store.transitionPath, `${JSON.stringify({
    schemaVersion: 1,
    eventId: "transition-2",
    state: { count: 2 },
    event: { id: "transition-2", value: 2 },
  })}\n`);

  assert.deepEqual(await store.load(), { count: 2 });
  assert.deepEqual(await store.history(), [{ id: "transition-2", value: 2 }]);
  assert.deepEqual(await store.history(), [{ id: "transition-2", value: 2 }]);
  await assert.rejects(readFile(store.transitionPath, "utf8"), { code: "ENOENT" });
});
