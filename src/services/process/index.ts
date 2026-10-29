import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessService {
  run: typeof runProcess;
  checked: typeof checkedProcess;
}

export async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; input?: string; maxOutputBytes?: number } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutMs
      ? setTimeout(() => controller.abort(new Error(`Process timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
      : undefined;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      signal: controller.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end(options.input);
    // A command may exit before consuming stdin. Its exit status remains the evidence.
    child.stdin.on("error", () => undefined);
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const collect = (chunk: string, stream: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);
      if (options.maxOutputBytes !== undefined && bytes > options.maxOutputBytes) {
        controller.abort(new Error(`Process output exceeded ${options.maxOutputBytes} bytes`));
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, "stdout"));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => collect(chunk, "stderr"));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
      cleanup();
    });
  });
}

export async function checkedProcess(command: string, args: string[], cwd?: string): Promise<string> {
  const result = await runProcess(command, args, { cwd });
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${result.stderr.slice(-2000)}`);
  return result.stdout;
}

/** Default process effect bound into Capability service sets. */
export const defaultProcessService: ProcessService = {
  run: runProcess,
  checked: checkedProcess,
};
