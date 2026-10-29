import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import type { ChangeScope, WorkspacePatchPlan } from "./protocol.ts";
import { validateChangedFiles } from "./scope.ts";
import { PatchValidationError, validatePatchPlan } from "./validation.ts";

export interface WorkspacePatchOptions {
  root: string;
  proposalDir: string;
  allowedScope: ChangeScope;
  protectedPaths?: string[];
  maxFiles?: number;
  maxAddedDeletedRatio?: number;
}

/** Validate a staged add/modify/delete patch without interpreting its business intent. */
export async function validateWorkspacePatch(options: WorkspacePatchOptions): Promise<{
  plan: Required<WorkspacePatchPlan>;
  changedPaths: string[];
}> {
  const value = JSON.parse(await readFile(path.join(options.proposalDir, "proposal.json"), "utf8")) as unknown;
  const plan = await validatePatchPlan(value, options);
  const changedPaths = [...plan.modified_files, ...plan.added_files, ...plan.deleted_files];
  validateChangedFiles({ change_scope: options.allowedScope }, changedPaths);
  let changed = plan.added_files.length > 0 || plan.deleted_files.length > 0;
  for (const relative of [...plan.modified_files, ...plan.added_files]) {
    const staged = await readFile(path.join(options.proposalDir, "files", relative));
    if (plan.modified_files.includes(relative)) {
      const current = await readFile(path.join(options.root, relative));
      if (!staged.equals(current)) changed = true;
    }
  }
  if (!changed) throw new PatchValidationError("workspace patch", ["patch produced no content changes"]);
  return { plan, changedPaths };
}

/** Apply a previously staged patch in deterministic delete/modify/add order. */
export async function applyWorkspacePatch(options: WorkspacePatchOptions): Promise<string[]> {
  const { plan, changedPaths } = await validateWorkspacePatch(options);
  for (const relative of plan.deleted_files) await rm(path.join(options.root, relative));
  for (const relative of plan.modified_files) {
    await copyFile(path.join(options.proposalDir, "files", relative), path.join(options.root, relative));
  }
  for (const relative of plan.added_files) {
    const target = path.join(options.root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(options.proposalDir, "files", relative), target);
  }
  return changedPaths;
}
