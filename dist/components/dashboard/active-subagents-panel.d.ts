import React from "react";
interface ActiveSubagentsPanelProps {
    subagentInstances: Map<string, any>;
    agentsScrollOffset: number;
    maxAgentsVisible: number;
    focusArea: string;
    getLatestSubagentAction: (logs: string[]) => string;
}
export declare function ActiveSubagentsPanel({ subagentInstances, agentsScrollOffset, maxAgentsVisible, focusArea, getLatestSubagentAction, }: ActiveSubagentsPanelProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=active-subagents-panel.d.ts.map