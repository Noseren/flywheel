#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

import { ClaudeAgentAdapter } from "./services/agent/claude-adapter.ts";
import { CodexAgentAdapter, type CodexReasoningEffort } from "./services/agent/codex-adapter.ts";
import { loadProject } from "./capabilities/run/project.ts";
import type { RunCommand, RunState } from "./capabilities/run/protocol.ts";
import type { AgentAdapter } from "./services/agent/protocol.ts";
import { DefaultAgentService } from "./services/agent/service.ts";
import { inspectInit } from "./capabilities/init/inspector.ts";
import { InitCapability } from "./capabilities/init/capability.ts";
import type {
  InitCommand,
  InitOperationResult,
  InitServices,
  InitState,
} from "./capabilities/init/protocol.ts";
import { RunBlocked, RunCapability } from "./capabilities/run/capability.ts";
import type { RunOperationResult, RunPolicyServices } from "./capabilities/run/policy.ts";
import { trustedModuleExecutionPolicySource } from "./session/policy.ts";
import { runCapability } from "./session/runner.ts";
import { FlywheelSession } from "./session/session.ts";
import { CapabilityRegistry } from "./session/session.ts";
import { runSessionTerminal } from "./tui/session-terminal.ts";
import { runSessionGui, startSessionGuiServer } from "./gui/server.ts";
import { startGuiLauncher } from "./gui/launcher.ts";
import { launchDesktop } from "./gui/desktop.ts";
import { PromptAssetStore } from "./services/prompt/index.ts";
import { defaultProcessService } from "./services/process/index.ts";
import type { ExecutionBudgetLimits } from "./session/execution-budget.ts";

interface CliOptions {
  help?: boolean;
  mode: "main" | "dev";
  project: string;
  goalFile?: string;
  pluginRoot?: string;
  promptRoot?: string;
  codexPath?: string;
  initPolicy?: string;
  runPolicy?: string;
  agent: "codex" | "claude";
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
  concurrency: number;
  command: "run" | "status" | "check-init" | "init" | "prompts" | "steering" | "policy" | "dev-help" | "gui";
  promptAction?: "list" | "show" | "validate" | "override";
  promptId?: string;
  maxIterations?: number;
  maxAttempts?: number;
  maxActiveMs?: number;
  maxTokens?: number;
  legacyWorkflow?: boolean;
  initOnly: boolean;
  steeringAction?: "propose" | "approve" | "reject";
  policyAction?: "activate";
  candidateId?: string;
  gui: boolean;
  guiPaused?: boolean;
  observeGui: boolean;
  guiPort: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: "main", project: process.cwd(), agent: "codex", concurrency: 8, command: "run", initOnly: false,
    gui: false, observeGui: false, guiPort: 4317,
  };
  let commandExplicit = false;
  const args = [...argv];
  while (args.length) {
    const item = args.shift()!;
    if (item === "--help" || item === "-h" || (item === "help" && options.mode === "main")) options.help = true;
    else if (item === "dev") {
      if (options.mode === "dev" || commandExplicit) throw new Error("dev must appear before the command");
      options.mode = "dev";
      options.command = "dev-help";
    }
    else if (item === "--project") options.project = args.shift()!;
    else if (item === "--goal-file") options.goalFile = args.shift()!;
    else if (item === "--max-iterations") options.maxIterations = Number(args.shift());
    else if (item === "--max-attempts") options.maxAttempts = Number(args.shift());
    else if (item === "--max-active-ms") options.maxActiveMs = Number(args.shift());
    else if (item === "--max-tokens") options.maxTokens = Number(args.shift());
    else if (item === "--legacy-workflow") options.legacyWorkflow = true;
    else if (item === "--init-only") options.initOnly = true;
    else if (item === "--gui") options.gui = true;
    else if (item === "--gui-paused") { options.gui = true; options.guiPaused = true; }
    else if (item === "--observe-gui") options.observeGui = true;
    else if (item === "--gui-port") options.guiPort = Number(args.shift());
    else if (options.mode !== "dev" && [
      "--plugin-root", "--prompt-root", "--codex-path", "--init-policy", "--run-policy",
      "--agent", "--model", "--reasoning-effort", "--concurrency",
    ].includes(item)) throw new Error(`${item} is only available under \`flywheel dev\``);
    else if (item === "--plugin-root" && options.mode === "dev") options.pluginRoot = args.shift()!;
    else if (item === "--prompt-root" && options.mode === "dev") options.promptRoot = args.shift()!;
    else if (item === "--codex-path" && options.mode === "dev") options.codexPath = args.shift()!;
    else if (item === "--init-policy" && options.mode === "dev") options.initPolicy = args.shift()!;
    else if (item === "--run-policy" && options.mode === "dev") options.runPolicy = args.shift()!;
    else if (item === "--agent") {
      if (options.mode !== "dev") throw new Error("--agent is only available under `flywheel dev`");
      const agent = args.shift();
      if (agent !== "codex" && agent !== "claude") throw new Error(`Unsupported agent: ${String(agent)}`);
      options.agent = agent;
    }
    else if (item === "--model" && options.mode === "dev") options.model = args.shift()!;
    else if (item === "--reasoning-effort") {
      if (options.mode !== "dev") throw new Error("--reasoning-effort is only available under `flywheel dev`");
      const effort = args.shift();
      if (!effort || !["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
        throw new Error(`Unsupported reasoning effort: ${String(effort)}`);
      }
      options.reasoningEffort = effort as CodexReasoningEffort;
    }
    else if (item === "--concurrency" && options.mode === "dev") options.concurrency = Number(args.shift());
    else if (["run", "init", "gui"].includes(item)) {
      options.command = item as CliOptions["command"];
      commandExplicit = true;
    }
    else if (options.mode === "dev" && item === "help") {
      options.command = "dev-help";
      commandExplicit = true;
    }
    else if (options.mode === "dev" && ["status", "check-init", "prompts", "steering", "policy"].includes(item)) {
      options.command = item as CliOptions["command"];
      commandExplicit = true;
    }
    else if (options.command === "prompts" && ["list", "show", "validate", "override"].includes(item)) {
      options.promptAction = item as CliOptions["promptAction"];
    }
    else if (options.command === "prompts" && options.promptAction && !options.promptId) options.promptId = item;
    else if (options.command === "steering" && ["propose", "approve", "reject"].includes(item)) {
      options.steeringAction = item as CliOptions["steeringAction"];
    }
    else if (options.command === "steering" && options.steeringAction && !options.candidateId) options.candidateId = item;
    else if (options.command === "policy" && item === "activate") options.policyAction = "activate";
    else if (options.command === "policy" && options.policyAction && !options.candidateId) options.candidateId = item;
    else throw new Error(`Unknown argument: ${item}`);
  }
  if (options.maxIterations !== undefined
    && (!Number.isSafeInteger(options.maxIterations) || options.maxIterations < 1)) {
    throw new Error("--max-iterations must be a positive integer within the safe integer range");
  }
  for (const [flag, value] of [["--max-attempts", options.maxAttempts], ["--max-active-ms", options.maxActiveMs], ["--max-tokens", options.maxTokens]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${flag} must be a positive safe integer`);
  }
  if (options.maxAttempts !== undefined && options.maxIterations !== undefined) throw new Error("Use only one of --max-attempts and --max-iterations");
  if (options.legacyWorkflow && (options.maxAttempts !== undefined || options.maxActiveMs !== undefined || options.maxTokens !== undefined)) {
    throw new Error("--max-attempts, --max-active-ms and --max-tokens require the compact workflow; --legacy-workflow supports --max-iterations only");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  if (!Number.isInteger(options.guiPort) || options.guiPort < 0 || options.guiPort > 65_535) {
    throw new Error("--gui-port must be an integer between 0 and 65535");
  }
  if (options.gui && options.command !== "init" && options.command !== "run") {
    throw new Error("--gui is available only for init and run");
  }
  if (options.observeGui && options.command !== "init" && options.command !== "run") {
    throw new Error("--observe-gui is available only for init and run");
  }
  if (options.gui && options.observeGui) throw new Error("--gui and --observe-gui cannot be used together");
  if (options.initOnly && options.command !== "init") throw new Error("--init-only requires the init command");
  if (options.command === "gui" && (options.goalFile !== undefined || options.maxIterations !== undefined || options.maxAttempts !== undefined)) {
    throw new Error("With flywheel gui, enter the goal and iteration limit in the project page");
  }
  return options;
}

/** Never silently enter the expensive historical workflow when opening old state. */
async function requireWorkflowChoice(projectRoot: string, legacy: boolean | undefined): Promise<void> {
  if (legacy) return;
  for (const relative of [".flywheel/runtime/init-state.json", ".flywheel/runtime/state.json",
    ".flywheel/contract/manifest.json", ".flywheel/init/manifest.json"]) {
    let saved: { workflow?: string };
    try { saved = JSON.parse(await readFile(path.join(projectRoot, relative), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (saved.workflow !== "compact") throw new Error(
      "已有项目使用旧流程。恢复旧会话请显式添加 --legacy-workflow；体验精简流程请使用新的隔离项目副本，保留旧目标、评价和历史。",
    );
  }
}

function budgetLimits(options: CliOptions, attempts?: number): Partial<ExecutionBudgetLimits> {
  const count = attempts ?? options.maxAttempts ?? options.maxIterations;
  return {
    ...(count === undefined ? {} : { candidateAttempts: count }),
    ...(options.maxActiveMs === undefined ? {} : { activeMs: options.maxActiveMs }),
    ...(options.maxTokens === undefined ? {} : { knownTokens: options.maxTokens }),
  };
}

async function runInteractiveSession(session: FlywheelSession, options: CliOptions) {
  if (options.gui) {
    const desktop = process.env.FLYWHEEL_DESKTOP_BACKEND === "1";
    const close = () => { void session.dispatch({ type: "session.stop" }); };
    if (desktop) { process.stdin.resume(); process.stdin.once("end", close); }
    try { return await runSessionGui(session, { port: options.guiPort, startPaused: options.guiPaused }); }
    finally { if (desktop) { process.stdin.off("end", close); process.stdin.pause(); } }
  }
  if (!options.observeGui) return await runSessionTerminal(session);
  const observer = await startSessionGuiServer(session, {
    port: options.guiPort,
    readOnly: true,
    onListening: () => undefined,
  });
  try {
    return await runSessionTerminal(session, { observerUrl: observer.url });
  } finally {
    await observer.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help && options.mode === "main") {
    console.log([
      "Flywheel Runtime — local development preview",
      "Usage: flywheel [--project <directory>] <command> [options]",
      "",
      "Commands:",
      "  init                 Initialize a project, then run optimization",
      "  run                  Run or resume an initialized project (default)",
      "  gui                  Open the experimental Tauri project launcher",
      "  dev                  Show developer and diagnostic commands",
      "",
      "Options:",
      "  --project <directory>    Project root (default: current directory)",
      "  --goal-file <file>       Read the initial goal from a UTF-8 file",
      "  --init-only              Initialize without starting Run (init only)",
      "  --max-attempts <n>       Candidate attempts, including rejects (default 3)",
      "  --max-active-ms <n>      Shared active execution budget (default 900000)",
      "  --max-tokens <n>         Known input + output token budget (default 500000)",
      "  --max-iterations <n>     Compact alias for attempts; legacy version limit",
      "  --legacy-workflow        Explicitly create/resume the historical workflow",
      "  --gui                    Use the Tauri workbench (init/run)",
      "  --gui-paused             Restore existing state without executing (init/run)",
      "  --observe-gui            Read-only browser observer alongside TUI (init/run)",
      "  --gui-port <port>        Local port, default 4317; 0 selects a free port",
      "  -h, --help               Show help without opening or changing a project",
      "",
      "Example: flywheel --project ./my-project init --goal-file ./my-project/goal.md",
      "Real model calls use your configured account and may incur charges.",
      "Budgets persist across preparation, optimization and resume; missing usage stays unknown.",
      "Token limits are checked when providers report usage; in-flight calls may overshoot.",
      "Tauri requires a separate desktop build. See README.md for setup.",
    ].join("\n"));
    return;
  }
  if (options.help) options.command = "dev-help";
  if (!options.help && (options.command === "gui" || options.gui) && process.env.FLYWHEEL_DESKTOP_BACKEND !== "1") {
    await launchDesktop(process.argv.slice(2));
    return;
  }
  if (options.command === "dev-help") {
    console.log([
      "Flywheel developer commands:",
      "  flywheel gui  (open the Tauri desktop app and choose a project)",
      "  flywheel dev check-init",
      "  flywheel dev status",
      "  flywheel dev prompts <list|show|validate|override> [prompt-id]",
      "  flywheel dev steering <propose|approve|reject> [candidate-id]",
      "  flywheel dev policy activate <candidate-id>",
      "  flywheel dev init|run [--agent ... --model ... --reasoning-effort ...]",
      "  flywheel init|run --gui [--gui-port 4317]",
      "  flywheel init|run --gui-paused [--gui-port 4317]  (restore without executing)",
      "  flywheel init|run --observe-gui [--gui-port 4317]",
    ].join("\n"));
    return;
  }
  if (options.command === "check-init") {
    const inspection = await inspectInit(options.project, defaultProcessService);
    console.log(JSON.stringify(inspection, null, 2));
    process.exitCode = inspection.status === "ready" ? 0 : 2;
    return;
  }
  if (options.command === "prompts") {
    const prompts = new PromptAssetStore({ projectRoot: options.project, configuredRoot: options.promptRoot });
    const action = options.promptAction ?? "list";
    if (action === "list") {
      console.log(JSON.stringify((await prompts.list()).map(({ template, ...asset }) => asset), null, 2));
    } else if (action === "validate") {
      await prompts.validateAll();
      console.log(JSON.stringify({ valid: true, count: (await prompts.list()).length }, null, 2));
    } else {
      if (!options.promptId) throw new Error(`prompts ${action} requires a prompt asset id`);
      if (action === "show") console.log(JSON.stringify(await prompts.inspect(options.promptId), null, 2));
      else console.log(JSON.stringify({ path: await prompts.materializeOverride(options.promptId) }, null, 2));
    }
    return;
  }
  const agent: AgentAdapter = options.agent === "codex"
    ? new CodexAgentAdapter({
      model: options.model,
      modelReasoningEffort: options.reasoningEffort,
      codexPath: options.codexPath,
    })
    : new ClaudeAgentAdapter({ model: options.model });
  const agentService = (projectRoot: string) => new DefaultAgentService(
    agent,
    new PromptAssetStore({ projectRoot, configuredRoot: options.promptRoot }),
  );
  const initPolicySource = options.initPolicy
    ? trustedModuleExecutionPolicySource<InitServices, InitState, InitCommand, InitOperationResult>(options.initPolicy)
    : undefined;
  const runPolicySource = options.runPolicy
    ? trustedModuleExecutionPolicySource<RunPolicyServices, RunState, RunCommand, RunOperationResult>(options.runPolicy)
    : undefined;
  if (options.command === "gui") {
    const launcher = await startGuiLauncher({ directory: options.project, port: options.guiPort,
      createSession: async (selected, goal, iterations) => {
        await requireWorkflowChoice(selected.path, options.legacyWorkflow);
        const registry = new CapabilityRegistry();
        registry.register("init", () => new InitCapability({ projectRoot: selected.path, initialGoal: goal, confirmationMode: "brief",
          workflow: options.legacyWorkflow ? "legacy" : "compact", budgetLimits: budgetLimits(options, iterations),
          agent: agentService(selected.path), pluginRoot: options.pluginRoot, promptRoot: options.promptRoot, policySource: initPolicySource }));
        registry.register("run", async () => {
          const project = await loadProject(selected.path, options.pluginRoot);
          return new RunCapability(project, agentService(selected.path), { concurrency: options.concurrency,
            budgetLimits: budgetLimits(options, iterations),
            maxIterations: iterations, promptRoot: options.promptRoot, policySource: runPolicySource, allowDynamicPolicy: options.mode === "dev" });
        });
        return new FlywheelSession(selected.path, registry, selected.chain);
      },
    });
    console.log(`Flywheel GUI: ${launcher.url}`);
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      process.stdin.pause();
      void launcher.close().catch(error => { console.error(error); process.exitCode = 1; });
    };
    process.once("SIGINT", close); process.once("SIGTERM", close);
    process.stdin.resume();
    process.stdin.once("end", close);
    const desktopParentPid = Number(process.env.FLYWHEEL_DESKTOP_PARENT_PID);
    if (Number.isSafeInteger(desktopParentPid) && desktopParentPid > 0) {
      const parentMonitor = setInterval(() => {
        try { process.kill(desktopParentPid, 0); }
        catch { clearInterval(parentMonitor); close(); }
      }, 1_000);
      parentMonitor.unref();
    }
    return;
  }
  if (options.command === "init") {
    await requireWorkflowChoice(options.project, options.legacyWorkflow);
    const initialGoal = options.goalFile === undefined
      ? undefined
      : await readFile(options.goalFile, "utf8");
    if (options.goalFile !== undefined && !initialGoal?.trim()) {
      throw new Error("--goal-file must contain a non-empty user goal");
    }
    const init = new InitCapability({
      projectRoot: options.project,
      initialGoal,
      confirmationMode: "brief",
      workflow: options.legacyWorkflow ? "legacy" : "compact",
      budgetLimits: budgetLimits(options),
      pluginRoot: options.pluginRoot,
      promptRoot: options.promptRoot,
      agent: agentService(options.project),
      policySource: initPolicySource,
    });
    const registry = new CapabilityRegistry().register("init", () => init);
    if (!options.initOnly) registry.register("run", async () => {
      const project = await loadProject(options.project, options.pluginRoot);
      return new RunCapability(project, agentService(project.root), {
        budgetLimits: budgetLimits(options),
        concurrency: options.concurrency,
        maxIterations: options.maxIterations,
        policySource: runPolicySource,
        promptRoot: options.promptRoot,
        allowDynamicPolicy: options.mode === "dev",
      });
    });
    const session = new FlywheelSession(options.project, registry, options.initOnly ? ["init"] : ["init", "run"]);
    const state = await runInteractiveSession(session, options);
    if (state.activeCapabilityStatus === "blocked") process.exitCode = 2;
    return;
  }
  const inspection = await inspectInit(options.project, defaultProcessService);
  if (inspection.status !== "ready") {
    console.error(JSON.stringify({
      error: "Flywheel initialization is not complete",
      status: inspection.status,
      problems: inspection.problems,
      next: `Run flywheel --project ${options.project} init`,
    }, null, 2));
    process.exitCode = 2;
    return;
  }
  const project = await loadProject(options.project, options.pluginRoot);
  if (options.command !== "status") await requireWorkflowChoice(project.root, options.legacyWorkflow);
  const run = new RunCapability(project, agentService(project.root), {
    budgetLimits: budgetLimits(options),
    concurrency: options.concurrency,
    maxIterations: options.maxIterations,
    policySource: runPolicySource,
    promptRoot: options.promptRoot,
    allowDynamicPolicy: options.mode === "dev",
  });
  try {
    const runCommand = async (command: RunCommand): Promise<RunState> => await runCapability(
      run,
      { type: "command", command },
      new AbortController().signal,
    );
    if (options.command === "steering") {
      const action = options.steeringAction ?? "propose";
      if (action === "propose") {
        const state = await runCommand({ type: "steering.propose" });
        console.log(JSON.stringify({
          ...state.commandResult,
          next: state.commandResult?.candidateId
            ? `Review the proposal, then run flywheel dev steering approve ${state.commandResult.candidateId} or flywheel dev steering reject ${state.commandResult.candidateId}`
            : undefined,
        }, null, 2));
      } else {
        if (!options.candidateId) throw new Error(`steering ${action} requires a candidate id`);
        const state = await runCommand({
          type: "steering.resolve", candidateId: options.candidateId, decision: action,
        });
        console.log(JSON.stringify({
          ...state.commandResult,
          ...(action === "approve" ? { effective: "next_search_window" } : {}),
        }, null, 2));
      }
      return;
    }
    if (options.command === "policy") {
      if (options.policyAction !== "activate" || !options.candidateId) {
        throw new Error("policy requires: activate <candidate-id>");
      }
      const state = await runCommand({ type: "policy.activate", candidateId: options.candidateId });
      console.log(JSON.stringify({
        ...state.commandResult,
        effective: "next_search_window_or_current_safe_boundary",
      }, null, 2));
      return;
    }
    if (options.command === "run") {
      const registry = new CapabilityRegistry().register("run", () => run);
      const session = new FlywheelSession(options.project, registry, ["run"]);
      const state = await runInteractiveSession(session, options);
      if (state.activeCapabilityStatus === "blocked") process.exitCode = 2;
      return;
    }
    const state = await run.store.load();
    console.log(JSON.stringify(state, null, 2));
  } catch (error) {
    if (error instanceof RunBlocked) {
      if (options.command === "run") {
        process.exitCode = 2;
        return;
      }
      console.error(JSON.stringify({ error: error.message, state: await run.store.load() }, null, 2));
      process.exitCode = 2;
      return;
    }
    throw error;
  }
}

await main();
