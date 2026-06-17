import fs from "fs";
import { getModelConfigPath } from "./paths.js";

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
      cachedConfig = JSON.parse(data);
      // Basic migrations/fallback validation
      if (!cachedConfig?.providers) {
        cachedConfig = { ...DEFAULT_CONFIG };
      }
      return cachedConfig!;
    }
  } catch (error) {
    console.error("Error reading model-config.json:", error);
  }

  // Fallback to default
  cachedConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  saveModelConfig(cachedConfig!);
  return cachedConfig!;
}

export function saveModelConfig(config: GlobalModelConfig): void {
  const configPath = getModelConfigPath();
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    cachedConfig = config;
  } catch (error) {
    console.error("Error writing model-config.json:", error);
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
  saveModelConfig(config);
}

export function removeProvider(id: string): void {
  const config = loadModelConfig();
  config.providers = config.providers.filter((p) => p.id !== id);
  saveModelConfig(config);
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
  saveModelConfig(config);
}

export function deletePreset(mode: "multi" | "single", id: string): void {
  const config = loadModelConfig();
  config.presets[mode] = (config.presets[mode] as any[]).filter((p) => p.id !== id);
  saveModelConfig(config);
}

export function getActivePresetId(mode: "multi" | "single"): string {
  return loadModelConfig().activePresetId[mode] || DEFAULT_CONFIG.activePresetId[mode];
}

export function setActivePresetId(mode: "multi" | "single", id: string): void {
  const config = loadModelConfig();
  config.activePresetId[mode] = id;
  saveModelConfig(config);
}

export function getActivePreset<T>(mode: "multi" | "single"): JSONModelPreset<T> {
  const config = loadModelConfig();
  const activeId = getActivePresetId(mode);
  const preset = (config.presets[mode] as any[]).find((p) => p.id === activeId);
  if (preset) {
    return preset;
  }
  // Fallback to the first preset in the list
  if (config.presets[mode].length > 0) {
    return config.presets[mode][0] as any;
  }
  return DEFAULT_CONFIG.presets[mode][0] as any;
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
        return `${profile.provider}:${tier.model}`;
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

