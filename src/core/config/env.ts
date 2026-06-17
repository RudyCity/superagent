import { ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
import { loadModelConfig } from "./jsonConfig.js";
import fs from "fs";
import path from "path";

// Populate process.env with credentials and settings from model-config.json on startup
try {
  const config = loadModelConfig();
  const providers = config.providers;
  const setKey = (envName: string, value: string | undefined) => {
    if (value && value.trim() !== "") {
      process.env[envName] = value;
    }
  };
  for (const provider of providers) {
    const prefix = provider.provider.toUpperCase();
    const hasKey = !!(provider.apiKey && provider.apiKey.trim() !== "");
    if (hasKey) {
      setKey(`PROVIDER_${prefix}_API_KEY`, provider.apiKey);
      if (provider.provider === "openai") {
        setKey("OPENAI_API_KEY", provider.apiKey);
      } else if (provider.provider === "anthropic") {
        setKey("ANTHROPIC_API_KEY", provider.apiKey);
      }
    }
    if (provider.baseUrl && provider.baseUrl.trim() !== "") {
      setKey(`PROVIDER_${prefix}_BASE_URL`, provider.baseUrl);
      if (provider.provider === "custom") {
        setKey("CUSTOM_BASE_URL", provider.baseUrl);
      }
    }
  }
  if (config.settings) {
    if (config.settings.concurrencyLimit !== undefined) {
      process.env.SUPERAGENT_MAX_CONCURRENCY = String(config.settings.concurrencyLimit);
    }
    if (config.settings.rateLimitRpm !== undefined) {
      process.env.SUPERAGENT_RATE_LIMIT_RPM = String(config.settings.rateLimitRpm);
    }
    if (config.settings.rateLimitCapacity !== undefined) {
      process.env.SUPERAGENT_RATE_LIMIT_CAPACITY = String(config.settings.rateLimitCapacity);
    }
  }
} catch (error) {
  // Ignore errors during initial startup load
}

function parseTierConfig(val: string) {
  const colonIndex = (val || "").indexOf(":");
  if (colonIndex > 0) {
    return { providerProfileId: val.substring(0, colonIndex), model: val.substring(colonIndex + 1) };
  }
  return { providerProfileId: "default-openai", model: val || "gpt-4o" };
}

export function updateEnvFile(updates: Record<string, string>): string {
  ensureGlobalConfigDir();

  // Also update process.env so it's immediate in memory!
  for (const [key, val] of Object.entries(updates)) {
    if (val === "") {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }

  // Safety net: when ACTIVE_PROVIDER is set, ensure matching credentials are in updates
  if (updates.ACTIVE_PROVIDER) {
    const activeProvider = updates.ACTIVE_PROVIDER.toLowerCase();
    const prefix = `PROVIDER_${activeProvider.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
    if (!updates[`${prefix}_API_KEY`]) {
      try {
        const config = loadModelConfig();
        const providers = config.providers || [];
        const matchedProfile = providers.find(
          (p) => p.id?.toLowerCase() === activeProvider || p.name?.toLowerCase() === activeProvider
        );
        const fallbackProviderType = matchedProfile?.provider?.toLowerCase() || activeProvider;
        const fallbackProfile = matchedProfile && matchedProfile.apiKey && matchedProfile.apiKey.trim() !== ""
          ? matchedProfile
          : providers.find(
              (p) => (p.provider || "").toLowerCase() === fallbackProviderType && p.apiKey && p.apiKey.trim() !== ""
            );
        if (fallbackProfile && fallbackProfile.apiKey && fallbackProfile.apiKey.trim() !== "") {
          updates[`${prefix}_API_KEY`] = fallbackProfile.apiKey;
          process.env[`${prefix}_API_KEY`] = fallbackProfile.apiKey;
          if (fallbackProfile.baseUrl && fallbackProfile.baseUrl.trim() !== "") {
            updates[`${prefix}_BASE_URL`] = fallbackProfile.baseUrl;
            process.env[`${prefix}_BASE_URL`] = fallbackProfile.baseUrl;
          }
          updates[`${prefix}_TYPE`] = fallbackProfile.provider || activeProvider;
          process.env[`${prefix}_TYPE`] = fallbackProfile.provider || activeProvider;
        }
      } catch (err) {
        // Ignore errors
      }
    }
  }

  // Synchronize model updates back to the active preset in model-config.json
  // Only canonical MODEL_MULTI_* and MODEL_SINGLE_* keys are synced
  const multiKeys = Object.keys(updates).filter(k => k.startsWith("MODEL_MULTI_"));
  const singleKeys = Object.keys(updates).filter(k => k.startsWith("MODEL_SINGLE_"));
  if (multiKeys.length > 0 || singleKeys.length > 0) {
    try {
      // Determine which modes to sync based on which canonical keys are present
      const modesToSync: ("multi" | "single")[] = [];
      if (multiKeys.length > 0) modesToSync.push("multi");
      if (singleKeys.length > 0) modesToSync.push("single");
      // Fallback: if no mode-specific keys matched, check argv/env
      if (modesToSync.length === 0) {
        if (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true") {
          modesToSync.push("multi");
        } else {
          modesToSync.push("single");
        }
      }

      // Use dynamic import to prevent circular dependency
      import("./jsonConfig.js").then(({ getActivePreset, savePreset }) => {
        for (const mode of modesToSync) {
          const keysForMode = mode === "multi" ? multiKeys : singleKeys;
          if (keysForMode.length === 0) continue;

          const preset = getActivePreset<any>(mode);

          // Ensure subagentDetails exists
          if (!preset.models.subagentDetails) {
            preset.models.subagentDetails = {};
          }

          for (const key of keysForMode) {
            const val = updates[key];
            const isClear = !val || val.trim() === "";

            if (mode === "multi") {
              if (key === "MODEL_MULTI_MASTER") {
                if (!isClear) preset.models.master = parseTierConfig(val);
              } else if (key === "MODEL_MULTI_SUPERAGENT") {
                if (!isClear) preset.models.superagent = parseTierConfig(val);
              } else if (key === "MODEL_MULTI_SUBAGENT") {
                if (!isClear) preset.models.subagentDefault = parseTierConfig(val);
              } else if (key.startsWith("MODEL_MULTI_SUBAGENT_")) {
                const type = key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase();
                if (isClear) {
                  delete preset.models.subagentDetails[type];
                } else {
                  preset.models.subagentDetails[type] = parseTierConfig(val);
                }
              }
            } else {
              // Single mode
              if (key === "MODEL_SINGLE_SUPERAGENT") {
                if (!isClear) preset.models.superagent = parseTierConfig(val);
              } else if (key === "MODEL_SINGLE_SUBAGENT") {
                if (!isClear) preset.models.subagentDefault = parseTierConfig(val);
              } else if (key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
                const type = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
                if (isClear) {
                  delete preset.models.subagentDetails[type];
                } else {
                  preset.models.subagentDetails[type] = parseTierConfig(val);
                }
              }
            }
          }
          savePreset(mode, preset);
        }
      }).catch(() => {});
    } catch (err) {
      // Ignore sync errors
    }
  }

  // Synchronize settings updates back to model-config.json
  const settingKeys = Object.keys(updates).filter(k => 
    k === "SUPERAGENT_MAX_CONCURRENCY" || 
    k === "SUPERAGENT_RATE_LIMIT_RPM" || 
    k === "SUPERAGENT_RATE_LIMIT_CAPACITY"
  );
  if (settingKeys.length > 0) {
    try {
      // Use dynamic import to prevent circular dependency
      import("./jsonConfig.js").then(({ loadModelConfig, saveModelConfig }) => {
        const config = loadModelConfig();
        if (!config.settings) {
          config.settings = { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 };
        }
        for (const key of settingKeys) {
          const val = updates[key];
          if (key === "SUPERAGENT_MAX_CONCURRENCY") {
            config.settings.concurrencyLimit = parseInt(val, 10) || 0;
          } else if (key === "SUPERAGENT_RATE_LIMIT_RPM") {
            config.settings.rateLimitRpm = parseInt(val, 10) || 0;
          } else if (key === "SUPERAGENT_RATE_LIMIT_CAPACITY") {
            config.settings.rateLimitCapacity = parseInt(val, 10) || 0;
          }
        }
        saveModelConfig(config);
      }).catch(() => {});
    } catch (err) {
      // Ignore sync errors
    }
  }

  const envPath = path.join(getRootConfigDir(), ".env");
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith("#")) {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        if (key.startsWith("MODEL") || key === "ACTIVE_PROVIDER") {
          lines[i] = "";
          continue;
        }
        if (updates.hasOwnProperty(key)) {
          lines[i] = `${key}=${updates[key]}`;
          updatedKeys.add(key);
        }
      }
    }
  }

  for (const [key, val] of Object.entries(updates)) {
    if (!key.startsWith("MODEL") && key !== "ACTIVE_PROVIDER" && !updatedKeys.has(key)) {
      lines.push(`${key}=${val}`);
    }
  }

  const cleanLines = lines.filter(line => line.trim() !== "");

  fs.writeFileSync(envPath, cleanLines.join("\n"), "utf-8");
  return envPath;
}
