import React from "react";
import { AgentSession } from "../multi-agent-dashboard.js";
export declare function ActiveStatusBadge(): React.JSX.Element;
export declare function SessionSpinner(): React.JSX.Element;
export declare function renderStatusBadge(status: AgentSession["status"]): React.JSX.Element;
export declare const tierIcon: Record<AgentSession["type"], string>;
export declare const tierColor: Record<AgentSession["type"], string>;
interface RegistryPanelProps {
    sessions: AgentSession[];
    selectedIndex: number;
    focusArea: string;
    startIdx: number;
    visibleSessions: AgentSession[];
    getLatestSuperagentAction: (logs: string[]) => string;
    getLatestSubagentAction: (logs: string[]) => string;
    leftTopHeight: number;
}
export declare function RegistryPanel({ sessions, selectedIndex, focusArea, startIdx, visibleSessions, getLatestSuperagentAction, getLatestSubagentAction, leftTopHeight, }: RegistryPanelProps): React.JSX.Element;
export {};
//# sourceMappingURL=registry-panel.d.ts.map