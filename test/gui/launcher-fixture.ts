// Creates isolated launcher acceptance inputs; never runs a model or Policy.
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { InitCapability } from "../../src/capabilities/init/capability.ts";
import { DefaultAgentService } from "../../src/services/agent/service.ts";
import { CodexAgentAdapter } from "../../src/services/agent/codex-adapter.ts";
import { PromptAssetStore } from "../../src/services/prompt/index.ts";
const root = await mkdtemp(path.join(os.tmpdir(), "flywheel-launcher-browser-"));
const fresh = path.join(root, "new-project");
const existing = path.join(root, "existing-project");
await mkdir(fresh); await mkdir(existing);
const capability = new InitCapability({ projectRoot: existing, initialGoal: "隔离启动器验收，不执行优化。",
  agent: new DefaultAgentService(new CodexAgentAdapter(), new PromptAssetStore()) });
const state = await capability.createState();
state.status = "paused";
await capability.store.save(state);
await mkdir(path.join(existing, ".flywheel/runtime"), { recursive: true });
await writeFile(path.join(existing, ".flywheel/runtime/session.json"), JSON.stringify({ schemaVersion: 1, sessionId: randomUUID(), capabilities: ["init"] }));
console.log(JSON.stringify({ root, fresh, existing }));
