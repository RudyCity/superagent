import { Conversation } from "./conversation.js";
import type { Tool, AgentTier, ViolationRecord } from "./tools.js";
import type { ToolCall, ToolResult } from "./conversation.js";
import { AsyncLocalStorage } from "async_hooks";
export declare function checkPlanStructure(content: string): boolean;
export declare const agentLocalStorage: AsyncLocalStorage<Agent>;
export type AgentEvent = {
    type: "text";
    content: string;
} | {
    type: "tool_start";
    toolCall: ToolCall;
    description: string;
} | {
    type: "tool_end";
    toolResult: ToolResult;
    description: string;
} | {
    type: "error";
    message: string;
} | {
    type: "done";
} | {
    type: "goal_done";
    goal: string;
    summary: string;
} | {
    type: "permission_required";
    toolCall: ToolCall;
    description: string;
} | {
    type: "illegal_operation";
    violation: ViolationRecord;
} | {
    type: "token_usage";
    promptTokens: number;
    completionTokens: number;
    durationMs?: number;
} | {
    type: "checkpoint_auto";
    name: string;
    id: string;
} | {
    type: "tool_progress";
    toolCallId: string;
    message: string;
};
export type PermissionHandler = (toolCall: ToolCall, description: string) => Promise<boolean | "session">;
export interface QuestionItem {
    question: string;
    options: string[];
    isMultiSelect?: boolean;
}
export type QuestionHandler = (question: string | QuestionItem[], options?: string[], isMultiSelect?: boolean, initialCheckedIndices?: number[]) => Promise<string | string[]>;
export declare class Agent {
    delegationDepth: number;
    /** Agent tier in the 3-tier hierarchy: master | superagent | subagent */
    tier: AgentTier;
    /** Whether the agent is running in multi-agent orchestrator mode */
    isMultiAgent: boolean;
    /** For superagents: absolute path to the isolated git worktree */
    worktreePath: string | null;
    /** For subagents: subagent type name (e.g. researcher, coder, reviewer) */
    subagentType?: string;
    workingDirectory: string;
    planState: "IDLE" | "PLANNING_PENDING" | "APPROVED";
    isSimpleTask: boolean;
    simpleTaskApproved: boolean;
    lastSpeed: number | null;
    goalMode: string | null;
    goalMaxIterations: number;
    wasRunningBeforeAbort: boolean;
    allowSessionOutOfBounds: boolean;
    allowSessionEnvAccess: boolean;
    allowSessionDangerous: boolean;
    workspaceCache: any;
    private workspaceCacheNeedsUpdate;
    disableWorkspaceDiscovery: boolean;
    private conversation;
    private customSystemPrompt?;
    /** Custom tool list for this agent (tier-specific). Undefined = use allTools. */
    private customTools?;
    private get config();
    onEvent: (event: AgentEvent) => void;
    private onPermission;
    private onQuestion;
    private abortController;
    private isRunning;
    private pendingMessage;
    private textLogBuffer;
    /** Flag set when completed tasks were just archived — used to inject system prompt hint */
    private tasksJustArchived;
    /** Number of tasks that were archived in the last sendMessage call */
    private archivedTaskCount;
    /** Timestamp of last auto-checkpoint (for cooldown) */
    private lastAutoCheckpointAt;
    /** Minimum interval between auto-checkpoints in ms */
    private static readonly AUTO_CHECKPOINT_COOLDOWN_MS;
    /** Cached preloaded guidelines (agents.md + mandatory skills) — built once per session */
    private cachedGuidelinesText;
    /** Keys of skills that were successfully preloaded into guidelinesText */
    private preloadedSkillKeys;
    approvePlan(): void;
    /**
     * Build and cache the guidelines text (agents.md + mandatory preloaded skills).
     * Called once per Agent instance lifetime — subsequent calls return the cache.
     * Each SKILL.md is trimmed to MAX_SKILL_LINES lines to reduce token cost while
     * preserving the most important instructions at the top of each file.
     */
    private static readonly MAX_SKILL_LINES;
    private static readonly MANDATORY_SKILLS;
    private static readonly MASTER_ONLY_SKILLS;
    /**
     * Trim a SKILL.md file's content to MAX_SKILL_LINES lines while always
     * preserving the YAML frontmatter (--- delimited block at the top, if any).
     * The line cap applies only to the body — critical metadata is never cut off.
     */
    private static trimSkillContent;
    private buildGuidelinesText;
    /**
     * Mark already-preloaded skill entries in the INSTALLED AGENT SKILLS list.
     * This prevents the AI from wasting tokens re-reading skill files whose content
     * is already injected earlier in the same system prompt.
     */
    private markPreloadedSkillsInList;
    /**
     * Answer a question on behalf of a Subagent/Superagent using the Master's
     * LLM and context (implementation plan + recent conversation). Does NOT
     * pollute Master's conversation history — uses a standalone generateText call.
     *
     * Returns the selected option string.
     */
    answerQuestionAsMaster(question: string, options: string[], context: {
        source: string;
        role?: string;
        task?: string;
        branch?: string;
        typeName?: string;
    }): Promise<string>;
    private flushTextLogBuffer;
    constructor(onEvent: (event: AgentEvent) => void, onPermission: PermissionHandler, onQuestion: QuestionHandler, customSystemPrompt?: string, customTools?: Tool[], workingDirectory?: string);
    private initContextManager;
    /**
     * Emit a text event into the live UI stream.
     * Used by tools that need to show progress/output while executing.
     */
    emitToolLog(msg: string): void;
    writeToLogFile(level: string, message: string): void;
    /**
     * Emit a structured illegal_operation event when a child agent's operation
     * is blocked. This propagates to the parent agent's event handler in
     * multi-agent mode so the parent can track violations and take action.
     */
    private emitViolation;
    private currentHistoryFilePath;
    private contextManagerInitFailed;
    getPlanFilePath(): string;
    getTaskFilePath(): string;
    getWalkthroughFilePath(): string;
    getTaskHistoryFilePath(): string;
    private resolveHistoryFilePath;
    getCurrentHistoryFilePath(): string;
    loadHistory(autoResume?: boolean | string): Promise<void>;
    loadHistoryFromPath(filePath: string): Promise<void>;
    saveHistory(): Promise<void>;
    private getModel;
    sendMessage(userInput: string | import("./conversation.js").MessageContent): Promise<void>;
    private runAgentLoop;
    private modelSupportsVision;
    private buildMessages;
    compactHistoryIfNeeded(signal?: AbortSignal): Promise<void>;
    private ensureContextManager;
    private contextManagerCompact;
    private legacyCompactHistory;
    private summarizeMessages;
    private delayWithCountdown;
    abort(): void;
    clearHistory(): Promise<void>;
    /**
     * Reset all internal transient state (buffers, flags) without touching
     * conversation history or file paths. Called by /new to guarantee a
     * completely clean slate in both single-agent and multi-agent modes.
     */
    /**
     * Creates an automatic checkpoint if cooldown has elapsed.
     * Called on every user message and before destructive tool operations.
     * Non-blocking — runs in background and swallows errors.
     */
    private autoCheckpoint;
    resetInternalState(): void;
    private prepopulateTencentDBMemoryContext;
    private syncConversationToTencentDB;
    getHistory(): Conversation;
    getContextManager(): import("./context/ContextManager.js").ContextManager | null;
    isAgentRunning(): boolean;
}
//# sourceMappingURL=agent.d.ts.map