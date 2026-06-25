import { Message } from "../conversation.js";
import { TokenTracker, TokenBreakdown } from "./TokenTracker.js";
import { CompactionStrategy, CompactionResult } from "./CompactionStrategy.js";
import { SemanticAnalyzer } from "./SemanticAnalyzer.js";
export type ContextState = "IDLE" | "CHECKING" | "COMPACTING" | "VALIDATING" | "FAILED" | "RECOVERING";
export interface ContextManagerConfig {
    model: string;
    contextWindowLimit: number;
    historyFilePath?: string;
    llmModel?: any;
    abortSignal?: AbortSignal;
}
export interface CompactionDecision {
    shouldCompact: boolean;
    reason: string;
    urgency?: "normal" | "critical";
    recommendedStrategy?: CompactionStrategy;
}
/** Metadata about the agent that created/pinned the message */
export interface AgentTag {
    tier: string;
    subagentType?: string;
    worktreePath?: string;
    workingDirectory?: string;
    sessionLabel?: string;
}
/** Full pinned message data — stores real content without truncation */
export interface PinnedMessage {
    id: string;
    role: string;
    content: string;
    timestamp: number;
    pinnedAt: number;
    originalIndex: number;
    agentTag?: AgentTag;
    toolCalls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
    }>;
    toolResults?: Array<{
        toolCallId: string;
        name: string;
        result: string;
        isError?: boolean;
    }>;
    tag?: string;
}
export declare class ContextManager {
    private state;
    private tokenTracker;
    private strategies;
    private semanticAnalyzer;
    private history;
    private eventEmitter;
    private config;
    private pinnedMessages;
    constructor(config: ContextManagerConfig);
    setLLMModel(model: any, abortSignal?: AbortSignal): void;
    shouldCompact(messages: Message[]): CompactionDecision;
    compact(messages: Message[], strategy?: CompactionStrategy, abortSignal?: AbortSignal): Promise<CompactionResult>;
    getState(): ContextState;
    on(event: "compaction:start" | "compaction:complete" | "compaction:fail", handler: (...args: any[]) => void): void;
    off(event: "compaction:start" | "compaction:complete" | "compaction:fail", handler: (...args: any[]) => void): void;
    setThreshold(threshold: number | "auto"): void;
    setModel(model: string): void;
    addPinnedMessage(messageId: string, data?: Partial<PinnedMessage>): void;
    removePinnedMessage(messageId: string): void;
    /** Backward-compatible: returns just the set of pinned message IDs */
    getPinnedMessages(): Set<string>;
    /** Returns full pinned message data as a Map */
    getPinnedMessagesFull(): Map<string, PinnedMessage>;
    /** Get a single pinned message by ID */
    getPinnedMessage(messageId: string): PinnedMessage | undefined;
    /** Update tag/label on a pinned message */
    setPinnedMessageTag(messageId: string, tag: string): boolean;
    /** Restore pinned messages from serialized data (for session restore) */
    restorePinnedMessages(data: PinnedMessage[]): void;
    /** Serialize pinned messages for persistence */
    serializePinnedMessages(): PinnedMessage[];
    getHistory(): import("./CompactionHistory.js").CompactionEvent[];
    getTokenTracker(): TokenTracker;
    getSemanticAnalyzer(): SemanticAnalyzer;
    estimateTokensForAll(messages: Message[]): TokenBreakdown;
    estimateTokens(message: Message): number;
    private calculateThreshold;
    private selectStrategy;
    private buildCompactionContext;
    private validateResult;
    private recover;
    private setState;
    private emit;
    private generateId;
}
//# sourceMappingURL=ContextManager.d.ts.map