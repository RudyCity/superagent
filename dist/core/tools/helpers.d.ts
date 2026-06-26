interface WindowsShellResult {
    shellPath: string;
    isBash: boolean;
}
export declare function resolveWindowsShell(): WindowsShellResult;
export declare function formatCommandForPowerShell(command: string): string;
export declare function normalizeForMatching(str: string): string;
export declare function verifySyntax(filePath: string): Promise<string | null>;
export declare function truncateOutput(output: string, maxLines?: number): string;
/**
 * Normalize backslash paths inside git commands to forward slashes.
 * Prevents Windows-style `feat\timer-service` being interpreted as
 * `feat<TAB>imer-service` by Git/Bash.
 *
 * Only transforms arguments that follow git subcommands (checkout, diff,
 * log, branch, worktree, merge, stash, etc.) — leaves the rest untouched.
 */
export declare function normalizeGitPaths(command: string): string;
export declare function detectInteractivePrompt(text: string): string | null;
export declare function mapNormToOrigIndices(sliceText: string, normSliceText: string): number[];
export {};
//# sourceMappingURL=helpers.d.ts.map