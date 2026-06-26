import type { ContextManager, ContextManagerConfig } from "./context/index.js";
export type TextPart = {
    type: "text";
    text: string;
};
export type ImagePart = {
    type: "image";
    image: string;
    mimeType: string;
};
export type MessageContent = string | Array<TextPart | ImagePart>;
/**
 * Convert MessageContent to a plain string.
 * Used by legacy code paths that work only with strings (display, summarization, token counting).
 * Image parts are represented as "[image]" placeholders.
 */
export declare function contentToString(content: MessageContent): string;
export interface Message {
    role: "user" | "assistant" | "system" | "tool";
    content: MessageContent;
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
    lastCapturedTimestamp: number;
    /** Pinned messages loaded from file, waiting for ContextManager to be initialized */
    private pendingPinnedMessages;
    initContextManager(config: ContextManagerConfig): Promise<void>;
    updateContextManagerLLM(model: any, abortSignal?: AbortSignal): Promise<void>;
    getContextManager(): ContextManager | null;
    hasContextManager(): boolean;
    replaceMessages(newMessages: Message[]): void;
    saveToFile(filePath: string, planState?: "IDLE" | "PLANNING_PENDING" | "APPROVED", workingDirectory?: string): Promise<void>;
    loadFromFile(filePath: string): Promise<void>;
    addMessage(msg: Message): void;
    addUserMessage(content: MessageContent): void;
    addAssistantMessage(content: string, toolCalls?: ToolCall[], toolResults?: ToolResult[]): void;
    getMessages(): Message[];
    getApiMessages(): Array<{
        role: "user" | "assistant";
        content: string;
    }>;
    clear(): void;
    getMessageTokenEstimate(m: Message): number;
    pruneToTokenLimit(maxTokens: number): void;
    replaceOldMessagesWithSummary(count: number, summaryText: string): void;
    getCompactSummary(limit?: number): string;
    getTokenEstimate(): number;
}
//# sourceMappingURL=conversation.d.ts.map