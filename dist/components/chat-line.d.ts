import React from "react";
import type { ChatLine } from "../core/slash-commands.js";
export declare function truncateStreamDisplay(text: string, maxLines: number, width: number): string;
export declare function renderMarkdown(content: string, themeColor?: string, showCursor?: boolean): React.ReactNode;
export declare function renderToolStart(content: string): React.ReactNode;
export declare function renderToolEnd(content: string, isError: boolean): React.ReactNode;
interface ChatLineComponentProps {
    line: ChatLine;
    isFirst: boolean;
    tokensUp?: number;
    tokensDown?: number;
    modelName?: string;
    maxResponseLines?: number;
    chatWidth?: number;
    /** When true, skip truncation for this assistant response (used for the last response) */
    isLastAssistant?: boolean;
}
export declare const ChatLineComponent: React.NamedExoticComponent<ChatLineComponentProps>;
export {};
//# sourceMappingURL=chat-line.d.ts.map