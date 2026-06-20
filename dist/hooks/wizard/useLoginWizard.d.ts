import type { Agent } from "../../core/agent.js";
import type { ChatLine } from "../../core/slash-commands.js";
interface LoginWizardContext {
    setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
    setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
    setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    addLine: (line: ChatLine) => void;
    setInput: React.Dispatch<React.SetStateAction<string>>;
    setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
    setContextLimit: React.Dispatch<React.SetStateAction<number>>;
    setActiveModel: React.Dispatch<React.SetStateAction<string>>;
    agentRef: React.MutableRefObject<Agent | null>;
    setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
}
export declare function useLoginWizard(ctx: LoginWizardContext): (value: string, step: number, data: Record<string, string>) => Promise<void>;
export {};
//# sourceMappingURL=useLoginWizard.d.ts.map