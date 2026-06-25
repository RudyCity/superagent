import React from "react";
import type { ChatLine } from "../core/slash-commands.js";
import type { ChatLinePosition } from "../hooks/useMouseScroll.js";
export interface WrappedChatLine {
    node: React.ReactNode;
    lineIndex: number;
    childIndex?: number;
    type: string;
    isHeader?: boolean;
    isSeparator?: boolean;
    isCollapsible?: boolean;
    isTruncated?: boolean;
}
export declare function renderInlineMarkdown(text: string, defaultColor?: string): React.ReactNode;
export declare function wrapMarkdownToLines(content: string, themeColor: string, chatWidth: number, lineIndex: number): WrappedChatLine[];
export declare function wrapChatLineToLines({ line, isFirst, lineIndex, tokensUp, tokensDown, modelName, maxResponseLines, chatWidth, isLastAssistant, isCollapsed, expandedChildren, }: {
    line: ChatLine;
    isFirst: boolean;
    lineIndex: number;
    tokensUp: number;
    tokensDown: number;
    modelName: string;
    maxResponseLines: number;
    chatWidth: number;
    isLastAssistant: boolean;
    isCollapsed: boolean;
    expandedChildren: Set<number>;
}): WrappedChatLine[];
export declare function computeWrappedLines({ lines, chatWidth, maxAssistantResponseLines, expandedLines, expandedChildren, tokensUp, tokensDown, modelName, isProcessing, streamDisplay, isExecutingTool, activeToolOutput, timeLeft, formatCompactNumber, }: {
    lines: ChatLine[];
    chatWidth: number;
    maxAssistantResponseLines: number;
    expandedLines: Set<number>;
    expandedChildren: Map<number, Set<number>>;
    tokensUp: number;
    tokensDown: number;
    modelName: string;
    isProcessing: boolean;
    streamDisplay: string;
    isExecutingTool: boolean;
    activeToolOutput: string;
    timeLeft: number | null;
    formatCompactNumber: (val: number) => string;
}): WrappedChatLine[];
export interface ChatAreaProps {
    showBanner: boolean;
    focusMode: string;
    scrollOffset: number;
    focusedResponseIndex: number | null;
    setFocusedResponseIndex: React.Dispatch<React.SetStateAction<number | null>>;
    focusedResponseOffset: number;
    setFocusedResponseOffset: React.Dispatch<React.SetStateAction<number>>;
    lines: ChatLine[];
    chatHeightLimit: number;
    terminalHeight: number;
    terminalWidth: number;
    isProcessing: boolean;
    streamDisplay: string;
    tokensUp: number;
    tokensDown: number;
    liveStreamTokens: number;
    modelName: string;
    maxAssistantResponseLines: number;
    isExecutingTool: boolean;
    timeLeft: number | null;
    activeToolOutput: string;
    formatCompactNumber: (val: number) => string;
    onVisibleLinesChange?: (positions: ChatLinePosition[]) => void;
    chatContentStartRow?: number;
    expandedLines?: Set<number>;
    toggleLineExpand?: (index: number) => void;
    expandedChildren?: Map<number, Set<number>>;
    toggleChildExpand?: (parentIndex: number, childIndex: number) => void;
    wrappedLines?: WrappedChatLine[];
}
export declare const ChatArea: React.NamedExoticComponent<ChatAreaProps>;
//# sourceMappingURL=chat-area.d.ts.map