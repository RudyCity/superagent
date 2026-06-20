export declare function stripSgrMouseSequences(value: string): string;
export declare function getInsertion(oldVal: string, newVal: string): {
    prefix: string;
    inserted: string;
    suffix: string;
};
export declare function getPasteSplit(currentInput: string, prefixLen: number, suffixLen: number): {
    prefix: string;
    inserted: string;
    suffix: string;
};
export declare function getLatestSubagentAction(logs: string[]): string;
export declare function getLatestSuperagentAction(logs: string[]): string;
export declare function truncateStreamDisplay(text: string, maxLines: number, width: number): string;
//# sourceMappingURL=uiHelpers.d.ts.map