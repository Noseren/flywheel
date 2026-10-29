import path from "node:path";

import type { ChangeScope } from "./protocol.ts";

type ScopedBoundary = { change_scope: ChangeScope };

function normalize(value: string): string {
  return value.replaceAll(path.sep, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function safePattern(value: string): string {
  const normalized = normalize(value);
  if (!normalized || path.isAbsolute(value) || normalized.split("/").includes("..")) {
    throw new Error(`Invalid change scope pattern: ${JSON.stringify(value)}`);
  }
  return /[\\/]$/.test(value) ? `${normalized}/**` : normalized;
}

function matches(file: string, pattern: string): boolean {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("**/", index)) {
      expression += "(?:.*/)?";
      index += 2;
    } else if (pattern.startsWith("**", index)) {
      expression += ".*";
      index += 1;
    } else if (pattern[index] === "*") expression += "[^/]*";
    else expression += pattern[index]!.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`).test(normalize(file));
}

export function changeScopeFor(boundary: ScopedBoundary): Required<ChangeScope> {
  const primary = boundary.change_scope.primary.map(safePattern);
  const auxiliary = (boundary.change_scope.auxiliary ?? []).map(safePattern);
  const forbidden = [".flywheel/**", ...(boundary.change_scope.forbidden ?? [])].map(safePattern);
  return { primary, auxiliary, forbidden };
}

export function validateChangedFiles(boundary: ScopedBoundary, files: string[]): void {
  const scope = changeScopeFor(boundary);
  const violations: string[] = [];
  for (const raw of files) {
    const file = safePattern(raw);
    if (scope.forbidden.some((pattern) => matches(file, pattern))) {
      violations.push(`${file}: forbidden`);
    } else if (![...scope.primary, ...scope.auxiliary].some((pattern) => matches(file, pattern))) {
      violations.push(`${file}: outside primary and auxiliary scope`);
    }
  }
  if (violations.length) throw new Error(`Change scope violation:\n${violations.map((item) => `  - ${item}`).join("\n")}`);
}

export function validateDeclaredAndActual(boundary: ScopedBoundary, declared: string[], actual: string[]): void {
  validateChangedFiles(boundary, declared);
  validateChangedFiles(boundary, actual);
  const expected = new Set(declared.map(normalize));
  const unexpected = actual.map(normalize).filter((file) => !expected.has(file));
  const actualSet = new Set(actual.map(normalize));
  const missing = declared.map(normalize).filter((file) => !actualSet.has(file));
  if (unexpected.length || missing.length) {
    throw new Error([
      ...(unexpected.length ? [`Candidate contains undeclared changes:\n${unexpected.map((file) => `  - ${file}`).join("\n")}`] : []),
      ...(missing.length ? [`Declared changes are absent from the actual diff:\n${missing.map((file) => `  - ${file}`).join("\n")}`] : []),
    ].join("\n"));
  }
}
