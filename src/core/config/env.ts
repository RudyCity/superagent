import { ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
import { loadModelConfig } from "./jsonConfig.js";
import fs from "fs";
import path from "path";

// Populate process.env with credentials and settings from model-config.json on startup
try {
  const config = loadModelConfig();
  const providers = config.providers;
  for (const provider of providers) {
    const prefix = provider.provider.toUpperCase();
    if (provider.apiKey) {
      process.env[`PROVIDER_${prefix}_API_KEY`] = provider.apiKey;
      if (provider.provider === "openai") {
        process.env.OPENAI_API_KEY = provider.apiKey;
      } else if (provider.provider === "anthropic") {
        process.env.ANTHROPIC_API_KEY = provider.apiKey;
      }
    }
    if (provider.baseUrl) {
      process.env[`PROVIDER_${prefix}_BASE_URL`] = provider.baseUrl;
      if (provider.provider === "custom") {
        process.env.CUSTOM_BASE_URL = provider.baseUrl;
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
  const parts = (val || "").split(":");
  if (parts.length >= 2) {
    return { providerProfileId: parts[0], model: parts[1] };
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

  // Synchronize model updates back to the active preset in model-config.json
  const modelKeys = Object.keys(updates).filter(k => k.startsWith("MODEL") && k !== "MODEL_LIMITS");
  if (modelKeys.length > 0) {
    try {
      const isMulti = Object.keys(updates).some(
        (k) => k.includes("MULTI") || k.includes("DEPTH_0") || k.includes("DEPTH_1") || k.includes("MASTER")
      ) || process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
      const mode = isMulti ? "multi" : "single";

      // Use dynamic import to prevent circular dependency
      import("./jsonConfig.js").then(({ getActivePreset, savePreset }) => {
        const preset = getActivePreset<any>(mode);

        for (const key of modelKeys) {
          const val = updates[key];
          if (!val) continue;
          const parsed = parseTierConfig(val);

          if (mode === "multi") {
            if (key === "MODEL_MULTI_DEPTH_0" || key === "MODEL_MULTI_DEPT0" || key === "MODEL_MULTI_MASTER" || key === "MODEL_DEPTH_0" || key === "MODEL_DEPT0") {
              preset.models.master = parsed;
            } else if (key === "MODEL_MULTI_DEPTH_1" || key === "MODEL_MULTI_DEPT1" || key === "MODEL_MULTI_SUPERAGENT" || key === "MODEL_DEPTH_1" || key === "MODEL_DEPT1") {
              preset.models.superagent = parsed;
            } else if (key === "MODEL_MULTI_DEPTH_2" || key === "MODEL_MULTI_DEPT2" || key === "MODEL_MULTI_SUBAGENT" || key === "MODEL_DEPTH_2" || key === "MODEL_DEPT2") {
              preset.models.subagentDefault = parsed;
            } else if (key.startsWith("MODEL_MULTI_SUBAGENT_")) {
              const type = key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase();
              preset.models.subagentDetails[type] = parsed;
            } else if (key.startsWith("MODEL_SUBAGENT_")) {
              const type = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              preset.models.subagentDetails[type] = parsed;
            }
          } else {
            if (key === "MODEL_SINGLE" || key === "MODEL") {
              preset.models.superagent = parsed;
            } else if (key === "MODEL_SINGLE_SUBAGENT" || key === "MODEL_SINGLE_DEPTH_2") {
              preset.models.subagentDefault = parsed;
            } else if (key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
              const type = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
              preset.models.subagentDetails[type] = parsed;
            }
          }
        }
        savePreset(mode, preset);
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
