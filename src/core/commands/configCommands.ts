import fs from "fs/promises";
import fsCb from "fs";
import path from "path";
import os from "os";
import { execa } from "execa";
import { registry } from "./registry.js";
import { 
  SlashCommand, 
  getDefaultModel, 
  getProviderLabel, 
  formatPresetValue, 
  getPresetLabel, 
  findPreset 
} from "./types.js";
import {
  getConfiguredProviders,
  switchActiveProvider,
  fetchAndCacheModels,
  updateEnvFile,
  getContextWindowLimit,
  getGlobalConfigDir,
  getModelPresets,
  saveModelPreset,
  applyModelPreset,
} from "../config.js";
import { 
  backgroundTasks, 
  notifyTasksChanged, 
  BackgroundTask 
} from "../tools.js";
import { killProcessTree } from "../tools/shellTools.js";

// /login command
export const loginCommand: SlashCommand = {
  name: "login",
  description: "Login to a provider (e.g. /login openrouter sk-or-...)",
  async execute(args, ctx) {
    const now = Date.now();
    if (!args) {
      if (ctx.setActiveWizard) {
        const list = getConfiguredProviders();
        if (list.length > 0) {
          ctx.setActiveWizard({
            type: "login",
            step: 1,
            data: {},
          });
          ctx.setWizardOptions?.([
            "1. Add / Log in to a Provider",
            "2. Switch Active Provider",
            "3. List Configured Providers"
          ]);
        } else {
          ctx.setActiveWizard({
            type: "login",
            step: 2,
            data: {},
          });
          ctx.setWizardOptions?.(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
        }
        ctx.setWizardSelectedIndex?.(0);
      } else {
        ctx.addLine({
          type: "system",
          content: [
            "Usage:",
            "  /login <api_key> (auto-detects OpenRouter, Anthropic, OpenAI)",
            "  /login openrouter <api_key>",
            "  /login anthropic <api_key>",
            "  /login openai <api_key>",
            "  /login custom <base_url> <api_key>",
          ].join("\n"),
          timestamp: now,
        });
      }
      return;
    }

    const parts = args.split(/\s+/);
    let provider = "";
    let apiKey = "";
    let baseUrl = "";

    if (parts[0].toLowerCase() === "custom") {
      if (parts.length < 3) {
        ctx.addLine({
          type: "error",
          content: "Error: /login custom requires <base_url> and <api_key>",
          timestamp: now,
        });
        return;
      }
      provider = "custom";
      baseUrl = parts[1];
      apiKey = parts[2];
    } else if (["openrouter", "anthropic", "openai"].includes(parts[0].toLowerCase())) {
      if (parts.length < 2) {
        ctx.addLine({
          type: "error",
          content: `Error: /login ${parts[0]} requires <api_key>`,
          timestamp: now,
        });
        return;
      }
      provider = parts[0].toLowerCase();
      apiKey = parts[1];
    } else {
      apiKey = parts[0];
      if (apiKey.startsWith("sk-or-")) {
        provider = "openrouter";
      } else if (apiKey.startsWith("sk-ant-")) {
        provider = "anthropic";
      } else {
        provider = "openai";
      }
    }

    const profileName = provider;
    const prefix = `PROVIDER_${profileName.toUpperCase()}`;
    const updates: Record<string, string> = {
      ACTIVE_PROVIDER: profileName,
      [`${prefix}_TYPE`]: provider,
      [`${prefix}_API_KEY`]: apiKey,
    };

    if (baseUrl) {
      updates[`${prefix}_BASE_URL`] = baseUrl;
    } else if (provider === "openrouter") {
      updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
    }

    try {
      updateEnvFile(updates);
      const envPath = switchActiveProvider(profileName);
      ctx.addLine({
        type: "system",
        content: `Successfully logged in. Configured provider: ${profileName} (${provider}).\nSaved to: ${envPath}`,
        timestamp: now,
      });

      if (provider === "openrouter" && !process.env.MODEL) {
        updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
        if (ctx.setActiveModel) {
          const isMulti = ctx.agent?.isMultiAgent ?? false;
          const nextActiveModel = isMulti
            ? (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
            : "google/gemini-2.5-flash";
          ctx.setActiveModel(nextActiveModel);
        }
      }

      fetchAndCacheModels()
        .then(() => {
          const currentModel = process.env.MODEL || getDefaultModel();
          const limit = getContextWindowLimit(currentModel);
          if (ctx.setContextLimit) {
            ctx.setContextLimit(limit);
          }
          if (ctx.setActiveModel) {
            const isMulti = ctx.agent?.isMultiAgent ?? false;
            const nextActiveModel = isMulti
              ? (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
              : currentModel;
            ctx.setActiveModel(nextActiveModel);
          }
        })
        .catch(() => {});
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save login credentials: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /model command
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
            const nextActiveModel = process.env.MODEL || getDefaultModel();
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
          updates = {
            MODEL: modelName,
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
          const activeProvider = process.env.ACTIVE_PROVIDER || "";
          if (activeProvider) {
            updates[`PROVIDER_${activeProvider.toUpperCase()}_MODEL`] = modelName;
          }
          targetLabel = "All Tiers (Overwrite All)";
        } else {
          const key = tierArg.toLowerCase();
          if (key === "master" || key === "depth0" || key === "dept0") {
            updates = { MODEL_DEPTH_0: modelName, MODEL_DEPT0: modelName };
            targetLabel = "Master Agent (depth 0) Model";
          } else if (key === "superagent" || key === "depth1" || key === "dept1") {
            updates = { MODEL_DEPTH_1: modelName, MODEL_DEPT1: modelName };
            targetLabel = "Superagent (depth 1) Model";
          } else if (key === "subagent" || key === "depth2" || key === "dept2") {
            updates = { MODEL_DEPTH_2: modelName, MODEL_DEPT2: modelName };
            targetLabel = "Subagent (depth 2) Model";
          } else {
            const type = key.replace(/^subagent-/, "");
            const typeUpper = type.toUpperCase();
            updates = {
              [`MODEL_SUBAGENT_${typeUpper}`]: modelName,
              [`MODEL_${typeUpper}`]: modelName
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
        if (ctx.setActiveModel) {
          const isMulti = ctx.agent?.isMultiAgent ?? false;
          const nextActiveModel = isMulti
            ? (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
            : (process.env.MODEL || getDefaultModel());
          ctx.setActiveModel(nextActiveModel);
        }
        
        const currentModel = process.env.MODEL || getDefaultModel();
        const masterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
        const superagentModel = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
        const subagentModel = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
        
        let updatedList = `\n\nUpdated Models:\n` +
          `  Default Model: ${currentModel}\n` +
          `  Master Agent (depth 0): ${masterModel}\n` +
          `  Superagent (depth 1): ${superagentModel}\n` +
          `  Subagent (depth 2): ${subagentModel}`;

        for (const [key, value] of Object.entries(process.env)) {
          if (value && key.startsWith("MODEL_SUBAGENT_")) {
            const name = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
            updatedList += `\n  Subagent "${name}": ${value}`;
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
      const currentModel = process.env.MODEL || getDefaultModel();
      const masterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
      const superagentModel = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
      const subagentModel = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
      
      const subagentSpecificOverrides: string[] = [];
      for (const [key, value] of Object.entries(process.env)) {
        if (value && key.startsWith("MODEL_SUBAGENT_")) {
          const name = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
          subagentSpecificOverrides.push(`  Subagent "${name}": ${value}`);
        }
      }

      let content = `Current Models:\n` +
        `  Default Model: ${currentModel}\n` +
        `  Master Agent (depth 0): ${masterModel}\n` +
        `  Superagent (depth 1): ${superagentModel}\n` +
        `  Subagent (depth 2): ${subagentModel}`;
      
      if (subagentSpecificOverrides.length > 0) {
        content += `\n` + subagentSpecificOverrides.join("\n");
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
        ctx.setWizardOptions?.([
          "1. Load/Apply Model Preset",
          "2. List Model Presets",
          "3. Create Model Preset",
          "4. Edit Model Preset",
          "5. Delete Model Preset",
          "6. Configure Agent Tier Models"
        ]);
        ctx.setWizardSelectedIndex?.(0);
      }
    }
  }
};

// /settings command
export const settingsCommand: SlashCommand = {
  name: "settings",
  description: "Show current rate limit & concurrency settings",
  execute(args, ctx) {
    const concurrency = process.env.SUPERAGENT_MAX_CONCURRENCY || "0 (disabled)";
    const rpm = process.env.SUPERAGENT_RATE_LIMIT_RPM || "60";
    const capacity = process.env.SUPERAGENT_RATE_LIMIT_CAPACITY || "60";
    ctx.addLine({
      type: "system",
      content: [
        "┌───[ ⚙️ SUPERAGENT SETTINGS ]",
        "│ ",
        `│ • Concurrency Limit : ${concurrency === "1" ? "1 (enabled)" : "0 (disabled)"}`,
        `│ • Rate Limit (RPM)  : ${rpm === "0" ? "0 (disabled)" : `${rpm} RPM`}`,
        `│ • Limit Capacity    : ${capacity}`,
        "│ ",
        "└─────────────────────────────",
        "Configure these settings using:",
        "  /setting-concurrency <0|1>",
        "  /setting-rpm <number>",
        "  /setting-capacity <number>"
      ].join("\n"),
      timestamp: Date.now(),
    });
  }
};

// /setting-concurrency command
export const settingConcurrencyCommand: SlashCommand = {
  name: "setting-concurrency",
  description: "Set LLM concurrency limit",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-concurrency <0|1>\nCurrent value: ${process.env.SUPERAGENT_MAX_CONCURRENCY || "0 (disabled)"}`,
        timestamp: now,
      });
      return;
    }
    if (val !== "0" && val !== "1") {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be 0 (disabled) or 1 (enabled).",
        timestamp: now,
      });
      return;
    }
    try {
      updateEnvFile({ SUPERAGENT_MAX_CONCURRENCY: val });
      ctx.addLine({
        type: "system",
        content: `✓ Concurrency limit set to: ${val === "1" ? "1 (enabled)" : "0 (disabled)"}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-rpm command
export const settingRpmCommand: SlashCommand = {
  name: "setting-rpm",
  description: "Set rate limit RPM",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-rpm <number>\nCurrent value: ${process.env.SUPERAGENT_RATE_LIMIT_RPM || "60"}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a non-negative integer.",
        timestamp: now,
      });
      return;
    }
    try {
      updateEnvFile({ SUPERAGENT_RATE_LIMIT_RPM: val });
      ctx.addLine({
        type: "system",
        content: `✓ Rate limit set to: ${val === "0" ? "0 (disabled)" : `${val} RPM`}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-capacity command
export const settingCapacityCommand: SlashCommand = {
  name: "setting-capacity",
  description: "Set rate limit capacity",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-capacity <number>\nCurrent value: ${process.env.SUPERAGENT_RATE_LIMIT_CAPACITY || "60"}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num <= 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a positive integer.",
        timestamp: now,
      });
      return;
    }
    try {
      updateEnvFile({ SUPERAGENT_RATE_LIMIT_CAPACITY: val });
      ctx.addLine({
        type: "system",
        content: `✓ Rate limit capacity set to: ${val}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /compact command
export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Show conversation summary",
  execute(args, ctx) {
    const currentModel = process.env.MODEL || getDefaultModel();
    const limit = getContextWindowLimit(currentModel);
    const summary = ctx.agent?.getHistory().getCompactSummary(limit);
    ctx.addLine({ type: "system", content: summary || "No history.", timestamp: Date.now() });
  }
};

// /terminal command
export const terminalCommand: SlashCommand = {
  name: "terminal",
  description: "Run a command or preset in a new window or background",
  async execute(args, ctx) {
    const cwd = process.cwd();
    const now = Date.now();

    if (args.toLowerCase() === "init") {
      ctx.addLine({
        type: "user",
        content: "❯ /terminal init",
        timestamp: now
      });
      ctx.addLine({
        type: "system",
        content: "Starting interactive preset creator wizard guided by AI...",
        timestamp: now
      });
      ctx.setIsProcessing?.(true);
      ctx.agent?.sendMessage(
        "USER COMMAND: /terminal init\n\n" +
        "You are initializing terminal presets for the user's workspace. Follow these steps:\n" +
        "1. Inspect the workspace files (e.g. read package.json scripts/dependencies, Cargo.toml, go.mod, requirements.txt, or list directories) to identify the project type and find common commands.\n" +
        "2. Dynamically construct AI suggestions/recommendations of potential terminal preset commands (e.g. dev/start servers, watch processes, test suites, builds) based on your discovery.\n" +
        "3. Ask the user to select which commands they want to set up as presets. You MUST call the `ask_question` tool with `isMultiSelect: true` so the user can check/uncheck multiple suggested commands using Space and Enter.\n" +
        "4. Once selected, guide them or define the preset names, custom working directories, and env variables if needed.\n" +
        "5. Write the final configuration back to the local project file `.superagent-r/terminal-presets.json` using a file writing tool. Confirm to the user once it is completed."
      ).catch((err: any) => {
        ctx.addLine({ type: "error", content: `Wizard error: ${err.message}`, timestamp: Date.now() });
      });
      return;
    }

    if (args.toLowerCase() === "stop" || args.toLowerCase().startsWith("stop ")) {
      const stopArg = args.slice(4).trim().toLowerCase();
      const termTasks = Array.from(backgroundTasks.entries()).filter(([id]) => id.startsWith("term-"));

      if (termTasks.length === 0) {
        ctx.addLine({
          type: "system",
          content: "🖥️ No running terminal processes to stop.",
          timestamp: Date.now()
        });
        return;
      }

      if (!stopArg || stopArg === "all") {
        let count = 0;
        for (const [id, task] of termTasks) {
          try { killProcessTree(task.process.pid); } catch {}
          try {
            if (task.logPath) {
              fsCb.appendFileSync(task.logPath, `\n[Process exited via force stop at ${new Date().toISOString()}]\n`);
            }
          } catch {}
          task.hasExited = true;
          backgroundTasks.delete(id);
          count++;
        }
        notifyTasksChanged();
        ctx.addLine({
          type: "system",
          content: `🛑 Stopped ${count} terminal process${count !== 1 ? "es" : ""}.`,
          timestamp: Date.now()
        });
      } else {
        const fullId = stopArg.startsWith("term-") ? stopArg : `term-${stopArg}`;
        const task = backgroundTasks.get(fullId);
        if (!task) {
          const ids = termTasks.map(([id]) => id).join(", ");
          ctx.addLine({
            type: "error",
            content: `Error: Terminal process "${fullId}" not found.\nRunning IDs: ${ids || "(none)"}`,
            timestamp: Date.now()
          });
          return;
        }
        try { killProcessTree(task.process.pid); } catch {}
        try {
          if (task.logPath) {
            fsCb.appendFileSync(task.logPath, `\n[Process exited via force stop at ${new Date().toISOString()}]\n`);
          }
        } catch {}
        task.hasExited = true;
        backgroundTasks.delete(fullId);
        notifyTasksChanged();
        ctx.addLine({
          type: "system",
          content: `🛑 Stopped terminal process [${fullId}]: "${task.command}"`,
          timestamp: Date.now()
        });
      }
      return;
    }

    if (args.toLowerCase() === "bg" || args.toLowerCase().startsWith("bg ")) {
      const bgRaw = args.slice(2).trim();

      (async () => {
        const localPresetDir = path.join(cwd, ".superagent-r");
        const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
        const localRootPresetPath = path.join(cwd, "terminal-presets.json");
        const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");
        const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
        let presets: Record<string, any> = {};
        for (const p of paths) {
          try {
            const content = await fs.readFile(p, "utf-8");
            const data = JSON.parse(content);
            presets = data?.presets ?? data;
            break;
          } catch { /* ignore */ }
        }

        if (!bgRaw) {
          const keys = Object.keys(presets);
          const presetsList = keys.length > 0
            ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
            : "  (No presets configured)";
          ctx.addLine({
            type: "system",
            content: [
              "🖥️ TERMINAL BG — Run preset or command silently in background",
              "Usage:",
              "  /terminal bg <command>          - Run any command in background",
              "  /terminal bg preset <name>      - Run a configured preset in background",
              "  /terminal bg <preset_name>      - Run preset directly by name",
              "",
              "Available Presets:",
              presetsList,
            ].join("\n"),
            timestamp: Date.now()
          });
          return;
        }

        let commandStr = bgRaw;
        let bgPresetName = "";
        if (bgRaw.toLowerCase().startsWith("preset ")) {
          const requestedName = bgRaw.slice(7).trim();
          const found = findPreset(presets, requestedName);
          if (!found) {
            ctx.addLine({ type: "error", content: `Error: Preset "${requestedName}" not found.`, timestamp: Date.now() });
            return;
          }
          bgPresetName = getPresetLabel(found.key, found.value);
          const val = found.value;
          commandStr = typeof val === "object" && val !== null ? (val.command || JSON.stringify(val)) : String(val);
        } else {
          const found = findPreset(presets, bgRaw);
          if (found) {
            bgPresetName = getPresetLabel(found.key, found.value);
            const val = found.value;
            commandStr = typeof val === "object" && val !== null ? (val.command || JSON.stringify(val)) : String(val);
          }
        }

        const taskId = `term-bg-${Math.random().toString(36).substring(2, 9)}`;
        const tasksLogDir = process.env.SUPERAGENT_SESSION_PATH
          ? path.join(path.dirname(process.env.SUPERAGENT_SESSION_PATH), "tasks")
          : path.join(getGlobalConfigDir(), "tasks");
        if (!fsCb.existsSync(tasksLogDir)) fsCb.mkdirSync(tasksLogDir, { recursive: true });
        const logPath = path.join(tasksLogDir, `${taskId}.log`);
        try { fsCb.writeFileSync(logPath, ""); } catch { /* ignore */ }

        let shellPath: string | boolean = true;
        if (process.platform === "win32") {
          shellPath = "powershell.exe";
        }

        const proc = execa(commandStr, {
          shell: shellPath,
          cwd,
          reject: false,
          all: true,
        });

        const task: BackgroundTask = {
          id: taskId,
          command: commandStr,
          process: proc,
          output: [],
          logPath,
        };

        backgroundTasks.set(taskId, task);
        notifyTasksChanged();

        proc.all?.on("data", (data: Buffer) => {
          const text = data.toString();
          task.output.push(text);
          if (task.output.length > 1000) task.output.shift();
          try { fsCb.appendFileSync(logPath, text); } catch { /* ignore */ }
        });

        proc.on("close", (code: number | null) => {
          task.hasExited = true;
          task.exitCode = code;
          const exitMsg = `\n[Process exited with code ${code}]`;
          task.output.push(exitMsg);
          try { fsCb.appendFileSync(logPath, exitMsg); } catch { /* ignore */ }
          notifyTasksChanged();
        });

        ctx.addLine({
          type: "system",
          content: [
            `⚙️ Background process started [ID: ${taskId}]`,
            `  Command : ${commandStr}`,
            `  Log     : ${logPath}`,
            bgPresetName ? `  Preset  : ${bgPresetName}` : "",
            `Use /processes to monitor, or /processes stop ${taskId} to kill.`,
          ].filter(Boolean).join("\n"),
          timestamp: Date.now()
        });
      })().catch(err => {
        ctx.addLine({ type: "error", content: `Failed to start background process: ${err.message}`, timestamp: Date.now() });
      });
      return;
    }
    
    const loadPresetsAndRun = async () => {
      const localPresetDir = path.join(cwd, ".superagent-r");
      const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
      const localRootPresetPath = path.join(cwd, "terminal-presets.json");
      const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");

      const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
      let presets: Record<string, string | string[]> = {};
      for (const p of paths) {
        try {
          const content = await fs.readFile(p, "utf-8");
          const data = JSON.parse(content);
          if (data && data.presets) {
            presets = data.presets;
          } else {
            presets = data;
          }
          break;
        } catch { /* ignore */ }
      }

      if (!args) {
        const keys = Object.keys(presets);
        const presetsList = keys.length > 0
          ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
          : "  (No presets configured)";
        ctx.addLine({
          type: "system",
          content: [
            "🖥️ TERMINAL COMMAND & PRESETS",
            "Usage:",
            "  /terminal <command>         - Run command in a new terminal window",
            "  /terminal all               - Launch ALL configured presets at once",
            "  /terminal preset <name>     - Run a configured preset",
            "  /terminal <preset_name>     - Run a preset directly (if name matches)",
            "",
            "Available Presets:",
            presetsList,
            "",
            "Presets can be configured in `.superagent-r/terminal-presets.json` or `terminal-presets.json`.",
          ].join("\n"),
          timestamp: Date.now()
        });
        return;
      }

      let commandToRun: any = args;
      let isPreset = false;
      let presetName = "";

      const runCmd = async (singleCmd: any, labelOverride?: string) => {
        let commandStr = "";
        let runCwd = cwd;
        let runEnv = { ...process.env };

        if (typeof singleCmd === "object" && singleCmd !== null) {
          commandStr = singleCmd.command || "";
          if (singleCmd.cwd) {
            runCwd = path.resolve(cwd, singleCmd.cwd);
          }
          if (singleCmd.env) {
            runEnv = { ...runEnv, ...singleCmd.env };
          }
        } else {
          commandStr = String(singleCmd);
        }

        if (!commandStr) return;

        const taskId = `term-${Math.random().toString(36).substring(2, 9)}`;
        const windowLabel = labelOverride || presetName || commandStr.split(" ")[0];

        const logDir = path.join(getGlobalConfigDir(), "tasks");
        if (!fsCb.existsSync(logDir)) fsCb.mkdirSync(logDir, { recursive: true });
        const logPath = path.join(logDir, `${taskId}.log`);
        const closeSignalPath = path.join(logDir, `${taskId}.closed.json`);
        fsCb.writeFileSync(logPath, `[Terminal: ${windowLabel}]\n[Command: ${commandStr}]\n[Started: ${new Date().toISOString()}]\n\n`);
        try { fsCb.rmSync(closeSignalPath, { force: true }); } catch { /* ignore */ }

        ctx.addLine({
          type: "system",
          content: `🖥️ Spawning terminal [ID: ${taskId}]: "${commandStr}" (cwd: ${runCwd})\n   Log: ${logPath}`,
          timestamp: Date.now()
        });

        let shellExe: string | boolean = true;
        if (process.platform === "win32") shellExe = "powershell.exe";

        const proc = execa(commandStr, {
          shell: shellExe,
          cwd: runCwd,
          env: runEnv,
          reject: false,
          all: true,
        });

        const task: BackgroundTask = {
          id: taskId,
          command: commandStr,
          process: proc,
          output: [],
          logPath,
          isDetachedWindow: true,
          windowLabel,
        };

        backgroundTasks.set(taskId, task);
        notifyTasksChanged();

        proc.all?.on("data", (data: Buffer) => {
          const text = data.toString();
          task.output.push(text);
          if (task.output.length > 2000) task.output.shift();
          try { fsCb.appendFileSync(logPath, text); } catch { /* ignore */ }
        });

        try {
          const safeLog = logPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
          const safeTitle = windowLabel.replace(/"/g, "");
          const safeCwd = runCwd.replace(/"/g, "");

          if (process.platform === "win32") {
            const safeCloseSignal = closeSignalPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
            const viewerScript = [
              `$logPath = '${safeLog}'`,
              `$closeSignalPath = '${safeCloseSignal}'`,
              `$lastPos = 0`,
              `try {`,
              `  Write-Host "=== ${safeTitle} === (close window to stop process)" -ForegroundColor Cyan`,
              `  Write-Host ''`,
              `  while ($true) {`,
              `    try {`,
              `      $bytes = [System.IO.File]::ReadAllBytes($logPath)`,
              `      if ($bytes.Length -gt $lastPos) {`,
              `        $chunk = [System.Text.Encoding]::UTF8.GetString($bytes, $lastPos, $bytes.Length - $lastPos)`,
              `        Write-Host $chunk -NoNewline`,
              `        $lastPos = $bytes.Length`,
              `      }`,
              `      if ($lastPos -gt 0) {`,
              `        $tail = [System.Text.Encoding]::UTF8.GetString($bytes)`,
              `        if ($tail -match '\\[Process exited') { break }`,
              `      }`,
              `    } catch {}`,
              `    Start-Sleep -Milliseconds 200`,
              `  }`,
              `  Write-Host ''`,
              `  Write-Host '[Process finished. Press Enter to close.]' -ForegroundColor Green`,
              `  Read-Host`,
              `} finally {`,
              `  try {`,
              `    $payload = @{ action = 'closed'; timestamp = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress`,
              `    [System.IO.File]::WriteAllText($closeSignalPath, $payload, [System.Text.Encoding]::UTF8)`,
              `  } catch {}`,
              `  try { Remove-Item $MyInvocation.MyCommand.Path -Force } catch {}`,
              `}`,
            ].join("\n");
            const viewerScriptPath = path.join(logDir, `${taskId}-viewer.ps1`);
            fsCb.writeFileSync(viewerScriptPath, viewerScript, "utf8");

            const viewerProc = execa(
              "cmd.exe",
              ["/c", `start /wait "${safeTitle}" /D "${safeCwd}" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${viewerScriptPath}"`],
              { detached: true, stdio: "ignore", windowsVerbatimArguments: true, reject: false }
            );
            const handleViewerExit = () => {
              if (!task.hasExited) {
                const closeMsg = `\n[Terminal window closed; process killed at ${new Date().toISOString()}]`;
                task.hasExited = true;
                task.exitCode = null;
                task.output.push(closeMsg);
                try { fsCb.appendFileSync(logPath, closeMsg); } catch { /* ignore */ }
                try { killProcessTree(proc.pid); } catch { /* ignore */ }
                backgroundTasks.delete(taskId);
                notifyTasksChanged();
              }
            };
            viewerProc.on("close", handleViewerExit);
            viewerProc.on("exit", handleViewerExit);
          } else if (process.platform === "darwin") {
            const script = `tell application "Terminal" to do script "tail -f '${safeLog}'"`;
            execa("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
          } else {
            execa("x-terminal-emulator", ["-e", `bash -c "tail -f '${safeLog}'"`],
              { detached: true, stdio: "ignore", reject: false }).unref();
          }
        } catch { /* viewer optional */ }

        proc.on("close", (code: number | null) => {
          task.hasExited = true;
          task.exitCode = code;
          const exitMsg = `\n[Process exited with code ${code} at ${new Date().toISOString()}]`;
          task.output.push(exitMsg);
          try { fsCb.appendFileSync(logPath, exitMsg); } catch { /* ignore */ }
          notifyTasksChanged();
        });

        ctx.addLine({
          type: "system",
          content:
            `[TERMINAL CONTEXT] ID: ${taskId} | Label: ${windowLabel}\n` +
            `  Command : ${commandStr}\n` +
            `  Log     : ${logPath}\n` +
            `  AI can read this log file to see the live output.`,
          timestamp: Date.now(),
        });
      };

      if (args.toLowerCase() === "all") {
        const keys = Object.keys(presets);
        if (keys.length === 0) {
          ctx.addLine({
            type: "system",
            content: "No presets configured. Run `/terminal init` to set some up.",
            timestamp: Date.now()
          });
          return;
        }
        ctx.addLine({
          type: "system",
          content: `🚀 Launching all ${keys.length} preset(s)…`,
          timestamp: Date.now()
        });
        for (const k of keys) {
          const val = presets[k];
          const label = getPresetLabel(k, val);
          if (Array.isArray(val)) {
            for (const item of val) {
              await runCmd(item, label);
            }
          } else {
            await runCmd(val, label);
          }
        }
        return;
      } else if (args.toLowerCase() === "preset") {
        const keys = Object.keys(presets);
        const presetsList = keys.length > 0
          ? keys.map(k => `  • ${getPresetLabel(k, presets[k])}: ${formatPresetValue(presets[k])}`).join("\n")
          : "  (No presets configured)";
        ctx.addLine({
          type: "system",
          content: [
            "🖥️ TERMINAL COMMAND & PRESETS",
            "Usage:",
            "  /terminal preset <name>     - Run a configured preset",
            "  /terminal <preset_name>     - Run a preset directly (if name matches)",
            "",
            "Available Presets:",
            presetsList,
            "",
            "Presets can be configured in `.superagent-r/terminal-presets.json` or `terminal-presets.json`.",
            "Run `/terminal init` to set up presets with AI guidance.",
          ].join("\n"),
          timestamp: Date.now()
        });
        return;
      } else if (args.toLowerCase().startsWith("preset ")) {
        const requestedName = args.slice(7).trim();
        const found = findPreset(presets, requestedName);
        if (found) {
          commandToRun = found.value;
          isPreset = true;
          presetName = getPresetLabel(found.key, found.value);
        } else {
          ctx.addLine({
            type: "error",
            content: `Error: Preset "${requestedName}" not found. Run /terminal preset to see available presets.`,
            timestamp: Date.now()
          });
          return;
        }
      } else {
        const found = findPreset(presets, args);
        if (found) {
          commandToRun = found.value;
          isPreset = true;
          presetName = getPresetLabel(found.key, found.value);
        }
      }

      if (Array.isArray(commandToRun)) {
        ctx.addLine({
          type: "system",
          content: `Running preset "${presetName}" with ${commandToRun.length} commands...`,
          timestamp: Date.now()
        });
        for (const c of commandToRun) {
          await runCmd(c);
        }
      } else {
        await runCmd(commandToRun);
      }
    };

    loadPresetsAndRun().catch(err => {
      ctx.addLine({
        type: "error",
        content: `Failed to execute terminal command: ${err.message}`,
        timestamp: Date.now()
      });
    });
  }
};

// Register configuration commands
registry.register(loginCommand);
registry.register(modelCommand);
registry.register(settingsCommand);
registry.register(settingConcurrencyCommand);
registry.register(settingRpmCommand);
registry.register(settingCapacityCommand);
registry.register(compactCommand);
registry.register(terminalCommand);
