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
/** Get system prompt for a subagent type, with fallback to a generic prompt.
 * Also injects the installed agent skills list so subagents know which skills
 * exist and can read their SKILL.md files before executing tasks.
 * Uses dynamic import to avoid circular module dependencies.
 */
export declare function getSubagentSystemPrompt(typeName: string, basePrompt: string): Promise<string>;
//# sourceMappingURL=prompts.d.ts.map