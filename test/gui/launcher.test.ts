import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
test("opening a new workbench does not wait for initialization and reports background failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-slow-"));
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((_, reject) => { fail = reject; });
  let starts = 0;
  const launcher = await startGuiLauncher({ directory: root, port: 0, stateFile: await isolatedStateFile(), createSession: async () => ({
    projectRoot: root, chain: ["init"], commandReceipts: async () => [], history: async () => [], activeHistory: async () => [], subscribe: () => () => {},
    snapshot: () => ({status:"idle"}), dispatch: async (command: {type:string}) => { if(command.type==="session.start"){ starts++; await gate; } }
  } as unknown as FlywheelSession) });
  try {
    const origin = new URL(launcher.url);
    const request = () => fetch(new URL("/api/open" + origin.search, origin), { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({path:root,kind:"new",iterations:10}), signal:AbortSignal.timeout(2000) });
    const result = await request();
    assert.equal(result.status,200); assert.equal(starts,1);
    const opened = new URL((await result.json() as {url:string}).url);
    assert.equal((await request()).status,200); assert.equal(starts,1);
    fail(new Error("startup failed"));
    const state = await (await fetch(new URL("/api/state" + opened.search, opened))).json() as {commandError?:string};
    assert.equal(state.commandError,"startup failed");
  } finally { fail(new Error("cleanup")); await launcher.close(); }
});
import { inspectLauncherProject, startGuiLauncher } from "../../src/gui/launcher.ts";
import type { FlywheelSession } from "../../src/session/session.ts";

async function isolatedStateFile(): Promise<string> {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-state-")), "recent-projects.json");
}

test("recent projects survive launcher origins and corrupted state degrades safely", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-persist-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-persist-other-"));
  const stateFile = await isolatedStateFile();
  let status = "idle";
  const first = await startGuiLauncher({ directory: root, port: 0, stateFile, createSession: async project => ({
    projectRoot: project.path, chain: project.chain, commandReceipts: async () => [], history: async () => [], activeHistory: async () => [], subscribe: () => () => {}, snapshot: () => ({ status }),
    dispatch: async (command: { type: string }) => { if (command.type === "session.stop") status = "stopped"; },
  } as unknown as FlywheelSession) });
  const firstUrl = new URL(first.url);
  try {
    const response = await fetch(new URL("/api/open" + firstUrl.search, firstUrl), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, kind: "new", goal: "persist", iterations: 1 }) });
    assert.equal(response.status, 200);
  } finally { await first.close(); }

  let secondStatus = "idle";
  const second = await startGuiLauncher({ directory: root, port: 0, stateFile, createSession: async project => ({
    projectRoot: project.path, chain: project.chain, commandReceipts: async () => [], history: async () => [], activeHistory: async () => [], subscribe: () => () => {}, snapshot: () => ({ status: secondStatus }),
    dispatch: async (command: { type: string }) => { if (command.type === "session.stop") secondStatus = "stopped"; },
  } as unknown as FlywheelSession) });
  const secondUrl = new URL(second.url);
  try {
    const persisted = await (await fetch(new URL("/api/recent" + secondUrl.search, secondUrl))).json() as { projects: string[] };
    assert.deepEqual(persisted.projects, [await realpath(root)]);
    const response = await fetch(new URL("/api/open" + secondUrl.search, secondUrl), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: other, kind: "new", goal: "persist another", iterations: 1 }) });
    assert.equal(response.status, 200);
  } finally { await second.close(); }

  const third = await startGuiLauncher({ directory: root, port: 0, stateFile, createSession: async () => { throw new Error("must not create"); } });
  const thirdUrl = new URL(third.url);
  try {
    const persisted = await (await fetch(new URL("/api/recent" + thirdUrl.search, thirdUrl))).json() as { projects: string[] };
    assert.deepEqual(persisted.projects, [await realpath(other), await realpath(root)]);
    await writeFile(stateFile, "not json", "utf8");
    assert.deepEqual(await (await fetch(new URL("/api/recent" + thirdUrl.search, thirdUrl))).json(), { projects: [] });
  } finally { await third.close(); }
});

test("folder picker requires authentication, prevents duplicates and never starts a task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-picker-"));
  let calls = 0;
  let settle!: (value: string | null) => void;
  const launcher = await startGuiLauncher({ directory: root, port: 0, stateFile: await isolatedStateFile(),
    createSession: async () => { throw new Error("must not create Session"); },
    pickFolder: async () => { calls++; return new Promise(resolve => { settle = resolve; }); },
  });
  const url = new URL(launcher.url);
  const request = (search = url.search, origin?: string) => fetch(new URL("/api/pick-folder" + search, url), {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: "{}",
  });
  try {
    assert.equal((await request("")).status, 403);
    assert.equal((await request(url.search, "https://untrusted.example")).status, 403);
    assert.equal(calls, 0);
    const first = request();
    while (!calls) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await request()).status, 409);
    settle(null);
    assert.deepEqual(await (await first).json(), { cancelled: true });
    const second = request();
    while (calls < 2) await new Promise(resolve => setTimeout(resolve, 5));
    settle(root);
    const selected = await (await second).json() as { cancelled: boolean; path: string };
    assert.equal(selected.cancelled, false);
    assert.equal((await inspectLauncherProject(selected.path)).kind, "new");
    assert.deepEqual(await readdir(root), []);
  } finally { settle?.(null); await launcher.close(); }
});

test("closing launcher cancels the pending folder dialog", async () => {
  let entered = false, aborted = false;
  const launcher = await startGuiLauncher({ directory: os.tmpdir(), port: 0, stateFile: await isolatedStateFile(),
    createSession: async () => { throw new Error("must not run"); },
    pickFolder: signal => new Promise(resolve => {
      entered = true;
      signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true });
    }),
  });
  const url = new URL(launcher.url);
  const pending = fetch(new URL("/api/pick-folder" + url.search, url), {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }).catch(() => undefined);
  while (!entered) await new Promise(resolve => setTimeout(resolve, 5));
  await launcher.close(); await pending;
  assert.equal(aborted, true);
});

test("launcher selection is read-only and rejects ambiguous existing state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-inspect-"));
  assert.equal((await inspectLauncherProject(root)).kind, "new");
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(inspectLauncherProject("relative"), /绝对/);
  await mkdir(path.join(root, ".flywheel"));
  await assert.rejects(inspectLauncherProject(root), /缺少 Session/);
  await mkdir(path.join(root, ".flywheel/runtime"));
  await writeFile(path.join(root, ".flywheel/runtime/session.json"), JSON.stringify({ schemaVersion: 1, sessionId: "saved", capabilities: ["init", "run"] }));
  assert.deepEqual((await inspectLauncherProject(root)).chain, ["init", "run"]);
});

test("launcher authenticates browsing and creates only one explicitly requested Session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-http-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-other-"));
  let creates = 0, starts = 0, restores = 0;
  let status = "idle";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stateFile = await isolatedStateFile();
  const launcher = await startGuiLauncher({ directory: root, port: 0, stateFile,
    createSession: async (project, goal) => {
      creates++; assert.equal(goal, "  原封不动的目标\n"); await gate;
      return { projectRoot: project.path, chain: project.chain, commandReceipts: async () => [], history: async () => [], activeHistory: async () => [],
        subscribe: () => () => {}, snapshot: () => ({ status }), restorePaused: async () => { restores++; },
        dispatch: async (command: { type: string }) => { if (command.type === "session.start") starts++; if (command.type === "session.stop") status = "stopped"; },
      } as unknown as FlywheelSession;
    } });
  const base = new URL(launcher.url);
  const api = (route: string, data?: unknown, origin?: string) => fetch(new URL(route + base.search, base), data ? {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(data),
  } : {});
  try {
    assert.equal((await fetch(new URL("/api/folders", base))).status, 403);
    assert.equal((await api("/api/inspect", { path: root }, "https://untrusted.example")).status, 403);
    const html = await (await fetch(launcher.url)).text();
    assert.match(html, /最近项目/); assert.match(html, /打开其他文件夹/);
    assert.match(html, /id="launcher-slogan"/); assert.doesNotMatch(html, /选择一个项目/);
    assert.match(html, /<svg class="flywheel-mark"/);
    assert.equal(html.match(/id="pick-folder"/g)?.length, 1); assert.doesNotMatch(html, /start-browse|change-project|__TOKEN__/);
    const script = await (await fetch(new URL("/launcher.js" + base.search, base))).text();
    assert.match(script, /const slogans = \[/); assert.match(script, /renderSlogan\(\);/);
    assert.doesNotMatch(script, /recentProjects\[0\]\) select/);
    assert.doesNotMatch(script, /project-glyph/);
    const logoResponse = await fetch(new URL("/flywheel-logo.svg" + base.search, base));
    assert.equal(logoResponse.status, 200); assert.match(logoResponse.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(logoResponse.headers.get("content-security-policy") ?? "", /style-src 'unsafe-inline'/);
    assert.match(logoResponse.headers.get("content-security-policy") ?? "", /script-src 'none'/);
    assert.equal((await api("/api/folders")).status, 200);
    assert.deepEqual(await (await api("/api/recent")).json(), { projects: [] });
    assert.equal((await api("/api/inspect", { path: root })).status, 200);
    assert.equal(creates, 0); assert.deepEqual(await readdir(root), []);
    assert.equal((await api("/api/open", { path: root, kind: "new", iterations: 10, goal: 42 })).status, 400);
    const request = { path: root, kind: "new", iterations: 10, goal: "  原封不动的目标\n" };
    const first = api("/api/open", request);
    while (!creates) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await api("/api/open", request)).status, 409);
    release();
    const opened = await (await first).json() as { url: string };
    assert.ok(opened.url.startsWith("http://127.0.0.1:"));
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")).recentProjects, [await realpath(root)]);
    assert.equal((await (await api("/api/inspect", { path: root })).json() as { opened: boolean }).opened, true);
    assert.equal((await api("/api/open", request)).status, 200);
    assert.equal((await api("/api/open", { ...request, path: other })).status, 409);
    assert.equal(creates, 1); assert.equal(starts, 1); assert.equal(restores, 0);
  } finally { release(); await launcher.close(); }
});

test("existing projects open paused and never consume a replacement goal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-existing-"));
  await mkdir(path.join(root, ".flywheel/runtime"), { recursive: true });
  await writeFile(path.join(root, ".flywheel/runtime/session.json"), JSON.stringify({ schemaVersion: 1, sessionId: "saved", capabilities: ["run"] }));
  let restored = 0, started = 0;
  const launcher = await startGuiLauncher({ directory: root, port: 0, stateFile: await isolatedStateFile(), createSession: async (project, goal) => {
    assert.equal(goal, undefined); assert.deepEqual(project.chain, ["run"]);
    return { projectRoot: root, chain: project.chain, commandReceipts: async () => [], history: async () => [], activeHistory: async () => [], subscribe: () => () => {},
      snapshot: () => ({ status: "idle" }), restorePaused: async () => { restored++; },
      dispatch: async (command: { type: string }) => { if (command.type === "session.start") started++; },
    } as unknown as FlywheelSession;
  } });
  try {
    const url = new URL(launcher.url);
    const result = await fetch(new URL("/api/open" + url.search, url), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: root, kind: "existing", iterations: 10, goal: "不得覆盖的目标" }) });
    assert.equal(result.status, 200); assert.equal(restored, 1); assert.equal(started, 0);
  } finally { await launcher.close(); }
});

test("workbench switches only to a persisted recent project through Session control", async () => {
  const first = await mkdtemp(path.join(os.tmpdir(), "flywheel-switch-first-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "flywheel-switch-second-"));
  for (const root of [first, second]) {
    await mkdir(path.join(root, ".flywheel/runtime"), { recursive: true });
    await writeFile(path.join(root, ".flywheel/runtime/session.json"), JSON.stringify({ schemaVersion: 1, sessionId: path.basename(root), capabilities: ["run"] }));
  }
  const firstReal = await realpath(first), secondReal = await realpath(second);
  const stateFile = await isolatedStateFile();
  await writeFile(stateFile, JSON.stringify({ schemaVersion: 1, recentProjects: [firstReal, secondReal] }));
  const records: { project: string; status: string; restores: number; stops: number }[] = [];
  const launcher = await startGuiLauncher({ directory: first, port: 0, stateFile, createSession: async project => {
    const record = { project: project.path, status: "idle", restores: 0, stops: 0 }; records.push(record);
    return { projectRoot: project.path, chain: project.chain, commandReceipts: async () => [], history: async () => [], activeHistory: async () => [], subscribe: () => () => {},
      snapshot: () => ({ status: record.status }), restorePaused: async () => { record.restores++; record.status = "paused"; },
      dispatch: async (command: { type: string }) => { if (command.type === "session.stop") { record.stops++; record.status = "stopped"; } },
    } as unknown as FlywheelSession;
  } });
  try {
    const launcherUrl = new URL(launcher.url);
    const opened = await fetch(new URL("/api/open" + launcherUrl.search, launcherUrl), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: first, kind: "existing", iterations: 10 }) }).then(response => response.json()) as { url: string };
    const firstGui = new URL(opened.url);
    const state = await fetch(new URL("/api/state" + firstGui.search, firstGui)).then(response => response.json()) as { projectNavigation: { recentProjects: string[] } };
    assert.deepEqual(state.projectNavigation.recentProjects, [firstReal, secondReal]);

    const switchedResponse = await fetch(new URL("/api/switch-project" + firstGui.search, firstGui), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: secondReal }) });
    assert.equal(switchedResponse.status, 200);
    const switched = await switchedResponse.json() as { url: string };
    const secondGui = new URL(switched.url);
    const secondState = await fetch(new URL("/api/state" + secondGui.search, secondGui)).then(response => response.json()) as { projectRoot: string };
    assert.equal(secondState.projectRoot, secondReal);
    assert.equal(records.length, 2); assert.equal(records[0]?.stops, 1); assert.equal(records[1]?.restores, 1);

    const rejected = await fetch(new URL("/api/switch-project" + secondGui.search, secondGui), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: os.tmpdir() }) });
    assert.equal(rejected.status, 403);
  } finally { await launcher.close(); }
});
