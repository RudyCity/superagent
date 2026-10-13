import path from "path";

/**
 * Canonical workspace context for MCP handlers.
 *
 * Resolve the target exactly once at the tool boundary and pass this context
 * through downstream calls. Do not use process.chdir() to select a request's
 * workspace: it is process-global and unsafe for concurrent MCP requests.
 */
export interface McpWorkspaceContext {
  path: string;
  explicit: boolean;
}

export function isRemoteWorkspaceTarget(workspacePath: string): boolean {
  return /^(?:ssh:|ssh:\/\/|chain:)/i.test(workspacePath);
}

export function resolveMcpWorkspace(workspaceArg?: unknown): McpWorkspaceContext {
  if (typeof workspaceArg === "string" && workspaceArg.trim()) {
    const raw = workspaceArg.trim();
    return {
      path: isRemoteWorkspaceTarget(raw) ? raw : path.resolve(raw),
      explicit: true,
    };
  }

  return { path: process.cwd(), explicit: false };
}

export function isServerRejection(res: { status?: number }): boolean {
  return res.status === 400 || res.status === 403 || res.status === 404 || res.status === 409;
}
