import type { ContextManager, ContextManagerConfig } from "./context/index.js";
export interface Message {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    timestamp: number;
}
export interface ToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
}
export interface ToolResult {
    toolCallId: string;
    name: string;
    result: string;
    isError?: boolean;
}
export declare class Conversation {
    private messages;
    private maxHistory;
    loadedPlanState?: "IDLE" | "PLANNING_PENDING" | "APPROVED";
    private contextManager;
    initContextManager(config: ContextManagerConfig): Promise<void>;
    updateContextManagerLLM(model: any, abortSignal?: AbortSignal): Promise<void>;
    getContextManager(): ContextManager | null;
    hasContextManager(): boolean;
    replaceMessages(newMessages: Message[]): void;
    saveToFile(filePath: string, planState?: "IDLE" | "PLANNING_PENDING" | "APPROVED"): Promise<void>;
    loadFromFile(filePath: string): Promise<void>;
    addMessage(msg: Message): void;
    addUserMessage(content: string): void;
    addAssistantMessage(content: string, toolCalls?: ToolCall[], toolResults?: ToolResult[]): void;
    getMessages(): Message[];
    getApiMessages(): Array<{
        role: "user" | "assistant";
        content: string;
    }>;
    clear(): void;
    pruneToTokenLimit(maxTokens: number): void;
    replaceOldMessagesWithSummary(count: number, summaryText: string): void;
    getCompactSummary(limit?: number): string;
    getTokenEstimate(): number;
}
//# sourceMappingURL=conversation.d.ts.map