interface ConflictHunk {
    fullMatch: string;
    ourSide: string;
    theirSide: string;
    startIndex: number;
    endIndex: number;
}
/**
 * Parses Git merge conflict markers in a file.
 */
export declare function parseConflictHunks(content: string): ConflictHunk[];
/**
 * Resolves conflicts in a file by feeding only conflict hunks + surrounding context
 * to the LLM, conserving context window tokens.
 *
 * NOTE: This is kept as an opt-in utility. The default mergeBranch() does NOT
 * auto-resolve conflicts — it aborts and reports instead.
 */
export declare function resolveFileConflicts(filePath: string, model: any): Promise<boolean>;
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Run all universal post-merge validation checks on changed files.
 *
 * This is the main entry point — call this AFTER `git merge --no-commit`
 * and BEFORE `git commit`. If validation fails, the merge should be aborted.
 */
export declare function validatePostMerge(cwd: string, branchName: string, changedFiles: string[]): Promise<ValidationResult>;
/**
 * Attempts safe line-based conflict resolution for a single file.
 * Only resolves trivially safe conflicts:
 *   - One side is empty (deletion vs modification) → take non-empty side
 *   - Both sides are identical → take either
 *   - One side is a line-subset of the other → take the superset
 *
 * Returns true if ALL conflicts in the file were resolved, false otherwise.
 */
export declare function tryLineBasedResolution(filePath: string): boolean;
/**
 * Master Agent that orchestrates concurrent Main Agents and merges their results.
 *
 * Merge strategy (v2 — safe by default):
 *   1. git merge --no-commit
 *   2. If conflicts: try line-based safe resolution, then validate, then commit.
 *      If line-based fails: ABORT and report (no LLM auto-resolve).
 *   3. If clean: run universal post-merge validation
 *   4. If validation fails: ABORT and report
 *   5. If validation passes: commit
 */
export declare class MasterAgent {
    private model;
    /**
     * Detailed error/warning messages from the last mergeBranch() call.
     * Read this after a failed merge to understand why it failed.
     */
    lastMergeErrors: string[];
    lastMergeWarnings: string[];
    constructor(model: any);
    /**
     * Merges a feature branch into the current branch.
     * Returns:
     *   - "merged"           if the branch was successfully merged
     *   - "already-merged"   if the branch is already an ancestor of HEAD (nothing to do)
     *   - false              if the merge failed (conflicts or validation failure)
     */
    mergeBranch(branchName: string, targetFiles: string[]): Promise<"merged" | "already-merged" | false>;
}
export {};
//# sourceMappingURL=masterAgent.d.ts.map