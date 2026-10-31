import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSshTarget, sanitizeSshTarget } from "./sshTargetSanitizer.js";

export type WorkspaceClassification =
  | "project"
  | "nested-project"
  | "worktree"
  | "temporary"
  | "test-fixture"
  | "missing"
  | "unsafe"
  | "unknown";

export interface ClassificationContext {
  registeredRoots?: Set<string>;
  explicitlyTrustedNamed?: Set<string>;
  allowTempAsProjectRoot?: boolean;
}

export interface ClassificationResult {
  classification: WorkspaceClassification;
  canonicalTarget: string;
  type: "local" | "ssh" | "chain";
  available: boolean;
  importable: boolean;
  gitRoot?: string;
  repositoryIdentity?: string;
  rejectionReasons: string[];
}

/**
 * Normalizes a local filesystem path:
 * - Resolves to absolute path
 * - Uppercases Windows drive letters (C:\...)
 * - Normalizes path separators and trims trailing slashes (except root)
 */
export function normalizeLocalPath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  let resolved = path.resolve(trimmed);

  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      if (real) {
        resolved = real;
      }
    }
  } catch {}

  if (process.platform === "win32") {
    if (resolved.startsWith("\\\\?\\UNC\\")) {
      resolved = "\\" + resolved.slice("\\\\?\\UNC\\".length);
    } else if (resolved.startsWith("\\\\?\\")) {
      resolved = resolved.slice("\\\\?\\".length);
    }
    if (/^[a-zA-Z]:/.test(resolved)) {
      resolved = resolved[0].toUpperCase() + resolved.slice(1);
    }
  }
  const parsed = path.parse(resolved);
  if (resolved !== parsed.root && (resolved.endsWith("/") || resolved.endsWith("\\"))) {
    resolved = resolved.replace(/[\\/]+$/, "");
  }
  return resolved;
}

export function pathKey(rawPath: string): string {
  const norm = normalizeLocalPath(rawPath);
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/**
 * Checks whether a path contains temporary, scratch, test fixture, or internal sandbox segments.
 */
export function isTemporaryOrTestPath(p: string, allowTempRoot = false): { isTemp: boolean; reason?: string } {
  const normalized = normalizeLocalPath(p);
  const lower = normalized.toLowerCase();

  if (lower.includes("node_modules")) {
    return { isTemp: true, reason: "node_modules directory." };
  }
  if (lower.includes("mcp-project-tools-") || lower.includes("mcp-test-") || lower.includes("temp-home-worker-")) {
    return { isTemp: true, reason: "SuperAgent test fixture directory." };
  }
  if (lower.includes("\\test-fixture") || lower.includes("/test-fixture") || lower.includes("\\fixtures\\") || lower.includes("/fixtures/")) {
    return { isTemp: true, reason: "Test fixture path." };
  }
  if (lower.endsWith("\\scratch") || lower.endsWith("/scratch") || lower.includes("\\scratch\\") || lower.includes("/scratch/")) {
    return { isTemp: true, reason: "Scratch workspace directory." };
  }
  if (lower.includes(".superagent-local-staging")) {
    return { isTemp: true, reason: "SuperAgent staging directory." };
  }

  // OS temp directories (unless explicitly allowed for mock unit tests)
  const allowTemp = allowTempRoot || process.env.SUPERAGENT_ALLOW_TEMP_WORKSPACE === "1";
  if (!allowTemp) {
    const tmpDir = normalizeLocalPath(os.tmpdir()).toLowerCase();
    if (lower.startsWith(tmpDir) || lower.includes("\\temp\\") || lower.includes("/temp/") || lower.includes("\\tmp\\") || lower.includes("/tmp/")) {
      return { isTemp: true, reason: "Temporary operating system directory." };
    }
  }

  return { isTemp: false };
}

/**
 * Checks whether a path indicates a Git worktree.
 */
export function isWorktreePath(p: string): { isWorktree: boolean; reason?: string } {
  const normalized = normalizeLocalPath(p);
  const lower = normalized.toLowerCase();

  if (/[\\/]\.worktrees(?:[\\/]|$)/i.test(lower) || /[\\/]\.superagent-r[\\/]worktrees(?:[\\/]|$)/i.test(lower)) {
    return { isWorktree: true, reason: "Isolated git worktree path (.worktrees)." };
  }
  if (/[\\/]wt_\d+/i.test(lower)) {
    return { isWorktree: true, reason: "Generated git worktree pattern (wt_*)." };
  }

  // Inspect .git file if present on disk
  try {
    const gitPath = path.join(normalized, ".git");
    if (fs.existsSync(gitPath)) {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf8");
        if (/gitdir:\s*.*worktree/i.test(content) || /gitdir:\s*.*\.worktrees/i.test(content)) {
          return { isWorktree: true, reason: "Git worktree pointer (.git file points to worktrees dir)." };
        }
      }
    }
  } catch {}

  return { isWorktree: false };
}

/**
 * Finds Git root information for a local path by inspecting .git directories.
 */
export function inspectGitBoundary(targetDir: string): {
  gitRoot?: string;
  hasOwnGit: boolean;
  parentGitRoot?: string;
  isWorktree: boolean;
} {
  const normalized = normalizeLocalPath(targetDir);
  if (!fs.existsSync(normalized)) {
    return { hasOwnGit: false, isWorktree: false };
  }

  // Check targetDir/.git
  const gitPath = path.join(normalized, ".git");
  if (fs.existsSync(gitPath)) {
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return { gitRoot: normalized, hasOwnGit: true, isWorktree: false };
      }
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf8");
        const isWt = /gitdir:\s*.*worktree/i.test(content) || /gitdir:\s*.*\.worktrees/i.test(content);
        return { gitRoot: normalized, hasOwnGit: true, isWorktree: isWt };
      }
    } catch {}
  }

  // Walk up to find enclosing Git root
  let current = path.dirname(normalized);
  const root = path.parse(normalized).root;
  while (current && current !== root && current !== path.dirname(current)) {
    const parentGit = path.join(current, ".git");
    if (fs.existsSync(parentGit)) {
      return { gitRoot: current, hasOwnGit: false, parentGitRoot: current, isWorktree: false };
    }
    current = path.dirname(current);
  }

  return { hasOwnGit: false, isWorktree: false };
}

/**
 * Classifies a workspace candidate and evaluates its importability and safety.
 */
export function classifyWorkspaceTarget(
  rawTarget: string,
  context?: ClassificationContext,
): ClassificationResult {
  const trimmed = (rawTarget || "").trim();
  const rejectionReasons: string[] = [];

  // Check for SSH
  if (isSshTarget(trimmed)) {
    const sanitized = sanitizeSshTarget(trimmed);
    if (!sanitized.valid || !sanitized.sanitized) {
      return {
        classification: "unsafe",
        canonicalTarget: trimmed,
        type: "ssh",
        available: false,
        importable: false,
        rejectionReasons: [sanitized.error || "Unsafe or malformed SSH target."],
      };
    }
    return {
      classification: "project",
      canonicalTarget: sanitized.sanitized,
      type: "ssh",
      available: true,
      importable: true,
      rejectionReasons: [],
    };
  }

  // Check for Chain
  if (trimmed.startsWith("chain:")) {
    const chainId = trimmed.slice("chain:".length).toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(chainId)) {
      return {
        classification: "unsafe",
        canonicalTarget: trimmed,
        type: "chain",
        available: false,
        importable: false,
        rejectionReasons: ["Invalid Workspace Chain target ID."],
      };
    }
    return {
      classification: "project",
      canonicalTarget: `chain:${chainId}`,
      type: "chain",
      available: true,
      importable: true,
      rejectionReasons: [],
    };
  }

  // Local filesystem target
  const normalized = normalizeLocalPath(trimmed);
  if (!normalized || normalized === "\\" || normalized === "/") {
    return {
      classification: "unsafe",
      canonicalTarget: trimmed,
      type: "local",
      available: false,
      importable: false,
      rejectionReasons: ["Invalid or empty filesystem target."],
    };
  }

  // Worktree structural pattern check before existence check
  const lowerTarget = normalized.toLowerCase();
  const isStructuralWorktree =
    /[\\/]\.worktrees(?:[\\/]|$)/i.test(lowerTarget) ||
    /[\\/]\.superagent-r[\\/]worktrees(?:[\\/]|$)/i.test(lowerTarget) ||
    /[\\/]wt_\d+/i.test(lowerTarget);

  if (isStructuralWorktree) {
    const exists = fs.existsSync(normalized);
    return {
      classification: "worktree",
      canonicalTarget: normalized,
      type: "local",
      available: exists,
      importable: false,
      rejectionReasons: ["Worktree environments cannot be imported as independent projects."],
    };
  }

  // Existence check
  if (!fs.existsSync(normalized)) {
    return {
      classification: "missing",
      canonicalTarget: normalized,
      type: "local",
      available: false,
      importable: false,
      rejectionReasons: [`Target directory does not exist on disk: ${normalized}`],
    };
  }

  // Worktree check (for .git file pointer worktrees present on disk)
  const worktreeCheck = isWorktreePath(normalized);
  if (worktreeCheck.isWorktree) {
    return {
      classification: "worktree",
      canonicalTarget: normalized,
      type: "local",
      available: true,
      importable: false,
      rejectionReasons: [worktreeCheck.reason || "Worktree environments cannot be imported as independent projects."],
    };
  }

  // Temp / test fixture check
  const tempCheck = isTemporaryOrTestPath(normalized, context?.allowTempAsProjectRoot);
  if (tempCheck.isTemp) {
    const isFixture = tempCheck.reason?.includes("test fixture") || tempCheck.reason?.includes("Test fixture");
    return {
      classification: isFixture ? "test-fixture" : "temporary",
      canonicalTarget: normalized,
      type: "local",
      available: true,
      importable: false,
      rejectionReasons: [tempCheck.reason || "Temporary or test directory."],
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return {
      classification: "missing",
      canonicalTarget: normalized,
      type: "local",
      available: false,
      importable: false,
      rejectionReasons: [`Cannot inspect target directory: ${normalized}`],
    };
  }

  if (!stat.isDirectory()) {
    return {
      classification: "unsafe",
      canonicalTarget: normalized,
      type: "local",
      available: true,
      importable: false,
      rejectionReasons: [`Target path is not a directory: ${normalized}`],
    };
  }

  // Git and Monorepo / Nested boundaries
  const gitBoundary = inspectGitBoundary(normalized);
  if (gitBoundary.isWorktree) {
    return {
      classification: "worktree",
      canonicalTarget: normalized,
      type: "local",
      available: true,
      importable: false,
      rejectionReasons: ["Worktree environments cannot be imported as independent projects."],
    };
  }

  const registeredKey = pathKey(normalized);
  const isExplicitlyRegistered = context?.registeredRoots?.has(registeredKey);
  const isExplicitlyTrustedNamed = context?.explicitlyTrustedNamed?.has(registeredKey);

  // If it has its own Git root, it's a first-class project
  if (gitBoundary.hasOwnGit) {
    return {
      classification: "project",
      canonicalTarget: normalized,
      type: "local",
      available: true,
      importable: !isExplicitlyRegistered,
      gitRoot: gitBoundary.gitRoot,
      repositoryIdentity: gitBoundary.gitRoot ? path.basename(gitBoundary.gitRoot) : undefined,
      rejectionReasons: isExplicitlyRegistered ? ["Already registered in MCP project registry."] : [],
    };
  }

  // Nested directory inside a parent Git repository
  if (gitBoundary.parentGitRoot) {
    // If explicitly registered or trusted by custom name, allow as nested project
    if (isExplicitlyRegistered || isExplicitlyTrustedNamed) {
      return {
        classification: "nested-project",
        canonicalTarget: normalized,
        type: "local",
        available: true,
        importable: !isExplicitlyRegistered,
        gitRoot: gitBoundary.parentGitRoot,
        repositoryIdentity: path.basename(gitBoundary.parentGitRoot),
        rejectionReasons: isExplicitlyRegistered ? ["Already registered in MCP project registry."] : [],
      };
    }

    // Otherwise, collapse into parent monorepo project: do not promote to independent importable project
    return {
      classification: "nested-project",
      canonicalTarget: normalized,
      type: "local",
      available: true,
      importable: false,
      gitRoot: gitBoundary.parentGitRoot,
      repositoryIdentity: path.basename(gitBoundary.parentGitRoot),
      rejectionReasons: [
        `Nested subdirectory of parent repository (${gitBoundary.parentGitRoot}). Attach usage to parent project instead.`,
      ],
    };
  }

  // Standalone directory without Git root
  return {
    classification: "project",
    canonicalTarget: normalized,
    type: "local",
    available: true,
    importable: !isExplicitlyRegistered,
    rejectionReasons: isExplicitlyRegistered ? ["Already registered in MCP project registry."] : [],
  };
}
