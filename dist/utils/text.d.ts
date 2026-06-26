export declare function resolveCarriageReturns(text: string): string;
export declare function formatArgs(args: Record<string, unknown>): string;
export declare function formatCompactNumber(num: number): string;
/**
 * Perform a fuzzy match and score on a text against a pattern.
 * Returns a score if it matches, or null if it doesn't.
 * Lower score is better/closer match:
 * - 0: Exact match (case-insensitive)
 * - 1: Prefix match (starts with)
 * - 2: Substring match (contains)
 * - 3: Fuzzy / subsequence match
 */
export declare function fuzzyScore(pattern: string, text: string): number | null;
/**
 * Filter and sort a list of possibilities using fuzzy matching against an input.
 */
export declare function filterSuggestions(possibilities: string[], input: string): string[];
/**
 * Strip SGR-style mouse escape sequences that may leak into text input
 * when the user clicks on the terminal.
 *
 * Handles:
 *   - SGR format: \x1b[<btn;col;rowM  (or with \x1b stripped by Ink)
 *   - Variable parameter count: [<0;48;30M, [<0;3;18M
 *   - Partial/fragmented at end of string: [<0;48;30 (missing terminator)
 */
export declare function stripSgrMouseSequences(value: string): string;
export declare function getInsertion(oldVal: string, newVal: string): {
    prefix: string;
    inserted: string;
    suffix: string;
};
export declare function getPasteSplit(currentInput: string, prefixLen: number, suffixLen: number): {
    prefix: string;
    inserted: string;
    suffix: string;
};
/**
 * Apply a Unicode combining long solidus overlay (U+0336) to each visible
 * character so the text appears struck-through regardless of terminal
 * ANSI strikethrough support.  Spaces and zero-width characters are
 * skipped to keep the output visually clean.
 */
export declare function unicodeStrikethrough(text: string): string;
export declare function minimizePathInDescription(str: string): string;
//# sourceMappingURL=text.d.ts.map