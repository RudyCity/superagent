import React from "react";
interface DashboardWizardProps {
    activeWizard: any;
    query: string;
    wizardAllOptions: string[];
    wizardSelectedIndex: number;
    wizardIsLoadingModels: boolean;
    wizardOptions: string[];
    wizardSelectedSet: Set<number>;
    pendingQuestion: any;
    agent: any;
    terminalWidth: number;
    focus?: "plan" | "actions";
    scrollOffset?: number;
    onScrollChange?: (val: number) => void;
}
export declare function DashboardWizard({ activeWizard, query, wizardAllOptions, wizardSelectedIndex, wizardIsLoadingModels, wizardOptions, wizardSelectedSet, pendingQuestion, agent, terminalWidth, focus, scrollOffset, onScrollChange, }: DashboardWizardProps): React.JSX.Element | null;
export {};
//# sourceMappingURL=dashboard-wizard.d.ts.map