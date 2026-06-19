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

export function resolveProviderType(choice: string): ProviderType | null {
  const lc = choice.toLowerCase();
  if (lc === "1" || lc.includes("openrouter")) return "openrouter";
  if (lc === "2" || lc.includes("openai")) return "openai";
  if (lc === "3" || lc.includes("anthropic")) return "anthropic";
  if (lc === "4" || lc.includes("custom")) return "custom";
  return null;
}

export function buildProviderOptions(providers: ConfiguredProvider[]): string[] {
  return providers
    .filter((p) => p.apiKey && p.apiKey.trim() !== "")
    .map((p, i) => {
      const label = p.provider || p.type || "unknown";
      return `${i + 1}. ${p.name} [${label}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`;
    });
}

export function getFallbackModels(providerType: ProviderType): string[] {
  switch (providerType) {
    case "anthropic":
      return [
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
      ];
    case "openai":
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
    default:
      return ["gpt-4o", "gpt-4o-mini"];
  }
}

export function getModelOptions(providerType: string, cachedModels: string[]): string[] {
  const fallback = getFallbackModels(providerType as ProviderType);
  let models = cachedModels.length > 0 ? cachedModels : fallback;
  if (providerType === "anthropic") {
    const filtered = models.filter((m) => m.includes("claude"));
    models = filtered.length > 0 ? filtered : fallback;
  } else if (providerType === "openai") {
    const filtered = models.filter(
      (m) => m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")
    );
    models = filtered.length > 0 ? filtered : fallback;
  }
  return models.slice(0, 50);
}

export function resolveTestModel(providerType: string, baseUrl: string): string {
  if (providerType === "anthropic") return "claude-3-haiku-20240307";
  if (providerType === "openrouter" || (baseUrl && baseUrl.includes("openrouter.ai"))) {
    return "openai/gpt-4o-mini";
  }
  return "gpt-4o-mini";
}
