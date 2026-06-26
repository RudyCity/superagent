export declare function fetchAndCacheModels(): Promise<void>;
/** Returns the list of model IDs cached from the last successful API fetch. */
export declare function getCachedModelIds(): string[];
export declare function getContextWindowLimit(model: string): number;
export declare function isAnthropicCompatible(baseUrl: string, modelName: string): boolean;
export declare function getModelInstance(): import("ai").LanguageModelV1;
export declare function getModelInstanceForString(modelStr: string): import("ai").LanguageModelV1;
export interface ModelConnectionDetails {
    provider: string;
    modelName: string;
    apiKey: string;
    baseUrl?: string;
    profileId: string;
}
export declare function getModelConnectionDetailsForTier(tier: string, depth: number, subagentType?: string, isSingleMode?: boolean): ModelConnectionDetails;
export declare function getModelInstanceForTier(tier: string, depth: number, subagentType?: string, isSingleMode?: boolean): import("ai").LanguageModelV1;
//# sourceMappingURL=models.d.ts.map