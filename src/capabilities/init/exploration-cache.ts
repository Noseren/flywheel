import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Bounded byte identity only, never an authorization check or semantic data inspection.
 * Provider sandbox setup can change NTFS ctime/attributes without changing project facts.
 * Hash bytes, not timestamps; never parse data or follow symlinks outside this project.
 * Huge trees disable reuse rather than introducing unbounded preparation work.
 */
export async function explorationSourceFingerprint(projectRoot: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  let visited = 0;
  let bytes = 0n;
  const ignored = new Set([".flywheel", ".git", "node_modules", ".venv", "__pycache__"]);
  const walk = async (directory: string): Promise<boolean> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 10_000) return false;
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!await walk(file)) return false; }
      else {
        const info = await lstat(file, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink()) return false;
        bytes += info.size;
        if (bytes > 64n * 1024n * 1024n || info.size > 8n * 1024n * 1024n) return false;
        const contents = await readFile(file);
        hash.update(`${path.relative(projectRoot, file)}\0${info.mode}\0${createHash("sha256").update(contents).digest("hex")}\n`);
      }
    }
    return true;
  };
  return await walk(projectRoot) ? hash.digest("hex") : undefined;
}
