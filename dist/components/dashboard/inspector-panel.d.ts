import React from "react";
import { AgentSession } from "../multi-agent-dashboard.js";
export declare function renderLogInlineStyles(text: string, defaultColor: string, isBold: boolean, dimColor: boolean): React.ReactNode;
export declare function ThinkingSpinner({ type }: {
    type?: "orchestrating" | "processing";
}): React.JSX.Element;
export declare function ToolLoadingIndicator(): React.JSX.Element;
export declare function BlinkingCursor(): React.JSX.Element;
interface InspectorPanelProps {
    selectedSession: AgentSession;
    focusArea: string;
    logScrollOffset: number;
    isHistoryTruncated: boolean;
    feedWidth: number;
    logBoxHeight: number;
    visibleLogs: React.ReactNode[];
    isExecutingTool: boolean;
    timeLeft: number | null;
    activeToolLines: string[];
    workspaceHeight: number;
}
export declare function InspectorPanel({ selectedSession, focusArea, logScrollOffset, isHistoryTruncated, feedWidth, logBoxHeight, visibleLogs, isExecutingTool, timeLeft, activeToolLines, workspaceHeight, }: InspectorPanelProps): React.JSX.Element;
export {};
//# sourceMappingURL=inspector-panel.d.ts.map