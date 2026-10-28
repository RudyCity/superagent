import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execa } from "execa";
import { addTrustedDirectory, ensureDirectoryTrusted } from "../config/jsonConfig.js";
import { applyProcessIntent } from "../process/processSpawnPolicy.js";
import { getProcessSupervisor } from "../process/processSupervisor.js";

function headlessOpts<T extends Record<string, any>>(opts?: T, caller = "cliBridgeWorktreeManager") {
  return applyProcessIntent(opts ?? ({} as T), "headless", { caller, executable: "git" });
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  baseCommitSha?: string;
  branchName: string;
  targetDir?: string;
  linkNodeModules?: boolean;
}

export interface WorktreeMetadata {
  worktreeId: string;
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
  createdAt: string;
}

export interface WorktreeEntry {
  worktreePath: string;
  headSha: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

export interface WorktreeCommitProvenance {
  headSha: string;
  baseCommitSha: string;
  branchName: string;
  commitCount: number;
  commitMessages: string[];
  isClean: boolean;
}

export function normalizeFsPath(p: string): string {
  return path.resolve(p).toLowerCase().replace(/\\/g, "/");
}

/**
 * Ensures that the project .gitignore excludes worktrees directory.
 */
export function ensureWorktreeIgnored(repoRoot: string, ignoreName: string = ".worktrees"): void {
  try {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    const entry = ignoreName.endsWith("/") ? ignoreName : `${ignoreName}/`;
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, `${entry}\n`, "utf-8");
      return;
    }
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const lines = content.split(/\r?\n/);
    if (!lines.some((line) => line.trim() === ignoreName || line.trim() === entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`, "utf-8");
    }
  } catch {
    // Non-fatal if gitignore cannot be modified
  }
}

/**
 * Parses `git worktree list --porcelain` into structured WorktreeEntry items.
 */
export async function listIsolatedWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const result = await execa("git", ["worktree", "list", "--porcelain"], headlessOpts({
    cwd: repoRoot,
    reject: false,
  }));

  if (!result.stdout || result.exitCode !== 0) {
    return [];
  }

  const entries: WorktreeEntry[] = [];
  const blocks = result.stdout.split(/\r?\n\r?\n/);

  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    let worktreePath = "";
    let headSha = "";
    let branch: string | undefined;
    let bare = false;
    let detached = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktreePath = path.resolve(line.slice(9).trim());
      } else if (line.startsWith("HEAD ")) {
        headSha = line.slice(5).trim();
      } else if (line.startsWith("branch ")) {
        branch = line.slice(7).trim();
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        detached = true;
      }
    }

    if (worktreePath && headSha) {
      entries.push({
        worktreePath,
        headSha,
        branch,
        bare,
        detached,
      });
    }
  }

  return entries;
}

/**
 * Creates an isolated git worktree checked out to a new branch from a pinned base commit SHA.
 */
export async function createIsolatedWorktree(options: CreateWorktreeOptions): Promise<WorktreeMetadata> {
  const repoRoot = path.resolve(options.repoRoot);

  // Verify that repoRoot is a valid git repository
  const revParseCheck = await execa("git", ["rev-parse", "--is-inside-work-tree"], headlessOpts({
    cwd: repoRoot,
    reject: false,
  }));
  if (revParseCheck.exitCode !== 0) {
    throw new Error(`Directory is not a valid git repository: ${repoRoot}`);
  }

  // Determine base commit SHA (pinned or current HEAD)
  let baseCommitSha = options.baseCommitSha;
  if (!baseCommitSha) {
    const headRes = await execa("git", ["rev-parse", "HEAD"], headlessOpts({ cwd: repoRoot }));
    baseCommitSha = headRes.stdout.trim();
  }

  // Validate base commit SHA exists
  const commitCheck = await execa("git", ["cat-file", "-e", `${baseCommitSha}^{commit}`], headlessOpts({
    cwd: repoRoot,
    reject: false,
  }));
  if (commitCheck.exitCode !== 0) {
    throw new Error(`Base commit SHA does not exist: ${baseCommitSha}`);
  }

  const worktreeId = `wt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const sanitizedBranch = options.branchName.replace(/[^a-zA-Z0-9._/-]/g, "_");

  // Determine target directory
  const targetDir = options.targetDir
    ? path.resolve(options.targetDir)
    : path.resolve(repoRoot, ".worktrees", worktreeId);

  // Ensure parent directory exists
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });

  // Add git worktree
  const gitAddArgs = ["worktree", "add", targetDir, "-b", sanitizedBranch, baseCommitSha];
  let procRecordId: string | undefined;
  try {
    const reg = await getProcessSupervisor().registerProcess({
      component: "git_worktree",
      executable: "git",
      args: gitAddArgs,
      launchIntent: "headless",
      lifecycle: "ephemeral",
      cleanupPolicy: "caller_owned",
      workspaceRoot: repoRoot,
    });
    procRecordId = reg.recordId;
  } catch {}

  const addProc = execa("git", gitAddArgs, headlessOpts({ cwd: repoRoot, reject: false }));
  if (procRecordId && addProc.pid) {
    void getProcessSupervisor().recordProcessSpawn(procRecordId, addProc.pid).catch(() => {});
  }
  const addResult = await addProc;
  if (procRecordId) {
    void getProcessSupervisor().recordProcessExit(procRecordId, {
      exitCode: addResult.exitCode ?? 0,
      signal: null,
      source: "cliBridgeWorktreeManager.createIsolatedWorktree",
    }).catch(() => {});
  }

  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to create git worktree: ${addResult.stderr || addResult.stdout}`);
  }

  // Trust directory in superagent config
  try {
    addTrustedDirectory(targetDir);
    await ensureDirectoryTrusted(targetDir);
  } catch {
    // Ignore config trust failures
  }

  // Link node_modules if requested or present in repoRoot
  if (options.linkNodeModules !== false) {
    const rootNodeModules = path.join(repoRoot, "node_modules");
    const targetNodeModules = path.join(targetDir, "node_modules");

    if (fs.existsSync(rootNodeModules) && !fs.existsSync(targetNodeModules)) {
      try {
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        await fs.promises.symlink(rootNodeModules, targetNodeModules, symlinkType);
      } catch {
        // Non-fatal if node_modules junction cannot be created
      }
    }
  }

  const metadata: WorktreeMetadata = {
    worktreeId,
    worktreePath: targetDir,
    branchName: sanitizedBranch,
    baseCommitSha,
    createdAt: new Date().toISOString(),
  };

  return metadata;
}

/**
 * Removes an isolated git worktree and optionally deletes its branch.
 */
export async function removeIsolatedWorktree(options: {
  repoRoot: string;
  worktreePath: string;
  branchName?: string;
  force?: boolean;
  deleteBranch?: boolean;
}): Promise<void> {
  const repoRoot = path.resolve(options.repoRoot);
  const targetDir = path.resolve(options.worktreePath);

  // Check if worktree directory exists or is registered
  if (fs.existsSync(targetDir)) {
    // Unlink node_modules junction/symlink first to prevent deleting host node_modules
    const targetNodeModules = path.join(targetDir, "node_modules");
    try {
      if (fs.existsSync(targetNodeModules) && fs.lstatSync(targetNodeModules).isSymbolicLink()) {
        fs.unlinkSync(targetNodeModules);
      }
    } catch {}

    const args = ["worktree", "remove", targetDir];
    if (options.force !== false) {
      args.push("--force");
    }

    let removeRecordId: string | undefined;
    try {
      const reg = await getProcessSupervisor().registerProcess({
        component: "git_worktree",
        executable: "git",
        args,
        launchIntent: "headless",
        lifecycle: "ephemeral",
        cleanupPolicy: "caller_owned",
        workspaceRoot: repoRoot,
      });
      removeRecordId = reg.recordId;
    } catch {}

    const removeProc = execa("git", args, headlessOpts({ cwd: repoRoot, reject: false }));
    if (removeRecordId && removeProc.pid) {
      void getProcessSupervisor().recordProcessSpawn(removeRecordId, removeProc.pid).catch(() => {});
    }
    const removeRes = await removeProc;
    if (removeRecordId) {
      void getProcessSupervisor().recordProcessExit(removeRecordId, {
        exitCode: removeRes.exitCode ?? 0,
        signal: null,
        source: "cliBridgeWorktreeManager.removeIsolatedWorktree",
      }).catch(() => {});
    }

    // If directory still exists on disk, clean up with retry
    if (fs.existsSync(targetDir)) {
      try {
        fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // ignore directory removal errors
      }
    }
  }

  // Prune worktree metadata in git
  await execa("git", ["worktree", "prune"], headlessOpts({ cwd: repoRoot, reject: false }));

  // Delete branch if requested
  if (options.deleteBranch && options.branchName) {
    await execa("git", ["branch", "-D", options.branchName], headlessOpts({
      cwd: repoRoot,
      reject: false,
    }));
  }
}

/**
 * Inspects commit provenance and cleanliness of a worktree against its base SHA.
 */
export async function getWorktreeCommitProvenance(
  worktreePath: string,
  baseCommitSha?: string
): Promise<WorktreeCommitProvenance> {
  const targetDir = path.resolve(worktreePath);

  const [headRes, branchRes, statusRes] = await Promise.all([
    execa("git", ["rev-parse", "HEAD"], headlessOpts({ cwd: targetDir })),
    execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], headlessOpts({ cwd: targetDir, reject: false })),
    execa("git", ["status", "--porcelain"], headlessOpts({ cwd: targetDir, reject: false })),
  ]);

  const headSha = headRes.stdout.trim();
  const branchName = branchRes.stdout ? branchRes.stdout.trim() : "DETACHED";
  const isClean = statusRes.stdout.trim().length === 0;

  let commitCount = 0;
  const commitMessages: string[] = [];

  if (baseCommitSha) {
    const logRes = await execa("git", ["log", `${baseCommitSha}..HEAD`, "--oneline"], headlessOpts({
      cwd: targetDir,
      reject: false,
    }));
    if (logRes.exitCode === 0 && logRes.stdout.trim().length > 0) {
      const lines = logRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
      commitCount = lines.length;
      commitMessages.push(...lines);
    }
  }

  return {
    headSha,
    baseCommitSha: baseCommitSha || headSha,
    branchName,
    commitCount,
    commitMessages,
    isClean,
  };
}

export const inspectWorktreeProvenance = getWorktreeCommitProvenance;

/**
 * Verifies that the main repository is clean and unmutated.
 */
export async function verifyMainRepoCleanliness(repoRoot: string): Promise<{
  isClean: boolean;
  statusOutput: string;
}> {
  const res = await execa("git", ["status", "--porcelain"], headlessOpts({
    cwd: path.resolve(repoRoot),
    reject: false,
  }));

  return {
    isClean: res.stdout.trim().length === 0,
    statusOutput: res.stdout.trim(),
  };
}
