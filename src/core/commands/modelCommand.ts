import { registry } from "./registry.js";
import { SlashCommand, getDefaultModel } from "./types.js";
import {
  getModelPresets,
  saveModelPreset,
  applyModelPreset,
  updateEnvFile,
  getContextWindowLimit,
  fetchAndCacheModels,
} from "../config.js";

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
              content: `Model Preset Commands:\n` +
                       `  /model preset list                      - List all available presets\n` +
                       `  /model preset save <name> [description]  - Save current model configuration\n` +
                       `  /model preset <name>                     - Load/apply model preset`,
              timestamp: now,
            });
            return;
          }
          const subAction = parts[1].toLowerCase();
          if (subAction === "list") {
            const presets = getModelPresets();
            const listStr = presets.map(p => `- **${p.name}**: ${p.description}`).join("\n");
            ctx.addLine({
              type: "system",
              content: `Available Model Presets:\n${listStr}`,
              timestamp: now,
            });
            return;
          } else if (subAction === "save") {
            if (parts.length < 3) {
              throw new Error("Usage: /model preset save <name> [description]");
            }
            const presetName = parts[2];
            const desc = parts.slice(3).join(" ");
            const savedPath = saveModelPreset(presetName, desc);
            ctx.addLine({
              type: "system",
              content: `Model configuration saved successfully as preset "${presetName}" to: ${savedPath}`,
              timestamp: now,
            });
            return;
          } else {
            const presetName = parts.slice(1).join(" ");
            const envPath = applyModelPreset(presetName);
            const isMulti = ctx.agent?.isMultiAgent ?? false;
            const nextActiveModel = isMulti
              ? (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
              : (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel());
            const limit = getContextWindowLimit(nextActiveModel);
            
            if (ctx.setContextLimit) {
              ctx.setContextLimit(limit);
            }
            if (ctx.setActiveModel) {
              ctx.setActiveModel(nextActiveModel);
            }

            ctx.addLine({
              type: "system",
              content: `Model preset "${presetName}" applied successfully!\nSaved to: ${envPath}`,
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

        let updates: Record<string, string> = {};
        let targetLabel = "";
        
        if (!tierArg) {
          const isMulti = ctx.agent?.isMultiAgent ?? false;
          if (isMulti) {
            updates = {
              MODEL: modelName,
              MODEL_MULTI_DEPTH_0: modelName,
              MODEL_MULTI_DEPT0: modelName,
              MODEL_MULTI_MASTER: modelName,
              MODEL_MULTI_DEPTH_1: modelName,
              MODEL_MULTI_DEPT1: modelName,
              MODEL_MULTI_SUPERAGENT: modelName,
              MODEL_MULTI_DEPTH_2: modelName,
              MODEL_MULTI_DEPT2: modelName,
              MODEL_MULTI_SUBAGENT: modelName,
              MODEL_MULTI_SUBAGENT_RESEARCHER: modelName,
              MODEL_MULTI_RESEARCHER: modelName,
              MODEL_MULTI_SUBAGENT_CODER: modelName,
              MODEL_MULTI_CODER: modelName,
              MODEL_MULTI_SUBAGENT_REVIEWER: modelName,
              MODEL_MULTI_REVIEWER: modelName,
              MODEL_DEPTH_0: modelName,
              MODEL_DEPT0: modelName,
              MODEL_DEPTH_1: modelName,
              MODEL_DEPT1: modelName,
              MODEL_DEPTH_2: modelName,
              MODEL_DEPT2: modelName,
              MODEL_SUBAGENT_RESEARCHER: modelName,
              MODEL_RESEARCHER: modelName,
              MODEL_SUBAGENT_CODER: modelName,
              MODEL_CODER: modelName,
              MODEL_SUBAGENT_REVIEWER: modelName,
              MODEL_REVIEWER: modelName
            };
            targetLabel = "All Tiers (Overwrite All)";
          } else {
            updates = {
              MODEL_SINGLE: modelName,
              MODEL: modelName
            };
            targetLabel = "Single Agent Model";
          }
          const activeProvider = process.env.ACTIVE_PROVIDER || "";
          if (activeProvider) {
            updates[`PROVIDER_${activeProvider.toUpperCase()}_MODEL`] = modelName;
          }
        } else {
          const key = tierArg.toLowerCase();
          const isMulti = ctx.agent?.isMultiAgent ?? false;
          if (key === "master" || key === "depth0" || key === "dept0") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_0: modelName, MODEL_MULTI_DEPT0: modelName, MODEL_MULTI_MASTER: modelName, MODEL_DEPTH_0: modelName, MODEL_DEPT0: modelName }
              : { MODEL_SINGLE: modelName, MODEL: modelName };
            targetLabel = "Master Agent (depth 0) Model";
          } else if (key === "superagent" || key === "depth1" || key === "dept1") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_1: modelName, MODEL_MULTI_DEPT1: modelName, MODEL_MULTI_SUPERAGENT: modelName, MODEL_DEPTH_1: modelName, MODEL_DEPT1: modelName }
              : { MODEL_SINGLE: modelName, MODEL: modelName };
            targetLabel = "Superagent (depth 1) Model";
          } else if (key === "subagent" || key === "depth2" || key === "dept2") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_2: modelName, MODEL_MULTI_DEPT2: modelName, MODEL_MULTI_SUBAGENT: modelName, MODEL_DEPTH_2: modelName, MODEL_DEPT2: modelName }
              : { MODEL_SINGLE_SUBAGENT: modelName, MODEL_SINGLE_DEPTH_2: modelName };
            targetLabel = "Subagent (depth 2) Model";
          } else {
            const type = key.replace(/^subagent-/, "");
            const typeUpper = type.toUpperCase();
            updates = isMulti
              ? {
                  [`MODEL_MULTI_SUBAGENT_${typeUpper}`]: modelName,
                  [`MODEL_MULTI_${typeUpper}`]: modelName,
                  [`MODEL_SUBAGENT_${typeUpper}`]: modelName,
                  [`MODEL_${typeUpper}`]: modelName
                }
              : {
                  [`MODEL_SINGLE_SUBAGENT_${typeUpper}`]: modelName,
                  [`MODEL_SINGLE_${typeUpper}`]: modelName
                };
            targetLabel = `Subagent "${type}" Model`;
          }
        }

        const envPath = updateEnvFile(updates);
        const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
        const limit = getContextWindowLimit(cleanModelName);
        
        if (!tierArg) {
          if (ctx.setContextLimit) {
            ctx.setContextLimit(limit);
          }
        }
        const isMulti = ctx.agent?.isMultiAgent ?? false;
        if (ctx.setActiveModel) {
          const nextActiveModel = isMulti
            ? (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
            : (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel());
          ctx.setActiveModel(nextActiveModel);
        }
        
        let updatedList = `\n\nUpdated Models:\n`;
        if (isMulti) {
          const masterModel = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          for (const [key, value] of Object.entries(process.env)) {
            if (value && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SUBAGENT_"))) {
              const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
                ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
                : key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${value}`;
              }
            }
          }
        } else {
          const singleModel = process.env.MODEL_SINGLE || "(use default)";
          updatedList += `  Single Agent: ${singleModel}`;
          const subagentModel = process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || "";
          if (subagentModel) {
            updatedList += `\n  Subagent (depth 2): ${subagentModel}`;
          }
          for (const [key, value] of Object.entries(process.env)) {
            if (value && key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
              const name = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
              updatedList += `\n  Subagent "${name}": ${value}`;
            }
          }
        }

        ctx.addLine({
          type: "system",
          content: `${targetLabel} changed to: ${modelName}\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}${updatedList}`,
          timestamp: now,
        });

        if (!tierArg) {
          fetchAndCacheModels()
            .then(() => {
              const newLimit = getContextWindowLimit(cleanModelName);
              if (ctx.setContextLimit) {
                ctx.setContextLimit(newLimit);
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
      let content = `Current Models:\n`;
      if (isMulti) {
        const masterModel = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
        const superagentModel = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
        const subagentModel = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
        content += `  Master Agent (depth 0): ${masterModel}\n` +
          `  Superagent (depth 1): ${superagentModel}\n` +
          `  Subagent (depth 2): ${subagentModel}`;
        
        const subagentSpecificOverrides: string[] = [];
        for (const [key, value] of Object.entries(process.env)) {
          if (value && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SUBAGENT_"))) {
            const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
              ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
              : key.replace("MODEL_SUBAGENT_", "").toLowerCase();
            const entry = `  Subagent "${name}": ${value}`;
            if (!subagentSpecificOverrides.includes(entry) && !content.includes(entry)) {
              subagentSpecificOverrides.push(entry);
            }
          }
        }
        if (subagentSpecificOverrides.length > 0) {
          content += `\n` + subagentSpecificOverrides.join("\n");
        }
      } else {
        const singleModel = process.env.MODEL_SINGLE || "(use default)";
        content += `  Single Agent: ${singleModel}`;
      }

      ctx.addLine({
        type: "system",
        content,
        timestamp: now,
      });

      if (ctx.setActiveWizard) {
        ctx.setActiveWizard({
          type: "model",
          step: 1,
          data: {},
        });
        ctx.setWizardOptions?.(
          isMulti
            ? [
                "1. Load/Apply Model Preset",
                "2. List Model Presets",
                "3. Create Model Preset",
                "4. Edit Model Preset",
                "5. Delete Model Preset",
                "6. Configure Agent Tier Models",
                "< Back"
              ]
            : [
                "1. Load/Apply Model Preset",
                "2. List Model Presets",
                "3. Create Model Preset",
                "4. Edit Model Preset",
                "5. Delete Model Preset",
                "6. Configure Single Agent Model",
                "7. Configure Subagent Models",
                "< Back"
              ]
        );
        ctx.setWizardSelectedIndex?.(0);
      }
    }
  }
};

registry.register(modelCommand);
