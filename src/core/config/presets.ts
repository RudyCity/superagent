import fs from "fs";
import path from "path";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { switchActiveProvider } from "./providers.js";
import { loadModelConfig, getActivePreset, savePreset } from "./jsonConfig.js";

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
      const result = {
        multi: multi.map(cleanPreset),
        single: single.map(cleanPreset),
      };
      // Migrate legacy bare keys in presets to canonical keys
      const migrated = migratePresetKeys(result);
      if (migrated) {
        ensureGlobalConfigDir();
        fs.writeFileSync(customPath, JSON.stringify(result, null, 2), "utf-8");
      }
      return result;
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
      // Migrate legacy bare keys too
      migratePresetKeys(result);
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

/**
 * Migrate legacy bare MODEL_* keys in preset models to canonical MODEL_MULTI_* keys.
 * Returns true if any migration happened.
 */
function migratePresetKeys(presets: ModelPresetsFile): boolean {
  const KEY_MAP: Record<string, string> = {
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

  let migrated = false;
  const allPresets = [...presets.multi, ...presets.single];
  for (const preset of allPresets) {
    if (!preset.models) continue;
    for (const [oldKey, newKey] of Object.entries(KEY_MAP)) {
      if (preset.models[oldKey] !== undefined) {
        // Only set canonical key if not already present
        if (preset.models[newKey] === undefined) {
          preset.models[newKey] = preset.models[oldKey];
        }
        delete preset.models[oldKey];
        migrated = true;
      }
    }
  }
  return migrated;
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

  let modelsToSave: Record<string, string> = models || {};

  if (!models) {
    // Read from active preset in JSON config instead of env vars
    const activePreset = getActivePreset<any>(targetMode);
    if (activePreset?.models) {
      const m = activePreset.models;
      if (targetMode === "multi") {
        if (m.master?.model) modelsToSave.MODEL_MULTI_MASTER = `${m.master.providerProfileId}:${m.master.model}`;
        if (m.superagent?.model) modelsToSave.MODEL_MULTI_SUPERAGENT = `${m.superagent.providerProfileId}:${m.superagent.model}`;
        if (m.subagentDefault?.model) modelsToSave.MODEL_MULTI_SUBAGENT = `${m.subagentDefault.providerProfileId}:${m.subagentDefault.model}`;
        if (m.subagentDetails) {
          for (const [type, cfg] of Object.entries(m.subagentDetails)) {
            if (cfg && typeof cfg === "object" && "model" in cfg) {
              const c = cfg as any;
              modelsToSave[`MODEL_MULTI_SUBAGENT_${type.toUpperCase()}`] = `${c.providerProfileId}:${c.model}`;
            }
          }
        }
      } else {
        if (m.superagent?.model) modelsToSave.MODEL_SINGLE_SUPERAGENT = `${m.superagent.providerProfileId}:${m.superagent.model}`;
        if (m.subagentDefault?.model) modelsToSave.MODEL_SINGLE_SUBAGENT = `${m.subagentDefault.providerProfileId}:${m.subagentDefault.model}`;
        if (m.subagentDetails) {
          for (const [type, cfg] of Object.entries(m.subagentDetails)) {
            if (cfg && typeof cfg === "object" && "model" in cfg) {
              const c = cfg as any;
              modelsToSave[`MODEL_SINGLE_SUBAGENT_${type.toUpperCase()}`] = `${c.providerProfileId}:${c.model}`;
            }
          }
        }
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
export function applyModelPreset(name: string, mode?: PresetMode): void {
  const targetMode: PresetMode = mode || "multi";
  const fileData = readPresetsFile();
  const targetName = name.toLowerCase().trim();

  const preset = fileData[targetMode].find(p => p.name.toLowerCase() === targetName);
  if (!preset) {
    throw new Error(`Model preset "${name}" not found in ${targetMode}-agent presets.`);
  }

  // Parse preset models into tier config format
  const parseModel = (val: string) => {
    if (!val) return undefined;
    const colonIndex = val.indexOf(":");
    if (colonIndex > 0) {
      return { providerProfileId: val.substring(0, colonIndex), model: val.substring(colonIndex + 1) };
    }
    return { providerProfileId: "", model: val };
  };

  // Build new preset models from the legacy MODEL_* format
  const newPreset: any = {
    superagent: parseModel(preset.models.MODEL_SINGLE_SUPERAGENT || preset.models.MODEL_MULTI_SUPERAGENT || ""),
    subagentDefault: parseModel(preset.models.MODEL_SINGLE_SUBAGENT || preset.models.MODEL_MULTI_SUBAGENT || ""),
    subagentDetails: {},
  };

  if (targetMode === "multi") {
    newPreset.master = parseModel(preset.models.MODEL_MULTI_MASTER || "");
  }

  // Parse subagent-specific overrides
  for (const [key, val] of Object.entries(preset.models)) {
    if (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
      const type = key.replace(/^MODEL_(MULTI|SINGLE)_SUBAGENT_/, "").toLowerCase();
      newPreset.subagentDetails[type] = parseModel(val);
    }
  }

  // Apply to active preset in JSON config
  savePreset(targetMode, newPreset);

  // Switch active provider if model has a provider prefix
  const mainModel = preset.models.MODEL_MULTI_MASTER || preset.models.MODEL_SINGLE_SUPERAGENT || "";
  if (mainModel && mainModel.includes(":")) {
    const providerId = mainModel.split(":")[0].toLowerCase();
    switchActiveProvider(providerId);
  }
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
