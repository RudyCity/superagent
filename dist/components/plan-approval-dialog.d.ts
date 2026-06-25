import React from "react";
interface PlanApprovalDialogProps {
    planFilePath: string;
    selectedIndex: number;
    step: number;
    borderColor?: "yellow" | "cyan" | "blue" | "green" | "gray" | "white" | "red";
    terminalWidth?: number;
    /** Maximum number of plan content lines visible at once */
    maxContentHeight?: number;
    focus?: "plan" | "actions";
    scrollOffset?: number;
    onScrollChange?: (val: number) => void;
}
export declare function PlanApprovalDialog({ planFilePath, selectedIndex, step, borderColor, terminalWidth, maxContentHeight, focus, scrollOffset: propScrollOffset, onScrollChange: propOnScrollChange, }: PlanApprovalDialogProps): React.JSX.Element;
/** The default option labels — used by callers that set wizardOptions */
export declare const PLAN_APPROVAL_OPTIONS: string[];
/** How many lines the plan approval dialog occupies (for chrome height calc) */
export declare function planApprovalChromeHeight(planFilePath: string, step: number, maxContentHeight?: number): number;
export {};
//# sourceMappingURL=plan-approval-dialog.d.ts.map