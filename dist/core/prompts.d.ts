/**
 * prompts.ts — Tier-specific system prompts for the 3-tier multi-agent system.
 *
 * Master Agent  (depth 0): orchestrator, delegates all implementation to Superagents
 * Superagent    (depth 1): feature developer isolated in a git worktree
 * Subagent      (depth 2): specialized worker with a restricted role
 */
export declare const MASTER_AGENT_SYSTEM_PROMPT: string;
export declare const SUPERAGENT_SYSTEM_PROMPT: (role: string, branch: string, worktreePath: string) => string;
export declare const SUBAGENT_SYSTEM_PROMPTS: Record<string, string>;
/** Get system prompt for a subagent type, with fallback to a generic prompt */
export declare function getSubagentSystemPrompt(typeName: string, basePrompt: string): string;
//# sourceMappingURL=prompts.d.ts.map