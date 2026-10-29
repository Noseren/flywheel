import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import type { GuiTimelineEntry } from "./server.ts";

export interface GuiEvidence {
  id: string;
  entryId: string;
  title: string;
  version?: string;
  timestamp: string;
  file?: string;
}

/** A read-only projection of trusted lifecycle outcomes, never Agent prose. */
export function officialEvidence(entries: readonly GuiTimelineEntry[]): GuiEvidence[] {
  const evidence: GuiEvidence[] = [];
  for (const entry of entries) {
    if (entry.category !== "runtime") continue;
    const event = entry.raw as { type?: string; version?: string; data?: Record<string, unknown> };
    const data = event?.data;
    if (!data) continue;
    const base = { id: entry.id, entryId: entry.id, timestamp: entry.timestamp };
    if (entry.capabilityId === "init" && ["init.baseline.created", "baseline.created"].includes(String(event.type)) && data.version === "v1") {
      evidence.push({ ...base, title: "初始化基线已建立", version: "v1" });
      continue;
    }
    if (entry.capabilityId === "run" && event.type === "operation.activity" && typeof data.retained === "boolean") {
      evidence.push({ ...base,
        title: data.retained
          ? `候选已保留为正式版本${data.target === "achieved" ? "，目标已达成" : data.target === "inconclusive" ? "（目标未判定）" : ""}`
          : "候选未保留，继续使用当前版本",
        ...(typeof event.version === "string" ? { version: event.version } : {}),
      });
      continue;
    }
    if (entry.capabilityId !== "run" || event.type !== "operation.completed"
      || !["completed", "paused"].includes(String(data.status))) continue;
    const result = data.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== "object") continue;
    const version = typeof event.version === "string" ? event.version : undefined;
    if (data.operationId === "assess_target") {
      const title = new Map([["achieved", "目标已达成"], ["not_achieved", "目标尚未达成"], ["inconclusive", "现有证据不足以判定"]]).get(String(result.assessment));
      if (title && typeof result.reportPath === "string") evidence.push({ ...base, title, version, file: result.reportPath });
    } else if (data.operationId === "evaluate" && typeof result.evaluationReportPath === "string") {
      evidence.push({ ...base, title: "正式版本评价已完成（不代表目标达成）", version, file: result.evaluationReportPath });
    } else if (data.operationId === "select" && result.action === "promote" && typeof result.promotedVersion === "string") {
      evidence.push({ ...base, title: "候选已晋升为正式版本", version: result.promotedVersion });
    }
  }
  return evidence;
}

/** Evidence can only reference regular files inside this project's .flywheel directory. */
export async function resolveEvidenceFile(projectRoot: string, file: string): Promise<string> {
  const project = await realpath(projectRoot);
  const boundary = path.join(project, ".flywheel");
  const resolved = await realpath(path.resolve(projectRoot, file));
  const relative = path.relative(boundary, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Evidence path is outside the project runtime assets");
  }
  if (!(await stat(resolved)).isFile()) throw new Error("Evidence is not a regular file");
  return resolved;
}
