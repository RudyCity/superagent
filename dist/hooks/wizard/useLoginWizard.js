import { useCallback } from "react";
import path from "path";
import fs from "fs/promises";
import { getConfiguredProviders, switchActiveProvider, fetchAndCacheModels, getContextWindowLimit, addProvider, getActiveConfigAudit, getProviders, getCachedModelIds, getEffectiveMasterModel, setAllTierModels, getModelInstanceForString, getSettings } from "../../core/config.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import { allTools } from "../../core/tools.js";
import { resolveProviderType, getModelOptions, fetchModelsFromEndpoint, checkEndpointCompatibility, testCustomProviderMessage } from "../../core/loginWizardLogic.js";
export function useLoginWizard(ctx) {
    const { setActiveWizard, setWizardOptions, setWizardSelectedIndex, addLine, setInput, setIsProcessing, setContextLimit, setActiveModel, agentRef, setWizardIsLoadingModels, } = ctx;
    const handleLoginWizard = useCallback(async (value, step, data) => {
        const now = Date.now();
        if (step === 1) {
            const choice = value.toLowerCase();
            if (choice.includes("create") || choice === "2") {
                setActiveWizard({
                    type: "login",
                    step: 2,
                    data: {},
                });
                setWizardOptions(["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint"]);
                setWizardSelectedIndex(0);
            }
            else {
                const list = getConfiguredProviders();
                if (list.length > 0) {
                    setActiveWizard({ type: "login", step: 6, data: {} });
                    setWizardOptions(list.map((p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`));
                    setWizardSelectedIndex(0);
                }
                else {
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
        }
        else if (step === 2) {
            const provider = resolveProviderType(value);
            if (!provider) {
                addLine({
                    type: "error",
                    content: "Invalid choice. Please select 1, 2, 3, or 4.",
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
        }
        else if (step === 3) {
            const provider = data.provider;
            const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
            const profileName = nameInput || provider;
            if (provider === "custom") {
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
            }
            else {
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
        }
        else if (step === 4) {
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
        }
        else if (step === 5) {
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
                    provider: provider,
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
                });
                // Skip connection test (old step 7) — go directly to model selection (step 8).
                // The connection will be tested naturally when the user sends a test message in step 9.
                setWizardIsLoadingModels(true);
                let models;
                try {
                    await fetchAndCacheModels();
                }
                catch { }
                if (provider === "custom" && effectiveBaseUrl) {
                    const endpointCheck = await checkEndpointCompatibility(effectiveBaseUrl, apiKey);
                    const endpointModels = endpointCheck.models;
                    models = endpointModels.length > 0 ? endpointModels : getModelOptions(provider, getCachedModelIds());
                    if (!endpointCheck.ok && endpointCheck.message) {
                        addLine({
                            type: "system",
                            content: `Custom endpoint warning: ${endpointCheck.message}`,
                            timestamp: Date.now(),
                        });
                    }
                }
                else {
                    models = getModelOptions(provider, getCachedModelIds());
                }
                setWizardIsLoadingModels(false);
                setActiveWizard({
                    type: "login",
                    step: 8,
                    data: {
                        providerId,
                        providerName: profileName,
                        providerType: provider,
                        providerApiKey: apiKey,
                        providerBaseUrl: effectiveBaseUrl,
                    },
                });
                setWizardOptions(models);
                setWizardSelectedIndex(0);
                return;
            }
            catch (err) {
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
        else if (step === 10) {
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
            }
            else {
                let stack = "TypeScript";
                if (choice.includes("javascript"))
                    stack = "JavaScript";
                else if (choice.includes("python"))
                    stack = "Python";
                else if (choice.includes("rust"))
                    stack = "Rust";
                else if (choice.includes("go"))
                    stack = "Go";
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
        }
        else if (step === 11) {
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
        }
        else if (step === 12) {
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
            }
            catch (err) {
                addLine({ type: "error", content: `Failed to complete project initialization: ${err.message}`, timestamp: Date.now() });
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
        }
        else if (step === 13) {
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
                const modelConfig = agentRef.current.getModel();
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
                }
                finally {
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
                if (nameMatch)
                    projectName = nameMatch[1].trim();
                const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
                if (techMatch)
                    projectTech = techMatch[1].trim();
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
            }
            catch (aiErr) {
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
            }
            finally {
                setIsProcessing(false);
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
        }
        else if (step === 6) {
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
            // Skip connection test (old step 7) — go directly to model selection (step 8).
            setWizardIsLoadingModels(true);
            const selBaseUrl = selectedProvider.baseUrl || "";
            const selApiKey = selectedProvider.apiKey || "";
            const selType = selectedProvider.provider || "";
            let models;
            try {
                await fetchAndCacheModels();
            }
            catch { }
            if (selType === "custom" && selBaseUrl) {
                const endpointModels = await fetchModelsFromEndpoint(selBaseUrl, selApiKey);
                models = endpointModels.length > 0 ? endpointModels : getModelOptions(selType, getCachedModelIds());
            }
            else {
                models = getModelOptions(selType, getCachedModelIds());
            }
            setWizardIsLoadingModels(false);
            setActiveWizard({
                type: "login",
                step: 8,
                data: {
                    providerId: selectedProvider.id,
                    providerName: selectedProvider.name,
                    providerType: selType,
                    providerApiKey: selApiKey,
                    providerBaseUrl: selBaseUrl,
                },
            });
            setWizardOptions(models);
            setWizardSelectedIndex(0);
        }
        else if (step === 8) {
            // Step 8: User selects model
            const selectedModel = value;
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
        }
        else if (step === 9) {
            // Step 9: Send test message to selected model (also serves as connection test)
            const message = value.trim();
            const providerProfileId = data.providerId || data.providerProfileId || "";
            if (!message || message === "/skip") {
                // Skip test message — still persist the selected model
                const selectedModel = data.selectedModel || "";
                if (selectedModel) {
                    setAllTierModels("auto", selectedModel, providerProfileId || undefined);
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
                    const result = await testCustomProviderMessage(data.providerBaseUrl, data.providerApiKey || "", selectedModel, message);
                    if (!result.ok)
                        throw new Error(result.message || "custom provider test failed");
                    responseText = result.text || "";
                }
                else {
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
                // Persist the selected model after successful test
                setAllTierModels("auto", selectedModel, providerProfileId || undefined);
                const limit = getContextWindowLimit(selectedModel);
                setContextLimit(limit);
                setActiveModel(selectedModel);
            }
            catch (err) {
                const errorMessage = err?.message || String(err);
                const hints = [];
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
            }
            finally {
                setIsProcessing(false);
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
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
//# sourceMappingURL=useLoginWizard.js.map