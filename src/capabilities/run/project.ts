import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createWorkspace,
  resolveInside,
  sha256,
  sha256Files,
  type Workspace,
} from "../../services/workspace/index.ts";
import type { ChangeScope } from "../../services/workspace/protocol.ts";
import { readVerificationConfig } from "../compact-evaluation.ts";
import { COMPACT_ASSISTANCE_REVISION } from "../compact-assistance.ts";

/** Run-owned machine boundary. WorkspaceService does not interpret these task roles. */
export interface RuntimeBoundary {
  schemaVersion: 1;
  artifact: { path: string };
  change_scope: ChangeScope;
}

/** Fixed Init roles; the evaluator remains a manifest-selected file rather than a fixed filename. */
export const FLYWHEEL_CONTRACT_ROLE_PATHS = {
  task: ".flywheel/contract/task.md",
  boundary: ".flywheel/contract/boundary.json",
  "tasking-guide": ".flywheel/contract/tasking_guide.md",
  requirements: ".flywheel/contract/requirements.json",
  "evaluate-guide": ".flywheel/contract/evaluate_guide.md",
  coverage: ".flywheel/contract/coverage.json",
} as const;

const frontmatterBlock = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

async function parseYaml(text: string): Promise<unknown> {
  let yaml: typeof import("yaml");
  try {
    yaml = await import("yaml");
  } catch {
    throw new Error("The `yaml` package is required. Run `npm install` in runtime/.");
  }
  return yaml.parse(text);
}

export async function readFrontmatter(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, "utf8");
  const match = text.match(frontmatterBlock);
  if (!match) throw new Error(`Missing YAML frontmatter: ${file}`);
  const parsed = await parseYaml(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Frontmatter must be an object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

/** Capability-owned optimization contract and its resolved paths. */
export interface Project extends Workspace {
  workflow?: "compact";
  assistanceRevision?: string;
  verificationPath?: string;
  frozenContractFiles?: string[];
  boundary: RuntimeBoundary;
  goalPath?: string;
  taskPath: string;
  boundaryPath: string;
  taskingGuidePath: string;
  evaluateGuidePath: string;
  artifactPath: string;
  trainsetPath?: string;
  holdoutPath?: string;
  collectorPath?: string;
  collectorGuidePath?: string;
  evaluatorPath: string;
  frozenEvaluatorPath: string;
  runDir(version: string): string;
}

/** Parse the only task-specific machine boundary understood by Runtime. */
export async function loadRuntimeBoundary(boundaryPath: string): Promise<RuntimeBoundary> {
  const value = JSON.parse(await readFile(boundaryPath, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("boundary.json must contain an object");
  }
  const boundary = value as RuntimeBoundary & Record<string, unknown>;
  const paths = (items: unknown): items is string[] => Array.isArray(items)
    && items.every((item) => typeof item === "string" && item.trim());
  const allowed = new Set(["schemaVersion", "artifact", "change_scope"]);
  const unknown = Object.keys(boundary).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`boundary.json contains unsupported fields: ${unknown.join(", ")}`);
  if (boundary.schemaVersion !== 1 || !boundary.artifact || typeof boundary.artifact.path !== "string"
    || !boundary.artifact.path.trim() || !boundary.change_scope || !paths(boundary.change_scope.primary)) {
    throw new Error("boundary.json requires schemaVersion 1, artifact.path, and change_scope.primary");
  }
  if (boundary.change_scope.auxiliary !== undefined && !paths(boundary.change_scope.auxiliary)) {
    throw new Error("boundary.json change_scope.auxiliary must be an array of paths");
  }
  if (boundary.change_scope.forbidden !== undefined && !paths(boundary.change_scope.forbidden)) {
    throw new Error("boundary.json change_scope.forbidden must be an array of paths");
  }
  const scopeKeys = Object.keys(boundary.change_scope as unknown as Record<string, unknown>);
  const unknownScope = scopeKeys.filter((key) => !["primary", "auxiliary", "forbidden"].includes(key));
  if (unknownScope.length) {
    throw new Error(`boundary.json change_scope contains unsupported fields: ${unknownScope.join(", ")}`);
  }
  return boundary;
}

interface ReadyManifestFile { id: string; path: string; sha256: string }

async function loadReadyManifest(root: string): Promise<{ files: ReadyManifestFile[]; workflow?: "compact"; assistanceRevision?: string }> {
  const manifestPath = path.join(root, ".flywheel", "init", "manifest.json");
  const value = JSON.parse(await readFile(manifestPath, "utf8")) as {
    schemaVersion?: number; status?: string; baseline?: string; files?: ReadyManifestFile[]; workflow?: "compact";
    assistanceRevision?: string;
  };
  if (value.schemaVersion !== 4 || value.status !== "ready" || value.baseline !== "v1" || !Array.isArray(value.files)) {
    throw new Error("Init manifest must be a ready schema 4 manifest for baseline v1");
  }
  const ids = new Set<string>();
  for (const file of value.files) {
    if (!file || typeof file.id !== "string" || !file.id || ids.has(file.id)
      || typeof file.path !== "string" || !file.path || path.isAbsolute(file.path)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)) {
      throw new Error("Init manifest contains an invalid or duplicate file entry");
    }
    ids.add(file.id);
  }
  if (value.assistanceRevision !== undefined && (value.workflow !== "compact" || value.assistanceRevision !== COMPACT_ASSISTANCE_REVISION)) {
    throw new Error("Unsupported compact assistance policy revision");
  }
  return { files: value.files, ...(value.workflow === "compact" ? { workflow: "compact" } : {}),
    ...(value.assistanceRevision ? { assistanceRevision: value.assistanceRevision } : {}) };
}

/** Resolve a ready project exclusively from its promoted manifest and boundary.json. */
export async function loadProject(rootInput: string, pluginRootInput?: string): Promise<Project> {
  const workspace = createWorkspace(rootInput, pluginRootInput);
  const { root, flywheelDir, runtimeDir } = workspace;
  const manifest = await loadReadyManifest(root);
  if (manifest.workflow === "compact") {
    for (const file of manifest.files) {
      if (await sha256(resolveInside(root, file.path)) !== file.sha256) throw new Error(`Ready compact contract hash mismatch: ${file.id}`);
    }
  }
  const byId = new Map(manifest.files.map((file) => [file.id, resolveInside(root, file.path)]));
  if (manifest.workflow === "compact" && byId.get("verification") !== resolveInside(root, ".flywheel/contract/verification.json")) {
    throw new Error("Compact verification role must be .flywheel/contract/verification.json");
  }
  if (manifest.workflow === "compact") {
    const config = await readVerificationConfig(byId.get("verification")!);
    if (config.tasking && !byId.has("tasking-guide")) throw new Error("Compact task execution requires the frozen tasking-guide role");
    if (config.judging && !byId.has("evaluate-guide")) throw new Error("Compact model judging requires the frozen evaluate-guide role");
  }
  for (const id of (manifest.workflow === "compact" ? ["goal", "task", "boundary", "evaluator", "verification"] : [...Object.keys(FLYWHEEL_CONTRACT_ROLE_PATHS), "evaluator"])) {
    if (!byId.has(id)) throw new Error(`Init manifest is missing required artifact: ${id}`);
  }
  for (const [id, expected] of Object.entries(FLYWHEEL_CONTRACT_ROLE_PATHS)) {
    if (manifest.workflow === "compact" && !byId.has(id)) continue;
    if (byId.get(id) !== resolveInside(root, expected)) {
      throw new Error(`Init manifest role ${id} does not match the Runtime contract entry`);
    }
  }
  const taskPath = byId.get("task")!;
  const goalPath = byId.get("goal");
  if (goalPath && goalPath !== resolveInside(root, ".flywheel/goal.md")) {
    throw new Error("Init manifest role goal does not match .flywheel/goal.md");
  }
  const boundaryPath = byId.get("boundary")!;
  const boundary = await loadRuntimeBoundary(boundaryPath);
  const evaluatorPath = byId.get("evaluator")!;
  const trainsetPath = byId.get("train");
  const holdoutPath = byId.get("holdout");
  if ((trainsetPath && !holdoutPath) || (!trainsetPath && holdoutPath)) {
    throw new Error("Init manifest must declare train and holdout together");
  }
  const collectorPath = byId.get("collector");
  const collectorGuidePath = byId.get("collector-guide");
  if ((collectorPath && !collectorGuidePath) || (!collectorPath && collectorGuidePath)) {
    throw new Error("Init manifest must declare collector and collector-guide together");
  }
  return {
    ...workspace,
    ...(manifest.workflow ? { workflow: manifest.workflow, verificationPath: byId.get("verification")!, frozenContractFiles: [...byId.values()] } : {}),
    ...(manifest.assistanceRevision ? { assistanceRevision: manifest.assistanceRevision } : {}),
    boundary, goalPath, taskPath, boundaryPath,
    taskingGuidePath: byId.get("tasking-guide") ?? taskPath,
    evaluateGuidePath: byId.get("evaluate-guide") ?? taskPath,
    artifactPath: resolveInside(root, boundary.artifact.path),
    trainsetPath,
    holdoutPath,
    collectorPath,
    collectorGuidePath,
    evaluatorPath,
    frozenEvaluatorPath: path.join(runtimeDir, "contracts", path.basename(evaluatorPath)),
    runDir: (version: string) => path.join(flywheelDir, "runs", version),
  };
}

export { sha256, sha256Files };
export type { Workspace };
