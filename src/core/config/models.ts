import fs from "fs";
import path from "path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getStaticModelLimit } from "../model_limits.js";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { getConfig } from "./base.js";
import { getConfiguredProviders } from "./providers.js";

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
      const providerUpper = prefix.toUpperCase();
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
        if (prefix.startsWith("openrouter")) {
          provider = "custom";
          baseUrl = "https://openrouter.ai/api/v1";
          apiKey = process.env.PROVIDER_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || process.env.CUSTOM_API_KEY || config.apiKey;
          modelName = rest;
        } else if (prefix.startsWith("anthropic")) {
          provider = "anthropic";
          baseUrl = undefined;
          apiKey = process.env.PROVIDER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || config.apiKey;
          modelName = rest;
        } else if (prefix.startsWith("openai")) {
          provider = "openai";
          baseUrl = undefined;
          apiKey = process.env.PROVIDER_OPENAI_API_KEY || process.env.OPENAI_API_KEY || config.apiKey;
          modelName = rest;
        }
      }
    }
  }

  const isCloud = !baseUrl || baseUrl.includes("openrouter.ai") || baseUrl.includes("openai.com") || baseUrl.includes("anthropic.com");
  const isMissingKey = !apiKey || apiKey.trim() === "" || apiKey === "dummy";
  const isTest = (process.env.VITEST || process.env.NODE_ENV === "test") && !process.env.SUPERAGENT_FORCE_VAL_CHECK;
  if (!isTest && isCloud && isMissingKey) {
    let keyVar = "API_KEY";
    if (baseUrl?.includes("openrouter.ai")) {
      keyVar = resolvedPrefix ? `PROVIDER_${resolvedPrefix.toUpperCase()}_API_KEY or OPENROUTER_API_KEY` : "OPENROUTER_API_KEY";
    } else if (provider === "anthropic") {
      keyVar = resolvedPrefix ? `PROVIDER_${resolvedPrefix.toUpperCase()}_API_KEY or ANTHROPIC_API_KEY` : "ANTHROPIC_API_KEY";
    } else if (provider === "openai") {
      keyVar = resolvedPrefix ? `PROVIDER_${resolvedPrefix.toUpperCase()}_API_KEY or OPENAI_API_KEY` : "OPENAI_API_KEY";
    }
    throw new Error(`API key is missing or not configured. Please set the ${keyVar} environment variable or add it to your global .env file.`);
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
  let modelStr = "";

  const checkSingle = tier === "single" || isSingleMode;

  if (checkSingle) {
    if (tier === "subagent" || depth >= 2) {
      if (subagentType) {
        const typeUpper = subagentType.toUpperCase();
        modelStr = process.env[`MODEL_SINGLE_SUBAGENT_${typeUpper}`] || process.env[`MODEL_SINGLE_${typeUpper}`] || "";
      }
      if (!modelStr) {
        modelStr = process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || process.env.MODEL_SINGLE || "";
      }
    } else {
      modelStr = process.env.MODEL_SINGLE || process.env.MODEL || "";
    }
  } else {
    if (tier === "master") {
      modelStr = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
    } else if (tier === "superagent") {
      modelStr = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
    } else if (tier === "subagent") {
      if (subagentType) {
        const typeUpper = subagentType.toUpperCase();
        modelStr = process.env[`MODEL_SUBAGENT_${typeUpper}`] || process.env[`MODEL_${typeUpper}`] || "";
      }
      if (!modelStr) {
        modelStr = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
      }
    }
  }

  // Fallback to depth check if tier is not recognized or not specified
  if (!modelStr && !checkSingle) {
    if (depth === 0) {
      modelStr = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
    } else if (depth === 1) {
      modelStr = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
    } else if (depth >= 2) {
      if (subagentType) {
        const typeUpper = subagentType.toUpperCase();
        modelStr = process.env[`MODEL_SUBAGENT_${typeUpper}`] || process.env[`MODEL_${typeUpper}`] || "";
      }
      if (!modelStr) {
        modelStr = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
      }
    }
  }

  if (!modelStr) {
    modelStr = process.env.MODEL || "";
  }

  return getModelInstanceForString(modelStr);
}
