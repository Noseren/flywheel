/** User-facing assessment prose. Never include it in optimization or routing inputs. */
export interface TargetUserSummary {
  summary: string;
  unresolved: string[];
}

export function targetSummaryText(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["summary", "unresolved"].includes(key))
    || typeof v.summary !== "string" || !v.summary.trim() || v.summary.length > 1200
    || !Array.isArray(v.unresolved) || v.unresolved.length > 8
    || !v.unresolved.every(item => typeof item === "string" && item.trim() && item.length <= 400)) return undefined;
  return [v.summary, ...(v.unresolved.length ? ["未决事项：", ...v.unresolved.map(item => `• ${item}`)] : [])].join("\n");
}
