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
      const urlPart = p.baseUrl ? ` (${p.baseUrl})` : "";
      return `${i + 1}. ${p.name} [${label}]${urlPart}`;
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
export interface EndpointCompatibilityResult {
  ok: boolean;
  models: string[];
  message?: string;
}

function formatInvalidJsonDiagnostic(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return "endpoint returned empty response body";
  }

  const oneLine = trimmed.replace(/\s+/g, " ").slice(0, 160);
  if (trimmed.startsWith("<")) {
    return `endpoint returned HTML instead of JSON: ${oneLine}`;
  }
  if (trimmed.startsWith("data:")) {
    return `endpoint returned SSE stream instead of JSON: ${oneLine}`;
  }
  return `endpoint returned non-JSON body: ${oneLine}`;
}

async function safeReadResponseText(response: Response | { text?: () => Promise<string>; json?: () => Promise<unknown> }): Promise<string> {
  try {
    if (typeof response.text === "function") {
      return await response.text();
    }
    if (typeof response.json === "function") {
      return JSON.stringify(await response.json());
    }
    return "";
  } catch {
    return "";
  }
}

export async function fetchModelsFromEndpoint(
  baseUrl: string,
  apiKey: string
): Promise<string[]> {
  const result = await checkEndpointCompatibility(baseUrl, apiKey);
  return result.models;
}

export async function checkEndpointCompatibility(
  baseUrl: string,
  apiKey: string
): Promise<EndpointCompatibilityResult> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const rawText = await safeReadResponseText(res);
      const statusMessage = `endpoint returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      const detail = rawText.trim() ? ` — ${formatInvalidJsonDiagnostic(rawText)}` : "";
      return { ok: false, models: [], message: `${statusMessage}${detail}` };
    }

    const rawText = await safeReadResponseText(res);
    try {
      const json = JSON.parse(rawText) as any;
      if (json && Array.isArray(json.data)) {
        const seen = new Set<string>();
        const models = json.data
          .map((m: any) => m?.id)
          .filter((id: any): id is string => {
            if (typeof id !== "string") return false;
            const trimmed = id.trim();
            if (trimmed.length === 0 || trimmed.length > 256) return false;
            if (seen.has(trimmed)) return false;
            seen.add(trimmed);
            return true;
          });
        return { ok: true, models };
      }
      return {
        ok: false,
        models: [],
        message: "endpoint /models response missing expected JSON shape: { data: [{ id: string }] }",
      };
    } catch {
      return {
        ok: false,
        models: [],
        message: formatInvalidJsonDiagnostic(rawText),
      };
    }
  } catch (error: any) {
    return {
      ok: false,
      models: [],
      message: error?.message || "failed to reach endpoint /models",
    };
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
