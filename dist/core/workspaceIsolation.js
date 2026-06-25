import fs from "fs";
import path from "path";
import { execa } from "execa";
import { addTrustedDirectory, ensureDirectoryTrusted } from "./config/jsonConfig.js";
/**
 * Ensures the project-local .gitignore ignores the .worktrees directory
 */
export function ensureGitIgnore() {
    const gitignorePath = path.join(process.cwd(), ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, ".worktrees/\n", "utf-8");
        return;
    }
    const content = fs.readFileSync(gitignorePath, "utf-8");
    const lines = content.split(/\r?\n/);
    const hasIgnore = lines.some((line) => line.trim() === ".worktrees" || line.trim() === ".worktrees/");
    if (!hasIgnore) {
        fs.appendFileSync(gitignorePath, "\n.worktrees/\n", "utf-8");
    }
}
/**
 * Prunes orphaned worktrees from git metadata
 */
export async function pruneWorktrees() {
    try {
        await execa("git", ["worktree", "prune"], { cwd: process.cwd() });
    }
    catch (err) {
        // Ignore error if git is not initialized
    }
}
/**
 * Sets up an isolated workspace for a given session by creating a Git Worktree
 * and symlinking the root node_modules to avoid slow package installation.
 */
export async function setupWorkspaceForSession(sessionId, branchSuffix) {
    ensureGitIgnore();
    await pruneWorktrees();
    const branchName = `multi-agent/${sessionId}-${branchSuffix}`;
    const worktreeBaseDir = path.join(process.cwd(), ".worktrees");
    if (!fs.existsSync(worktreeBaseDir)) {
        fs.mkdirSync(worktreeBaseDir, { recursive: true });
    }
    const workspacePath = path.join(worktreeBaseDir, sessionId);
    // 1. Create the Git Worktree
    // We check out a new branch
    await execa("git", ["worktree", "add", workspacePath, "-b", branchName], {
        cwd: process.cwd(),
    });
    // 1.5 Trust the directory and configure Git safe.directory to prevent ownership issues
    addTrustedDirectory(workspacePath);
    await ensureDirectoryTrusted(workspacePath);
    // 2. Link node_modules to make setup instant
    const rootNodeModules = path.join(process.cwd(), "node_modules");
    const targetNodeModules = path.join(workspacePath, "node_modules");
    if (fs.existsSync(rootNodeModules) && !fs.existsSync(targetNodeModules)) {
        // Under Windows, we use junction to avoid admin privilege requirements
        const type = process.platform === "win32" ? "junction" : "dir";
        await fs.promises.symlink(rootNodeModules, targetNodeModules, type);
    }
    return { workspacePath, branchName };
}
/**
 * Cleans up the isolated workspace and branch created for the session
 */
export async function cleanupWorkspaceForSession(sessionId, branchName) {
    const workspacePath = path.join(process.cwd(), ".worktrees", sessionId);
    if (fs.existsSync(workspacePath)) {
        try {
            // Remove worktree
            await execa("git", ["worktree", "remove", workspacePath, "--force"], {
                cwd: process.cwd(),
            });
        }
        catch (err) {
            // Ignore cleanup error if already removed
        }
    }
    try {
        // Delete the branch
        await execa("git", ["branch", "-D", branchName], {
            cwd: process.cwd(),
        });
    }
    catch (err) {
        // Ignore branch deletion errors
    }
}
//# sourceMappingURL=workspaceIsolation.js.map