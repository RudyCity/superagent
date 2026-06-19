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
  return models.slice(0, 15);
}

export function resolveTestModel(providerType: string, baseUrl: string): string {
  if (providerType === "anthropic") return "claude-3-haiku-20240307";
  if (providerType === "openrouter" || (baseUrl && baseUrl.includes("openrouter.ai"))) {
    return "openai/gpt-4o-mini";
  }
  return "gpt-4o-mini";
}

/**
 * Fetch the list of available models from an OpenAI-compatible endpoint's
 * `/models` API. Returns an empty array on any failure so callers can
 * safely fall back to `resolveTestModel()`.
 */
export async function fetchModelsFromEndpoint(
  baseUrl: string,
  apiKey: string
): Promise<string[]> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });
    if (!res.ok) return [];

    const json = (await res.json()) as any;
    if (json && Array.isArray(json.data)) {
      return json.data
        .map((m: any) => m?.id)
        .filter((id: any): id is string => typeof id === "string" && id.length > 0);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Resolve the best model to use for a connection test.
 * For custom endpoints, fetches the available models list first and picks the
 * first available model. Falls back to the static `resolveTestModel()` when
 * the endpoint doesn't respond or returns no models.
 */
export async function resolveTestModelAsync(
  providerType: string,
  baseUrl: string,
  apiKey: string
): Promise<string> {
  // For custom / unknown endpoints, try to fetch models from the endpoint
  if (
    providerType === "custom" ||
    (baseUrl &&
      !baseUrl.includes("openrouter.ai") &&
      !baseUrl.includes("openai.com") &&
      !baseUrl.includes("anthropic.com"))
  ) {
    if (baseUrl) {
      const models = await fetchModelsFromEndpoint(baseUrl, apiKey);
      if (models.length > 0) {
        return models[0];
      }
    }
  }
  return resolveTestModel(providerType, baseUrl);
}
