export interface CompactionEvent {
    id: string;
    timestamp: number;
    strategy: string;
    messagesBefore: number;
    messagesAfter: number;
    tokensBefore: number;
    tokensAfter: number;
    summary?: string;
    summaryTokens?: number;
    pinnedMessages?: string[];
    reason: "threshold" | "emergency" | "manual";
}
export declare class CompactionHistory {
    private events;
    private maxHistory;
    private filePath?;
    constructor(filePath?: string);
    record(event: CompactionEvent): void;
    getHistory(): CompactionEvent[];
    getLastSummary(): CompactionEvent | null;
    getTokensSaved(): number;
    getCompactionCount(): number;
    clear(): void;
    private save;
    private load;
}
//# sourceMappingURL=CompactionHistory.d.ts.map