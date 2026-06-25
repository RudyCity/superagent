import React from "react";
interface ActiveAgentsListProps {
    focusMode: string;
    runningSuperagentsCount: number;
    runningSubagentsCount: number;
    runningTasksCount: number;
    superagentsScrollOffset: number;
    subagentsScrollOffset: number;
    procsScrollOffset: number;
    maxSuperagentsVisible: number;
    maxSubagentsVisible: number;
    maxProcsVisible: number;
    collapsedSections: {
        superagents: boolean;
        subagents: boolean;
        procs: boolean;
    };
}
export declare function ActiveAgentsList({ focusMode, runningSuperagentsCount, runningSubagentsCount, runningTasksCount, superagentsScrollOffset, subagentsScrollOffset, procsScrollOffset, maxSuperagentsVisible, maxSubagentsVisible, maxProcsVisible, collapsedSections, }: ActiveAgentsListProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=active-agents-list.d.ts.map