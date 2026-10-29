import assert from "node:assert/strict";
import test from "node:test";

import { validateCandidateSelection } from "../../../src/capabilities/run/policy.ts";

test("selector may promote only an independently reviewed and validated candidate", () => {
  assert.equal(validateCandidateSelection({
    action: "promote",
    candidate_id: "h1",
  }, ["h1", "h2"]).candidate_id, "h1");
  assert.throws(() => validateCandidateSelection({
    action: "promote",
    candidate_id: "unknown",
  }, ["h1", "h2"]), /did not complete Review and Validate/);
});

test("selector cannot attach candidate code identity to a non-promotion action", () => {
  assert.equal(validateCandidateSelection({ action: "iterate" }, ["h1"]).action, "iterate");
  assert.throws(() => validateCandidateSelection({
    action: "iterate", candidate_id: "h1",
  }, ["h1"]), /Only promote/);
});

test("selector cannot decide that the overall target is complete", () => {
  assert.throws(() => validateCandidateSelection({ action: "stop" }, ["h1"]), /action is invalid/);
  assert.throws(() => validateCandidateSelection({ action: "target_achieved" }, ["h1"]), /action is invalid/);
});
