// Read-only, heuristic pre-publication review. Never print matching values.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const summaryOnly = process.argv.includes("--summary");
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const rules = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ["provider-token", /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/],
  ["credential-assignment", /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+\/=.-]{16,}["']/i],
  ["token-url", /[?&](?:token|api_key|access_token)=[A-Za-z0-9_.-]{16,}/i],
  ["personal-path", /(?:[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/"'<>]+|\/(?:Users|home)\/[^\s/"'<>]+)/],
  ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
];
const findings = [];
const unscanned = [];
let textFiles = 0;
function scan(buffer, scope, file, object) {
  if (buffer.length > 8 * 1024 * 1024 || buffer.includes(0)) {
    unscanned.push({ scope, file, object, reason: buffer.length > 8 * 1024 * 1024 ? "size-limit" : "binary" });
    return;
  }
  textFiles++;
  buffer.toString("utf8").split(/\r?\n/).forEach((line, index) => {
    for (const [kind, regex] of rules) if (regex.test(line)) findings.push({ scope, file, object, line: index + 1, kind });
  });
}
const candidates = [...new Set(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").toString().split("\0").filter(Boolean))];
for (const file of candidates) {
  if (/(^|\/)(\.env(?:\.|$)|\.aws\/|\.flywheel\/|attempts\/|auth\.json$|credentials(?:\.|$)|id_(?:rsa|ed25519)$)/.test(file)
      && !file.endsWith(".env.example")) findings.push({ scope: "worktree", file, kind: "sensitive-path" });
  try { scan(readFileSync(path.join(root, file)), "worktree", file); }
  catch (error) { if (error.code !== "ENOENT") throw error; } // Deleted tracked paths are absent from the proposed tree.
}
const objects = git("rev-list", "--objects", "--all").toString().trim().split("\n").filter(Boolean);
const branchObjects = new Set(git("rev-list", "--objects", "--branches", "--remotes").toString().split("\n").map((line) => line.split(" ")[0]));
let blobs = 0;
for (const entry of objects) {
  const [oid, ...name] = entry.split(" ");
  if (git("cat-file", "-t", oid).toString().trim() !== "blob") continue;
  blobs++;
  scan(git("cat-file", "blob", oid), branchObjects.has(oid) ? "branch-history" : "auxiliary-history", name.join(" "), oid);
}
scan(git("log", "--all", "--format=%B"), "history-messages", "commit-messages");
const identities = git("log", "--all", "--format=%ae%n%ce").toString().trim().split("\n").filter(Boolean);
console.log(JSON.stringify({
  scope: "Git-tracked plus nonignored untracked working files; all refs' reachable history blobs and commit email metadata",
  limitations: "Heuristic patterns only; ignored local files, unreachable objects, binary pixels and arbitrary encoded secrets are not audited. Findings include test placeholders, upstream attribution and examples. Review each before publication.",
  candidatePaths: candidates.length, historyBlobs: blobs, textFiles,
  commitEmailIdentities: new Set(identities).size,
  findings,
  unscanned: summaryOnly ? {
    total: unscanned.length,
    worktree: unscanned.filter((item) => item.scope === "worktree").length,
    history: unscanned.filter((item) => item.scope !== "worktree").length,
  } : unscanned,
}, null, 2));
process.exitCode = findings.length || unscanned.length ? 2 : 0;
