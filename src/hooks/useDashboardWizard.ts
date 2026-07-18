import React, { useCallback } from "react";
import { execSync } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { 
  switchActiveProvider, 
  addProvider,
  listHistorySessions, 
  fetchAndCacheModels,
  getConfiguredProviders,
  getProviders,
  getContextWindowLimit,
  getInstalledSkills,
  getCachedModelIds,
  getModelPresets,
  applyModelPreset,
  saveModelPreset,
  deleteModelPreset,
  BUILT_IN_PRESETS,
  getProviderOptionsList,
  getActiveConfigAudit,
  getActiveProviderName,
  getResolvedModelWithProvider,
  formatProviderForPicker,
  formatProviderForLog,
  getEffectiveMasterModel,
  getTierModel,
  getTierModelWithProvider,
  setTierModel,
  setAllTierModels,
  clearTierModel,
  getAllTierModels,
  getModelInstanceForString,
  getSettings
} from "../core/config.js";
import type { PresetMode } from "../core/config.js";
import { filterSuggestions } from "../utils/text.js";
import { handleSlashCommand, getDefaultModel } from "../core/slash-commands.js";
import { listCheckpointsForSession, restoreCheckpoint, deleteCheckpointById } from "../core/checkpoints.js";
import { allTools } from "../core/tools.js";
import type { Agent, QuestionItem } from "../core/agent.js";
import { resolveProviderType, buildProviderOptions, getModelOptions, resolveTestModel, resolveTestModelAsync, fetchModelsFromEndpoint, checkEndpointCompatibility, testCustomProviderMessage } from "../core/loginWizardLogic.js";
import { PLAN_APPROVAL_OPTIONS } from "../components/plan-approval-dialog.js";
import { contentToString } from "../core/conversation.js";
import { attachmentToImagePart, type ImageAttachment } from "../utils/imageUtils.js";
import { useModelWizard } from "./wizard/useModelWizard.js";

export interface DashboardWizardContext {
  agent: Agent;
  exit: () => void;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  activeWizard: {
    type: "login" | "model" | "plan_approve" | "permission" | "question" | "resume" | "goal" | "checkpoint" | "skills" | "exit_confirm" | "workspace";
    step: number;
    data: Record<string, string>;
    isMultiSelect?: boolean;
    questions?: QuestionItem[];
    currentQuestionIndex?: number;
    answers?: string[];
  } | null;
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
  attachments: ImageAttachment[];
  setAttachments: React.Dispatch<React.SetStateAction<ImageAttachment[]>>;
  setSelectedIndex?: React.Dispatch<React.SetStateAction<number>>;
  setLogScrollOffset?: React.Dispatch<React.SetStateAction<number>>;
  setWorkingDirectory?: (path: string) => void;
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
    attachments,
    setAttachments,
    setSelectedIndex,
    setLogScrollOffset,
    setWorkingDirectory,
  } = ctx;

  const isMulti = agent.isMultiAgent;
  const presetMode: PresetMode = isMulti ? "multi" : "single";
  const modeLabel = isMulti ? "Multi-Agent" : "Single-Agent";

  const handleModelWizard = useModelWizard({
    setActiveWizard,
    setWizardOptions,
    setWizardAllOptions,
    setWizardSelectedIndex,
    addLine: (line: any) => setMasterLogs((prev) => [...prev, line.content].slice(-500)),
    setInput: setQuery,
    setContextLimit,
    setActiveModel,
    setWizardIsLoadingModels,
    wizardSelectedIndex,
    wizardOptions,
    wizardIsLoadingModels,
    agentRef: { current: agent },
  });

  const getProfilePickerOptions = (providerType: string): string[] => {
    const providers = getProviders().filter(p => p.provider === providerType);
    return providers.map(p => {
      const apiKey = p.apiKey || "";
      const maskedKey = apiKey
        ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
        : "(no key)";
      return `${p.name} (key: ${maskedKey})`;
    });
  };

  const getTierOptionsList = (
    masterModelFormatted: string,
    superagentModelFormatted: string,
    subagentModelFormatted: string,
    researcherModelFormatted: string,
    coderModelFormatted: string,
    reviewerModelFormatted: string,
    advisorModelFormatted: string
  ): string[] => {
    if (isMulti) {
      return [
        `1. Master Agent (depth 0) (${masterModelFormatted})`,
        `2. Superagent (depth 1) (${superagentModelFormatted})`,
        `3. Subagent (depth 2) (${subagentModelFormatted})`,
        `4. Feature: researcher (${researcherModelFormatted})`,
        `5. Feature: coder (${coderModelFormatted})`,
        `6. Feature: reviewer (${reviewerModelFormatted})`,
        `7. Feature: advisor (${advisorModelFormatted})`,
        `8. All Tiers (Overwrite All)`,
        `< Back`
      ];
    } else {
      return [
        `1. Superagent (depth 1) (${superagentModelFormatted})`,
        `2. Subagent (depth 2) (${subagentModelFormatted})`,
        `3. Feature: researcher (${researcherModelFormatted})`,
        `4. Feature: coder (${coderModelFormatted})`,
        `5. Feature: reviewer (${reviewerModelFormatted})`,
        `6. Feature: advisor (${advisorModelFormatted})`,
        `7. All Tiers (Overwrite All)`,
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
        `4. Feature: researcher (${formatVal(models.MODEL_MULTI_SUBAGENT_RESEARCHER)})`,
        `5. Feature: coder (${formatVal(models.MODEL_MULTI_SUBAGENT_CODER)})`,
        `6. Feature: reviewer (${formatVal(models.MODEL_MULTI_SUBAGENT_REVIEWER)})`,
        `7. Feature: advisor (${formatVal(models.MODEL_MULTI_SUBAGENT_ADVISOR)})`,
        "8. Save Preset & Exit",
        "9. Cancel & Exit",
        "< Back"
      ];
    } else {
      return [
        `1. Superagent (depth 1) (${formatVal(models.MODEL_SINGLE_SUPERAGENT)})`,
        `2. Subagent (depth 2) (${formatVal(models.MODEL_SINGLE_SUBAGENT)})`,
        `3. Feature: researcher (${formatVal(models.MODEL_SINGLE_SUBAGENT_RESEARCHER)})`,
        `4. Feature: coder (${formatVal(models.MODEL_SINGLE_SUBAGENT_CODER)})`,
        `5. Feature: reviewer (${formatVal(models.MODEL_SINGLE_SUBAGENT_REVIEWER)})`,
        `6. Feature: advisor (${formatVal(models.MODEL_SINGLE_SUBAGENT_ADVISOR)})`,
        "7. Save Preset & Exit",
        "8. Cancel & Exit",
        "< Back"
      ];
    }
  };

  const handleWizardSubmit = useCallback(async (value: string) => {
    if (!activeWizard) return;
    const now = Date.now();

    if (activeWizard.type === "exit_confirm") {
      if (value === "Yes, exit") {
        exit();
      } else {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setMasterLogs((prev) => [...prev, "[SYSTEM] Exit cancelled. Retaining session."].slice(-500));
      }
      return;
    }

    if (activeWizard.type === "workspace") {
      if (activeWizard.step === 1) {
        if (value === "➕ Add a new workspace...") {
          setActiveWizard({
            type: "workspace",
            step: 2,
            data: {},
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          return;
        }

        const cleanVal = value.replace(/^\*\s*\[active\]\s*/i, "").replace(/^📁\s*/, "").replace(/\s*\(active\)$/i, "").trim();
        const resolvedPath = path.resolve(cleanVal);

        if (fsSync.existsSync(resolvedPath)) {
          const { addTrustedDirectory } = await import("../core/config/jsonConfig.js");
          addTrustedDirectory(resolvedPath);

          if (setWorkingDirectory) {
            setWorkingDirectory(resolvedPath);
          } else {
            process.chdir(resolvedPath);
            if (agent) agent.workingDirectory = resolvedPath;
          }

          if (agent) {
            agent.resetInternalState();
            await agent.clearHistory();
            agent.planState = "IDLE";
            agent.goalMode = null;
          }

          setMasterLogs([`[SYSTEM] 📁 Switched workspace to: ${resolvedPath} (started new chat session)`]);
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Workspace path does not exist: ${resolvedPath}`].slice(-500));
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      if (activeWizard.step === 2) {
        const pathInput = value.trim();
        if (!pathInput) {
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        const currentCwd = agent?.workingDirectory || process.cwd();
        const resolvedPath = path.resolve(currentCwd, pathInput);

        if (fsSync.existsSync(resolvedPath) && (await fs.stat(resolvedPath)).isDirectory()) {
          const { addTrustedDirectory } = await import("../core/config/jsonConfig.js");
          addTrustedDirectory(resolvedPath);

          if (setWorkingDirectory) {
            setWorkingDirectory(resolvedPath);
          } else {
            process.chdir(resolvedPath);
            if (agent) agent.workingDirectory = resolvedPath;
          }

          if (agent) {
            agent.resetInternalState();
            await agent.clearHistory();
            agent.planState = "IDLE";
            agent.goalMode = null;
          }

          setMasterLogs([`[SYSTEM] 📁 Added and switched to workspace: ${resolvedPath} (started new chat session)`]);
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        } else {
          setMasterLogs((prev) => [...prev, `[ERROR] Path does not exist or is not a directory: ${resolvedPath}`].slice(-500));
          setQuery("");
        }
        return;
      }
    }

    if (activeWizard.type === "login") {
      if (activeWizard.step === 1) {
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
        } else {
        const list = getConfiguredProviders();
        if (list.length > 0) {
          setActiveWizard({ type: "login", step: 6, data: {} });
          setWizardOptions(list.map(
            (p, i) => `${i + 1}. ${p.name} [${p.type || "unknown"}]${p.baseUrl ? ` (${p.baseUrl})` : ""}`
          ));
            setWizardSelectedIndex(0);
          } else {
            setMasterLogs((prev) => [...prev, `[SYSTEM] No providers configured yet.`].slice(-500));
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
          }
        }
      } else if (activeWizard.step === 2) {
        const provider = resolveProviderType(value);
        if (!provider) {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid choice. Please select 1, 2, 3, 4, 5, or 6.`].slice(-500));
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

        if (provider === "custom" || provider === "custom-anthropic") {
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
            provider: provider === "custom-anthropic" ? "anthropic" : provider,
            apiKey: apiKey,
            baseUrl: baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
          });

          // Set provider ini sebagai aktif di preset JSON
          switchActiveProvider(providerId);

          const effectiveBaseUrl = baseUrl || (provider === "openrouter" ? "https://openrouter.ai/api/v1" : "");
          const baseUrlInfo = baseUrl ? `\nBase URL: ${baseUrl}` : (provider === "openrouter" ? `\nBase URL: https://openrouter.ai/api/v1` : "");

          setMasterLogs((prev) => [
            ...prev,
            `[SYSTEM] Successfully configured provider profile: ${profileName} (${provider})${baseUrlInfo}\nSaved to model-config.json`
          ].slice(-500));

          // Transition to connection test confirmation (step 7)
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
          return;
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to save credentials: ${err.message}`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        }
      } else if (activeWizard.step === 6) {
        const providers = getProviders().filter(p => p.apiKey && p.apiKey.trim() !== "");
        const idx = parseInt(value, 10) - 1;
        const selectedProvider = providers[idx];
        if (!selectedProvider) {
          setMasterLogs((prev) => [...prev, `[ERROR] Invalid provider selection.`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }
        setMasterLogs((prev) => [...prev, `[MASTER] Provider selected: ${selectedProvider.name} [${selectedProvider.provider}]`].slice(-500));
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
      } else if (activeWizard.step === 7) {
        // Step 7: Confirm connection test in Dashboard
        const choice = value.toLowerCase();
        const cancelSetup = choice.includes("tidak") || choice.includes("no") || choice === "2" || choice.startsWith("2.");
        
        const pId = activeWizard.data.providerId || "";
        const pName = activeWizard.data.providerName || "";
        const pType = activeWizard.data.providerType || "";
        const pApiKey = activeWizard.data.providerApiKey || "";
        const pBaseUrl = activeWizard.data.providerBaseUrl || "";

        if (cancelSetup) {
          setMasterLogs((prev) => [...prev, `[SYSTEM] Provider setup cancelled.`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }

        setMasterLogs((prev) => [...prev, `[SYSTEM] 🔄 Testing connection to ${pName}...`].slice(-500));
        setWizardIsLoadingModels(true);
        let testPassed = false;
        let fetchedModelsList: string[] = [];

        try {
          if (pType === "custom" || pType === "custom-anthropic") {
            const endpointCheck = await checkEndpointCompatibility(pBaseUrl, pApiKey);
            if (endpointCheck.ok) {
              testPassed = true;
              fetchedModelsList = endpointCheck.models;
              setMasterLogs((prev) => [...prev, `[SYSTEM] ✅ Connection successful! Fetched ${fetchedModelsList.length} models from custom endpoint.`].slice(-500));
            } else {
              setMasterLogs((prev) => [...prev, `[ERROR] ❌ Connection check failed: ${endpointCheck.message || "Unknown endpoint issue"}`].slice(-500));
            }
          } else {
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
              setMasterLogs((prev) => [...prev, `[SYSTEM] ✅ Connection successful! Response: "${result.text.trim()}"`].slice(-500));
            }
          }
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] ❌ Connection failed: ${err.message || String(err)}`].slice(-500));
        }

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
        setActiveWizard({ type: "login", step: 8, data: activeWizard.data });
        setWizardOptions([...models, "+ Custom Model (Input manually)"]);
        setWizardSelectedIndex(0);
      } else if (activeWizard.step === 8) {
        const selectedModel = value;
        if (selectedModel === "+ Custom Model (Input manually)") {
          setActiveWizard({
            type: "login",
            step: 16,
            data: { ...activeWizard.data },
          });
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setQuery("");
          setMasterLogs((prev) => [...prev, "[SYSTEM] Please enter the custom model ID manually (e.g., meta-llama/llama-3-70b-instruct):"].slice(-500));
          return;
        }
        setMasterLogs((prev) => [...prev, `[MASTER] Model selected: ${selectedModel}\nNow type a test message to verify the connection works (e.g. "hi"), or type /skip to finish setup.`].slice(-500));
        setActiveWizard({ type: "login", step: 9, data: { ...activeWizard.data, selectedModel } });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 16) {
        // Step 16: User inputs custom model name manually
        const selectedModel = value.trim();
        if (!selectedModel) {
          setMasterLogs((prev) => [...prev, "[ERROR] Model ID cannot be empty. Please enter a valid model ID:"].slice(-500));
          return;
        }
        setMasterLogs((prev) => [...prev, `[MASTER] Custom model selected: ${selectedModel}\nNow type a test message to verify the connection works (e.g. "hi"), or type /skip to finish setup.`].slice(-500));
        setActiveWizard({ type: "login", step: 9, data: { ...activeWizard.data, selectedModel } });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
      } else if (activeWizard.step === 9) {
        const message = value.trim();
        const providerProfileId = activeWizard.data.providerId || activeWizard.data.providerProfileId || "";
        if (!message || message === "/skip") {
          // Skip test message — still persist the selected model
          const selectedModel = activeWizard.data.selectedModel || "";
          if (selectedModel) {
            setAllTierModels(isMulti ? "multi" : "single", selectedModel, providerProfileId || undefined);
            const limit = getContextWindowLimit(selectedModel);
            setContextLimit(limit);
            const effectiveModel = getEffectiveMasterModel(isMulti ? "multi" : "single") || selectedModel;
            setActiveModel(effectiveModel);
            setMasterLogs((prev) => [...prev, `[SYSTEM] Setup complete. Active model: ${selectedModel}`].slice(-500));
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }
        const selectedModel = activeWizard.data.selectedModel || "";
        if (!selectedModel) {
          setMasterLogs((prev) => [...prev, `[ERROR] No model selected. Please go back and select a model.`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          return;
        }
        setMasterLogs((prev) => [...prev, `[USER] [Test to ${selectedModel}]: ${message}`].slice(-500));
        setIsProcessing(true);
        try {
          const isCustomProvider = activeWizard.data.providerType === "custom" || activeWizard.data.providerBaseUrl;
          let responseText = "";
          if (isCustomProvider && activeWizard.data.providerBaseUrl) {
            const result = await testCustomProviderMessage(
              activeWizard.data.providerBaseUrl,
              activeWizard.data.providerApiKey || "",
              selectedModel,
              message
            );
            if (!result.ok) throw new Error(result.message || "custom provider test failed");
            responseText = result.text || "";
          } else {
            const { generateText } = await import("ai");
            const testModel = getModelInstanceForString(selectedModel);
            const result = await generateText({ model: testModel, prompt: message, maxTokens: 512 });
            responseText = result.text;
          }
          setMasterLogs((prev) => [...prev, `[ASSISTANT] ${responseText}`].slice(-500));
          // Persist the selected model after successful test
          setAllTierModels(isMulti ? "multi" : "single", selectedModel, providerProfileId || undefined);
          const limit = getContextWindowLimit(selectedModel);
          setContextLimit(limit);
          const effectiveModel = getEffectiveMasterModel(isMulti ? "multi" : "single") || selectedModel;
          setActiveModel(effectiveModel);
        } catch (err: any) {
          const errorMessage = err?.message || String(err);
          const hints: string[] = [];
          if (activeWizard.data.providerType === "custom" || activeWizard.data.providerBaseUrl) {
            const baseUrl = activeWizard.data.providerBaseUrl || "custom endpoint";
            if (/Invalid JSON response/i.test(errorMessage)) {
              hints.push(`Endpoint ${baseUrl} did not return valid OpenAI-compatible JSON.`);
              hints.push(`Check ${baseUrl.replace(/\/+$/, "")}/chat/completions for JSON response body.`);
              hints.push(`Common causes: HTML error page, plain text error, SSE stream, empty body, or incompatible API schema.`);
            }
          }
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to send message: ${errorMessage}${hints.length ? `\n${hints.join("\n")}` : ""}`].slice(-500));
        } finally {
          setIsProcessing(false);
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
            ...(activeWizard.data.gitBranch ? [`│ 🌿 Branch         : ${activeWizard.data.gitBranch}`] : []),
            ...(activeWizard.data.gitSha ? [`│ 📌 HEAD           : ${activeWizard.data.gitSha}`] : []),
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
          setMasterLogs((prev) => [...prev, `[SYSTEM] ${auditLines.join("\n")}`].slice(-500));

          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        })().catch(err => {
          setMasterLogs((prev) => [...prev, `[ERROR] Failed to complete project initialization: ${err.message}`].slice(-500));
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
        });
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
            setMasterLogs((prev) => [...prev, `[SYSTEM] 📄 Generated agents.md successfully!`].slice(-500));

            // Extract project details dynamically from AI generated content
            let projectName = path.basename(cwd);
            let projectTech = "Unknown";
            const nameMatch = content.match(/-\s*\*\*Name\*\*:\s*(.*)/i);
            if (nameMatch) projectName = nameMatch[1].trim();
            const techMatch = content.match(/-\s*\*\*Technology Stack\*\*:\s*(.*)/i);
            if (techMatch) projectTech = techMatch[1].trim();

            const gitStatusLabel = activeWizard.data.gitStatus === "ACTIVE" ? "✓ ACTIVE" : activeWizard.data.gitStatus === "INITIALIZED" ? "✓ INITIALIZED (new)" : `✗ ${activeWizard.data.gitStatus}`;
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
              ...(activeWizard.data.gitBranch ? [`│ 🌿 Branch         : ${activeWizard.data.gitBranch}`] : []),
              ...(activeWizard.data.gitSha ? [`│ 📌 HEAD           : ${activeWizard.data.gitSha}`] : []),
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
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
          }
        })();
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setWizardAllOptions([]);
        setWizardIsLoadingModels(false);
      }
    } else if (activeWizard.type === "model") {
      handleModelWizard(value, activeWizard.step, activeWizard.data);
      return;
    } else if (activeWizard.type === "resume") {
      const chosen = cachedSessions[wizardSelectedIndex];
      if (!chosen) return;
      try {
        await agent.loadHistoryFromPath(chosen.filePath);
        const msgs = agent.getHistory().getMessages();
        const loadedLogs: string[] = [];
        for (const m of msgs) {
          const stringContent = m.content ? contentToString(m.content) : "";
          if (m.role === "user") {
            const skillPrefixMatch = stringContent.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
            if (skillPrefixMatch) {
              loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
            } else {
              loadedLogs.push(`[USER] ${stringContent}`);
            }
          } else if (m.role === "assistant") {
            if (stringContent) {
              loadedLogs.push(`[AGENT] ${stringContent}`);
            }
          } else if (m.role === "system") {
            if (stringContent && stringContent.startsWith("[ERROR]")) {
              loadedLogs.push(stringContent);
            } else if (stringContent) {
              loadedLogs.push(`[MASTER] ${stringContent}`);
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
        const action = activeWizard.data.action || "browse";

        // "browse" mode: show action sub-menu
        if (action === "browse") {
          setActiveWizard({ type: "checkpoint", step: 1, data: { action: "choose", checkpointIndex: String(wizardSelectedIndex) } });
          setWizardOptions(["🔄 Restore this checkpoint", "🗑️ Delete this checkpoint"]);
          setWizardSelectedIndex(0);
          return;
        }

        // "choose" sub-menu
        if (action === "choose") {
          const chkIndex = parseInt(activeWizard.data.checkpointIndex || "0", 10);
          const targetChk = checkpointsList[chkIndex];
          if (!targetChk) return;

          if (wizardSelectedIndex === 0) {
            // Restore selected
            if (targetChk.gitSha) {
              setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(chkIndex) } });
              setWizardOptions(["✓ Yes, restore workspace to this commit (git stash & checkout)", "✗ No, only restore conversation history"]);
              setWizardSelectedIndex(0);
              return;
            }
            // Direct restore (no git)
            const sessionPath = agent.getCurrentHistoryFilePath();
            if (!sessionPath) return;
            const checkpointsDir = path.join(path.dirname(sessionPath), "checkpoints");
            const chkPath = path.join(checkpointsDir, `checkpoint_${targetChk.timestamp}.json`);
            restoreCheckpoint(chkPath, sessionPath)
              .then(async () => {
                await agent.loadHistoryFromPath(sessionPath);
                const msgs = agent.getHistory().getMessages();
                const loadedLogs: string[] = [];
                for (const m of msgs) {
                  if (m.role === "user") loadedLogs.push(`[USER] ${m.content}`);
                  else if (m.role === "assistant" && m.content) loadedLogs.push(`[AGENT] ${m.content}`);
                }
                setMasterLogs(loadedLogs.slice(-500));
                setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${targetChk.name}" restored! (${targetChk.messages.length} messages)`].slice(-500));
              })
              .catch((err: any) => {
                setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore: ${err.message}`].slice(-500));
              });
            setActiveWizard(null); setWizardOptions([]); setWizardSelectedIndex(0); setCheckpointsList([]);
            return;
          } else {
            // Delete selected
            const sessionPath = agent.getCurrentHistoryFilePath();
            if (!sessionPath) return;
            deleteCheckpointById(targetChk.id, sessionPath)
              .then((deleted) => {
                setMasterLogs((prev) => [...prev, deleted ? `[MASTER] Checkpoint "${targetChk.name}" deleted.` : `[ERROR] Failed to delete "${targetChk.name}".`].slice(-500));
              })
              .catch((err: any) => {
                setMasterLogs((prev) => [...prev, `[ERROR] Delete failed: ${err.message}`].slice(-500));
              });
            setActiveWizard(null); setWizardOptions([]); setWizardSelectedIndex(0); setCheckpointsList([]);
            return;
          }
        }

        // "restore" mode (direct from /checkpoint restore wizard)
        if (action === "restore") {
          if (chosen.gitSha) {
            setActiveWizard({ type: "checkpoint", step: 2, data: { checkpointIndex: String(wizardSelectedIndex) } });
            setWizardOptions(["✓ Yes, restore workspace to this commit (git stash & checkout)", "✗ No, only restore conversation history"]);
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
                if (m.role === "user") loadedLogs.push(`[USER] ${m.content}`);
                else if (m.role === "assistant" && m.content) loadedLogs.push(`[AGENT] ${m.content}`);
              }
              setMasterLogs(loadedLogs.slice(-500));
              setMasterLogs((prev) => [...prev, `[MASTER] Checkpoint "${chosen.name}" restored! (${chosen.messages.length} messages)`].slice(-500));
            })
            .catch((err: any) => {
              setMasterLogs((prev) => [...prev, `[ERROR] Failed to restore: ${err.message}`].slice(-500));
            });
          setActiveWizard(null); setWizardOptions([]); setWizardSelectedIndex(0); setCheckpointsList([]);
          return;
        }

        // "delete" mode (direct from /checkpoint delete wizard)
        if (action === "delete") {
          const sessionPath = agent.getCurrentHistoryFilePath();
          if (!sessionPath) return;
          deleteCheckpointById(chosen.id, sessionPath)
            .then((deleted) => {
              setMasterLogs((prev) => [...prev, deleted ? `[MASTER] Checkpoint "${chosen.name}" deleted.` : `[ERROR] Failed to delete "${chosen.name}".`].slice(-500));
            })
            .catch((err: any) => {
              setMasterLogs((prev) => [...prev, `[ERROR] Delete failed: ${err.message}`].slice(-500));
            });
          setActiveWizard(null); setWizardOptions([]); setWizardSelectedIndex(0); setCheckpointsList([]);
          return;
        }
      } else if (activeWizard.step === 2) {
        if (value === "< Back") {
          setActiveWizard({ type: "checkpoint", step: 1, data: { action: "browse" } });
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
              const stringContent = m.content ? contentToString(m.content) : "";
              if (m.role === "user") {
                const skillPrefixMatch = stringContent.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${stringContent}`);
                }
              } else if (m.role === "assistant" && stringContent) {
                loadedLogs.push(`[AGENT] ${stringContent}`);
              } else if (m.role === "system") {
                if (stringContent && stringContent.startsWith("[ERROR]")) {
                  loadedLogs.push(stringContent);
                } else if (stringContent) {
                  loadedLogs.push(`[MASTER] ${stringContent}`);
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
      if (activeWizard.step === 1 && value === "Custom...") {
        setActiveWizard({
          ...activeWizard,
          step: 2,
          data: { question: pendingQuestion?.question || "" },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setQuery("");
        return;
      }

      const qList = activeWizard.questions;
      const currIdx = activeWizard.currentQuestionIndex;
      if (qList && currIdx !== undefined) {
        const updatedAnswers = [...(activeWizard.answers || [])];
        updatedAnswers[currIdx] = value;

        setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${value}"`].slice(-500));

        const nextIdx = currIdx + 1;
        if (nextIdx < qList.length) {
          const nextQ = qList[nextIdx];
          const hasOptions = Array.isArray(nextQ.options) && nextQ.options.length > 0;
          const allOptions = hasOptions ? [...nextQ.options, "Custom..."] : [];
          if (pendingQuestion) {
            setPendingQuestion({
              question: nextQ.question,
              options: allOptions,
              resolve: pendingQuestion.resolve,
            });
          }
          setWizardOptions(allOptions);

          const nextSavedAns = updatedAnswers[nextIdx] || "";
          if (nextQ.isMultiSelect) {
            const nextAnsList = nextSavedAns.split(", ").map((x: string) => x.trim());
            const newSet = new Set<number>();
            allOptions.forEach((opt, idx) => {
              if (nextAnsList.includes(opt)) {
                newSet.add(idx);
              }
            });
            setWizardSelectedSet(newSet);
            setWizardSelectedIndex(0);
          } else {
            const optionIdx = nextQ.options.indexOf(nextSavedAns);
            if (optionIdx >= 0) {
              setWizardSelectedIndex(optionIdx);
            } else {
              setWizardSelectedIndex(0);
            }
            setWizardSelectedSet(new Set());
          }

          setQuery("");

          const optionIdx = nextQ.options.indexOf(nextSavedAns);
          const isCustomAnswer = nextSavedAns !== "" && optionIdx < 0;

          if (isCustomAnswer && !nextQ.isMultiSelect) {
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setQuery(nextSavedAns);
            setActiveWizard({
              ...activeWizard,
              step: 2,
              currentQuestionIndex: nextIdx,
              answers: updatedAnswers,
              isMultiSelect: nextQ.isMultiSelect,
            });
          } else {
            setActiveWizard({
              ...activeWizard,
              step: hasOptions ? 1 : 2,
              currentQuestionIndex: nextIdx,
              answers: updatedAnswers,
              isMultiSelect: nextQ.isMultiSelect,
            });
          }
        } else {
          if (pendingQuestion) {
            pendingQuestion.resolve(updatedAnswers);
            setPendingQuestion(null);
          }
          setActiveWizard(null);
          setWizardOptions([]);
          setWizardSelectedIndex(0);
          setWizardSelectedSet(new Set());
          setQuery("");
        }
        return;
      }

      if (pendingQuestion) {
        pendingQuestion.resolve(value);
        setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${value}"`].slice(-500));
      }

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setWizardSelectedSet(new Set());
      setPendingQuestion(null);
      setQuery("");
    } else if (activeWizard.type === "plan_approve") {
      // Step 2: custom feedback — send to agent for revision
      if (activeWizard.step === 2) {
        const feedback = (typeof value === "string" ? value : "").trim();
        if (!feedback) return;
        agent.planState = "IDLE";
        setPlanState("IDLE");
        setMasterLogs((prev) => [...prev, `[MASTER] 💬 Plan feedback: "${feedback.slice(0, 100)}${feedback.length > 100 ? "..." : ""}"`].slice(-500));
        setIsProcessing(true);
        agent.sendMessage(`Plan revision feedback: ${feedback}`)
          .then(() => { setIsProcessing(false); })
          .catch((err: any) => {
            setIsProcessing(false);
            setMasterLogs((prev) => [...prev, `[ERROR] Plan feedback error: ${err.message}`].slice(-500));
          });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        return;
      }

      // Step 1: approve / reject / custom
      const approved = value === "approve" || (typeof value === "string" && value.includes("Approve"));
      if (approved && planState === "APPROVED") return;
      if (approved) {
        agent.approvePlan();
        setPlanState("APPROVED");
        setMasterLogs((prev) => [...prev, "✅ Implementation plan approved! Continuing with the approved plan now."].slice(-500));
        setIsProcessing(true);
        agent.sendMessage("Implementation plan approved via interactive approval wizard. Continue with the approved plan now.")
          .then(() => {
            setIsProcessing(false);
          })
          .catch((err: any) => {
            setIsProcessing(false);
            setMasterLogs((prev) => [...prev, `[ERROR] Plan approval resume error: ${err.message}`].slice(-500));
          });
      } else if (value === "reject" || (typeof value === "string" && value.includes("Reject"))) {
        // Reject — stop the agent process
        agent.planState = "IDLE";
        setPlanState("IDLE");
        agent.abort();
        setIsProcessing(false);
        setMasterLogs((prev) => [...prev, "❌ Implementation plan rejected. Agent process stopped."].slice(-500));
      } else {
        // Custom feedback — transition to step 2
        setWizardOptions([]);
        setActiveWizard({ ...activeWizard, step: 2 });
        return; // Don't close wizard
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
    exit,
    setWorkingDirectory,
  ]);

  const handleQuerySubmit = useCallback((val: string) => {
    setIsPasted(false);
    const cleanVal = val.trim();

    if (activeWizard) {
      if (activeWizard.type === "question" && activeWizard.isMultiSelect) {
        const selectedList = Array.from(wizardSelectedSet).map(idx => wizardOptions[idx]).filter(Boolean);
        const answer = selectedList.join(", ");

        const qList = activeWizard.questions;
        const currIdx = activeWizard.currentQuestionIndex;
        if (qList && currIdx !== undefined) {
          const updatedAnswers = [...(activeWizard.answers || [])];
          updatedAnswers[currIdx] = answer;

          setMasterLogs((prev) => [...prev, `[MASTER] ❓ Answered: "${answer}"`].slice(-500));

          const nextIdx = currIdx + 1;
          if (nextIdx < qList.length) {
            const nextQ = qList[nextIdx];
            const hasOptions = Array.isArray(nextQ.options) && nextQ.options.length > 0;
            const allOptions = hasOptions ? [...nextQ.options, "Custom..."] : [];
            if (pendingQuestion) {
              setPendingQuestion({
                question: nextQ.question,
                options: allOptions,
                resolve: pendingQuestion.resolve,
              });
            }
            setWizardOptions(allOptions);

            const nextSavedAns = updatedAnswers[nextIdx] || "";
            if (nextQ.isMultiSelect) {
              const nextAnsList = nextSavedAns.split(", ").map((x: string) => x.trim());
              const newSet = new Set<number>();
              allOptions.forEach((opt, idx) => {
                if (nextAnsList.includes(opt)) {
                  newSet.add(idx);
                }
              });
              setWizardSelectedSet(newSet);
              setWizardSelectedIndex(0);
            } else {
              const optionIdx = nextQ.options.indexOf(nextSavedAns);
              if (optionIdx >= 0) {
                setWizardSelectedIndex(optionIdx);
              } else {
                setWizardSelectedIndex(0);
              }
              setWizardSelectedSet(new Set());
            }

            setQuery("");

            const optionIdx = nextQ.options.indexOf(nextSavedAns);
            const isCustomAnswer = nextSavedAns !== "" && optionIdx < 0;

            if (isCustomAnswer && !nextQ.isMultiSelect) {
              setWizardOptions([]);
              setWizardSelectedIndex(0);
              setQuery(nextSavedAns);
              setActiveWizard({
                ...activeWizard,
                step: 2,
                currentQuestionIndex: nextIdx,
                answers: updatedAnswers,
                isMultiSelect: nextQ.isMultiSelect,
              });
            } else {
              setActiveWizard({
                ...activeWizard,
                step: hasOptions ? 1 : 2,
                currentQuestionIndex: nextIdx,
                answers: updatedAnswers,
                isMultiSelect: nextQ.isMultiSelect,
              });
            }
          } else {
            if (pendingQuestion) {
              pendingQuestion.resolve(updatedAnswers);
              setPendingQuestion(null);
            }
            setActiveWizard(null);
            setWizardOptions([]);
            setWizardSelectedIndex(0);
            setWizardSelectedSet(new Set());
            setQuery("");
          }
          return;
        }

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
      } else if (activeWizard.type === "model" && (activeWizard.step === 3 || activeWizard.step === 4 || activeWizard.step === 15 || activeWizard.step === 24 || activeWizard.step === 25 || activeWizard.step === 30 || activeWizard.step === 34 || activeWizard.step === 35 || activeWizard.step === 40)) {
        const lc = val.trim();
        const filteredOptions = lc
          ? filterSuggestions(wizardAllOptions, lc)
          : wizardAllOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
        finalValue = filteredOptions[clampedIndex] || cleanVal;
      } else if (activeWizard.type === "workspace" && activeWizard.step === 1) {
        const lc = val.trim();
        const filteredOptions = lc
          ? filterSuggestions(wizardOptions, lc)
          : wizardOptions;
        const clampedIndex = Math.min(wizardSelectedIndex, Math.max(0, filteredOptions.length - 1));
        finalValue = filteredOptions[clampedIndex] || cleanVal;
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
      setWizardOptions([...PLAN_APPROVAL_OPTIONS]);
      setWizardSelectedIndex(0);
      setActiveWizard({
        type: "plan_approve",
        step: 1,
        data: {},
      });
      setQuery("");
      return;
    }

    if (!cleanVal && attachments.length === 0) return;

    if (setSelectedIndex) setSelectedIndex(0);
    if (setLogScrollOffset) setLogScrollOffset(0);

    if (cleanVal) {
      setHistory((prev) => {
        if (prev.length > 0 && prev[prev.length - 1] === cleanVal) {
          return prev;
        }
        const next = [...prev, cleanVal].slice(-200);
        fs.writeFile(HISTORY_FILE, JSON.stringify(next, null, 2), "utf8").catch(() => {});
        return next;
      });
      setHistoryIndex(-1);
    }

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

      const handleAttachImage = async (filePath: string) => {
        try {
          const { readImageFromPath } = await import("../utils/imageUtils.js");
          const attachment = await readImageFromPath(filePath);
          setAttachments((prev) => [...prev, attachment]);
          setMasterLogs((prev) => [...prev, `[SYSTEM] 📎 Image attached: ${attachment.filename}`].slice(-500));
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Could not attach image: ${err.message}`].slice(-500));
        }
      };

      const handlePasteImage = async () => {
        try {
          const { readImageFromClipboard } = await import("../utils/imageUtils.js");
          const attachment = await readImageFromClipboard();
          if (attachment) {
            setAttachments((prev) => [...prev, attachment]);
            setMasterLogs((prev) => [...prev, `[SYSTEM] 📎 Clipboard image attached: ${attachment.filename}`].slice(-500));
          }
        } catch (err: any) {
          setMasterLogs((prev) => [...prev, `[ERROR] Could not paste image: ${err.message}`].slice(-500));
        }
      };

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
            setCachedSessions(listHistorySessions(agent?.isMultiAgent || false, false, undefined, 20).slice(0, 10));
          }
        },
        setWizardOptions,
        setWizardSelectedIndex,
        setPlanState,
        setGoalMode: () => {},
        setIsProcessing: () => {},
        resumeSession: async () => {},
        attachImage: handleAttachImage,
        pasteImage: handlePasteImage,
        resumeFromPath: async (filePath: string) => {
          try {
            await agent.loadHistoryFromPath(filePath);
            const msgs = agent.getHistory().getMessages();
            const loadedLogs: string[] = [];
            for (const m of msgs) {
              const stringContent = m.content ? contentToString(m.content) : "";
              if (m.role === "user" && stringContent) {
                const skillPrefixMatch = stringContent.match(/^I would like you to use the following skill:\s*"(.*?)"\.\nPlease read its instruction file at\s*"(.*?)"/);
                if (skillPrefixMatch) {
                  loadedLogs.push(`[USER] 🛠️ [SKILL USE] ${skillPrefixMatch[1]} (${skillPrefixMatch[2]})`);
                } else {
                  loadedLogs.push(`[USER] ${stringContent}`);
                }
              } else if (m.role === "assistant") {
                if (stringContent) {
                  loadedLogs.push(`[AGENT] ${stringContent}`);
                }
              } else if (m.role === "system") {
                if (stringContent && stringContent.startsWith("[ERROR]")) {
                  loadedLogs.push(stringContent);
                } else if (stringContent) {
                  loadedLogs.push(`[MASTER] ${stringContent}`);
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

    const displayText = commandInput || (attachments.length > 0 ? `[${attachments.length} image${attachments.length > 1 ? "s" : ""}]` : "");
    const displayLine = attachments.length > 0 ? `${displayText} 📎×${attachments.length}` : commandInput;

    let messageContent: import("../core/conversation.js").MessageContent = commandInput;
    if (attachments.length > 0) {
      const parts: import("../core/conversation.js").MessageContent = [
        ...(commandInput ? [{ type: "text" as const, text: commandInput }] : []),
        ...attachments.map(attachmentToImagePart),
      ];
      messageContent = parts;
    }

    if (isProcessing) {
      setMasterLogs((prev) => [...prev, `[USER] ${displayLine}`].slice(-500));
      setQuery("");
      setAttachments([]);
      agent.abort();
      agent.queueMessage(messageContent);
      return;
    }

    setMasterLogs((prev) => [...prev, `[USER] ${displayLine}`].slice(-500));
    setQuery("");
    setCurrentTask(displayLine);

    setIsProcessing(true);
    setAttachments([]);

    agent.sendMessage(messageContent)
      .then(() => {
        setIsProcessing(false);
        setCurrentTask(`Idle - Completed: ${displayText}`);
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
    attachments,
    setAttachments,
  ]);

  return {
    handleWizardSubmit,
    handleQuerySubmit,
  };
}
