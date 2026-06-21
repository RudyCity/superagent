import React from "react";
import type { Checkpoint } from "../core/checkpoints.js";
import type { ToolCall } from "../core/conversation.js";
export interface WizardPanelsProps {
    activeWizard: {
        type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills";
        step: number;
        data: Record<string, string>;
        isMultiSelect?: boolean;
    } | null;
    wizardOptions: string[];
    wizardSelectedIndex: number;
    wizardSelectedSet: Set<number>;
    pendingPermission: {
        toolCall: ToolCall;
        description: string;
        resolve: (value: boolean) => void;
    } | null;
    pendingQuestion: {
        question: string;
        options: string[];
        resolve: (value: string) => void;
    } | null;
    planState: string;
    planUrl: string;
    planFilePath: string;
    input: string;
    wizardIsLoadingModels: boolean;
    checkpointsList: Checkpoint[];
    goalMode: {
        goal: string;
        startedAt: number;
    } | null;
    suggestions: string[];
}
export declare const WizardPanels: React.NamedExoticComponent<WizardPanelsProps>;
//# sourceMappingURL=wizard-panels.d.ts.map