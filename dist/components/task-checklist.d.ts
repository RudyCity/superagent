import React from "react";
interface TaskChecklistProps {
    planState: string;
    checklistTasks: {
        status: string;
        text: string;
    }[];
    checklistScrollOffset: number;
    maxChecklistVisible: number;
    focusMode: string;
    isMultiAgent: boolean;
    completedHistory?: {
        status: string;
        text: string;
    }[];
}
export declare function TaskChecklist({ planState, checklistTasks, checklistScrollOffset, maxChecklistVisible, focusMode, isMultiAgent, completedHistory, }: TaskChecklistProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=task-checklist.d.ts.map