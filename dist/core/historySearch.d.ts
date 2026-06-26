/**
 * Custom subsequence fuzzy matching and token-based scoring algorithm.
 * Returns a score between 0.0 (no match) and 1.0 (exact match).
 */
export declare function fuzzyScore(text: string, query: string): number;
/**
 * Filter out verbose tool output logs to save 90-95% of token context.
 */
export declare function cleanTranscriptForLLM(messages: any[]): string;
/**
 * Clear the in-memory semantic search cache.
 */
export declare function clearSemanticSearchCache(): void;
/**
 * Perform a hybrid AI-powered semantic search with an offline fuzzy fallback.
 * @param query - The search query
 * @param isMulti - Whether to search multi-agent sessions
 * @param crossSession - If true, search ALL sessions regardless of working directory
 */
export declare function searchHistory(query: string, isMulti?: boolean, crossSession?: boolean, onDebug?: (msg: string) => void): Promise<string>;
//# sourceMappingURL=historySearch.d.ts.map