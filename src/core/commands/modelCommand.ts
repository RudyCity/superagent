import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import {
  getModelPresets,
  saveModelPreset,
  applyModelPreset,
  getContextWindowLimit,
  fetchAndCacheModels,
} from "../config.js";
import type { PresetMode } from "../config.js";
import { loadModelConfig, getActivePreset, savePreset } from "../config/jsonConfig.js";

import { getEffectiveMasterModel } from "../config/providers.js";

function formatModelWithProvider(tier: any, config: any): string {
  if (!tier?.model) return "(use default)";
  if (tier.providerProfileId) {
    // Use providerProfileId (profile ID) for consistency with getTierModelWithProvider
    return `${tier.providerProfileId}@${tier.model}`;
  }
  return tier.model;
}

function getActiveModelInfo(isMulti: boolean) {
  const mode = isMulti ? "multi" : "single";
  const preset = getActivePreset<any>(mode);
  const config = loadModelConfig();
  const models = preset.models;

  if (isMulti) {
    return {
      master: formatModelWithProvider(models.master, config),
      superagent: formatModelWithProvider(models.superagent, config),
      subagentDefault: formatModelWithProvider(models.subagentDefault, config),
      subagentDetails: models.subagentDetails || {},
    };
  } else {
    return {
      superagent: formatModelWithProvider(models.superagent, config),
      subagentDefault: formatModelWithProvider(models.subagentDefault, config),
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
    const singleAgent = info.superagent === "(use default)" ? getEffectiveMasterModel("single") : info.superagent;
    list += `  Single Agent: ${singleAgent}`;
    if (info.subagentDefault !== "(use default)") {
      list += `\n  Subagent (depth 2): ${info.subagentDefault}`;
    }
  }
  for (const [name, cfg] of Object.entries(info.subagentDetails)) {
    if (cfg && typeof cfg === "object" && "model" in cfg) {
      list += `\n  Subagent "${name}": ${formatModelWithProvider(cfg, loadModelConfig())}`;
    }
  }
  return list;
}

export const modelCommand: SlashCommand = {
  name: "model",
  description: "Set or list active AI models (e.g. /model openai/gpt-4o)",
  async execute(args, ctx) {
    const now = Date.now();
    if (args) {
      try {
        let tierArg = "";
        let modelName = "";
        const parts = args.split(/\s+/);
        
        const firstWord = parts[0].toLowerCase();
        if (firstWord === "preset") {
          if (parts.length === 1 || (parts.length === 2 && parts[1].toLowerCase() === "help")) {
            ctx.addLine({
              type: "system",
              content: `Model Preset Commands (mode-aware):\n` +
                       `  /model preset list                      - List presets for current mode\n` +
                       `  /model preset save <name> [description]  - Save & apply preset for current mode\n` +
                       `  /model preset <name>                     - Load/apply preset for current mode`,
              timestamp: now,
            });
            return;
          }
          const subAction = parts[1].toLowerCase();
          const isMulti = ctx.agent?.isMultiAgent ?? false;
          const presetMode: PresetMode = isMulti ? "multi" : "single";
          const modeLabel = isMulti ? "Multi-Agent" : "Single-Agent";

          if (subAction === "list") {
            const presets = getModelPresets(presetMode);
            const listStr = presets.map(p => {
              const modeInfo = p.mode ? ` [${p.mode}]` : "";
              return `- **${p.name}**${modeInfo}: ${p.description}`;
            }).join("\n");
            ctx.addLine({
              type: "system",
              content: `Available Model Presets (${modeLabel}):\n${listStr}`,
              timestamp: now,
            });
            return;
          } else if (subAction === "save") {
            if (parts.length < 3) {
              throw new Error("Usage: /model preset save <name> [description]");
            }
            const presetName = parts[2];
            const desc = parts.slice(3).join(" ");
            saveModelPreset(presetName, desc, undefined, presetMode);

            // Auto-apply after save
            applyModelPreset(presetName, presetMode);
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
              content: `Model preset "${presetName}" saved & applied successfully! [${modeLabel}]\nUpdated Models:\n${formatModelList(info, isMulti)}`,
              timestamp: now,
            });
            return;
          } else {
            const presetName = parts.slice(1).join(" ");
            applyModelPreset(presetName, presetMode);
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
              content: `Model preset "${presetName}" applied successfully!\nUpdated Models:\n${formatModelList(info, isMulti)}`,
              timestamp: now,
            });
            return;
          }
        }

        if (parts.length >= 2) {
          const knownSubagents = ["researcher", "coder", "reviewer"];
          if (
            ["master", "superagent", "subagent", "depth0", "depth1", "depth2", "dept0", "dept1", "dept2"].includes(firstWord) ||
            knownSubagents.includes(firstWord) ||
            firstWord.startsWith("subagent-")
          ) {
            tierArg = firstWord;
            modelName = parts.slice(1).join(" ");
          }
        }
        
        if (!tierArg) {
          modelName = args;
        }

        const isMulti = ctx.agent?.isMultiAgent ?? false;
        const mode = isMulti ? "multi" : "single";
        const preset = getActivePreset<any>(mode);
        let targetLabel = "";
        
        if (!tierArg) {
          if (isMulti) {
            preset.models.master = { ...preset.models.master, model: modelName };
            preset.models.superagent = { ...preset.models.superagent, model: modelName };
            preset.models.subagentDefault = { ...preset.models.subagentDefault, model: modelName };
            if (!preset.models.subagentDetails) preset.models.subagentDetails = {};
            for (const key of Object.keys(preset.models.subagentDetails)) {
              preset.models.subagentDetails[key] = { ...preset.models.subagentDetails[key], model: modelName };
            }
            targetLabel = "All Tiers (Overwrite All)";
          } else {
            preset.models.superagent = { ...preset.models.superagent, model: modelName };
            targetLabel = "Single Agent Model";
          }
        } else {
          const key = tierArg.toLowerCase();
          if (key === "master" || key === "depth0" || key === "dept0") {
            if (isMulti) {
              preset.models.master = { ...preset.models.master, model: modelName };
            } else {
              preset.models.superagent = { ...preset.models.superagent, model: modelName };
            }
            targetLabel = isMulti ? "Master Agent (depth 0) Model" : "Single Agent Model";
          } else if (key === "superagent" || key === "depth1" || key === "dept1") {
            preset.models.superagent = { ...preset.models.superagent, model: modelName };
            targetLabel = "Superagent (depth 1) Model";
          } else if (key === "subagent" || key === "depth2" || key === "dept2") {
            preset.models.subagentDefault = { ...preset.models.subagentDefault, model: modelName };
            targetLabel = "Subagent (depth 2) Model";
          } else {
            const type = key.replace(/^subagent-/, "");
            if (!preset.models.subagentDetails) preset.models.subagentDetails = {};
            preset.models.subagentDetails[type] = { ...preset.models.subagentDetails[type], model: modelName };
            targetLabel = `Subagent "${type}" Model`;
          }
        }

        savePreset(mode, preset);
        const cleanModelName = modelName.includes("@") ? modelName.substring(modelName.indexOf("@") + 1) : modelName;
        const limit = getContextWindowLimit(cleanModelName);
        
        if (!tierArg && ctx.setContextLimit) {
          ctx.setContextLimit(limit);
        }
        if (ctx.setActiveModel) {
          const info = getActiveModelInfo(isMulti);
          const nextModel = (isMulti ? info.master : info.superagent) || "gpt-4o";
          ctx.setActiveModel(nextModel);
        }

        // Update ContextManager if it exists
        const cm = ctx.agent?.getContextManager?.();
        if (cm && !tierArg) {
          cm.setModel(cleanModelName);
          cm.setThreshold(limit);
        }

        const info = getActiveModelInfo(isMulti);
        ctx.addLine({
          type: "system",
          content: `${targetLabel} changed to: ${modelName}\nContext limit: ${limit.toLocaleString()} tokens\n\nUpdated Models:\n${formatModelList(info, isMulti)}`,
          timestamp: now,
        });

        if (!tierArg) {
          fetchAndCacheModels()
            .then(() => {
              const newLimit = getContextWindowLimit(cleanModelName);
              if (ctx.setContextLimit) ctx.setContextLimit(newLimit);
              // Also update ContextManager with fetched limit
              if (cm) {
                cm.setThreshold(newLimit);
              }
            })
            .catch(() => {});
        }
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to set model: ${err.message}`,
          timestamp: now,
        });
      }
    } else {
      const isMulti = ctx.agent?.isMultiAgent ?? false;
      const info = getActiveModelInfo(isMulti);
      let content = `Current Models:\n${formatModelList(info, isMulti)}`;

      ctx.addLine({
        type: "system",
        content,
        timestamp: now,
      });

      if (ctx.setActiveWizard) {
        const modeLabelMenu = isMulti ? "Multi-Agent" : "Single-Agent";
        ctx.setActiveWizard({
          type: "model",
          step: 1,
          data: {},
        });
        ctx.setWizardOptions?.(
          isMulti
            ? [
                `1. Load/Apply Model Preset [${modeLabelMenu}]`,
                `2. List Model Presets [${modeLabelMenu}]`,
                `3. Create Model Preset [${modeLabelMenu}]`,
                `4. Edit Model Preset [${modeLabelMenu}]`,
                `5. Delete Model Preset [${modeLabelMenu}]`,
                `6. Configure Agent Tier Models`,
                "< Back"
              ]
            : [
                `1. Load/Apply Model Preset [${modeLabelMenu}]`,
                `2. List Model Presets [${modeLabelMenu}]`,
                `3. Create Model Preset [${modeLabelMenu}]`,
                `4. Edit Model Preset [${modeLabelMenu}]`,
                `5. Delete Model Preset [${modeLabelMenu}]`,
                `6. Configure Single Agent Model`,
                `7. Configure Subagent Models`,
                "< Back"
              ]
        );
        ctx.setWizardSelectedIndex?.(0);
      }
    }
  }
};

registry.register(modelCommand);
