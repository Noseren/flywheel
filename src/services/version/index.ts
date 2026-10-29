import { access, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { checkedProcess, runProcess } from "../process/index.ts";
import type { Workspace } from "../workspace/index.ts";
import { VersionRecordStore } from "./records.ts";

export type { ActiveRecordPointer, ArtifactRef, VersionRecord } from "./records-protocol.ts";
export { VersionRecordStore } from "./records.ts";

const identity = {
  ...process.env,
  GIT_AUTHOR_NAME: "flywheel",
  GIT_AUTHOR_EMAIL: "flywheel@local",
  GIT_COMMITTER_NAME: "flywheel",
  GIT_COMMITTER_EMAIL: "flywheel@local",
};

/** Keep snapshots byte-stable regardless of the user's platform Git settings. */
const stableGitConfig = [
  "-c", "core.autocrlf=false",
  "-c", "core.eol=lf",
  // Git for Windows still needs this even when Node can address the same path.
  // Candidate repositories commonly contain long nested test paths.
  "-c", "core.longpaths=true",
];

const runtimeIgnore = [
  ".flywheel/",
  ".git/",
];

const defaultSnapshotIgnore = [
  ...runtimeIgnore,
  "node_modules/",
  "dist/",
  "build/",
  "coverage/",
  ".cache/",
  ".tmp/",
  "tmp/",
  "temp/",
  "__pycache__/",
  ".pytest_cache/",
  ".mypy_cache/",
  ".venv/",
  "venv/",
  "target/",
  "*.log",
  "*.tsbuildinfo",
  ".DS_Store",
  ".env",
  ".env.*",
  "!.env.example",
];

const internalPathspecs = [
  ":(exclude,top).flywheel",
  ":(exclude,top,glob).flywheel/**",
  ":(exclude,top).git",
  ":(exclude,top,glob).git/**",
];

function literalPathspec(file: string): string {
  return `:(literal)${file}`;
}

function batches<T>(values: T[], size = 256): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isSnapshotFile(file: string): Promise<boolean> {
  try {
    const stat = await lstat(file);
    return stat.isFile() || stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Project snapshot service backed by a private bare Git repository.
 * It never versions .flywheel control state and reapplies project ignore rules on every operation.
 */
export class VersionStore {
  readonly project: Workspace;
  readonly historyDir: string;

  constructor(project: Workspace) {
    this.project = project;
    this.historyDir = path.join(project.flywheelDir, "history.git");
  }

  private gitArgs(): string[] {
    return [...stableGitConfig, `--git-dir=${this.historyDir}`, `--work-tree=${this.project.root}`];
  }

  private async ensureRepository(): Promise<void> {
    const check = await runProcess("git", [`--git-dir=${this.historyDir}`, "rev-parse", "--is-bare-repository"]);
    if (check.code === 0) return;
    await mkdir(path.dirname(this.historyDir), { recursive: true });
    const initialized = await runProcess("git", ["init", "--bare", this.historyDir]);
    if (initialized.code !== 0) throw new Error(initialized.stderr);
  }

  private async configureSnapshotScope(): Promise<void> {
    await this.ensureRepository();
    const hasProjectIgnore = await exists(path.join(this.project.root, ".gitignore"));
    const patterns = hasProjectIgnore ? runtimeIgnore : defaultSnapshotIgnore;
    const infoDir = path.join(this.historyDir, "info");
    await mkdir(infoDir, { recursive: true });
    await writeFile(
      path.join(infoDir, "exclude"),
      `# Managed by Flywheel VersionStore.\n${patterns.join("\n")}\n`,
      "utf8",
    );
    // Private snapshots store workspace bytes, not the project's Git transport
    // representation. info/attributes overrides nested .gitattributes as well
    // as user attributes, and also applies to our detached candidate worktrees.
    await writeFile(
      path.join(infoDir, "attributes"),
      "# Managed by Flywheel VersionStore.\n* -text -eol -filter -ident -working-tree-encoding\n",
      "utf8",
    );
  }

  private async ignoredFiles(files: string[]): Promise<Set<string>> {
    const ignored = new Set<string>();
    for (const group of batches(files)) {
      const result = await runProcess("git", [
        ...this.gitArgs(), "check-ignore", "--no-index", "-z", "--stdin",
      ], { cwd: this.project.root, input: `${group.join("\0")}\0` });
      if (![0, 1].includes(result.code)) {
        throw new Error(`Could not evaluate snapshot scope: ${result.stderr}`);
      }
      for (const file of result.stdout.split("\0").filter(Boolean)) ignored.add(file);
    }
    for (const file of await this.sourceTrackedFiles()) ignored.delete(file);
    return ignored;
  }

  /** Use only this project's index, never an implicitly discovered parent repository. */
  private async sourceTrackedFiles(): Promise<string[]> {
    if (!await exists(path.join(this.project.root, ".git"))) return [];
    const output = await checkedProcess("git", [
      ...stableGitConfig, "-C", this.project.root, "ls-files", "--cached", "-z",
      "--", ".", ...internalPathspecs,
    ]);
    return [...new Set(output.split("\0").filter(Boolean))].filter((file) =>
      // Provenance cannot override exclusions for control state or local secrets.
      !file.split("/").some((part) => part === ".git" || part === ".flywheel"
        || (part !== ".env.example" && (part === ".env" || part.startsWith(".env.")))),
    );
  }

  private async trackedChanges(from: string, to?: string): Promise<string[]> {
    const range = to ? [from, to] : [from];
    const output = await checkedProcess("git", [
      ...this.gitArgs(), "diff", "--name-only", "-z", ...range, "--", ".", ...internalPathspecs,
    ]);
    const files = output.split("\0").filter(Boolean);
    const ignored = await this.ignoredFiles(files);
    return files.filter((file) => !ignored.has(file)).sort();
  }

  async hasTag(tag: string): Promise<boolean> {
    const result = await runProcess("git", [`--git-dir=${this.historyDir}`, "rev-parse", "--verify", `refs/tags/${tag}`]);
    return result.code === 0;
  }

  async treeHash(tag: string): Promise<string> {
    if (!await this.hasTag(tag)) throw new Error(`Missing snapshot tag: ${tag}`);
    return (await checkedProcess("git", [`--git-dir=${this.historyDir}`, "rev-parse", `${tag}^{tree}`])).trim();
  }

  async diff(from: string, to?: string): Promise<string> {
    await this.configureSnapshotScope();
    const files = await this.trackedChanges(from, to);
    if (!files.length) return "";
    const range = to ? [from, to] : [from];
    return await checkedProcess("git", [
      ...this.gitArgs(), "diff", "--binary", ...range, "--", ...files.map(literalPathspec),
    ]);
  }

  async changedFiles(from: string, to?: string): Promise<string[]> {
    await this.configureSnapshotScope();
    const files = await this.trackedChanges(from, to);
    if (!to) {
      const untracked = await checkedProcess("git", [
        ...this.gitArgs(), "ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...internalPathspecs,
      ]);
      files.push(...untracked.split("\0").filter(Boolean));
      const previous = new Set((await checkedProcess("git", [
        ...this.gitArgs(), "ls-tree", "-r", "-z", "--name-only", from,
      ])).split("\0").filter(Boolean));
      for (const file of await this.sourceTrackedFiles()) {
        if (!previous.has(file) && await isSnapshotFile(path.join(this.project.root, file))) files.push(file);
      }
    }
    return [...new Set(files)].sort();
  }

  async assertExact(tag: string): Promise<void> {
    const changed = await this.changedFiles(tag);
    if (changed.length) {
      throw new Error(`Working tree does not match ${tag}:\n${changed.slice(0, 20).map((file) => `  - ${file}`).join("\n")}`);
    }
  }

  private checkpointRef(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`Invalid checkpoint id: ${id}`);
    return `refs/flywheel/checkpoints/${id}`;
  }

  /** Snapshot workspace bytes; the source index supplies provenance, never staged content. */
  private async snapshotCommit(message: string): Promise<string> {
    await this.configureSnapshotScope();
    await checkedProcess("git", [...this.gitArgs(), "read-tree", "--empty"], this.project.root);
    const snapshotFiles = (await checkedProcess("git", [
      ...this.gitArgs(), "ls-files", "--others", "--exclude-standard", "-z", "--", ".", ...internalPathspecs,
    ], this.project.root)).split("\0").filter(Boolean);
    for (const files of batches(snapshotFiles)) {
      const add = await runProcess("git", [
        ...this.gitArgs(), "add", "--", ...files.map(literalPathspec),
      ], { cwd: this.project.root, env: identity });
      if (add.code !== 0) throw new Error(add.stderr);
    }
    const sourceFiles: string[] = [];
    for (const file of await this.sourceTrackedFiles()) {
      if (await isSnapshotFile(path.join(this.project.root, file))) sourceFiles.push(file);
    }
    for (const files of batches(sourceFiles)) {
      const add = await runProcess("git", [
        ...this.gitArgs(), "add", "--force", "--", ...files.map(literalPathspec),
      ], { cwd: this.project.root, env: identity });
      if (add.code !== 0) throw new Error(add.stderr);
    }
    const commit = await runProcess("git", [
      ...this.gitArgs(), "commit", "--allow-empty", "-m", message,
    ], { cwd: this.project.root, env: identity });
    if (commit.code !== 0) throw new Error(commit.stderr);
    return (await checkedProcess("git", [`--git-dir=${this.historyDir}`, "rev-parse", "HEAD"])).trim();
  }

  /** Capture an exact project preimage behind a private ref for crash recovery. */
  async createCheckpoint(id: string): Promise<string> {
    const ref = this.checkpointRef(id);
    const existing = await runProcess("git", [`--git-dir=${this.historyDir}`, "rev-parse", "--verify", ref]);
    if (existing.code === 0) return ref;
    const commit = await this.snapshotCommit(`operation checkpoint ${id}`);
    await checkedProcess("git", [`--git-dir=${this.historyDir}`, "update-ref", ref, commit]);
    return ref;
  }

  async restoreCheckpoint(ref: string): Promise<void> {
    if (!ref.startsWith("refs/flywheel/checkpoints/")) throw new Error(`Invalid checkpoint ref: ${ref}`);
    await this.restoreRef(ref);
  }

  async assertCheckpoint(ref: string): Promise<void> {
    if (!ref.startsWith("refs/flywheel/checkpoints/")) throw new Error(`Invalid checkpoint ref: ${ref}`);
    const changed = await this.changedFiles(ref);
    if (changed.length) throw new Error(`Working tree differs from operation checkpoint: ${changed.join(", ")}`);
  }

  async deleteCheckpoint(ref: string): Promise<void> {
    if (!ref.startsWith("refs/flywheel/checkpoints/")) throw new Error(`Invalid checkpoint ref: ${ref}`);
    await checkedProcess("git", [`--git-dir=${this.historyDir}`, "update-ref", "-d", ref]);
  }

  /** Create or verify one detached candidate worktree at an immutable base tag. */
  async createWorktree(tag: string, destination: string): Promise<void> {
    await this.configureSnapshotScope();
    if (!await this.hasTag(tag)) throw new Error(`Missing snapshot tag: ${tag}`);
    const expected = (await checkedProcess("git", [
      `--git-dir=${this.historyDir}`, "rev-parse", `${tag}^{commit}`,
    ])).trim();
    if (await exists(path.join(destination, ".git"))) {
      const actual = (await checkedProcess("git", ["-C", destination, "rev-parse", "HEAD"])).trim();
      if (actual !== expected) throw new Error(`Candidate worktree does not match ${tag}: ${destination}`);
      return;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const result = await runProcess("git", [
      ...stableGitConfig, `--git-dir=${this.historyDir}`, "worktree", "add", "--detach", destination, tag,
    ], { cwd: this.project.root, env: identity });
    if (result.code !== 0) throw new Error(result.stderr);
  }

  /** Stage a candidate tree so its complete tracked and untracked diff is durable evidence. */
  async worktreeChanges(destination: string): Promise<{ files: string[]; diff: string }> {
    await this.configureSnapshotScope();
    const added = await runProcess("git", [...stableGitConfig, "-C", destination, "add", "--all"], { env: identity });
    if (added.code !== 0) throw new Error(added.stderr);
    const files = (await checkedProcess("git", [
      ...stableGitConfig, "-C", destination, "diff", "--cached", "--name-only", "-z",
    ])).split("\0").filter(Boolean).sort();
    const diff = await checkedProcess("git", [...stableGitConfig, "-C", destination, "diff", "--cached", "--binary"]);
    return { files, diff };
  }

  /** Return the exact staged tree evaluated for a candidate without creating a commit. */
  async worktreeTreeHash(destination: string): Promise<string> {
    await this.worktreeChanges(destination);
    return (await checkedProcess("git", [...stableGitConfig, "-C", destination, "write-tree"])).trim();
  }

  /** Commit one selected detached worktree and expose it as the next immutable version tag. */
  async promoteWorktree(destination: string, tag: string, message: string): Promise<void> {
    if (!/^[A-Za-z0-9._/-]+$/.test(tag)) throw new Error(`Invalid tag: ${tag}`);
    const { files } = await this.worktreeChanges(destination);
    if (await this.hasTag(tag)) {
      const tagged = (await checkedProcess("git", [
        ...stableGitConfig, `--git-dir=${this.historyDir}`, "rev-parse", `${tag}^{commit}`,
      ])).trim();
      const head = (await checkedProcess("git", [...stableGitConfig, "-C", destination, "rev-parse", "HEAD"])).trim();
      if (tagged !== head || files.length) throw new Error(`Existing version ${tag} does not match selected worktree`);
      return;
    }
    if (files.length) {
      const committed = await runProcess("git", [
        ...stableGitConfig, "-C", destination, "commit", "-m", message,
      ], { env: identity });
      if (committed.code !== 0) throw new Error(committed.stderr);
    }
    const head = (await checkedProcess("git", [...stableGitConfig, "-C", destination, "rev-parse", "HEAD"])).trim();
    const result = await runProcess("git", [
      `--git-dir=${this.historyDir}`, "tag", "-a", tag, head, "-m", message,
    ], { cwd: this.project.root, env: identity });
    if (result.code !== 0) throw new Error(result.stderr);
  }

  async prepare(target: string): Promise<void> {
    if (target === "KEEP") {
      await checkedProcess("git", [`--git-dir=${this.historyDir}`, "rev-parse", "--is-bare-repository"]);
      return;
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(target) || !await this.hasTag(target)) {
      throw new Error(`Invalid or missing snapshot target: ${target}`);
    }
    await this.restoreRef(target);
  }

  /** Restore an exact tree, including deleting allowed files absent from the target snapshot. */
  private async restoreRef(target: string): Promise<void> {
    await this.configureSnapshotScope();
    const listedTargetFiles = (await checkedProcess("git", [
      ...this.gitArgs(), "ls-tree", "-r", "-z", "--name-only", target,
    ])).split("\0").filter(Boolean);
    const ignoredTargetFiles = await this.ignoredFiles(listedTargetFiles);
    const targetFiles = new Set(listedTargetFiles.filter((file) => !ignoredTargetFiles.has(file)));
    const listedCurrentFiles = (await checkedProcess("git", [
      ...this.gitArgs(), "ls-files", "--cached", "--others", "--exclude-standard", "-z",
      "--", ".", ...internalPathspecs,
    ], this.project.root)).split("\0").filter(Boolean);
    for (const file of await this.sourceTrackedFiles()) {
      if (await isSnapshotFile(path.join(this.project.root, file))) listedCurrentFiles.push(file);
    }
    const ignoredCurrentFiles = await this.ignoredFiles(listedCurrentFiles);
    for (const file of listedCurrentFiles.filter((item) => !ignoredCurrentFiles.has(item))) {
      if (!targetFiles.has(file)) await rm(path.join(this.project.root, file), { force: true });
    }
    await checkedProcess("git", [...this.gitArgs(), "read-tree", target], this.project.root);
    for (const files of batches([...targetFiles])) {
      await checkedProcess("git", [
        ...this.gitArgs(), "checkout", target, "--", ...files.map(literalPathspec),
      ], this.project.root);
    }
  }

  /** Create a public immutable version tag; callers must handle idempotency before calling. */
  async tag(tag: string, message: string): Promise<void> {
    if (!/^[A-Za-z0-9._/-]+$/.test(tag)) throw new Error(`Invalid tag: ${tag}`);
    if (await this.hasTag(tag)) throw new Error(`Snapshot tag already exists: ${tag}`);
    const commit = await this.snapshotCommit(message);
    const result = await runProcess("git", [
      `--git-dir=${this.historyDir}`, "tag", "-a", tag, commit, "-m", message,
    ], { cwd: this.project.root, env: identity });
    if (result.code !== 0) throw new Error(result.stderr);
  }
}

/** One Version service lifecycle: project snapshots plus opaque immutable records. */
export interface VersionService {
  snapshots: VersionStore;
  records: VersionRecordStore;
}

export function createVersionService(workspace: Workspace): VersionService {
  return {
    snapshots: new VersionStore(workspace),
    records: new VersionRecordStore(workspace),
  };
}
