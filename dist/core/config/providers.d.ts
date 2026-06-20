export interface ConfiguredProvider {
    id: string;
    name: string;
    type: string;
    apiKey: string;
    baseUrl?: string;
    isActive: boolean;
}
export declare function getConfiguredProviders(): ConfiguredProvider[];
export declare function switchActiveProvider(name: string): boolean;
export declare function getProviderOptionsList(list: ConfiguredProvider[]): string[];
/**
 * Get the active provider type name from JSON config.
 */
export declare function getActiveProviderName(): string;
/**
 * Resolve a raw model value to "provider:model" format.
 * Reads fallback from JSON config, not env var.
 */
export declare function getResolvedModelWithProvider(rawVal: string, isDefault: boolean, fallbackModel?: string): string;
/**
 * Format provider list for wizard profile picker (with masked API key + [Active]).
 */
export declare function formatProviderForPicker(list: ConfiguredProvider[]): string[];
/**
 * Format provider list for log display (with masked API key, base URL, [Active]).
 */
export declare function formatProviderForLog(list: ConfiguredProvider[]): string;
type ModelMode = "multi" | "single";
/**
 * Get the effective master/primary model name from JSON config.
 * For multi mode: returns master model.
 * For single mode: returns superagent model.
 * Falls back to "gpt-4o" if nothing is set.
 */
export declare function getEffectiveMasterModel(mode?: ModelMode | "auto"): string;
/**
 * Get a specific tier's model from JSON config.
 * @param mode "multi" | "single" | "auto"
 * @param tier Tier name: "master", "superagent", "subagent", "researcher", "coder", "reviewer", or any subagent name
 * @returns The model string, or "" if not set
 */
export declare function getTierModel(mode: ModelMode | "auto", tier: string): string;
export declare function getTierModelWithProvider(mode: ModelMode | "auto", tier: string): string;
/**
 * Set a specific tier's model in JSON config and persist.
 * @param mode "multi" | "single" | "auto"
 * @param tier Tier name
 * @param modelName The model string to set
 * @param providerProfileId Optional provider profile ID
 */
export declare function setTierModel(mode: ModelMode | "auto", tier: string, modelName: string, providerProfileId?: string): void;
/**
 * Set ALL tiers' models at once in JSON config and persist.
 */
export declare function setAllTierModels(mode: ModelMode | "auto", modelName: string, providerProfileId?: string): void;
/**
 * Clear a specific tier's model override (set to empty string).
 */
export declare function clearTierModel(mode: ModelMode | "auto", tier: string): void;
/**
 * Get all tier models as a display-ready record.
 * Returns keys like: master, superagent, subagentDefault, and subagentDetails entries.
 */
export declare function getAllTierModels(mode: ModelMode | "auto"): Record<string, string>;
export {};
//# sourceMappingURL=providers.d.ts.map