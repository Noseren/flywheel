import { execFile } from "node:child_process";
import path from "node:path";

// Fixed script only: no browser-supplied text is interpolated into PowerShell.
const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Flywheel 项目文件夹'
$dialog.ShowNewFolderButton = $false
try {
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
}
`;

export async function pickWindowsFolder(signal: AbortSignal): Promise<string | null> {
  if (process.platform !== "win32") throw new Error("系统文件夹选择框目前仅支持 Windows，请手动输入目录路径。");
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, signal, timeout: 300_000, maxBuffer: 65_536, encoding: "utf8" }, (error, stdout) => {
        if (error) { reject(new Error("文件夹选择框未能完成，请重试或手动输入路径。")); return; }
        resolve(stdout || null);
      });
    child.stdin?.end();
  });
}
