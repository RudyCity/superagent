import React from "react";
interface PlanApprovalDialogProps {
    planFilePath: string;
    selectedIndex: number;
    step: number;
    borderColor?: "yellow" | "cyan" | "magenta" | "green" | "gray" | "white" | "red";
    terminalWidth?: number;
    /** Maximum number of plan content lines visible at once */
    maxContentHeight?: number;
}
export declare function PlanApprovalDialog({ planFilePath, selectedIndex, step, borderColor, terminalWidth, maxContentHeight, }: PlanApprovalDialogProps): React.JSX.Element;
/** The default option labels — used by callers that set wizardOptions */
export declare const PLAN_APPROVAL_OPTIONS: string[];
/** How many lines the plan approval dialog occupies (for chrome height calc) */
export declare function planApprovalChromeHeight(planFilePath: string, step: number, maxContentHeight?: number): number;
export {};
//# sourceMappingURL=plan-approval-dialog.d.ts.map