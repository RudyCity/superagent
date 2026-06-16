import fs from "fs";
import path from "path";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { updateEnvFile } from "./env.js";
import { switchActiveProvider } from "./providers.js";
import { loadModelConfig } from "./jsonConfig.js";

export interface ModelPreset {
  name: string;
  description: string;
  models: Record<string, string>;
}

export function getCustomPresetsPath(): string {
  return path.join(getRootConfigDir(), "model-presets.json");
}

export const BUILT_IN_PRESETS: ModelPreset[] = [];

export function getModelPresets(): ModelPreset[] {
  const presets = [...BUILT_IN_PRESETS];
  const customPath = getCustomPresetsPath();
  if (fs.existsSync(customPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(data)) {
        for (const p of data) {
          if (p && typeof p === "object" && typeof p.name === "string" && p.models && typeof p.models === "object") {
            const idx = presets.findIndex(bp => bp.name.toLowerCase() === p.name.toLowerCase());
            const cleanPreset = {
              name: p.name.toLowerCase(),
              description: p.description || "Custom model preset.",
              models: p.models
            };
            if (idx !== -1) {
              presets[idx] = cleanPreset;
            } else {
              presets.push(cleanPreset);
            }
          }
        }
      }
    } catch {
      // Ignore corruption
    }
  }
  return presets;
}

export function saveModelPreset(name: string, description: string, models?: Record<string, string>): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot overwrite built-in preset "${name}"`);
  }

  const modelsToSave: Record<string, string> = models || {};

  if (!models) {
    if (process.env.MODEL) modelsToSave.MODEL = process.env.MODEL;
    if (process.env.MODEL_DEPTH_0) modelsToSave.MODEL_DEPTH_0 = process.env.MODEL_DEPTH_0;
    if (process.env.MODEL_DEPT0) modelsToSave.MODEL_DEPT0 = process.env.MODEL_DEPT0;
    if (process.env.MODEL_DEPTH_1) modelsToSave.MODEL_DEPTH_1 = process.env.MODEL_DEPTH_1;
    if (process.env.MODEL_DEPT1) modelsToSave.MODEL_DEPT1 = process.env.MODEL_DEPT1;
    if (process.env.MODEL_DEPTH_2) modelsToSave.MODEL_DEPTH_2 = process.env.MODEL_DEPTH_2;
    if (process.env.MODEL_DEPT2) modelsToSave.MODEL_DEPT2 = process.env.MODEL_DEPT2;

    for (const [k, v] of Object.entries(process.env)) {
      if (v && k.startsWith("MODEL_SUBAGENT_")) {
        modelsToSave[k] = v;
      } else if (v && k.startsWith("MODEL_") && k !== "MODEL" && k !== "MODEL_LIMITS") {
        modelsToSave[k] = v;
      }
    }
  }

  if (Object.keys(modelsToSave).length === 0) {
    throw new Error("No model configuration settings found to save.");
  }

  const customPath = getCustomPresetsPath();
  let customPresets: ModelPreset[] = [];
  if (fs.existsSync(customPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(parsed)) {
        customPresets = parsed;
      }
    } catch {}
  }

  const newPreset: ModelPreset = {
    name: presetName,
    description: description || "Custom model preset.",
    models: modelsToSave
  };

  const existingIdx = customPresets.findIndex(p => p.name === presetName);
  if (existingIdx !== -1) {
    customPresets[existingIdx] = newPreset;
  } else {
    customPresets.push(newPreset);
  }

  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(customPresets, null, 2), "utf-8");
  return customPath;
}

export function applyModelPreset(name: string): string {
  const presets = getModelPresets();
  const preset = presets.find(p => p.name.toLowerCase() === name.toLowerCase().trim());
  if (!preset) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  const presetModel = preset.models.MODEL || preset.models.MODEL_DEPTH_0 || preset.models.MODEL_DEPT0 || "";
  let activeProvider = "";
  if (presetModel && presetModel.includes(":")) {
    activeProvider = presetModel.split(":")[0].toLowerCase();
  }

  const updates: Record<string, string> = {};

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MODEL_DEPTH_") || key.startsWith("MODEL_DEPT") || 
        (key.startsWith("MODEL_") && key !== "MODEL" && key !== "MODEL_LIMITS")) {
      updates[key] = "";
      delete process.env[key];
    }
  }

  for (const [key, val] of Object.entries(preset.models)) {
    updates[key] = val;
  }

  if (!preset.models.MODEL) {
    updates.MODEL = preset.models.MODEL_DEPTH_0 || preset.models.MODEL_DEPT0 || "gpt-4o";
  }

  if (activeProvider) {
    switchActiveProvider(activeProvider);
    updates.ACTIVE_PROVIDER = activeProvider;

    const config = loadModelConfig();
    const providers = config.providers || [];
    const matchedProfile = providers.find(
      (p) => p.id?.toLowerCase() === activeProvider || p.name?.toLowerCase() === activeProvider
    );
    const fallbackProfile = matchedProfile && matchedProfile.apiKey
      ? matchedProfile
      : providers.find(
          (p) => (p.provider || "").toLowerCase() === activeProvider && p.apiKey && p.apiKey.trim() !== ""
        );
    if (fallbackProfile && fallbackProfile.apiKey && fallbackProfile.apiKey.trim() !== "") {
      const prefix = `PROVIDER_${activeProvider.toUpperCase()}`;
      updates[`${prefix}_API_KEY`] = fallbackProfile.apiKey;
      if (fallbackProfile.baseUrl && fallbackProfile.baseUrl.trim() !== "") {
        updates[`${prefix}_BASE_URL`] = fallbackProfile.baseUrl;
      }
      updates[`${prefix}_TYPE`] = fallbackProfile.provider || activeProvider;
    }
  }

  return updateEnvFile(updates);
}

export function deleteModelPreset(name: string): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot delete built-in preset "${name}"`);
  }

  const customPath = getCustomPresetsPath();
  if (!fs.existsSync(customPath)) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  let customPresets: ModelPreset[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
    if (Array.isArray(parsed)) {
      customPresets = parsed;
    }
  } catch {}

  const existingIdx = customPresets.findIndex(p => p.name === presetName);
  if (existingIdx === -1) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  customPresets.splice(existingIdx, 1);
  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(customPresets, null, 2), "utf-8");
  return customPath;
}

export function updateModelPreset(name: string, description: string, models?: Record<string, string>): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot edit built-in preset "${name}"`);
  }

  const customPath = getCustomPresetsPath();
  let customPresets: ModelPreset[] = [];
  if (fs.existsSync(customPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(parsed)) {
        customPresets = parsed;
      }
    } catch {}
  }

  const existingIdx = customPresets.findIndex(p => p.name === presetName);
  if (existingIdx === -1) {
    throw new Error(`Model preset "${name}" not found.`);
  }

  customPresets[existingIdx] = {
    name: presetName,
    description: description || customPresets[existingIdx].description,
    models: models || customPresets[existingIdx].models
  };

  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(customPresets, null, 2), "utf-8");
  return customPath;
}
