import path from "path";
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
