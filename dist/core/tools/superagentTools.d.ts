/**
 * superagentTools.ts — Tools for the Master Agent to orchestrate Superagents.
 *
 * Tools:
 *   invoke_superagent  — spawn a Superagent in an isolated git worktree
 *   await_superagents  — poll until all active Superagents finish
 *   merge_superagents  — merge all completed Superagent branches via MasterAgent
 */
import { Tool } from "./types.js";
export declare const invokeSuperagentTool: Tool;
export declare const awaitSuperagentsTool: Tool;
export declare const mergeSuperagentsTool: Tool;
export declare const manageSuperagentsTool: Tool;
export declare const defineSuperagentTool: Tool;
export declare const sendMessageToSuperagentTool: Tool;
//# sourceMappingURL=superagentTools.d.ts.map