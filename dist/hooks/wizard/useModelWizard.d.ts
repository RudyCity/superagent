import type { ChatLine } from "../../core/slash-commands.js";
interface ModelWizardContext {
    setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
    setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
    setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
    addLine: (line: ChatLine) => void;
    setInput: React.Dispatch<React.SetStateAction<string>>;
    setContextLimit: React.Dispatch<React.SetStateAction<number>>;
    setActiveModel: React.Dispatch<React.SetStateAction<string>>;
    setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
    wizardSelectedIndex: number;
    wizardOptions: string[];
    wizardIsLoadingModels: boolean;
    agentRef?: React.MutableRefObject<any>;
}
export declare function useModelWizard(ctx: ModelWizardContext): (value: string, step: number, data: Record<string, string>) => Promise<void>;
export {};
//# sourceMappingURL=useModelWizard.d.ts.map