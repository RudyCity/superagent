import { Message } from "../conversation";
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
    private encoder;
    constructor(model: string);
    private initEncoder;
    setModel(model: string): void;
    getModel(): string;
    estimateTokens(message: Message): number;
    estimateTokensForAll(messages: Message[]): TokenBreakdown;
    getBreakdown(messages: Message[], systemPrompt?: string): TokenBreakdown;
    private countText;
    private hashMessage;
}
//# sourceMappingURL=TokenTracker.d.ts.map