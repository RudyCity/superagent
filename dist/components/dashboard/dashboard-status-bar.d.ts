import React from "react";
export interface DashboardStatusBarProps {
    activeModel: string;
    contextPercentage: string;
    activeContextUsage: number;
    contextLimit: number;
    lastSpeed: number | null;
    masterPromptTokens: number;
    masterCompletionTokens: number;
    historicalSuperagentTokens: number;
    activeSuperagentsCount: number;
    subagentInstances: any;
    worktreeCount: number;
    runningTasksCount: number;
    runningSubagentsCount: number;
    activeWTs: string[];
    activeWizard: any;
    wizardOptions: string[];
    focusArea: string;
    tencentdbStatus?: "online" | "offline" | "checking" | "disabled";
    workspace?: string;
}
export declare function DashboardStatusBar({ activeModel, contextPercentage, activeContextUsage, contextLimit, lastSpeed, masterPromptTokens, masterCompletionTokens, historicalSuperagentTokens, activeSuperagentsCount, subagentInstances, worktreeCount, runningTasksCount, runningSubagentsCount, activeWTs, activeWizard, wizardOptions, focusArea, tencentdbStatus, workspace, }: DashboardStatusBarProps): React.JSX.Element;
//# sourceMappingURL=dashboard-status-bar.d.ts.map