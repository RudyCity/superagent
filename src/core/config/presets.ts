import fs from "fs";
import path from "path";
import { getRootConfigDir, ensureGlobalConfigDir } from "./paths.js";
import { updateEnvFile } from "./env.js";

export interface ModelPreset {
  name: string;
  description: string;
  models: Record<string, string>;
}

export function getCustomPresetsPath(): string {
  return path.join(getRootConfigDir(), "model-presets.json");
}

export const BUILT_IN_PRESETS: ModelPreset[] = [
  {
    name: "balanced",
    description: "Recommended multi-agent setup: Sonnet for Master/Superagent/Coder/Reviewer, Gemini 2.5 Flash for Researcher and general Subagents.",
    models: {
      MODEL: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_2: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT2: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_SUBAGENT_REVIEWER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_REVIEWER: "anthropic:claude-3-5-sonnet-20241022"
    }
  },
  {
    name: "openai-full",
    description: "Full OpenAI stack: GPT-4o for Master/Superagent, GPT-4o-mini for Subagents.",
    models: {
      MODEL: "openai:gpt-4o",
      MODEL_DEPTH_0: "openai:gpt-4o",
      MODEL_DEPT0: "openai:gpt-4o",
      MODEL_DEPTH_1: "openai:gpt-4o",
      MODEL_DEPT1: "openai:gpt-4o",
      MODEL_DEPTH_2: "openai:gpt-4o-mini",
      MODEL_DEPT2: "openai:gpt-4o-mini",
      MODEL_SUBAGENT_RESEARCHER: "openai:gpt-4o-mini",
      MODEL_RESEARCHER: "openai:gpt-4o-mini",
      MODEL_SUBAGENT_CODER: "openai:gpt-4o",
      MODEL_CODER: "openai:gpt-4o",
      MODEL_SUBAGENT_REVIEWER: "openai:gpt-4o",
      MODEL_REVIEWER: "openai:gpt-4o"
    }
  },
  {
    name: "anthropic-full",
    description: "Full Anthropic stack: Claude 3.5 Sonnet for Master/Superagent/Coder, Claude 3.5 Haiku for Subagents.",
    models: {
      MODEL: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT0: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPT1: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_DEPTH_2: "anthropic:claude-3-5-haiku-20241022",
      MODEL_DEPT2: "anthropic:claude-3-5-haiku-20241022",
      MODEL_SUBAGENT_RESEARCHER: "anthropic:claude-3-5-haiku-20241022",
      MODEL_RESEARCHER: "anthropic:claude-3-5-haiku-20241022",
      MODEL_SUBAGENT_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_CODER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_SUBAGENT_REVIEWER: "anthropic:claude-3-5-sonnet-20241022",
      MODEL_REVIEWER: "anthropic:claude-3-5-sonnet-20241022"
    }
  },
  {
    name: "gemini-full",
    description: "Full Gemini stack (via OpenRouter): Gemini 2.5 Pro for Master/Superagent, Gemini 2.5 Flash for Subagents.",
    models: {
      MODEL: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPTH_0: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPT0: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPTH_1: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPT1: "openrouter:google/gemini-2.5-pro",
      MODEL_DEPTH_2: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT2: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_CODER: "openrouter:google/gemini-2.5-pro",
      MODEL_CODER: "openrouter:google/gemini-2.5-pro",
      MODEL_SUBAGENT_REVIEWER: "openrouter:google/gemini-2.5-pro",
      MODEL_REVIEWER: "openrouter:google/gemini-2.5-pro"
    }
  },
  {
    name: "fast-cheap",
    description: "Cost-efficient setup: Gemini 2.5 Flash for all tiers.",
    models: {
      MODEL: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPTH_0: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT0: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPTH_1: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT1: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPTH_2: "openrouter:google/gemini-2.5-flash",
      MODEL_DEPT2: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_RESEARCHER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_CODER: "openrouter:google/gemini-2.5-flash",
      MODEL_CODER: "openrouter:google/gemini-2.5-flash",
      MODEL_SUBAGENT_REVIEWER: "openrouter:google/gemini-2.5-flash",
      MODEL_REVIEWER: "openrouter:google/gemini-2.5-flash"
    }
  }
];

export function getModelPresets(): ModelPreset[] {
  const presets = [...BUILT_IN_PRESETS];
  const customPath = getCustomPresetsPath();
  if (fs.existsSync(customPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(customPath, "utf-8"));
      if (Array.isArray(data)) {
        for (const p of data) {
          if (p && typeof p === "object" && typeof p.name === "string" && p.models && typeof p.models === "object") {
            // Check if name conflicts with built-in
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
        // e.g. MODEL_RESEARCHER, MODEL_CODER, MODEL_REVIEWER
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

  const updates: Record<string, string> = {};

  // 1. Reset all current model keys to avoid leaking old configuration
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MODEL_DEPTH_") || key.startsWith("MODEL_DEPT") || 
        (key.startsWith("MODEL_") && key !== "MODEL" && key !== "MODEL_LIMITS")) {
      updates[key] = "";
      delete process.env[key];
    }
  }

  // 2. Set all model keys from the preset
  for (const [key, val] of Object.entries(preset.models)) {
    updates[key] = val;
  }

  // 3. Set standard MODEL if not specified in the preset
  if (!preset.models.MODEL) {
    updates.MODEL = preset.models.MODEL_DEPTH_0 || preset.models.MODEL_DEPT0 || "gpt-4o";
  }

  // 4. Update the active provider if the default model has a provider prefix
  const defaultModel = updates.MODEL;
  if (defaultModel && defaultModel.includes(":")) {
    const providerPart = defaultModel.split(":")[0].toLowerCase();
    updates.ACTIVE_PROVIDER = providerPart;
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
