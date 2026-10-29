import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { promptAsset, type PromptRequest } from "../../services/prompt/index.ts";

/** Minimal code-consumed reference to an Agent-owned natural-language plan. */
export interface InitProposal {
  artifactPath: string;
  documentPath: string;
  /** Agent-authored display copy, not a substitute for the frozen full proposal. */
  userFacingSummary?: string;
}

const DEFAULT_INIT_GOAL = "用户尚未提供独立的初始目标；不得替用户发明需求。";

/** Runtime-owned source of truth for the user's original request. */
export function initGoalPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".flywheel", "goal.md");
}

export async function ensureInitGoal(projectRoot: string, goal?: string, exact = false): Promise<string> {
  const expected = exact ? goal : goal?.trim() || DEFAULT_INIT_GOAL;
  if (expected === undefined || !expected.trim()) throw new Error("An explicit original goal is required");
  const file = initGoalPath(projectRoot);
  try {
    const original = await readFile(file, "utf8");
    const current = exact ? original : original.trim();
    if (current !== expected) throw new Error("Frozen initialization goal changed");
    return current;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, exact ? expected : `${expected}\n`, { encoding: "utf8", flag: "wx" });
    return expected;
  }
}

export async function readInitGoal(projectRoot: string): Promise<string> {
  const goal = (await readFile(initGoalPath(projectRoot), "utf8")).trim();
  if (!goal) throw new Error("Frozen initialization goal is empty");
  return goal;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function proposalPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".flywheel", "init", "proposal.json");
}

export function proposalDocumentPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".flywheel", "init", "proposal.md");
}

export async function loadProposal(projectRootInput: string): Promise<InitProposal> {
  const projectRoot = path.resolve(projectRootInput);
  const value = JSON.parse(await readFile(proposalPath(projectRoot), "utf8")) as unknown;
  if (!record(value) || typeof value.artifactPath !== "string" || !value.artifactPath.trim()
    || typeof value.documentPath !== "string" || !value.documentPath.trim()) {
    throw new Error("Initialization proposal must reference an artifact and a natural-language document");
  }
  const artifact = path.resolve(projectRoot, value.artifactPath);
  const document = path.resolve(projectRoot, value.documentPath);
  const flywheelDir = path.join(projectRoot, ".flywheel");
  if (path.isAbsolute(value.artifactPath) || !inside(artifact, projectRoot) || inside(artifact, flywheelDir)) {
    throw new Error("Initialization proposal artifact must stay inside the project and outside .flywheel");
  }
  if (!inside(document, path.join(flywheelDir, "init"))) {
    throw new Error("Initialization proposal document must stay inside .flywheel/init");
  }
  await access(artifact);
  if (!(await readFile(document, "utf8")).trim()) throw new Error("Initialization proposal document is empty");
  if (value.userFacingSummary !== undefined && (typeof value.userFacingSummary !== "string"
    || !value.userFacingSummary.trim() || value.userFacingSummary.length > 1200)) {
    throw new Error("Proposal userFacingSummary must contain 1–1200 characters");
  }
  return { artifactPath: value.artifactPath, documentPath: value.documentPath,
    ...(typeof value.userFacingSummary === "string" ? { userFacingSummary: value.userFacingSummary } : {}) };
}

export function proposalSchemaPrompt(projectRoot: string): PromptRequest {
  return promptAsset("init.proposal.schema", {
    destination: proposalPath(projectRoot),
    document_path: proposalDocumentPath(projectRoot),
  });
}

export async function proposalSummary(proposal: InitProposal, projectRoot: string): Promise<string> {
  return await readFile(path.resolve(projectRoot, proposal.documentPath), "utf8");
}

export function revisionPrompt(
  proposal: InitProposal,
  projectRoot: string,
  feedback: string,
): PromptRequest {
  return promptAsset("init.proposal.revision", {
    goal_path: initGoalPath(projectRoot),
    proposal_path: path.resolve(projectRoot, proposal.documentPath),
    proposal_ref_path: proposalPath(projectRoot),
    feedback,
    schema_prompt: proposalSchemaPrompt(projectRoot),
  });
}
