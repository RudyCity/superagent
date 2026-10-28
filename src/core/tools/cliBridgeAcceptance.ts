import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { applyProcessIntent } from "../process/processSpawnPolicy.js";

export interface AcceptanceArtifactRequirement {
  path: string;
  mustExist?: boolean;
  minBytes?: number;
  expectedSha256?: string;
}

export interface AcceptanceGitDiffRequirement {
  maxChangedFiles?: number;
  prohibitedPaths?: string[];
  requireCommit?: boolean;
  baseCommitSha?: string;
}

export type TypedVerificationCommand =
  | { kind: "npm-script"; name: string; args?: string[] }
  | { kind: "bun-script"; name: string; args?: string[] }
  | { kind: "binary"; executable: string; args?: string[] }
  | { kind: "git-status"; args?: string[] }
  | { kind: "git-diff"; args?: string[] };

export type VerificationCommandSpec = string | TypedVerificationCommand;

export interface AcceptanceContract {
  artifacts?: AcceptanceArtifactRequirement[];
  commands?: VerificationCommandSpec[];
  tests?: VerificationCommandSpec[];
  build?: VerificationCommandSpec[];
  gitDiff?: AcceptanceGitDiffRequirement;
  customVerifier?: VerificationCommandSpec;
}

export type JobVerificationState =
  | "succeeded_unverified"
  | "verifying"
  | "verified"
  | "artifacts_verified"
  | "verification_failed"
  | "permission_blocked"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "unknown_outcome_review_required";

export interface ArtifactVerificationDetail {
  path: string;
  exists: boolean;
  bytes: number;
  sha256?: string;
  passed: boolean;
  reason?: string;
}

export interface CommandVerificationDetail {
  command: string;
  exitCode: number;
  passed: boolean;
  outputTail: string;
}

function resolveArtifactInsideWorkspace(cwd: string, artifactPath: string): string {
  if (!artifactPath || path.isAbsolute(artifactPath)) {
    throw new Error("Artifact path must be a non-empty relative path.");
  }
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, artifactPath);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error("Artifact path escapes delegated workspace.");
  }
  return resolved;
}

export interface VerificationResult {
  state: JobVerificationState;
  verifiedAt: number;
  durationMs: number;
  artifactsPassed: boolean;
  artifactDetails?: ArtifactVerificationDetail[];
  testsPassed: boolean;
  buildPassed: boolean;
  gitDiffPassed: boolean;
  commandResults?: CommandVerificationDetail[];
  failureReason?: string;
}

/**
 * Verifies all required artifacts exist, meet minimum size, and match expected SHA-256 hash.
 */
export async function verifyArtifacts(
  cwd: string,
  artifacts: AcceptanceArtifactRequirement[]
): Promise<{ passed: boolean; details: ArtifactVerificationDetail[]; failureReason?: string }> {
  const details: ArtifactVerificationDetail[] = [];

  for (const req of artifacts) {
    let fullPath: string;
    try {
      fullPath = resolveArtifactInsideWorkspace(cwd, req.path);
    } catch (err: any) {
      details.push({ path: req.path, exists: false, bytes: 0, passed: false, reason: err?.message || "Invalid artifact path" });
      return { passed: false, details, failureReason: "Artifact '" + req.path + "' is outside the delegated workspace" };
    }
    try {
      const lstat = await fs.lstat(fullPath);
      if (lstat.isSymbolicLink()) {
        details.push({ path: req.path, exists: true, bytes: 0, passed: false, reason: "Symbolic links are not accepted as verification artifacts" });
        return { passed: false, details, failureReason: "Artifact '" + req.path + "' is a symbolic link" };
      }
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        details.push({
          path: req.path,
          exists: true,
          bytes: 0,
          passed: false,
          reason: "Target is not a regular file",
        });
        return { passed: false, details, failureReason: `Artifact '${req.path}' is not a regular file` };
      }

      if (req.minBytes !== undefined && stat.size < req.minBytes) {
        details.push({
          path: req.path,
          exists: true,
          bytes: stat.size,
          passed: false,
          reason: `File size ${stat.size} is less than minBytes ${req.minBytes}`,
        });
        return {
          passed: false,
          details,
          failureReason: `Artifact '${req.path}' size (${stat.size}B) < required minimum (${req.minBytes}B)`,
        };
      }

      const content = await fs.readFile(fullPath);
      const sha256 = crypto.createHash("sha256").update(content).digest("hex");

      if (req.expectedSha256 && sha256.toLowerCase() !== req.expectedSha256.toLowerCase()) {
        details.push({
          path: req.path,
          exists: true,
          bytes: stat.size,
          sha256,
          passed: false,
          reason: `SHA-256 mismatch (actual: ${sha256}, expected: ${req.expectedSha256})`,
        });
        return {
          passed: false,
          details,
          failureReason: `Artifact '${req.path}' SHA-256 mismatch`,
        };
      }

      details.push({
        path: req.path,
        exists: true,
        bytes: stat.size,
        sha256,
        passed: true,
      });
    } catch (err) {
      const exists = false;
      const mustExist = req.mustExist !== false;
      if (mustExist) {
        details.push({
          path: req.path,
          exists: false,
          bytes: 0,
          passed: false,
          reason: "File does not exist",
        });
        return {
          passed: false,
          details,
          failureReason: `Required artifact '${req.path}' does not exist`,
        };
      } else {
        details.push({
          path: req.path,
          exists: false,
          bytes: 0,
          passed: true,
        });
      }
    }
  }

  return { passed: true, details };
}

export const SAFE_VERIFICATION_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
  "HOMEPATH",
  "HOMEDRIVE",
  "APPDATA",
  "LOCALAPPDATA",
  "NODE_ENV",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "SHELL",
  "COMSPEC",
]);

export function buildSafeVerificationEnv(customEnv?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_VERIFICATION_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!;
    }
  }
  for (const [k] of Object.entries(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE)/i.test(k)) {
      delete env[k];
    }
  }
  if (customEnv) {
    for (const [k, v] of Object.entries(customEnv)) {
      if (!/(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE)/i.test(k)) {
        env[k] = v;
      }
    }
  }
  return env;
}

export function redactSecrets(text: string): string {
  if (!text) return "";
  return text
    .replace(/sk-ant-[a-zA-Z0-9_\-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/sk-[a-zA-Z0-9_\-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(/gh[pousr]_[a-zA-Z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/(?:api_key|apikey|password|secret|token)\s*[:=]\s*['"]?[a-zA-Z0-9_\-\.]{8,}['"]?/gi, (match) => {
      const idx = match.search(/[:=]/);
      return match.slice(0, idx + 1) + " [REDACTED]";
    });
}

/**
 * Runs a list of verification commands and asserts exit code 0.
 * Enforces environment isolation, output secret redaction, and bounded timeouts.
 */
export async function runVerificationCommands(
  cwd: string,
  commands: VerificationCommandSpec[],
  timeoutMs: number = 30000,
  options?: {
    workspaceRoot?: string;
  }
): Promise<{ passed: boolean; results: CommandVerificationDetail[]; failureReason?: string }> {
  const results: CommandVerificationDetail[] = [];
  const cappedTimeout = Math.min(Math.max(timeoutMs || 30000, 1000), 60000);
  const safeEnv = buildSafeVerificationEnv();

  for (const cmdSpec of commands) {
    let commandDisplay: string;
    let execFile: string;
    let execArgs: string[];
    let useShell = false;

    if (typeof cmdSpec === "string") {
      commandDisplay = cmdSpec.trim();
      // Path traversal or encoded flags check
      if (/(?:^|\s|\/|\\)\.\.(?:\/|\\|\s|$)/.test(commandDisplay)) {
        results.push({
          command: commandDisplay,
          exitCode: -1,
          passed: false,
          outputTail: "Rejected: verification command contains path traversal (../)",
        });
        return {
          passed: false,
          results,
          failureReason: `Verification command rejected: path traversal detected in '${commandDisplay}'`,
        };
      }
      if (/(?:^|\s)-(?:enc|encodedcommand)\b/i.test(commandDisplay) || /(?:powershell|pwsh)\b.*-(?:e|enc|encodedcommand)\b/i.test(commandDisplay)) {
        results.push({
          command: commandDisplay,
          exitCode: -1,
          passed: false,
          outputTail: "Rejected: verification command contains encoded command flags (-enc/-EncodedCommand)",
        });
        return {
          passed: false,
          results,
          failureReason: `Verification command rejected: encoded command flag in '${commandDisplay}'`,
        };
      }
      if (/\$\([^)]+\)/.test(commandDisplay) || /`[^`\r\n]+`/.test(commandDisplay)) {
        results.push({
          command: commandDisplay,
          exitCode: -1,
          passed: false,
          outputTail: "Rejected: verification command contains dynamic command substitution ($() or backticks)",
        });
        return {
          passed: false,
          results,
          failureReason: `Verification command rejected: dynamic command substitution in '${commandDisplay}'`,
        };
      }
      execFile = commandDisplay;
      execArgs = [];
      useShell = true;
    } else {
      // TypedVerificationCommand
      const kind = cmdSpec.kind;
      if (kind === "npm-script") {
        commandDisplay = `npm run ${cmdSpec.name}` + (cmdSpec.args?.length ? ` -- ${cmdSpec.args.join(" ")}` : "");
        execFile = process.platform === "win32" ? "npm.cmd" : "npm";
        execArgs = ["run", cmdSpec.name, "--", ...(cmdSpec.args ?? [])];
      } else if (kind === "bun-script") {
        commandDisplay = `bun run ${cmdSpec.name}` + (cmdSpec.args?.length ? ` ${cmdSpec.args.join(" ")}` : "");
        execFile = process.platform === "win32" ? "bun.exe" : "bun";
        execArgs = ["run", cmdSpec.name, ...(cmdSpec.args ?? [])];
      } else if (kind === "binary") {
        commandDisplay = `${cmdSpec.executable}` + (cmdSpec.args?.length ? ` ${cmdSpec.args.join(" ")}` : "");
        execFile = cmdSpec.executable;
        execArgs = cmdSpec.args ?? [];
      } else if (kind === "git-status") {
        commandDisplay = "git status " + (cmdSpec.args?.join(" ") || "--porcelain");
        execFile = "git";
        execArgs = ["status", ...(cmdSpec.args ?? ["--porcelain"])];
      } else if (kind === "git-diff") {
        commandDisplay = "git diff " + (cmdSpec.args?.join(" ") || "--name-only HEAD");
        execFile = "git";
        execArgs = ["diff", ...(cmdSpec.args ?? ["--name-only", "HEAD"])];
      } else {
        results.push({
          command: JSON.stringify(cmdSpec),
          exitCode: -1,
          passed: false,
          outputTail: `Unsupported verification command kind '${(cmdSpec as any)?.kind}'`,
        });
        return {
          passed: false,
          results,
          failureReason: `Unsupported verification command kind '${(cmdSpec as any)?.kind}'`,
        };
      }
    }

    try {
      const res = useShell
        ? await execa(execFile, applyProcessIntent({
            cwd,
            shell: true,
            timeout: cappedTimeout,
            env: safeEnv,
            reject: false,
          }, "headless", { caller: "cliBridgeAcceptance.runVerificationCommands.shell", executable: execFile, cwd }))
        : await execa(execFile, execArgs, applyProcessIntent({
            cwd,
            shell: false,
            timeout: cappedTimeout,
            env: safeEnv,
            reject: false,
          }, "headless", { caller: "cliBridgeAcceptance.runVerificationCommands.argv", executable: execFile, args: execArgs, cwd }));

      const rawOutput = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
      const outputTail = redactSecrets(rawOutput.slice(-500));
      const passed = res.exitCode === 0;
      results.push({
        command: commandDisplay,
        exitCode: res.exitCode ?? -1,
        passed,
        outputTail,
      });

      if (!passed) {
        const failureReason = res.timedOut
          ? `Verification command timed out after ${cappedTimeout}ms: '${commandDisplay}'`
          : `Verification command failed with exit code ${res.exitCode}: '${commandDisplay}'`;
        return {
          passed: false,
          results,
          failureReason,
        };
      }
    } catch (err: any) {
      const rawError = err?.message || "Execution failed";
      const outputTail = redactSecrets(rawError.slice(-500));
      const isTimeout = err?.timedOut === true || /timed?\s*out/i.test(rawError);
      results.push({
        command: commandDisplay,
        exitCode: -1,
        passed: false,
        outputTail,
      });
      return {
        passed: false,
        results,
        failureReason: isTimeout
          ? `Verification command timed out: '${commandDisplay}'`
          : `Verification command crashed or failed: '${commandDisplay}'`,
      };
    }
  }

  return { passed: true, results };
}

/**
 * Inspects Git diff against prohibited paths and maximum changed file count.
 */
export async function verifyGitDiffConstraints(
  cwd: string,
  gitDiffReq: AcceptanceGitDiffRequirement
): Promise<{ passed: boolean; changedFiles: string[]; failureReason?: string }> {
  try {
    const baseCommit = gitDiffReq.baseCommitSha || "HEAD";
    const res = await execa("git", ["diff", "--name-only", baseCommit], applyProcessIntent({
      cwd,
      reject: false,
    }, "headless", { caller: "cliBridgeAcceptance.verifyGitDiffConstraints.diff", executable: "git", cwd }));

    const statusRes = await execa("git", ["status", "--porcelain"], applyProcessIntent({
      cwd,
      reject: false,
    }, "headless", { caller: "cliBridgeAcceptance.verifyGitDiffConstraints.status", executable: "git", cwd }));

    const diffFiles = res.stdout ? res.stdout.split(/\r?\n/).filter(Boolean) : [];
    const untrackedFiles = statusRes.stdout
      ? statusRes.stdout
          .split(/\r?\n/)
          .filter((l) => l.startsWith("?? "))
          .map((l) => l.slice(3).trim())
      : [];

    const allChanged = [...new Set([...diffFiles, ...untrackedFiles])];

    if (gitDiffReq.maxChangedFiles !== undefined && allChanged.length > gitDiffReq.maxChangedFiles) {
      return {
        passed: false,
        changedFiles: allChanged,
        failureReason: `Changed file count (${allChanged.length}) exceeded allowed maximum (${gitDiffReq.maxChangedFiles})`,
      };
    }

    if (gitDiffReq.prohibitedPaths && gitDiffReq.prohibitedPaths.length > 0) {
      for (const prohibited of gitDiffReq.prohibitedPaths) {
        const normProhibited = prohibited.replace(/\\/g, "/").toLowerCase();
        const violated = allChanged.find((f) => f.replace(/\\/g, "/").toLowerCase().includes(normProhibited));
        if (violated) {
          return {
            passed: false,
            changedFiles: allChanged,
            failureReason: `Mutation in prohibited path detected: '${violated}' matches '${prohibited}'`,
          };
        }
      }
    }

    if (gitDiffReq.requireCommit) {
      const dirty = statusRes.stdout.trim().length > 0;
      if (dirty) {
        return {
          passed: false,
          changedFiles: allChanged,
          failureReason: "Uncommitted changes present in workspace when requireCommit is true",
        };
      }
    }

    return { passed: true, changedFiles: allChanged };
  } catch (err: any) {
    return {
      passed: false,
      changedFiles: [],
      failureReason: `Git diff check error: ${err?.message || "Failed to inspect git diff"}`,
    };
  }
}

/**
 * Primary entry point for verifying a completed job against its acceptance contract.
 */
export async function executeAcceptanceVerification(
  cwd: string,
  contract?: AcceptanceContract,
  options?: { timeoutMs?: number; workspaceRoot?: string }
): Promise<VerificationResult> {
  const startedAt = Date.now();

  // If no contract specified, job outcome remains unverified
  if (!contract || Object.keys(contract).length === 0) {
    return {
      state: "succeeded_unverified",
      verifiedAt: startedAt,
      durationMs: 0,
      artifactsPassed: true,
      testsPassed: true,
      buildPassed: true,
      gitDiffPassed: true,
    };
  }

  // 1. Artifacts verification
  let artifactsPassed = true;
  let artifactDetails: ArtifactVerificationDetail[] | undefined;
  if (contract.artifacts && contract.artifacts.length > 0) {
    const artRes = await verifyArtifacts(cwd, contract.artifacts);
    artifactsPassed = artRes.passed;
    artifactDetails = artRes.details;
    if (!artifactsPassed) {
      return {
        state: "verification_failed",
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        artifactsPassed: false,
        artifactDetails,
        testsPassed: true,
        buildPassed: true,
        gitDiffPassed: true,
        failureReason: artRes.failureReason,
      };
    }
  }

  // 2. Build verification commands
  let buildPassed = true;
  if (contract.build && contract.build.length > 0) {
    const buildRes = await runVerificationCommands(cwd, contract.build, options?.timeoutMs);
    buildPassed = buildRes.passed;
    if (!buildPassed) {
      return {
        state: "verification_failed",
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        artifactsPassed,
        artifactDetails,
        testsPassed: true,
        buildPassed: false,
        gitDiffPassed: true,
        commandResults: buildRes.results,
        failureReason: buildRes.failureReason,
      };
    }
  }

  // 3. Test verification commands
  let testsPassed = true;
  let commandResults: CommandVerificationDetail[] | undefined;
  if (contract.tests && contract.tests.length > 0) {
    const testRes = await runVerificationCommands(cwd, contract.tests, options?.timeoutMs);
    testsPassed = testRes.passed;
    commandResults = testRes.results;
    if (!testsPassed) {
      return {
        state: "verification_failed",
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        artifactsPassed,
        artifactDetails,
        testsPassed: false,
        buildPassed,
        gitDiffPassed: true,
        commandResults,
        failureReason: testRes.failureReason,
      };
    }
  }

  // Generic verification commands
  if (contract.commands && contract.commands.length > 0) {
    const cmdRes = await runVerificationCommands(cwd, contract.commands, options?.timeoutMs);
    if (!cmdRes.passed) {
      return {
        state: "verification_failed",
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        artifactsPassed,
        artifactDetails,
        testsPassed,
        buildPassed,
        gitDiffPassed: true,
        commandResults: cmdRes.results,
        failureReason: cmdRes.failureReason,
      };
    }
    commandResults = [...(commandResults || []), ...cmdRes.results];
  }

  // 4. Git diff constraints
  let gitDiffPassed = true;
  if (contract.gitDiff) {
    const diffRes = await verifyGitDiffConstraints(cwd, contract.gitDiff);
    gitDiffPassed = diffRes.passed;
    if (!gitDiffPassed) {
      return {
        state: "verification_failed",
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        artifactsPassed,
        artifactDetails,
        testsPassed,
        buildPassed,
        gitDiffPassed: false,
        commandResults,
        failureReason: diffRes.failureReason,
      };
    }
  }

  // 5. Custom verifier command
  if (contract.customVerifier) {
    const custRes = await runVerificationCommands(cwd, [contract.customVerifier], options?.timeoutMs);
    if (!custRes.passed) {
      return {
        state: "verification_failed",
        verifiedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        artifactsPassed,
        artifactDetails,
        testsPassed,
        buildPassed,
        gitDiffPassed,
        commandResults: custRes.results,
        failureReason: custRes.failureReason,
      };
    }
  }

  return {
    state: "verified",
    verifiedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    artifactsPassed,
    artifactDetails,
    testsPassed,
    buildPassed,
    gitDiffPassed,
    commandResults,
  };
}
