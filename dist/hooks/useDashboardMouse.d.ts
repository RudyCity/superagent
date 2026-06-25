import React from "react";
import type { LogGroupInfo } from "../utils/dashboardLogFormatter.js";
export interface DashboardMouseContext {
    wrappedLines: React.ReactNode[];
    logsCount: number;
    terminalSize: {
        width: number;
        height: number;
    };
    activeWizard: any;
    setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
    wizardOptions: string[];
    wizardSelectedIndex: number;
    setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    wizardSelectedSet: Set<number>;
    setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
    setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
    pendingQuestion: any;
    handleWizardSubmit: (val: string) => void;
    query: string;
    setQuery: React.Dispatch<React.SetStateAction<string>>;
    wizardAllOptions: string[];
    workspaceHeight: number;
    leftTopHeight: number;
    wizardIsLoadingModels: boolean;
    agent: any;
    focusArea: string;
    setFocusArea: React.Dispatch<React.SetStateAction<any>>;
    setLogScrollOffset: React.Dispatch<React.SetStateAction<number>>;
    setChecklistScrollOffset: React.Dispatch<React.SetStateAction<number>>;
    setAgentsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
    setProcsScrollOffset: React.Dispatch<React.SetStateAction<number>>;
    checklistTasksCount: number;
    maxChecklistVisible: number;
    agentsCount: number;
    maxAgentsVisible: number;
    procsCount: number;
    maxProcsVisible: number;
    /** Start index of visible logs in the full wrappedLines array */
    startIdxLogs?: number;
    /** Group boundaries for click detection on collapsible log groups */
    groupBoundaries?: LogGroupInfo[];
    /** Toggle expand/collapse for a log group */
    toggleGroupCollapse?: (groupIndex: number) => void;
}
export declare function useDashboardMouse(ctx: DashboardMouseContext): void;
//# sourceMappingURL=useDashboardMouse.d.ts.map