import type { ChatLine } from "../core/slash-commands.js";
import type { ToolCall } from "../core/conversation.js";
import { type Agent, type QuestionItem } from "../core/agent.js";
import type { Checkpoint } from "../core/checkpoints.js";
export interface WizardSubmitContext {
    activeWizard: {
        type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm";
        step: number;
        data: Record<string, string>;
        isMultiSelect?: boolean;
        questions?: QuestionItem[];
        currentQuestionIndex?: number;
        answers?: string[];
    } | null;
    setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
    wizardOptions: string[];
    setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
    wizardSelectedIndex: number;
    setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
    setCheckpointsList: React.Dispatch<React.SetStateAction<Checkpoint[]>>;
    addLine: (line: ChatLine) => void;
    setInput: React.Dispatch<React.SetStateAction<string>>;
    isProcessing: boolean;
    setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
    setContextLimit: React.Dispatch<React.SetStateAction<number>>;
    setActiveModel: React.Dispatch<React.SetStateAction<string>>;
    setPlanState: React.Dispatch<React.SetStateAction<any>>;
    setGoalMode: React.Dispatch<React.SetStateAction<any>>;
    agentRef: React.MutableRefObject<Agent | null>;
    pendingPermission: {
        toolCall: ToolCall;
        description: string;
        resolve: (value: boolean) => void;
    } | null;
    setPendingPermission: React.Dispatch<React.SetStateAction<any>>;
    pendingQuestion: {
        question: string;
        options: string[];
        resolve: (value: any) => void;
    } | null;
    setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
    wizardIsLoadingModels: boolean;
    setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
    planState: string;
    streamBufferRef: React.MutableRefObject<string>;
    setStreamDisplay: React.Dispatch<React.SetStateAction<string>>;
    exit?: () => void;
}
export declare function useWizardSubmit(ctx: WizardSubmitContext): (value: string) => void;
//# sourceMappingURL=useWizardSubmit.d.ts.map