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
}
export declare function clearModelConfigCache(): void;
export declare function loadModelConfig(): GlobalModelConfig;
export declare function saveModelConfig(config: GlobalModelConfig): boolean;
export declare function getProviders(): ProviderProfile[];
export declare function addProvider(profile: ProviderProfile): void;
export declare function removeProvider(id: string): void;
export declare function getPresets(mode: "multi" | "single"): JSONModelPreset<PresetModelsMulti>[] | JSONModelPreset<PresetModelsSingle>[];
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
//# sourceMappingURL=jsonConfig.d.ts.map