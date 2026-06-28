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
        remainingSeconds?: number;
    }[];
    maxHistoryVisible?: number;
}
export declare function TaskChecklist({ planState, checklistTasks, checklistScrollOffset, maxChecklistVisible, focusMode, isMultiAgent, completedHistory, maxHistoryVisible, }: TaskChecklistProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=task-checklist.d.ts.map