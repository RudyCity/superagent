import path from "path";
import { execa } from "execa";
import { getWorkspaceId } from "./paths.js";
import { saveWorkspaceToDb, getWorkspacesFromDb, getWorkspaceFromDb, deleteWorkspaceFromDb } from "../storage/historyDb.js";

export function getTrustedDirectories(): string[] {
  const workspaces = getWorkspacesFromDb();
  return workspaces.filter(ws => ws.isTrusted).map(ws => ws.path);
}

export function addTrustedDirectory(dirPath: string, name?: string): void {
  const resolvedPath = dirPath.startsWith("ssh:") ? dirPath : path.resolve(dirPath);
  const id = getWorkspaceId(resolvedPath);
  saveWorkspaceToDb({
    id,
    path: resolvedPath,
    name,
    isTrusted: true
  });
}

export function removeTrustedDirectory(dirPath: string): void {
  const resolvedPath = dirPath.startsWith("ssh:") ? dirPath : path.resolve(dirPath);
  deleteWorkspaceFromDb(resolvedPath);
}

export function isDirectoryTrusted(dirPath: string): boolean {
  const resolvedPath = path.resolve(dirPath);
  const id = getWorkspaceId(resolvedPath);
  const ws = getWorkspaceFromDb(id);
  return ws ? ws.isTrusted : false;
}

/**
 * Ensure a directory is added to Git's global safe.directory configuration
 * to prevent dubious ownership issues on Windows/multi-user systems.
 */
export async function ensureDirectoryTrusted(dirPath: string, cwd: string = process.cwd()): Promise<void> {
  try {
    const resolvedPath = path.resolve(dirPath);
    // Normalize path to use forward slashes for Git config compatibility on Windows
    const normalizedPath = resolvedPath.replace(/\\/g, "/");

    // Check if it's already in safe.directory to avoid duplicates
    const { stdout } = await execa("git", ["config", "--global", "--get-all", "safe.directory"], { cwd, reject: false });
    const safeDirectories = stdout.split(/\r?\n/).map(d => d.trim().replace(/\\/g, "/"));

    if (!safeDirectories.includes(normalizedPath)) {
      await execa("git", ["config", "--global", "--add", "safe.directory", normalizedPath], { cwd });
    }
  } catch (err) {
    // Ignore config errors
  }
}
