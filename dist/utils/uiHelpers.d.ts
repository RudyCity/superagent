import type { ChatLine } from "../core/commands/types.js";
import type { Message } from "../core/conversation.js";
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
export declare function getLatestSubagentAction(logs: string[]): string;
export declare function getLatestSuperagentAction(logs: string[]): string;
export declare function truncateStreamDisplay(text: string, maxLines: number, width: number): string;
export declare function reconstructChatLines(msgs: Message[]): ChatLine[];
//# sourceMappingURL=uiHelpers.d.ts.map