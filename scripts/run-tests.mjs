import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith("._")) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(target));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(target);
  }
  return files;
}

const tests = (await discover(path.resolve("test"))).sort();
if (!tests.length) throw new Error("No test files were discovered");

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  throw error;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
