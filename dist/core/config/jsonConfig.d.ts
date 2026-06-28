export interface ProviderProfile {
    id: string;
    name: string;
    provider: string;
    apiKey: string;
    baseUrl?: string;
}
export interface TierModelConfig {
    providerProfileId: string;
    model: string;
}
export interface PresetModelsMulti {
    master: TierModelConfig;
    superagent: TierModelConfig;
    subagentDefault: TierModelConfig;
    subagentDetails: Record<string, TierModelConfig>;
}
export interface PresetModelsSingle {
    superagent: TierModelConfig;
    subagentDefault: TierModelConfig;
    subagentDetails: Record<string, TierModelConfig>;
}
export interface JSONModelPreset<T> {
    id: string;
    name: string;
    description: string;
    models: T;
}
export interface SystemSettings {
    concurrencyLimit: number;
    rateLimitRpm: number;
    rateLimitCapacity: number;
    disableStreaming: boolean;
    contextWindowLimit: number;
    maxIterations: number;
    simpleTaskFileThreshold?: number;
    simpleTaskKeywords?: string[];
    tencentdbGatewayUrl?: string;
    tencentdbGatewayApiKey?: string;
    tencentdbServiceId?: string;
    enableTencentdbMemory?: boolean;
    tencentdbPollIntervalMs?: number;
    maxChecklistVisible?: number;
    maxHistoryVisible?: number;
    maxProcsVisible?: number;
}
export interface GlobalModelConfig {
    providers: ProviderProfile[];
    presets: {
        multi: JSONModelPreset<PresetModelsMulti>[];
        single: JSONModelPreset<PresetModelsSingle>[];
    };
    activePresetId: {
        multi: string;
        single: string;
    };
    settings?: SystemSettings;
    trustedDirectories?: string[];
    activeHooks?: Record<string, string[]>;
}
export declare function clearModelConfigCache(): void;
export declare function loadModelConfig(): GlobalModelConfig;
export declare function saveModelConfig(config: GlobalModelConfig, options?: {
    mergeProviders?: boolean;
    mergePresets?: boolean;
}): boolean;
export declare function getProviders(): ProviderProfile[];
export declare function addProvider(profile: ProviderProfile): void;
export declare function removeProvider(id: string): void;
/**
 * Get system settings with defaults filled in for any missing fields.
 */
export declare function getSettings(): SystemSettings;
/**
 * Update one or more settings and persist to model-config.json.
 */
export declare function updateSettings(updates: Partial<SystemSettings>): void;
export declare function getPresets(mode: "multi" | "single"): JSONModelPreset<PresetModelsMulti>[] | JSONModelPreset<PresetModelsSingle>[];
/**
 * Reload latest config from disk, apply a mutation, then persist in one save.
 * Use this for provider/model/preset writes that would otherwise do read-mutate-save
 * on a possibly stale cached snapshot.
 */
export declare function mutateModelConfig(mutator: (config: GlobalModelConfig) => void, options?: Parameters<typeof saveModelConfig>[1]): void;
export declare function savePreset<T>(mode: "multi" | "single", preset: JSONModelPreset<T>): void;
export declare function deletePreset(mode: "multi" | "single", id: string): void;
export declare function getActivePresetId(mode: "multi" | "single"): string;
export declare function setActivePresetId(mode: "multi" | "single", id: string): void;
export declare function getActivePreset<T>(mode: "multi" | "single"): JSONModelPreset<T>;
export declare function getActiveConfigAudit(overrideMode?: "multi" | "single"): string;
/**
 * Get model info for display purposes from JSON config.
 * Returns formatted model strings for each tier.
 */
export declare function getModelInfoForDisplay(isMulti: boolean): {
    activeProvider: string;
    master: string;
    superagent: string;
    subagentDefault: string;
    subagentDetails: Record<string, string>;
};
/**
 * Get the list of all trusted project directories.
 */
export declare function getTrustedDirectories(): string[];
/**
 * Add a directory path to the trusted list in configuration.
 */
export declare function addTrustedDirectory(dirPath: string): void;
/**
 * Check if a directory path is trusted in configuration.
 */
export declare function isDirectoryTrusted(dirPath: string): boolean;
/**
 * Ensure a directory is added to Git's global safe.directory configuration
 * to prevent dubious ownership issues on Windows/multi-user systems.
 */
export declare function ensureDirectoryTrusted(dirPath: string, cwd?: string): Promise<void>;
//# sourceMappingURL=jsonConfig.d.ts.map