import { SlashCommand } from "./types.js";
declare class CommandRegistry {
    private commands;
    register(command: SlashCommand): void;
    get(name: string): SlashCommand | undefined;
    getAll(): SlashCommand[];
}
export declare const registry: CommandRegistry;
export {};
//# sourceMappingURL=registry.d.ts.map