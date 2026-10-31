import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Context } from "./compact.ts";
import type { JobSpec } from "../../../services/agent/job-protocol.ts";

/** Enumerate only regular files from a VersionStore-created isolated tree. Never follow symlinks. */
export async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", ".flywheel", ".aws", ".ssh", ".codex", ".agents"].includes(entry.name)
        || (entry.name.startsWith(".env") && entry.name !== ".env.example")) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(file);
    }
  }
  await walk(root);
  return result.sort();
}

export async function formalSource(context: Context, version: string, treeHash: string) {
  const { services } = context;
  const root = services.workspace.join(services.project.runtimeDir, "components", "formal-source", treeHash);
  await services.version.createWorktree(version, root);
  if (await services.version.worktreeTreeHash(root) !== treeHash) throw new Error("Formal source snapshot changed");
  const files = await sourceFiles(root);
  return await Promise.all(files.map(async path => ({ path, sha256: await services.workspace.sha256(path) })));
}

/** Private Policy decision, with durable invocation authority and no replay of unknown transport. */
export async function privateDecision<T>(context: Context, directory: string, job: JobSpec, reportPath: string, parse: (value: unknown) => T, deadlineMs?: number): Promise<T> {
  const { services } = context, budget = services.executionBudget!, reservationId = job.invocationReservation!.reservationId;
  const recordPath = services.workspace.join(directory, "execution.json");
  type Record = { phase: "running" | "completed"; before: string[]; deadline?: number; repair: boolean; hash?: string; resultHash?: string;
    reservationId: string; inputs: { path: string; sha256: string }[] };
  let record = await services.workspace.exists(recordPath) ? await services.workspace.readJson<Record>(recordPath) : undefined;
  if (record) for (const input of record.inputs) if (await services.workspace.sha256(input.path) !== input.sha256) throw new Error("Private decision input changed");
  if (record?.phase === "completed") {
    if (await services.workspace.sha256(reportPath) !== record.hash || await services.workspace.sha256(job.resultPath!) !== record.resultHash) throw new Error("Private decision evidence changed");
    return parse(await services.workspace.readJson(reportPath));
  }
  const execute = async () => {
    const remaining = record!.deadline === undefined ? undefined : record!.deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) throw new Error("Private decision original authorization expired");
    const signal = remaining === undefined ? context.signal : AbortSignal.any([context.signal, AbortSignal.timeout(Math.ceil(remaining))]);
    const result = await services.guard.project(context.state, job.label, async () => await services.agent.execute(context.state, job, signal));
    if (result.status !== "completed" || signal.aborted) throw new Error("Private decision did not complete within original authority");
  };
  if (!record) {
    record = { phase: "running", before: Object.keys(budget.state.invocations), repair: false, reservationId,
      inputs: await Promise.all(job.readRoots.map(async path => ({ path, sha256: await services.workspace.sha256(path) }))),
      ...(deadlineMs ? { deadline: Date.now() + deadlineMs } : {}) };
    await services.workspace.writeJson(recordPath, record);
    await execute();
  }
  for (;;) {
    const calls = Object.entries(budget.state.invocations).filter(([id, call]) => !record!.before.includes(id) && call.reservationId === record!.reservationId);
    if (!calls.length || calls.some(([, call]) => call.endedAt === undefined || call.tokens === undefined || call.interrupted)) throw new Error("Private decision invocation terminal state unknown; no replay");
    if (record.deadline !== undefined && calls.some(([, call]) => call.endedAt! > record!.deadline!)) throw new Error("Private decision completed after original authorization expired");
    for (const input of record.inputs) if (await services.workspace.sha256(input.path) !== input.sha256) throw new Error("Private decision input changed");
    let parsed: T;
    try {
      const terminal = await services.artifact.readJobResult(job);
      if (terminal.status !== "completed" || !terminal.artifacts.some(file => path.resolve(job.cwd, file) === path.resolve(reportPath))) throw new Error("Private decision JobResult does not include its report");
      parsed = parse(await services.workspace.readJson(reportPath));
    } catch (error) {
      if (record.repair) throw error;
      await budget.claimRepair();
      if (budget.state.reservations?.[reservationId]?.kind === "required") {
        const repairReservation = `${reservationId}:protocol-repair`;
        await budget.reserveRequiredWork(repairReservation, budget.estimateInvocation(job.invocationReservation?.estimateClass));
        job = { ...job, invocationReservation: { ...job.invocationReservation!, reservationId: repairReservation } };
        record.reservationId = repairReservation;
      }
      record = { ...record, repair: true, before: Object.keys(budget.state.invocations) };
      await services.workspace.writeJson(recordPath, record);
      job = { ...job, prompt: services.prompt("common.decision-repair", { decision_path: reportPath, issues: String(error), base_prompt: job.prompt }) };
      await execute();
      continue;
    }
    await services.workspace.writeJson(recordPath, { ...record, phase: "completed", hash: await services.workspace.sha256(reportPath), resultHash: await services.workspace.sha256(job.resultPath!) });
    if (record.reservationId !== reservationId) await budget.closeReservation(record.reservationId);
    return parsed;
  }
}

export async function publicSource(root: string, excludedRelativePaths: string[] = []) {
  const { readFile } = await import("node:fs/promises");
  const files: string[] = [], omitted: { path: string; reason: string }[] = [];
  const canonical = (file: string) => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
  const excluded = new Set(excludedRelativePaths.map(file => canonical(path.resolve(root, file))));
  let bytes = 0;
  for (const file of await sourceFiles(root)) {
    // Manifest roles retain their privacy after VersionStore relocates the tree.
    // Do not expose private filenames through the public omission manifest either.
    if (excluded.has(canonical(file))) continue;
    const content = await readFile(file);
    let reason: string | undefined;
    if (content.length > 1_048_576) reason = "text exceeds per-file snapshot limit";
    else if (content.includes(0)) reason = "binary content";
    else { try { new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { reason = "non-UTF8 content"; } }
    if (!reason && (files.length >= 1000 || bytes + content.length > 15_000_000)) reason = "bounded public snapshot limit";
    if (reason) omitted.push({ path: path.relative(root, file), reason });
    else { files.push(file); bytes += content.length; }
  }
  return { files, omissions: { total: omitted.length, examples: omitted.slice(0, 100) } };
}
