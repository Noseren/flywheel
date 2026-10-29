import { createHash } from "node:crypto";
import {
  access,
  copyFile as copyFileFs,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

import { applyWorkspacePatch, validateWorkspacePatch, type WorkspacePatchOptions } from "./patch.ts";
import { validateChangedFiles } from "./scope.ts";
import type { ChangeScope } from "./protocol.ts";

/** Task-independent filesystem identity shared by state, version, and Capability code. */
export interface Workspace {
  root: string;
  pluginRoot: string;
  flywheelDir: string;
  runtimeDir: string;
  statePath: string;
  eventsPath: string;
}

export function createWorkspace(rootInput: string, pluginRootInput?: string): Workspace {
  const root = path.resolve(rootInput);
  const flywheelDir = path.join(root, ".flywheel");
  const runtimeDir = path.join(flywheelDir, "runtime");
  return {
    root,
    pluginRoot: path.resolve(pluginRootInput ?? path.join(import.meta.dirname, "..", "..", "..", "..")),
    flywheelDir,
    runtimeDir,
    statePath: path.join(runtimeDir, "state.json"),
    eventsPath: path.join(runtimeDir, "events.jsonl"),
  };
}

/** Resolve a user-declared path inside one explicit workspace root. */
export function resolveInside(rootInput: string, value: string): string {
  const root = path.resolve(rootInput);
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (!value.trim() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${value}`);
  }
  return resolved;
}

export async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export async function sha256Files(files: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = await readFile(file);
    hash.update(file).update("\0").update(String(contents.length)).update("\0").update(contents);
  }
  return hash.digest("hex");
}

export interface WorkspaceService extends Workspace {
  readonly roots: readonly string[];
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  parent(file: string): string;
  exists(file: string): Promise<boolean>;
  mkdir(directory: string): Promise<void>;
  ensureDir(directory: string): Promise<void>;
  readText(file: string): Promise<string>;
  readJson<T = unknown>(file: string): Promise<T>;
  readFrontmatter(file: string): Promise<Record<string, unknown>>;
  writeText(file: string, contents: string): Promise<void>;
  writeJson(file: string, value: unknown): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  copyTree(from: string, to: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(target: string): Promise<void>;
  removeTree(target: string): Promise<void>;
  sha256(file: string): Promise<string>;
  validateChanges(scope: ChangeScope, changedPaths: string[]): void;
  validatePatch(options: WorkspacePatchOptions): ReturnType<typeof validateWorkspacePatch>;
  applyPatch(options: WorkspacePatchOptions): Promise<string[]>;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Create the single task-independent filesystem facade used by Policies.
 * It enforces lexical root containment; process-level isolation remains a separate concern.
 */
export function createWorkspaceService(options: {
  workspace: Workspace;
  roots?: readonly string[];
}): WorkspaceService {
  const workspace = options.workspace;
  const roots = [...new Set((options.roots ?? [workspace.root]).map((root) => path.resolve(root)))];
  if (!roots.length) throw new Error("WorkspaceService requires at least one authorized root");

  const authorize = (value: string): string => {
    if (!value.trim()) throw new Error("Workspace path may not be empty");
    const absolute = path.resolve(value);
    if (!roots.some((root) => isInside(root, absolute))) {
      throw new Error(`Path is outside authorized workspace roots: ${value}`);
    }
    return absolute;
  };
  const join = (...parts: string[]): string => authorize(path.join(...parts));
  const parent = (file: string): string => authorize(path.dirname(authorize(file)));
  const ensureParent = async (file: string): Promise<void> => {
    await mkdir(parent(file), { recursive: true });
  };
  const remove = async (target: string): Promise<void> => {
    await rm(authorize(target), { recursive: true, force: true });
  };

  return {
    ...workspace,
    roots,
    join,
    resolve: (...parts) => authorize(path.resolve(...parts)),
    relative: (from, to) => path.relative(authorize(from), authorize(to)),
    parent,
    exists: async (file) => {
      try { await access(authorize(file)); return true; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    mkdir: async (directory) => { await mkdir(authorize(directory), { recursive: true }); },
    ensureDir: async (directory) => { await mkdir(authorize(directory), { recursive: true }); },
    readText: async (file) => await readFile(authorize(file), "utf8"),
    readJson: async <T = unknown>(file: string) => JSON.parse(await readFile(authorize(file), "utf8")) as T,
    readFrontmatter: async (file) => {
      const text = await readFile(authorize(file), "utf8");
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!match) throw new Error(`Missing YAML frontmatter: ${file}`);
      const value = parseYaml(match[1] ?? "");
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Frontmatter must be an object: ${file}`);
      }
      return value as Record<string, unknown>;
    },
    writeText: async (file, contents) => {
      const target = authorize(file); await ensureParent(target); await writeFile(target, contents, "utf8");
    },
    writeJson: async (file, value) => {
      const target = authorize(file); await ensureParent(target); await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    },
    copyFile: async (from, to) => {
      const target = authorize(to); await ensureParent(target); await copyFileFs(authorize(from), target);
    },
    copyTree: async (from, to) => {
      const target = authorize(to); await ensureParent(target); await cp(authorize(from), target, { recursive: true });
    },
    move: async (from, to) => {
      const target = authorize(to); await ensureParent(target); await rename(authorize(from), target);
    },
    remove,
    removeTree: remove,
    sha256: async (file) => await sha256(authorize(file)),
    validateChanges: (scope, changedPaths) => validateChangedFiles({ change_scope: scope }, changedPaths),
    validatePatch: async (patchOptions) => await validateWorkspacePatch({
      ...patchOptions,
      root: authorize(patchOptions.root),
      proposalDir: authorize(patchOptions.proposalDir),
      protectedPaths: patchOptions.protectedPaths?.map(authorize),
    }),
    applyPatch: async (patchOptions) => await applyWorkspacePatch({
      ...patchOptions,
      root: authorize(patchOptions.root),
      proposalDir: authorize(patchOptions.proposalDir),
      protectedPaths: patchOptions.protectedPaths?.map(authorize),
    }),
  };
}
