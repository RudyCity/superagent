import { useCallback } from "react";
import path from "path";
import fs from "fs/promises";
import { getConfiguredProviders, switchActiveProvider, fetchAndCacheModels, getContextWindowLimit, updateEnvFile, getInstalledSkills, getModelPresets, applyModelPreset, saveModelPreset, deleteModelPreset, BUILT_IN_PRESETS } from "../core/config.js";
import { getDefaultModel } from "../core/slash-commands.js";
import { allTools } from "../core/tools.js";
import { createCheckpoint, type Checkpoint } from "../core/checkpoints.js";
import type { ChatLine } from "../core/slash-commands.js";
import type { ToolCall } from "../core/conversation.js";
import type { Agent } from "../core/agent.js";

export interface WizardSubmitContext {
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
  } | null;
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  wizardOptions: string[];
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  wizardSelectedIndex: number;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  setWizardSelectedSet: React.Dispatch<React.SetStateAction<Set<number>>>;
  setCheckpointsList: React.Dispatch<React.SetStateAction<Checkpoint[]>>;
  addLine: (line: ChatLine) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  isProcessing: boolean;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  setPlanState: React.Dispatch<React.SetStateAction<any>>;
  setGoalMode: React.Dispatch<React.SetStateAction<any>>;
  agentRef: React.MutableRefObject<Agent | null>;
  pendingPermission: {
    toolCall: ToolCall;
    description: string;
    resolve: (value: boolean) => void;
  } | null;
  setPendingPermission: React.Dispatch<React.SetStateAction<any>>;
  pendingQuestion: {
    question: string;
    options: string[];
    resolve: (value: string) => void;
  } | null;
  setPendingQuestion: React.Dispatch<React.SetStateAction<any>>;
  wizardIsLoadingModels: boolean;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  planState: string;
  streamBufferRef: React.MutableRefObject<string>;
  setStreamDisplay: React.Dispatch<React.SetStateAction<string>>;
}

export function useWizardSubmit(ctx: WizardSubmitContext) {
  const {
    activeWizard,
    setActiveWizard,
    wizardOptions,
    setWizardOptions,
    wizardSelectedIndex,
    setWizardSelectedIndex,
    setWizardSelectedSet,
    setCheckpointsList,
    addLine,
    setInput,
    setIsProcessing,
    setContextLimit,
    setActiveModel,
    setPlanState,
    setGoalMode,
    agentRef,
    pendingPermission,
    setPendingPermission,
    pendingQuestion,
    setPendingQuestion,
    wizardIsLoadingModels,
    setWizardIsLoadingModels,
    planState,
    streamBufferRef,
    setStreamDisplay,
  } = ctx;

  const handleWizardSubmit = useCallback((value: string) => {
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
        } else if (choice.includes("switch") || choice === "2") {
          const list = getConfiguredProviders();
          const options = list.map(p => `${p.name} (${p.type})${p.isActive ? " [Active]" : ""}`);
          setActiveWizard({
            type: "login",
            step: 5,
            data: {},
          });
          setWizardOptions(options);
          setWizardSelectedIndex(0);
        } else {
          const list = getConfiguredProviders();
          addLine({
            type: "system",
            content: `Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})${p.isActive ? " [Active]" : ""}`).join("\n"),
            timestamp: now,
          });
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
          addLine({
            type: "error",
            content: "Invalid choice. Please select 1, 2, 3, or 4.",
            timestamp: now,
          });
          return;
        }

        addLine({
          type: "system",
          content: `Selected provider type: ${provider}\nStep 3: Enter config profile name (e.g. ${provider}, deepseek, or press Enter for default):`,
          timestamp: now,
        });

        setActiveWizard({
          type: "login",
          step: 3,
          data: { provider },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 3) {
        const provider = activeWizard.data.provider;
        const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
        const profileName = nameInput || provider;

        if (provider === "custom") {
          addLine({
            type: "system",
            content: `Config Name: ${profileName}\nStep 4: Please enter your Base URL (e.g. http://localhost:11434/v1):`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 4,
            data: { provider, name: profileName },
          });
          setInput("");
        } else {
          addLine({
            type: "system",
            content: `Config Name: ${profileName}\nStep 6: Please enter your API Key:`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 6,
            data: { provider, name: profileName },
          });
          setInput("");
        }
      } else if (activeWizard.step === 4) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = value.trim();

        addLine({
          type: "system",
          content: `Entered Base URL: ${baseUrl}\nStep 6: Please enter your API Key:`,
          timestamp: now,
        });
        setActiveWizard({
          type: "login",
          step: 6,
          data: { provider, name: profileName, baseUrl },
        });
        setInput("");
      } else if (activeWizard.step === 5) {
        const list = getConfiguredProviders();
        const chosen = list.find(p => p.name.toLowerCase() === value.toLowerCase());
        if (chosen) {
          try {
            const envPath = switchActiveProvider(chosen.name);
            addLine({
              type: "system",
              content: `Switched active provider to: ${chosen.name}\nSaved to: ${envPath}`,
              timestamp: now,
            });
            fetchAndCacheModels()
              .then(() => {
                const currentModel = process.env.MODEL || getDefaultModel();
                const limit = getContextWindowLimit(currentModel);
                setContextLimit(limit);
                setActiveModel(currentModel);
              })
              .catch(() => {});
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to switch provider: ${err.message}`,
              timestamp: now,
            });
          }
        } else {
          addLine({
            type: "error",
            content: `Provider "${value}" not found in configured list.`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 6) {
        const provider = activeWizard.data.provider;
        const profileName = activeWizard.data.name;
        const baseUrl = activeWizard.data.baseUrl;
        const apiKey = value;

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

          addLine({
            type: "system",
            content: `Successfully configured and activated provider profile: ${profileName} (${provider})!\nSaved to: ${envPath}`,
            timestamp: now,
          });

          if (provider === "openrouter" && !process.env.MODEL) {
            updateEnvFile({ MODEL: "google/gemini-2.5-flash" });
          }

          fetchAndCacheModels()
            .then(() => {
              const currentModel = process.env.MODEL || getDefaultModel();
              const limit = getContextWindowLimit(currentModel);
              setContextLimit(limit);
              setActiveModel(currentModel);
            })
            .catch(() => {});
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to save credentials: ${err.message}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 10) {
        const choice = value.toLowerCase();
        if (choice.includes("ask ai") || choice.startsWith("6")) {
          addLine({
            type: "system",
            content: `Selected AI-Assisted Initialization.\nStep 13: Briefly describe what you want to build (e.g. "A simple markdown parser command line tool in TypeScript"):`,
            timestamp: now,
          });
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

          addLine({
            type: "system",
            content: `Selected Stack: ${stack}\nStep 11: Enter Project Name (or press Enter for default "${path.basename(process.cwd())}"):`,
            timestamp: now,
          });
          setActiveWizard({
            type: "login",
            step: 11,
            data: { ...activeWizard.data, stack },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 11) {
        const projectName = value.trim() || path.basename(process.cwd());
        addLine({
          type: "system",
          content: `Project Name: ${projectName}\nStep 12: Enter a short Project Description:`,
          timestamp: now,
        });
        setActiveWizard({
          type: "login",
          step: 12,
          data: { ...activeWizard.data, projectName },
        });
        setInput("");
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
          addLine({ type: "system", content: `📄 Generated agents.md (created: ${projectName}, ${projectTech})`, timestamp: Date.now() });

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
          addLine({ type: "system", content: auditLines.join("\n"), timestamp: Date.now() });
        })().catch(err => {
          addLine({ type: "error", content: `Failed to complete project initialization: ${err.message}`, timestamp: Date.now() });
        });

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 13) {
        const goal = value.trim();
        if (!goal) {
          addLine({ type: "error", content: "AI prompt cannot be empty. Initialization cancelled.", timestamp: now });
          setActiveWizard(null);
          return;
        }

        addLine({ type: "system", content: "🤖 Consulting AI to formulate project structure...", timestamp: now });
        setIsProcessing(true);

        (async () => {
          try {
            if (!agentRef.current) {
              throw new Error("AI Core is not initialized yet.");
            }

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
            const modelConfig = (agentRef.current as any).getModel();
            
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
            addLine({ type: "system", content: `📄 Generated agents.md successfully!`, timestamp: Date.now() });

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
            addLine({ type: "system", content: auditLines.join("\n"), timestamp: Date.now() });

          } catch (aiErr: any) {
            addLine({ type: "error", content: `AI code completion request failed: ${aiErr.message}. Falling back to default project structure.`, timestamp: Date.now() });
            
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
            setIsProcessing(false);
          }
        })();

        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (activeWizard.type === "model") {
      if (activeWizard.step === 1) {
        const choice = value.toLowerCase();
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
        } else if (choice.includes("all")) {
          tier = "all";
        } else {
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "all"];
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
        setWizardOptions(options.length > 0 ? options : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
        setWizardSelectedIndex(0);
        setInput("");
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
          const rawSuperagent = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPTH_1 || "";
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
          setInput("");
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
                  setWizardOptions([...modelsList, "< Back"]);
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
                    setWizardOptions([...modelsList, "< Back"]);
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
                    setWizardOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        setWizardOptions([...initialModels, "< Back"]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 4) {
        const presetChoice = value;
        const presetName = presetChoice.split(" - ")[0].trim();
        try {
          const envPath = applyModelPreset(presetName);
          const nextActiveModel = process.env.MODEL || getDefaultModel();
          const limit = getContextWindowLimit(nextActiveModel);
          setContextLimit(limit);
          setActiveModel(nextActiveModel);

          const currentModel = process.env.MODEL || getDefaultModel();
          const masterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          
          let updatedList = `\n\nUpdated Models:\n` +
            `  Default Model: ${currentModel}\n` +
            `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          for (const [key, val] of Object.entries(process.env)) {
            if (val && key.startsWith("MODEL_SUBAGENT_")) {
              const name = key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              updatedList += `\n  Subagent "${name}": ${val}`;
            }
          }

          addLine({
            type: "system",
            content: `Model preset "${presetName}" applied successfully!\nSaved to: ${envPath}${updatedList}`,
            timestamp: now,
          });
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to apply model preset: ${err.message}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardIsLoadingModels(false);
      } else if (activeWizard.step === 20) {
        const name = value.trim();
        if (!name) {
          addLine({
            type: "error",
            content: "Preset name cannot be empty.",
            timestamp: now,
          });
          return;
        }
        if (BUILT_IN_PRESETS.some(bp => bp.name === name.toLowerCase())) {
          addLine({
            type: "error",
            content: `Cannot overwrite built-in preset "${name}".`,
            timestamp: now,
          });
          return;
        }
        setActiveWizard({
          type: "model",
          step: 21,
          data: { ...activeWizard.data, presetName: name },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 21) {
        const desc = value.trim();
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
          "9. Cancel & Exit"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 22 || activeWizard.step === 32) {
        const models: Record<string, string> = activeWizard.data.presetModels ? JSON.parse(activeWizard.data.presetModels) : {};
        if (value.includes("Save Preset")) {
          const presetName = activeWizard.data.presetName || "";
          const presetDescription = activeWizard.data.presetDescription || "";
          try {
            const savedPath = saveModelPreset(presetName, presetDescription, models);
            addLine({
              type: "system",
              content: `Model preset "${presetName}" saved successfully!\nSaved to: ${savedPath}`,
              timestamp: now,
            });
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to save model preset: ${err.message}`,
              timestamp: now,
            });
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        if (value.includes("Cancel")) {
          addLine({
            type: "system",
            content: `Preset configuration cancelled.`,
            timestamp: now,
          });
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
        setInput("");
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
            "9. Cancel & Exit"
          ]);
          setWizardSelectedIndex(0);
          setInput("");
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
                  setWizardOptions([...modelsList, "< Back"]);
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
                    setWizardOptions([...modelsList, "< Back"]);
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
                    setWizardOptions([...modelsList, "< Back"]);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        setWizardOptions([...initialModels, "< Back"]);
        setWizardSelectedIndex(0);
        setInput("");
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
          setInput("");
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
          "9. Cancel & Exit"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 30) {
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
        setInput("");
      } else if (activeWizard.step === 31) {
        const desc = value.trim();
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
          "9. Cancel & Exit"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 40) {
        const choice = value;
        const name = choice.split(" - ")[0].trim();
        setActiveWizard({
          type: "model",
          step: 41,
          data: { ...activeWizard.data, presetName: name },
        });
        setWizardOptions(["1. Yes, delete it", "2. No, cancel"]);
        setWizardSelectedIndex(0);
        setInput("");
      } else if (activeWizard.step === 41) {
        const choice = value;
        const name = activeWizard.data.presetName || "";
        const doDelete = choice.includes("Yes") || choice.includes("delete");
        if (doDelete) {
          try {
            const savedPath = deleteModelPreset(name);
            addLine({
              type: "system",
              content: `Model preset "${name}" deleted successfully!\nSaved to: ${savedPath}`,
              timestamp: now,
            });
          } catch (err: any) {
            addLine({
              type: "error",
              content: `Failed to delete model preset: ${err.message}`,
              timestamp: now,
            });
          }
        } else {
          addLine({
            type: "system",
            content: `Deletion of model preset "${name}" cancelled.`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
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
          setInput("");
          return;
        }

        const modelName = value;
        try {
          const profileName = activeWizard.data.provider;
          const tier = activeWizard.data.tier;
          let updates: Record<string, string> = {};

          let envPath = "";
          let targetLabel = "";
          if (tier === "default") {
            envPath = switchActiveProvider(profileName);
            updateEnvFile({ 
              MODEL: modelName,
              [`PROVIDER_${profileName.toUpperCase()}_MODEL`]: modelName
            });
            targetLabel = "Default Model";
          } else if (tier === "all") {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
              ? `${profileName.toLowerCase()}:${modelName}`
              : modelName;
            updates = {
              MODEL: modelName,
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
            envPath = switchActiveProvider(profileName);
            updateEnvFile(updates);
          } else {
            const activeProvider = process.env.ACTIVE_PROVIDER || "";
            const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
              ? `${profileName.toLowerCase()}:${modelName}`
              : modelName;
            
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
            envPath = updateEnvFile(updates);
          }

          const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
          const limit = getContextWindowLimit(cleanModelName);
          
          const effectiveMasterModel = process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel();
          const cleanMasterModel = effectiveMasterModel.includes(":") ? effectiveMasterModel.substring(effectiveMasterModel.indexOf(":") + 1) : effectiveMasterModel;
          const newLimit = getContextWindowLimit(cleanMasterModel);
          setContextLimit(newLimit);
          setActiveModel(effectiveMasterModel);
          
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

          addLine({
            type: "system",
            content: `${targetLabel} successfully changed to: ${modelName} (via provider ${profileName})\nContext limit: ${limit.toLocaleString()} tokens\nSaved to: ${envPath}${updatedList}`,
            timestamp: now,
          });
          
          if (tier === "default" || tier === "all") {
            fetchAndCacheModels()
              .then(() => {
                const newLimit = getContextWindowLimit(cleanModelName);
                setContextLimit(newLimit);
              })
              .catch(() => {});
          }
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to set model: ${err.message}`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardIsLoadingModels(false);
      }
    } else if (activeWizard.type === "plan_approve") {
      const approved = value === "approve";
      // Guard: skip if already approved (prevent double-fire from useInput + TextInput.onSubmit)
      if (approved && planState === "APPROVED") return;
      if (approved) {
        if (agentRef.current) {
          agentRef.current.approvePlan();
          setPlanState("APPROVED");
          setIsProcessing(true);
          streamBufferRef.current = "";
          setStreamDisplay("");
          agentRef.current.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.").catch((err: any) => {
            setIsProcessing(false);
            addLine({ type: "error", content: `Plan approval resume error: ${err.message}`, timestamp: Date.now() });
          });
        }
        addLine({
          type: "system",
          content: "✓ Implementation plan approved! Continuing with the approved plan now.",
          timestamp: now,
        });
      } else {
        if (agentRef.current) {
          agentRef.current.planState = "IDLE";
          setPlanState("IDLE");
        }
        addLine({
          type: "system",
          content: "✗ Implementation plan rejected. Please type your feedback below and press Enter to send it to the agent.",
          timestamp: now,
        });
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (activeWizard.type === "question") {
      if (pendingQuestion) {
        pendingQuestion.resolve(value);
        addLine({
          type: "system",
          content: `❓ Answered: "${value}"`,
          timestamp: now,
        });
        setPendingQuestion(null);
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (activeWizard.type === "goal") {
      // User typed their goal in the wizard dialog
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      if (!value.trim()) return;
      const goalArg = value.trim();
      if (agentRef.current) {
        agentRef.current.goalMode = goalArg;
      }
      setGoalMode({ goal: goalArg, startedAt: now });
      addLine({
        type: "system",
        content: [
          "🎯 GOAL MODE ACTIVATED",
          `   Objective : ${goalArg}`,
          "   Iterations: up to 200 steps (auto-continue enabled)",
          "   The agent will not stop until the goal is achieved.",
          "   Use Ctrl+C to abort at any time.",
        ].join("\n"),
        timestamp: now,
      });
      addLine({
        type: "user",
        content: `❯ /goal ${goalArg}`,
        timestamp: now,
      });
      setIsProcessing(true);
      agentRef.current?.sendMessage(
        `GOAL MODE: Your primary objective is to achieve the following goal completely and verifiably:\n\n"${goalArg}"\n\nBegin immediately. Plan thoroughly, execute step by step, verify completion, and report back with GOAL_COMPLETE or GOAL_PARTIAL.`
      ).catch((err: any) => {
        addLine({ type: "error", content: `Goal mode error: ${err.message}`, timestamp: Date.now() });
      });
    }
  }, [activeWizard, addLine, setContextLimit, setPlanState, setGoalMode, setIsProcessing, wizardSelectedIndex, wizardOptions, pendingQuestion, pendingPermission, setInput, setActiveWizard, setWizardOptions, setWizardSelectedIndex, setCheckpointsList, setPendingPermission, setPendingQuestion, setWizardIsLoadingModels, agentRef, planState, streamBufferRef, setStreamDisplay]);

  return handleWizardSubmit;
}
