import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import {
  applyModelPreset,
  getContextWindowLimit,
  fetchAndCacheModels,
  getEffectiveMasterModel,
  getTierModelWithProvider,
  getAllTierModels,
} from "../config.js";
import type { PresetMode } from "../config.js";

function buildUpdatedModelsList(mode: PresetMode): string {
  const isSingle = mode === "single";
  let updatedList = "";
  if (isSingle) {
    const singleModel = getEffectiveMasterModel("single") || getDefaultModel();
    const subagentModel = getTierModelWithProvider("single", "subagent") || "(use default)";
    updatedList += `  Single Agent Model: ${singleModel}\n` +
      `  Subagent (depth 2): ${subagentModel}`;

    const allModelsSingle = getAllTierModels("single");
    for (const [key, val] of Object.entries(allModelsSingle)) {
      if (key.startsWith("subagent_") || key.startsWith("subagentDetails_")) {
        const subName = key.replace(/^(subagent_|subagentDetails_)/, "");
        const tierVal = getTierModelWithProvider("single", key) || val;
        updatedList += `\n  Subagent [${subName}]: ${tierVal}`;
      }
    }
  } else {
    const masterModel = getTierModelWithProvider("multi", "master") || "(use default)";
    const superagentModel = getTierModelWithProvider("multi", "superagent") || "(use default)";
    const subagentModel = getTierModelWithProvider("multi", "subagent") || "(use default)";
    updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
      `  Superagent (depth 1): ${superagentModel}\n` +
      `  Subagent (depth 2): ${subagentModel}`;

    const allModelsMulti = getAllTierModels("multi");
    for (const [key, val] of Object.entries(allModelsMulti)) {
      if (key.startsWith("subagent_") || key.startsWith("subagentDetails_")) {
        const subName = key.replace(/^(subagent_|subagentDetails_)/, "");
        const tierVal = getTierModelWithProvider("multi", key) || val;
        updatedList += `\n  Subagent [${subName}]: ${tierVal}`;
      }
    }
  }
  return updatedList;
}

export const mpCommand: SlashCommand = {
  name: "mp",
  description: "Quick-switch model preset (e.g. /mp fast, /mp default). Shortcut: /mp-<name>",
  async execute(args, ctx) {
    const now = Date.now();
    const presetName = args.trim();

    if (!presetName) {
      ctx.addLine({
        type: "system",
        content: `Usage: /mp <preset-name>\n       /mp-<preset-name>\n\nQuick-switch to a saved model preset.\nUse /model preset list to see available presets.`,
        timestamp: now,
      });
      return;
    }

    try {
      const isMulti = ctx.agent?.isMultiAgent ?? false;
      const presetMode: PresetMode = isMulti ? "multi" : "single";
      const modeLabel = isMulti ? "Multi-Agent" : "Single-Agent";

      const hasGlobal = args.includes("--global") || args.includes("--save");
      const cleanPresetName = args.replace(/--(global|save)/gi, "").trim();

      // Apply preset in-memory for this session (unless --global / --save is specified)
      applyModelPreset(cleanPresetName, presetMode, hasGlobal);

      const nextActiveModel = getEffectiveMasterModel(presetMode) || getDefaultModel();
      const limit = getContextWindowLimit(nextActiveModel);

      if (ctx.setContextLimit) ctx.setContextLimit(limit);
      if (ctx.setActiveModel) ctx.setActiveModel(nextActiveModel);

      // Update ContextManager if it exists
      const cm = ctx.agent?.getContextManager?.();
      if (cm) {
        cm.setModel(nextActiveModel);
        cm.setThreshold(limit);
      }

      const scopeLabel = hasGlobal ? " (Saved Globally)" : " (Session In-Memory)";
      ctx.addLine({
        type: "system",
        content: `Model preset "${cleanPresetName}" applied successfully! [${modeLabel}]${scopeLabel}\n\nUpdated Models:\n${buildUpdatedModelsList(presetMode)}`,
        timestamp: now,
      });

      // Fetch and cache models in background for accurate context limit
      fetchAndCacheModels()
        .then(() => {
          const newLimit = getContextWindowLimit(nextActiveModel);
          if (ctx.setContextLimit) ctx.setContextLimit(newLimit);
          if (cm) cm.setThreshold(newLimit);
        })
        .catch(() => {});
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to switch preset: ${err.message}`,
        timestamp: now,
      });
    }
  },
};

registry.register(mpCommand);