import fs from "fs";
import { getModelConfigPath, ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";

export interface ProviderProfile {
  id: string;
  name: string;
  provider: string; // e.g. 'openai', 'anthropic', 'openrouter', 'custom'
  apiKey: string;
  baseUrl?: string;
}

export interface TierModelConfig {
  providerProfileId: string;
  model: string;
}

export interface PresetModelsMulti {
  master: TierModelConfig;
  superagent: TierModelConfig;
  subagentDefault: TierModelConfig;
  subagentDetails: Record<string, TierModelConfig>;
}

export interface PresetModelsSingle {
  superagent: TierModelConfig;
  subagentDefault: TierModelConfig;
  subagentDetails: Record<string, TierModelConfig>;
}

export interface JSONModelPreset<T> {
  id: string;
  name: string;
  description: string;
  models: T;
}

export interface SystemSettings {
  concurrencyLimit: number;
  rateLimitRpm: number;
  rateLimitCapacity: number;
  disableStreaming: boolean;
  contextWindowLimit: number;
  maxIterations: number;
}

export interface GlobalModelConfig {
  providers: ProviderProfile[];
  presets: {
    multi: JSONModelPreset<PresetModelsMulti>[];
    single: JSONModelPreset<PresetModelsSingle>[];
  };
  activePresetId: {
    multi: string;
    single: string;
  };
  settings?: SystemSettings;
}

const DEFAULT_CONFIG: GlobalModelConfig = {
  settings: {
    concurrencyLimit: 0,
    rateLimitRpm: 60,
    rateLimitCapacity: 60,
    disableStreaming: false,
    contextWindowLimit: 0,
    maxIterations: 50,
  },
  providers: [
    {
      id: "default-anthropic",
      name: "Default Anthropic",
      provider: "anthropic",
      apiKey: "",
      baseUrl: "",
    },
    {
      id: "default-openai",
      name: "Default OpenAI",
      provider: "openai",
      apiKey: "",
      baseUrl: "",
    }
  ],
  presets: {
    multi: [
      {
        id: "default-multi",
        name: "Default Multi-Agent Setup",
        description: "Standard configuration using Claude Sonnet and GPT-4o-mini",
        models: {
          master: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          superagent: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          subagentDefault: {
            providerProfileId: "default-openai",
            model: "gpt-4o-mini",
          },
          subagentDetails: {},
        },
      },
    ],
    single: [
      {
        id: "default-single",
        name: "Default Single-Agent Setup",
        description: "Standard single-agent setup using Claude Sonnet and GPT-4o-mini",
        models: {
          superagent: {
            providerProfileId: "default-anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          subagentDefault: {
            providerProfileId: "default-openai",
            model: "gpt-4o-mini",
          },
          subagentDetails: {},
        },
      },
    ],
  },
  activePresetId: {
    multi: "default-multi",
    single: "default-single",
  },
};

let cachedConfig: GlobalModelConfig | null = null;

export function clearModelConfigCache(): void {
  cachedConfig = null;
}

export function loadModelConfig(): GlobalModelConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  const configPath = getModelConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(data);
      // Basic migrations/fallback validation
      if (!parsed?.providers) {
        // File exists but providers field is invalid/missing — back up before repairing
        try {
          const backupPath = configPath + ".corrupt-" + Date.now();
          fs.copyFileSync(configPath, backupPath);
          console.warn(`model-config.json had invalid providers field. Backed up to: ${backupPath}`);
        } catch {}
        // Repair: keep any existing presets/activePresetId, only reset providers to defaults
        const fallbackConfig: GlobalModelConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        if (parsed?.presets) {
          fallbackConfig.presets = parsed.presets;
        }
        if (parsed?.activePresetId) {
          fallbackConfig.activePresetId = parsed.activePresetId;
        }
        if (parsed?.settings) {
          fallbackConfig.settings = parsed.settings;
        }
        console.warn(`[WARNING] model-config.json providers were invalid. Reset to defaults. Presets and settings preserved.`);
        cachedConfig = fallbackConfig;
        saveModelConfig(fallbackConfig);
      } else {
        // Validate and repair missing presets / activePresetId (e.g. from older app versions)
        if (!parsed.presets || !parsed.presets.multi || !parsed.presets.single) {
          parsed.presets = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets));
        }
        if (!parsed.activePresetId || !parsed.activePresetId.multi || !parsed.activePresetId.single) {
          parsed.activePresetId = JSON.parse(JSON.stringify(DEFAULT_CONFIG.activePresetId));
        }

        // Repair stale providerProfileIds: if a preset references a non-existent provider,
        // replace it with a valid provider that has an API key (or the first provider).
        const providerIds = new Set((parsed.providers || []).map((p: any) => p.id));
        const firstProviderWithKey = (parsed.providers || []).find(
          (p: any) => p.apiKey && p.apiKey.trim() !== ""
        );
        const fallbackProviderId = firstProviderWithKey?.id || parsed.providers?.[0]?.id || "";

        if (fallbackProviderId) {
          let repaired = false;
          for (const mode of ["multi", "single"] as const) {
            const presetsList = parsed.presets?.[mode] as any[] | undefined;
            if (!presetsList) continue;
            for (const preset of presetsList) {
              if (!preset?.models) continue;
              const models = preset.models;
              const tierKeys = ["master", "superagent", "subagentDefault"];
              for (const key of tierKeys) {
                if (models[key]?.providerProfileId && !providerIds.has(models[key].providerProfileId)) {
                  models[key].providerProfileId = fallbackProviderId;
                  repaired = true;
                }
              }
              if (models.subagentDetails) {
                for (const subKey of Object.keys(models.subagentDetails)) {
                  if (models.subagentDetails[subKey]?.providerProfileId && !providerIds.has(models.subagentDetails[subKey].providerProfileId)) {
                    models.subagentDetails[subKey].providerProfileId = fallbackProviderId;
                    repaired = true;
                  }
                }
              }
            }
          }
          if (repaired) {
            // Persist the repaired config with retry for Windows EPERM
            try {
              const tmpPath = configPath + ".tmp";
              fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf-8");
              for (let attempt = 0; attempt <= 3; attempt++) {
                try {
                  fs.renameSync(tmpPath, configPath);
                  break;
                } catch (renameErr: any) {
                  if (attempt < 3 && (renameErr?.code === "EPERM" || renameErr?.code === "EBUSY")) {
                    const end = Date.now() + (attempt + 1) * 50;
                    while (Date.now() < end) { /* busy wait */ }
                    continue;
                  }
                  throw renameErr;
                }
              }
            } catch {
              // Ignore repair write errors
            }
          }
        }

        cachedConfig = parsed;
      }
      return cachedConfig!;
    }
  } catch (error) {
    console.error("Error reading model-config.json:", error);
    // Back up the corrupted file before overwriting with defaults
    try {
      if (fs.existsSync(configPath)) {
        const backupPath = configPath + ".corrupt-" + Date.now();
        fs.copyFileSync(configPath, backupPath);
        console.warn(`model-config.json was corrupted. Backed up to: ${backupPath}`);
      }
    } catch {}
  }

  // Fallback to default — do NOT set cachedConfig until save succeeds
  const defaultConfig: GlobalModelConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const saveResult = saveModelConfig(defaultConfig);
  if (saveResult) {
    cachedConfig = defaultConfig;
  } else {
    // Save failed (e.g. directory creation failed). Set cache anyway so the app
    // can still function in-memory, but log a critical warning.
    cachedConfig = defaultConfig;
    console.error("CRITICAL: Failed to persist model-config.json to disk. Credentials will be lost on restart. Check permissions for: " + getRootConfigDir());
  }
  return cachedConfig!;
}

export function saveModelConfig(config: GlobalModelConfig): boolean {
  const configPath = getModelConfigPath();
  try {
    ensureGlobalConfigDir();
    // Atomic write: write to a temp file first, then rename.
    // This prevents file corruption if the process is killed (Ctrl+C, crash)
    // during the write — the original file stays intact until rename completes.
    const tmpPath = configPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");

    // Retry logic for Windows EPERM: antivirus, Windows Search Indexer, or
    // OneDrive may momentarily lock the target file. Retry up to 3 times
    // with a short delay between attempts.
    const MAX_RETRIES = 3;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        fs.renameSync(tmpPath, configPath);
        break; // Success
      } catch (renameErr: any) {
        if (attempt < MAX_RETRIES && (renameErr?.code === "EPERM" || renameErr?.code === "EBUSY")) {
          // Wait briefly before retrying (50ms, 100ms, 150ms)
          const waitMs = (attempt + 1) * 50;
          const end = Date.now() + waitMs;
          while (Date.now() < end) { /* busy wait — short duration */ }
          continue;
        }
        throw renameErr; // Re-throw if not EPERM/EBUSY or retries exhausted
      }
    }

    cachedConfig = config;
    return true;
  } catch (error) {
    console.error("Error writing model-config.json:", error);
    // Clean up temp file if rename failed but write succeeded
    try { fs.unlinkSync(configPath + ".tmp"); } catch {}
    return false;
  }
}

export function getProviders(): ProviderProfile[] {
  return loadModelConfig().providers;
}

export function addProvider(profile: ProviderProfile): void {
  const config = loadModelConfig();
  const index = config.providers.findIndex((p) => p.id === profile.id);
  if (index !== -1) {
    config.providers[index] = profile;
  } else {
    config.providers.push(profile);
  }
  if (!saveModelConfig(config)) {
    throw new Error("Failed to save provider credentials to disk. Check permissions for: " + getRootConfigDir());
  }
}

export function removeProvider(id: string): void {
  const config = loadModelConfig();
  config.providers = config.providers.filter((p) => p.id !== id);
  if (!saveModelConfig(config)) {
    throw new Error("Failed to save provider removal to disk. Check permissions for: " + getRootConfigDir());
  }
}

/**
 * Get system settings with defaults filled in for any missing fields.
 */
export function getSettings(): SystemSettings {
  const config = loadModelConfig();
  const s: Partial<SystemSettings> = config.settings || {};
  return {
    concurrencyLimit: s.concurrencyLimit ?? 0,
    rateLimitRpm: s.rateLimitRpm ?? 60,
    rateLimitCapacity: s.rateLimitCapacity ?? 60,
    disableStreaming: s.disableStreaming ?? false,
    contextWindowLimit: s.contextWindowLimit ?? 0,
    maxIterations: s.maxIterations ?? 50,
  };
}

/**
 * Update one or more settings and persist to model-config.json.
 * Also updates process.env so runtime checks stay in sync.
 */
export function updateSettings(updates: Partial<SystemSettings>): void {
  const config = loadModelConfig();
  if (!config.settings) {
    config.settings = { ...DEFAULT_CONFIG.settings! };
  }
  Object.assign(config.settings, updates);
  saveModelConfig(config);

  // Sync to process.env for backward-compatible runtime checks
  if (updates.concurrencyLimit !== undefined) {
    process.env.SUPERAGENT_MAX_CONCURRENCY = String(updates.concurrencyLimit);
  }
  if (updates.rateLimitRpm !== undefined) {
    process.env.SUPERAGENT_RATE_LIMIT_RPM = String(updates.rateLimitRpm);
  }
  if (updates.rateLimitCapacity !== undefined) {
    process.env.SUPERAGENT_RATE_LIMIT_CAPACITY = String(updates.rateLimitCapacity);
  }
  if (updates.disableStreaming !== undefined) {
    process.env.DISABLE_STREAMING = updates.disableStreaming ? "true" : "";
  }
  if (updates.contextWindowLimit !== undefined) {
    process.env.CONTEXT_WINDOW_LIMIT = updates.contextWindowLimit > 0 ? String(updates.contextWindowLimit) : "";
  }
  if (updates.maxIterations !== undefined) {
    process.env.MAX_ITERATIONS = String(updates.maxIterations);
  }
}

export function getPresets(mode: "multi" | "single") {
  return loadModelConfig().presets[mode];
}

export function savePreset<T>(mode: "multi" | "single", preset: JSONModelPreset<T>): void {
  const config = loadModelConfig();
  const presetsList = config.presets[mode] as any[];
  const index = presetsList.findIndex((p) => p.id === preset.id);
  if (index !== -1) {
    presetsList[index] = preset;
  } else {
    presetsList.push(preset);
  }
  if (!saveModelConfig(config)) {
    throw new Error("Failed to save preset to disk. Check permissions for: " + getRootConfigDir());
  }
}

export function deletePreset(mode: "multi" | "single", id: string): void {
  const config = loadModelConfig();
  config.presets[mode] = (config.presets[mode] as any[]).filter((p) => p.id !== id);
  if (!saveModelConfig(config)) {
    throw new Error("Failed to save preset deletion to disk. Check permissions for: " + getRootConfigDir());
  }
}

export function getActivePresetId(mode: "multi" | "single"): string {
  const config = loadModelConfig();
  return config.activePresetId?.[mode] || DEFAULT_CONFIG.activePresetId[mode];
}

export function setActivePresetId(mode: "multi" | "single", id: string): void {
  const config = loadModelConfig();
  config.activePresetId[mode] = id;
  if (!saveModelConfig(config)) {
    throw new Error("Failed to save active preset ID to disk. Check permissions for: " + getRootConfigDir());
  }
}

export function getActivePreset<T>(mode: "multi" | "single"): JSONModelPreset<T> {
  const config = loadModelConfig();
  const activeId = getActivePresetId(mode);
  const presetsList = config.presets?.[mode] as any[] | undefined;
  if (presetsList) {
    const preset = presetsList.find((p) => p.id === activeId);
    if (preset) {
      return preset;
    }
    // Fallback to the first preset in the list
    if (presetsList.length > 0) {
      return presetsList[0] as any;
    }
  }
  // Last resort: return a DEEP COPY of the default to prevent mutating DEFAULT_CONFIG
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets[mode][0])) as any;
}

export function getActiveConfigAudit(overrideMode?: "multi" | "single"): string {
  const mode = overrideMode || (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true" ? "multi" : "single");
  const preset = getActivePreset<any>(mode);
  
  let lines = [
    `│ ✦ Active Preset   : ${preset.name} (${mode}-agent mode)`
  ];

  if (mode === "multi") {
    const m = preset.models;
    lines.push(`│ ✦ Master Agent    : ${m.master?.providerProfileId || "(default)"} ➔ ${m.master?.model || "(not set)"}`);
    lines.push(`│ ✦ Superagent      : ${m.superagent?.providerProfileId || "(default)"} ➔ ${m.superagent?.model || "(not set)"}`);
    lines.push(`│ ✦ Subagent Default: ${m.subagentDefault?.providerProfileId || "(default)"} ➔ ${m.subagentDefault?.model || "(not set)"}`);
    if (m.subagentDetails && Object.keys(m.subagentDetails).length > 0) {
      for (const [t, cfg] of Object.entries(m.subagentDetails)) {
        lines.push(`│ ✦ Subagent (${t}): ${(cfg as any).providerProfileId} ➔ ${(cfg as any).model}`);
      }
    }
  } else {
    const m = preset.models;
    lines.push(`│ ✦ Superagent      : ${m.superagent?.providerProfileId || "(default)"} ➔ ${m.superagent?.model || "(not set)"}`);
    lines.push(`│ ✦ Subagent Default: ${m.subagentDefault?.providerProfileId || "(default)"} ➔ ${m.subagentDefault?.model || "(not set)"}`);
    if (m.subagentDetails && Object.keys(m.subagentDetails).length > 0) {
      for (const [t, cfg] of Object.entries(m.subagentDetails)) {
        lines.push(`│ ✦ Subagent (${t}): ${(cfg as any).providerProfileId} ➔ ${(cfg as any).model}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Get model info for display purposes from JSON config.
 * Returns formatted model strings for each tier.
 */
export function getModelInfoForDisplay(isMulti: boolean): {
  activeProvider: string;
  master: string;
  superagent: string;
  subagentDefault: string;
  subagentDetails: Record<string, string>;
} {
  const mode = isMulti ? "multi" : "single";
  const preset = getActivePreset<any>(mode);
  const config = loadModelConfig();
  const models = preset.models || {};

  // Get active provider from the main tier config
  const mainTier = isMulti ? models.master : models.superagent;
  const activeProvider = mainTier?.providerProfileId || "";

  const formatModel = (tier: any): string => {
    if (!tier?.model) return "(use default)";
    if (tier.providerProfileId) {
      const profile = config.providers.find(p => p.id === tier.providerProfileId);
      if (profile) {
        return `${profile.provider}@${tier.model}`;
      }
    }
    return tier.model;
  };

  const subagentDetails: Record<string, string> = {};
  if (models.subagentDetails) {
    for (const [type, cfg] of Object.entries(models.subagentDetails)) {
      if (cfg && typeof cfg === "object" && "model" in cfg) {
        subagentDetails[type] = formatModel(cfg);
      }
    }
  }

  return {
    activeProvider,
    master: formatModel(models.master),
    superagent: formatModel(models.superagent),
    subagentDefault: formatModel(models.subagentDefault),
    subagentDetails,
  };
}

