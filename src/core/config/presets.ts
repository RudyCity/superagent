import fs from "fs";
import path from "path";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { updateEnvFile } from "./env.js";
import { switchActiveProvider } from "./providers.js";
import { loadModelConfig } from "./jsonConfig.js";

export type PresetMode = "multi" | "single";

export interface ModelPreset {
  name: string;
  description: string;
  models: Record<string, string>;
}

/** New separated JSON structure */
export interface ModelPresetsFile {
  multi: ModelPreset[];
  single: ModelPreset[];
}

export function getCustomPresetsPath(): string {
  return path.join(getRootConfigDir(), "model-presets.json");
}

export const BUILT_IN_PRESETS: ModelPreset[] = [];

const EMPTY_FILE: ModelPresetsFile = { multi: [], single: [] };

/**
 * Read the model-presets.json file.
 * - Handles new format: { multi: [...], single: [...] }
 * - Auto-migrates old format: [...] (flat array) into the new structure.
 *   Old presets with mode field go to their respective section;
 *   old presets without mode field go to "multi" as default.
 */
function readPresetsFile(): ModelPresetsFile {
  const customPath = getCustomPresetsPath();
  if (!fs.existsSync(customPath)) {
    return { ...EMPTY_FILE, multi: [], single: [] };
  }

  try {
    const data = JSON.parse(fs.readFileSync(customPath, "utf-8"));

    // New format: { multi: [...], single: [...] }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const multi = Array.isArray(data.multi) ? data.multi : [];
      const single = Array.isArray(data.single) ? data.single : [];
      return {
        multi: multi.map(cleanPreset),
        single: single.map(cleanPreset),
      };
    }

    // Old format: [...] (flat array) — migrate
    if (Array.isArray(data)) {
      const result: ModelPresetsFile = { multi: [], single: [] };
      for (const p of data) {
        if (p && typeof p === "object" && typeof p.name === "string" && p.models && typeof p.models === "object") {
          const clean: ModelPreset = {
            name: p.name.toLowerCase(),
            description: p.description || "Custom model preset.",
            models: p.models,
          };
          // Route based on old mode field if present
          if (p.mode === "single") {
            result.single.push(clean);
          } else {
            result.multi.push(clean);
          }
        }
      }
      // Write migrated file back
      ensureGlobalConfigDir();
      fs.writeFileSync(customPath, JSON.stringify(result, null, 2), "utf-8");
      return result;
    }
  } catch {
    // Ignore corruption
  }

  return { multi: [], single: [] };
}

function cleanPreset(p: any): ModelPreset {
  return {
    name: (typeof p.name === "string" ? p.name : "").toLowerCase(),
    description: p.description || "Custom model preset.",
    models: p.models && typeof p.models === "object" ? p.models : {},
  };
}

function writePresetsFile(data: ModelPresetsFile): void {
  const customPath = getCustomPresetsPath();
  ensureGlobalConfigDir();
  fs.writeFileSync(customPath, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Get all model presets for a specific mode.
 * - mode is REQUIRED — presets are physically separated by mode in the JSON file.
 * - If mode is omitted, returns all presets from both sections (with mode tag for display).
 */
export function getModelPresets(mode?: PresetMode): (ModelPreset & { mode?: PresetMode })[] {
  const fileData = readPresetsFile();

  if (mode) {
    return fileData[mode].map(p => ({ ...p, mode }));
  }

  // Return all presets from both sections with mode tag
  return [
    ...fileData.multi.map(p => ({ ...p, mode: "multi" as PresetMode })),
    ...fileData.single.map(p => ({ ...p, mode: "single" as PresetMode })),
  ];
}

/**
 * Save a model preset into the mode-specific section of model-presets.json.
 * - mode is REQUIRED to determine which section to store in.
 *   Defaults to "multi" if not provided (backward compat).
 */
export function saveModelPreset(name: string, description: string, models?: Record<string, string>, mode?: PresetMode): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot overwrite built-in preset "${name}"`);
  }

  const targetMode: PresetMode = mode || "multi";

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

  const fileData = readPresetsFile();
  const section = fileData[targetMode];

  const newPreset: ModelPreset = {
    name: presetName,
    description: description || "Custom model preset.",
    models: modelsToSave,
  };

  const existingIdx = section.findIndex(p => p.name === presetName);
  if (existingIdx !== -1) {
    section[existingIdx] = newPreset;
  } else {
    section.push(newPreset);
  }

  writePresetsFile(fileData);
  return getCustomPresetsPath();
}

/**
 * Apply a model preset by name from a specific mode section.
 * - mode is REQUIRED to know which section to search.
 *   Defaults to "multi" if not provided.
 */
export function applyModelPreset(name: string, mode?: PresetMode): string {
  const targetMode: PresetMode = mode || "multi";
  const fileData = readPresetsFile();
  const targetName = name.toLowerCase().trim();

  const preset = fileData[targetMode].find(p => p.name.toLowerCase() === targetName);
  if (!preset) {
    throw new Error(`Model preset "${name}" not found in ${targetMode}-agent presets.`);
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

/**
 * Delete a model preset by name from a specific mode section.
 */
export function deleteModelPreset(name: string, mode?: PresetMode): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot delete built-in preset "${name}"`);
  }

  const targetMode: PresetMode = mode || "multi";
  const fileData = readPresetsFile();
  const section = fileData[targetMode];

  const existingIdx = section.findIndex(p => p.name === presetName);
  if (existingIdx === -1) {
    throw new Error(`Model preset "${name}" not found in ${targetMode}-agent presets.`);
  }

  section.splice(existingIdx, 1);
  writePresetsFile(fileData);
  return getCustomPresetsPath();
}

/**
 * Update a model preset by name in a specific mode section.
 */
export function updateModelPreset(name: string, description: string, models?: Record<string, string>, mode?: PresetMode): string {
  const presetName = name.toLowerCase().trim();
  if (!presetName) {
    throw new Error("Preset name cannot be empty");
  }
  if (BUILT_IN_PRESETS.some(bp => bp.name === presetName)) {
    throw new Error(`Cannot edit built-in preset "${name}"`);
  }

  const targetMode: PresetMode = mode || "multi";
  const fileData = readPresetsFile();
  const section = fileData[targetMode];

  const existingIdx = section.findIndex(p => p.name === presetName);
  if (existingIdx === -1) {
    throw new Error(`Model preset "${name}" not found in ${targetMode}-agent presets.`);
  }

  section[existingIdx] = {
    name: presetName,
    description: description || section[existingIdx].description,
    models: models || section[existingIdx].models,
  };

  writePresetsFile(fileData);
  return getCustomPresetsPath();
}
