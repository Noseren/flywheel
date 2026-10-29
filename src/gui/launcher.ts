import { randomUUID } from "node:crypto";
import { embedLogo } from "./logo.ts";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlywheelSession } from "../session/session.ts";
import { startSessionGuiServer, type SessionGuiServer } from "./server.ts";
import { pickWindowsFolder } from "./folder-picker.ts";

export interface LauncherProject { path: string; kind: "new" | "existing"; chain: string[] }
interface LauncherState { schemaVersion: 1; recentProjects: string[] }

export function launcherStatePath(): string {
  const appData = process.platform === "win32"
    ? process.env.LOCALAPPDATA
    : process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(appData || path.join(homedir(), ".flywheel"), "dev.flywheel.runtime", "recent-projects.json");
}

function normalizeRecentProjects(value: unknown): string[] {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return [];
  const input = (value as { recentProjects?: unknown }).recentProjects;
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>(), projects: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || !path.isAbsolute(item)) continue;
    const normalized = path.normalize(item), key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key); projects.push(normalized);
    if (projects.length === 10) break;
  }
  return projects;
}

async function readLauncherState(file: string): Promise<LauncherState> {
  try { return { schemaVersion: 1, recentProjects: normalizeRecentProjects(JSON.parse(await readFile(file, "utf8"))) }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { schemaVersion: 1, recentProjects: [] };
    throw error;
  }
}

async function writeLauncherState(file: string, state: LauncherState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

async function rememberProject(file: string, project: string): Promise<string[]> {
  const current = (await readLauncherState(file)).recentProjects;
  const key = process.platform === "win32" ? path.normalize(project).toLowerCase() : path.normalize(project);
  const recentProjects = [path.normalize(project), ...current.filter(item => (process.platform === "win32" ? item.toLowerCase() : item) !== key)].slice(0, 10);
  await writeLauncherState(file, { schemaVersion: 1, recentProjects });
  return recentProjects;
}

export async function inspectLauncherProject(input: string): Promise<LauncherProject> {
  if (!path.isAbsolute(input)) throw new Error("请输入项目的绝对目录路径。");
  const root = await realpath(input);
  if (!(await stat(root)).isDirectory()) throw new Error("请选择目录，不是文件。");
  try {
    const identity = JSON.parse(await readFile(path.join(root, ".flywheel/runtime/session.json"), "utf8"));
    if (identity.schemaVersion !== 1 || !identity.sessionId || !Array.isArray(identity.capabilities)
      || !identity.capabilities.length || identity.capabilities.some((id: unknown) => id !== "init" && id !== "run")) {
      throw new Error("已有 Session 元数据无法识别；请先检查项目，不会覆盖旧记录。");
    }
    return { path: root, kind: "existing", chain: [...new Set<string>(identity.capabilities)] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try { await stat(path.join(root, ".flywheel")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: root, kind: "new", chain: ["init", "run"] };
    throw error;
  }
  throw new Error("目录存在 .flywheel 但缺少 Session 身份；请使用原命令诊断恢复，不会重新初始化覆盖。");
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new Error("Expected application/json");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65536) throw new Error("请求过大（最多 64 KiB）。");
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected an object");
  return parsed;
}

/** Local CLI entry UI only; execution and recovery remain owned by Session. */
export async function startGuiLauncher(options: {
  directory: string; port?: number; stateFile?: string;
  pickFolder?: (signal: AbortSignal) => Promise<string | null>;
  createSession(project: LauncherProject, goal: string | undefined, iterations: number): Promise<FlywheelSession>;
}) {
  const token = randomUUID();
  let opening = false;
  let picker: AbortController | undefined;
  let active: { project: string; session: FlywheelSession; gui: SessionGuiServer } | undefined;
  const retired = new Set<SessionGuiServer>();
  let origin = "";
  const stateFile = options.stateFile ?? launcherStatePath();

  const projectKey = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  const recentWith = async (project: string): Promise<string[]> => {
    try { return await rememberProject(stateFile, project); }
    catch (error) {
      console.warn(`Unable to persist recent project: ${error instanceof Error ? error.message : String(error)}`);
      let current: string[] = [];
      try { current = (await readLauncherState(stateFile)).recentProjects; } catch { /* Persistence must not block opening a project. */ }
      return [project, ...current.filter((item) => projectKey(item) !== projectKey(project))].slice(0, 10);
    }
  };
  async function workbench(project: LauncherProject, session: FlywheelSession, recentProjects: string[]): Promise<SessionGuiServer> {
    let gui!: SessionGuiServer;
    gui = await startSessionGuiServer(session, {
      port: 0,
      onListening: () => undefined,
      projectNavigation: {
        recentProjects,
        switchProject: async (target) => await switchProject(gui, target),
      },
    });
    return gui;
  }
  async function switchProject(source: SessionGuiServer, target: string): Promise<string> {
    if (opening) throw new Error("正在切换项目，请勿重复提交。");
    opening = true;
    try {
      const current = active;
      if (!current || current.gui !== source) throw new Error("当前工作台已经失效，请使用最新窗口。");
      const liveRecent = (await readLauncherState(stateFile)).recentProjects;
      if (!liveRecent.some((item) => projectKey(item) === projectKey(target))) throw new Error("该目录已不在最近项目中。");
      const project = await inspectLauncherProject(target);
      if (project.kind !== "existing") throw new Error("该项目已不包含可恢复的 Flywheel Session，请从启动页重新打开。");
      if (projectKey(project.path) === projectKey(current.project)) return current.gui.url;

      const session = await options.createSession(project, undefined, 3);
      await session.restorePaused();
      const recentProjects = await recentWith(project.path);
      const gui = await workbench(project, session, recentProjects);
      try { await current.session.dispatch({ type: "session.stop" }); }
      catch (error) {
        await session.dispatch({ type: "session.stop" }).catch(() => undefined);
        await gui.close();
        throw error;
      }
      active = { project: project.path, session, gui };
      retired.add(current.gui);
      setTimeout(() => void current.gui.close().finally(() => retired.delete(current.gui)), 750).unref();
      return gui.url;
    } finally { opening = false; }
  }
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: "Invalid origin" });
      if (url.searchParams.get("token") !== token) return send(403, { error: "链接已失效，请使用终端输出的完整地址。" });
      if (request.method === "GET" && ["/", "/launcher.js", "/launcher.css", "/flywheel-logo.svg"].includes(url.pathname)) {
        const name = url.pathname === "/" ? "launcher.html" : url.pathname.slice(1);
        const file = new URL(`../../system-assets/gui/${name}`, import.meta.url);
        const logoNonce = randomUUID();
        const contentSecurityPolicy = name.endsWith(".svg")
          ? "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
          : `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${logoNonce}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'`;
        response.writeHead(200, { "content-type": name.endsWith("html") ? "text/html; charset=utf-8" : name.endsWith("js") ? "text/javascript; charset=utf-8" : name.endsWith("svg") ? "image/svg+xml; charset=utf-8" : "text/css; charset=utf-8",
          "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
          "content-security-policy": contentSecurityPolicy });
        const asset = (await readFile(file, "utf8")).replaceAll("__TOKEN__", token);
        response.end(name.endsWith("html") ? await embedLogo(asset, logoNonce) : asset); return;
      }
      if (request.method === "POST" && url.pathname === "/api/pick-folder") {
        await body(request);
        if (picker) return send(409, { error: "文件夹选择框已打开，请先完成选择或取消。" });
        const controller = new AbortController();
        picker = controller;
        const cancel = () => controller.abort();
        response.once("close", cancel);
        try {
          const chosen = await (options.pickFolder ?? pickWindowsFolder)(controller.signal);
          if (chosen === null) return send(200, { cancelled: true });
          if (!path.isAbsolute(chosen)) throw new Error("选择框返回的目录无效，请手动输入路径。");
          const root = await realpath(chosen);
          if (!(await stat(root)).isDirectory()) throw new Error("请选择文件夹。");
          return send(200, { cancelled: false, path: root });
        } finally { response.off("close", cancel); picker = undefined; }
      }
      if (request.method === "GET" && url.pathname === "/api/folders") {
        const root = await realpath(url.searchParams.get("path") || options.directory);
        const folders: { name: string; path: string }[] = [];
        const dir = await opendir(root);
        let truncated = false;
        for await (const item of dir) {
          if (!item.isDirectory() || item.name.startsWith(".")) continue;
          if (folders.length >= 200) { truncated = true; break; }
          folders.push({ name: item.name, path: path.join(root, item.name) });
        }
        folders.sort((a, b) => a.name.localeCompare(b.name));
        return send(200, { path: root, parent: path.dirname(root), folders, truncated });
      }
      if (request.method === "GET" && url.pathname === "/api/recent") {
        return send(200, { projects: (await readLauncherState(stateFile)).recentProjects });
      }
      if (request.method === "POST" && ["/api/inspect", "/api/open"].includes(url.pathname)) {
        const input = await body(request);
        if (typeof input.path !== "string") throw new Error("请选择项目目录。");
        if (url.pathname === "/api/inspect") {
          const project = await inspectLauncherProject(input.path);
          return send(200, { ...project, opened: active?.project === project.path && active.session.snapshot().status !== "stopped" });
        }
        if (opening) return send(409, { error: "正在打开项目，请勿重复提交。" });
        opening = true;
        try {
          const project = await inspectLauncherProject(input.path);
          if (active && active.session.snapshot().status !== "stopped") {
            if (active.project === project.path) return send(200, { url: active.gui.url });
            return send(409, { error: "已有项目打开。请先在工作台结束该运行，再选择其他项目。" });
          }
          if (active) { await active.gui.close(); active = undefined; }
          if (input.kind !== project.kind) return send(409, { error: "项目状态已变化，请重新选择目录。" });
          const iterations = input.iterations;
          if (typeof iterations !== "number" || !Number.isSafeInteger(iterations) || iterations < 1) throw new Error("候选尝试上限必须为正整数。");
          const goal = project.kind === "new" ? input.goal : undefined;
          if (goal !== undefined && typeof goal !== "string") throw new Error("目标必须为文本。");
          const session = await options.createSession(project, goal as string | undefined, iterations);
          if (project.kind === "existing") await session.restorePaused();
          const recentProjects = await recentWith(project.path);
          const gui = await workbench(project, session, recentProjects);
          active = { project: project.path, session, gui };
          // Reserve before starting: subsequent requests cannot start a second runner.
          if (project.kind === "new") void session.dispatch({ type: "session.start" }).catch(error => gui.reportError(error));
          return send(200, { url: gui.url });
        } finally { opening = false; }
      }
      send(404, { error: "Not found" });
    } catch (error) { send(400, { error: error instanceof Error ? error.message : String(error) }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4317, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing launcher address");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/?token=${token}`, close: async () => {
    picker?.abort();
    if (active) { await active.session.dispatch({ type: "session.stop" }); await active.gui.close(); }
    await Promise.all([...retired].map(async gui => await gui.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
