import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPolicyServiceGrants,
  decideExecutionPolicy,
  defineExecutionPolicy,
  executePolicyOperation,
  loadExecutionPolicy,
  trustedModuleExecutionPolicySource,
} from "../../../src/session/policy.ts";

function moduleSource(marker: string): string {
  return `export default {
    id: "reloadable.run",
    revision: "declared",
    decide() { return { type: "run", operationId: "custom" }; },
    operations: {
      custom: async () => ({ status: "completed", data: { marker: ${JSON.stringify(marker)} } })
    }
  };\n`;
}

test("trusted execution policy reloads edited operation code by content hash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-policy-"));
  const file = path.join(root, "policy.mjs");
  await writeFile(file, moduleSource("first"), "utf8");
  const source = trustedModuleExecutionPolicySource<Record<string, never>, Record<string, never>>(file);

  const first = await loadExecutionPolicy(source);
  await writeFile(file, moduleSource("second"), "utf8");
  const second = await loadExecutionPolicy(source);

  assert.match(first.revision, /^declared\+[a-f0-9]{12}$/);
  assert.match(second.revision, /^declared\+[a-f0-9]{12}$/);
  assert.notEqual(first.revision, second.revision);
  assert.equal(first.id, second.id);
  assert.deepEqual((await executePolicyOperation(first, "custom", {
    services: {}, state: {}, signal: new AbortController().signal,
  })).data, { marker: "first" });
  assert.deepEqual((await executePolicyOperation(second, "custom", {
    services: {}, state: {}, signal: new AbortController().signal,
  })).data, { marker: "second" });
});

test("policy owns executable operations, transitions, and explicit service requirements", async () => {
  const policy = defineExecutionPolicy<{ prefix: string }, { next: string }>({
    id: "programmable",
    revision: "1",
    requires: ["agent"],
    operations: {
      first: async ({ services }) => ({ status: "completed", data: { value: `${services.prefix}:first` } }),
      second: async ({ services }) => ({ status: "completed", data: { value: `${services.prefix}:second` } }),
    },
    decide({ state, policyState }) {
      return {
        type: "run",
        operationId: state.next,
        policyState: { decisions: Number(policyState.decisions ?? 0) + 1 },
      };
    },
  });

  assertPolicyServiceGrants(policy, ["agent", "version"]);
  assert.throws(() => assertPolicyServiceGrants(policy, ["version"]), /requires ungranted service agent/);
  assert.deepEqual(decideExecutionPolicy(policy, {
    state: { next: "second" },
    policyState: {},
  }), {
    type: "run",
    operationId: "second",
    policyState: { decisions: 1 },
  });
  assert.throws(() => decideExecutionPolicy(policy, {
    state: { next: "missing" },
    policyState: {},
  }), /unknown operation missing/);

  const result = await executePolicyOperation(policy, "second", {
    services: { prefix: "policy" },
    state: { next: "second" },
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { status: "completed", data: { value: "policy:second" } });

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(executePolicyOperation(policy, "first", {
    services: { prefix: "policy" }, state: { next: "first" }, signal: aborted.signal,
  }), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});
