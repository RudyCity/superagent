export type ProviderType =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "gemini"
  | "custom"
  | "custom-anthropic"
  | "opencode"
  | "deepseek"
  | "xai"
  | "mistral"
  | "groq"
  | "azure"
  | "zai"
  | "kimi"
  | "cerebras"
  | "together"
  | "fireworks"
  | "ollama"
  | "lmstudio"
  | "tokenrouter"
  | "commandcode"
  | "zenmux";

// User-facing list shown in the provider picker (CLI wizard + dashboard wizard).
// Adding a provider here is a single-source-of-truth change; the UI sites
// (useLoginWizard, useDashboardWizard, useKeyboardHandler, useDashboardKeyboard)
// all consume this array.
export const PROVIDER_TEMPLATE_OPTIONS: ReadonlyArray<{
  key: string;
  label: string;
  type: ProviderType;
}> = [
  { key: "1", label: "OpenRouter",                   type: "openrouter" },
  { key: "2", label: "OpenAI",                       type: "openai" },
  { key: "3", label: "Anthropic",                    type: "anthropic" },
  { key: "4", label: "Custom OpenAI Endpoint",       type: "custom" },
  { key: "5", label: "Custom Anthropic Endpoint",    type: "custom-anthropic" },
  { key: "6", label: "Google Gemini",                type: "gemini" },
  { key: "7", label: "OpenCode Zen (Free Models)",   type: "opencode" },
  { key: "8",  label: "DeepSeek",                    type: "deepseek" },
  { key: "9",  label: "xAI (Grok)",                  type: "xai" },
  { key: "10", label: "Mistral",                     type: "mistral" },
  { key: "11", label: "Groq",                        type: "groq" },
  { key: "12", label: "Azure OpenAI",                type: "azure" },
  { key: "13", label: "Z.AI (GLM)",                  type: "zai" },
  { key: "14", label: "Kimi (Moonshot)",             type: "kimi" },
  { key: "15", label: "Cerebras",                    type: "cerebras" },
  { key: "16", label: "Together AI",                 type: "together" },
  { key: "17", label: "Fireworks AI",                type: "fireworks" },
  { key: "18", label: "Ollama (Local)",              type: "ollama" },
  { key: "19", label: "LM Studio (Local)",           type: "lmstudio" },
  { key: "20", label: "TokenRouter",                 type: "tokenrouter" },
  { key: "21", label: "CommandCode",                 type: "commandcode" },
  { key: "22", label: "ZenMux",                      type: "zenmux" },
];

export const PROVIDER_TEMPLATE_OPTION_KEYS: ReadonlySet<string> = new Set(
  PROVIDER_TEMPLATE_OPTIONS.map((p) => p.key)
);

// UI-ready labels: "1. OpenRouter", "2. OpenAI", ...
// Single source of truth consumed by every wizard UI surface.
export const PROVIDER_TEMPLATE_LABELS: readonly string[] =
  PROVIDER_TEMPLATE_OPTIONS.map((p) => `${p.key}. ${p.label}`);

/**
 * Resolve a wizard option string (e.g. "4. Custom OpenAI Endpoint" or a typed
 * number) back to its ProviderType. Resolution order:
 *   1. Exact numeric key match ("4" or prefix "4.") — authoritative.
 *   2. Longest label substring match (so "Custom OpenAI Endpoint" wins over
 *      the shorter "OpenAI" label).
 * Returns null when nothing matches.
 */
export function resolveProviderTemplateChoice(option: string): ProviderType | null {
  const trimmed = option.trim();
  const numericMatch = trimmed.match(/^(\d+)/);
  if (numericMatch) {
    const byKey = PROVIDER_TEMPLATE_OPTIONS.find((p) => p.key === numericMatch[1]);
    if (byKey) return byKey.type;
  }
  const lc = trimmed.toLowerCase();
  let best: (typeof PROVIDER_TEMPLATE_OPTIONS)[number] | undefined;
  for (const p of PROVIDER_TEMPLATE_OPTIONS) {
    if (lc.includes(p.label.toLowerCase())) {
      if (!best || p.label.length > best.label.length) best = p;
    }
  }
  return best ? best.type : null;
}

// Model-override wizard shows the full provider list (numeric keys stay aligned
// with PROVIDER_TEMPLATE_OPTIONS.key so typed numbers resolve correctly), plus
// an unnumbered "Not Set" action and "< Back".
export const MODEL_OVERRIDE_TEMPLATE_LABELS: readonly string[] = [
  ...PROVIDER_TEMPLATE_LABELS,
  "Not Set (Clear Override)",
  "< Back",
];

/**
 * Default baseUrl for each provider (cloud-hosted). Empty string means
 * the provider is local / variable and the user must supply the URL.
 */
export const PROVIDER_DEFAULT_BASE_URLS: Readonly<Record<ProviderType, string>> = {
  openrouter:      "https://openrouter.ai/api/v1",
  openai:          "",
  anthropic:       "",
  gemini:          "",
  custom:          "",
  "custom-anthropic": "",
  opencode:        "https://opencode.ai/zen/v1",
  deepseek:        "https://api.deepseek.com",
  xai:             "https://api.x.ai/v1",
  mistral:         "https://api.mistral.ai/v1",
  groq:            "https://api.groq.com/openai/v1",
  azure:           "",
  zai:             "https://api.z.ai/v1",
  kimi:            "https://api.moonshot.cn/v1",
  cerebras:        "https://api.cerebras.ai/v1",
  together:        "https://api.together.xyz/v1",
  fireworks:       "https://api.fireworks.ai/inference/v1",
  ollama:          "http://localhost:11434/v1",
  lmstudio:        "http://localhost:1234/v1",
  tokenrouter:     "https://tokenrouter.me/v1",
  commandcode:     "https://api.commandcode.ai/v1",
  zenmux:          "https://zenmux.ai/api/v1",
};

/**
 * Returns the default test model used by the wizard when fetching the model
 * list from the endpoint fails. Returns `null` for providers whose model
 * list should be queried before any fallback is shown.
 */
export function getDefaultModels(providerType: ProviderType): string[] {
  switch (providerType) {
    case "openrouter":
      return [
        "google/gemini-2.5-flash",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-chat",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
      ];
    case "anthropic":
    case "custom-anthropic":
      return [
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
      ];
    case "openai":
      return [
        "gpt-4o",
        "gpt-4o-mini",
        "o1",
        "o1-mini",
        "o3-mini",
        "gpt-4-turbo",
      ];
    case "gemini":
      return [
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
      ];
    case "opencode":
      return [
        "x-preview-f-free",
        "claude-sonnet-4-5",
        "gpt-5",
      ];
    case "deepseek":
      return [
        "deepseek-chat",
        "deepseek-coder",
        "deepseek-reasoner",
      ];
    case "xai":
      return [
        "grok-2",
        "grok-2-mini",
        "grok-beta",
      ];
    case "mistral":
      return [
        "mistral-large-latest",
        "mistral-small-latest",
        "codestral-latest",
      ];
    case "groq":
      return [
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant",
        "mixtral-8x7b-32768",
      ];
    case "azure":
      // Azure deployments are user-named; supply reasonable starters.
      return [
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
      ];
    case "zai":
      return [
        "glm-4.6",
        "glm-4.5",
      ];
    case "kimi":
      return [
        "kimi-k2-instruct",
        "moonshot-v1-128k",
        "moonshot-v1-32k",
      ];
    case "cerebras":
      return [
        "llama-3.3-70b",
        "llama-3.1-8b",
      ];
    case "together":
      return [
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      ];
    case "fireworks":
      return [
        "accounts/fireworks/models/llama-v3p3-70b-instruct",
        "accounts/fireworks/models/llama-v3p1-8b-instruct",
      ];
    case "ollama":
      return [
        "llama3.2",
        "qwen2.5",
      ];
    case "lmstudio":
      return [
        "llama-3.1-8b-instruct",
        "qwen2.5-7b-instruct",
      ];
    case "tokenrouter":
    case "commandcode":
    case "zenmux":
      return ["gpt-4o-mini", "claude-3-5-haiku-20241022"];
    case "custom":
    default:
      return ["gpt-4o-mini"];
  }
}

export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
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
  // NOTE: zenmux MUST be resolved before opencode — "zenmux" contains "zen",
  // which would otherwise be captured by the opencode keyword rule below.
  if (lc === "20" || lc.includes("tokenrouter")) return "tokenrouter";
  if (lc === "21" || lc.includes("commandcode")) return "commandcode";
  if (lc === "22" || lc.includes("zenmux")) return "zenmux";
  if (lc === "7" || lc.includes("opencode") || lc.includes("zen")) return "opencode";
  if (lc === "8" || lc.includes("deepseek")) return "deepseek";
  if (lc === "9" || (lc.includes("xai") || lc.includes("grok") || lc.includes("x.ai"))) return "xai";
  if (lc === "10" || (lc.includes("mistral") || lc.includes("codestral"))) return "mistral";
  if (lc === "11" || lc.includes("groq")) return "groq";
  if (lc === "12" || (lc.includes("azure") && lc.includes("openai")) || lc === "azure") return "azure";
  if (lc === "13" || lc.includes("z.ai") || lc.includes("zai") || lc.includes("glm")) return "zai";
  if (lc === "14" || lc.includes("kimi") || lc.includes("moonshot")) return "kimi";
  if (lc === "15" || lc.includes("cerebras")) return "cerebras";
  if (lc === "16" || (lc.includes("together") && lc.includes("ai"))) return "together";
  if (lc === "17" || lc.includes("fireworks")) return "fireworks";
  if (lc === "18" || lc.includes("ollama")) return "ollama";
  if (lc === "19" || (lc.includes("lmstudio") || lc.includes("lm studio"))) return "lmstudio";
  if (lc === "6" || lc.includes("gemini") || lc.includes("google")) return "gemini";
  if (lc.includes("custom anthropic") || lc === "5") return "custom-anthropic";
  if (lc.includes("custom openai") || lc.includes("custom") || lc === "4") return "custom";
  return null;
}

export function buildProviderOptions(providers: ConfiguredProvider[]): string[] {
  return providers.map((p, i) => {
    const label = p.provider || p.type || "unknown";
    const urlPart = p.baseUrl ? ` (${p.baseUrl})` : "";
    return `${i + 1}. ${p.name} [${label}]${urlPart}`;
  });
}

export function getFallbackModels(providerType: ProviderType): string[] {
  switch (providerType) {
    case "openrouter":
      return [
        "google/gemini-2.5-flash",
        "meta-llama/llama-3.3-70b-instruct",
        "deepseek/deepseek-chat",
        "anthropic/claude-3.5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini",
      ];
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
    case "opencode":
      return [
        "x-preview-f-free",
        "big-pickle",
        "mimo-v2.5-free",
        "hy3-free",
        "nemotron-3-ultra-free",
        "nemotron-3.5-lightning-free",
      ];
    // New native SDK providers
    case "deepseek":
      return ["deepseek-chat", "deepseek-coder", "deepseek-reasoner"];
    case "xai":
      return ["grok-2", "grok-2-mini", "grok-beta"];
    case "mistral":
      return ["mistral-large-latest", "mistral-small-latest", "codestral-latest"];
    case "groq":
      return ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"];
    case "azure":
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
    // OpenAI-compatible first-class providers
    case "zai":
      return ["glm-4.6", "glm-4.5"];
    case "kimi":
      return ["kimi-k2-instruct", "moonshot-v1-128k", "moonshot-v1-32k"];
    case "cerebras":
      return ["llama-3.3-70b", "llama-3.1-8b"];
    case "together":
      return [
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo",
      ];
    case "fireworks":
      return [
        "accounts/fireworks/models/llama-v3p3-70b-instruct",
        "accounts/fireworks/models/llama-v3p1-8b-instruct",
      ];
    case "ollama":
      return ["llama3.2", "qwen2.5"];
    case "lmstudio":
      return ["llama-3.1-8b-instruct", "qwen2.5-7b-instruct"];
    // Gateway providers: the live /models fetch supersedes these offline
    // fallbacks whenever the endpoint responds.
    case "tokenrouter":
    case "commandcode":
    case "zenmux":
      return ["gpt-4o-mini", "claude-3-5-haiku-20241022"];
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
  } else if (providerType === "openrouter") {
    const popular = [
      "google/gemini-2.5-flash",
      "meta-llama/llama-3.3-70b-instruct",
      "deepseek/deepseek-chat",
      "anthropic/claude-3.5-sonnet",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
    ];
    const top = popular.filter((p) => models.includes(p));
    const rest = models.filter((m) => !popular.includes(m));
    models = [...top, ...rest];
  } else if (providerType === "custom") {
    const filtered = models.filter((m) => !m.includes("/") || m.startsWith("custom/"));
    models = filtered.length > 0 ? filtered : fallback;
  }
  return models.slice(0, 15);
}

export function resolveProfileFromPicker(
  value: string,
  providerType: string,
  providers: ConfiguredProvider[]
): ConfiguredProvider | undefined {
  const matching = providers.filter((p) => {
    const typeLower = (p.provider || p.type || "").toLowerCase();
    if (providerType === "anthropic") {
      return typeLower === "anthropic" && !p.baseUrl;
    }
    if (providerType === "custom-anthropic") {
      return typeLower === "anthropic" && !!p.baseUrl;
    }
    return typeLower === providerType.toLowerCase();
  });

  const trimmed = value.trim();
  const numMatch = trimmed.match(/^(\d+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1], 10) - 1;
    if (idx >= 0 && idx < matching.length) {
      return matching[idx];
    }
    if (idx >= 0 && idx < providers.length) {
      return providers[idx];
    }
  }

  const cleanVal = trimmed.replace(/^\d+\.\s*/, "").trim();
  const profileName = cleanVal.split(" (key:")[0].trim().toLowerCase();

  let found = matching.find(
    (p) => p.name.toLowerCase() === profileName || p.id.toLowerCase() === profileName
  );
  if (!found) {
    found = providers.find(
      (p) => p.name.toLowerCase() === profileName || p.id.toLowerCase() === profileName
    );
  }
  if (!found && matching.length > 0) {
    found = matching.find(
      (p) =>
        p.name.toLowerCase().includes(profileName) ||
        profileName.includes(p.name.toLowerCase())
    );
  }

  return found;
}

export const DEFAULT_API_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Superagent/1.0",
  "HTTP-Referer": "https://github.com/RudyCity/superagent",
  "X-Title": "SuperAgent CLI",
};

export async function fetchModelsForProvider(
  providerType: string,
  apiKey: string,
  baseUrl: string
): Promise<string[]> {
  let url = "";
  const headers: Record<string, string> = { ...DEFAULT_API_HEADERS };
  const cleanUrl = baseUrl ? (ensureProtocol(baseUrl) as string) : "";
  const cleanBase = cleanUrl.replace(/\/(chat\/completions|models)\/?$/i, "").replace(/\/+$/, "");

  if (providerType === "openrouter") {
    url = "https://openrouter.ai/api/v1/models";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (providerType === "openai") {
    url = cleanBase ? `${cleanBase}/models` : "https://api.openai.com/v1/models";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (providerType === "opencode") {
    url = cleanBase ? `${cleanBase}/models` : `${OPENCODE_ZEN_BASE_URL}/models`;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (providerType === "gemini") {
    if (!apiKey) return [];
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  } else if (
    providerType === "deepseek" ||
    providerType === "xai" ||
    providerType === "mistral" ||
    providerType === "groq" ||
    providerType === "zai" ||
    providerType === "kimi" ||
    providerType === "cerebras" ||
    providerType === "together" ||
    providerType === "fireworks" ||
    providerType === "tokenrouter" ||
    providerType === "commandcode" ||
    providerType === "zenmux"
  ) {
    // All new OpenAI-compatible cloud providers expose /v1/models.
    const fallbackBase = PROVIDER_DEFAULT_BASE_URLS[providerType as ProviderType] || "";
    url = cleanBase ? `${cleanBase}/models` : (fallbackBase ? `${fallbackBase.replace(/\/$/, "")}/models` : "");
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (providerType === "azure") {
    // Azure OpenAI requires a deployment name rather than a model name in
    // /chat/completions, so /models is not directly queryable in the same
    // way. Defer to caller; return empty so the wizard shows fallback list.
    return [];
  } else if (providerType === "ollama" || providerType === "lmstudio") {
    // Local servers often expose /models. Some (LM Studio) require no auth.
    const localFallback = PROVIDER_DEFAULT_BASE_URLS[providerType as ProviderType];
    url = cleanBase ? `${cleanBase}/models` : `${localFallback.replace(/\/$/, "")}/models`;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (cleanBase) {
    url = `${cleanBase}/models`;
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  }

  if (!url) return [];

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Authentication rejected by ${providerType} (HTTP ${res.status}) — the API key is invalid or revoked.`
      );
    }
    if (!res.ok) {
      throw new Error(`${providerType} model list returned HTTP ${res.status}.`);
    }
    const json = (await res.json()) as any;
    const isDataArray = Array.isArray(json?.data);
    const dataArr = isDataArray
      ? json.data
      : Array.isArray(json?.models)
      ? json.models
      : Array.isArray(json)
      ? json
      : null;

    if (dataArr) {
      const seen = new Set<string>();
      return dataArr
        .map((m: any) => {
          if (typeof m === "string") return m;
          if (isDataArray) {
            return typeof m?.id === "string" ? m.id : null;
          }
          const rawId = m?.id || (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : null) || m?.model;
          return typeof rawId === "string" ? rawId : null;
        })
        .filter((id: any): id is string => {
          if (typeof id !== "string") return false;
          const trimmed = id.trim();
          if (trimmed.length === 0 || trimmed.length > 256) return false;
          if (seen.has(trimmed)) return false;
          seen.add(trimmed);
          return true;
        });
    }
    // Auth ok but response shape unrecognized — treat as empty list, not error.
    return [];
  } catch (err: any) {
    // Re-throw auth/clear errors so the caller can surface them.
    if (err?.message && /Authentication rejected|HTTP \d{3}/.test(err.message)) throw err;
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      throw new Error(`Network timeout contacting ${providerType} — check your connection.`);
    }
    if (err?.cause?.code === "ENOTFOUND" || err?.cause?.code === "ECONNREFUSED") {
      throw new Error(`Network error contacting ${providerType}: ${err.message}`);
    }
    // Unknown error: surface as a generic network failure rather than silently swallowing.
    throw new Error(`Failed to fetch models from ${providerType}: ${err?.message || "unknown error"}`);
  }
}

export function resolveTestModel(providerType: string, baseUrl: string): string {
  // Test-connection model = cheapest/fastest known-good model per provider
  // (NOT the recommended default, which may be expensive). Keep in sync with
  // getFallbackModels() ordering.
  switch (providerType) {
    case "gemini": return "gemini-2.5-flash";
    case "anthropic":
    case "custom-anthropic": return "claude-3-haiku-20240307";
    case "opencode": return "x-preview-f-free";
    case "deepseek": return "deepseek-chat";
    case "xai": return "grok-2-mini";
    case "mistral": return "mistral-small-latest";
    case "groq": return "llama-3.1-8b-instant";
    case "azure": return "gpt-4o-mini";
    case "zai": return "glm-4.5";
    case "kimi": return "moonshot-v1-32k";
    case "cerebras": return "llama-3.1-8b";
    case "together": return "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo";
    case "fireworks": return "accounts/fireworks/models/llama-v3p1-8b-instruct";
    case "tokenrouter":
    case "commandcode":
    case "zenmux": return "gpt-4o-mini";
    case "ollama": return "llama3.2";
    case "lmstudio": return "llama-3.1-8b-instruct";
    default:
      break; // fall through to openrouter/generic handling below
  }
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

  // Attempt to parse JSON error responses directly
  try {
    const json = JSON.parse(trimmed);
    const errMsg = json?.error?.message || json?.message || (typeof json?.error === "string" ? json.error : null);
    if (errMsg && typeof errMsg === "string") {
      return errMsg;
    }
  } catch {
    // Not valid JSON, proceed with standard diagnostics
  }

  if (
    trimmed.includes("Vercel Security Checkpoint") ||
    trimmed.includes("verifying your browser") ||
    trimmed.includes("Just a moment...") ||
    trimmed.includes("Cloudflare")
  ) {
    return "endpoint blocked by Vercel/Cloudflare Security Checkpoint (WAF Bot Protection)";
  }

  const oneLine = trimmed.replace(/\s+/g, " ").slice(0, 160);
  if (trimmed.startsWith("<") || trimmed.includes("<!DOCTYPE")) {
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
  let content = choice?.message?.content ?? choice?.text ?? choice?.delta?.content;
  if (!content || (typeof content === "string" && !content.trim())) {
    const reasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (typeof reasoning === "string" && reasoning.trim()) {
      content = reasoning;
    }
  }
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...DEFAULT_API_HEADERS,
    };
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
    const cleanBase = baseUrl.replace(/\/(chat\/completions|models)\/?$/i, "").replace(/\/+$/, "");
    const url = `${cleanBase}/models`;
    const headers: Record<string, string> = { ...DEFAULT_API_HEADERS };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(4000),
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
      const isDataArray = Array.isArray(json?.data);
      const dataArr = isDataArray
        ? json.data
        : Array.isArray(json?.models)
        ? json.models
        : Array.isArray(json)
        ? json
        : null;

      if (dataArr) {
        const seen = new Set<string>();
        const models = dataArr
          .map((m: any) => {
            if (typeof m === "string") return m;
            if (isDataArray) {
              return typeof m?.id === "string" ? m.id : null;
            }
            const rawId = m?.id || (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : null) || m?.model;
            return typeof rawId === "string" ? rawId : null;
          })
          .filter((id: any): id is string => {
            if (typeof id !== "string") return false;
            const trimmed = id.trim();
            if (trimmed.length === 0 || trimmed.length > 256) return false;
            if (seen.has(trimmed)) return false;
            seen.add(trimmed);
            return true;
          });
        if (models.length > 0) {
          return { ok: true, models };
        }
      }
      return {
        ok: false,
        models: [],
        message: "endpoint /models response missing expected JSON shape with model array",
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
    providerType === "ollama" ||
    providerType === "lmstudio" ||
    providerType === "zai" ||
    providerType === "kimi" ||
    providerType === "cerebras" ||
    providerType === "together" ||
    providerType === "fireworks" ||
    providerType === "tokenrouter" ||
    providerType === "commandcode" ||
    providerType === "zenmux" ||
    (baseUrl &&
      !baseUrl.includes("openrouter.ai") &&
      !baseUrl.includes("api.openai.com") &&
      !baseUrl.includes("anthropic.com") &&
      !baseUrl.includes("api.deepseek.com") &&
      !baseUrl.includes("api.x.ai") &&
      !baseUrl.includes("api.mistral.ai") &&
      !baseUrl.includes("api.groq.com"))
  ) {
    // Use effective baseUrl: explicit, or per-provider default.
    let effectiveBaseUrl = baseUrl;
    if (!effectiveBaseUrl) {
      const preset = PROVIDER_DEFAULT_BASE_URLS[providerType as ProviderType];
      if (preset) effectiveBaseUrl = preset;
    }
    if (effectiveBaseUrl) {
      const models = await fetchModelsFromEndpoint(effectiveBaseUrl, apiKey);
      if (models.length > 0) {
        return models[0];
      }
    }
  }
  return resolveTestModel(providerType, baseUrl);
}
