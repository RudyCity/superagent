import React from "react";
interface ActiveProcessesPanelProps {
    backgroundTasks: Map<string, any>;
    procsScrollOffset: number;
    maxProcsVisible: number;
    focusArea: string;
    runningSubagentsCount: number;
}
export declare function ActiveProcessesPanel({ backgroundTasks, procsScrollOffset, maxProcsVisible, focusArea, runningSubagentsCount, }: ActiveProcessesPanelProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=active-processes-panel.d.ts.map