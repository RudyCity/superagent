interface WindowsShellResult {
    shellPath: string;
    isBash: boolean;
}
export declare function resolveWindowsShell(): WindowsShellResult;
export declare function formatCommandForPowerShell(command: string): string;
export declare function normalizeForMatching(str: string): string;
export declare function verifySyntax(filePath: string): Promise<string | null>;
export declare function truncateOutput(output: string, maxLines?: number): string;
export declare function detectInteractivePrompt(text: string): string | null;
export {};
//# sourceMappingURL=helpers.d.ts.map