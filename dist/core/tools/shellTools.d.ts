import { Tool } from "./types.js";
export declare function adjustCommandPorts(command: string): Promise<string>;
export declare function acquireNpmLock(): Promise<() => void>;
export declare function killProcessTree(pid: number | undefined): void;
export declare const bashTool: Tool;
export declare const runCommandTool: Tool;
export declare const runBackgroundProcessTool: Tool;
export declare const killBackgroundProcessTool: Tool;
export declare const viewBackgroundProcessesTool: Tool;
export declare const manageBackgroundProcessTool: Tool;
//# sourceMappingURL=shellTools.d.ts.map