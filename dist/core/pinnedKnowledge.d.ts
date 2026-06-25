import type { PinnedMessage, AgentTag } from "./context/ContextManager.js";
export interface KnowledgeEntry {
    /** Unique ID for this knowledge entry */
    id: string;
    /** Full message content (un-truncated) */
    content: string;
    /** Message role */
    role: string;
    /** Agent metadata */
    agentTag?: AgentTag;
    /** User-defined tag/label */
    tag?: string;
    /** Absolute path to the source session JSON file */
    sourceSessionPath: string;
    /** Working directory of the source session */
    workingDirectory: string;
    /** When the message was pinned */
    pinnedAt: number;
    /** Original message timestamp */
    timestamp: number;
    /** Short summary (first 200 chars) for quick scanning */
    preview: string;
    /** Tool calls associated with the message */
    toolCalls?: Array<{
        id: string;
        name: string;
        args: Record<string, unknown>;
    }>;
    /** Tool results associated with the message */
    toolResults?: Array<{
        toolCallId: string;
        name: string;
        result: string;
        isError?: boolean;
    }>;
}
/**
 * Add a pinned message to the global knowledge store.
 * Returns the generated entry ID.
 */
export declare function addToKnowledge(pinned: PinnedMessage, sourceSessionPath: string, workingDirectory: string): string;
/**
 * Remove a knowledge entry by ID.
 */
export declare function removeFromKnowledge(id: string): boolean;
/**
 * Remove a knowledge entry matching a specific session path + content preview.
 * Used when unpinning a message to clean up the corresponding global entry.
 */
export declare function removeKnowledgeByPin(sourceSessionPath: string, contentPreview: string): boolean;
/**
 * Update the tag of a knowledge entry matching a specific session path + content preview.
 * Used when tagging a pinned message to sync the tag to the global store.
 */
export declare function updateKnowledgeTag(sourceSessionPath: string, contentPreview: string, tag: string): boolean;
/**
 * Remove all knowledge entries from a specific session.
 */
export declare function removeSessionFromKnowledge(sourceSessionPath: string): number;
/**
 * Search knowledge entries by query (fuzzy match on content, tag, role).
 * Optionally filter by workingDirectory.
 */
export declare function searchKnowledge(query: string, options?: {
    workingDirectory?: string;
    tag?: string;
    limit?: number;
}): KnowledgeEntry[];
/**
 * Get all knowledge entries, optionally filtered by working directory.
 */
export declare function getAllKnowledge(options?: {
    workingDirectory?: string;
    tag?: string;
    limit?: number;
}): KnowledgeEntry[];
/**
 * Get unique working directories from knowledge entries.
 */
export declare function getKnowledgeProjects(): string[];
/**
 * Format knowledge entries for injection into an AI system prompt.
 * Returns a string that can be concatenated into the system prompt.
 */
export declare function formatKnowledgeForPrompt(entries: KnowledgeEntry[], maxEntries?: number, maxContentChars?: number): string;
/**
 * Read the full conversation history from a session file referenced by a knowledge entry.
 * Returns the messages array or null if the file can't be read.
 */
export declare function loadSessionFromKnowledge(sourceSessionPath: string): Array<{
    role: string;
    content: string;
    timestamp?: number;
}> | null;
/**
 * Get a formatted transcript of a session for the AI to study.
 */
export declare function getSessionTranscript(sourceSessionPath: string, maxChars?: number): string | null;
//# sourceMappingURL=pinnedKnowledge.d.ts.map