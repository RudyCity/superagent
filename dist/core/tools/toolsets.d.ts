/**
 * toolsets.ts — Per-tier tool definitions for the 3-tier multi-agent system.
 *
 * Master Agent  (depth 0): orchestration only — no direct coding
 * Superagent    (depth 1): full dev toolset, scoped to own worktree
 * Subagent      (depth 2): restricted toolset per specialization type
 */
import { Tool } from "./types.js";
export declare const masterToolset: Tool[];
export declare const superagentToolset: Tool[];
export declare const subagentToolsets: Record<string, Tool[]>;
/** Fallback toolset for unrecognized subagent types */
export declare const defaultSubagentToolset: Tool[];
//# sourceMappingURL=toolsets.d.ts.map