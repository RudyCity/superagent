#!/usr/bin/env bun
/**
 * Detect the observability-refactor regression class: a commit that deletes a
 * lifecycle guard (`resume`, `pause`, `setRawMode`, `clearInterval`,
 * `clearTimeout`, `removeListener`, `off`, `abort`, `cancel`, `dispose`) in the
 * same file where it adds logging.
 *
 * That is exactly how 322d0b50 removed both `process.stdin.resume()` calls and
 * left the CLI rendering but deaf to keys for a week. The pairing keeps the
 * signal high: guards removed on their own, or logging added on its own, are
 * normal work.
 *
 * Usage:
 *   bun scripts/audit-effect-guards.ts [--since <when>] [--range <rev-range>]
 *                                      [--allowlist <path>] [--json]
 *
 * Exit codes: 0 clean, 1 regressions found, 2 usage/environment error.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface GuardFinding {
  sha: string;
  date: string;
  subject: string;
  file: string;
  removed: string[];
}

export interface AuditOptions {
  /** Commit SHAs reviewed and accepted, keyed by full or short SHA. */
  allowlist?: Record<string, string>;
}

const GUARD_PATTERN =
  /\.resume\(|\.pause\(|setRawMode|clearInterval|clearTimeout|removeListener|\.off\(|\.abort\(|\.cancel\(|\.dispose\(/;
const LOGGER_PATTERN = /logInput|logCli|logDispatch|logHang|logPerf|logStartup/;

interface CommitState {
  sha: string;
  date: string;
  subject: string;
  guardsByFile: Map<string, string[]>;
  loggedFiles: Set<string>;
}

function finalize(state: CommitState | undefined, into: GuardFinding[]): void {
  if (!state) return;
  for (const [file, removed] of state.guardsByFile) {
    if (state.loggedFiles.has(file)) {
      into.push({ sha: state.sha, date: state.date, subject: state.subject, file, removed });
    }
  }
}

/**
 * Parse `git log -p --unified=0` output into guard-removal findings.
 * Pure: everything the audit needs is in the diff text.
 */
export function findGuardRemovals(history: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  let state: CommitState | undefined;
  let file: string | null = null;

  for (const line of history.split(/\r?\n/)) {
    if (line.startsWith("COMMIT\t")) {
      finalize(state, findings);
      const [, sha = "", date = "", subject = ""] = line.split("\t");
      state = { sha, date, subject, guardsByFile: new Map(), loggedFiles: new Set() };
      file = null;
      continue;
    }
    if (!state) continue;

    if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length).trim();
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++") || file === null) continue;

    if (line.startsWith("-")) {
      const body = line.slice(1).trim();
      if (!body || !GUARD_PATTERN.test(body)) continue;
      const existing = state.guardsByFile.get(file) ?? [];
      existing.push(body);
      state.guardsByFile.set(file, existing);
      continue;
    }

    if (line.startsWith("+") && LOGGER_PATTERN.test(line)) {
      state.loggedFiles.add(file);
    }
  }

  finalize(state, findings);
  return findings;
}

export function splitAllowlisted(
  findings: GuardFinding[],
  allowlist: Record<string, string> = {}
): { blocking: GuardFinding[]; allowed: GuardFinding[] } {
  const blocking: GuardFinding[] = [];
  const allowed: GuardFinding[] = [];
  for (const finding of findings) {
    const known = Object.keys(allowlist).some((prefix) => finding.sha.startsWith(prefix));
    (known ? allowed : blocking).push(finding);
  }
  return { blocking, allowed };
}

export function formatReport(
  blocking: GuardFinding[],
  allowed: GuardFinding[],
  allowlist: Record<string, string> = {}
): string {
  const lines: string[] = [];
  if (blocking.length === 0) {
    lines.push("effect-guard audit: clean");
  } else {
    lines.push(`effect-guard audit: ${blocking.length} regression(s) found`);
  }
  lines.push(`  allowlisted commits: ${Object.keys(allowlist).length}`);
  for (const finding of blocking) {
    lines.push("");
    lines.push(`BLOCKING ${finding.sha.slice(0, 8)} ${finding.date} ${finding.subject}`);
    lines.push(`  file: ${finding.file}`);
    for (const line of finding.removed) lines.push(`  removed guard: ${line}`);
  }
  for (const finding of allowed) {
    lines.push("");
    lines.push(`allowed ${finding.sha.slice(0, 8)} (${finding.file}) — reviewed, see allowlist reason`);
  }
  return lines.join("\n");
}

function readAllowlist(filePath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function gitHistory(args: string[]): string {
  const result = spawnSync("git", ["log", "--no-merges", "--unified=0", "--date=short", "--format=COMMIT%x09%H%x09%ad%x09%s", ...args, "--", "src"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git log failed (${result.status}): ${result.stderr?.trim() ?? ""}`);
  }
  return result.stdout ?? "";
}

function main(argv: string[]): number {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: bun scripts/audit-effect-guards.ts [--since <when>] [--range <rev-range>] [--allowlist <path>] [--json]");
    return 0;
  }

  const allowlistPath = path.resolve(option("--allowlist") ?? path.join(import.meta.dir, "effect-guard-allowlist.json"));
  const allowlist = readAllowlist(allowlistPath);
  const range = option("--range");
  const since = option("--since") ?? (range ? undefined : "1.year.ago");

  let history: string;
  try {
    history = gitHistory(range ? [range] : [`--since=${since}`]);
  } catch (error) {
    console.error(`effect-guard audit failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const findings = findGuardRemovals(history);
  const { blocking, allowed } = splitAllowlisted(findings, allowlist);

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ blocking, allowed, allowlist }, null, 2));
  } else {
    console.log(formatReport(blocking, allowed, allowlist));
    if (blocking.length > 0) {
      console.error("\nA guard was deleted in the same file where logging was added.");
      console.error("Restore the guard, or record the reviewed commit in " + allowlistPath + " with a reason.");
    }
  }

  return blocking.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
