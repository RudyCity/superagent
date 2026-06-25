import React from "react";
export interface StatusBarProps {
    modelName: string;
    contextPercentage: number;
    tokensUp: number;
    tokensDown: number;
    liveStreamTokens: number;
    activeContextUsage: number;
    contextLimit: number;
    messageCount: number;
    runningTasksCount: number;
    runningSubagentsCount: number;
    gitBranch: string;
    worktreeCount: number;
    lastSpeed: number | null;
    formatCompactNumber: (val: number) => string;
    tencentdbStatus?: "online" | "offline" | "checking" | "disabled";
}
export declare function StatusBar(props: StatusBarProps): React.JSX.Element;
//# sourceMappingURL=status-bar.d.ts.map