import React from "react";
interface ChecklistPanelProps {
    planState: string;
    checklistTasks: any[];
    focusArea: string;
    checklistScrollOffset: number;
    maxChecklistVisible: number;
    agent: any;
    superagentInstances: any;
    completedHistory?: {
        status: string;
        text: string;
    }[];
}
export declare function ChecklistPanel({ planState, checklistTasks, focusArea, checklistScrollOffset, maxChecklistVisible, agent, superagentInstances, completedHistory, }: ChecklistPanelProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=checklist-panel.d.ts.map