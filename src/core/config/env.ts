import { ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
import { loadModelConfig, saveModelConfig } from "./jsonConfig.js";

// Populate process.env with settings from model-config.json on startup.
// Provider credentials are resolved directly from JSON config — no env var population needed.
try {
  const config = loadModelConfig();
  if (config.settings) {
    const s = config.settings;
    if (s.concurrencyLimit !== undefined) {
      process.env.SUPERAGENT_MAX_CONCURRENCY = String(s.concurrencyLimit);
    }
    if (s.rateLimitRpm !== undefined) {
      process.env.SUPERAGENT_RATE_LIMIT_RPM = String(s.rateLimitRpm);
    }
    if (s.rateLimitCapacity !== undefined) {
      process.env.SUPERAGENT_RATE_LIMIT_CAPACITY = String(s.rateLimitCapacity);
    }
    if (s.disableStreaming !== undefined) {
      process.env.DISABLE_STREAMING = s.disableStreaming ? "true" : "";
    }
    if (s.contextWindowLimit !== undefined && s.contextWindowLimit > 0) {
      process.env.CONTEXT_WINDOW_LIMIT = String(s.contextWindowLimit);
    }
    if (s.maxIterations !== undefined) {
      process.env.MAX_ITERATIONS = String(s.maxIterations);
    }
  }
} catch (error) {
  // Ignore errors during initial startup load
}

/**
 * Update runtime config: syncs updates to process.env (in-memory) and
 * persists relevant changes to model-config.json (synchronous).
 *
 * .env file is NO LONGER used — all persistent config lives in model-config.json.
 */
export function updateEnvFile(updates: Record<string, string>): string {
  ensureGlobalConfigDir();

  const forbiddenKeys = Object.keys(updates).filter((key) =>
    key.startsWith("MODEL_") ||
    key === "ACTIVE_PROVIDER" ||
    key.startsWith("PROVIDER_") ||
    key === "OPENAI_API_KEY" ||
    key === "ANTHROPIC_API_KEY" ||
    key === "CUSTOM_API_KEY" ||
    key === "CUSTOM_BASE_URL"
  );
  if (forbiddenKeys.length > 0) {
    throw new Error(
      `updateEnvFile no longer accepts provider/model keys after JSON config migration: ${forbiddenKeys.join(", ")}`
    );
  }

  // Update process.env so runtime-only settings changes are immediate in memory
  for (const [key, val] of Object.entries(updates)) {
    if (val === "") {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  // Synchronize settings updates to model-config.json (synchronous)
  const settingKeys = Object.keys(updates).filter(k =>
    k === "SUPERAGENT_MAX_CONCURRENCY" ||
    k === "SUPERAGENT_RATE_LIMIT_RPM" ||
    k === "SUPERAGENT_RATE_LIMIT_CAPACITY" ||
    k === "DISABLE_STREAMING" ||
    k === "CONTEXT_WINDOW_LIMIT" ||
    k === "MAX_CONTEXT_TOKENS" ||
    k === "MAX_ITERATIONS"
  );

  if (settingKeys.length > 0) {
    try {
      const config = loadModelConfig();
      if (!config.settings) {
        config.settings = { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60, disableStreaming: false, contextWindowLimit: 0, maxIterations: 50 };
      }
      for (const key of settingKeys) {
        const val = updates[key];
        if (key === "SUPERAGENT_MAX_CONCURRENCY") {
          config.settings.concurrencyLimit = parseInt(val, 10) || 0;
        } else if (key === "SUPERAGENT_RATE_LIMIT_RPM") {
          config.settings.rateLimitRpm = parseInt(val, 10) || 0;
        } else if (key === "SUPERAGENT_RATE_LIMIT_CAPACITY") {
          config.settings.rateLimitCapacity = parseInt(val, 10) || 0;
        } else if (key === "DISABLE_STREAMING") {
          config.settings.disableStreaming = val === "true";
        } else if (key === "CONTEXT_WINDOW_LIMIT" || key === "MAX_CONTEXT_TOKENS") {
          config.settings.contextWindowLimit = parseInt(val, 10) || 0;
        } else if (key === "MAX_ITERATIONS") {
          config.settings.maxIterations = parseInt(val, 10) || 50;
        }
      }
      saveModelConfig(config);
    } catch (err) {
      // Ignore sync errors
    }
  }

  // Return the JSON config path (for backward compatibility with callers that use the return value)
  return getRootConfigDir() + "/model-config.json";
}
