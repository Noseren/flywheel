import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface CommandReceipt {
  commandId: string;
  clientRequestId: string;
  fingerprint: string;
  status: "accepted" | "running" | "completed" | "failed" | "interrupted";
  acceptedAt: string;
  updatedAt: string;
  error?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");

/** Durable admission is separate from slow execution. Reopening never silently replays work. */
export class CommandInbox {
  private readonly receipts = new Map<string, CommandReceipt>();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  readonly file: string;
  private readonly onChange: (receipt: CommandReceipt) => Promise<void>;
  constructor(file: string, onChange: (receipt: CommandReceipt) => Promise<void>) {
    this.file = file;
    this.onChange = onChange;
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async append(receipt: CommandReceipt): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(receipt)}\n`, "utf8");
    this.receipts.set(receipt.clientRequestId, receipt);
    await this.onChange({ ...receipt });
  }
  private async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const lines = (await readFile(this.file, "utf8")).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const receipt = JSON.parse(line) as CommandReceipt;
        if (!receipt.clientRequestId || !receipt.commandId || !receipt.fingerprint) throw new Error("Invalid command receipt journal");
        this.receipts.set(receipt.clientRequestId, receipt);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.initialized = true;
    for (const receipt of this.receipts.values()) {
      if (receipt.status === "accepted" || receipt.status === "running") await this.append({ ...receipt,
        status: "interrupted", updatedAt: new Date().toISOString(), error: "处理被中断，未自动重新执行。请查看当前进度后明确重试。" });
    }
  }
  async lookup(id: string, payload?: unknown): Promise<CommandReceipt | undefined> {
    return this.exclusive(async () => {
      await this.initialize();
      const receipt = this.receipts.get(id);
      if (receipt && payload !== undefined && receipt.fingerprint !== fingerprint(payload)) throw new Error("同一请求编号不能用于不同内容。");
      return receipt && { ...receipt };
    });
  }
  async list(): Promise<CommandReceipt[]> {
    return this.exclusive(async () => { await this.initialize(); return [...this.receipts.values()].map((r) => ({ ...r })); });
  }
  async accept(id: string, payload: unknown, execute: () => Promise<unknown>): Promise<CommandReceipt> {
    return this.exclusive(async () => {
      await this.initialize();
      if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new Error("Invalid clientRequestId");
      const digest = fingerprint(payload);
      const previous = this.receipts.get(id);
      if (previous) {
        if (previous.fingerprint !== digest) throw new Error("同一请求编号不能用于不同内容。");
        return { ...previous };
      }
      const now = new Date().toISOString();
      const receipt: CommandReceipt = { commandId: randomUUID(), clientRequestId: id, fingerprint: digest,
        status: "accepted", acceptedAt: now, updatedAt: now };
      await this.append(receipt);
      // Do not hold the admission lock during execution; stop/abort must always get through.
      setImmediate(() => { void (async () => {
        try {
          await this.exclusive(() => this.append({ ...receipt, status: "running", updatedAt: new Date().toISOString() }));
          await execute();
          await this.exclusive(() => this.append({ ...receipt, status: "completed", updatedAt: new Date().toISOString() }));
        } catch (error) {
          await this.exclusive(() => this.append({ ...receipt, status: "failed", updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error) }));
        }
      })().catch(() => undefined); });
      return { ...receipt };
    });
  }
}
