export type ProviderType = "openrouter" | "openai" | "anthropic" | "gemini" | "custom" | "custom-anthropic";
import { ensureProtocol } from "./config/paths.js";

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
  if (lc === "2" || (lc.includes("openai") && !lc.includes("custom"))) return "openai";
  if (lc === "3" || (lc.includes("anthropic") && !lc.includes("custom"))) return "anthropic";
  if (lc === "6" || lc.includes("gemini") || lc.includes("google")) return "gemini";
  if (lc.includes("custom anthropic") || lc === "5") return "custom-anthropic";
  if (lc.includes("custom openai") || lc.includes("custom") || lc === "4") return "custom";
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
    case "custom-anthropic":
      return [
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
      ];
    case "openai":
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
    case "gemini":
      return [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
      ];
    default:
      return ["gpt-4o", "gpt-4o-mini"];
  }
}

export function getModelOptions(providerType: string, cachedModels: string[]): string[] {
  const fallback = getFallbackModels(providerType as ProviderType);
  let models = cachedModels.length > 0 ? cachedModels : fallback;
  if (providerType === "anthropic" || providerType === "custom-anthropic") {
    const filtered = models.filter((m) => m.includes("claude"));
    models = filtered.length > 0 ? filtered : fallback;
  } else if (providerType === "openai") {
    const filtered = models.filter(
      (m) => m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")
    );
    models = filtered.length > 0 ? filtered : fallback;
  } else if (providerType === "gemini") {
    const filtered = models.filter((m) => m.startsWith("gemini-"));
    models = filtered.length > 0 ? filtered : fallback;
  }
  return models.slice(0, 15);
}

export function resolveTestModel(providerType: string, baseUrl: string): string {
  if (providerType === "gemini") return "gemini-2.5-flash";
  if (providerType === "anthropic" || providerType === "custom-anthropic") return "claude-3-haiku-20240307";
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

export interface CustomProviderMessageTestResult {
  ok: boolean;
  text?: string;
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

function extractOpenAiMessageText(json: any): string {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const content = choice?.message?.content ?? choice?.text ?? choice?.delta?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part?.text ?? part?.content ?? "")
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("");
  }
  return "";
}

function extractSseMessageText(rawText: string): string {
  const chunks: string[] = [];
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      const text = extractOpenAiMessageText(json);
      if (text) chunks.push(text);
    } catch {
      // Ignore malformed SSE frames and keep scanning for usable content.
    }
  }
  return chunks.join("");
}

export async function testCustomProviderMessage(
  baseUrl: string,
  apiKey: string,
  model: string,
  message: string
): Promise<CustomProviderMessageTestResult> {
  try {
    baseUrl = ensureProtocol(baseUrl) as string;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: message }],
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });

    const rawText = await safeReadResponseText(res);
    if (!res.ok) {
      const statusMessage = `endpoint returned HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
      const detail = rawText.trim() ? ` — ${formatInvalidJsonDiagnostic(rawText)}` : "";
      return { ok: false, message: `${statusMessage}${detail}` };
    }

    try {
      const json = JSON.parse(rawText);
      const text = extractOpenAiMessageText(json);
      if (text) return { ok: true, text };
      return { ok: false, message: "endpoint /chat/completions response missing assistant text in OpenAI-compatible JSON" };
    } catch {
      const sseText = extractSseMessageText(rawText);
      if (sseText) return { ok: true, text: sseText };
      return { ok: false, message: formatInvalidJsonDiagnostic(rawText) };
    }
  } catch (error: any) {
    return { ok: false, message: error?.message || "failed to reach endpoint /chat/completions" };
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
    baseUrl = ensureProtocol(baseUrl) as string;
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
