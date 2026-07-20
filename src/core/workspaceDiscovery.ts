import fs from "fs";
import path from "path";
import crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import { getRootConfigDir, getWorkspaceId } from "./config/paths.js";

const execAsync = promisify(exec);

export interface WorkspaceCache {
  workspaceDir: string;
  fingerprint: string;
  fileList: string[];
  files: Record<string, { size: number; mtimeMs: number }>;
  agentsMd?: string;
  packageJson?: any;
  lastScanTime: number;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".worktrees",
  "dist",
  "vendor",
  ".agents",
  ".superagent-r",
  ".next",
  ".svelte-kit",
  ".tauri",
  "build",
  ".docusaurus",
  "coverage",
  ".nyc_output",
]);

/**
 * Recursively walks a directory to find all non-ignored files with their sizes and modification times.
 */
async function walkDirectory(
  dir: string,
  baseDir: string,
  results: { path: string; size: number; mtimeMs: number }[] = []
): Promise<{ path: string; size: number; mtimeMs: number }[]> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // If directory cannot be read, return empty
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      await walkDirectory(fullPath, baseDir, results);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.promises.stat(fullPath);
        results.push({
          path: relPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs || stat.mtime.getTime(),
        });
      } catch {
        // Ignore files that cannot be statted (e.g. locked files)
      }
    }
  }
  return results;
}

/**
 * Checks if a directory is a Git repository.
 */
async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await execAsync("git rev-parse --is-inside-work-tree", { cwd: dir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists all tracked and untracked files in the Git repository (excluding standard ignores).
 */
async function getGitFiles(dir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git ls-files --cached --others --exclude-standard", {
      cwd: dir,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * Calculates a fast fingerprint MD5 hash of the workspace files (sorted paths + sizes + mtimes).
 */
export async function getWorkspaceFingerprint(dir: string): Promise<{
  fingerprint: string;
  fileList: string[];
  files: Record<string, { size: number; mtimeMs: number }>;
}> {
  const resolvedDir = path.resolve(dir);
  
  let fileList: string[] = [];
  if (await isGitRepo(resolvedDir)) {
    const gitFiles = await getGitFiles(resolvedDir);
    fileList = gitFiles.filter((f) => {
      const parts = f.split("/");
      return !parts.some((part) => IGNORED_DIRS.has(part));
    });
  } else {
    const rawFiles = await walkDirectory(resolvedDir, resolvedDir);
    fileList = rawFiles.map((f) => f.path);
  }

  // Sort files deterministically by path
  fileList.sort((a, b) => a.localeCompare(b));

  const files: Record<string, { size: number; mtimeMs: number }> = {};
  
  // Stat files in batches of 100 to prevent event loop lag and open fd limits
  const BATCH_SIZE = 100;
  for (let i = 0; i < fileList.length; i += BATCH_SIZE) {
    const batch = fileList.slice(i, i + BATCH_SIZE);
    const stats = await Promise.all(
      batch.map(async (f) => {
        try {
          const fullPath = path.resolve(resolvedDir, f);
          const stat = await fs.promises.stat(fullPath);
          return {
            path: f,
            size: stat.size,
            mtimeMs: stat.mtimeMs || stat.mtime.getTime(),
          };
        } catch {
          return null;
        }
      })
    );

    for (const s of stats) {
      if (s) {
        files[s.path] = { size: s.size, mtimeMs: s.mtimeMs };
      }
    }
  }

  // Generate fingerprint string from files that were successfully statted
  let fingerprintString = "";
  for (const f of fileList) {
    const meta = files[f];
    if (meta) {
      fingerprintString += `${f}:${meta.size}:${meta.mtimeMs}\n`;
    }
  }

  const fingerprint = crypto.createHash("md5").update(fingerprintString).digest("hex");
  const finalFileList = Object.keys(files).sort((a, b) => a.localeCompare(b));
  return { fingerprint, fileList: finalFileList, files };
}

/**
 * Resolves the cache file path for the given workspace directory.
 */
export function getWorkspaceCachePath(dir: string): string {
  const root = getRootConfigDir();
  const dirHash = getWorkspaceId(dir);
  const cacheDir = path.join(root, "workspace-caches");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return path.join(cacheDir, `${dirHash}.json`);
}

/**
 * Discovers the workspace: compares current fingerprint with the cache to determine
 * whether a full/partial update is required. Returns isIdentical and the cache.
 */
export async function discoverWorkspace(
  dir: string
): Promise<{ isIdentical: boolean; cache: WorkspaceCache }> {
  const resolvedDir = path.resolve(dir);
  const cachePath = getWorkspaceCachePath(resolvedDir);

  const current = await getWorkspaceFingerprint(resolvedDir);

  let cached: WorkspaceCache | null = null;
  if (fs.existsSync(cachePath)) {
    try {
      cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    } catch {
      // Ignore reading errors, cache will be overwritten
    }
  }

  if (cached && cached.fingerprint === current.fingerprint) {
    return { isIdentical: true, cache: cached };
  }

  // Workspace has changed or no cache exists. Read agents.md and package.json to populate context.
  const packageJsonPath = path.join(resolvedDir, "package.json");
  const agentsMdPath = path.join(resolvedDir, "agents.md");

  let agentsMd: string | undefined = undefined;
  if (fs.existsSync(agentsMdPath)) {
    try {
      agentsMd = fs.readFileSync(agentsMdPath, "utf-8");
    } catch {}
  }

  let packageJson: any = undefined;
  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    } catch {}
  }

  const newCache: WorkspaceCache = {
    workspaceDir: resolvedDir,
    fingerprint: current.fingerprint,
    fileList: current.fileList,
    files: current.files,
    agentsMd,
    packageJson,
    lastScanTime: Date.now(),
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(newCache, null, 2), "utf-8");
  } catch {}

  return { isIdentical: false, cache: newCache };
}

/**
 * Injects a formatted overview of the workspace files and main configs into the system prompt.
 */
export function injectWorkspaceOverview(systemPrompt: string, cache: WorkspaceCache): string {
  let overview = `\n\n==================================================\n`;

  if (cache.agentsMd) {
    overview += `📄 PROJECT SPECIFICATIONS (agents.md):\n${cache.agentsMd}\n`;
  }

  if (cache.packageJson && cache.packageJson.name) {
    overview += `\n📦 PROJECT METADATA (package.json):\n- Name: ${cache.packageJson.name}\n- Version: ${cache.packageJson.version || "unknown"}\n`;
    if (cache.packageJson.dependencies) {
      overview += `- Dependencies: ${Object.keys(cache.packageJson.dependencies).join(", ")}\n`;
    }
  }
  overview += `==================================================\n`;

  return systemPrompt + overview;
}
