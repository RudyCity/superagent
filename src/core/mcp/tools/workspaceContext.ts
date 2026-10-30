import path from "path";
import fs from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Canonical async-local workspace context for MCP handlers. Never use
 * process.chdir() to select a request workspace: it is process-global.
 */
export interface McpWorkspaceContext {
  path: string;
  explicit: boolean;
}

const workspaceStorage = new AsyncLocalStorage<string>();

export function runWithMcpWorkspace<T>(workspacePath: string, callback: () => T): T {
  return workspaceStorage.run(workspacePath, callback);
}

export function getMcpWorkspacePath(): string {
  return workspaceStorage.getStore() || process.cwd();
}

export function isRemoteWorkspaceTarget(workspacePath: string): boolean {
  return /^(?:ssh:|ssh:\/\/|chain:)/i.test(workspacePath);
}

/**
 * Resolve an explicit child path beneath an already-authorized local workspace.
 * This preserves child cwd/worktree semantics after MCP project routing while
 * refusing lexical and symlink-parent escapes from the authorized workspace.
 */
export function resolveMcpChildWorkspacePath(workspacePath: string, requestedPath: string): string {
  if (isRemoteWorkspaceTarget(workspacePath)) {
    throw new Error("Child filesystem paths are unavailable for remote MCP workspace targets.");
  }
  const raw = requestedPath.trim();
  if (!raw || isRemoteWorkspaceTarget(raw)) {
    throw new Error("MCP child workspace path must be a nonempty local path.");
  }

  const root = fs.realpathSync(path.resolve(workspacePath));
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const canonicalAncestor = fs.realpathSync(ancestor);
  const canonicalCandidate = path.resolve(canonicalAncestor, path.relative(ancestor, candidate));
  const relative = path.relative(root, canonicalCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("MCP child workspace path is outside the authorized workspace.");
  }
  return canonicalCandidate;
}

export function resolveMcpWorkspace(workspaceArg?: unknown): McpWorkspaceContext {
  if (typeof workspaceArg === "string" && workspaceArg.trim()) {
    const raw = workspaceArg.trim();
    const base = getMcpWorkspacePath();
    const localBase = isRemoteWorkspaceTarget(base) ? process.cwd() : base;
    return {
      path: isRemoteWorkspaceTarget(raw)
        ? raw
        : path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(localBase, raw),
      explicit: true,
    };
  }

  return { path: getMcpWorkspacePath(), explicit: false };
}

export function isServerRejection(res: { status?: number }): boolean {
  return res.status === 400 || res.status === 403 || res.status === 404 || res.status === 409;
}
