import type { LifecycleAction } from "./protocol.ts";

const lifecycleActions = new Set<LifecycleAction>([
  "promote", "iterate", "stop", "ask_user", "rollback",
]);

export function validateLifecycleAction(value: unknown): LifecycleAction {
  if (typeof value !== "string" || !lifecycleActions.has(value as LifecycleAction)) {
    throw new Error("Lifecycle action must be promote, iterate, stop, ask_user, or rollback");
  }
  return value as LifecycleAction;
}
