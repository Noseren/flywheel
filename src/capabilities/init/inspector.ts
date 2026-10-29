import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { defaultProcessService, type ProcessService } from "../../services/process/index.ts";
import { resolveInside, sha256 } from "../../services/workspace/index.ts";
import { INIT_COMPACT_ROLE_PATHS, INIT_CONTRACT_ROLE_PATHS, loadInitBoundary, validateInitContract } from "./artifacts.ts";

export type InitInspectionStatus = "not_initialized" | "in_progress" | "invalid" | "ready";

export interface InitInspection {
  status: InitInspectionStatus;
  checks: {
    manifest: boolean;
    contractFiles: boolean;
    artifact: boolean;
    baselineV1: boolean;
  };
  problems: string[];
}
async function exists(candidate: string): Promise<boolean> {
  try { await access(candidate); return true; } catch { return false; }
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function inspectReadyManifest(projectRoot: string): Promise<{
  contractFiles: boolean;
  artifact: boolean;
}> {
  const manifestPath = path.join(projectRoot, ".flywheel", "init", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion?: number;
    workflow?: string;
    status?: string;
    baseline?: string;
    contractManifestSha256?: string;
    files?: Array<{ id?: string; path?: string; sha256?: string }>;
  };
  if (manifest.schemaVersion !== 4 || manifest.status !== "ready" || manifest.baseline !== "v1"
    || typeof manifest.contractManifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/i.test(manifest.contractManifestSha256)
    || !Array.isArray(manifest.files)) {
    throw new Error("Init manifest must be a ready schema 4 manifest for baseline v1");
  }
  const ids = new Set<string>();
  const filesById = new Map<string, string>();
  for (const entry of manifest.files) {
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
      || typeof entry.path !== "string" || !entry.path || path.isAbsolute(entry.path)
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
      throw new Error("Init manifest contains an invalid or duplicate file entry");
    }
    const file = path.resolve(projectRoot, entry.path);
    if (!inside(file, projectRoot) || await sha256(file) !== entry.sha256) {
      throw new Error(`Init manifest hash mismatch: ${entry.path}`);
    }
    ids.add(entry.id);
    filesById.set(entry.id, file);
  }
  const compact = manifest.workflow === "compact";
  if (manifest.workflow !== undefined && !compact) throw new Error("Unsupported Init workflow");
  for (const id of compact ? ["goal", "task", "boundary", "evaluator", "verification"] : ["task", "boundary", "tasking-guide", "evaluate-guide", "evaluator"]) {
    if (!ids.has(id)) throw new Error(`Init manifest is missing required artifact: ${id}`);
  }
  for (const [id, expectedPath] of Object.entries(compact ? INIT_COMPACT_ROLE_PATHS : INIT_CONTRACT_ROLE_PATHS)) {
    if (filesById.get(id) !== resolveInside(projectRoot, expectedPath)) {
      throw new Error(`Init manifest role ${id} does not match the Runtime contract entry`);
    }
  }
  if (compact) {
    const contract = await validateInitContract(projectRoot);
    if (contract.workflow !== "compact" || contract.manifestSha256 !== manifest.contractManifestSha256
      || contract.files.some((entry) => filesById.get(entry.id) !== path.resolve(projectRoot, entry.path))) {
      throw new Error("Ready compact manifest does not match its frozen draft");
    }
  }
  const boundary = await loadInitBoundary(filesById.get("boundary")!);
  const artifactPath = resolveInside(projectRoot, boundary.artifact.path);
  const stat = await lstat(artifactPath);
  if (stat.isSymbolicLink()) throw new Error("Init artifact may not be a symbolic link");
  return { contractFiles: true, artifact: true };
}

export async function inspectInit(
  projectRootInput: string,
  processService: Pick<ProcessService, "run"> = defaultProcessService,
): Promise<InitInspection> {
  const projectRoot = path.resolve(projectRootInput);
  const flywheelDir = path.join(projectRoot, ".flywheel");
  const initStatePath = path.join(flywheelDir, "runtime", "init-state.json");
  const checks: InitInspection["checks"] = {
    manifest: false,
    contractFiles: false,
    artifact: false,
    baselineV1: false,
  };
  const problems: string[] = [];
  const manifestPath = path.join(flywheelDir, "init", "manifest.json");
  if (await exists(manifestPath)) {
    try {
      const ready = await inspectReadyManifest(projectRoot);
      checks.manifest = true;
      checks.contractFiles = ready.contractFiles;
      checks.artifact = ready.artifact;
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  const baseline = await processService.run("git", [
    `--git-dir=${path.join(flywheelDir, "history.git")}`,
    "rev-parse", "--verify", "refs/tags/v1",
  ]);
  checks.baselineV1 = baseline.code === 0;
  const required = [
    ["init manifest", checks.manifest],
    ["contract artifacts", checks.contractFiles],
    ["optimized artifact", checks.artifact],
    ["v1 baseline", checks.baselineV1],
  ] as const;
  for (const [label, present] of required) if (!present) problems.push(`Missing or invalid ${label}`);
  if (required.every(([, present]) => present)) return { status: "ready", checks, problems: [] };
  if (await exists(initStatePath)) {
    try {
      const state = JSON.parse(await readFile(initStatePath, "utf8")) as { status?: string };
      if (state.status !== "completed") return { status: "in_progress", checks, problems };
    } catch {
      problems.push("init-state.json is invalid");
    }
  }
  if (!await exists(flywheelDir)) return { status: "not_initialized", checks, problems };
  const hasAnyContract = checks.manifest || checks.contractFiles || checks.artifact || checks.baselineV1;
  return { status: hasAnyContract ? "invalid" : "not_initialized", checks, problems };
}
