import type { ToolCall, ToolResult } from "./conversation.js";
export declare const MODIFYING_TOOLS: string[];
export declare function isDangerousCommand(command: string): boolean;
/**
 * Checks whether a file path is inside the given worktree directory.
 */
export declare function isPathInWorktree(filePath: string, worktreePath: string): boolean;
/**
 * Returns true if a Superagent's tool call targets a file OUTSIDE its worktree.
 * Checked for both modifying and reading/search tools.
 */
export declare function isSuperagentOutOfBounds(toolCall: {
    name: string;
    args: Record<string, unknown>;
}, worktreePath: string): boolean;
export declare function getToolDescription(toolCall: ToolCall): string;
export declare function executeToolCall(toolCall: ToolCall, cwd: string, signal?: AbortSignal): Promise<ToolResult>;
//# sourceMappingURL=permissions.d.ts.map