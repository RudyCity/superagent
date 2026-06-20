import { Tool } from "./types.js";
export declare const allTools: Tool[];
export declare function getToolByName(name: string): Tool | undefined;
export declare function getToolDefinitions(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}>;
export * from "./types.js";
export * from "./helpers.js";
export * from "./state.js";
export * from "./toolsets.js";
export { killProcessTree } from "./shellTools.js";
//# sourceMappingURL=index.d.ts.map