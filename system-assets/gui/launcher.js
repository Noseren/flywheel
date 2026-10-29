const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token");
const slogans = [
  "让每一次迭代，都留下可以复核的证据。",
  "目标保持清晰，系统持续向前。",
  "把复杂工作交给 Agent，把最终决定留给你。",
  "不是反复生成，是持续收敛。",
  "从原始目标到正式版本，每一步都看得见。",
  "让改进有方向，让结果有依据。",
];
let directory, selected, busy = false, sequence = 0, recentProjects = [];
function renderSlogan() { $("launcher-slogan").textContent = slogans[Math.floor(Math.random() * slogans.length)]; }
function theme(value) { document.documentElement.dataset.theme = value; $("theme").value = value; }
let currentTheme = "system";
try { currentTheme = localStorage.getItem("flywheel-theme") || "system"; } catch {}
theme(currentTheme);
$("theme").onchange = () => { theme($("theme").value); try { localStorage.setItem("flywheel-theme", $("theme").value); } catch {} };
async function api(route, data) {
  const response = await fetch(`${route}${route.includes("?") ? "&" : "?"}token=${encodeURIComponent(token || "")}`, data ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
  } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败：${response.status}`);
  return result;
}
function error(reason) { $("error").textContent = reason.message || String(reason); $("status").textContent = ""; }
function button(text, callback) { const element = document.createElement("button"); element.type = "button"; element.textContent = text; element.onclick = callback; return element; }
function renderRecent() {
  const items = recentProjects.map(p => {
    const name = p.split(/[\\/]/).filter(Boolean).at(-1) || p;
    const b = button("", () => select(p)); b.className = "recent-project";
    const copy = document.createElement("span"); copy.className = "project-copy";
    const title = document.createElement("strong"); title.textContent = name;
    const path = document.createElement("small"); path.textContent = p; copy.append(title, path);
    const chevron = document.createElement("span"); chevron.className = "project-chevron"; chevron.textContent = "›"; chevron.setAttribute("aria-hidden", "true");
    b.append(copy, chevron); b.title = p; b.setAttribute("aria-current", String(selected?.path === p)); return b;
  });
  $("recent").replaceChildren(...items);
  if (!recentProjects.length) { const empty = document.createElement("p"); empty.className = "recent-empty"; empty.textContent = "还没有最近项目。请打开一个本机文件夹。"; $("recent").append(empty); }
}
async function recent() {
  const result = await api("/api/recent"); recentProjects = Array.isArray(result.projects) ? result.projects : []; renderRecent();
}
async function browse(p) {
  if (busy) return;
  const revision = ++sequence;
  selected = undefined; $("project").hidden = true;
  $("error").textContent = ""; $("status").textContent = "正在读取目录…"; $("choose").disabled = true;
  try {
    const result = await api(`/api/folders${p ? `?path=${encodeURIComponent(p)}` : ""}`);
    if (revision !== sequence) return;
    directory = result; selected = undefined; $("project").hidden = true;
    $("path").value = result.path; $("location").textContent = result.path;
    $("folders").replaceChildren(...result.folders.map(item => button(item.name, () => browse(item.path))));
    $("parent").disabled = result.parent === result.path; $("choose").disabled = false;
    $("limit").textContent = result.truncated ? "仅显示前 200 个子目录；其他目录可直接输入完整路径。" : result.folders.length ? "" : "没有可显示的子目录，可以直接选择当前目录。";
    $("status").textContent = "目录已读取。浏览目录不会启动或恢复任务。";
  } catch (reason) { if (revision === sequence) error(reason); }
}
async function select(p) {
  if (busy) return;
  const revision = ++sequence;
  $("error").textContent = ""; selected = undefined; $("project").hidden = true; $("welcome").hidden = false;
  try {
    const result = await api("/api/inspect", { path: p });
    if (revision !== sequence) return;
    selected = result; $("project").hidden = false; $("welcome").hidden = true;
    $("project-name").textContent = result.path.split(/[\\/]/).filter(Boolean).at(-1) || result.path;
    $("directory-browser").open = false; renderRecent();
    $("project-path").textContent = result.path; $("project-title").textContent = result.kind === "new" ? "新项目" : "已有运行记录";
    $("goal-field").hidden = result.kind !== "new"; $("goal").required = false;
    $("project-note").textContent = result.kind === "new" ? "开始后调用模型，消耗账号额度。" : "先查看历史，再决定是否继续。打开不会自动恢复运行。";
    $("open").textContent = "打开工作台";
    if (result.opened) {
      $("open").textContent = "回到当前工作台";
      $("project-note").textContent = "此项目已在当前启动器打开。保留它的当前状态，不重复启动或暂停。";
    }
    $("status").textContent = "目录已选择。此操作不会启动或恢复任务。";
    $("project-title").scrollIntoView({ block: "nearest" });
  } catch (reason) { if (revision === sequence) error(reason); }
}
$("browse-form").onsubmit = event => { event.preventDefault(); browse($("path").value.trim()); };
$("pick-folder").onclick = async () => {
  if (busy) return;
  busy = true; ++sequence;
  const controls = [...document.querySelectorAll("button, input, textarea")];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  $("error").textContent = "";
  $("status").textContent = "请在 Windows 文件夹选择框中确认或取消（若未看到，请检查任务栏）。";
  let result;
  try { result = await api("/api/pick-folder", {}); }
  catch (reason) { error(reason); }
  finally { controls.forEach((control, index) => { control.disabled = disabled[index]; }); busy = false; }
  if (result?.cancelled) { $("status").textContent = "已取消，项目选择保持不变。"; return; }
  if (result?.path) { await browse(result.path); await select(result.path); }
};
$("parent").onclick = () => directory && browse(directory.parent);
$("choose").onclick = () => directory && select(directory.path);
$("open-form").onsubmit = async event => {
  event.preventDefault(); if (busy || !selected) return;
  busy = true; $("open").disabled = true; $("error").textContent = ""; $("status").textContent = "正在打开工作台，请勿重复提交…";
  try {
    const goal = $("goal").value;
    const result = await api("/api/open", { path: selected.path, kind: selected.kind, ...(goal.trim() ? { goal } : {}), iterations: Number($("iterations").value) });
    location.assign(result.url);
  } catch (reason) { error(reason); }
  finally { busy = false; $("open").disabled = false; }
};
$("directory-browser").addEventListener("toggle", () => { if ($("directory-browser").open && !directory) browse(); });
renderSlogan();
recent().catch(error);
