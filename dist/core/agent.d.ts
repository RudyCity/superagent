import { Conversation } from "./conversation.js";
import type { Tool, AgentTier, ViolationRecord } from "./tools.js";
import type { ToolCall, ToolResult } from "./conversation.js";
import { AsyncLocalStorage } from "async_hooks";
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
};
export type PermissionHandler = (toolCall: ToolCall, description: string) => Promise<boolean>;
export type QuestionHandler = (question: string, options: string[], isMultiSelect?: boolean) => Promise<string>;
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
    lastSpeed: number | null;
    goalMode: string | null;
    goalMaxIterations: number;
    wasRunningBeforeAbort: boolean;
    private conversation;
    private customSystemPrompt?;
    /** Custom tool list for this agent (tier-specific). Undefined = use allTools. */
    private customTools?;
    private get config();
    private onEvent;
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
    approvePlan(): void;
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
    sendMessage(userInput: string): Promise<void>;
    private runAgentLoop;
    private buildMessages;
    compactHistoryIfNeeded(): Promise<void>;
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
    getHistory(): Conversation;
    getContextManager(): import("./context/ContextManager.js").ContextManager | null;
    isAgentRunning(): boolean;
}
//# sourceMappingURL=agent.d.ts.map