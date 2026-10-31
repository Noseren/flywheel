import { defineExecutionPolicy, type ExecutionPolicy } from "../../session/policy.ts";
import { prepareCompactOperation } from "./policy/compact.ts";
import { isCompactAssistanceRevision } from "../compact-assistance.ts";
import type {
  InitCommand,
  InitOperationResult,
  InitServices,
  InitState,
} from "./protocol.ts";
import {
  confirmProposalOperation,
  createBaselineOperation,
  exploreOperation,
  generateContractOperation,
  generateEvaluatorOperation,
  inspectOperation,
  proposalOperation,
  reviewEvaluatorOperation,
  validateContractOperation,
  awaitGoalOperation,
} from "./policy/operations.ts";

export const DEFAULT_INIT_POLICY_REVISION = "2026-10-23.compact.v1";

export function createDefaultInitExecutionPolicy(assistanceRevision?: string): ExecutionPolicy<
  InitServices,
  InitState,
  InitCommand,
  InitOperationResult
> {
  return defineExecutionPolicy({
    id: "flywheel.init",
    revision: isCompactAssistanceRevision(assistanceRevision) ? assistanceRevision : DEFAULT_INIT_POLICY_REVISION,
    requires: ["agent", "artifact", "version", "workspace", "state", "prompt", "process"],
    operations: {
      inspect: inspectOperation,
      explore: exploreOperation,
      await_goal: awaitGoalOperation,
      prepare_recommendation: proposalOperation,
      confirm_proposal: confirmProposalOperation,
      generate_contract: generateContractOperation,
      generate_evaluator: generateEvaluatorOperation,
      review_evaluator: reviewEvaluatorOperation,
      validate_contract: validateContractOperation,
      create_baseline: createBaselineOperation,
      prepare_compact: prepareCompactOperation,
    },
    decide({ state, lastOutcome }) {
      switch (lastOutcome?.operationId) {
        case undefined: return { type: "run", operationId: "inspect" };
        case "inspect": return {
          type: "run",
          operationId: state.inspection.status === "ready" ? "create_baseline" : "explore",
        };
        case "explore": return { type: "run", operationId: state.confirmationMode === "brief" ? "await_goal" : "prepare_recommendation" };
        case "await_goal": return { type: "run", operationId: lastOutcome?.data?.refreshContext === true ? "explore" : "prepare_recommendation" };
        case "prepare_recommendation": return { type: "run", operationId: "confirm_proposal" };
        case "confirm_proposal": return {
          type: "run",
          operationId: state.answers.summaryConfirmed === true ? (state.workflow === "compact" ? "prepare_compact" : "generate_contract") : "confirm_proposal",
        };
        case "prepare_compact": return { type: "run", operationId: "create_baseline" };
        case "generate_contract": return { type: "run", operationId: "generate_evaluator" };
        case "generate_evaluator": return { type: "run", operationId: "review_evaluator" };
        case "review_evaluator": return { type: "run", operationId: "validate_contract" };
        case "validate_contract": {
          if (state.answers.summaryConfirmed !== true) {
            return { type: "run", operationId: "confirm_proposal" };
          }
          return {
            type: "run",
            operationId: state.answers.smokeConfirmed === true ? "create_baseline" : "validate_contract",
          };
        }
        case "create_baseline": return { type: "complete" };
        default: return {
          type: "blocked",
          error: `No Init transition from ${lastOutcome?.operationId ?? "<none>"}`,
        };
      }
    },
  });
}
