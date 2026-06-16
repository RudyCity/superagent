import fs from "fs";
import { getModelConfigPath } from "./paths";

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
}

const DEFAULT_CONFIG: GlobalModelConfig = {
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
