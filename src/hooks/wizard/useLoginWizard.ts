import { useCallback } from "react";
import path from "path";
import fs from "fs/promises";
import { 
  getConfiguredProviders, 
  switchActiveProvider, 
  fetchAndCacheModels, 
  getContextWindowLimit, 
  addProvider,
  getActiveConfigAudit,
  getProviders,
  getCachedModelIds,
  getEffectiveMasterModel,
  getModelInstanceForString,
  getSettings,
  removeProvider,
  setAllTierModels
} from "../../core/config.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import { allTools } from "../../core/tools.js";
import type { Agent } from "../../core/agent.js";
import type { ChatLine } from "../../core/slash-commands.js";
import { resolveProviderType, buildProviderOptions, getModelOptions, resolveTestModel, resolveTestModelAsync, fetchModelsFromEndpoint, checkEndpointCompatibility, testCustomProviderMessage, fetchModelsForProvider, getFallbackModels, PROVIDER_TEMPLATE_LABELS, PROVIDER_DEFAULT_BASE_URLS } from "../../core/loginWizardLogic.js";
import {
  handleDeleteProviderStep14,
  handleDeleteProviderStep15,
  handleEditProviderStep17,
  handleEditProviderStep18,
  handleEditProviderStep19,
} from "./loginWizardProviderCrud.js";

interface LoginWizardContext {
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  addLine: (line: ChatLine) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setIsProcessing: React.Dispatch<React.SetStateAction<boolean>>;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  agentRef: React.MutableRefObject<Agent | null>;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
}

export function useLoginWizard(ctx: LoginWizardContext) {
  const {
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    addLine,
    setInput,
    setIsProcessing,
    setContextLimit,
    setActiveModel,
    agentRef,
    setWizardIsLoadingModels,
  } = ctx;

  const handleLoginWizard = useCallback(async (value: string, step: number, data: Record<string, string>) => {
    const now = Date.now();

    if (step === 1) {
      const choice = value.toLowerCase();
      if (choice.includes("create") || choice === "2") {
        setActiveWizard({
          type: "login",
          step: 2,
          data: {},
        });
        setWizardOptions([...PROVIDER_TEMPLATE_LABELS]);
        setWizardSelectedIndex(0);
      } else if (choice.includes("delete") || choice.includes("remove") || choice === "3") {
        const list = getConfiguredProviders();
        if (list.length > 0) {
          setActiveWizard({ type: "login", step: 14, data: {} });
          setWizardOptions(list.map(
            (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
          ));
          setWizardSelectedIndex(0);
        } else {
          addLine({
            type: "system",
            content: `No providers configured yet.`,
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      } else if (choice.includes("edit") || choice === "4") {
        const list = getConfiguredProviders();
        if (list.length > 0) {
          setActiveWizard({ type: "login", step: 17, data: {} });
          setWizardOptions(list.map(
            (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
          ));
          setWizardSelectedIndex(0);
        } else {
          addLine({
            type: "system",
            content: `No providers configured yet.`,
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      } else {
        const list = getConfiguredProviders();
        if (list.length > 0) {
          setActiveWizard({ type: "login", step: 6, data: {} });
          setWizardOptions(list.map(
            (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
          ));
          setWizardSelectedIndex(0);
        } else {
          addLine({
            type: "system",
            content: `No providers configured yet.`,
            timestamp: now,
          });
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      }
    } else if (step === 2) {
      const provider = resolveProviderType(value);
      if (!provider) {
        addLine({
          type: "error",
          content: "Invalid choice. Please select a valid provider number.",
          timestamp: now,
        });
        return;
      }

      addLine({
        type: "system",
        content: `Selected provider type: ${provider}`,
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
    } else if (step === 3) {
      const provider = data.provider;
      const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
      const profileName = nameInput || provider;

      // Step 4 collects baseUrl for providers that need user input:
      //   - custom / custom-anthropic: always
      //   - ollama / lmstudio: localhost default but user-overridable
      //   - azure: deployment URL differs per resource
      const needsBaseUrlStep =
        provider === "custom" ||
        provider === "custom-anthropic" ||
        provider === "ollama" ||
        provider === "lmstudio" ||
        provider === "azure";

      if (needsBaseUrlStep) {
        addLine({
          type: "system",
          content: `Config Name: ${profileName}`,
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
          content: `Config Name: ${profileName}`,
          timestamp: now,
        });
        setActiveWizard({
          type: "login",
          step: 5,
          data: { provider, name: profileName },
        });
        setInput("");
      }
    } else if (step === 4) {
      const provider = data.provider;
      const profileName = data.name;
      const baseUrl = value.trim();

      // ollama / lmstudio have a sensible localhost default; the user can
      // override if their server runs on a different host/port.
      // Azure has no useful default — require an explicit URL.
      const effectiveBaseUrl =
        baseUrl ||
        (provider === "ollama" || provider === "lmstudio"
          ? PROVIDER_DEFAULT_BASE_URLS[provider] || ""
          : "");
      if (!effectiveBaseUrl) {
        addLine({
          type: "error",
          content: `Base URL is required for ${provider}. Please enter the full endpoint URL.`,
          timestamp: now,
        });
        return;
      }

      addLine({
        type: "system",
        content: `Entered Base URL: ${effectiveBaseUrl}`,
        timestamp: now,
      });
      setActiveWizard({
        type: "login",
        step: 5,
        data: { provider, name: profileName, baseUrl: effectiveBaseUrl },
      });
      setInput("");
    } else if (step === 5) {
      const provider = data.provider;
      const profileName = data.name;
      const baseUrl = data.baseUrl;
      const apiKey = value;

      // ollama / lmstudio usually run without auth; allow empty apiKey.
      // Cloud providers require a key (or Azure's resource endpoint API key).
      const isLocal = provider === "ollama" || provider === "lmstudio";
      if (!isLocal && !apiKey.trim()) {
        addLine({
          type: "error",
          content: `API key is required for ${provider}. Please paste your key.`,
          timestamp: now,
        });
        return;
      }

      const providerId = profileName.toLowerCase().replace(/[^a-z0-9_-]/g, "");

      try {
        // Save provider to JSON (model-config.json) — NOT to .env
        addProvider({
          id: providerId,
          name: profileName,
          provider: provider === "custom-anthropic" ? "anthropic" : provider,
          apiKey: apiKey,
          baseUrl: baseUrl || (PROVIDER_DEFAULT_BASE_URLS[provider as keyof typeof PROVIDER_DEFAULT_BASE_URLS] ?? undefined),
        });

        // Set this provider as active in preset JSON
        switchActiveProvider(providerId);

        // Invalidate stale tool-call-support probe cache so next run re-probes the new endpoint
        try {
          const { clearToolCallSupportCache } = await import("../../utils/promptBasedToolCalling.js");
          clearToolCallSupportCache();
        } catch {}

        const providerDefaultBase = PROVIDER_DEFAULT_BASE_URLS[provider as keyof typeof PROVIDER_DEFAULT_BASE_URLS] || "";
        const effectiveBaseUrl = baseUrl || providerDefaultBase;
        const baseUrlInfo = baseUrl ? `\nBase URL: ${baseUrl}` : (providerDefaultBase ? `\nBase URL: ${providerDefaultBase}` : "");

        addLine({
          type: "system",
          content: `Successfully configured provider profile: ${profileName} (${provider})${baseUrlInfo}\nSaved to model-config.json`,
          timestamp: now,
        });        // Transition to connection test confirmation (step 7)
        setActiveWizard({
          type: "login",
          step: 7,
          data: {
            providerId,
            providerName: profileName,
            providerType: provider,
            providerApiKey: apiKey,
            providerBaseUrl: effectiveBaseUrl,
            fromList: "false",
          },
        });
        setWizardOptions(["1. Yes, Test Connection", "2. No (Cancel Setup)"]);
        setWizardSelectedIndex(0);
        setInput("");
      } catch (err: any) {
        addLine({
          type: "error",
          content: `Failed to save credentials: ${err.message}`,
          timestamp: now,
        });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (step === 10) {
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
          data: data,
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
          data: { ...data, stack },
        });
      }
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 11) {
      const projectName = value.trim() || path.basename(process.cwd());
      addLine({
        type: "system",
        content: `Project Name: ${projectName}\nStep 12: Enter a short Project Description:`,
        timestamp: now,
      });
      setActiveWizard({
        type: "login",
        step: 12,
        data: { ...data, projectName },
      });
      setInput("");
    } else if (step === 12) {
      const projectDesc = value.trim() || "A software project.";
      const projectName = data.projectName;
      const projectTech = data.stack;
      const cwd = process.cwd();

      try {
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
        const gitStatusLabel = data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${data.gitStatus}`;
        const modelName = getEffectiveMasterModel("auto") || getDefaultModel();
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
          ...(data.gitBranch ? [`│ 🌿 Branch         : ${data.gitBranch}`] : []),
          ...(data.gitSha ? [`│ 📌 HEAD           : ${data.gitSha}`] : []),
          "│ ",
          "│ [COGNITIVE CORE]",
          getActiveConfigAudit(),
          `│ ✦ Streaming       : ${getSettings().disableStreaming ? "DISABLED" : "ENABLED"}`,
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
      } catch (err: any) {
        addLine({ type: "error", content: `Failed to complete project initialization: ${err.message}`, timestamp: Date.now() });
      }

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (step === 13) {
      const goal = value.trim();
      if (!goal) {
        addLine({ type: "error", content: "AI prompt cannot be empty. Initialization cancelled.", timestamp: now });
        setActiveWizard(null);
        return;
      }

      addLine({ type: "system", content: "🤖 Consulting AI to formulate project structure...", timestamp: now });
      setIsProcessing(true);

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
        const { rateLimiter, concurrencyLimiter } = await import("../../core/rateLimiter.js");
        const modelConfig = (agentRef.current as any).getModel();
        
        let concurrencyAcquired = false;
        let response;
        try {
          if (getSettings().concurrencyLimit === 1) {
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

        const gitStatusLabel = data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${data.gitStatus}`;
        const modelName = getEffectiveMasterModel("auto") || getDefaultModel();
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
          ...(data.gitBranch ? [`│ 🌿 Branch         : ${data.gitBranch}`] : []),
          ...(data.gitSha ? [`│ 📌 HEAD           : ${data.gitSha}`] : []),
          "│ ",
          "│ [COGNITIVE CORE]",
          getActiveConfigAudit(),
          `│ ✦ Streaming       : ${getSettings().disableStreaming ? "DISABLED" : "ENABLED"}`,
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

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (step === 6) {
      // Step 6: Select provider from list (from /login → List)
      const providers = getConfiguredProviders();
      const idx = parseInt(value, 10) - 1;
      const selectedProvider = providers[idx];
      if (!selectedProvider) {
        addLine({ type: "error", content: "Invalid provider selection.", timestamp: now });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }
      addLine({
        type: "system",
        content: `Provider selected: ${selectedProvider.name} [${selectedProvider.type}]`,
        timestamp: now,
      });
      // Activate the selected provider in ALL preset tiers (both modes)
      switchActiveProvider(selectedProvider.id);
      const selBaseUrl = selectedProvider.baseUrl || "";
      const selApiKey = selectedProvider.apiKey || "";
      const selType = selectedProvider.type || "";
      setActiveWizard({
        type: "login",
        step: 7,
        data: {
          providerId: selectedProvider.id,
          providerName: selectedProvider.name,
          providerType: selType,
          providerApiKey: selApiKey,
          providerBaseUrl: selBaseUrl,
          fromList: "true",
        },
      });
      setWizardOptions(["1. Yes, Test Connection", "2. No (Cancel Setup)"]);
      setWizardSelectedIndex(0);
    } else if (step === 7) {
      // Step 7: Confirm connection test
      const choice = value.toLowerCase();
      const cancelSetup = choice.includes("tidak") || choice.includes("no") || choice === "2" || choice.startsWith("2.");
      
      const pId = data.providerId || "";
      const pName = data.providerName || "";
      const pType = data.providerType || "";
      const pApiKey = data.providerApiKey || "";
      const pBaseUrl = data.providerBaseUrl || "";

      if (cancelSetup) {
        addLine({ type: "system", content: "Provider setup cancelled.", timestamp: now });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      // Perform connection test
      addLine({ type: "system", content: `🔄 Testing connection to ${pName}...`, timestamp: now });
      setWizardIsLoadingModels(true);
      let testPassed = false;
      let fetchedModelsList: string[] = [];

      try {
        if (pType === "custom" || pType === "custom-anthropic") {
          // Custom providers: test via models endpoint compatibility
          const endpointCheck = await checkEndpointCompatibility(pBaseUrl, pApiKey);
          if (endpointCheck.ok) {
            testPassed = true;
            fetchedModelsList = endpointCheck.models;
            addLine({
              type: "system",
              content: `✅ Connection successful! Fetched ${fetchedModelsList.length} models from custom endpoint.`,
              timestamp: Date.now(),
            });
          } else {
            addLine({
              type: "error",
              content: `❌ Connection check failed: ${endpointCheck.message || "Unknown endpoint issue"}`,
              timestamp: Date.now(),
            });
          }
        } else {
          // Standard providers: test via dummy message
          const { generateText } = await import("ai");
          const testModelName = resolveTestModel(pType, pBaseUrl);
          const testModel = getModelInstanceForString(testModelName);
          const result = await generateText({
            model: testModel,
            prompt: 'Reply with exactly one word: "OK"',
            maxTokens: 10,
          });
          if (result.text.trim()) {
            testPassed = true;
            addLine({
              type: "system",
              content: `✅ Connection successful! Response: "${result.text.trim()}"`,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err: any) {
        addLine({
          type: "error",
          content: `❌ Connection failed: ${err.message || String(err)}`,
          timestamp: Date.now(),
        });
      }

      // Load model options and proceed to step 8
      let directFetched: string[] = [];
      if (fetchedModelsList.length === 0) {
        directFetched = await fetchModelsForProvider(pType, pApiKey, pBaseUrl);
      }

      let models: string[];
      if (fetchedModelsList.length > 0) {
        models = fetchedModelsList;
      } else if (directFetched.length > 0) {
        models = directFetched;
      } else if (pType === "custom" || pType === "custom-anthropic" || pBaseUrl) {
        addLine({
          type: "system",
          content: `⚠️ Could not fetch model list from ${pName} endpoint (${pBaseUrl || "custom"}). Please enter your model ID manually below.`,
          timestamp: Date.now(),
        });
        models = getFallbackModels("custom");
      } else {
        models = getModelOptions(pType, getCachedModelIds());
      }

      setWizardIsLoadingModels(false);
      setActiveWizard({ type: "login", step: 8, data });
      setWizardOptions([...models, "+ Custom Model (Input manually)"]);
      setWizardSelectedIndex(0);
    } else if (step === 8) {
      // Step 8: User selects model
      const selectedModel = value;
      if (selectedModel === "+ Custom Model (Input manually)") {
        setActiveWizard({
          type: "login",
          step: 16,
          data: { ...data },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        addLine({
          type: "system",
          content: "Please enter the custom model ID manually (e.g., meta-llama/llama-3-70b-instruct):",
          timestamp: now,
        });
        return;
      }
      addLine({
        type: "system",
        content: `Model selected: ${selectedModel}\nNow type a test message to verify the connection works (e.g. "hi"), or type /skip to finish setup.`,
        timestamp: now,
      });
      setActiveWizard({
        type: "login",
        step: 9,
        data: { ...data, selectedModel },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 16) {
      // Step 16: User inputs custom model name manually
      const selectedModel = value.trim();
      if (!selectedModel) {
        addLine({
          type: "error",
          content: "Model ID cannot be empty. Please enter a valid model ID:",
          timestamp: now,
        });
        return;
      }
      addLine({
        type: "system",
        content: `Custom model selected: ${selectedModel}\nNow type a test message to verify the connection works (e.g. "hi"), or type /skip to finish setup.`,
        timestamp: now,
      });
      setActiveWizard({
        type: "login",
        step: 9,
        data: { ...data, selectedModel },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 9) {
      // Step 9: Send test message to selected model (also serves as connection test)
      const message = value.trim();
      const providerProfileId = data.providerId || data.providerProfileId || "";
      if (!message || message === "/skip") {
        // Skip test message — set active model for current session only (don't override preset tier models)
        const selectedModel = data.selectedModel || "";
        if (selectedModel) {
          const limit = getContextWindowLimit(selectedModel);
          setContextLimit(limit);
          setActiveModel(selectedModel);
          addLine({ type: "system", content: `Setup complete. Active model: ${selectedModel}`, timestamp: now });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }
      const selectedModel = data.selectedModel || "";
      if (!selectedModel) {
        addLine({ type: "error", content: "No model selected. Please go back and select a model.", timestamp: now });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }
      addLine({
        type: "user",
        content: `❯ [Test to ${selectedModel}]: ${message}`,
        timestamp: now,
      });
      setIsProcessing(true);
      try {
        const isCustomProvider = data.providerType === "custom" || data.providerBaseUrl;
        let responseText = "";
        if (isCustomProvider && data.providerBaseUrl) {
          const result = await testCustomProviderMessage(
            data.providerBaseUrl,
            data.providerApiKey || "",
            selectedModel,
            message
          );
          if (!result.ok) throw new Error(result.message || "custom provider test failed");
          responseText = result.text || "";
        } else {
          const { generateText } = await import("ai");
          const testModel = getModelInstanceForString(selectedModel);
          const result = await generateText({
            model: testModel,
            prompt: message,
            maxTokens: 512,
          });
          responseText = result.text;
        }
        const { cleanThinkingTags } = await import("../../core/agent/FastPath.js");
        const cleaned = cleanThinkingTags(responseText);
        const displayContent = cleaned.cleanText.trim()
          ? (cleaned.reasoning.trim() ? `[Thinking]:\n${cleaned.reasoning.trim()}\n\n${cleaned.cleanText.trim()}` : cleaned.cleanText.trim())
          : (cleaned.reasoning.trim() ? cleaned.reasoning.trim() : responseText);

        addLine({
          type: "assistant",
          content: displayContent,
          timestamp: Date.now(),
        });
        // Persist the selected model after successful test
        const isMulti = ctx.agentRef.current?.isMultiAgent ?? false;
        const providerProfileId = data.providerId || "";
        setAllTierModels(isMulti ? "multi" : "single", selectedModel, providerProfileId || undefined);
        const limit = getContextWindowLimit(selectedModel);
        setContextLimit(limit);
        const effectiveModel = getEffectiveMasterModel(isMulti ? "multi" : "single") || selectedModel;
        setActiveModel(effectiveModel);
      } catch (err: any) {
        const errorMessage = err?.message || String(err);
        const hints: string[] = [];
        if (data.providerType === "custom" || data.providerBaseUrl) {
          const baseUrl = data.providerBaseUrl || "custom endpoint";
          if (/Invalid JSON response/i.test(errorMessage)) {
            hints.push(`Endpoint ${baseUrl} did not return valid OpenAI-compatible JSON.`);
            hints.push(`Check ${baseUrl.replace(/\/+$/, "")}/chat/completions for JSON response body.`);
            hints.push(`Common causes: HTML error page, plain text error, SSE stream, empty body, or incompatible API schema.`);
          }
        }
        addLine({
          type: "error",
          content: `❌ Failed to send message: ${errorMessage}${hints.length ? `\n${hints.join("\n")}` : ""}`,
          timestamp: Date.now(),
        });
      } finally {
        setIsProcessing(false);
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (step === 14) {
      handleDeleteProviderStep14(value, ctx, now);
    } else if (step === 15) {
      handleDeleteProviderStep15(value, data, ctx, now);
    } else if (step === 17) {
      handleEditProviderStep17(value, ctx, now);
    } else if (step === 18) {
      handleEditProviderStep18(value, data, ctx, now);
    } else if (step === 19) {
      await handleEditProviderStep19(value, data, ctx, now);
    }
  }, [
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    addLine,
    setInput,
    setIsProcessing,
    setContextLimit,
    setActiveModel,
    agentRef,
    setWizardIsLoadingModels,
  ]);

  return handleLoginWizard;
}
