import { Message } from "../conversation.js";
export interface TokenBreakdown {
    systemPrompt: number;
    messages: number;
    toolCalls: number;
    toolResults: number;
    total: number;
}
export declare class TokenTracker {
    private model;
    private cache;
    private breakdownCache;
    private encoder;
    /** Resolved once tiktoken is ready (or failed). Await before first count. */
    private encoderReady;
    constructor(model: string);
    private initEncoder;
    /** Await this before the first token estimate to ensure encoder is loaded. */
    ensureEncoder(): Promise<void>;
    setModel(model: string): void;
    getModel(): string;
    estimateTokens(message: Message): number;
    estimateTokensForAll(messages: Message[]): TokenBreakdown;
    getBreakdown(messages: Message[], systemPrompt?: string): TokenBreakdown;
    private countContent;
    private countText;
    /**
     * Stable hash that includes a content prefix to prevent collisions between
     * messages sharing the same role, timestamp, and content length but differing
     * in actual text (e.g., two user messages sent at the same millisecond).
     */
    private hashMessage;
}
//# sourceMappingURL=TokenTracker.d.ts.map