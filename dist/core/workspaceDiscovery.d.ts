export interface WorkspaceCache {
    workspaceDir: string;
    fingerprint: string;
    fileList: string[];
    files: Record<string, {
        size: number;
        mtimeMs: number;
    }>;
    agentsMd?: string;
    packageJson?: any;
    lastScanTime: number;
}
/**
 * Calculates a fast fingerprint MD5 hash of the workspace files (sorted paths + sizes + mtimes).
 */
export declare function getWorkspaceFingerprint(dir: string): Promise<{
    fingerprint: string;
    fileList: string[];
    files: Record<string, {
        size: number;
        mtimeMs: number;
    }>;
}>;
/**
 * Resolves the cache file path for the given workspace directory.
 */
export declare function getWorkspaceCachePath(dir: string): string;
/**
 * Discovers the workspace: compares current fingerprint with the cache to determine
 * whether a full/partial update is required. Returns isIdentical and the cache.
 */
export declare function discoverWorkspace(dir: string): Promise<{
    isIdentical: boolean;
    cache: WorkspaceCache;
}>;
/**
 * Injects a formatted overview of the workspace files and main configs into the system prompt.
 */
export declare function injectWorkspaceOverview(systemPrompt: string, cache: WorkspaceCache): string;
//# sourceMappingURL=workspaceDiscovery.d.ts.map