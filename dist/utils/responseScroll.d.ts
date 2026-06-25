import type { ChatLine } from "../core/slash-commands.js";
export declare function capDisplayLines(text: string, maxLines: number, width: number): {
    text: string;
    truncated: boolean;
};
export declare function getTruncatedAssistantIndexes(lines: ChatLine[], maxLines: number, width: number): number[];
export declare function wrapTextForDisplay(text: string, width: number): string[];
export declare function renderScrollBar(offset: number, windowHeight: number, totalLines: number): string;
//# sourceMappingURL=responseScroll.d.ts.map