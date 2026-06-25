/**
 * Ensures the project-local .gitignore ignores the .worktrees directory
 */
export declare function ensureGitIgnore(): void;
/**
 * Prunes orphaned worktrees from git metadata
 */
export declare function pruneWorktrees(): Promise<void>;
/**
 * Sets up an isolated workspace for a given session by creating a Git Worktree
 * and symlinking the root node_modules to avoid slow package installation.
 */
export declare function setupWorkspaceForSession(sessionId: string, branchSuffix: string): Promise<{
    workspacePath: string;
    branchName: string;
}>;
/**
 * Cleans up the isolated workspace and branch created for the session
 */
export declare function cleanupWorkspaceForSession(sessionId: string, branchName: string): Promise<void>;
//# sourceMappingURL=workspaceIsolation.d.ts.map