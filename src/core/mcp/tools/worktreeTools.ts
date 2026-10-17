/** Workspace-scoped Git feature worktree management. */
import fs from "node:fs";
import { McpToolResult } from "../types.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import { assertPathWithinProject } from "../../project/projectRouter.js";
import { loadRegistry, removeEntries } from "../../tools/superagentRegistry.js";

export async function handleManageWorktrees(args: any): Promise<McpToolResult> {
  const action = String(args.action || "list");
  const registry = loadRegistry();
  const targetWorkspace = String(args.workspace || getMcpWorkspacePath());
  if (/^(?:ssh:|chain:)/i.test(targetWorkspace)) {
    return { content: [{ type: "text", text: "Feature worktree management requires a local project workspace." }], isError: true };
  }

  const inWorkspace = (worktreePath: string): boolean => {
    try {
      assertPathWithinProject(worktreePath, targetWorkspace);
      return true;
    } catch {
      return false;
    }
  };
  const scopedRegistry = registry.filter((entry) => inWorkspace(entry.worktreePath));

  if (action === "list") {
    if (scopedRegistry.length === 0) {
      return { content: [{ type: "text", text: "No feature worktrees registered within the selected project workspace." }] };
    }
    const lines = ["=== Registered Git Feature Worktrees ==="];
    for (const r of scopedRegistry) {
      const exists = fs.existsSync(r.worktreePath);
      lines.push(`- ID: ${r.id} | Role: ${r.role} | Branch: ${r.branch} | Status: ${r.status}`);
      lines.push(`  Path: ${r.worktreePath} [${exists ? "Active on Disk" : "Removed"}]`);
    }
    return { content: [{ type: "text", text: lines.join(String.fromCharCode(10)) }] };
  }

  if (action === "remove" || action === "delete") {
    const id = String(args.id || args.superagentId || "");
    if (!id) {
      return { content: [{ type: "text", text: "Error: 'id' is required to remove a worktree." }], isError: true };
    }
    const entry = scopedRegistry.find((r) => r.id === id);
    if (entry) {
      try {
        if (fs.existsSync(entry.worktreePath)) {
          fs.rmSync(entry.worktreePath, { recursive: true, force: true });
        }
        removeEntries([id]);
        return { content: [{ type: "text", text: `Successfully removed worktree for Superagent '${id}' (${entry.branch}).` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error removing worktree: ${err.message}` }], isError: true };
      }
    }
    const existsOutsideScope = registry.some((r) => r.id === id);
    return {
      content: [{ type: "text", text: existsOutsideScope
        ? `Error: Worktree '${id}' is outside the selected project workspace and was not removed.`
        : `No worktree entry found with ID: ${id}` }],
      isError: true,
    };
  }

  return { content: [{ type: "text", text: `Unknown worktree action: ${action}` }], isError: true };
}
