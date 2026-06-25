import React from "react";
import type { ChatLine } from "../core/slash-commands.js";
/** Returns true if the given chat line type supports collapse/expand */
export declare function isCollapsibleType(type: string): boolean;
export declare function truncateStreamDisplay(text: string, maxLines: number, width: number): string;
export declare function renderMarkdown(content: string, themeColor?: string, showCursor?: boolean): React.ReactNode;
export declare function renderToolStart(content: string): React.ReactNode;
export declare function renderToolEnd(content: string, isError: boolean): React.ReactNode;
interface ChatLineComponentProps {
    line: ChatLine;
    isFirst: boolean;
    lineIndex?: number;
    tokensUp?: number;
    tokensDown?: number;
    modelName?: string;
    maxResponseLines?: number;
    chatWidth?: number;
    /** When true, skip truncation for this assistant response (used for the last response) */
    isLastAssistant?: boolean;
    /** When true, render compact collapsed view */
    isCollapsed?: boolean;
    /** Set of expanded child indexes (for nested tool children) */
    expandedChildren?: Set<number>;
    /** Toggle expand/collapse for a child line */
    toggleChildExpand?: (childIndex: number) => void;
}
export declare const ChatLineComponent: React.NamedExoticComponent<ChatLineComponentProps>;
export {};
//# sourceMappingURL=chat-line.d.ts.map