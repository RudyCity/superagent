export declare function normalizePath(p: string): string;
export interface LoadedSkill {
    name: string;
    description: string;
    path: string;
    author?: string;
}
export declare function getInstalledSkills(): LoadedSkill[];
export declare function loadAgentSkills(): string;
//# sourceMappingURL=skills.d.ts.map