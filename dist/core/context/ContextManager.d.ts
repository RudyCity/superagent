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
    compact(messages: Message[], strategy?: CompactionStrategy): Promise<CompactionResult>;
    getState(): ContextState;
    on(event: "compaction:start" | "compaction:complete" | "compaction:fail", handler: (...args: any[]) => void): void;
    off(event: "compaction:start" | "compaction:complete" | "compaction:fail", handler: (...args: any[]) => void): void;
    setThreshold(threshold: number | "auto"): void;
    setModel(model: string): void;
    addPinnedMessage(messageId: string): void;
    removePinnedMessage(messageId: string): void;
    getPinnedMessages(): Set<string>;
    getHistory(): import("./CompactionHistory.js").CompactionEvent[];
    getTokenTracker(): TokenTracker;
    getSemanticAnalyzer(): SemanticAnalyzer;
    estimateTokensForAll(messages: Message[]): TokenBreakdown;
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