import type { Agent } from "../agent.js";
export interface ChatLine {
    type: "user" | "assistant" | "system" | "error" | "tool_start" | "tool_end";
    content: string;
    timestamp: number;
}
export interface SlashCommandContext {
    addLine: (line: ChatLine) => void;
    exit: () => void;
    agent: Agent | null;
    clearLines?: () => void;
    setContextLimit?: (limit: number) => void;
    setActiveModel?: (model: string) => void;
    setActiveWizard?: (val: {
        type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills";
        step: number;
        data: Record<string, string>;
    } | null) => void;
    setWizardOptions?: (options: string[]) => void;
    setWizardSelectedIndex?: (index: number) => void;
    setCheckpointsList?: (list: any[]) => void;
    resumeSession?: () => Promise<void>;
    resumeFromPath?: (filePath: string) => Promise<void>;
    setPlanState?: (state: "IDLE" | "PLANNING_PENDING" | "APPROVED") => void;
    setGoalMode?: (val: {
        goal: string;
        startedAt: number;
    } | null) => void;
    setIsProcessing?: (val: boolean) => void;
}
export interface SlashCommand {
    name: string;
    aliases?: string[];
    description: string;
    execute(args: string, ctx: SlashCommandContext): Promise<void> | void;
}
export declare function getProviderLabel(): string;
export declare function getDefaultModel(): string;
export declare function formatPresetValue(preset: any): string;
export declare function getPresetLabel(key: string, val: any): string;
export declare function findPreset(presets: Record<string, any>, nameOrKey: string): {
    key: string;
    value: any;
} | null;
//# sourceMappingURL=types.d.ts.map