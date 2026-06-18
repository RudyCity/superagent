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
  getCachedModelIds
} from "../../core/config.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import { allTools } from "../../core/tools.js";
import type { Agent } from "../../core/agent.js";
import type { ChatLine } from "../../core/slash-commands.js";

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
          addLine({
            type: "system",
            content: `Configured Providers:\n` + list.map(p => `- ${p.name} (${p.type})`).join("\n"),
            timestamp: now,
          });
        } else {
          addLine({
            type: "system",
            content: `No providers configured yet.`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
      }
    } else if (step === 2) {
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

        // Set MODEL di memory saja (process.env) — tidak ditulis ke .env
        if (!process.env.MODEL) {
          let defaultModel = "openai:gpt-4o";
          if (provider === "openrouter") defaultModel = "openrouter:google/gemini-2.5-flash";
          else if (provider === "anthropic") defaultModel = "anthropic:claude-3-5-sonnet-20241022";
          process.env.MODEL = defaultModel;
        }

        addLine({
          type: "system",
          content: `Successfully configured provider profile: ${profileName} (${provider})!\nSaved to global model-config.json`,
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
          content: `Failed to save credentials: ${err.message}`,
          timestamp: now,
        });
      }
      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
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
          ...(data.gitBranch ? [`│ 🌿 Branch         : ${data.gitBranch}`] : []),
          ...(data.gitSha ? [`│ 📌 HEAD           : ${data.gitSha}`] : []),
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

        const gitStatusLabel = data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${data.gitStatus}`;
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
          ...(data.gitBranch ? [`│ 🌿 Branch         : ${data.gitBranch}`] : []),
          ...(data.gitSha ? [`│ 📌 HEAD           : ${data.gitSha}`] : []),
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
      // Step 6: Pilih provider dari daftar (dari /login → List)
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
        content: `Provider dipilih: ${selectedProvider.name} [${selectedProvider.provider}]`,
        timestamp: now,
      });
      setActiveWizard({
        type: "login",
        step: 7,
        data: {
          providerId: selectedProvider.id,
          providerName: selectedProvider.name,
          providerType: selectedProvider.provider,
          providerApiKey: selectedProvider.apiKey,
          providerBaseUrl: selectedProvider.baseUrl || "",
        },
      });
      setWizardOptions(["Ya, Test Koneksi", "Tidak"]);
      setWizardSelectedIndex(0);
    } else if (step === 7) {
      // Step 7: Konfirmasi test koneksi
      const choice = value.toLowerCase();
      const skipTest = choice.includes("tidak") || choice === "2" || choice === "no";
      if (skipTest) {
        addLine({ type: "system", content: "Test koneksi dilewati.", timestamp: now });
        // Lanjut ke step 102: pilih model
        const cachedModels = getCachedModelIds();
        const providerType = data.providerType || "";
        const baseUrl = data.providerBaseUrl || "";
        // Filter model list berdasarkan provider type jika memungkinkan
        let models = cachedModels.length > 0 ? cachedModels : ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"];
        if (providerType === "anthropic") {
          const anthropicModels = models.filter(m => m.includes("claude"));
          if (anthropicModels.length > 0) models = anthropicModels;
          else models = ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"];
        } else if (providerType === "openai") {
          const openaiModels = models.filter(m => m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3"));
          if (openaiModels.length > 0) models = openaiModels;
          else models = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
        }
        setActiveWizard({ type: "login", step: 8, data });
        setWizardOptions(models.slice(0, 50));
        setWizardSelectedIndex(0);
        return;
      }
      // Lakukan test koneksi
      addLine({ type: "system", content: `🔄 Menguji koneksi ke ${data.providerName}...`, timestamp: now });
      setWizardIsLoadingModels(true);
      try {
        const { generateText } = await import("ai");
        const { createOpenAI } = await import("@ai-sdk/openai");
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        const providerType = data.providerType || "";
        const apiKey = data.providerApiKey || "";
        const baseUrl = data.providerBaseUrl || "";
        let testModel: any;
        let testModelName = "";
        if (providerType === "anthropic") {
          const anthropic = createAnthropic({ apiKey });
          testModelName = "claude-3-haiku-20240307";
          testModel = anthropic(testModelName);
        } else {
          const openaiOpts: any = { apiKey };
          if (baseUrl) openaiOpts.baseURL = baseUrl;
          openaiOpts.headers = {
            "HTTP-Referer": "https://github.com/RudyCity/superagent",
            "X-Title": "SuperAgent CLI",
          };
          const openai = createOpenAI(openaiOpts);
          if (providerType === "openrouter" || (baseUrl && baseUrl.includes("openrouter.ai"))) {
            testModelName = "openai/gpt-4o-mini";
          } else {
            testModelName = "gpt-4o-mini";
          }
          testModel = openai(testModelName);
        }
        const result = await generateText({
          model: testModel,
          prompt: 'Reply with exactly one word: "OK"',
          maxTokens: 10,
        });
        addLine({
          type: "system",
          content: `✅ Koneksi berhasil! Response: "${result.text.trim()}"`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        addLine({
          type: "error",
          content: `❌ Koneksi gagal: ${err.message || String(err)}`,
          timestamp: Date.now(),
        });
      } finally {
        setWizardIsLoadingModels(false);
      }
      // Fetch model list dan lanjut ke step 102
      try {
        await fetchAndCacheModels();
      } catch {}
      const cachedModels = getCachedModelIds();
      const pType = data.providerType || "";
      let models = cachedModels.length > 0 ? cachedModels : ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet-20241022"];
      if (pType === "anthropic") {
        const filtered = models.filter(m => m.includes("claude"));
        if (filtered.length > 0) models = filtered;
        else models = ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"];
      } else if (pType === "openai") {
        const filtered = models.filter(m => m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3"));
        if (filtered.length > 0) models = filtered;
        else models = ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
      }
      setActiveWizard({ type: "login", step: 8, data });
      setWizardOptions(models.slice(0, 50));
      setWizardSelectedIndex(0);
    } else if (step === 8) {
      // Step 8: User pilih model
      const selectedModel = value;
      addLine({
        type: "system",
        content: `Model dipilih: ${selectedModel}`,
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
      // Step 9: Kirim pesan test ke model yang dipilih
      const message = value.trim();
      if (!message) {
        addLine({ type: "error", content: "Pesan tidak boleh kosong.", timestamp: now });
        return;
      }
      const selectedModel = data.selectedModel || "";
      const providerType = data.providerType || "";
      const apiKey = data.providerApiKey || "";
      const baseUrl = data.providerBaseUrl || "";
      addLine({
        type: "user",
        content: `❯ [Test ke ${selectedModel}]: ${message}`,
        timestamp: now,
      });
      setIsProcessing(true);
      try {
        const { generateText } = await import("ai");
        const { createOpenAI } = await import("@ai-sdk/openai");
        const { createAnthropic } = await import("@ai-sdk/anthropic");
        let testModel: any;
        if (providerType === "anthropic") {
          const anthropic = createAnthropic({ apiKey });
          testModel = anthropic(selectedModel);
        } else {
          const openaiOpts: any = { apiKey };
          if (baseUrl) openaiOpts.baseURL = baseUrl;
          openaiOpts.headers = {
            "HTTP-Referer": "https://github.com/RudyCity/superagent",
            "X-Title": "SuperAgent CLI",
          };
          const openai = createOpenAI(openaiOpts);
          testModel = openai(selectedModel);
        }
        const result = await generateText({
          model: testModel,
          prompt: message,
          maxTokens: 512,
        });
        addLine({
          type: "assistant",
          content: result.text,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        addLine({
          type: "error",
          content: `❌ Gagal mengirim pesan: ${err.message || String(err)}`,
          timestamp: Date.now(),
        });
      } finally {
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
