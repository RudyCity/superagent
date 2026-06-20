import React from "react";
import type { ChatLine } from "../core/slash-commands.js";
import type { ChatLinePosition } from "../hooks/useMouseScroll.js";
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
}
export declare const ChatArea: React.NamedExoticComponent<ChatAreaProps>;
//# sourceMappingURL=chat-area.d.ts.map