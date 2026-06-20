import type { Agent } from "../../core/agent.js";
import type { ChatLine } from "../../core/slash-commands.js";
interface GoalWizardContext {
    setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
    setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
    setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    addLine: (line: ChatLine) => void;
    setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
    setGoalMode: React.Dispatch<React.SetStateAction<any>>;
    agentRef: React.MutableRefObject<Agent | null>;
}
export declare function useGoalWizard(ctx: GoalWizardContext): (value: string, step: number, data: Record<string, string>) => void;
export {};
//# sourceMappingURL=useGoalWizard.d.ts.map