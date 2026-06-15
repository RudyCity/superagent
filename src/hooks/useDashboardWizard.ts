import React, { useCallback } from "react";
import { execSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { 
  updateEnvFile, 
  switchActiveProvider, 
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
  BUILT_IN_PRESETS
} from "../core/config.js";
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
          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})`).join("\n")
          ].slice(-500));
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
            step: 6,
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
          step: 6,
          data: { provider, name: profileName, baseUrl },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 6) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = activeWizard.data.baseUrl;
        const apiKey = value.trim();

        const prefix = `PROVIDER_${profileName.toUpperCase()}`;
        const updates: Record<string, string> = {
          ACTIVE_PROVIDER: "",
          [`${prefix}_TYPE`]: provider,
          [`${prefix}_API_KEY`]: apiKey,
        };

        if (baseUrl) {
          updates[`${prefix}_BASE_URL`] = baseUrl;
        } else if (provider === "openrouter") {
          updates[`${prefix}_BASE_URL`] = "https://openrouter.ai/api/v1";
        }

        try {
          const envPath = updateEnvFile(updates);

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Successfully configured provider profile: ${profileName} (${provider})!\nSaved to: ${envPath}`
          ].slice(-500));

          if (!process.env.MODEL) {
            let defaultModel = "openai:gpt-4o";
            if (provider === "openrouter") {
              defaultModel = "openrouter:google/gemini-2.5-flash";
            } else if (provider === "anthropic") {
              defaultModel = "anthropic:claude-3-5-sonnet-20241022";
            }
            updateEnvFile({ MODEL: defaultModel });
          }

          fetchAndCacheModels()
            .then(() => {
              const effectiveMasterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
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
            `│ ✦ Provider        : ${process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai"}`,
            `│ ✦ Active Model    : ${modelName}`,
            `│ ✦ Context Limit   : ${limit.toLocaleString()} tokens`,
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
              `│ ✦ Provider        : ${process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai"}`,
              `│ ✦ Active Model    : ${modelName}`,
              `│ ✦ Context Limit   : ${limit.toLocaleString()} tokens`,
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
          const presets = getModelPresets();
          const options = presets.map(p => `${p.name} - ${p.description}`);
          setWizardOptions([...options, "< Back"]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        if (choice.includes("list") || choice === "2. list model presets") {
          const presets = getModelPresets();
          const listStr = presets.map(p => {
            const modelsStr = Object.entries(p.models).map(([k, v]) => `    - ${k}: ${v}`).join("\n");
            return `- **${p.name}**: ${p.description}\n${modelsStr}`;
          }).join("\n");
          setMasterLogs((prev) => [
            ...prev,
            `Available Model Presets:\n${listStr}`
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
          const presets = getModelPresets();
          const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
          if (customPresets.length === 0) {
            setMasterLogs((prev) => [...prev, `[ERROR] No custom presets available to edit.`].slice(-500));
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
          const presets = getModelPresets();
          const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
          if (customPresets.length === 0) {
            setMasterLogs((prev) => [...prev, `[ERROR] No custom presets available to delete.`].slice(-500));
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
          const rawMaster = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
          const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
          const rawSuperagent = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
          const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
          const rawSubagent = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
          const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
          const rawResearcher = process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "";
          const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
          const rawCoder = process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "";
          const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
          const rawReviewer = process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_REVIEWER || "";
          const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

          setActiveWizard({
            type: "model",
            step: 50,
            data: {},
          });
          setWizardOptions([
            `1. Master Agent (depth 0) (${masterModelFormatted})`,
            `2. Superagent (depth 1) (${superagentModelFormatted})`,
            `3. Subagent (depth 2) (${subagentModelFormatted})`,
            `4. Subagent: researcher (${researcherModelFormatted})`,
            `5. Subagent: coder (${coderModelFormatted})`,
            `6. Subagent: reviewer (${reviewerModelFormatted})`,
            `7. Default Model (Only set default fallback)`,
            `8. All Tiers (Overwrite All)`,
            `< Back`
          ]);
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
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "preset", "default", "all"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "master";
        }

        setActiveWizard({
          type: "model",
          step: 2,
          data: { tier },
        });

        const list = getConfiguredProviders();
        const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
        const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
        setWizardOptions(providerOptions);
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
          const rawMaster = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
          const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
          const rawSuperagent = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
          const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
          const rawSubagent = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
          const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
          const rawResearcher = process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "";
          const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
          const rawCoder = process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "";
          const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
          const rawReviewer = process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_REVIEWER || "";
          const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

          setActiveWizard({
            type: "model",
            step: 50,
            data: { ...activeWizard.data },
          });
          setWizardOptions([
            `1. Master Agent (depth 0) (${masterModelFormatted})`,
            `2. Superagent (depth 1) (${superagentModelFormatted})`,
            `3. Subagent (depth 2) (${subagentModelFormatted})`,
            `4. Subagent: researcher (${researcherModelFormatted})`,
            `5. Subagent: coder (${coderModelFormatted})`,
            `6. Subagent: reviewer (${reviewerModelFormatted})`,
            `7. Default Model (Only set default fallback)`,
            `8. All Tiers (Overwrite All)`,
            `< Back`
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const list = getConfiguredProviders();
        const cleanName = value.replace(/\s*\[Active\]\s*$/, "").split(" (")[0].trim();
        const nameWithoutNumber = cleanName.replace(/^\d+\.\s*/, "").trim();
        const found = list.find(p => p.name.toLowerCase() === nameWithoutNumber.toLowerCase());

        let providerProfileName = "";
        let providerType = "";
        let resolvedApiKey = "";
        let resolvedBaseUrl = "";

        if (found) {
          providerProfileName = found.name;
          providerType = found.type;
          resolvedBaseUrl = found.baseUrl || "";
          
          const prefix = `PROVIDER_${found.name.toUpperCase()}`;
          resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
          
          if (!resolvedApiKey) {
            if (found.name.toLowerCase() === "openai") {
              resolvedApiKey = process.env.OPENAI_API_KEY || "";
            } else if (found.name.toLowerCase() === "anthropic") {
              resolvedApiKey = process.env.ANTHROPIC_API_KEY || "";
            } else if (found.name.toLowerCase() === "openrouter") {
              resolvedApiKey = process.env.CUSTOM_API_KEY || "";
            } else if (found.type === "custom") {
              resolvedApiKey = process.env.CUSTOM_API_KEY || "";
            }
          }
          
          if (found.name.toLowerCase() === "openrouter") {
            providerType = "openrouter";
          }
        } else {
          const lowerName = nameWithoutNumber.toLowerCase();
          if (lowerName.includes("openrouter")) {
            providerProfileName = "openrouter";
            providerType = "openrouter";
            resolvedApiKey = process.env.CUSTOM_API_KEY || "";
          } else if (lowerName.includes("openai")) {
            providerProfileName = "openai";
            providerType = "openai";
            resolvedApiKey = process.env.OPENAI_API_KEY || "";
          } else if (lowerName.includes("anthropic")) {
            providerProfileName = "anthropic";
            providerType = "anthropic";
            resolvedApiKey = process.env.ANTHROPIC_API_KEY || "";
          } else if (lowerName.includes("custom")) {
            providerProfileName = "custom";
            providerType = "custom";
            resolvedBaseUrl = process.env.CUSTOM_BASE_URL || "";
            resolvedApiKey = process.env.CUSTOM_API_KEY || "";
          } else {
            providerProfileName = "openrouter";
            providerType = "openrouter";
          }
        }

        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...activeWizard.data, provider: providerProfileName },
        });

        const initialModels: string[] =
          providerType === "openrouter" ? [
            "google/gemini-2.5-flash",
            "meta-llama/llama-3.3-70b-instruct",
            "deepseek/deepseek-chat",
            "anthropic/claude-3.5-sonnet",
          ] :
          providerType === "openai" ? [
            "gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o1-preview", "o3-mini",
          ] :
          providerType === "anthropic" ? [
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ] :
          providerType === "custom" ? [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ] : [];

        setWizardAllOptions([...initialModels, "< Back"]);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");

        if (providerType === "openrouter") {
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
        } else if (providerType === "custom") {
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

        setMasterLogs((prev) => [...prev, `[MASTER] Provider profile "${providerProfileName}" selected. Choose a model below:`].slice(-500));
      } else if (activeWizard.step === 4) {
        if (value === "< Back") {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions([
            "1. Load/Apply Model Preset",
            "2. List Model Presets",
            "3. Create Model Preset",
            "4. Edit Model Preset",
            "5. Delete Model Preset",
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
          const envPath = applyModelPreset(presetName);
          const effectiveMasterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
          const limit = getContextWindowLimit(effectiveMasterModel);
          setContextLimit(limit);
          setActiveModel(effectiveMasterModel);

          const currentModel = process.env.MODEL || getDefaultModel();
          const masterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          
          const updatedLogs = [
            `[MASTER] Updated Models:`,
            `[MASTER]   Default Model: ${currentModel}`,
            `[MASTER]   Master Agent (depth 0): ${masterModel}`,
            `[MASTER]   Superagent (depth 1): ${superagentModel}`,
            `[MASTER]   Subagent (depth 2): ${subagentModel}`,
          ];

          for (const [key, val] of Object.entries(process.env)) {
            if (val && key.startsWith("MODEL_SUBAGENT_")) {
              const name = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              updatedLogs.push(`[MASTER]   Subagent "${name}": ${val}`);
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
            "1. Load/Apply Model Preset",
            "2. List Model Presets",
            "3. Create Model Preset",
            "4. Edit Model Preset",
            "5. Delete Model Preset",
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
        const formatVal = (val?: string) => val ? val : "(not set)";
        setWizardOptions([
          `1. Master Agent (depth 0) (${formatVal(undefined)})`,
          `2. Superagent (depth 1) (${formatVal(undefined)})`,
          `3. Subagent (depth 2) (${formatVal(undefined)})`,
          `4. Subagent: researcher (${formatVal(undefined)})`,
          `5. Subagent: coder (${formatVal(undefined)})`,
          `6. Subagent: reviewer (${formatVal(undefined)})`,
          `7. Default Model (Only set default fallback) (${formatVal(undefined)})`,
          "8. Save Preset & Exit",
          "9. Cancel & Exit",
          "< Back"
        ]);
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
            const savedPath = saveModelPreset(presetName, presetDescription, models);
            setMasterLogs((prev) => [...prev, `[SYSTEM] Model preset "${presetName}" saved successfully!\nSaved to: ${savedPath}`].slice(-500));
          } catch (err: any) {
            setMasterLogs((prev) => [...prev, `[ERROR] Failed to save model preset: ${err.message}`].slice(-500));
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

        const list = getConfiguredProviders();
        const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
        const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
        setWizardOptions(providerOptions);
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
          const formatVal = (val?: string) => val ? val : "(not set)";
          setWizardOptions([
            `1. Master Agent (depth 0) (${formatVal(models.MODEL_DEPTH_0 || models.MODEL_DEPT0)})`,
            `2. Superagent (depth 1) (${formatVal(models.MODEL_DEPTH_1 || models.MODEL_DEPT1)})`,
            `3. Subagent (depth 2) (${formatVal(models.MODEL_DEPTH_2 || models.MODEL_DEPT2)})`,
            `4. Subagent: researcher (${formatVal(models.MODEL_SUBAGENT_RESEARCHER || models.MODEL_RESEARCHER)})`,
            `5. Subagent: coder (${formatVal(models.MODEL_SUBAGENT_CODER || models.MODEL_CODER)})`,
            `6. Subagent: reviewer (${formatVal(models.MODEL_SUBAGENT_REVIEWER || models.MODEL_REVIEWER)})`,
            `7. Default Model (Only set default fallback) (${formatVal(models.MODEL)})`,
            "8. Save Preset & Exit",
            "9. Cancel & Exit",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const list = getConfiguredProviders();
        const cleanName = value.replace(/\s*\[Active\]\s*$/, "").split(" (")[0].trim();
        const nameWithoutNumber = cleanName.replace(/^\d+\.\s*/, "").trim();
        const found = list.find(p => p.name.toLowerCase() === nameWithoutNumber.toLowerCase());

        let providerProfileName = "";
        let providerType = "";
        let resolvedApiKey = "";
        let resolvedBaseUrl = "";

        if (found) {
          providerProfileName = found.name;
          providerType = found.type;
          resolvedBaseUrl = found.baseUrl || "";
          
          const prefix = `PROVIDER_${found.name.toUpperCase()}`;
          resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
          
          if (!resolvedApiKey) {
            if (found.name.toLowerCase() === "openai") {
              resolvedApiKey = process.env.OPENAI_API_KEY || "";
            } else if (found.name.toLowerCase() === "anthropic") {
              resolvedApiKey = process.env.ANTHROPIC_API_KEY || "";
            } else if (found.name.toLowerCase() === "openrouter") {
              resolvedApiKey = process.env.CUSTOM_API_KEY || "";
            } else if (found.type === "custom") {
              resolvedApiKey = process.env.CUSTOM_API_KEY || "";
            }
          }
          
          if (found.name.toLowerCase() === "openrouter") {
            providerType = "openrouter";
          }
        } else {
          const lowerName = nameWithoutNumber.toLowerCase();
          if (lowerName.includes("openrouter")) {
            providerProfileName = "openrouter";
            providerType = "openrouter";
            resolvedApiKey = process.env.CUSTOM_API_KEY || "";
          } else if (lowerName.includes("openai")) {
            providerProfileName = "openai";
            providerType = "openai";
            resolvedApiKey = process.env.OPENAI_API_KEY || "";
          } else if (lowerName.includes("anthropic")) {
            providerProfileName = "anthropic";
            providerType = "anthropic";
            resolvedApiKey = process.env.ANTHROPIC_API_KEY || "";
          } else if (lowerName.includes("custom")) {
            providerProfileName = "custom";
            providerType = "custom";
            resolvedBaseUrl = process.env.CUSTOM_BASE_URL || "";
            resolvedApiKey = process.env.CUSTOM_API_KEY || "";
          } else {
            providerProfileName = "openrouter";
            providerType = "openrouter";
          }
        }

        const nextStep = activeWizard.step === 23 ? 24 : 34;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...activeWizard.data, provider: providerProfileName },
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
            "gpt-4o",
            "gpt-4o-mini",
            "o1",
            "o1-mini",
            "o1-preview",
            "o3-mini",
            "gpt-4-turbo",
            "gpt-4",
          ];
          if (resolvedApiKey) {
            setWizardIsLoadingModels(true);
            fetch("https://api.openai.com/v1/models", {
              headers: {
                Authorization: `Bearer ${resolvedApiKey}`
              }
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
            "deepseek-chat",
            "llama-3.3-70b-instruct",
          ];
          if (resolvedBaseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (resolvedApiKey) {
              headers["Authorization"] = `Bearer ${resolvedApiKey}`;
            }
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
          const nextStep = activeWizard.step === 24 ? 23 : 33;
          setActiveWizard({
            type: "model",
            step: nextStep,
            data: { ...activeWizard.data },
          });
          const list = getConfiguredProviders();
          const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
          const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
          setWizardOptions(providerOptions);
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
          presetModels.MODEL_DEPTH_0 = finalModelName;
          presetModels.MODEL_DEPT0 = finalModelName;
        } else if (tier === "superagent") {
          presetModels.MODEL_DEPTH_1 = finalModelName;
          presetModels.MODEL_DEPT1 = finalModelName;
        } else if (tier === "subagent") {
          presetModels.MODEL_DEPTH_2 = finalModelName;
          presetModels.MODEL_DEPT2 = finalModelName;
        } else if (tier === "researcher") {
          presetModels.MODEL_SUBAGENT_RESEARCHER = finalModelName;
          presetModels.MODEL_RESEARCHER = finalModelName;
        } else if (tier === "coder") {
          presetModels.MODEL_SUBAGENT_CODER = finalModelName;
          presetModels.MODEL_CODER = finalModelName;
        } else if (tier === "reviewer") {
          presetModels.MODEL_SUBAGENT_REVIEWER = finalModelName;
          presetModels.MODEL_REVIEWER = finalModelName;
        } else if (tier === "default") {
          presetModels.MODEL = finalModelName;
        }

        const nextStep = activeWizard.step === 24 ? 22 : 32;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...activeWizard.data, presetModels: JSON.stringify(presetModels) },
        });

        const formatVal = (val?: string) => val ? val : "(not set)";
        setWizardOptions([
          `1. Master Agent (depth 0) (${formatVal(presetModels.MODEL_DEPTH_0 || presetModels.MODEL_DEPT0)})`,
          `2. Superagent (depth 1) (${formatVal(presetModels.MODEL_DEPTH_1 || presetModels.MODEL_DEPT1)})`,
          `3. Subagent (depth 2) (${formatVal(presetModels.MODEL_DEPTH_2 || presetModels.MODEL_DEPT2)})`,
          `4. Subagent: researcher (${formatVal(presetModels.MODEL_SUBAGENT_RESEARCHER || presetModels.MODEL_RESEARCHER)})`,
          `5. Subagent: coder (${formatVal(presetModels.MODEL_SUBAGENT_CODER || presetModels.MODEL_CODER)})`,
          `6. Subagent: reviewer (${formatVal(presetModels.MODEL_SUBAGENT_REVIEWER || presetModels.MODEL_REVIEWER)})`,
          `7. Default Model (Only set default fallback) (${formatVal(presetModels.MODEL)})`,
          "8. Save Preset & Exit",
          "9. Cancel & Exit",
          "< Back"
        ]);
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
            "1. Load/Apply Model Preset",
            "2. List Model Presets",
            "3. Create Model Preset",
            "4. Edit Model Preset",
            "5. Delete Model Preset",
            "6. Configure Agent Tier Models",
            "< Back"
          ]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const choice = value;
        const name = choice.split(" - ")[0].trim();
        const presets = getModelPresets();
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
          const presets = getModelPresets();
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

        const formatModel = (val: string) => val ? val : "(not set)";
        setWizardOptions([
          `1. Master Agent (depth 0) (${formatModel(models.MODEL_DEPTH_0 || models.MODEL_DEPT0)})`,
          `2. Superagent (depth 1) (${formatModel(models.MODEL_DEPTH_1 || models.MODEL_DEPT1)})`,
          `3. Subagent (depth 2) (${formatModel(models.MODEL_DEPTH_2 || models.MODEL_DEPT2)})`,
          `4. Subagent: researcher (${formatModel(models.MODEL_SUBAGENT_RESEARCHER || models.MODEL_RESEARCHER)})`,
          `5. Subagent: coder (${formatModel(models.MODEL_SUBAGENT_CODER || models.MODEL_CODER)})`,
          `6. Subagent: reviewer (${formatModel(models.MODEL_SUBAGENT_REVIEWER || models.MODEL_REVIEWER)})`,
          `7. Default Model (Only set default fallback) (${formatModel(models.MODEL)})`,
          "8. Save Preset & Exit",
          "9. Cancel & Exit",
          "< Back"
        ]);
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
            "1. Load/Apply Model Preset",
            "2. List Model Presets",
            "3. Create Model Preset",
            "4. Edit Model Preset",
            "5. Delete Model Preset",
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
          const presets = getModelPresets();
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
            const savedPath = deleteModelPreset(name);
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
            "1. Load/Apply Model Preset",
            "2. List Model Presets",
            "3. Create Model Preset",
            "4. Edit Model Preset",
            "5. Delete Model Preset",
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
        const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
        const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
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
          const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
          const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
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
            updates = {
              MODEL: finalModelName,
              MODEL_DEPTH_0: finalModelName,
              MODEL_DEPT0: finalModelName,
              MODEL_DEPTH_1: finalModelName,
              MODEL_DEPT1: finalModelName,
              MODEL_DEPTH_2: finalModelName,
              MODEL_DEPT2: finalModelName,
              MODEL_SUBAGENT_RESEARCHER: finalModelName,
              MODEL_RESEARCHER: finalModelName,
              MODEL_SUBAGENT_CODER: finalModelName,
              MODEL_CODER: finalModelName,
              MODEL_SUBAGENT_REVIEWER: finalModelName,
              MODEL_REVIEWER: finalModelName
            };
            targetLabel = "All Tiers & Subagents";
          } else {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = provider.toLowerCase() !== activeProvider.toLowerCase()
              ? `${provider.toLowerCase()}:${selectedModel}`
              : selectedModel;

            if (tier === "master") {
              updates = { MODEL_DEPTH_0: finalModelName, MODEL_DEPT0: finalModelName };
              targetLabel = "Master Agent (depth 0) Model";
            } else if (tier === "superagent") {
              updates = { MODEL_DEPTH_1: finalModelName, MODEL_DEPT1: finalModelName };
              targetLabel = "Superagent (depth 1) Model";
            } else if (tier === "subagent") {
              updates = { MODEL_DEPTH_2: finalModelName, MODEL_DEPT2: finalModelName };
              targetLabel = "Subagent (depth 2) Model";
            } else {
              const typeUpper = tier.toUpperCase();
              updates = {
                [`MODEL_SUBAGENT_${typeUpper}`]: finalModelName,
                [`MODEL_${typeUpper}`]: finalModelName
              };
              targetLabel = `Subagent "${tier}" Model`;
            }
          }

          const envPath = updateEnvFile(updates);
          const effectiveMasterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
          setActiveModel(effectiveMasterModel);
          const limit = getContextWindowLimit(selectedModel);
          const currentModel = process.env.MODEL || getDefaultModel();
          const masterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          
          const updatedLogs = [
            `[MASTER] Updated Models:`,
            `[MASTER]   Default Model: ${currentModel}`,
            `[MASTER]   Master Agent (depth 0): ${masterModel}`,
            `[MASTER]   Superagent (depth 1): ${superagentModel}`,
            `[MASTER]   Subagent (depth 2): ${subagentModel}`,
          ];

          for (const [key, val] of Object.entries(process.env)) {
            if (val && key.startsWith("MODEL_SUBAGENT_")) {
              const name = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
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
      } else if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 24 || activeWizard.step === 34)) {
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
