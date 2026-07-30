import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import {
  applyModelPreset,
  getContextWindowLimit,
  fetchAndCacheModels,
} from "../config.js";
import type { PresetMode } from "../config.js";
import { getActivePreset } from "../config/jsonConfig.js";
import { getTierModelConfig } from "../config/providers.js";

function formatModelWithProvider(tier: any): string {
  if (!tier?.model) return "(use default)";
  if (tier.providerProfileId) {
    return `${tier.providerProfileId}@${tier.model}`;
  }
  return tier.model;
}

function getActiveModelInfo(isMulti: boolean) {
  const mode = isMulti ? "multi" : "single";
  const preset = getActivePreset<any>(mode);
  const models = preset.models;

  if (isMulti) {
    return {
      master: formatModelWithProvider(models.master),
      superagent: formatModelWithProvider(models.superagent),
      subagentDefault: formatModelWithProvider(models.subagentDefault),
      subagentDetails: models.subagentDetails || {},
    };
  } else {
    return {
      superagent: formatModelWithProvider(models.superagent),
      subagentDefault: formatModelWithProvider(models.subagentDefault),
      subagentDetails: models.subagentDetails || {},
    };
  }
}

function formatModelList(info: ReturnType<typeof getActiveModelInfo>, isMulti: boolean): string {
  let list = "";
  if (isMulti) {
    list += `  Master Agent (depth 0): ${info.master}\n`;
    list += `  Superagent (depth 1): ${info.superagent}\n`;
    list += `  Subagent (depth 2): ${info.subagentDefault}`;
  } else {
    const singleTierCfg = getTierModelConfig("single", "superagent");
    const visionTag = singleTierCfg?.supportsVision === true
      ? " [👁 Vision: ON]"
      : singleTierCfg?.supportsVision === false
      ? " [Vision: OFF]"
      : "";
    list += `  Single Agent: ${info.superagent}${visionTag}`;
    if (info.subagentDefault !== "(use default)") {
      list += `\n  Subagent (depth 2): ${info.subagentDefault}`;
    }
  }
  for (const [name, cfg] of Object.entries(info.subagentDetails)) {
    if (cfg && typeof cfg === "object" && "model" in cfg) {
      list += `\n  Subagent "${name}": ${formatModelWithProvider(cfg)}`;
    }
  }
  return list;
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

      // Apply the preset (persist globally by default)
      applyModelPreset(presetName, presetMode, true);

      const info = getActiveModelInfo(isMulti);
      const nextModel = (isMulti ? info.master : info.superagent) || "gpt-4o";
      const limit = getContextWindowLimit(nextModel);

      if (ctx.setContextLimit) ctx.setContextLimit(limit);
      if (ctx.setActiveModel) ctx.setActiveModel(nextModel);

      // Update ContextManager if it exists
      const cm = ctx.agent?.getContextManager?.();
      if (cm) {
        cm.setModel(nextModel);
        cm.setThreshold(limit);
      }

      ctx.addLine({
        type: "system",
        content: `⚡ Switched to model preset "${presetName}" [${modeLabel}]\nUpdated Models:\n${formatModelList(info, isMulti)}`,
        timestamp: now,
      });

      // Fetch and cache models in background for accurate context limit
      fetchAndCacheModels()
        .then(() => {
          const newLimit = getContextWindowLimit(nextModel);
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