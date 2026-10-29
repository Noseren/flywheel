import { access, readFile, realpath } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type { JobResult, JobSpec } from "./job-protocol.ts";

const jobStatuses = new Set<JobResult["status"]>([
  "completed", "failed", "aborted", "needs_input",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveFrom(cwd: string, value: string): string {
  return path.resolve(cwd, value);
}

/** Resolve existing symlink ancestors even when the final write target does not exist yet. */
function physicalPath(value: string): string {
  let existing = path.resolve(value);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...missing);
}

/** Validate only the Runtime's generic filesystem and execution boundary. */
export function validateJobSpec(spec: JobSpec): JobSpec {
  if (!spec.operation.trim()) throw new Error("Job operation may not be empty");
  if (!spec.label.trim()) throw new Error("Job label may not be empty");
  const cwd = path.resolve(spec.cwd);
  const physicalCwd = physicalPath(cwd);
  for (const [field, roots] of [
    ["readRoots", spec.readRoots],
    ["writeRoots", spec.writeRoots],
    ["deniedPaths", spec.deniedPaths ?? []],
  ] as const) {
    for (const root of roots) {
      const resolved = resolveFrom(cwd, root);
      if (!root.trim() || !inside(resolved, cwd) || !inside(physicalPath(resolved), physicalCwd)) {
        throw new Error(`Job ${field} path escapes cwd: ${JSON.stringify(root)}`);
      }
    }
  }
  if (spec.resultPath) {
    const resolved = resolveFrom(cwd, spec.resultPath);
    if (!inside(resolved, cwd) || !inside(physicalPath(resolved), physicalCwd)) {
      throw new Error(`Job resultPath escapes cwd: ${JSON.stringify(spec.resultPath)}`);
    }
    const writeRoots = spec.writeRoots.map((root) => resolveFrom(cwd, root));
    if (!writeRoots.some((root) => inside(resolved, root))) {
      throw new Error(`Job resultPath is outside writeRoots: ${spec.resultPath}`);
    }
  }
  return spec;
}

/**
 * Validate the stable Job result without interpreting any task artifact.
 * Completed results must point to real artifacts inside this Job's write roots.
 */
export async function validateJobResult(value: unknown, spec: JobSpec): Promise<JobResult> {
  validateJobSpec(spec);
  if (!record(value) || !jobStatuses.has(value.status as JobResult["status"])) {
    throw new Error("Job result has an invalid status");
  }
  if (!Array.isArray(value.artifacts) || !value.artifacts.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("Job result artifacts must be an array of paths");
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error("Job result message must be a string");
  }
  if ((value.status === "failed" || value.status === "needs_input")
    && (typeof value.message !== "string" || !value.message.trim())) {
    throw new Error(`${value.status} JobResult must provide a user-routable message`);
  }

  const writeRoots = spec.writeRoots.map((root) => resolveFrom(spec.cwd, root));
  for (const artifact of value.artifacts) {
    const resolved = resolveFrom(spec.cwd, artifact);
    if (!writeRoots.some((root) => inside(resolved, root))) {
      throw new Error(`Job artifact is outside write roots: ${artifact}`);
    }
    if (value.status === "completed") {
      await access(resolved);
      const physical = await realpath(resolved);
      const allowed = await Promise.all(writeRoots.map(async (root) => {
        try { return inside(physical, await realpath(root)); }
        catch { return inside(physical, root); }
      }));
      if (!allowed.some(Boolean)) throw new Error(`Job artifact escapes write roots: ${artifact}`);
    }
  }
  return value as unknown as JobResult;
}

/** Revalidate a persisted Agent-authored result when a Job resumes. */
export async function readJobResult(spec: JobSpec): Promise<JobResult> {
  if (!spec.resultPath) throw new Error(`Job ${spec.label} has no resultPath`);
  return await validateJobResult(
    JSON.parse(await readFile(spec.resultPath, "utf8")) as unknown,
    spec,
  );
}
