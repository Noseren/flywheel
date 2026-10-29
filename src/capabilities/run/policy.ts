import { defineExecutionPolicy } from "../../session/policy.ts";
import {
  bootstrap,
  assessTarget,
  evaluation,
  policyActivate,
  propose,
  refine,
  select,
  steeringPropose,
  steeringResolve,
  tasking,
  type RunExecutionPolicy,
} from "./policy/operations.ts";

export type {
  RunExecutionPolicy,
  RunOperationResult,
  RunPolicyServices,
} from "./policy/operations.ts";
export { validateCandidateSelection } from "./policy/operations.ts";

/** Run's complete programmable business flow; Session alone repeats operations. */
export function createDefaultRunExecutionPolicy(): RunExecutionPolicy {
  return defineExecutionPolicy({
    id: "flywheel.run", revision: "13",
    requires: ["agent", "artifact", "workspace", "state", "version", "search", "prompt"],
    operations: {
      bootstrap, tasking, evaluate: evaluation, assess_target: assessTarget, propose, refine, select,
      "steering.propose": steeringPropose,
      "steering.resolve": steeringResolve,
      "policy.activate": policyActivate,
    },
    decide({ state, lastOutcome }) {
      if (state.pendingRunCommand) return { type: "run", operationId: state.pendingRunCommand.type };
      if (["steering.propose", "steering.resolve", "policy.activate"].includes(lastOutcome?.operationId ?? "")) {
        return { type: "complete" };
      }
      switch (lastOutcome?.operationId) {
        case undefined: return { type: "run", operationId: "bootstrap" };
        case "bootstrap": return { type: "run", operationId: "tasking" };
        case "tasking": return { type: "run", operationId: "evaluate" };
        case "evaluate": return { type: "run", operationId: "assess_target" };
        case "assess_target": {
          const assessment = lastOutcome.data?.assessment;
          if (assessment === "not_achieved" || assessment === "continue") {
            return { type: "run", operationId: "propose" };
          }
          return { type: "blocked", error: `Target Assess returned an unsupported completed result: ${String(assessment)}` };
        }
        case "propose": {
          const action = lastOutcome.data?.action;
          if (action === "iterate") {
            if (state.maxIterations !== undefined && state.iteration >= state.maxIterations) {
              return { type: "blocked", error: "Propose found another hypothesis, but the configured iteration limit has been reached" };
            }
            return { type: "run", operationId: "refine" };
          }
          return { type: "blocked", error: `Propose returned an unsupported completed action: ${String(action)}` };
        }
        case "refine": {
          const action = lastOutcome.data?.action;
          if (action === "select") return { type: "run", operationId: "select" };
          if (action === "repropose") return { type: "run", operationId: "propose" };
          return { type: "blocked", error: `Refine returned an unsupported completed action: ${String(action)}` };
        }
        case "select": {
          const action = lastOutcome.data?.action;
          if (action === "promote") return { type: "run", operationId: "assess_target" };
          if (action === "iterate") return { type: "run", operationId: "propose" };
          return { type: "blocked", error: `Select returned an unsupported completed action: ${String(action)}` };
        }
        default: return { type: "blocked", error: `No Run transition from ${lastOutcome?.operationId ?? "<none>"}` };
      }
    },
  });
}
