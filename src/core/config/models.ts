import fs from "fs";
import path from "path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createXai } from "@ai-sdk/xai";
import { createMistral } from "@ai-sdk/mistral";
import { createGroq } from "@ai-sdk/groq";
import { createAzure } from "@ai-sdk/azure";
import { getStaticModelLimit } from "../model_limits.js";
import { getRootConfigDir, ensureProtocol } from "./paths.js";
import { getConfig } from "./base.js";
import { getConfiguredProviders, getEffectiveMasterModel } from "./providers.js";
import { loadModelConfig, getActivePreset, TierModelConfig, getSettings, getSingleAgentMode } from "./jsonConfig.js";
import { saveModelCachesToDb, getModelCachesFromDb } from "../storage/historyDb.js";

let legacyCacheMigrated = false;

/** Cached context limits below this are treated as provider misreports. */
const MIN_TRUSTED_CONTEXT_LIMIT = 16384;
/** Fallback context window when no reliable data exists. */
const DEFAULT_CONTEXT_WINDOW_LIMIT = 256000;

export async function fetchAndCacheModels(): Promise<void> {
  const providers = getConfiguredProviders();
  const cache: Record<string, number> = {};

  const fetchPromises = providers.map(async (provider) => {
    if (provider.type === "anthropic" && !provider.baseUrl) return;

    let url = "";
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Superagent/1.0",
      "HTTP-Referer": "https://github.com/RudyCity/superagent",
      "X-Title": "SuperAgent CLI",
    };
    const apiKey = provider.apiKey || "";
    const baseUrl = ensureProtocol(provider.baseUrl || "");

    if (provider.type === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
    } else if (provider.type === "openai") {
      url = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/models` : "https://api.openai.com/v1/models";
    } else if (provider.type === "opencode") {
      url = `${(baseUrl || "https://opencode.ai/zen/v1").replace(/\/+$/, "")}/models`;
    } else if (provider.type === "gemini") {
      // Google Gemini: use the generativelanguage REST API models endpoint
      url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    } else if ((provider.type === "custom" || provider.type === "anthropic") && baseUrl) {
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
            m.inputTokenLimit ||
            (m.metadata &&
              (m.metadata.context_length ||
                m.metadata.max_model_len ||
                m.metadata.max_position_embeddings));
          const finalLimit = (typeof limit === "number" ? limit : null) || getStaticModelLimit(rawId) || 128000;
          cache[rawId] = finalLimit;
        }
      }
    } catch (err) {
      // Ignore individual fetch errors
    }
  });

  await Promise.allSettled(fetchPromises);

  if (Object.keys(cache).length > 0) {
    try {
      const existingCache = getModelCachesFromDb();
      const updatedCache = { ...existingCache, ...cache };
      saveModelCachesToDb(updatedCache);
    } catch (err) {
      // Ignore write errors
    }
  }
}

function loadModelsCacheWithMigration(): Record<string, number> {
  const dbCache = getModelCachesFromDb();
  if (legacyCacheMigrated) {
    return dbCache;
  }
  legacyCacheMigrated = true;
  try {
    const cachePath = path.join(getRootConfigDir(), "models_cache.json");
    if (fs.existsSync(cachePath)) {
      try {
        const legacyCache = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as Record<string, number>;
        if (legacyCache && typeof legacyCache === "object") {
          const merged = { ...legacyCache, ...dbCache };
          saveModelCachesToDb(merged);
          fs.unlinkSync(cachePath);
          return merged;
        }
      } catch {}
    }
  } catch {}
  return dbCache;
}

/** Returns the list of model IDs cached from the last successful API fetch. */
export function getCachedModelIds(): string[] {
  try {
    const cache = loadModelsCacheWithMigration();
    return Object.keys(cache);
  } catch {
    // Ignore
  }
  return [];
}

export function getContextWindowLimit(model: string): number {
  // 1. JSON config override (centralized settings)
  const jsonLimit = getSettings().contextWindowLimit;
  if (jsonLimit > 0) return jsonLimit;

  // Clean provider prefix (e.g. "dddd@claude-sonnet" -> "claude-sonnet")
  const cleanModel = model.includes("@") ? model.substring(model.indexOf("@") + 1) : model;

  // 2. Read from SQLite model_caches
  try {
    const cache = loadModelsCacheWithMigration();
    if (cache && typeof cache[cleanModel] === "number") {
      const cachedVal = cache[cleanModel];
      const staticLimit = getStaticModelLimit(cleanModel);
      // Guard against unreasonably small cached values (e.g. 8192 misreported
      // by a provider's /models endpoint). Prefer static lookup or the 256K
      // default over a cached value below the minimum trusted threshold.
      if (cachedVal < MIN_TRUSTED_CONTEXT_LIMIT) {
        return staticLimit ?? DEFAULT_CONTEXT_WINDOW_LIMIT;
      }
      if ((cachedVal === 128000 || cachedVal === 200000) && staticLimit !== null) {
        return staticLimit;
      }
      return cachedVal;
    }
  } catch (err) {
    // Ignore cache read errors
  }

  // 3. Fallback to rich static lookup
  const staticLimit = getStaticModelLimit(cleanModel);
  if (staticLimit !== null) {
    return staticLimit;
  }

  // Default fallback
  return DEFAULT_CONTEXT_WINDOW_LIMIT;
}

export function isAnthropicCompatible(baseUrl: string, modelName: string): boolean {
  const urlLower = baseUrl.toLowerCase();
  const modelLower = modelName.toLowerCase();
  if (urlLower.includes("anthropic") || urlLower.includes("antigravity")) return true;
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
  if (
    urlLower.includes("deepseek.com") ||
    urlLower.includes("api.deepseek") ||
    urlLower.includes("x.ai") ||
    urlLower.includes("mistral.ai") ||
    urlLower.includes("groq.com") ||
    urlLower.includes("cerebras.ai") ||
    urlLower.includes("cerebras.cloud") ||
    urlLower.includes("fireworks.ai") ||
    urlLower.includes("fireworks.ai/api") ||
    urlLower.includes("z.ai") ||
    urlLower.includes("moonshot") ||
    urlLower.includes("kimi.com") ||
    urlLower.includes("azure.com") ||
    urlLower.includes("openai.azure.com")
  ) {
    return false;
  }
  return modelLower.includes("claude") || modelLower.includes("antigravity");
}

import {
  extractJSON,
  reconstructChatCompletionFromSse,
  synthesizeSseFromChatCompletion,
  transformSseText,
  transformSseStream,
} from "./openAiSseAdapter.js";

export {
  extractJSON,
  reconstructChatCompletionFromSse,
  synthesizeSseFromChatCompletion,
  transformSseText,
  transformSseStream,
};

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
  let baseUrl = ensureProtocol(config.baseUrl);

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
        } else if (typeLower === "opencode") {
          // OpenCode Zen gateway (https://opencode.ai/zen) — OpenAI-compatible
          // /chat/completions for most models; Claude/Qwen Plus are served via
          // the Anthropic-format /messages API and detected below.
          provider = "custom";
          if (!baseUrl) {
            baseUrl = "https://opencode.ai/zen/v1";
          }
        } else if (
          typeLower === "tokenrouter" ||
          typeLower === "commandcode" ||
          typeLower === "zenmux"
        ) {
          // OpenAI-compatible LLM gateways — routed through the generic custom
          // client path with the gateway's default baseUrl.
          provider = "custom";
          if (!baseUrl) {
            if (typeLower === "tokenrouter") baseUrl = "https://tokenrouter.me/v1";
            else if (typeLower === "commandcode") baseUrl = "https://api.commandcode.ai/v1";
            else baseUrl = "https://zenmux.ai/api/v1";
          }
        } else if (typeLower === "deepseek") {
          provider = "deepseek";
          baseUrl = undefined;
        } else if (typeLower === "xai") {
          provider = "xai";
          baseUrl = undefined;
        } else if (typeLower === "mistral") {
          provider = "mistral";
          baseUrl = undefined;
        } else if (typeLower === "groq") {
          provider = "groq";
          baseUrl = undefined;
        } else if (typeLower === "azure") {
          provider = "azure";
          baseUrl = undefined;
        } else if (typeLower === "zai") {
          provider = "zai";
          baseUrl = undefined;
        } else if (typeLower === "kimi") {
          provider = "kimi";
          baseUrl = undefined;
        } else if (typeLower === "cerebras") {
          provider = "cerebras";
          baseUrl = undefined;
        } else if (typeLower === "together") {
          provider = "together";
          baseUrl = undefined;
        } else if (typeLower === "fireworks") {
          provider = "fireworks";
          baseUrl = undefined;
        } else if (typeLower === "ollama") {
          provider = "ollama";
          baseUrl = undefined;
        } else if (typeLower === "lmstudio") {
          provider = "lmstudio";
          baseUrl = undefined;
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

  if (baseUrl) {
    baseUrl = ensureProtocol(baseUrl);
  }

  const isCloud = !baseUrl
    || baseUrl.includes("openrouter.ai")
    || baseUrl.includes("openai.com")
    || baseUrl.includes("anthropic.com")
    || baseUrl.includes("opencode.ai")
    || baseUrl.includes("api.deepseek.com")
    || baseUrl.includes("api.x.ai")
    || baseUrl.includes("api.mistral.ai")
    || baseUrl.includes("api.groq.com")
    || baseUrl.includes("openai.azure.com")
    || baseUrl.includes("api.z.ai")
    || baseUrl.includes("api.moonshot")
    || baseUrl.includes("api.cerebras.ai")
    || baseUrl.includes("api.together.xyz")
    || baseUrl.includes("api.fireworks.ai");
  const isMissingKey = !apiKey || apiKey.trim() === "" || apiKey === "dummy";
  const isTest = (process.env.VITEST || process.env.NODE_ENV === "test") && !process.env.SUPERAGENT_FORCE_VAL_CHECK;
  if (!isTest && isCloud && isMissingKey) {
    throw new Error(`API key is missing or not configured. Please configure it using the /login command.`);
  }

  // If the resolved provider is "custom", it represents a Custom OpenAI Endpoint (or OpenRouter).
  // We should only treat it as Anthropic-compatible if the baseUrl explicitly indicates Anthropic (e.g. contains "anthropic").
  // This allows Custom OpenAI Endpoints to serve Claude models (like claude-sonnet-4-6) via OpenAI-compatible APIs.
  // Exception: OpenCode Zen serves Claude/Qwen Plus models via the Anthropic-format /messages API
  // (https://opencode.ai/zen/v1/messages), so route those to the Anthropic SDK.
  const isOpenCodeZenAnthropicModel =
    (baseUrl || "").toLowerCase().includes("opencode.ai") &&
    /^(claude|qwen[\d.]*-plus)/i.test(modelName);
  const isAnthropic = provider === "anthropic" || isOpenCodeZenAnthropicModel || (
    provider === "custom" &&
    isAnthropicCompatible(baseUrl || "", modelName) &&
    (
      (baseUrl || "").toLowerCase().includes("anthropic") ||
      (baseUrl || "").toLowerCase().includes("antigravity") ||
      modelName.toLowerCase().includes("antigravity") ||
      modelStr.toLowerCase().includes("antigravity")
    )
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

  // Native @ai-sdk/* providers (official SDKs)
  if (provider === "deepseek") {
    const ds = createDeepSeek({ apiKey });
    return ds(modelName);
  }
  if (provider === "xai") {
    const xaiSdk = createXai({ apiKey });
    return xaiSdk(modelName);
  }
  if (provider === "mistral") {
    const m = createMistral({ apiKey });
    return m(modelName);
  }
  if (provider === "groq") {
    const g = createGroq({ apiKey });
    return g(modelName);
  }
  if (provider === "azure") {
    // Azure OpenAI requires { resourceName } + apiKey (deployments are
    // handled via the @ai-sdk/azure implementation by deployment name).
    // We pass resourceName via baseURL fallback for ad-hoc compatibility.
    const az = createAzure({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
    return az(modelName);
  }

  // OpenAI-compatible first-class providers (no official SDK; routed via
  // createOpenAI with the provider's base URL). Ollama / LM Studio are
  // local servers that may have no API key.
  const openaiCompatPrefixes: Record<string, { baseURL: string }> = {
    zai:       { baseURL: "https://api.z.ai/v1" },
    kimi:      { baseURL: "https://api.moonshot.cn/v1" },
    cerebras:  { baseURL: "https://api.cerebras.ai/v1" },
    together:  { baseURL: "https://api.together.xyz/v1" },
    fireworks: { baseURL: "https://api.fireworks.ai/inference/v1" },
  };
  if (provider in openaiCompatPrefixes) {
    const preset = openaiCompatPrefixes[provider];
    const oa = createOpenAI({
      apiKey: apiKey || "no-key-required",
      baseURL: baseUrl || preset.baseURL,
    });
    return oa(modelName);
  }

  if (provider === "ollama" || provider === "lmstudio") {
    // Local servers default to http://localhost:<port>/v1 when no baseUrl
    // is configured. Ollama defaults to 11434, LM Studio to 1234.
    const defaultPort = provider === "ollama" ? "11434" : "1234";
    const fallbackBase = `http://localhost:${defaultPort}/v1`;
    const oa = createOpenAI({
      apiKey: apiKey || "no-key-required",
      baseURL: baseUrl || fallbackBase,
    });
    // Ollama's OpenAI-compatible endpoint exposes /v1, but its native
    // model identifiers may not include a prefix. We do not prefix here
    // because users can name their models freely; downstream providers
    // must handle bare names like "llama3" or "qwen2.5-coder".
    return oa(modelName);
  }

  const openai = createOpenAI({
    apiKey,
    ...(baseUrl && { baseURL: baseUrl }),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Superagent/1.0",
      "HTTP-Referer": "https://github.com/RudyCity/superagent",
      "X-Title": "SuperAgent CLI",
    },
    fetch: async (url, options) => {
      // Strip strict mode from tools if calling a custom base URL (e.g. OpenRouter, Nexotao)
      // because custom/proxy endpoints often reject "strict: true" for non-supported models.
      if (options && options.body && typeof options.body === "string" && baseUrl) {
        try {
          const bodyJson = JSON.parse(options.body);
          if (bodyJson.tools && Array.isArray(bodyJson.tools)) {
            let bodyChanged = false;
            bodyJson.tools = bodyJson.tools.map((tool: any) => {
              if (tool.function && "strict" in tool.function) {
                const newFunc = { ...tool.function };
                delete newFunc.strict;
                bodyChanged = true;
                return { ...tool, function: newFunc };
              }
              return tool;
            });
            if (bodyChanged) {
              options.body = JSON.stringify(bodyJson);
            }
          }
        } catch {
          // Ignore parsing/modification errors
        }
      }

      const response = await globalThis.fetch(url, options);
      
      // If the upstream returned an HTTP error (4xx or 5xx), do not attempt response adaptation or SSE synthesis.
      // Returning the raw response ensures @ai-sdk receives the actual HTTP error status and JSON payload.
      if (!response.ok) {
        return response;
      }
      
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
        let text = "";
        try {
          text = await response.text();
        } catch {
          return response;
        }

        try {
          const contentType = response.headers.get("content-type") || "";
          const isEventStream = (contentType.includes("text/event-stream") || text.trim().startsWith("data:")) && !text.trim().startsWith("{");

          const headers = new Headers(response.headers);
          headers.delete("transfer-encoding");
          headers.delete("content-length");

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
          const headers = new Headers(response.headers);
          headers.delete("transfer-encoding");
          headers.delete("content-length");
          return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      } else {
        // Streaming request: check whether the endpoint actually returned an SSE stream
        const contentType = response.headers.get("content-type") || "";
        const isEventStream = contentType.includes("text/event-stream");

        if (!isEventStream) {
          let rawText = "";
          try {
            rawText = await response.text();
          } catch {
            return response;
          }

          // If the text starts with "data:", it's an SSE stream without the text/event-stream header
          if (rawText.trim().startsWith("data:")) {
            const headers = new Headers(response.headers);
            headers.set("content-type", "text/event-stream");
            headers.delete("transfer-encoding");
            headers.delete("content-length");
            const transformed = transformSseText(rawText);
            return new Response(transformed, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }

          // Non-streaming JSON response returned for a streaming request (e.g. 78_openai_server.rdy or simple proxies)
          try {
            const cleanedText = extractJSON(rawText);
            const json = JSON.parse(cleanedText);
            const sseBody = synthesizeSseFromChatCompletion(json, modelName);
            const headers = new Headers(response.headers);
            headers.set("content-type", "text/event-stream");
            headers.delete("transfer-encoding");
            headers.delete("content-length");

            return new Response(sseBody, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          } catch {
            const headers = new Headers(response.headers);
            headers.delete("transfer-encoding");
            headers.delete("content-length");
            return new Response(rawText, {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
          }
        }

        // Response is text/event-stream: transform SSE stream to map reasoning_content to delta.content
        if (response.body) {
          const transformedStream = transformSseStream(response.body);
          const headers = new Headers(response.headers);
          headers.delete("content-length");
          return new Response(transformedStream, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
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
  const isMulti = !isSingleMode && !getSingleAgentMode() && (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true");
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
  const baseUrl = ensureProtocol(providerProfile?.baseUrl) || undefined;

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

