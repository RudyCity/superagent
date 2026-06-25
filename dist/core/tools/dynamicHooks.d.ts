import { Tool } from "./types.js";
export interface HookMetadata {
    name: string;
    dirName: string;
    description: string;
    active: boolean;
}
export declare function getActiveHooksForProject(projectPath: string): string[] | null;
export declare function saveActiveHooksForProject(projectPath: string, activeHooks: string[]): void;
export declare function getAvailableHooks(): HookMetadata[];
export declare function loadDynamicHooks(): Tool[];
export declare function runEventHooks(event: "pre_tool" | "post_tool" | "pre_command" | "post_command", contextData: any): Promise<void>;
//# sourceMappingURL=dynamicHooks.d.ts.map