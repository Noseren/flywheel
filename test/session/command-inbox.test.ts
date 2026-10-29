import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandInbox, type CommandReceipt } from "../../src/session/command-inbox.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function journal() {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "flywheel-command-inbox-")), "commands.jsonl");
}

test("command admission persists and returns before a slow executor completes", { timeout: 5000 }, async () => {
  const file = await journal();
  const entered = deferred();
  const release = deferred();
  const completed = deferred();
  const changes: CommandReceipt[] = [];
  const inbox = new CommandInbox(file, async (receipt) => {
    changes.push(receipt);
    if (receipt.status === "completed") completed.resolve();
  });
  let finished = false;
  try {
    const accepted = await inbox.accept("slow-1", { type: "intervention.submit", message: "hello" }, async () => {
      entered.resolve();
      await release.promise;
      finished = true;
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(finished, false);
    const persisted = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(persisted[0].status, "accepted");
    assert.equal(persisted[0].commandId, accepted.commandId);
    await entered.promise;
    assert.equal((await inbox.lookup("slow-1"))?.status, "running");
    // Reads remain available while the executor is blocked.
    assert.equal((await inbox.list()).length, 1);
  } finally {
    release.resolve();
  }
  await completed.promise;
  assert.equal(finished, true);
  assert.deepEqual(changes.map((entry) => entry.status), ["accepted", "running", "completed"]);
});

test("concurrent identical request IDs execute once and canonical payload keys deduplicate", { timeout: 5000 }, async () => {
  const done = deferred();
  const inbox = new CommandInbox(await journal(), async (receipt) => {
    if (receipt.status === "completed") done.resolve();
  });
  let executions = 0;
  const execute = async () => { executions++; };
  const [first, duplicate] = await Promise.all([
    inbox.accept("same", { type: "interaction.respond", detail: { a: 1, b: 2 } }, execute),
    inbox.accept("same", { detail: { b: 2, a: 1 }, type: "interaction.respond" }, execute),
  ]);
  assert.equal(first.commandId, duplicate.commandId);
  await done.promise;
  const repeated = await inbox.accept("same", { type: "interaction.respond", detail: { a: 1, b: 2 } }, execute);
  assert.equal(repeated.status, "completed");
  assert.equal(repeated.commandId, first.commandId);
  assert.equal(executions, 1);
});

test("reusing an admitted ID with changed content rejects without changing the receipt", { timeout: 5000 }, async () => {
  const done = deferred();
  const inbox = new CommandInbox(await journal(), async (receipt) => { if (receipt.status === "completed") done.resolve(); });
  const payload = { type: "intervention.submit", message: "original" };
  const accepted = await inbox.accept("conflict", payload, async () => {});
  await assert.rejects(inbox.accept("conflict", { ...payload, message: "changed" }, async () => {
    assert.fail("conflicting executor must never run");
  }), /同一请求编号不能用于不同内容/);
  await assert.rejects(inbox.lookup("conflict", { ...payload, message: "changed" }), /同一请求编号不能用于不同内容/);
  await done.promise;
  assert.equal((await inbox.lookup("conflict", payload))?.commandId, accepted.commandId);
});

test("restart marks persisted unfinished commands interrupted and never replays them", { timeout: 5000 }, async () => {
  const file = await journal();
  const done = deferred();
  const original = new CommandInbox(file, async (receipt) => { if (receipt.status === "completed") done.resolve(); });
  const payload = { type: "intervention.submit", message: "restart fixture" };
  const receipt = await original.accept("restart", payload, async () => {});
  await done.promise;
  // Model a process exit with the accepted/running receipt durable but no terminal record.
  for (const status of ["accepted", "running"] as const) {
    await writeFile(file, `${JSON.stringify({ ...receipt, status })}\n`, "utf8");
    const notifications: CommandReceipt[] = [];
    const reopened = new CommandInbox(file, async (entry) => { notifications.push(entry); });
    let executions = 0;
    const recovered = await reopened.accept("restart", payload, async () => { executions++; });
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.commandId, receipt.commandId);
    assert.match(recovered.error ?? "", /未自动重新执行/);
    assert.equal(executions, 0);
    assert.deepEqual(notifications.map((entry) => entry.status), ["interrupted"]);
    const again = new CommandInbox(file, async () => { assert.fail("terminal receipt should not be appended again"); });
    assert.equal((await again.lookup("restart", payload))?.status, "interrupted");
  }
});

test("a slow or failed command does not block unrelated stop admission", { timeout: 5000 }, async () => {
  const entered = deferred();
  const release = deferred();
  const failed = deferred();
  const stopped = deferred();
  const resumed = deferred();
  const inbox = new CommandInbox(await journal(), async (receipt) => {
    if (receipt.clientRequestId === "slow-fail" && receipt.status === "failed") failed.resolve();
    if (receipt.clientRequestId === "stop" && receipt.status === "completed") stopped.resolve();
    if (receipt.clientRequestId === "after-failure" && receipt.status === "completed") resumed.resolve();
  });
  try {
    await inbox.accept("slow-fail", { type: "intervention.submit" }, async () => {
      entered.resolve();
      await release.promise;
      throw new Error("provider unavailable");
    });
    await entered.promise;
    const stop = await inbox.accept("stop", { type: "session.stop" }, async () => {});
    assert.equal(stop.status, "accepted");
    await stopped.promise;
    assert.equal((await inbox.lookup("slow-fail"))?.status, "running");
  } finally {
    release.resolve();
  }
  await failed.promise;
  const failure = await inbox.lookup("slow-fail");
  assert.equal(failure?.status, "failed");
  assert.equal(failure.error, "provider unavailable");
  // A later unrelated command remains admissible after failure, too.
  const later = await inbox.accept("after-failure", { type: "capability.resume" }, async () => {});
  assert.equal(later.status, "accepted");
  await resumed.promise;
});
