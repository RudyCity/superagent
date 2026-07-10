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
  removeProvider
} from "../../core/config.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import { allTools } from "../../core/tools.js";
import type { Agent } from "../../core/agent.js";
import type { ChatLine } from "../../core/slash-commands.js";
import { resolveProviderType, buildProviderOptions, getModelOptions, resolveTestModel, resolveTestModelAsync, fetchModelsFromEndpoint, checkEndpointCompatibility, testCustomProviderMessage } from "../../core/loginWizardLogic.js";

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
        setWizardOptions([
          "1. OpenRouter (Recommended)",
          "2. OpenAI",
          "3. Anthropic",
          "4. Custom OpenAI Endpoint",
          "5. Custom Anthropic Endpoint",
          "6. Google Gemini"
        ]);
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
          content: "Invalid choice. Please select 1, 2, 3, 4, 5, or 6.",
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

      if (provider === "custom" || provider === "custom-anthropic") {
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

      addLine({
        type: "system",
        content: `Entered Base URL: ${baseUrl}`,
        timestamp: now,
      });
      setActiveWizard({
        type: "login",
        step: 5,
        data: { provider, name: profileName, baseUrl },
      });
      setInput("");
    } else if (step === 5) {
      const provider = data.provider;
      const profileName = data.name;
      const baseUrl = data.baseUrl;
      const apiKey = value;

      const providerId = profileName.toLowerCase().replace(/[^a-z0-9_-]/g, "");

      try {
        // Save provider to JSON (model-config.json) — NOT to .env
        addProvider({
          id: providerId,
          name: profileName,
          provider: provider === "custom-anthropic" ? "anthropic" : provider,
          apiKey: apiKey,
          baseUrl: baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
        });

        // Set this provider as active in preset JSON
        switchActiveProvider(providerId);

        const effectiveBaseUrl = baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "");
        const baseUrlInfo = baseUrl ? `\nBase URL: ${baseUrl}` : (provider === "openrouter" ? `\nBase URL: https://openrouter.ai/api/v1` : "");

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
      const providers = getProviders().filter(p => p.apiKey && p.apiKey.trim() !== "");
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
        content: `Provider selected: ${selectedProvider.name} [${selectedProvider.provider}]`,
        timestamp: now,
      });
      // Activate the selected provider in ALL preset tiers (both modes)
      switchActiveProvider(selectedProvider.id);
      const selBaseUrl = selectedProvider.baseUrl || "";
      const selApiKey = selectedProvider.apiKey || "";
      const selType = selectedProvider.provider || "";
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
      try {
        await fetchAndCacheModels();
      } catch {}

      let models: string[];
      if ((pType === "custom" || pType === "custom-anthropic") && testPassed && fetchedModelsList.length > 0) {
        models = fetchedModelsList;
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
        addLine({
          type: "assistant",
          content: responseText,
          timestamp: Date.now(),
        });
        // Set active model for current session only (don't override preset tier models)
        const limit = getContextWindowLimit(selectedModel);
        setContextLimit(limit);
        setActiveModel(selectedModel);
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
      // Step 14: Select provider to delete
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
      setActiveWizard({
        type: "login",
        step: 15,
        data: {
          providerId: selectedProvider.id,
          providerName: selectedProvider.name,
        },
      });
      setWizardOptions(["1. Yes, Delete Provider", "2. No (Cancel)"]);
      setWizardSelectedIndex(0);
    } else if (step === 15) {
      // Step 15: Confirm deletion of provider
      const choice = value.toLowerCase();
      const confirmDelete = choice.includes("yes") || choice.includes("delete") || choice === "1" || choice.startsWith("1.");
      
      const pId = data.providerId || "";
      const pName = data.providerName || "";

      if (!confirmDelete) {
        // No (Cancel) → back to step 14 delete list
        const list = getConfiguredProviders();
        setActiveWizard({ type: "login", step: 14, data: {} });
        setWizardOptions(list.map(
          (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
        ));
        setWizardSelectedIndex(0);
        return;
      }

      try {
        removeProvider(pId);
        addLine({
          type: "system",
          content: `✅ Provider removed: ${pName}`,
          timestamp: now,
        });
      } catch (err: any) {
        addLine({
          type: "error",
          content: `Failed to remove provider: ${err.message}`,
          timestamp: now,
        });
      }

      // After deletion: reload list and go back to step 14
      const remaining = getConfiguredProviders();
      if (remaining.length > 0) {
        setActiveWizard({ type: "login", step: 14, data: {} });
        setWizardOptions(remaining.map(
          (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
        ));
        setWizardSelectedIndex(0);
      } else {
        addLine({ type: "system", content: "No more providers to delete.", timestamp: now });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (step === 17) {
      // Step 17: Select provider to edit
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

      const masked = selectedProvider.apiKey
        ? (selectedProvider.apiKey.length <= 8 ? "*".repeat(selectedProvider.apiKey.length) : `${selectedProvider.apiKey.slice(0, 4)}...${selectedProvider.apiKey.slice(-4)}`)
        : "None";

      addLine({
        type: "system",
        content: `Editing provider: ${selectedProvider.name} [${selectedProvider.type}]\nCurrent API Key: ${masked}\nCurrent Base URL: ${selectedProvider.baseUrl || "None"}\n\nEnter new API Key (or press Enter to keep current):`,
        timestamp: now,
      });

      setActiveWizard({
        type: "login",
        step: 18,
        data: {
          providerId: selectedProvider.id,
          providerName: selectedProvider.name,
          providerType: selectedProvider.type,
          providerApiKey: selectedProvider.apiKey,
          providerBaseUrl: selectedProvider.baseUrl || "",
        },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 18) {
      // Step 18: Enter new API Key
      const newApiKey = value;
      if (newApiKey.trim() !== "") {
        data.providerApiKey = newApiKey.trim();
        addLine({
          type: "system",
          content: "Updated API Key input.",
          timestamp: now,
        });
      } else {
        addLine({
          type: "system",
          content: "Kept current API Key.",
          timestamp: now,
        });
      }

      addLine({
        type: "system",
        content: `Enter new Base URL (or press Enter to keep current: ${data.providerBaseUrl || "None"}):`,
        timestamp: now,
      });

      setActiveWizard({
        type: "login",
        step: 19,
        data: {
          ...data,
        },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 19) {
      // Step 19: Enter new Base URL and save
      const newBaseUrl = value.trim();
      if (newBaseUrl !== "") {
        data.providerBaseUrl = newBaseUrl;
        addLine({
          type: "system",
          content: `Updated Base URL: ${newBaseUrl}`,
          timestamp: now,
        });
      } else {
        addLine({
          type: "system",
          content: "Kept current Base URL.",
          timestamp: now,
        });
      }

      const pId = data.providerId || "";
      const pName = data.providerName || "";
      const pType = data.providerType || "";
      const pApiKey = data.providerApiKey || "";
      const pBaseUrl = data.providerBaseUrl || "";

      try {
        addProvider({
          id: pId,
          name: pName,
          provider: pType,
          apiKey: pApiKey,
          baseUrl: pBaseUrl || undefined,
        });

        switchActiveProvider(pId);

        addLine({
          type: "system",
          content: `Successfully updated provider profile: ${pName} (${pType})\nSaved to model-config.json`,
          timestamp: now,
        });

        // Transition to connection test confirmation (step 7)
        setActiveWizard({
          type: "login",
          step: 7,
          data: {
            providerId: pId,
            providerName: pName,
            providerType: pType,
            providerApiKey: pApiKey,
            providerBaseUrl: pBaseUrl,
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
