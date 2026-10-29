import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { changeScopeFor } from "../../services/workspace/scope.ts";
import { sha256, sha256Files } from "../../services/workspace/index.ts";
import type { ChangeScope } from "../../services/workspace/protocol.ts";
import { initGoalPath } from "./proposal.ts";
import { readVerificationConfig } from "../compact-evaluation.ts";

export const INIT_COMPACT_ROLE_PATHS = {
  task: ".flywheel/contract/task.md",
  boundary: ".flywheel/contract/boundary.json",
  verification: ".flywheel/contract/verification.json",
} as const;

export const INIT_SPEC_ROLE_PATHS = {
  task: ".flywheel/contract/task.md",
  boundary: ".flywheel/contract/boundary.json",
  "tasking-guide": ".flywheel/contract/tasking_guide.md",
  requirements: ".flywheel/contract/requirements.json",
} as const;

export const INIT_EVALUATION_ROLE_PATHS = {
  "evaluate-guide": ".flywheel/contract/evaluate_guide.md",
  coverage: ".flywheel/contract/coverage.json",
} as const;

export const INIT_CONTRACT_ROLE_PATHS = {
  ...INIT_SPEC_ROLE_PATHS,
  ...INIT_EVALUATION_ROLE_PATHS,
} as const;

interface InitRuntimeBoundary {
  schemaVersion: 1;
  artifact: { path: string };
  change_scope: ChangeScope;
}

export async function loadInitBoundary(file: string): Promise<InitRuntimeBoundary> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("boundary.json must contain an object");
  }
  const value = parsed as Partial<InitRuntimeBoundary> & Record<string, unknown>;
  const paths = (items: unknown): items is string[] => Array.isArray(items)
    && items.every((item) => typeof item === "string" && item.trim());
  const allowed = new Set(["schemaVersion", "artifact", "change_scope"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`boundary.json contains unsupported fields: ${unknown.join(", ")}`);
  if (value.schemaVersion !== 1 || !value.artifact || typeof value.artifact.path !== "string"
    || !value.artifact.path.trim() || !value.change_scope || !paths(value.change_scope.primary)) {
    throw new Error("boundary.json requires schemaVersion 1, artifact.path, and change_scope.primary");
  }
  if (value.change_scope.auxiliary !== undefined && !paths(value.change_scope.auxiliary)) {
    throw new Error("boundary.json change_scope.auxiliary must be an array of paths");
  }
  if (value.change_scope.forbidden !== undefined && !paths(value.change_scope.forbidden)) {
    throw new Error("boundary.json change_scope.forbidden must be an array of paths");
  }
  const scopeKeys = Object.keys(value.change_scope as unknown as Record<string, unknown>);
  const unknownScope = scopeKeys.filter((key) => !["primary", "auxiliary", "forbidden"].includes(key));
  if (unknownScope.length) {
    throw new Error(`boundary.json change_scope contains unsupported fields: ${unknownScope.join(", ")}`);
  }
  return value as InitRuntimeBoundary;
}

export const INIT_CONTRACT_MANIFEST = "manifest.json";

export interface InitContractFile {
  id: string;
  path: string;
}

export interface InitContractManifest {
  schemaVersion: 2;
  workflow?: "compact";
  files: InitContractFile[];
}

export interface ValidatedInitContract {
  workflow?: "compact";
  artifactPath: string;
  manifestPath: string;
  manifestSha256: string;
  files: Array<InitContractFile & { sha256: string }>;
}

export interface ValidatedInitContractSpec {
  artifactPath: string;
  manifestPath: string;
  specSha256: string;
  files: Array<InitContractFile & { sha256: string }>;
  requirementIds: string[];
}

const requiredIds = new Set([...Object.keys(INIT_CONTRACT_ROLE_PATHS), "evaluator"]);

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveContractPath(projectRoot: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || path.isAbsolute(value)) {
    throw new Error(`boundary.json ${field} must be a project-relative path`);
  }
  const resolved = path.resolve(projectRoot, value);
  if (!inside(resolved, projectRoot)) throw new Error(`boundary.json ${field} escapes the project root: ${value}`);
  return resolved;
}

function validateManifestEntries(manifest: InitContractManifest, projectRoot: string): InitContractFile[] {
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.files)) {
    throw new Error("Init contract manifest must declare schemaVersion 2 and files");
  }
  const contractDir = initContractDir(projectRoot);
  const ids = new Set<string>();
  const paths = new Set<string>();
  return manifest.files.map((entry) => {
    const canonical = entry?.path?.replaceAll("\\", "/");
    const prefix = ".flywheel/contract/";
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)
      || typeof entry.path !== "string" || !canonical?.startsWith(prefix) || canonical === prefix
      || paths.has(canonical) || path.isAbsolute(entry.path) || canonical.split("/").includes("..")) {
      throw new Error("Init contract manifest contains an invalid or duplicate file entry");
    }
    const file = path.resolve(projectRoot, canonical);
    if (!inside(file, contractDir)) throw new Error(`Init contract path escapes its root: ${entry.path}`);
    ids.add(entry.id);
    paths.add(canonical);
    return { id: entry.id, path: canonical };
  });
}

function readRequirementIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("requirements.json must contain an object");
  }
  const document = value as { schemaVersion?: unknown; requirements?: unknown };
  if (document.schemaVersion !== 1 || !Array.isArray(document.requirements) || document.requirements.length === 0) {
    throw new Error("requirements.json requires schemaVersion 1 and a non-empty requirements array");
  }
  const ids = new Set<string>();
  for (const item of document.requirements) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("requirements.json contains an invalid requirement");
    }
    const entry = item as { id?: unknown; source?: unknown; text?: unknown };
    if (typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)
      || !["goal", "proposal"].includes(String(entry.source))
      || typeof entry.text !== "string" || !entry.text.trim()) {
      throw new Error("requirements.json requirements need unique id, source, and non-empty text");
    }
    ids.add(entry.id);
  }
  return [...ids];
}

async function validateCoverage(
  value: unknown,
  requirementIds: string[],
  artifacts: Map<string, InitContractFile & { sha256: string }>,
  projectRoot: string,
): Promise<void> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("coverage.json must contain an object");
  }
  const document = value as { schemaVersion?: unknown; checks?: unknown };
  if (![1, 2].includes(Number(document.schemaVersion))
    || !Array.isArray(document.checks) || document.checks.length === 0) {
    throw new Error("coverage.json requires schemaVersion 1 or 2 and a non-empty checks array");
  }
  const knownRequirements = new Set(requirementIds);
  const artifactIds = new Set(artifacts.keys());
  if (document.schemaVersion === 2 && (!artifactIds.has("collector") || !artifactIds.has("collector-guide"))) {
    throw new Error("coverage.json schemaVersion 2 requires frozen collector and collector-guide artifacts");
  }
  const covered = new Set<string>();
  const checkIds = new Set<string>();
  const locators = new Set<string>();
  for (const item of document.checks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("coverage.json contains an invalid check");
    const check = item as {
      id?: unknown;
      requirementIds?: unknown;
      artifactIds?: unknown;
      locator?: unknown;
      oracle?: unknown;
    };
    const locator = typeof check.locator === "string" ? check.locator : "";
    const separator = locator.indexOf("#");
    const locatorArtifactId = separator > 0 ? locator.slice(0, separator) : "";
    const selector = separator > 0 ? locator.slice(separator + 1) : "";
    if (typeof check.id !== "string" || !check.id.trim() || checkIds.has(check.id)
      || !Array.isArray(check.requirementIds) || check.requirementIds.length !== 1
      || !Array.isArray(check.artifactIds) || check.artifactIds.length === 0
      || !check.requirementIds.every((id) => typeof id === "string" && knownRequirements.has(id))
      || !check.artifactIds.every((id) => typeof id === "string" && artifactIds.has(id))
      || !locator.trim() || locators.has(locator)
      || !locatorArtifactId || !selector.trim() || !check.artifactIds.includes(locatorArtifactId)) {
      throw new Error("coverage.json checks need one known requirement, known manifest artifacts, and a unique artifact-prefixed locator");
    }
    if (document.schemaVersion === 2) {
      const oracle = check.oracle;
      if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) {
        throw new Error("coverage.json schemaVersion 2 checks require oracle provenance");
      }
      const provenance = oracle as Record<string, unknown>;
      const source = provenance.source;
      const sourceValid = source && typeof source === "object" && !Array.isArray(source)
        && ["goal", "contract", "project"].includes(String((source as Record<string, unknown>).type))
        && typeof (source as Record<string, unknown>).locator === "string"
        && !!String((source as Record<string, unknown>).locator).trim();
      const hasExpected = Object.prototype.hasOwnProperty.call(provenance, "expected");
      if (!["exact", "semantic"].includes(String(provenance.kind)) || !sourceValid
        || typeof provenance.derivation !== "string" || !provenance.derivation.trim()
        || (provenance.kind === "exact" && !hasExpected)
        || (provenance.kind === "semantic" && hasExpected)) {
        throw new Error(
          "coverage.json schemaVersion 2 oracle requires kind, source.type/source.locator, derivation, and expected only for exact checks",
        );
      }
    }
    const locatorArtifact = artifacts.get(locatorArtifactId)!;
    const locatorContents = await readFile(path.resolve(projectRoot, locatorArtifact.path), "utf8");
    if (!locatorContents.includes(selector)) {
      throw new Error(`coverage.json locator selector is not present in ${locatorArtifactId}: ${selector}`);
    }
    checkIds.add(check.id);
    locators.add(locator);
    const requirementId = check.requirementIds[0] as string;
    if (covered.has(requirementId)) {
      throw new Error(`coverage.json maps a frozen requirement more than once: ${requirementId}`);
    }
    covered.add(requirementId);
  }
  const missing = requirementIds.filter((id) => !covered.has(id));
  if (missing.length) throw new Error(`coverage.json does not map every frozen requirement: ${missing.join(", ")}`);
}

export function initContractDir(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".flywheel", "contract");
}

/** Validate only the semantic task package produced before evaluator generation. */
export async function validateInitContractSpec(projectRootInput: string): Promise<ValidatedInitContractSpec> {
  const projectRoot = path.resolve(projectRootInput);
  const contractDir = initContractDir(projectRoot);
  const manifestPath = path.join(contractDir, INIT_CONTRACT_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InitContractManifest;
  const entries = validateManifestEntries(manifest, projectRoot);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const [id, expectedPath] of Object.entries(INIT_SPEC_ROLE_PATHS)) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`Init contract manifest is missing required semantic artifact: ${id}`);
    if (entry.path !== expectedPath) {
      throw new Error(`Init contract role ${id} must map to ${expectedPath}; received ${entry.path}`);
    }
  }
  return await validateInitContractSpecFiles(projectRoot);
}

/** Check frozen semantic files even while the Evaluator is rewriting its manifest. */
export async function validateInitContractSpecFiles(projectRootInput: string): Promise<ValidatedInitContractSpec> {
  const projectRoot = path.resolve(projectRootInput);
  const manifestPath = path.join(initContractDir(projectRoot), INIT_CONTRACT_MANIFEST);
  const byId = new Map(Object.entries(INIT_SPEC_ROLE_PATHS).map(([id, file]) => [id, { id, path: file }]));
  const files: ValidatedInitContractSpec["files"] = [];
  for (const id of Object.keys(INIT_SPEC_ROLE_PATHS)) {
    const entry = byId.get(id)!;
    const file = path.resolve(projectRoot, entry.path);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Init contract file must be a regular file: ${entry.path}`);
    files.push({ ...entry, sha256: await sha256(file) });
  }
  const boundary = await loadInitBoundary(path.resolve(projectRoot, byId.get("boundary")!.path));
  changeScopeFor(boundary);
  const artifactPath = resolveContractPath(projectRoot, boundary.artifact.path, "artifact.path");
  const flywheelDir = path.join(projectRoot, ".flywheel");
  if (inside(artifactPath, flywheelDir)) throw new Error("boundary.json artifact.path must stay outside .flywheel");
  const artifactStat = await lstat(artifactPath);
  if (artifactStat.isSymbolicLink()) throw new Error("Init artifact path may not be a symbolic link");
  const requirementsPath = path.resolve(projectRoot, byId.get("requirements")!.path);
  const requirementIds = readRequirementIds(JSON.parse(await readFile(requirementsPath, "utf8")));
  return {
    artifactPath,
    manifestPath,
    specSha256: await sha256Files(files.map((file) => path.resolve(projectRoot, file.path))),
    files,
    requirementIds,
  };
}

/** Validate the Contract Agent's files in their canonical location. */
export async function validateInitContract(projectRootInput: string): Promise<ValidatedInitContract> {
  const projectRoot = path.resolve(projectRootInput);
  const flywheelDir = path.join(projectRoot, ".flywheel");
  const contractDir = path.join(flywheelDir, "contract");
  const manifestPath = path.join(contractDir, INIT_CONTRACT_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InitContractManifest;
  const entries = validateManifestEntries(manifest, projectRoot);
  const ids = new Set(entries.map((entry) => entry.id));
  const files: ValidatedInitContract["files"] = [];
  for (const entry of entries) {
    const file = path.resolve(projectRoot, entry.path);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Init contract file must be a regular file: ${entry.path}`);
    }
    files.push({ ...entry, sha256: await sha256(file) });
  }
  const compact = manifest.workflow === "compact";
  if (manifest.workflow !== undefined && !compact) throw new Error("Unsupported Init workflow");
  for (const id of compact ? ["task", "boundary", "evaluator", "verification"] : requiredIds) {
    if (!ids.has(id)) throw new Error(`Init contract manifest is missing required artifact: ${id}`);
  }

  const byId = new Map(files.map((file) => [file.id, file]));
  for (const [id, expectedPath] of Object.entries(compact ? INIT_COMPACT_ROLE_PATHS : INIT_CONTRACT_ROLE_PATHS)) {
    const actualPath = byId.get(id)!.path.replaceAll("\\", "/");
    if (actualPath !== expectedPath) {
      throw new Error(`Init contract role ${id} must map to ${expectedPath}; received ${actualPath}`);
    }
  }

  const boundary = await loadInitBoundary(path.resolve(projectRoot, byId.get("boundary")!.path));
  changeScopeFor(boundary);
  const artifactPath = resolveContractPath(projectRoot, boundary.artifact.path, "artifact.path");
  if (inside(artifactPath, flywheelDir)) throw new Error("boundary.json artifact.path must stay outside .flywheel");
  const artifactStat = await lstat(artifactPath);
  if (artifactStat.isSymbolicLink()) throw new Error("Init artifact path may not be a symbolic link");

  if (ids.has("train") !== ids.has("holdout")) throw new Error("train and holdout must be paired");
  if (compact) {
    const config = await readVerificationConfig(path.resolve(projectRoot, byId.get("verification")!.path));
    if (config.tasking && !ids.has("tasking-guide")) throw new Error("tasking requires tasking-guide");
    if (config.judging && !ids.has("evaluate-guide")) throw new Error("judging requires evaluate-guide");
  } else {
    const requirementIds = readRequirementIds(JSON.parse(await readFile(path.resolve(projectRoot, byId.get("requirements")!.path), "utf8")));
    await validateCoverage(
    JSON.parse(await readFile(path.resolve(projectRoot, byId.get("coverage")!.path), "utf8")),
    requirementIds,
    byId,
    projectRoot,
    );
  }

  return {
    ...(compact ? { workflow: "compact" as const } : {}),
    artifactPath,
    manifestPath,
    manifestSha256: await sha256(manifestPath),
    files,
  };
}

/** Freeze the validated contract hashes as the ready manifest. */
export async function writeInitManifest(projectRootInput: string, assistanceRevision?: string): Promise<void> {
  const projectRoot = path.resolve(projectRootInput);
  const flywheelDir = path.join(projectRoot, ".flywheel");
  const contract = await validateInitContract(projectRoot);
  const files = contract.files.map((file) => ({
    id: file.id,
    path: file.path,
    sha256: file.sha256,
  }));
  files.push({
    id: "goal",
    path: ".flywheel/goal.md",
    sha256: await sha256(initGoalPath(projectRoot)),
  });
  const manifest = {
    schemaVersion: 4,
    ...(contract.workflow ? { workflow: contract.workflow } : {}),
    ...(contract.workflow === "compact" && assistanceRevision ? { assistanceRevision } : {}),
    status: "ready",
    baseline: "v1",
    confirmedAt: new Date().toISOString(),
    contractManifestSha256: contract.manifestSha256,
    files,
  };
  await mkdir(path.join(flywheelDir, "init"), { recursive: true });
  await writeFile(
    path.join(flywheelDir, "init", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
