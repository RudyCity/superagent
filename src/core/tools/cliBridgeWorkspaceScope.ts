/** Canonical, fail-closed filesystem boundary for CLI Bridge delegations.
 * The parent workspace is already resolved by the invoking agent/MCP authorization layer.
 * An explicit child cwd may narrow that boundary, but must never broaden it.
 */
import fs from "node:fs";
import path from "node:path";

export function canonicalCliWorkspace(directory: string): string {
  const resolved = fs.realpathSync(path.resolve(directory));
  if (!fs.statSync(resolved).isDirectory()) throw new Error("CLI Bridge workspace is not a directory.");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function resolveAuthorizedDelegateCwd(callerWorkspace: string, requestedCwd?: string): string {
  const owner = canonicalCliWorkspace(callerWorkspace);
  const child = canonicalCliWorkspace(requestedCwd ? path.resolve(callerWorkspace, requestedCwd) : callerWorkspace);
  const relative = path.relative(owner, child);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("CLI Bridge delegation cwd is outside the authorized workspace.");
  }
  return child;
}

export function delegateJobVisibleToWorkspace(
  job: { cwd: string; workspaceRoot?: string },
  callerWorkspace: string,
): boolean {
  try {
    // Legacy persisted records are scoped to their original cwd, never globally visible.
    return canonicalCliWorkspace(job.workspaceRoot || job.cwd) === canonicalCliWorkspace(callerWorkspace);
  } catch {
    return false;
  }
}


/** Session actions may inspect only sessions whose existing cwd is inside the invoking workspace. */
export function cliSessionVisibleToWorkspace(session: { cwd: string }, callerWorkspace: string): boolean {
  try {
    resolveAuthorizedDelegateCwd(callerWorkspace, session.cwd);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a prospective file path, including symlinked parents, without requiring the file to exist. */
export function cliArtifactPathVisibleToWorkspace(filePath: string, callerWorkspace: string): boolean {
  try {
    let ancestor = path.resolve(filePath);
    while (true) {
      try {
        // lstat identifies dangling symlink components too. Treat unresolved
        // targets as denied rather than silently walking past the symlink.
        fs.lstatSync(ancestor);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
    }
    // Resolve the existing file itself or its nearest parent; this catches symlink escapes.
    const realPath = fs.realpathSync(ancestor);
    const realAncestor = canonicalCliWorkspace(fs.statSync(realPath).isDirectory() ? realPath : path.dirname(realPath));
    const root = canonicalCliWorkspace(callerWorkspace);
    const relative = path.relative(root, realAncestor);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}
