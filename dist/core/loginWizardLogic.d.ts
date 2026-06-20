export type ProviderType = "openrouter" | "openai" | "anthropic" | "custom";
export interface ConfiguredProvider {
    id: string;
    name: string;
    provider?: string;
    type?: string;
    apiKey?: string;
    baseUrl?: string;
    isActive?: boolean;
}
export declare function resolveProviderType(choice: string): ProviderType | null;
export declare function buildProviderOptions(providers: ConfiguredProvider[]): string[];
export declare function getFallbackModels(providerType: ProviderType): string[];
export declare function getModelOptions(providerType: string, cachedModels: string[]): string[];
export declare function resolveTestModel(providerType: string, baseUrl: string): string;
/**
 * Fetch the list of available models from an OpenAI-compatible endpoint's
 * `/models` API. Returns an empty array on any failure so callers can
 * safely fall back to `resolveTestModel()`.
 */
export declare function fetchModelsFromEndpoint(baseUrl: string, apiKey: string): Promise<string[]>;
/**
 * Resolve the best model to use for a connection test.
 * For custom endpoints, fetches the available models list first and picks the
 * first available model. Falls back to the static `resolveTestModel()` when
 * the endpoint doesn't respond or returns no models.
 */
export declare function resolveTestModelAsync(providerType: string, baseUrl: string, apiKey: string): Promise<string>;
//# sourceMappingURL=loginWizardLogic.d.ts.map