export interface HistorySession {
    filePath: string;
    displayName: string;
    messageCount: number;
    lastModified: Date;
    preview: string;
}
export declare function listHistorySessions(isMulti?: boolean): HistorySession[];
//# sourceMappingURL=history.d.ts.map