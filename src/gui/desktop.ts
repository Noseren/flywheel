import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/** GUI commands launch the desktop shell; only its child runs the loopback transport. */
export async function desktopLaunchSpec(root: string, args: string[], platform = process.platform) {
  const name = platform === "win32" ? "flywheel-desktop.exe" : "flywheel-desktop";
  const binary = path.join(root, "src-tauri", "target", "release", name);
  try { await access(binary); }
  catch { throw new Error("Tauri 桌面程序尚未构建。请在 Runtime 目录运行 pnpm desktop:build，再执行 flywheel gui。"); }
  return { binary, args: args.includes("--gui-port") ? args : [...args, "--gui-port", "0"] };
}

export async function launchDesktop(args: string[]): Promise<void> {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const spec = await desktopLaunchSpec(root, args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.binary, spec.args, {
      // Preserve relative --project / --goal-file semantics from the caller.
      cwd: process.cwd(), stdio: "inherit", windowsHide: false,
      env: { ...process.env, FLYWHEEL_RUNTIME_ROOT: root, FLYWHEEL_NODE: process.execPath },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Tauri exited: ${code ?? signal}`)));
  });
}
