import path from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir } from "node:fs/promises";

export function sharedCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
}

export function flywheelCodexHome(): string {
  return path.resolve(process.env.FLYWHEEL_CODEX_HOME ?? path.join(homedir(), ".flywheel", "codex"));
}

async function copyIfAbsent(source: string, target: string): Promise<void> {
  try { await copyFile(source, target, constants.COPYFILE_EXCL); }
  catch (error) {
    if (!["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Seed credentials/config only; import a legacy rollout only for an explicit resume. */
export async function prepareCodexHome(home: string, legacyHome: string, resumeId?: string): Promise<void> {
  if (path.resolve(home) === path.resolve(legacyHome)) return;
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "config.toml"]) {
    await copyIfAbsent(path.join(legacyHome, name), path.join(home, name));
  }
  if (!resumeId || !/^[a-zA-Z0-9-]+$/.test(resumeId)) return;
  const suffix = `-${resumeId}.jsonl`;
  const destination = path.join(home, "sessions");
  for (const root of [destination, path.join(home, "archived_sessions")]) {
    try { if ((await readdir(root, { recursive: true })).some((entry) => entry.endsWith(suffix))) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const folder of ["sessions", "archived_sessions"]) {
    const root = path.join(legacyHome, folder);
    let entries: string[];
    try { entries = await readdir(root, { recursive: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const match = entries.find((entry) => entry.endsWith(suffix));
    if (!match) continue;
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await copyIfAbsent(path.join(root, match), path.join(destination, path.basename(match)));
    return;
  }
}
