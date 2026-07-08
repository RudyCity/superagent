import fs from "fs";
import path from "path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getStaticModelLimit } from "../model_limits.js";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { getConfig } from "./base.js";
import { getConfiguredProviders, getEffectiveMasterModel } from "./providers.js";
import { loadModelConfig, getActivePreset, TierModelConfig, getSettings } from "./jsonConfig.js";

export async function fetchAndCacheModels(): Promise<void> {
  const providers = getConfiguredProviders();
  const cache: Record<string, number> = {};

  const fetchPromises = providers.map(async (provider) => {
    if (provider.type === "anthropic") return;

    let url = "";
    const headers: Record<string, string> = {};
    const apiKey = provider.apiKey || "";
    const baseUrl = provider.baseUrl || "";

    if (provider.type === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
    } else if (provider.type === "openai") {
      url = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/models` : "https://api.openai.com/v1/models";
    } else if (provider.type === "gemini") {
      // Google Gemini: use the generativelanguage REST API models endpoint
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    } else if (provider.type === "custom" && baseUrl) {
      url = `${baseUrl.replace(/\/+$/, "")}/models`;
    }

    if (!url) return;
    if (apiKey && provider.type !== "gemini") {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return;
      const json = await res.json() as any;
      // Google Gemini models API returns { models: [{ name: "models/gemini-2.5-flash", ... }] }
      const dataArr = Array.isArray(json.data) ? json.data : (Array.isArray(json.models) ? json.models : null);
      if (dataArr) {
        for (const m of dataArr) {
          // OpenAI-style: { id: string } | Google-style: { name: "models/xxx" }
          const rawId = m?.id || (typeof m?.name === "string" ? m.name.replace(/^models\//, "") : null);
          if (!rawId) continue;
          const limit =
            m.context_length ||
            m.max_model_len ||
            m.max_position_embeddings ||
            (m.metadata &&
              (m.metadata.context_length ||
                m.metadata.max_model_len ||
                m.metadata.max_position_embeddings));
          if (limit && typeof limit === "number") {
            cache[rawId] = limit;
          }
        }
      }
    } catch (err) {
      // Ignore individual fetch errors
    }
  });

  await Promise.allSettled(fetchPromises);

  if (Object.keys(cache).length > 0) {
    try {
      ensureGlobalConfigDir();
      const cachePath = path.join(getRootConfigDir(), "models_cache.json");
      let existingCache: Record<string, number> = {};
      if (fs.existsSync(cachePath)) {
        try {
          existingCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        } catch {}
      }
      const updatedCache = { ...existingCache, ...cache };
      fs.writeFileSync(cachePath, JSON.stringify(updatedCache, null, 2), "utf-8");
    } catch (err) {
      // Ignore write errors
    }
  }
}

/** Returns the list of model IDs cached from the last successful API fetch. */
export function getCachedModelIds(): string[] {
  try {
    const cachePath = path.join(getRootConfigDir(), "models_cache.json");
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, number>;
      return Object.keys(cache);
    }
  } catch {
    // Ignore
  }
  return [];
}

export function getContextWindowLimit(model: string): number {
  // 1. JSON config override (centralized settings)
  const jsonLimit = getSettings().contextWindowLimit;
  if (jsonLimit > 0) return jsonLimit;

  // 2. Read from models_cache.json
  try {
    const cachePath = path.join(getRootConfigDir(), "models_cache.json");
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (cache && typeof cache[model] === "number") {
        return cache[model];
      }
    }
  } catch (err) {
    // Ignore cache read errors
  }

  // 3. Fallback to rich static lookup
  const staticLimit = getStaticModelLimit(model);
  if (staticLimit !== null) {
    return staticLimit;
  }

  // Default fallback
  return 256000;
}

export function isAnthropicCompatible(baseUrl: string, modelName: string): boolean {
  const urlLower = baseUrl.toLowerCase();
  const modelLower = modelName.toLowerCase();
  if (urlLower.includes("anthropic")) return true;
  if (
    urlLower.includes("openrouter.ai") ||
    urlLower.includes("openai.com") ||
    urlLower.includes("litellm") ||
    urlLower.includes("ollama") ||
    urlLower.includes("groq") ||
    urlLower.includes("deepinfra") ||
    urlLower.includes("together")
  ) {
    return false;
  }
  return modelLower.includes("claude");
}

export function extractJSON(text: string): string {
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let startIdx = -1;

  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = firstBrace < firstBracket ? firstBrace : firstBracket;
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  if (startIdx === -1) {
    return text;
  }

  let braceCount = 0;
  let bracketCount = 0;
  let inString = false;
  let stringChar = "";
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (inString) {
      if (char === stringChar) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === "{") {
      braceCount++;
    } else if (char === "}") {
      braceCount--;
    } else if (char === "[") {
      bracketCount++;
    } else if (char === "]") {
      bracketCount--;
    }

    if (braceCount === 0 && bracketCount === 0) {
      return text.substring(startIdx, i + 1);
    }
  }

  return text;
}

export function reconstructChatCompletionFromSse(rawText: string): any {
  let accumulatedText = "";
  const toolCallsMap = new Map<number, { id?: string; type?: string; name?: string; arguments: string }>();
  let firstChunkJson: any = {};

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const json = JSON.parse(payload);
      if (!firstChunkJson.id && json.id) {
        firstChunkJson = json;
      }
      
      const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
      if (choice) {
        const content = choice.delta?.content ?? choice.message?.content ?? choice.text;
        if (typeof content === "string") {
          accumulatedText += content;
        } else if (Array.isArray(content)) {
          accumulatedText += content
            .map((part) => part?.text ?? part?.content ?? "")
            .filter((part) => typeof part === "string" && part.length > 0)
            .join("");
        }

        const deltaToolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
        if (Array.isArray(deltaToolCalls)) {
          for (const tc of deltaToolCalls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, { arguments: "" });
            }
            const current = toolCallsMap.get(idx)!;
            if (tc.id) current.id = tc.id;
            if (tc.type) current.type = tc.type;
            if (tc.function?.name) current.name = tc.function.name;
            if (tc.function?.arguments) current.arguments += tc.function.arguments;
          }
        }
      }
    } catch {
      // Ignore parsing errors of individual lines
    }
  }

  const choicesMessage: any = {
    role: "assistant",
    content: accumulatedText || null,
  };

  if (toolCallsMap.size > 0) {
    const toolCalls = Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([_, tc]) => ({
        id: tc.id || `call_${Math.random().toString(36).substring(2, 11)}`,
        type: tc.type || "function",
        function: {
          name: tc.name || "",
          arguments: tc.arguments,
        },
      }));
    choicesMessage.tool_calls = toolCalls;
  }

  return {
    id: firstChunkJson.id || "chatcmpl-mock",
    object: "chat.completion",
    created: firstChunkJson.created || Math.floor(Date.now() / 1000),
    model: firstChunkJson.model || "custom-model",
    choices: [
      {
        index: 0,
        message: choicesMessage,
        finish_reason: toolCallsMap.size > 0 ? "tool_calls" : "stop",
      },
    ],
  };
}

export function getModelInstance() {
  const config = getConfig();
  return getModelInstanceForString(config.model);
}


export function getModelInstanceForString(modelStr: string) {
  const config = getConfig();
  
  if (!modelStr) {
    modelStr = config.model;
  }

  let provider = config.provider;
  let modelName = modelStr;
  let apiKey = config.apiKey;
  let baseUrl = config.baseUrl;

  // Prefer `@` as the unambiguous profile/model separator. Fall back to `:` for
  // backward compatibility, but only treat it as a separator when the prefix
  // does not contain `/` (so model IDs like openrouter/nex-agi/nex-n2-pro:free
  // are not split at the pricing-tier colon).
  const atIndex = modelStr.indexOf("@");
  const colonIndex = modelStr.indexOf(":");
  let separatorIndex = -1;
  if (atIndex > 0) {
    separatorIndex = atIndex;
  } else if (colonIndex > 0 && !modelStr.substring(0, colonIndex).includes("/")) {
    separatorIndex = colonIndex;
  }
  const prefixBeforeSeparator = separatorIndex > 0 ? modelStr.substring(0, separatorIndex).toLowerCase() : "";
  const isProviderPrefix = separatorIndex > 0 && !prefixBeforeSeparator.includes("/");
  if (isProviderPrefix) {
    const prefix = prefixBeforeSeparator;
    const rest = modelStr.substring(separatorIndex + 1);
    const modelConfig = loadModelConfig();

    if (prefix === "anthropic") {
      provider = "anthropic";
      modelName = rest;
      baseUrl = undefined;
      const anthropicProfile = modelConfig.providers.find(
        (p) => p.provider === "anthropic" && p.apiKey && p.apiKey.trim() !== ""
      );
      if (anthropicProfile) {
        apiKey = anthropicProfile.apiKey;
      }
    } else if (prefix === "openai") {
      provider = "openai";
      modelName = rest;
      baseUrl = undefined;
      const openaiProfile = modelConfig.providers.find(
        (p) => p.provider === "openai" && p.apiKey && p.apiKey.trim() !== ""
      );
      if (openaiProfile) {
        apiKey = openaiProfile.apiKey;
      }
    } else if (prefix === "custom") {
      provider = "custom";
      modelName = rest;
      const customProfile = modelConfig.providers.find(
        (p) => p.provider === "custom" && p.apiKey && p.apiKey.trim() !== ""
      );
      if (customProfile) {
        apiKey = customProfile.apiKey;
        baseUrl = customProfile.baseUrl || undefined;
      }
    } else if (prefix === "gemini") {
      provider = "gemini";
      modelName = rest;
      baseUrl = undefined;
      const geminiProfile = modelConfig.providers.find(
        (p) => p.provider === "gemini" && p.apiKey && p.apiKey.trim() !== ""
      );
      if (geminiProfile) {
        apiKey = geminiProfile.apiKey;
      }
    } else {
      // Find provider by ID or name in JSON config
      const matchedProvider = modelConfig.providers?.find(
        p => p.id?.toLowerCase() === prefix || p.name?.toLowerCase() === prefix
      );
      if (matchedProvider) {
        apiKey = matchedProvider.apiKey || "";
        baseUrl = matchedProvider.baseUrl || undefined;
        modelName = rest;
        const typeLower = (matchedProvider.provider || "").toLowerCase();

        // Fallback: if matched profile has empty apiKey, scan for other profiles of same provider type
        if (!apiKey || apiKey.trim() === "") {
          const fallbackProfile = modelConfig.providers.find(
            (p) => p.id !== matchedProvider.id && (p.provider || "").toLowerCase() === typeLower && p.apiKey && p.apiKey.trim() !== ""
          );
          if (fallbackProfile) {
            apiKey = fallbackProfile.apiKey;
            baseUrl = fallbackProfile.baseUrl || baseUrl;
          }
        }

        if (typeLower === "openrouter") {
          provider = "custom";
          if (!baseUrl) {
            baseUrl = "https://openrouter.ai/api/v1";
          }
        } else if (typeLower === "gemini") {
          provider = "gemini";
          baseUrl = undefined;
        } else if (typeLower === "anthropic") {
          // If the profile has a custom baseUrl that is NOT an official Anthropic endpoint,
          // treat it as an OpenAI-compatible (custom) provider. Local servers (e.g. Orbit,
          // LiteLLM, OpenCode) use the OpenAI API format and reject the Anthropic SDK headers,
          // causing 401 Unauthorized errors.
          const isOfficialAnthropic = !matchedProvider.baseUrl ||
            matchedProvider.baseUrl.trim() === "" ||
            matchedProvider.baseUrl.toLowerCase().includes("anthropic.com");
          if (isOfficialAnthropic) {
            provider = "anthropic";
            if (!matchedProvider.baseUrl || matchedProvider.baseUrl.trim() === "") {
              baseUrl = undefined;
            }
          } else {
            // Custom baseUrl with anthropic provider type → treat as OpenAI-compatible endpoint
            provider = "custom";
          }
        } else if (typeLower === "custom" || baseUrl) {
          provider = "custom";
        } else {
          provider = "openai";
        }
      } else if (prefix.startsWith("openrouter")) {
        // Find openrouter provider in JSON config
        const openrouterProfile = modelConfig.providers.find(
          (p) => (p.provider === "openrouter" || p.provider === "custom") && p.baseUrl?.includes("openrouter.ai") && p.apiKey && p.apiKey.trim() !== ""
        );
        if (openrouterProfile) {
          provider = "custom";
          baseUrl = openrouterProfile.baseUrl || "https://openrouter.ai/api/v1";
          apiKey = openrouterProfile.apiKey;
          modelName = rest;
        }
      } else if (prefix.startsWith("anthropic")) {
        // Find anthropic provider in JSON config
        const anthropicProfile = modelConfig.providers.find(
          (p) => p.provider === "anthropic" && p.apiKey && p.apiKey.trim() !== ""
        );
        if (anthropicProfile) {
          provider = "anthropic";
          baseUrl = undefined;
          apiKey = anthropicProfile.apiKey;
          modelName = rest;
        }
      } else if (prefix.startsWith("openai")) {
        // Find openai provider in JSON config
        const openaiProfile = modelConfig.providers.find(
          (p) => p.provider === "openai" && p.apiKey && p.apiKey.trim() !== ""
        );
        if (openaiProfile) {
          provider = "openai";
          baseUrl = undefined;
          apiKey = openaiProfile.apiKey;
          modelName = rest;
        }
      } else if (prefix.startsWith("gemini")) {
        // Find native gemini provider in JSON config
        const geminiProfile = modelConfig.providers.find(
          (p) => p.provider === "gemini" && p.apiKey && p.apiKey.trim() !== ""
        );
        if (geminiProfile) {
          provider = "gemini";
          baseUrl = undefined;
          apiKey = geminiProfile.apiKey;
          modelName = rest;
        }
      }
    }
  }

  const isCloud = !baseUrl || baseUrl.includes("openrouter.ai") || baseUrl.includes("openai.com") || baseUrl.includes("anthropic.com");
  const isMissingKey = !apiKey || apiKey.trim() === "" || apiKey === "dummy";
  const isTest = (process.env.VITEST || process.env.NODE_ENV === "test") && !process.env.SUPERAGENT_FORCE_VAL_CHECK;
  if (!isTest && isCloud && isMissingKey) {
    throw new Error(`API key is missing or not configured. Please configure it using the /login command.`);
  }

  // If the resolved provider is "custom", it represents a Custom OpenAI Endpoint (or OpenRouter).
  // We should only treat it as Anthropic-compatible if the baseUrl explicitly indicates Anthropic (e.g. contains "anthropic").
  // This allows Custom OpenAI Endpoints to serve Claude models (like claude-sonnet-4-6) via OpenAI-compatible APIs.
  const isAnthropic = provider === "anthropic" || (
    provider === "custom" &&
    isAnthropicCompatible(baseUrl || "", modelName) &&
    (baseUrl || "").toLowerCase().includes("anthropic")
  );

  if (isAnthropic) {
    const anthropic = createAnthropic({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });
    return anthropic(modelName);
  }

  // Native Google Gemini provider
  if (provider === "gemini") {
    const google = createGoogleGenerativeAI({ apiKey });
    return google(modelName);
  }

  const openai = createOpenAI({
    apiKey,
    ...(baseUrl && { baseURL: baseUrl }),
    headers: {
      "HTTP-Referer": "https://github.com/RudyCity/superagent",
      "X-Title": "SuperAgent CLI",
    },
    fetch: async (url, options) => {
      const response = await globalThis.fetch(url, options);
      
      let isStreamingRequest = false;
      if (options && options.body) {
        try {
          let bodyStr: string | null = null;
          if (typeof options.body === "string") {
            bodyStr = options.body;
          } else if (options.body instanceof ArrayBuffer) {
            bodyStr = new TextDecoder().decode(options.body);
          } else if (ArrayBuffer.isView(options.body)) {
            bodyStr = new TextDecoder().decode(options.body);
          } else if (typeof (options.body as any).toString === "function") {
            bodyStr = (options.body as any).toString();
          }

          if (bodyStr) {
            const bodyJson = JSON.parse(bodyStr);
            if (bodyJson.stream === true) {
              isStreamingRequest = true;
            }
          }
        } catch {
          // Ignore parsing errors
        }
      }

      if (!isStreamingRequest) {
        try {
          let text = await response.text();
          const contentType = response.headers.get("content-type") || "";
          const isEventStream = contentType.includes("text/event-stream") || text.trim().startsWith("data:");

          const headers = new Headers(response.headers);
          if (isEventStream) {
            headers.set("content-type", "application/json");
            text = JSON.stringify(reconstructChatCompletionFromSse(text));
          } else {
            const cleanedText = extractJSON(text);
            try {
              JSON.parse(cleanedText);
              text = cleanedText;
            } catch {
              // Ignore failures and fall back to original text
            }
          }
          
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch {
          // Ignore failures and fall back to original response
        }
      }
      return response;
    },
  });
  // Use .chat() to explicitly force Chat Completions API for custom base URLs/non-standard model names
  return baseUrl ? openai.chat(modelName) : openai(modelName);
}

/**
 * Validates whether a TierModelConfig entry is usable (has a model and a resolvable provider).
 * If the entry is stale/empty/broken, we should fall back to the default instead.
 * Note: We intentionally do NOT check apiKey here — that is handled later by
 * getModelInstanceForString() which has its own isTest bypass and fallback chains.
 */
function isValidTierConfig(tierConfig: TierModelConfig | undefined, providers: any[]): boolean {
  if (!tierConfig) return false;
  if (!tierConfig.model || tierConfig.model.trim() === "") return false;
  // A tierConfig is valid if it has a model string (even without a providerProfileId,
  // since getModelInstanceForString can handle bare model names).
  // If providerProfileId is set, verify it resolves to an existing provider profile.
  if (tierConfig.providerProfileId && tierConfig.providerProfileId.trim() !== "") {
    const resolvedProvider = providers.find((p: any) => p.id === tierConfig.providerProfileId);
    if (!resolvedProvider) return false;
  }
  return true;
}

/**
 * Resolves the best tierConfig for a subagent, checking subagentDetails first
 * then falling back to subagentDefault. Validates entries before using them
 * to prevent stale/broken entries from causing API key errors.
 */
function resolveSubagentTierConfig(
  subagentType: string | undefined,
  subagentDetails: Record<string, TierModelConfig> | undefined,
  subagentDefault: TierModelConfig | undefined,
  providers: any[]
): TierModelConfig | undefined {
  // 1. Try type-specific entry (e.g. "coder", "researcher")
  if (subagentType && subagentDetails?.[subagentType]) {
    const typeConfig = subagentDetails[subagentType];
    if (isValidTierConfig(typeConfig, providers)) {
      return typeConfig;
    }
    // Entry exists but is invalid/stale — fall through to subagentDefault
  }

  // 2. Fall back to subagentDefault
  if (isValidTierConfig(subagentDefault, providers)) {
    return subagentDefault;
  }

  // 3. Return whatever we have (will be caught by later fallbacks)
  return subagentDefault || (subagentType ? subagentDetails?.[subagentType] : undefined);
}

export interface ModelConnectionDetails {
  provider: string;
  modelName: string;
  apiKey: string;
  baseUrl?: string;
  profileId: string;
}

export function getModelConnectionDetailsForTier(
  tier: string,
  depth: number,
  subagentType?: string,
  isSingleMode?: boolean
): ModelConnectionDetails {
  const isMulti = !isSingleMode && !process.env.SINGLE_AGENT_MODE && (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true");
  const mode = isMulti ? "multi" : "single";

  const config = loadModelConfig();
  const activePreset = getActivePreset<any>(mode);
  const providers = config.providers || [];

  let tierConfig: TierModelConfig | undefined;

  if (mode === "multi") {
    // Prioritize explicit tier checks over depth fallback
    if (tier === "master") {
      tierConfig = activePreset.models.master;
    } else if (tier === "superagent") {
      tierConfig = activePreset.models.superagent;
    } else if (tier === "subagent") {
      tierConfig = resolveSubagentTierConfig(subagentType, activePreset.models.subagentDetails, activePreset.models.subagentDefault, providers);
    } else if (depth === 0) {
      tierConfig = activePreset.models.master;
    } else if (depth === 1) {
      tierConfig = activePreset.models.superagent;
    } else {
      // Subagent depth fallback
      tierConfig = resolveSubagentTierConfig(subagentType, activePreset.models.subagentDetails, activePreset.models.subagentDefault, providers);
    }
  } else {
    // Single mode logic
    if (tier === "superagent") {
      tierConfig = activePreset.models.superagent;
    } else if (tier === "subagent") {
      tierConfig = resolveSubagentTierConfig(subagentType, activePreset.models.subagentDetails, activePreset.models.subagentDefault, providers);
    } else if (depth <= 1) {
      tierConfig = activePreset.models.superagent;
    } else {
      // Subagent depth fallback
      tierConfig = resolveSubagentTierConfig(subagentType, activePreset.models.subagentDetails, activePreset.models.subagentDefault, providers);
    }
  }

  // Fallback to active preset superagent if tierConfig is missing
  if (!tierConfig) {
    tierConfig = activePreset.models.superagent || (activePreset.models as any).master;
  }

  // Find the provider profile with robust fallback chain
  let providerProfile = config.providers.find((p) => p.id === tierConfig?.providerProfileId);

  // Fallback 1: fuzzy match by name or provider type
  if (!providerProfile && tierConfig?.providerProfileId) {
    const staleId = tierConfig.providerProfileId.toLowerCase();
    providerProfile = config.providers.find(
      (p) => p.id?.toLowerCase() === staleId || p.name?.toLowerCase() === staleId || p.provider?.toLowerCase() === staleId
    );
  }

  // Fallback 2: any provider with a non-empty apiKey
  if (!providerProfile || !providerProfile.apiKey || providerProfile.apiKey.trim() === "") {
    const anyWithKey = config.providers.find(
      (p) => p.apiKey && p.apiKey.trim() !== ""
    );
    if (anyWithKey) {
      providerProfile = anyWithKey;
    } else {
      providerProfile = config.providers[0];
    }
  }

  const apiKey = providerProfile?.apiKey || "";
  const provider = providerProfile?.provider || "openai";
  const modelName = tierConfig?.model || getEffectiveMasterModel(mode) || (provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o");
  const profileId = providerProfile?.id || provider;
  const baseUrl = providerProfile?.baseUrl || undefined;

  return { provider, modelName, apiKey, baseUrl, profileId };
}

export function getModelInstanceForTier(tier: string, depth: number, subagentType?: string, isSingleMode?: boolean) {
  const details = getModelConnectionDetailsForTier(tier, depth, subagentType, isSingleMode);

  // If modelName already contains a provider prefix (e.g. 'openai@gpt-4o'), do not double-prepend the profileId
  if (details.modelName.includes("@")) {
    return getModelInstanceForString(details.modelName);
  }

  return getModelInstanceForString(`${details.profileId}@${details.modelName}`);
}

