import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256, type Workspace } from "../workspace/index.ts";
import type { ActiveRecordPointer, ArtifactRef, VersionRecord } from "./records-protocol.ts";

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function contentHash(content: string): string { return createHash("sha256").update(content).digest("hex"); }

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
}

async function writeImmutable(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  try {
    await link(temporary, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(file, "utf8") !== content) {
      throw new Error(`Immutable version record already exists with different content: ${file}`);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function safeName(kind: string, value: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Invalid ${kind}: ${value}`);
  return value;
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Generic immutable JSON records plus named active pointers. This service verifies
 * identity, hashes and paths only; a Capability owns every record schema and gate.
 */
export class VersionRecordStore {
  readonly root: string;
  readonly workspace: Workspace;

  constructor(workspace: Workspace) {
    this.workspace = workspace;
    this.root = path.join(workspace.flywheelDir, "version", "records");
  }

  private collectionRoot(collection: string): string {
    return path.join(this.root, safeName("record collection", collection));
  }

  private recordPath(collection: string, id: string): string {
    return path.join(this.collectionRoot(collection), "immutable", `${safeName("record id", id)}.json`);
  }

  private stagedPath(collection: string, id: string): string {
    return path.join(this.collectionRoot(collection), "staging", `${safeName("record id", id)}.json`);
  }

  private activePath(collection: string): string {
    return path.join(this.collectionRoot(collection), "active.json");
  }

  private assertRecord(value: unknown, expectedId: string): asserts value is { id: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || (value as { id?: unknown }).id !== expectedId) {
      throw new Error(`Invalid version record identity: ${expectedId}`);
    }
  }

  async verifyRef(ref: ArtifactRef): Promise<void> {
    if (!ref.id || !ref.version || !/^[a-f0-9]{64}$/i.test(ref.sha256)) {
      throw new Error(`Invalid artifact reference: ${ref.id || "<unknown>"}`);
    }
    if (ref.path) {
      const file = path.resolve(this.workspace.root, ref.path);
      if (!inside(file, this.workspace.root) || await sha256(file) !== ref.sha256) {
        throw new Error(`Artifact reference hash mismatch: ${ref.path}`);
      }
    } else if (!ref.externalRef) {
      throw new Error(`Artifact reference ${ref.id} has no location`);
    }
  }

  async resolveRef(ref: ArtifactRef): Promise<string | undefined> {
    await this.verifyRef(ref);
    return ref.path ? path.resolve(this.workspace.root, ref.path) : undefined;
  }

  async fileRef(id: string, version: string, file: string): Promise<ArtifactRef | undefined> {
    if (!inside(file, this.workspace.root)) throw new Error(`Artifact reference escapes workspace: ${file}`);
    if (!await exists(file)) return undefined;
    return { id, version, path: path.relative(this.workspace.root, file), sha256: await sha256(file) };
  }

  snapshotRef(version: string, treeHash: string): ArtifactRef {
    return {
      id: "artifact",
      version,
      externalRef: `snapshot:${version}`,
      sha256: contentHash(`git-tree:${treeHash}`),
    };
  }

  async write<T extends { id: string }>(collection: string, record: T): Promise<T> {
    safeName("record id", record.id);
    await writeImmutable(this.recordPath(collection, record.id), json(record));
    return record;
  }

  async load<T extends { id: string } = VersionRecord>(collection: string, id: string): Promise<T> {
    const value = JSON.parse(await readFile(this.recordPath(collection, id), "utf8")) as unknown;
    this.assertRecord(value, id);
    return value as T;
  }

  async hash(collection: string, id: string): Promise<string> {
    await this.load(collection, id);
    return contentHash(await readFile(this.recordPath(collection, id), "utf8"));
  }

  async stage<T extends { id: string }>(collection: string, record: T): Promise<T> {
    safeName("record id", record.id);
    await writeImmutable(this.stagedPath(collection, record.id), json(record));
    return record;
  }

  async loadStaged<T extends { id: string } = VersionRecord>(collection: string, id: string): Promise<T> {
    const value = JSON.parse(await readFile(this.stagedPath(collection, id), "utf8")) as unknown;
    this.assertRecord(value, id);
    return value as T;
  }

  async hashStaged(collection: string, id: string): Promise<string> {
    await this.loadStaged(collection, id);
    return contentHash(await readFile(this.stagedPath(collection, id), "utf8"));
  }

  async commitStaged<T extends { id: string } = VersionRecord>(collection: string, id: string): Promise<T> {
    const record = await this.loadStaged<T>(collection, id);
    return await this.write(collection, record);
  }

  async activate(collection: string, id: string): Promise<ActiveRecordPointer> {
    await this.load(collection, id);
    const previous = await this.activePointer(collection);
    const pointer: ActiveRecordPointer = {
      id,
      recordSha256: await this.hash(collection, id),
      ...(previous && previous.id !== id ? { previousId: previous.id } : {}),
      updatedAt: new Date().toISOString(),
    };
    await writeAtomic(this.activePath(collection), json(pointer));
    return pointer;
  }

  async activePointer(collection: string): Promise<ActiveRecordPointer | undefined> {
    const file = this.activePath(collection);
    if (!await exists(file)) return undefined;
    const pointer = JSON.parse(await readFile(file, "utf8")) as ActiveRecordPointer;
    if (!pointer.id || pointer.recordSha256 !== await this.hash(collection, pointer.id)) {
      throw new Error(`Active ${collection} record pointer hash mismatch`);
    }
    return pointer;
  }

  async active<T extends { id: string } = VersionRecord>(collection: string): Promise<T | undefined> {
    const pointer = await this.activePointer(collection);
    return pointer ? await this.load<T>(collection, pointer.id) : undefined;
  }

  async rollback(collection: string, failedId: string): Promise<string | undefined> {
    const pointer = await this.activePointer(collection);
    if (!pointer || pointer.id !== failedId) throw new Error(`Record ${failedId} is not active in ${collection}`);
    if (!pointer.previousId) {
      await unlink(this.activePath(collection));
      return undefined;
    }
    const restored = await this.load(collection, pointer.previousId);
    await writeAtomic(this.activePath(collection), json({
      id: restored.id,
      recordSha256: await this.hash(collection, restored.id),
      updatedAt: new Date().toISOString(),
    } satisfies ActiveRecordPointer));
    return restored.id;
  }
}
