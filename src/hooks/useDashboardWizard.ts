import React, { useCallback } from "react";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { 
  updateEnvFile, 
  switchActiveProvider, 
  addProvider,
  listHistorySessions, 
  fetchAndCacheModels,
  getConfiguredProviders,
  getContextWindowLimit,
  getInstalledSkills,
  getCachedModelIds,
  getModelPresets,
  applyModelPreset,
  saveModelPreset,
  deleteModelPreset,
  BUILT_IN_PRESETS,
  getProviderOptionsList,
  getActiveConfigAudit
} from "../core/config.js";
import type { PresetMode } from "../core/config.js";
import { filterSuggestions } from "../utils/text.js";
import { handleSlashCommand, getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, restoreCheckpoint } from "../core/checkpoints.js";
import { allTools } from "../core/tools.js";
import type { Agent } from "../core/agent.js";

export interface DashboardWizardContext {
  agent: Agent;
  exit: () => void;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  activeWizard: any;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  wizardSelectedSet: Set<number>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  masterLogs: string[];
  setMasterLogs: React.Dispatch<React.SetStateAction<string[]>>;
  activeModel: string;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  currentTask: string;
  setCurrentTask: React.Dispatch<React.SetStateAction<string>>;
  history: string[];
  setHistory: React.Dispatch<React.SetStateAction<string[]>>;
  historyIndex: number;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number>>;
  tempInput: string;
  setTempInput: React.Dispatch<React.SetStateAction<string>>;
  planState: string;
  setPlanState: React.Dispatch<React.SetStateAction<any>>;
  pendingQuestion: any;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  wizardAllOptions: string[];
  setWizardAllOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardIsLoadingModels: boolean;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  checkpointsList: any[];
  setCheckpointsList: React.Dispatch<React.SetStateAction<any[]>>;
  contextLimit: number;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  isPasted: boolean;
  setIsPasted: React.Dispatch<React.SetStateAction<boolean>>;
  pastePrefixLength: number;
  pasteSuffixLength: number;
  HISTORY_FILE: string;
  cachedSessions: any[];
  setCachedSessions: React.Dispatch<React.SetStateAction<any[]>>;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useDashboardWizard(ctx: DashboardWizardContext) {
  const {
    agent,
    exit,
    query,
    setQuery,
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    masterLogs,
    setMasterLogs,
    setActiveModel,
    setCurrentTask,
    history,
    setHistory,
    setHistoryIndex,
    planState,
    setPlanState,
    pendingQuestion,
    setPendingQuestion,
    wizardAllOptions,
    setWizardAllOptions,
    wizardIsLoadingModels,
    setWizardIsLoadingModels,
    checkpointsList,
    setCheckpointsList,
    setContextLimit,
    setIsPasted,
    HISTORY_FILE,
    cachedSessions,
    setCachedSessions,
    isProcessing,
    setIsProcessing,
  } = ctx;

  const isMulti = agent.isMultiAgent;
  const presetMode: PresetMode = isMulti ? "multi" : "single";
  const modeLabel = isMulti ? "Multi-Agent" : "Single-Agent";

  const getTierOptionsList = (
    masterModelFormatted: string,
    superagentModelFormatted: string,
    subagentModelFormatted: string,
    researcherModelFormatted: string,
    coderModelFormatted: string,
    reviewerModelFormatted: string
  ): string[] => {
    if (isMulti) {
      return [
        `1. Master Agent (depth 0) (${masterModelFormatted})`,
        `2. Superagent (depth 1) (${superagentModelFormatted})`,
        `3. Subagent (depth 2) (${subagentModelFormatted})`,
        `4. Subagent: researcher (${researcherModelFormatted})`,
        `5. Subagent: coder (${coderModelFormatted})`,
        `6. Subagent: reviewer (${reviewerModelFormatted})`,
        `7. All Tiers (Overwrite All)`,
        `< Back`
      ];
    } else {
      return [
        `1. Superagent (depth 1) (${superagentModelFormatted})`,
        `2. Subagent (depth 2) (${subagentModelFormatted})`,
        `3. Subagent: researcher (${researcherModelFormatted})`,
        `4. Subagent: coder (${coderModelFormatted})`,
        `5. Subagent: reviewer (${reviewerModelFormatted})`,
        `6. All Tiers (Overwrite All)`,
        `< Back`
      ];
    }
  };

  const getPresetOptionsList = (models: Record<string, string>): string[] => {
    const formatVal = (val?: string) => val ? val : "(not set)";
    if (isMulti) {
      return [
        `1. Master Agent (depth 0) (${formatVal(models.MODEL_MULTI_MASTER)})`,
        `2. Superagent (depth 1) (${formatVal(models.MODEL_MULTI_SUPERAGENT)})`,
        `3. Subagent (depth 2) (${formatVal(models.MODEL_MULTI_SUBAGENT)})`,
        `4. Subagent: researcher (${formatVal(models.MODEL_MULTI_SUBAGENT_RESEARCHER)})`,
        `5. Subagent: coder (${formatVal(models.MODEL_MULTI_SUBAGENT_CODER)})`,
        `6. Subagent: reviewer (${formatVal(models.MODEL_MULTI_SUBAGENT_REVIEWER)})`,
        "7. Save Preset & Exit",
        "8. Cancel & Exit",
        "< Back"
      ];
    } else {
      return [
        `1. Superagent (depth 1) (${formatVal(models.MODEL_SINGLE_SUPERAGENT)})`,
        `2. Subagent (depth 2) (${formatVal(models.MODEL_SINGLE_SUBAGENT)})`,
        `3. Subagent: researcher (${formatVal(models.MODEL_SINGLE_SUBAGENT_RESEARCHER)})`,
        `4. Subagent: coder (${formatVal(models.MODEL_SINGLE_SUBAGENT_CODER)})`,
        `5. Subagent: reviewer (${formatVal(models.MODEL_SINGLE_SUBAGENT_REVIEWER)})`,
        "6. Save Preset & Exit",
        "7. Cancel & Exit",
        "< Back"
      ];
    }
  };

  const handleWizardSubmit = useCallback(async (value: string) => {
    if (!activeWizard) return;
    const now = Date.now();

    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) {
        const choice = value.toLowerCase();
        if (choice.includes("add") || choice === "1") {
          setActiveWizard({
            type: "login",
            step: 2,
            data: {},
          });
          setWizardOptions(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
          setWizardSelectedIndex(0);
        } else {
          const list = getConfiguredProviders();
          if (list.length > 0) {
            setMasterLogs((prev) => [
              ...prev,
              `[SYSTEM] Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})`).join("\n")
            ].slice(-500));
          } else {
            setMasterLogs((prev) => [
              ...prev,
              `[SYSTEM] No providers configured yet.`
            ].slice(-500));
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      } else if (activeWizard.step === 2) {
        const choice = value.toLowerCase();
        let provider = "";
        if (choice === "1" || choice.includes("openrouter")) {
          provider = "openrouter";
        } else if (choice === "2" || choice.includes("openai")) {
          provider = "openai";
        } else if (choice === "3" || choice.includes("anthropic")) {
          provider = "anthropic";
        } else if (choice === "4" || choice.includes("custom")) {
          provider = "custom";
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid choice. Please select 1, 2, 3, or 4.`].slice(-500));
          return;
        }

        setMasterLogs((prev) => [
          ...prev,
          `[MASTER] Selected provider type: ${provider}`
        ].slice(-500));

        setActiveWizard({
          type: "login",
          step: 3,
          data: { provider },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 3) {
        const provider = activeWizard.data.provider;
        const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
        const profileName = nameInput || provider;

        if (provider === "custom") {
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Config Name: ${profileName}`
          ].slice(-500));
          setActiveWizard({
            type: "login",
            step: 4,
            data: { provider, name: profileName },
          });
        } else {
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Config Name: ${profileName}`
          ].slice(-500));
          setActiveWizard({
            type: "login",
            step: 5,
            data: { provider, name: profileName },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 4) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = value.trim();

        setMasterLogs((prev) => [
          ...prev,
          `[MASTER] Entered Base URL: ${baseUrl}`
        ].slice(-500));
        setActiveWizard({
          type: "login",
          step: 5,
          data: { provider, name: profileName, baseUrl },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 5) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = activeWizard.data.baseUrl;
        const apiKey = value.trim();

        const providerId = profileName.toLowerCase().replace(/[^a-z0-9_-]/g, "");

        try {
          // Simpan provider ke JSON (model-config.json) — BUKAN ke .env
          addProvider({
            id: providerId,
            name: profileName,
            provider: provider,
            apiKey: apiKey,
            baseUrl: baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
          });

          // Set provider ini sebagai aktif di preset JSON
          switchActiveProvider(providerId);

          // Set MODEL di memory saja — tidak ditulis ke .env
          if (!process.env.MODEL) {
            let defaultModel = "openai:gpt-4o";
            if (provider === "openrouter") defaultModel = "openrouter:google/gemini-2.5-flash";
            else if (provider === "anthropic") defaultModel = "anthropic:claude-3-5-sonnet-20241022";
            process.env.MODEL = defaultModel;
          }

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Successfully configured provider profile: ${profileName} (${provider})!\nSaved to model-config.json`
          ].slice(-500));

          fetchAndCacheModels()
            .then(() => {
              const effectiveMasterModel = isMulti ? (process.env.MODEL_MULTI_MASTER || process.env.MODEL || getDefaultModel()) : (process.env.MODEL || getDefaultModel());
              setActiveModel(effectiveMasterModel);
            })
            .catch(() => {});
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to save credentials: ${err.message}`].slice(-500));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 10) {
        const choice = value.toLowerCase();
        if (choice.includes("ask ai") || choice.startsWith("6")) {
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Selected AI-Assisted Initialization.\nStep 13: Briefly describe what you want to build (e.g. "A simple markdown parser command line tool in TypeScript"):`
          ].slice(-500));
          setActiveWizard({
            type: "login",
            step: 13,
            data: activeWizard.data,
          });
        } else {
          let stack = "TypeScript";
          if (choice.includes("javascript")) stack = "JavaScript";
          else if (choice.includes("python")) stack = "Python";
          else if (choice.includes("rust")) stack = "Rust";
          else if (choice.includes("go")) stack = "Go";

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Selected Stack: ${stack}\nStep 11: Enter Project Name (or press Enter for default "${path.basename(process.cwd())}"):`
          ].slice(-500));
          setActiveWizard({
            type: "login",
            step: 11,
            data: { ...activeWizard.data, stack },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 11) {
        const projectName = value.trim() || path.basename(process.cwd());
        setMasterLogs((prev) => [
          ...prev,
          `[SYSTEM] Project Name: ${projectName}\nStep 12: Enter a short Project Description:`
        ].slice(-500));
        setActiveWizard({
          type: "login",
          step: 12,
          data: { ...activeWizard.data, projectName },
        });
      } else if (activeWizard.step === 12) {
        const projectDesc = value.trim() || "A software project.";
        const projectName = activeWizard.data.projectName;
        const projectTech = activeWizard.data.stack;
        const cwd = process.cwd();

        (async () => {
          // Write agents.md
          const agentsPath = path.resolve(cwd, "agents.md");
          const defaultContent = [
            `# Project Specifications (agents.md)`,
            ``,
            `This file contains key information about the project for AI agents to study and align with.`,
            ``,
            `## Project Overview`,
            `- **Name**: ${projectName}`,
            `- **Description**: ${projectDesc}`,
            `- **Technology Stack**: ${projectTech}`,
            ``,
            `## Coding Guidelines`,
            `- On Windows, statement separator for terminal commands is ';' instead of '&&'.`,
            `- Always verify compilation and run tests before committing.`,
            ``,
          ].join("\n");

          await fs.writeFile(agentsPath, defaultContent, "utf-8");
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] 📄 Generated agents.md (created: ${projectName}, ${projectTech})`
          ].slice(-500));

          // Run audit/git setup summary
          const gitStatusLabel = activeWizard.data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : activeWizard.data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${activeWizard.data.gitStatus}`;
          const modelName = process.env.MODEL || getDefaultModel();
          const limit = getContextWindowLimit(modelName);

          const auditLines = [
            "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
            "│ ",
            "│ [HOST INFO]",
            `│ 🖥️ OS Platform   : ${process.platform}`,
            `│ 📦 Node Version   : ${process.version}`,
            `│ 📂 Workspace      : ${cwd}`,
            "│ ",
            "│ [VERSION CONTROL]",
            `│ 🔀 Git Status     : ${gitStatusLabel}`,
            ...(activeWizard.data.gitBranch ? [`│ 🌿 Branch         : ${activeWizard.data.gitBranch}`] : []),
            ...(activeWizard.data.gitSha ? [`│ 📌 HEAD           : ${activeWizard.data.gitSha}`] : []),
            "│ ",
            "│ [COGNITIVE CORE]",
            getActiveConfigAudit(),
            `│ ✦ Streaming       : ${process.env.DISABLE_STREAMING === "true" ? "DISABLED" : "ENABLED"}`,
            "│ ",
            "│ [PROJECT METADATA]",
            `│ 📄 Registry File  : CREATED (${agentsPath})`,
            `│ 📂 Project Name   : ${projectName}`,
            `│ 🛠️ Tech Stack      : ${projectTech}`,
            "│ ",
            "│ [SYSTEM TOOLS]",
            `│ 🛠️ Loaded Tools (${allTools.length}): ${allTools.map(t => t.name).join(", ")}`,
            "│ ",
            "└──────────────────────────────────────────────"
          ];
          setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-500));
        })().catch(err => {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to complete project initialization: ${err.message}`].slice(-500));
        });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 13) {
        const goal = value.trim();
        if (!goal) {
          setMasterLogs((prev) => [...prev, `[ERROR] AI prompt cannot be empty. Initialization cancelled.`].slice(-500));
          setActiveWizard(null);
          return;
        }

        setMasterLogs((prev) => [...prev, `[SYSTEM] 🤖 Consulting AI to formulate project structure...`].slice(-500));
        setCurrentTask("Consulting AI for project structure...");

        (async () => {
          try {
            const prompt = `You are a software architect. Build a specifications file named 'agents.md' for this new project based on the user's goal: "${goal}".
Generate ONLY a raw markdown document that maps precisely to this structure:

# Project Specifications (agents.md)

## Project Overview
- **Name**: [a suitable name for the project]
- **Description**: [one-sentence clear description]
- **Technology Stack**: [a list of key libraries and language, e.g. TypeScript, React, Vite]

## Coding Guidelines
- On Windows, statement separator for terminal commands is ';' instead of '&&'.
- Always verify compilation and run tests before committing.
[Add 2-3 specific custom guidelines for the target stack if helpful]`;

            // Make direct completion request to active provider/model
            const { generateText } = await import("ai");
            const { rateLimiter, concurrencyLimiter } = await import("../core/rateLimiter.js");
            const modelConfig = (agent as any).getModel();
            
            let concurrencyAcquired = false;
            let response;
            try {
              if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
                await concurrencyLimiter.acquire();
                concurrencyAcquired = true;
              }
              await rateLimiter.acquire(1);
              response = await generateText({
                model: modelConfig,
                prompt: prompt,
              });
            } finally {
              if (concurrencyAcquired) {
                concurrencyLimiter.release();
              }
            }

            const content = response.text || "";
            const cwd = process.cwd();
            const agentsPath = path.resolve(cwd, "agents.md");
            await fs.writeFile(agentsPath, content, "utf-8");
            setMasterLogs((prev) => [...prev, `[SYSTEM] 📄 Generated agents.md successfully!`].slice(-500));

            // Extract project details dynamically from AI generated content
            let projectName = path.basename(cwd);
            let projectTech = "Unknown";
            const nameMatch = content.match(/-\s*\*\*Name\*\*:\s*(.*)/i);
            if (nameMatch) projectName = nameMatch[1].trim();
            const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
            if (techMatch) projectTech = techMatch[1].trim();

            const gitStatusLabel = activeWizard.data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : activeWizard.data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${activeWizard.data.gitStatus}`;
            const modelName = process.env.MODEL || getDefaultModel();
            const limit = getContextWindowLimit(modelName);

            const auditLines = [
              "┌───[ ⚙️ SYSTEM AUDIT & AGENT INITIALIZATION ]",
              "│ ",
              "│ [HOST INFO]",
              `│ 🖥️ OS Platform   : ${process.platform}`,
              `│ 📦 Node Version   : ${process.version}`,
              `│ 📂 Workspace      : ${cwd}`,
              "│ ",
              "│ [VERSION CONTROL]",
              `│ 🔀 Git Status     : ${gitStatusLabel}`,
              ...(activeWizard.data.gitBranch ? [`│ 🌿 Branch         : ${activeWizard.data.gitBranch}`] : []),
              ...(activeWizard.data.gitSha ? [`│ 📌 HEAD           : ${activeWizard.data.gitSha}`] : []),
              "│ ",
              "│ [COGNITIVE CORE]",
              getActiveConfigAudit(),
              `│ ✦ Streaming       : ${process.env.DISABLE_STREAMING === "true" ? "DISABLED" : "ENABLED"}`,
              "│ ",
              "│ [PROJECT METADATA]",
              `│ 📄 Registry File  : CREATED (${agentsPath})`,
              `│ 📂 Project Name   : ${projectName}`,
              `│ 🛠️ Tech Stack      : ${projectTech}`,
              "│ ",
              "│ [SYSTEM TOOLS]",
              `│ 🛠️ Loaded Tools (${allTools.length}): ${allTools.map(t => t.name).join(", ")}`,
              "│ ",
              "└──────────────────────────────────────────────"
            ];
            setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-500));
          } catch (aiErr: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] AI code completion request failed: ${aiErr.message}. Falling back to default project structure.`].slice(-500));
            
            // Fallback content write
            const cwd = process.cwd();
            const agentsPath = path.resolve(cwd, "agents.md");
            const fallbackContent = [
              `# Project Specifications (agents.md)`,
              ``,
              `## Project Overview`,
              `- **Name**: ${path.basename(cwd)}`,
              `- **Description**: A new software project.`,
              `- **Technology Stack**: Custom Stack`,
              ``,
              `## Coding Guidelines`,
              `- On Windows, statement separator for terminal commands is ';' instead of '&&'.`,
              `- Always verify compilation and run tests before committing.`,
            ].join("\n");
            await fs.writeFile(agentsPath, fallbackContent, "utf-8");
          } finally {
            setCurrentTask("Idle");
          }
        })();

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (activeWizard.type === "model") {
      if (activeWizard.step === 1) {
        const choice = value.toLowerCase();
        
        if (choice.includes("load") || choice.includes("apply") || choice === "1. load/apply model preset") {
          setActiveWizard({
            type: "model",
            step: 4,
            data: {},
          });
          const presets = getModelPresets(presetMode);
          const options = presets.map(p => `${p.name} - ${p.description}${p.mode ? ` [${p.mode}]` : ""}`);
          setWizardOptions([...options, "< Back"]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("list") || choice === "2. list model presets") {
          const presets = getModelPresets(presetMode);
          const listStr = presets.map(p => {
            const modeInfo = p.mode ? ` [${p.mode}]` : "";
            const modelsStr = Object.entries(p.models).map(([k, v]) => `    - ${k}: ${v}`).join("\n");
            return `- **${p.name}**${modeInfo}: ${p.description}\n${modelsStr}`;
          }).join("\n");
          setMasterLogs((prev) => [
            ...prev,
            `Available Model Presets (${modeLabel}):\n${listStr}`
          ].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("create") || choice === "3. create model preset") {
          setActiveWizard({
            type: "model",
            step: 20,
            data: {},
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("edit") || choice === "4. edit model preset") {
          const presets = getModelPresets(presetMode);
          const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
          if (customPresets.length === 0) {
            setMasterLogs((prev) => [...prev, `[ERROR] No custom presets available to edit for ${modeLabel} mode.`].slice(-500));
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
          }
          setActiveWizard({
            type: "model",
            step: 30,
            data: {},
          });
          setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("delete") || choice === "5. delete model preset") {
          const presets = getModelPresets(presetMode);
          const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
          if (customPresets.length === 0) {
            setMasterLogs((prev) => [...prev, `[ERROR] No custom presets available to delete for ${modeLabel} mode.`].slice(-500));
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            return;
          }
          setActiveWizard({
            type: "model",
            step: 40,
            data: {},
          });
          setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("configure") || choice === "6. configure agent tier models") {
          const getResolvedModelWithProvider = (rawVal: string, isDefault: boolean): string => {
            const mStr = (rawVal || (isDefault ? (process.env.MODEL || getDefaultModel()) : "")).trim();
            if (!mStr) return "(not set)";
            if (mStr.includes(":")) return mStr;
            const activeProvider = (process.env.ACTIVE_PROVIDER || (process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim();
            return `${activeProvider}:${mStr}`;
          };
          const defaultResolved = getResolvedModelWithProvider("", true);
          const rawMaster = isMulti ? (process.env.MODEL_MULTI_MASTER || "") : "";
          const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
          const rawSuperagent = isMulti ? (process.env.MODEL_MULTI_SUPERAGENT || "") : (process.env.MODEL_SINGLE_SUPERAGENT || "");
          const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
          const rawSubagent = isMulti ? (process.env.MODEL_MULTI_SUBAGENT || "") : (process.env.MODEL_SINGLE_SUBAGENT || "");
          const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
          const rawResearcher = isMulti ? (process.env.MODEL_MULTI_SUBAGENT_RESEARCHER || "") : (process.env.MODEL_SINGLE_SUBAGENT_RESEARCHER || "");
          const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
          const rawCoder = isMulti ? (process.env.MODEL_MULTI_SUBAGENT_CODER || "") : (process.env.MODEL_SINGLE_SUBAGENT_CODER || "");
          const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
          const rawReviewer = isMulti ? (process.env.MODEL_MULTI_SUBAGENT_REVIEWER || "") : (process.env.MODEL_SINGLE_SUBAGENT_REVIEWER || "");
          const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

          setActiveWizard({
            type: "model",
            step: 50,
            data: {},
          });
          setWizardOptions(getTierOptionsList(masterModelFormatted, superagentModelFormatted, subagentModelFormatted, researcherModelFormatted, coderModelFormatted, reviewerModelFormatted));
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("back") || choice === "< back") {
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        // Fallback or direct input tier selection
        let tier = "";
        if (choice.includes("master") || choice.includes("depth 0")) {
          tier = "master";
        } else if (choice.includes("superagent") || choice.includes("depth 1")) {
          tier = "superagent";
        } else if (choice.includes("subagents") || choice.includes("depth 2")) {
          tier = "subagent";
        } else if (choice.includes("researcher")) {
          tier = "researcher";
        } else if (choice.includes("coder")) {
          tier = "coder";
        } else if (choice.includes("reviewer")) {
          tier = "reviewer";
        } else if (choice.includes("default") || choice.includes("default model")) {
          tier = "default";
        } else if (choice.includes("all")) {
          tier = "all";
        } else {
          if (isMulti) {
            const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "all"];
            const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
            tier = tiers[idx] || "master";
          } else {
            const tiers = ["superagent", "subagent", "researcher", "coder", "reviewer", "all"];
            const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
            tier = tiers[idx] || "superagent";
          }
        }

        setActiveWizard({
          type: "model",
          step: 2,
          data: { tier },
        });

        setWizardOptions([
          "1. OpenRouter (Recommended)",
          "2. OpenAI",
          "3. Anthropic",
          "4. Custom Endpoint",
          "5. Not Set (Clear Override)",
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 2) {
        if (value === "< Back") {
          const getResolvedModelWithProvider = (rawVal: string, isDefault: boolean): string => {
            const mStr = (rawVal || (isDefault ? (process.env.MODEL || getDefaultModel()) : "")).trim();
            if (!mStr) return "(not set)";
            if (mStr.includes(":")) return mStr;
            const activeProvider = (process.env.ACTIVE_PROVIDER || (process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim();
            return `${activeProvider}:${mStr}`;
          };
          const defaultResolved = getResolvedModelWithProvider("", true);
          const rawMaster = isMulti ? (process.env.MODEL_MULTI_MASTER || "") : "";
          const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
          const rawSuperagent = isMulti ? (process.env.MODEL_MULTI_SUPERAGENT || "") : (process.env.MODEL_SINGLE_SUPERAGENT || "");
          const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
          const rawSubagent = isMulti ? (process.env.MODEL_MULTI_SUBAGENT || "") : (process.env.MODEL_SINGLE_SUBAGENT || "");
          const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
          const rawResearcher = isMulti ? (process.env.MODEL_MULTI_SUBAGENT_RESEARCHER || "") : (process.env.MODEL_SINGLE_SUBAGENT_RESEARCHER || "");
          const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
          const rawCoder = isMulti ? (process.env.MODEL_MULTI_SUBAGENT_CODER || "") : (process.env.MODEL_SINGLE_SUBAGENT_CODER || "");
          const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
          const rawReviewer = isMulti ? (process.env.MODEL_MULTI_SUBAGENT_REVIEWER || "") : (process.env.MODEL_SINGLE_SUBAGENT_REVIEWER || "");
          const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

          setActiveWizard({
            type: "model",
            step: 50,
            data: { ...activeWizard.data },
          });
          setWizardOptions(getTierOptionsList(masterModelFormatted, superagentModelFormatted, subagentModelFormatted, researcherModelFormatted, coderModelFormatted, reviewerModelFormatted));
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (value.toLowerCase().includes("not set") || value === "5") {
          const tier = activeWizard.data.tier || "";
          let clearUpdates: Record<string, string> = {};
          let targetLabel = "";
          if (tier === "master") {
            if (isMulti) {
              clearUpdates = { MODEL_MULTI_MASTER: "" };
            }
            targetLabel = "Master Agent (depth 0)";
          } else if (tier === "superagent") {
            if (isMulti) {
              clearUpdates = { MODEL_MULTI_SUPERAGENT: "" };
            } else {
              clearUpdates = { MODEL_SINGLE_SUPERAGENT: "" };
            }
            targetLabel = "Superagent (depth 1)";
          } else if (tier === "subagent") {
            if (isMulti) {
              clearUpdates = { MODEL_MULTI_SUBAGENT: "" };
            } else {
              clearUpdates = { MODEL_SINGLE_SUBAGENT: "" };
            }
            targetLabel = "Subagent (depth 2)";
          } else if (tier === "researcher") {
            if (isMulti) {
              clearUpdates = { MODEL_MULTI_SUBAGENT_RESEARCHER: "" };
            } else {
              clearUpdates = { MODEL_SINGLE_SUBAGENT_RESEARCHER: "" };
            }
            targetLabel = `Subagent "researcher"`;
          } else if (tier === "coder") {
            if (isMulti) {
              clearUpdates = { MODEL_MULTI_SUBAGENT_CODER: "" };
            } else {
              clearUpdates = { MODEL_SINGLE_SUBAGENT_CODER: "" };
            }
            targetLabel = `Subagent "coder"`;
          } else if (tier === "reviewer") {
            if (isMulti) {
              clearUpdates = { MODEL_MULTI_SUBAGENT_REVIEWER: "" };
            } else {
              clearUpdates = { MODEL_SINGLE_SUBAGENT_REVIEWER: "" };
            }
            targetLabel = `Subagent "reviewer"`;
          } else if (tier === "all") {
            if (isMulti) {
              clearUpdates = {
                MODEL_MULTI_MASTER: "",
                MODEL_MULTI_SUPERAGENT: "",
                MODEL_MULTI_SUBAGENT: "",
                MODEL_MULTI_SUBAGENT_RESEARCHER: "",
                MODEL_MULTI_SUBAGENT_CODER: "",
                MODEL_MULTI_SUBAGENT_REVIEWER: "",
              };
            } else {
              clearUpdates = {
                MODEL_SINGLE: "",
                MODEL_SINGLE_SUPERAGENT: "",
                MODEL_SINGLE_SUBAGENT: "",
                MODEL_SINGLE_SUBAGENT_RESEARCHER: "",
                MODEL_SINGLE_SUBAGENT_CODER: "",
                MODEL_SINGLE_SUBAGENT_REVIEWER: "",
              };
            }
            targetLabel = "All Tiers";
          }
          if (Object.keys(clearUpdates).length > 0) {
            updateEnvFile(clearUpdates);
            const effectiveMasterModel = isMulti ? (process.env.MODEL_MULTI_MASTER || process.env.MODEL || getDefaultModel()) : (process.env.MODEL || getDefaultModel());
            setActiveModel(effectiveMasterModel);
            setMasterLogs((prev) => [
              ...prev,
              `[SYSTEM] ${targetLabel} model override cleared (not set).`
            ].slice(-500));
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const choice = value.toLowerCase();
        let providerType = "";
        if (choice.includes("openrouter") || choice === "1") {
          providerType = "openrouter";
        } else if (choice.includes("openai") || choice === "2") {
          providerType = "openai";
        } else if (choice.includes("anthropic") || choice === "3") {
          providerType = "anthropic";
        } else if (choice.includes("custom") || choice === "4") {
          providerType = "custom";
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid provider type choice.`].slice(-500));
          return;
        }

        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...activeWizard.data, providerType },
        });

        const list = getConfiguredProviders();
        const matchingProfiles = list.filter(p => p.type === providerType);
        const profileOptions = matchingProfiles.map(p => {
          const prefix = `PROVIDER_${p.name.toUpperCase()}`;
          const apiKey = process.env[`${prefix}_API_KEY`] || "";
          const maskedKey = apiKey
            ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
            : "(no key)";
          return `${p.name} (key: ${maskedKey})`;
        });

        setWizardOptions([
          ...profileOptions,
          `+ Configure a new ${providerType} profile`,
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 3) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 2,
            data: { ...activeWizard.data },
          });
          setWizardOptions([
            "1. OpenRouter (Recommended)",
            "2. OpenAI",
            "3. Anthropic",
            "4. Custom Endpoint",
            "5. Not Set (Clear Override)",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const providerType = activeWizard.data.providerType;
        if (value.startsWith("+ Configure a new")) {
          setActiveWizard({
            type: "model",
            step: 16,
            data: { ...activeWizard.data },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Configure new profile. Please enter a profile name (alphanumeric, e.g. ${providerType}_dev):`
          ].slice(-500));
          return;
        }

        const profileName = value.split(" (key:")[0].trim();
        const list = getConfiguredProviders();
        const found = list.find(p => p.name.toLowerCase() === profileName.toLowerCase());
        
        let resolvedApiKey = "";
        let resolvedBaseUrl = "";
        if (found) {
          resolvedBaseUrl = found.baseUrl || "";
          const prefix = `PROVIDER_${found.name.toUpperCase()}`;
          resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
        }

        setActiveWizard({
          type: "model",
          step: 15,
          data: { ...activeWizard.data, provider: profileName },
        });

        let initialModels: string[] = [];
        if (providerType === "openrouter") {
          initialModels = [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ];
          setWizardIsLoadingModels(true);
          const headers: Record<string, string> = {};
          if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
          fetch("https://openrouter.ai/api/v1/models", { headers })
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList: string[] = data.data.map((m: any) => m.id);
                  setWizardAllOptions([...modelsList, "< Back"]);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        } else if (providerType === "openai") {
          initialModels = [
            "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o1-preview", "o3-mini",
          ];
          if (resolvedApiKey) {
            setWizardIsLoadingModels(true);
            fetch("https://api.openai.com/v1/models", {
              headers: { Authorization: `Bearer ${resolvedApiKey}` }
            })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList: string[] = data.data.map((m: any) => m.id);
                    setWizardAllOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "anthropic") {
          initialModels = [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ];
        } else if (providerType === "custom") {
          initialModels = [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ];
          if (resolvedBaseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
            fetch(`${resolvedBaseUrl}/models`, { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList: string[] = data.data.map((m: any) => m.id);
                    setWizardAllOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        setWizardAllOptions([...initialModels, "< Back"]);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
        setMasterLogs((prev) => [...prev, `[MASTER] Provider profile "${profileName}" selected. Choose a model below:`].slice(-500));
      } else if (activeWizard.step === 16) {
        if (value === "< Back") {
          const providerType = activeWizard.data.providerType;
          setActiveWizard({
            type: "model",
            step: 3,
            data: { ...activeWizard.data },
          });
          const list = getConfiguredProviders();
          const matchingProfiles = list.filter(p => p.type === providerType);
          const profileOptions = matchingProfiles.map(p => {
            const prefix = `PROVIDER_${p.name.toUpperCase()}`;
            const apiKey = process.env[`${prefix}_API_KEY`] || "";
            const maskedKey = apiKey
              ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
              : "(no key)";
            return `${p.name} (key: ${maskedKey})`;
          });
          setWizardOptions([
            ...profileOptions,
            `+ Configure a new ${providerType} profile`,
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
        const providerType = activeWizard.data.providerType;
        const profileName = nameInput || providerType;

        if (providerType === "custom") {
          setActiveWizard({
            type: "model",
            step: 17,
            data: { ...activeWizard.data, name: profileName },
          });
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Profile name: ${profileName}. Please enter Base URL for Custom Endpoint (e.g. http://localhost:11434/v1):`
          ].slice(-500));
        } else {
          setActiveWizard({
            type: "model",
            step: 18,
            data: { ...activeWizard.data, name: profileName },
          });
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Profile name: ${profileName}. Please enter API Key:`
          ].slice(-500));
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 17) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 16,
            data: { ...activeWizard.data },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const baseUrl = value.trim();
        setActiveWizard({
          type: "model",
          step: 18,
          data: { ...activeWizard.data, baseUrl },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
        setMasterLogs((prev) => [
          ...prev,
          `[SYSTEM] Base URL: ${baseUrl}. Please enter API Key:`
        ].slice(-500));
      } else if (activeWizard.step === 18) {
        if (value === "< Back") {
          const providerType = activeWizard.data.providerType;
          if (providerType === "custom") {
            setActiveWizard({
              type: "model",
              step: 17,
              data: { ...activeWizard.data },
            });
          } else {
            setActiveWizard({
              type: "model",
              step: 16,
              data: { ...activeWizard.data },
            });
          }
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const apiKey = value.trim();
        const providerType = activeWizard.data.providerType;
        const profileName = activeWizard.data.name;
        const baseUrl = activeWizard.data.baseUrl;

        const prefix = `PROVIDER_${profileName.toUpperCase()}`;
        const updates: Record<string, string> = {
          [`${prefix}_TYPE`]: providerType,
          [`${prefix}_API_KEY`]: apiKey,
        };

        if (baseUrl) {
          updates[`${prefix}_BASE_URL`] = baseUrl;
        } else if (providerType === "openrouter") {
          updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
        }

        try {
          const envPath = updateEnvFile(updates);
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Successfully configured provider profile: ${profileName} (${providerType})!\nSaved to: ${envPath}`
          ].slice(-500));
          
          const nextStep = activeWizard.data.isPreset === "true"
            ? Number(activeWizard.data.returnStep)
            : 15;

          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data, provider: profileName },
          });

          let initialModels: string[] = [];
          if (providerType === "openrouter") {
            initialModels = [
              "google/gemini-2.5-flash",
              "meta-llama/llama-3.3-70b-instruct",
              "deepseek/deepseek-chat",
              "anthropic/claude-3.5-sonnet",
            ];
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
            fetch("https://openrouter.ai/api/v1/models", { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    setWizardAllOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          } else if (providerType === "openai") {
            initialModels = [
              "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o1-preview", "o3-mini",
            ];
            if (apiKey) {
              setWizardIsLoadingModels(true);
              fetch("https://api.openai.com/v1/models", {
                headers: { Authorization: `Bearer ${apiKey}` }
              })
                .then(async (res) => {
                  if (res.ok) {
                    const data = await res.json() as any;
                    if (data && Array.isArray(data.data)) {
                      const modelsList = data.data.map((m: any) => m.id);
                      setWizardAllOptions([...modelsList, "< Back"]);
                    }
                  }
                })
                .catch(() => {})
                .finally(() => setWizardIsLoadingModels(false));
            }
          } else if (providerType === "anthropic") {
            initialModels = [
              "claude-opus-4-5",
              "claude-sonnet-4-5",
              "claude-3-5-sonnet-20241022",
              "claude-3-5-haiku-20241022",
              "claude-3-opus-20240229",
            ];
          } else if (providerType === "custom") {
            initialModels = [
              "deepseek-chat", "llama-3.3-70b-instruct",
            ];
            if (baseUrl) {
              setWizardIsLoadingModels(true);
              const headers: Record<string, string> = {};
              if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
              fetch(`${baseUrl}/models`, { headers })
                .then(async (res) => {
                  if (res.ok) {
                    const data = await res.json() as any;
                    if (data && Array.isArray(data.data)) {
                      const modelsList = data.data.map((m: any) => m.id);
                      setWizardAllOptions([...modelsList, "< Back"]);
                    }
                  }
                })
                .catch(() => {})
                .finally(() => setWizardIsLoadingModels(false));
            }
          }

          setWizardAllOptions([...initialModels, "< Back"]);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to save credentials: ${err.message}`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      } else if (activeWizard.step === 15) {
        if (value === "< Back") {
          const providerType = activeWizard.data.providerType;
          setActiveWizard({
            type: "model",
            step: 3,
            data: { ...activeWizard.data },
          });
          const list = getConfiguredProviders();
          const matchingProfiles = list.filter(p => p.type === providerType);
          const profileOptions = matchingProfiles.map(p => {
            const prefix = `PROVIDER_${p.name.toUpperCase()}`;
            const apiKey = process.env[`${prefix}_API_KEY`] || "";
            const maskedKey = apiKey
              ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
              : "(no key)";
            return `${p.name} (key: ${maskedKey})`;
          });
          setWizardOptions([
            ...profileOptions,
            `+ Configure a new ${providerType} profile`,
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const modelName = value;
        const profileName = activeWizard.data.provider || "";
        const tier = activeWizard.data.tier || "";
        
        try {
          let envPath = "";
          let targetLabel = "";
          if (tier === "default") {
            switchActiveProvider(profileName);
            envPath = updateEnvFile({ 
              MODEL: modelName,
              [`PROVIDER_${profileName.toUpperCase()}_MODEL`]: modelName
            });
            targetLabel = "Default Model";
          } else if (tier === "all") {
            const activeProvider = process.env.ACTIVE_PROVIDER || profileName;
            const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
              ? `${profileName.toLowerCase()}:${modelName}`
              : modelName;
            const updates: Record<string, string> = { MODEL: modelName };
            if (isMulti) {
              updates.MODEL_MULTI_MASTER = finalModelName;
              updates.MODEL_MULTI_SUPERAGENT = finalModelName;
              updates.MODEL_MULTI_SUBAGENT = finalModelName;
              updates.MODEL_MULTI_SUBAGENT_RESEARCHER = finalModelName;
              updates.MODEL_MULTI_SUBAGENT_CODER = finalModelName;
              updates.MODEL_MULTI_SUBAGENT_REVIEWER = finalModelName;
            } else {
              updates.MODEL_SINGLE = modelName;
              updates.MODEL_SINGLE_SUPERAGENT = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT_RESEARCHER = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT_CODER = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT_REVIEWER = finalModelName;
            }
            targetLabel = "All Tiers & Subagents";
            switchActiveProvider(profileName);
            envPath = updateEnvFile(updates);
          } else {
            const activeProvider = process.env.ACTIVE_PROVIDER || profileName;
            const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
              ? `${profileName.toLowerCase()}:${modelName}`
              : modelName;
            
            let updates: Record<string, string> = {};
            if (tier === "master") {
              if (isMulti) {
                updates = { MODEL_MULTI_MASTER: finalModelName };
              }
              targetLabel = "Master Agent (depth 0) Model";
            } else if (tier === "superagent") {
              if (isMulti) {
                updates = { MODEL_MULTI_SUPERAGENT: finalModelName };
              } else {
                updates = { MODEL_SINGLE_SUPERAGENT: finalModelName };
              }
              targetLabel = "Superagent (depth 1) Model";
            } else if (tier === "subagent") {
              if (isMulti) {
                updates = { MODEL_MULTI_SUBAGENT: finalModelName };
              } else {
                updates = { MODEL_SINGLE_SUBAGENT: finalModelName };
              }
              targetLabel = "Subagent (depth 2) Model";
            } else {
              const typeUpper = tier.toUpperCase();
              if (isMulti) {
                updates = { [`MODEL_MULTI_SUBAGENT_${typeUpper}`]: finalModelName };
              } else {
                updates = { [`MODEL_SINGLE_SUBAGENT_${typeUpper}`]: finalModelName };
              }
              targetLabel = `Subagent "${tier}" Model`;
            }
            envPath = updateEnvFile(updates);
          }

          const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
          const limit = getContextWindowLimit(cleanModelName);
          
          if (tier === "default" || tier === "all") {
            setContextLimit(limit);
          }
          const effectiveMasterModel = isMulti ? (process.env.MODEL_MULTI_MASTER || process.env.MODEL || getDefaultModel()) : (process.env.MODEL || getDefaultModel());
          setActiveModel(effectiveMasterModel);
          
          const currentModel = process.env.MODEL || getDefaultModel();
          const masterModel = isMulti ? (process.env.MODEL_MULTI_MASTER || "(use default)") : "(N/A)";
          const superagentModel = isMulti ? (process.env.MODEL_MULTI_SUPERAGENT || "(use default)") : (process.env.MODEL_SINGLE_SUPERAGENT || "(use default)");
          const subagentModel = isMulti ? (process.env.MODEL_MULTI_SUBAGENT || "(use default)") : (process.env.MODEL_SINGLE_SUBAGENT || "(use default)");
          
          let updatedList = `\n\nUpdated Models:\n` +
            `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          for (const [key, val] of Object.entries(process.env)) {
            if (val && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SINGLE_SUBAGENT_"))) {
              const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
                ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
                : key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
              updatedList += `\n  Subagent "${name}": ${val}`;
            }
          }

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] ${targetLabel} successfully changed to: ${modelName} (via provider ${profileName})\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}${updatedList}`
          ].slice(-500));
          
          if (tier === "default" || tier === "all") {
            fetchAndCacheModels()
              .then(() => {
                const newLimit = getContextWindowLimit(cleanModelName);
                setContextLimit(newLimit);
              })
              .catch(() => {});
          }
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to set model: ${err.message}`].slice(-500));
        }

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardIsLoadingModels(false);
      } else if (activeWizard.step === 4) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions([
            `1. Load/Apply Model Preset [${modeLabel}]`,
            `2. List Model Presets [${modeLabel}]`,
            `3. Create Model Preset [${modeLabel}]`,
            `4. Edit Model Preset [${modeLabel}]`,
            `5. Delete Model Preset [${modeLabel}]`,
            "6. Configure Agent Tier Models",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const presetChoice = value;
        const presetName = presetChoice.split(" - ")[0].trim();
        try {
          const envPath = applyModelPreset(presetName, presetMode);
          const isSingle = !isMulti;
          const effectiveMasterModel = isSingle
            ? (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel())
            : (process.env.MODEL_MULTI_MASTER || process.env.MODEL || getDefaultModel());
          const limit = getContextWindowLimit(effectiveMasterModel);
          setContextLimit(limit);
          setActiveModel(effectiveMasterModel);

          const updatedLogs = [
            `[MASTER] Updated Models:`,
          ];

          if (isSingle) {
            const singleModel = process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel();
            const subagentModel = process.env.MODEL_SINGLE_SUBAGENT || "(use default)";
            updatedLogs.push(
              `[MASTER]   Single Agent Model: ${singleModel}`,
              `[MASTER]   Subagent (depth 2): ${subagentModel}`
            );

            for (const [key, val] of Object.entries(process.env)) {
              if (val && key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
                const name = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
                if (!updatedLogs.some(log => log.includes(`Subagent "${name}":`))) {
                  updatedLogs.push(`[MASTER]   Subagent "${name}": ${val}`);
                }
              }
            }
          } else {
            const masterModel = process.env.MODEL_MULTI_MASTER || "(use default)";
            const superagentModel = process.env.MODEL_MULTI_SUPERAGENT || "(use default)";
            const subagentModel = process.env.MODEL_MULTI_SUBAGENT || "(use default)";
            
            updatedLogs.push(
              `[MASTER]   Master Agent (depth 0): ${masterModel}`,
              `[MASTER]   Superagent (depth 1): ${superagentModel}`,
              `[MASTER]   Subagent (depth 2): ${subagentModel}`
            );

            for (const [key, val] of Object.entries(process.env)) {
              if (val && key.startsWith("MODEL_MULTI_SUBAGENT_")) {
                const name = key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase();
                if (!updatedLogs.some(log => log.includes(`Subagent "${name}":`))) {
                  updatedLogs.push(`[MASTER]   Subagent "${name}": ${val}`);
                }
              }
            }
          }

          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Model preset "${presetName}" applied successfully!`,
            `[MASTER] Context Limit: ${limit.toLocaleString()} tokens`,
            `[MASTER] Saved to: ${envPath}`,
            ...updatedLogs
          ].slice(-500));
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to apply model preset: ${err.message}`].slice(-500));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
      } else if (activeWizard.step === 20) {
        const name = value.trim();
        if (name.toLowerCase() === "< back" || name.toLowerCase() === "back") {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions([
            `1. Load/Apply Model Preset [${modeLabel}]`,
            `2. List Model Presets [${modeLabel}]`,
            `3. Create Model Preset [${modeLabel}]`,
            `4. Edit Model Preset [${modeLabel}]`,
            `5. Delete Model Preset [${modeLabel}]`,
            "6. Configure Agent Tier Models",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }
        if (!name) {
          setMasterLogs((prev) => [...prev, `[ERROR] Preset name cannot be empty.`].slice(-500));
          return;
        }
        if (BUILT_IN_PRESETS.some(bp => bp.name === name.toLowerCase())) {
          setMasterLogs((prev) => [...prev, `[ERROR] Cannot overwrite built-in preset "${name}".`].slice(-500));
          return;
        }
        setActiveWizard({
          type: "model",
          step: 21,
          data: { ...activeWizard.data, presetName: name },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 21) {
        const desc = value.trim();
        if (desc.toLowerCase() === "< back" || desc.toLowerCase() === "back") {
          setActiveWizard({
            type: "model",
            step: 20,
            data: { ...activeWizard.data },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }
        setActiveWizard({
          type: "model",
          step: 22,
          data: { ...activeWizard.data, presetDescription: desc, presetModels: JSON.stringify({}) },
        });
        setWizardOptions(getPresetOptionsList({}));
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 22 || activeWizard.step === 32) {
        const models: Record<string, string> = activeWizard.data.presetModels ? JSON.parse(activeWizard.data.presetModels) : {};
        if (value === "< Back") {
          const nextStep = activeWizard.step === 22 ? 21 : 31;
          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }
        if (value.includes("Save Preset")) {
          const presetName = activeWizard.data.presetName || "";
          const presetDescription = activeWizard.data.presetDescription || "";
          try {
            const savedPath = saveModelPreset(presetName, presetDescription, models, presetMode);

            // Auto-apply the preset after saving
            const envPath = applyModelPreset(presetName, presetMode);
            const isSingle = !isMulti;
            const effectiveMasterModel = isSingle
              ? (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel())
              : (process.env.MODEL_MULTI_MASTER || process.env.MODEL || getDefaultModel());
            const limit = getContextWindowLimit(effectiveMasterModel);
            setContextLimit(limit);
            setActiveModel(effectiveMasterModel);

            const updatedLogs = [
              `[MASTER] Updated Models:`,
            ];

            if (isSingle) {
              const singleModel = process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel();
              const subagentModel = process.env.MODEL_SINGLE_SUBAGENT || "(use default)";
              updatedLogs.push(
                `[MASTER]   Single Agent Model: ${singleModel}`,
                `[MASTER]   Subagent (depth 2): ${subagentModel}`
              );

              for (const [key, val] of Object.entries(process.env)) {
                if (val && key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
                  const name = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
                  if (!updatedLogs.some(log => log.includes(`Subagent "${name}":`))) {
                    updatedLogs.push(`[MASTER]   Subagent "${name}": ${val}`);
                  }
                }
              }
            } else {
              const masterModel = process.env.MODEL_MULTI_MASTER || "(use default)";
              const superagentModel = process.env.MODEL_MULTI_SUPERAGENT || "(use default)";
              const subagentModel = process.env.MODEL_MULTI_SUBAGENT || "(use default)";
              
              updatedLogs.push(
                `[MASTER]   Master Agent (depth 0): ${masterModel}`,
                `[MASTER]   Superagent (depth 1): ${superagentModel}`,
                `[MASTER]   Subagent (depth 2): ${subagentModel}`
              );

              for (const [key, val] of Object.entries(process.env)) {
                if (val && key.startsWith("MODEL_MULTI_SUBAGENT_")) {
                  const name = key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase();
                  if (!updatedLogs.some(log => log.includes(`Subagent "${name}":`))) {
                    updatedLogs.push(`[MASTER]   Subagent "${name}": ${val}`);
                  }
                }
              }
            }

            setMasterLogs((prev) => [
              ...prev,
              `[SYSTEM] Model preset "${presetName}" saved & applied successfully!`,
              `[MASTER] Context Limit: ${limit.toLocaleString()} tokens`,
              `[MASTER] Saved to: ${savedPath}`,
              `[MASTER] Applied to: ${envPath}`,
              ...updatedLogs
            ].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to save/apply model preset: ${err.message}`].slice(-500));
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        if (value.includes("Cancel")) {
          setMasterLogs((prev) => [...prev, `[SYSTEM] Preset configuration cancelled.`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        let tier = "";
        if (value.includes("Master Agent")) tier = "master";
        else if (value.includes("Superagent")) tier = "superagent";
        else if (value.includes("depth 2")) tier = "subagent";
        else if (value.includes("researcher")) tier = "researcher";
        else if (value.includes("coder")) tier = "coder";
        else if (value.includes("reviewer")) tier = "reviewer";
        else if (value.includes("Default Model")) tier = "default";

        if (!tier) return;

        const nextStep = activeWizard.step === 22 ? 23 : 33;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...activeWizard.data, tier },
        });

        setWizardOptions([
          "1. OpenRouter (Recommended)",
          "2. OpenAI",
          "3. Anthropic",
          "4. Custom Endpoint",
          "5. Not Set (Clear Override)",
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 23 || activeWizard.step === 33) {
        if (value === "< Back") {
          const nextStep = activeWizard.step === 23 ? 22 : 32;
          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data },
          });
          const models: Record<string, string> = activeWizard.data.presetModels ? JSON.parse(activeWizard.data.presetModels) : {};
          setWizardOptions(getPresetOptionsList(models));
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (value.toLowerCase().includes("not set") || value === "5") {
          const tier = activeWizard.data.tier || "";
          const presetModels: Record<string, string> = activeWizard.data.presetModels ? JSON.parse(activeWizard.data.presetModels) : {};
          if (tier === "master") {
            delete presetModels.MODEL_MULTI_MASTER;
          } else if (tier === "superagent") {
            if (isMulti) { delete presetModels.MODEL_MULTI_SUPERAGENT; } else { delete presetModels.MODEL_SINGLE_SUPERAGENT; }
          } else if (tier === "subagent") {
            if (isMulti) { delete presetModels.MODEL_MULTI_SUBAGENT; } else { delete presetModels.MODEL_SINGLE_SUBAGENT; }
          } else if (tier === "researcher") {
            if (isMulti) { delete presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER; } else { delete presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER; }
          } else if (tier === "coder") {
            if (isMulti) { delete presetModels.MODEL_MULTI_SUBAGENT_CODER; } else { delete presetModels.MODEL_SINGLE_SUBAGENT_CODER; }
          } else if (tier === "reviewer") {
            if (isMulti) { delete presetModels.MODEL_MULTI_SUBAGENT_REVIEWER; } else { delete presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER; }
          }

          const nextStep = activeWizard.step === 23 ? 22 : 32;
          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data, presetModels: JSON.stringify(presetModels) },
          });

          setWizardOptions(getPresetOptionsList(presetModels));
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const choice = value.toLowerCase();
        let providerType = "";
        if (choice.includes("openrouter") || choice === "1") {
          providerType = "openrouter";
        } else if (choice.includes("openai") || choice === "2") {
          providerType = "openai";
        } else if (choice.includes("anthropic") || choice === "3") {
          providerType = "anthropic";
        } else if (choice.includes("custom") || choice === "4") {
          providerType = "custom";
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid provider type choice.`].slice(-500));
          return;
        }

        const nextStep = activeWizard.step === 23 ? 25 : 35;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...activeWizard.data, providerType },
        });

        const list = getConfiguredProviders();
        const matchingProfiles = list.filter(p => p.type === providerType);
        const profileOptions = matchingProfiles.map(p => {
          const prefix = `PROVIDER_${p.name.toUpperCase()}`;
          const apiKey = process.env[`${prefix}_API_KEY`] || "";
          const maskedKey = apiKey
            ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
            : "(no key)";
          return `${p.name} (key: ${maskedKey})`;
        });

        setWizardOptions([
          ...profileOptions,
          `+ Configure a new ${providerType} profile`,
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 25 || activeWizard.step === 35) {
        if (value === "< Back") {
          const nextStep = activeWizard.step === 25 ? 23 : 33;
          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data },
          });
          setWizardOptions([
            "1. OpenRouter (Recommended)",
            "2. OpenAI",
            "3. Anthropic",
            "4. Custom Endpoint",
            "5. Not Set (Clear Override)",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const providerType = activeWizard.data.providerType;
        if (value.startsWith("+ Configure a new")) {
          const nextModelStep = activeWizard.step === 25 ? 24 : 34;
          setActiveWizard({
            type: "model",
            step: 16,
            data: { ...activeWizard.data, isPreset: "true", returnStep: String(nextModelStep) },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Configure new profile for Preset. Please enter a profile name (alphanumeric, e.g. ${providerType}_preset):`
          ].slice(-500));
          return;
        }

        const profileName = value.split(" (key:")[0].trim();
        const list = getConfiguredProviders();
        const found = list.find(p => p.name.toLowerCase() === profileName.toLowerCase());
        
        let resolvedApiKey = "";
        let resolvedBaseUrl = "";
        if (found) {
          resolvedBaseUrl = found.baseUrl || "";
          const prefix = `PROVIDER_${found.name.toUpperCase()}`;
          resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
        }

        const nextStep = activeWizard.step === 25 ? 24 : 34;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...activeWizard.data, provider: profileName },
        });

        let initialModels: string[] = [];
        if (providerType === "openrouter") {
          initialModels = [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ];
          setWizardIsLoadingModels(true);
          const headers: Record<string, string> = {};
          if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
          fetch("https://openrouter.ai/api/v1/models", { headers })
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList = data.data.map((m: any) => m.id);
                  setWizardAllOptions([...modelsList, "< Back"]);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        } else if (providerType === "openai") {
          initialModels = [
            "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o1-preview", "o3-mini",
          ];
          if (resolvedApiKey) {
            setWizardIsLoadingModels(true);
            fetch("https://api.openai.com/v1/models", {
              headers: { Authorization: `Bearer ${resolvedApiKey}` }
            })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    setWizardAllOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "anthropic") {
          initialModels = [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ];
        } else if (providerType === "custom") {
          initialModels = [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ];
          if (resolvedBaseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
            fetch(`${resolvedBaseUrl}/models`, { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    setWizardAllOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        setWizardAllOptions([...initialModels, "< Back"]);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 24 || activeWizard.step === 34) {
        if (value === "< Back") {
          const nextStep = activeWizard.step === 24 ? 25 : 35;
          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data },
          });
          const providerType = activeWizard.data.providerType;
          const list = getConfiguredProviders();
          const matchingProfiles = list.filter(p => p.type === providerType);
          const profileOptions = matchingProfiles.map(p => {
            const prefix = `PROVIDER_${p.name.toUpperCase()}`;
            const apiKey = process.env[`${prefix}_API_KEY`] || "";
            const maskedKey = apiKey
              ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
              : "(no key)";
            return `${p.name} (key: ${maskedKey})`;
          });
          setWizardOptions([
            ...profileOptions,
            `+ Configure a new ${providerType} profile`,
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const modelName = value;
        const profileName = activeWizard.data.provider || "";
        const tier = activeWizard.data.tier || "";
        
        const activeProvider = process.env.ACTIVE_PROVIDER || "";
        const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
          ? `${profileName.toLowerCase()}:${modelName}`
          : modelName;

        const presetModels: Record<string, string> = activeWizard.data.presetModels ? JSON.parse(activeWizard.data.presetModels) : {};

        if (tier === "master") {
          presetModels.MODEL_MULTI_MASTER = finalModelName;
        } else if (tier === "superagent") {
          if (isMulti) { presetModels.MODEL_MULTI_SUPERAGENT = finalModelName; } else { presetModels.MODEL_SINGLE_SUPERAGENT = finalModelName; }
        } else if (tier === "subagent") {
          if (isMulti) { presetModels.MODEL_MULTI_SUBAGENT = finalModelName; } else { presetModels.MODEL_SINGLE_SUBAGENT = finalModelName; }
        } else if (tier === "researcher") {
          if (isMulti) { presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER = finalModelName; } else { presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER = finalModelName; }
        } else if (tier === "coder") {
          if (isMulti) { presetModels.MODEL_MULTI_SUBAGENT_CODER = finalModelName; } else { presetModels.MODEL_SINGLE_SUBAGENT_CODER = finalModelName; }
        } else if (tier === "reviewer") {
          if (isMulti) { presetModels.MODEL_MULTI_SUBAGENT_REVIEWER = finalModelName; } else { presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER = finalModelName; }
        } else if (tier === "default") {
          presetModels.MODEL = finalModelName;
        }

        const nextStep = activeWizard.step === 24 ? 22 : 32;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...activeWizard.data, presetModels: JSON.stringify(presetModels) },
        });

        setWizardOptions(getPresetOptionsList(presetModels));
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 30) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions([
            `1. Load/Apply Model Preset [${modeLabel}]`,
            `2. List Model Presets [${modeLabel}]`,
            `3. Create Model Preset [${modeLabel}]`,
            `4. Edit Model Preset [${modeLabel}]`,
            `5. Delete Model Preset [${modeLabel}]`,
            "6. Configure Agent Tier Models",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const choice = value;
        const name = choice.split(" - ")[0].trim();
        const presets = getModelPresets(presetMode);
        const preset = presets.find(p => p.name.toLowerCase() === name.toLowerCase());
        const models = preset ? preset.models : {};
        const desc = preset ? preset.description : "";
        setActiveWizard({
          type: "model",
          step: 31,
          data: { ...activeWizard.data, presetName: name, presetDescription: desc, presetModels: JSON.stringify(models) },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 31) {
        const desc = value.trim();
        if (desc.toLowerCase() === "< back" || desc.toLowerCase() === "back") {
          setActiveWizard({
            type: "model",
            step: 30,
            data: { ...activeWizard.data },
          });
          const presets = getModelPresets(presetMode);
          const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
          setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const updatedDesc = desc || activeWizard.data.presetDescription || "";
        const models: Record<string, string> = activeWizard.data.presetModels ? JSON.parse(activeWizard.data.presetModels) : {};
        
        setActiveWizard({
          type: "model",
          step: 32,
          data: { ...activeWizard.data, presetDescription: updatedDesc }
        });

        setWizardOptions(getPresetOptionsList(models));
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 40) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions([
            `1. Load/Apply Model Preset [${modeLabel}]`,
            `2. List Model Presets [${modeLabel}]`,
            `3. Create Model Preset [${modeLabel}]`,
            `4. Edit Model Preset [${modeLabel}]`,
            `5. Delete Model Preset [${modeLabel}]`,
            "6. Configure Agent Tier Models",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const choice = value;
        const name = choice.split(" - ")[0].trim();
        setActiveWizard({
          type: "model",
          step: 41,
          data: { ...activeWizard.data, presetName: name },
        });
        setWizardOptions(["1. Yes, delete it", "2. No, cancel"]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 41) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 40,
            data: { ...activeWizard.data },
          });
          const presets = getModelPresets(presetMode);
          const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
          setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }
        const choice = value;
        const name = activeWizard.data.presetName || "";
        const doDelete = choice.includes("Yes") || choice.includes("delete");
        if (doDelete) {
          try {
            const savedPath = deleteModelPreset(name, presetMode);
            setMasterLogs((prev) => [...prev, `[SYSTEM] Model preset "${name}" deleted successfully!\nSaved to: ${savedPath}`].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to delete model preset: ${err.message}`].slice(-500));
          }
        } else {
          setMasterLogs((prev) => [...prev, `[SYSTEM] Deletion of model preset "${name}" cancelled.`].slice(-500));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 50) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions([
            `1. Load/Apply Model Preset [${modeLabel}]`,
            `2. List Model Presets [${modeLabel}]`,
            `3. Create Model Preset [${modeLabel}]`,
            `4. Edit Model Preset [${modeLabel}]`,
            `5. Delete Model Preset [${modeLabel}]`,
            "6. Configure Agent Tier Models",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const choice = value.toLowerCase();
        let tier = "";
        if (choice.includes("master") || choice.includes("depth 0")) {
          tier = "master";
        } else if (choice.includes("superagent") || choice.includes("depth 1")) {
          tier = "superagent";
        } else if (choice.includes("subagent (depth 2)") || choice.includes("depth 2")) {
          tier = "subagent";
        } else if (choice.includes("researcher")) {
          tier = "researcher";
        } else if (choice.includes("coder")) {
          tier = "coder";
        } else if (choice.includes("reviewer")) {
          tier = "reviewer";
        } else if (choice.includes("default model")) {
          tier = "default";
        } else if (choice.includes("all tiers")) {
          tier = "all";
        } else {
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "default", "all"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "master";
        }

        setActiveWizard({
          type: "model",
          step: 2,
          data: { tier },
        });

        const list = getConfiguredProviders();
        const providerOptions = getProviderOptionsList(list);
        setWizardOptions(providerOptions);
        setWizardSelectedIndex(0);
        setQuery("");
      } else {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 2,
            data: { ...activeWizard.data },
          });
          const list = getConfiguredProviders();
          const providerOptions = getProviderOptionsList(list);
          setWizardOptions(providerOptions);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const selectedModel = value;
        const tier = activeWizard.data.tier;
        const provider = activeWizard.data.provider;

        try {
          let updates: Record<string, string> = {};
          let targetLabel = "";

          if (tier === "default") {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = provider.toLowerCase() !== activeProvider.toLowerCase()
              ? `${provider.toLowerCase()}:${selectedModel}`
              : selectedModel;
            updates = { 
              MODEL: finalModelName,
              [`PROVIDER_${provider.toUpperCase()}_MODEL`]: selectedModel
            };
            targetLabel = "Default Model";
          } else if (tier === "all") {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = provider.toLowerCase() !== activeProvider.toLowerCase()
              ? `${provider.toLowerCase()}:${selectedModel}`
              : selectedModel;
            updates = { MODEL: finalModelName };
            if (isMulti) {
              updates.MODEL_MULTI_MASTER = finalModelName;
              updates.MODEL_MULTI_SUPERAGENT = finalModelName;
              updates.MODEL_MULTI_SUBAGENT = finalModelName;
              updates.MODEL_MULTI_SUBAGENT_RESEARCHER = finalModelName;
              updates.MODEL_MULTI_SUBAGENT_CODER = finalModelName;
              updates.MODEL_MULTI_SUBAGENT_REVIEWER = finalModelName;
            } else {
              updates.MODEL_SINGLE = finalModelName;
              updates.MODEL_SINGLE_SUPERAGENT = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT_RESEARCHER = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT_CODER = finalModelName;
              updates.MODEL_SINGLE_SUBAGENT_REVIEWER = finalModelName;
            }
            targetLabel = "All Tiers & Subagents";
          } else {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = provider.toLowerCase() !== activeProvider.toLowerCase()
              ? `${provider.toLowerCase()}:${selectedModel}`
              : selectedModel;

            if (tier === "master") {
              if (isMulti) {
                updates = { MODEL_MULTI_MASTER: finalModelName };
              }
              targetLabel = "Master Agent (depth 0) Model";
            } else if (tier === "superagent") {
              if (isMulti) {
                updates = { MODEL_MULTI_SUPERAGENT: finalModelName };
              } else {
                updates = { MODEL_SINGLE_SUPERAGENT: finalModelName };
              }
              targetLabel = "Superagent (depth 1) Model";
            } else if (tier === "subagent") {
              if (isMulti) {
                updates = { MODEL_MULTI_SUBAGENT: finalModelName };
              } else {
                updates = { MODEL_SINGLE_SUBAGENT: finalModelName };
              }
              targetLabel = "Subagent (depth 2) Model";
            } else {
              const typeUpper = tier.toUpperCase();
              if (isMulti) {
                updates = { [`MODEL_MULTI_SUBAGENT_${typeUpper}`]: finalModelName };
              } else {
                updates = { [`MODEL_SINGLE_SUBAGENT_${typeUpper}`]: finalModelName };
              }
              targetLabel = `Subagent "${tier}" Model`;
            }
          }

          const envPath = updateEnvFile(updates);
          const effectiveMasterModel = isMulti ? (process.env.MODEL_MULTI_MASTER || process.env.MODEL || getDefaultModel()) : (process.env.MODEL || getDefaultModel());
          setActiveModel(effectiveMasterModel);
          const limit = getContextWindowLimit(selectedModel);
          const currentModel = process.env.MODEL || getDefaultModel();
          const masterModel = isMulti ? (process.env.MODEL_MULTI_MASTER || "(use default)") : "(N/A)";
          const superagentModel = isMulti ? (process.env.MODEL_MULTI_SUPERAGENT || "(use default)") : (process.env.MODEL_SINGLE_SUPERAGENT || "(use default)");
          const subagentModel = isMulti ? (process.env.MODEL_MULTI_SUBAGENT || "(use default)") : (process.env.MODEL_SINGLE_SUBAGENT || "(use default)");
          
          const updatedLogs = [
            `[MASTER] Updated Models:`,
            `[MASTER]   Master Agent (depth 0): ${masterModel}`,
            `[MASTER]   Superagent (depth 1): ${superagentModel}`,
            `[MASTER]   Subagent (depth 2): ${subagentModel}`,
          ];

          for (const [key, val] of Object.entries(process.env)) {
            if (val && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SINGLE_SUBAGENT_"))) {
              const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
                ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
                : key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
              updatedLogs.push(`[MASTER]   Subagent "${name}": ${val}`);
            }
          }

          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] ${targetLabel} successfully changed to: ${selectedModel}`,
            `[MASTER] Context Limit: ${limit.toLocaleString()} tokens`,
            `[MASTER] Saved to: ${envPath}`,
            ...updatedLogs
          ].slice(-500));
          
          if (tier === "default") {
            fetchAndCacheModels().catch(() => {});
          }
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to set model: ${err.message}`].slice(-500));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
        setQuery("");
      }
    } else if (activeWizard.type === "resume") {
      const chosen = cachedSessions[wizardSelectedIndex];
      if (!chosen) return;
      try {
        await agent.loadHistoryFromPath(chosen.filePath);
        const msgs = agent.getHistory().getMessages();
        const loadedLogs: string[] = [];
        for (const m of msgs) {
          if (m.role === "user") {
            const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
            if (skillPrefixMatch) {
              loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
            } else {
              loadedLogs.push(`[USER] ${m.content}`);
            }
          } else if (m.role === "assistant") {
            if (m.content) {
              loadedLogs.push(`[AGENT] ${m.content}`);
            }
          } else if (m.role === "system") {
            if (m.content && m.content.startsWith("[ERROR]")) {
              loadedLogs.push(m.content);
            } else if (m.content) {
              loadedLogs.push(`[MASTER] ${m.content}`);
            }
          }
        }
        setMasterLogs(loadedLogs.slice(-500));
        setMasterLogs((prev) => [...prev, `[MASTER] Successfully resumed session: ${chosen.displayName}`].slice(-500));
      } catch (err: any) {
        setMasterLogs((prev) => [...prev, `[ERROR] Failed to resume session: ${err.message}`].slice(-500));
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (activeWizard.type === "skills") {
      if (activeWizard.step === 1) {
        setActiveWizard({
          type: "skills",
          step: 2,
          data: { skillIndex: String(wizardSelectedIndex) },
        });
        setWizardOptions([
          "✓ Use / Activate Skill",
          "ℹ View Details",
          "← Back to List",
        ]);
        setWizardSelectedIndex(0);
      } else {
        const skillIndex = parseInt(activeWizard.data.skillIndex || "0", 10);
        const skillsList = getInstalledSkills();
        const chosen = skillsList[skillIndex];
        if (!chosen) return;

        if (wizardSelectedIndex === 0) {
          // Use / Activate Skill
          const slug = chosen.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
          setMasterLogs((prev) => [...prev, `[USER] 🛠️ [SKILL USE] ${chosen.name} (${chosen.path})`, `[MASTER] Activating skill "${chosen.name}"...\nInstruction path: ${chosen.path}`].slice(-500));
          setIsProcessing(true);
          agent.sendMessage(
            `I would like you to use the following skill: "${chosen.name}".\nPlease read its instruction file at "${chosen.path}" using a file read tool first, and then help me with my request based on its instructions.`
          ).then(() => {
            setIsProcessing(false);
          }).catch((err: any) => {
            setIsProcessing(false);
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to send message: ${err.message}`].slice(-500));
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        } else if (wizardSelectedIndex === 1) {
          // View Details
          setMasterLogs((prev) => [
            ...prev,
            `[MASTER] Skill Details: ${chosen.name}`,
            `[MASTER] Description: ${chosen.description}`,
            `[MASTER] Path: ${chosen.path}`
          ].slice(-500));
        } else {
          // Back to List
          const options = skillsList.map((s) => `• ${s.name} - ${s.description.slice(0, 50)}${s.description.length > 50 ? "..." : ""}`);
          setActiveWizard({
            type: "skills",
            step: 1,
            data: {},
          });
          setWizardOptions(options);
          setWizardSelectedIndex(skillIndex);
        }
      }
    } else if (activeWizard.type === "checkpoint") {
      if (activeWizard.step === 1) {
        const chosen = checkpointsList[wizardSelectedIndex];
        if (!chosen) return;

        if (chosen.gitSha) {
          setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(wizardSelectedIndex) } });
          setWizardOptions(["✓ Ya, pulihkan workspace ke commit ini (git stash & checkout)", "✗ Tidak, hanya pulihkan riwayat percakapan saja"]);
          setWizardSelectedIndex(0);
          return;
        }

        const sessionPath = agent.getCurrentHistoryFilePath();
        if (!sessionPath) return;
        const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
        const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

        restoreCheckpoint(chkPath, sessionPath)
          .then(async () => {
            await agent.loadHistoryFromPath(sessionPath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") {
                const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${m.content}`);
                }
              } else if (m.role === "assistant" && m.content) {
                loadedLogs.push(`[AGENT] ${m.content}`);
              } else if (m.role === "system") {
                if (m.content && m.content.startsWith("[ERROR]")) {
                  loadedLogs.push(m.content);
                } else if (m.content) {
                  loadedLogs.push(`[MASTER] ${m.content}`);
                }
              }
            }
            setMasterLogs(loadedLogs.slice(-500));
            setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" successfully restored! (${chosen.messages.length} messages)`].slice(-500));
          })
          .catch((err: any) => {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore checkpoint: ${err.message}`].slice(-500));
          });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setCheckpointsList([]);
      } else if (activeWizard.step === 2) {
        if (value === "< Back") {
          setActiveWizard({ type: "checkpoint", step: 1, data: {} });
          const options = checkpointsList.map((c) => `${c.name} (${new Date(c.timestamp).toLocaleString()}) - ${c.messages.length} messages`);
          setWizardOptions(options);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }
        const chkIndex = parseInt(activeWizard.data.checkpointIndex || "0", 10);
        const chosen = checkpointsList[chkIndex];
        if (!chosen) return;
        const doGitRestore = wizardSelectedIndex === 0;
        const sessionPath = agent.getCurrentHistoryFilePath();
        if (!sessionPath) return;

        const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
        const chkPath = path.join(checkpointsDir, `checkpoint_${chosen.timestamp}.json`);

        (async () => {
          try {
            if (doGitRestore && chosen.gitSha) {
              try {
                const { execa: execaFn } = await import("execa");
                const targetCwd = agent.workingDirectory || process.cwd();
                await execaFn("git", ["stash", "--include-untracked"], { cwd: targetCwd, reject: false });
                const checkoutRes = await execaFn("git", ["checkout", chosen.gitSha], { cwd: targetCwd, reject: false });
                if (checkoutRes.failed) {
                  setMasterLogs((prev) => [...prev, `[ERROR] Git restore failed: ${checkoutRes.stderr || checkoutRes.message}. Conversation history restored anyway.`].slice(-500));
                } else {
                  setMasterLogs((prev) => [...prev, `[MASTER] Workspace restored to Git commit: ${chosen.gitSha}`].slice(-500));
                }
              } catch (gitErr: any) {
                setMasterLogs((prev) => [...prev, `[ERROR] Git restore error: ${gitErr.message}. Conversation history restored anyway.`].slice(-500));
              }
            }

            await restoreCheckpoint(chkPath, sessionPath);
            await agent.loadHistoryFromPath(sessionPath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user") {
                const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${m.content}`);
                }
              } else if (m.role === "assistant" && m.content) {
                loadedLogs.push(`[AGENT] ${m.content}`);
              } else if (m.role === "system") {
                if (m.content && m.content.startsWith("[ERROR]")) {
                  loadedLogs.push(m.content);
                } else if (m.content) {
                  loadedLogs.push(`[MASTER] ${m.content}`);
                }
              }
            }
            setMasterLogs(loadedLogs.slice(-500));
            setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" successfully restored! (${chosen.messages.length} messages)`].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore checkpoint: ${err.message}`].slice(-500));
          }
        })();

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setCheckpointsList([]);
      }
    } else if (activeWizard.type === "question") {
      if (activeWizard.step === 1) {
        const selectedOption = value;
        if (selectedOption === "Custom...") {
          setActiveWizard({
            type: "question",
            step: 2,
            data: { question: pendingQuestion?.question || "" },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (pendingQuestion) {
          pendingQuestion.resolve(selectedOption);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${selectedOption}"`].slice(-500));
        }
      } else {
        if (pendingQuestion) {
          pendingQuestion.resolve(value);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${value}"`].slice(-500));
        }
      }

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setWizardSelectedSet(new Set());
      setPendingQuestion(null);
    } else if (activeWizard.type === "plan_approve") {
      const approved = value === "Approve Plan & Proceed";
      if (approved && planState === "APPROVED") return;
      if (approved) {
        agent.approvePlan();
        setPlanState("APPROVED");
        setMasterLogs((prev) => [...prev, "✓ Implementation plan approved! Continuing with the approved plan now."].slice(-500));
        setIsProcessing(true);
        agent.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.")
          .then(() => {
            setIsProcessing(false);
          })
          .catch((err: any) => {
            setIsProcessing(false);
            setMasterLogs((prev) => [...prev, `[ERROR] Plan approval resume error: ${err.message}`].slice(-500));
          });
      } else {
        agent.planState = "IDLE";
        setPlanState("IDLE");
        setMasterLogs((prev) => [...prev, "✗ Implementation plan rejected. Please type your feedback below and press Enter to send it to the agent."].slice(-500));
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    }
  }, [
    activeWizard,
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    setMasterLogs,
    setActiveModel,
    setCurrentTask,
    setHistory,
    setHistoryIndex,
    setPlanState,
    setPendingQuestion,
    wizardSelectedIndex,
    wizardOptions,
    pendingQuestion,
    checkpointsList,
    setCheckpointsList,
    setContextLimit,
    setQuery,
    agent,
    wizardAllOptions,
    setWizardAllOptions,
    wizardIsLoadingModels,
    setWizardIsLoadingModels,
    cachedSessions,
    setIsProcessing,
  ]);

  const handleQuerySubmit = useCallback((val: string) => {
    setIsPasted(false);
    const cleanVal = val.trim();

    if (activeWizard) {
      if (activeWizard.type === "question" && activeWizard.isMultiSelect) {
        const selectedList = Array.from(wizardSelectedSet).map(idx => wizardOptions[idx]).filter(Boolean);
        const answer = selectedList.join(", ");
        if (pendingQuestion) {
          pendingQuestion.resolve(answer);
          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${answer}"`].slice(-500));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardSelectedSet(new Set());
        setPendingQuestion(null);
        setQuery("");
        return;
      }

      let finalValue: string;
      if (cleanVal === "< Back" || cleanVal === "back") {
        finalValue = cleanVal;
      } else if (activeWizard.type === "model" && (activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 34)) {
        const lc = query.trim();
        const filteredModels = lc
          ? filterSuggestions(wizardAllOptions, lc)
          : wizardAllOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredModels.length - 1));
        finalValue = filteredModels[clampedIndex] || cleanVal;
      } else {
        const hasOptions = wizardOptions.length > 0;
        finalValue = hasOptions && wizardSelectedIndex >= 0 && wizardSelectedIndex < wizardOptions.length
          ? wizardOptions[wizardSelectedIndex]
          : cleanVal;
      }

      handleWizardSubmit(finalValue);
      setQuery("");
      return;
    }

    if (planState === "PLANNING_PENDING") {
      setWizardOptions(["Approve Plan & Proceed", "Reject Plan / Give Feedback"]);
      setWizardSelectedIndex(0);
      setActiveWizard({
        type: "plan_approve",
        step: 1,
        data: {},
      });
      setQuery("");
      return;
    }

    if (!cleanVal) return;

    setHistory((prev) => {
      if (prev.length > 0 && prev[prev.length - 1] === cleanVal) {
        return prev;
      }
      const next = [...prev, cleanVal].slice(-200);
      fs.writeFile(HISTORY_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {});
      return next;
    });
    setHistoryIndex(-1);

    const commandInput = cleanVal.startsWith("!") ? `/terminal ${cleanVal.slice(1).trim()}` : cleanVal;

    if (commandInput.startsWith("/")) {
      if (commandInput.toLowerCase().startsWith("/goal")) {
        setMasterLogs((prev) => [...prev, `[USER] ${commandInput}`, `[ERROR] /goal command is disabled in Multi-Agent Dashboard.`].slice(-500));
        setQuery("");
        return;
      }

      if (commandInput.toLowerCase().startsWith("/checkpoint")) {
        const sessionFilePath = agent.getCurrentHistoryFilePath();
        listCheckpointsForSession(sessionFilePath)
          .then((list) => {
            setCheckpointsList(list);
          })
          .catch(() => {});
      }

      handleSlashCommand(commandInput, {
        addLine: (line) => setMasterLogs((prev) => [...prev, `[${line.type.toUpperCase()}] ${line.content}`].slice(-500)),
        exit,
        agent,
        clearLines: () => {
          setMasterLogs([]);
        },
        setContextLimit,
        setActiveModel,
        setActiveWizard: (val) => {
          if (val && val.type === "goal") return;
          setActiveWizard(val);
          if (val && val.type === "resume") {
            setCachedSessions(listHistorySessions(true));
          }
        },
        setWizardOptions,
        setWizardSelectedIndex,
        setPlanState,
        setGoalMode: () => {},
        setIsProcessing: () => {},
        resumeSession: async () => {},
        resumeFromPath: async (filePath: string) => {
          try {
            await agent.loadHistoryFromPath(filePath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              if (m.role === "user" && m.content) {
                const skillPrefixMatch = m.content.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${m.content}`);
                }
              } else if (m.role === "assistant") {
                if (m.content) {
                  loadedLogs.push(`[AGENT] ${m.content}`);
                }
              } else if (m.role === "system") {
                if (m.content && m.content.startsWith("[ERROR]")) {
                  loadedLogs.push(m.content);
                } else if (m.content) {
                  loadedLogs.push(`[MASTER] ${m.content}`);
                }
              }
            }
            setMasterLogs(loadedLogs.slice(-500));
            setMasterLogs((prev) => [...prev, `[MASTER] Successfully loaded session history from: ${filePath}`].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to load session from path: ${err.message}`].slice(-500));
          }
        }
      });
      setQuery("");
      return;
    }

    setMasterLogs((prev) => [...prev, `[USER] ${commandInput}`].slice(-500));
    setQuery("");
    setCurrentTask(commandInput);

    setIsProcessing(true);
    agent.sendMessage(commandInput)
      .then(() => {
        setIsProcessing(false);
        setCurrentTask(`Idle - Completed: ${commandInput}`);
      })
      .catch((err) => {
        setIsProcessing(false);
        setCurrentTask(`Error: ${err.message || err}`);
        setMasterLogs((prev) => [...prev, `[ERROR] ${err.message || err}`].slice(-500));
      });
  }, [
    activeWizard,
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    wizardSelectedSet,
    setWizardSelectedSet,
    setMasterLogs,
    setActiveModel,
    setCurrentTask,
    setHistory,
    setHistoryIndex,
    setPlanState,
    pendingQuestion,
    setPendingQuestion,
    setQuery,
    query,
    wizardAllOptions,
    wizardSelectedIndex,
    wizardOptions,
    agent,
    exit,
    setContextLimit,
    setCheckpointsList,
    setIsPasted,
    HISTORY_FILE,
    handleWizardSubmit,
    setIsProcessing,
  ]);

  return {
    handleWizardSubmit,
    handleQuerySubmit,
  };
}
