import path from "path";
import { getRootConfigDir } from "../config/paths.js";
import { workspaceMode } from "../ssh/workspaceMode.js";

/**
 * Normalize a file path to fix common LLM path construction errors.
 * Handles:
 *   - Double drive letter prefix: D:\d\backup... → D:\backup...
 *   - Git Bash style paths: /d/backup... → D:\backup... (on Windows)
 */
export function normalizePath(filePath: string): string {
  // Fix double drive letter: e.g. "D:\d\backup..." or "C:\c\Users..."
  const doubleDriveMatch = filePath.match(/^([A-Za-z]):\\([a-z])\\(.*)$/);
  if (doubleDriveMatch) {
    const drive = doubleDriveMatch[1].toUpperCase();
    const innerDrive = doubleDriveMatch[2].toLowerCase();
    if (drive.toLowerCase() === innerDrive) {
      return `${drive}:\\${doubleDriveMatch[3]}`;
    }
  }
  return filePath;
}

/**
 * Synchronous SSH path resolver with boundary enforcement.
 * Returns the resolved POSIX path if SSH mode is active, or null if not.
 * Throws on boundary violations (paths escaping remoteCwd).
 */
function tryResolveSshPath(raw: string, cwd: string): string | null {
  if (!workspaceMode.isSsh()) return null;

  const sshCfg = workspaceMode.getConfig();
  const remoteCwd = (sshCfg?.remoteCwd || cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
  let posix = raw.replace(/\\/g, "/");
  if (!posix.startsWith("/")) {
    posix = `${remoteCwd}/${posix.replace(/^\/+/, "")}`;
  }
  posix = posix.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";

  // Resolve '..' segments so traversal escapes are detected by boundary check below.
  const parts = posix.split("/").reduce<string[]>((acc, seg) => {
    if (seg === "..") acc.pop();
    else if (seg !== "" && seg !== ".") acc.push(seg);
    return acc;
  }, []);
  posix = "/" + parts.join("/");

  // Boundary enforcement: reject paths that escape remoteCwd.
  const normalizedBase = "/" + remoteCwd.split("/").filter((p: string) => p && p !== ".").join("/");
  if (normalizedBase !== "/" && posix !== normalizedBase && !posix.startsWith(normalizedBase + "/")) {
    throw new Error('Path "' + raw + '" violates SSH workspace boundary. Operations must remain within "' + remoteCwd + '". To access external files, ask for user permission via ask_question or copy the file into the workspace directory.');
  }
  return posix;
}

/**
 * Resolve the file path from tool args, accepting common LLM aliases:
 *   filePath, file_path, TargetFile, path (for file-targeting tools)
 * Returns the resolved absolute path, or undefined if no valid path was provided.
 *
 * NOTE: This function is synchronous and cannot use dynamic `import()`.
 * The SSH workspace mode check is handled by a synchronous helper that
 * avoids the ESM `require()` incompatibility. If SSH mode is active,
 * the SSH path resolution is performed inline; otherwise, local resolution
 * proceeds normally.
 */
export function resolveFilePathFromArgs(args: Record<string, unknown>, cwd: string): string | undefined {
  const raw = (args.filePath ?? args.file_path ?? args.path ?? args.TargetFile ?? args.targetFile ?? args.target_file ?? args.file) as string | undefined;
  if (!raw || typeof raw !== "string" || raw.trim() === "") return undefined;

  // SSH routing: resolve to POSIX path under remoteCwd with boundary enforcement.
  // Use synchronous workspaceMode access — the module is already loaded by this point
  // in the application lifecycle (tools are registered after workspace init).
  const sshResult = tryResolveSshPath(raw, cwd);
  if (sshResult !== null) return sshResult;

  const clean = (p: string) => p.split(String.fromCharCode(92)).join('/').toLowerCase().replace(/\/$/, '');
  const resolved = clean(normalizePath(path.resolve(cwd, raw)));
  const workspaceRoot = clean(normalizePath(path.resolve(process.cwd())));
  const testRoot = clean(normalizePath(path.resolve(cwd)));
  const rootConfigDir = clean(normalizePath(getRootConfigDir()));
  const allowedRoots = [workspaceRoot, testRoot, rootConfigDir];
  const isAllowed = allowedRoots.some(root => resolved === root || resolved.startsWith(root + "/")) || resolved.endsWith("_walkthrough.md");
  if (!isAllowed) {
    throw new Error('Path "' + raw + '" violates workspace boundary. Operations must remain within "' + workspaceRoot + '". To read external files, ask for user permission via ask_question or copy the file into the workspace directory.');
  }
  return normalizePath(path.resolve(cwd, raw));
}

export function getImageMimeType(ext: string): string | null {
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tiff": "image/tiff",
    ".tif": "image/tiff",
  };
  return map[ext.toLowerCase()] || null;
}