import { access, realpath } from "node:fs/promises";
import path from "node:path";

import type { WorkspacePatchPlan } from "./protocol.ts";

export class PatchValidationError extends Error {
  readonly errors: string[];

  constructor(contract: string, errors: string[]) {
    super(`${contract} failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
    this.name = "PatchValidationError";
    this.errors = errors;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolvedInside(relativePath: string, root: string): Promise<string | undefined> {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) return undefined;
  const rootResolved = path.resolve(root);
  const candidate = path.resolve(rootResolved, relativePath);
  const lexicalRelative = path.relative(rootResolved, candidate);
  if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) return undefined;

  // Existing symlinks must not escape the artifact root.
  if (await exists(candidate)) {
    const [realRoot, realCandidate] = await Promise.all([realpath(rootResolved), realpath(candidate)]);
    const physicalRelative = path.relative(realRoot, realCandidate);
    if (physicalRelative.startsWith("..") || path.isAbsolute(physicalRelative)) return undefined;
    return realCandidate;
  }
  return candidate;
}

function patchList(value: unknown, key: string, errors: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!stringArray(value)) {
    errors.push(`${key} must be an array of strings`);
    return [];
  }
  return value;
}

export async function validatePatchPlan(
  value: unknown,
  options: {
    root: string;
    protectedPaths?: string[];
    maxFiles?: number;
    maxAddedDeletedRatio?: number;
  },
): Promise<Required<WorkspacePatchPlan>> {
  if (!isRecord(value)) throw new PatchValidationError("workspace patch", ["root must be an object"]);
  const errors: string[] = [];
  const modified = patchList(value.modified_files, "modified_files", errors);
  const added = patchList(value.added_files, "added_files", errors);
  const deleted = patchList(value.deleted_files, "deleted_files", errors);
  const groups = [
    ["modified", modified], ["added", added], ["deleted", deleted],
  ] as const;
  const seen = new Map<string, string>();
  const resolved = new Map<string, string>();

  for (const [kind, paths] of groups) {
    for (const item of paths) {
      const target = await resolvedInside(item, options.root);
      if (!target) errors.push(`path escapes workspace root: ${JSON.stringify(item)} (${kind})`);
      else resolved.set(`${kind}:${item}`, target);
      const previous = seen.get(item);
      if (previous && previous !== kind) errors.push(`path appears in multiple lists (${previous} + ${kind}): ${JSON.stringify(item)}`);
      else seen.set(item, kind);
    }
  }

  for (const item of added) {
    const target = resolved.get(`added:${item}`);
    if (target && await exists(target)) errors.push(`added_files path already exists: ${JSON.stringify(item)}`);
  }
  for (const item of modified) {
    const target = resolved.get(`modified:${item}`);
    if (target && !await exists(target)) errors.push(`modified_files path does not exist: ${JSON.stringify(item)}`);
  }
  const protectedPaths = await Promise.all((options.protectedPaths ?? []).map(async (item) => {
    const lexical = path.resolve(item);
    return await exists(lexical) ? await realpath(lexical) : lexical;
  }));
  for (const item of deleted) {
    const target = resolved.get(`deleted:${item}`);
    if (!target) continue;
    if (!await exists(target)) errors.push(`deleted_files path does not exist: ${JSON.stringify(item)}`);
    if (protectedPaths.includes(path.resolve(target))) {
      errors.push(`refusing to delete protected path: ${JSON.stringify(item)}`);
    }
  }

  const total = modified.length + added.length + deleted.length;
  if (options.maxFiles !== undefined && total > options.maxFiles) {
    errors.push(`too many files in patch: ${total} > ${options.maxFiles}`);
  }
  const addedDeleted = added.length + deleted.length;
  if (options.maxAddedDeletedRatio !== undefined && modified.length === 0 && addedDeleted > 0) {
    errors.push(`add+delete ratio violation: ${addedDeleted} added/deleted with 0 modified`);
  } else if (options.maxAddedDeletedRatio !== undefined
    && addedDeleted > options.maxAddedDeletedRatio * modified.length) {
    errors.push(
      `add+delete ratio violation: ${addedDeleted} > ${options.maxAddedDeletedRatio} * ${modified.length}`,
    );
  }
  if (errors.length) throw new PatchValidationError("workspace patch", errors);
  return { modified_files: modified, added_files: added, deleted_files: deleted };
}
