import fs from "fs";
import path from "path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getStaticModelLimit } from "../model_limits.js";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { getConfig } from "./base.js";
import { getConfiguredProviders } from "./providers.js";
import { loadModelConfig, getActivePreset, TierModelConfig } from "./jsonConfig.js";

export async function fetchAndCacheModels(): Promise<void> {
  const providers = getConfiguredProviders();
  const cache: Record<string, number> = {};

  const fetchPromises = providers.map(async (provider) => {
    if (provider.type === "anthropic") return;

    let url = "";
    const headers: Record<string, string> = {};
    const prefix = `PROVIDER_${provider.name.toUpperCase()}`;
    let apiKey = process.env[`${prefix}_API_KEY`] || "";
    let baseUrl = process.env[`${prefix}_BASE_URL`] || "";

    if (!apiKey) {
      if (provider.name.toLowerCase() === "openai") apiKey = process.env.OPENAI_API_KEY || "";
      else if (provider.name.toLowerCase() === "anthropic") apiKey = process.env.ANTHROPIC_API_KEY || "";
      else if (provider.name.toLowerCase() === "custom") apiKey = process.env.CUSTOM_API_KEY || "";
    }
    if (!baseUrl) {
      if (provider.name.toLowerCase() === "custom") baseUrl = process.env.CUSTOM_BASE_URL || "";
    }

    if (provider.name.toLowerCase() === "openrouter" || provider.type === "openrouter") {
      url = "https://openrouter.ai/api/v1/models";
    } else if (provider.type === "openai") {
      url = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/models` : "https://api.openai.com/v1/models";
    } else if (provider.type === "custom" && baseUrl) {
      url = `${baseUrl.replace(/\/+$/, "")}/models`;
    }

    if (!url) return;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return;
      const json = await res.json() as any;
      if (json && Array.isArray(json.data)) {
        for (const m of json.data) {
          if (!m || !m.id) continue;
          const limit =
            m.context_length ||
            m.max_model_len ||
            m.max_position_embeddings ||
            (m.metadata &&
              (m.metadata.context_length ||
                m.metadata.max_model_len ||
                m.metadata.max_position_embeddings));
          if (limit && typeof limit === "number") {
            cache[m.id] = limit;
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
  // 1. Env overrides
  if (process.env.CONTEXT_WINDOW_LIMIT) {
    const parsed = parseInt(process.env.CONTEXT_WINDOW_LIMIT, 10);
    if (!isNaN(parsed)) return parsed;
  }
  if (process.env.MAX_CONTEXT_TOKENS) {
    const parsed = parseInt(process.env.MAX_CONTEXT_TOKENS, 10);
    if (!isNaN(parsed)) return parsed;
  }

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
  let resolvedPrefix = "";

  const colonIndex = modelStr.indexOf(":");
  if (colonIndex > 0) {
    const prefix = modelStr.substring(0, colonIndex).toLowerCase();
    resolvedPrefix = prefix;
    const rest = modelStr.substring(colonIndex + 1);
    if (prefix === "anthropic") {
      provider = "anthropic";
      modelName = rest;
      apiKey = process.env.PROVIDER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || config.apiKey;
      baseUrl = undefined;
    } else if (prefix === "openai") {
      provider = "openai";
      modelName = rest;
      apiKey = process.env.PROVIDER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || config.apiKey;
      baseUrl = undefined;
    } else if (prefix === "custom") {
      provider = "custom";
      modelName = rest;
      apiKey = process.env.PROVIDER_CUSTOM_API_KEY || process.env.CUSTOM_API_KEY || config.apiKey;
      baseUrl = process.env.PROVIDER_CUSTOM_BASE_URL || process.env.CUSTOM_BASE_URL || config.baseUrl;
    } else {
      const providerUpper = prefix.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const customKey = process.env[`PROVIDER_${providerUpper}_API_KEY`];
      const customBase = process.env[`PROVIDER_${providerUpper}_BASE_URL`];
      const customType = process.env[`PROVIDER_${providerUpper}_TYPE`];
      if (customKey !== undefined || customBase !== undefined || customType !== undefined) {
        apiKey = customKey || "";
        baseUrl = customBase || undefined;
        modelName = rest;
        const typeLower = (customType || "").toLowerCase();
        if (typeLower === "anthropic") {
          provider = "anthropic";
          baseUrl = undefined;
        } else if (typeLower === "custom" || typeLower === "openrouter" || baseUrl) {
          provider = "custom";
        } else {
          provider = "openai";
        }
      } else {
        const modelConfig = loadModelConfig();
        const matchedProvider = modelConfig.providers?.find(
          p => p.id?.toLowerCase() === prefix || p.name?.toLowerCase() === prefix
        );
        if (matchedProvider) {
          apiKey = matchedProvider.apiKey || "";
          baseUrl = matchedProvider.baseUrl || undefined;
          modelName = rest;
          const typeLower = (matchedProvider.provider || "").toLowerCase();
          if (typeLower === "openrouter") {
            provider = "custom";
            if (!baseUrl) {
              baseUrl = "https://openrouter.ai/api/v1";
            }
          } else if (typeLower === "anthropic") {
            provider = "anthropic";
            baseUrl = undefined;
          } else if (typeLower === "custom" || baseUrl) {
            provider = "custom";
          } else {
            provider = "openai";
          }
        } else if (prefix.startsWith("openrouter")) {
          provider = "custom";
          baseUrl = "https://openrouter.ai/api/v1";
          const canFallback = config.provider === "custom" || config.provider === "openai";
          apiKey = process.env.PROVIDER_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || process.env.CUSTOM_API_KEY || (canFallback ? config.apiKey : "");
          modelName = rest;
        } else if (prefix.startsWith("anthropic")) {
          provider = "anthropic";
          baseUrl = undefined;
          const canFallback = config.provider === "anthropic";
          apiKey = process.env.PROVIDER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || (canFallback ? config.apiKey : "");
          modelName = rest;
        } else if (prefix.startsWith("openai")) {
          provider = "openai";
          baseUrl = undefined;
          const canFallback = config.provider === "openai";
          apiKey = process.env.PROVIDER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || (canFallback ? config.apiKey : "");
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

  if (provider === "anthropic" || (provider === "custom" && isAnthropicCompatible(baseUrl || "", modelName))) {
    const anthropic = createAnthropic({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });
    return anthropic(modelName);
  }

  const openai = createOpenAI({
    apiKey,
    ...(baseUrl && { baseURL: baseUrl }),
    headers: {
      "HTTP-Referer": "https://github.com/RudyCity/superagent",
      "X-Title": "SuperAgent CLI",
    },
  });
  return openai(modelName);
}

export function getModelInstanceForTier(tier: string, depth: number, subagentType?: string, isSingleMode?: boolean) {
  const isMulti = !isSingleMode && !process.env.SINGLE_AGENT_MODE && (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true");
  const mode = isMulti ? "multi" : "single";

  const config = loadModelConfig();
  const activePreset = getActivePreset<any>(mode);

  let tierConfig: TierModelConfig | undefined;

  if (mode === "multi") {
    // Prioritize explicit tier checks over depth fallback
    if (tier === "master") {
      tierConfig = activePreset.models.master;
    } else if (tier === "superagent") {
      tierConfig = activePreset.models.superagent;
    } else if (tier === "subagent") {
      if (subagentType && activePreset.models.subagentDetails?.[subagentType]) {
        tierConfig = activePreset.models.subagentDetails[subagentType];
      }
      if (!tierConfig) {
        tierConfig = activePreset.models.subagentDefault;
      }
    } else if (depth === 0) {
      tierConfig = activePreset.models.master;
    } else if (depth === 1) {
      tierConfig = activePreset.models.superagent;
    } else {
      // Subagent depth fallback
      if (subagentType && activePreset.models.subagentDetails?.[subagentType]) {
        tierConfig = activePreset.models.subagentDetails[subagentType];
      }
      if (!tierConfig) {
        tierConfig = activePreset.models.subagentDefault;
      }
    }
  } else {
    // Single mode logic
    if (tier === "superagent") {
      tierConfig = activePreset.models.superagent;
    } else if (tier === "subagent") {
      if (subagentType && activePreset.models.subagentDetails?.[subagentType]) {
        tierConfig = activePreset.models.subagentDetails[subagentType];
      }
      if (!tierConfig) {
        tierConfig = activePreset.models.subagentDefault;
      }
    } else if (depth <= 1) {
      tierConfig = activePreset.models.superagent;
    } else {
      // Subagent depth fallback
      if (subagentType && activePreset.models.subagentDetails?.[subagentType]) {
        tierConfig = activePreset.models.subagentDetails[subagentType];
      }
      if (!tierConfig) {
        tierConfig = activePreset.models.subagentDefault;
      }
    }
  }

  // Fallback to active preset superagent if tierConfig is missing
  if (!tierConfig) {
    tierConfig = activePreset.models.superagent || (activePreset.models as any).master;
  }

  // Find the provider profile
  const providerProfile = config.providers.find((p) => p.id === tierConfig?.providerProfileId) || config.providers[0];

  const apiKey = providerProfile?.apiKey || "";
  const baseUrl = providerProfile?.baseUrl || undefined;
  const provider = providerProfile?.provider || "openai";
  const modelName = tierConfig?.model || process.env.MODEL || (provider === "anthropic" ? "claude-3-5-sonnet-20241022" : "gpt-4o");

  // Construct a prefix that maps back to the profile credentials
  const profileId = providerProfile?.id || provider;
  const prefix = profileId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  process.env[`PROVIDER_${prefix}_API_KEY`] = apiKey;
  if (baseUrl) {
    process.env[`PROVIDER_${prefix}_BASE_URL`] = baseUrl;
  }
  process.env[`PROVIDER_${prefix}_TYPE`] = provider;

  // If modelName already contains a provider prefix (e.g. 'openai:gpt-4o'), do not double-prepend the profileId
  if (modelName.includes(":")) {
    return getModelInstanceForString(modelName);
  }

  return getModelInstanceForString(`${profileId}:${modelName}`);
}

