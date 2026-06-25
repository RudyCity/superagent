import React from "react";
import { AgentSession } from "../components/multi-agent-dashboard.js";
/** Returns true if the given label is collapsible */
export declare function isCollapsibleLabel(label: string): boolean;
export interface LogGroupInfo {
    groupIndex: number;
    startLine: number;
    endLine: number;
    label: string;
    isCollapsible: boolean;
}
/** Compute group boundaries for click detection in the multi-agent dashboard */
export declare function computeLogGroupBoundaries(selectedSession: AgentSession, feedWidth: number, isHistoryTruncated: boolean, expandedGroups: Set<number>): LogGroupInfo[];
export declare function computeWrappedLogs(selectedSession: AgentSession, feedWidth: number, isHistoryTruncated: boolean, expandedGroups?: Set<number>): React.ReactNode[];
//# sourceMappingURL=dashboardLogFormatter.d.ts.map