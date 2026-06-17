import { ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
import { loadModelConfig } from "./jsonConfig.js";
import fs from "fs";
import path from "path";

// Populate process.env with settings from model-config.json on startup
// Provider credentials are resolved directly from JSON config - no env var population needed
try {
  const config = loadModelConfig();
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

// One-time migration: convert legacy bare MODEL_* keys to canonical MODEL_MULTI_* / MODEL_SINGLE_* keys.
// This handles users who have old .env files with bare keys like MODEL_DEPTH_0, MODEL_SUBAGENT_CODER, etc.
try {
  const BARE_TO_MULTI: Record<string, string> = {
    MODEL_DEPTH_0: "MODEL_MULTI_MASTER",
    MODEL_DEPT0: "MODEL_MULTI_MASTER",
    MODEL_DEPTH_1: "MODEL_MULTI_SUPERAGENT",
    MODEL_DEPT1: "MODEL_MULTI_SUPERAGENT",
    MODEL_DEPTH_2: "MODEL_MULTI_SUBAGENT",
    MODEL_DEPT2: "MODEL_MULTI_SUBAGENT",
    MODEL_MASTER: "MODEL_MULTI_MASTER",
    MODEL_SUPERAGENT: "MODEL_MULTI_SUPERAGENT",
    MODEL_SUBAGENT: "MODEL_MULTI_SUBAGENT",
    MODEL_SUBAGENT_RESEARCHER: "MODEL_MULTI_SUBAGENT_RESEARCHER",
    MODEL_SUBAGENT_CODER: "MODEL_MULTI_SUBAGENT_CODER",
    MODEL_SUBAGENT_REVIEWER: "MODEL_MULTI_SUBAGENT_REVIEWER",
    MODEL_RESEARCHER: "MODEL_MULTI_SUBAGENT_RESEARCHER",
    MODEL_CODER: "MODEL_MULTI_SUBAGENT_CODER",
    MODEL_REVIEWER: "MODEL_MULTI_SUBAGENT_REVIEWER",
  };

  let migrated = false;
  for (const [bareKey, canonicalKey] of Object.entries(BARE_TO_MULTI)) {
    const val = process.env[bareKey];
    if (val && val.trim() !== "") {
      // Only migrate if the canonical key is not already set
      if (!process.env[canonicalKey] || process.env[canonicalKey]!.trim() === "") {
        process.env[canonicalKey] = val;
      }
      delete process.env[bareKey];
      migrated = true;
    }
  }

  // Also migrate deprecated MODEL_MULTI_DEPTH_* / MODEL_MULTI_DEPT* aliases
  const DEPRECATED_ALIASES: Record<string, string> = {
    MODEL_MULTI_DEPTH_0: "MODEL_MULTI_MASTER",
    MODEL_MULTI_DEPT0: "MODEL_MULTI_MASTER",
    MODEL_MULTI_DEPTH_1: "MODEL_MULTI_SUPERAGENT",
    MODEL_MULTI_DEPT1: "MODEL_MULTI_SUPERAGENT",
    MODEL_MULTI_DEPTH_2: "MODEL_MULTI_SUBAGENT",
    MODEL_MULTI_DEPT2: "MODEL_MULTI_SUBAGENT",
    MODEL_MULTI_RESEARCHER: "MODEL_MULTI_SUBAGENT_RESEARCHER",
    MODEL_MULTI_CODER: "MODEL_MULTI_SUBAGENT_CODER",
    MODEL_MULTI_REVIEWER: "MODEL_MULTI_SUBAGENT_REVIEWER",
    MODEL_SINGLE_DEPTH_2: "MODEL_SINGLE_SUBAGENT",
    MODEL_SINGLE_RESEARCHER: "MODEL_SINGLE_SUBAGENT_RESEARCHER",
    MODEL_SINGLE_CODER: "MODEL_SINGLE_SUBAGENT_CODER",
    MODEL_SINGLE_REVIEWER: "MODEL_SINGLE_SUBAGENT_REVIEWER",
  };

  for (const [deprecatedKey, canonicalKey] of Object.entries(DEPRECATED_ALIASES)) {
    const val = process.env[deprecatedKey];
    if (val && val.trim() !== "") {
      if (!process.env[canonicalKey] || process.env[canonicalKey]!.trim() === "") {
        process.env[canonicalKey] = val;
      }
      delete process.env[deprecatedKey];
      migrated = true;
    }
  }

  // If migration happened, rewrite the .env file to persist canonical keys
  if (migrated) {
    const envPath = path.join(getRootConfigDir(), ".env");
    if (fs.existsSync(envPath)) {
      let content = fs.readFileSync(envPath, "utf-8");
      const allLegacyKeys = [...Object.keys(BARE_TO_MULTI), ...Object.keys(DEPRECATED_ALIASES)];
      const lines = content.split(/\r?\n/);
      const cleanLines: string[] = [];
      const writtenCanonical = new Set<string>();

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            const key = trimmed.substring(0, eqIdx).trim();
            if (allLegacyKeys.includes(key)) {
              // Skip legacy key — canonical version is already in process.env
              continue;
            }
          }
        }
        cleanLines.push(line);
      }

      // Append canonical keys that were migrated
      for (const [bareKey, canonicalKey] of Object.entries({ ...BARE_TO_MULTI, ...DEPRECATED_ALIASES })) {
        const val = process.env[canonicalKey];
        if (val && val.trim() !== "" && !writtenCanonical.has(canonicalKey)) {
          // Check if canonical key already exists in the file
          const exists = cleanLines.some(l => {
            const t = l.trim();
            return t && !t.startsWith("#") && t.startsWith(`${canonicalKey}=`);
          });
          if (!exists) {
            cleanLines.push(`${canonicalKey}=${val}`);
          }
          writtenCanonical.add(canonicalKey);
        }
      }

      fs.writeFileSync(envPath, cleanLines.filter(l => l.trim() !== "").join("\n"), "utf-8");
    }
  }
} catch (error) {
  // Ignore migration errors
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
