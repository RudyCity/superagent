import { useCallback } from "react";
import { 
  getConfiguredProviders, 
  getProviders,
  switchActiveProvider, 
  fetchAndCacheModels, 
  getContextWindowLimit, 
  getModelPresets,
  applyModelPreset,
  saveModelPreset,
  deleteModelPreset,
  BUILT_IN_PRESETS,
  getProviderOptionsList,
  addProvider,
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
  ensureProtocol
} from "../../core/config.js";
import type { PresetMode } from "../../core/config.js";
import { getTierModelConfig } from "../../core/config/providers.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import type { ChatLine } from "../../core/slash-commands.js";
import { handlePresetStep } from "./useModelPresets.js";

function cleanFetchUrl(url: string | undefined): string {
  if (!url) return "";
  const withProtocol = ensureProtocol(url) || "";
  return `${withProtocol.replace(/\/+$/, "")}/models`;
}

interface ModelWizardContext {
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardAllOptions?: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  addLine: (line: ChatLine) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  wizardSelectedIndex: number;
  wizardOptions: string[];
  wizardIsLoadingModels: boolean;
  agentRef?: React.MutableRefObject<any>;
}

export function useModelWizard(ctx: ModelWizardContext) {
  const {
    setActiveWizard,
    setWizardOptions,
    setWizardAllOptions,
    setWizardSelectedIndex,
    addLine,
    setInput,
    setContextLimit,
    setActiveModel,
    setWizardIsLoadingModels,
    wizardSelectedIndex,
    wizardOptions,
    wizardIsLoadingModels,
    agentRef,
  } = ctx;

  const handleModelWizard = useCallback(async (value: string, step: number, data: Record<string, string>) => {
    const now = Date.now();
    const isMulti = agentRef?.current?.isMultiAgent ?? false;

    const presetMode: PresetMode = isMulti ? "multi" : "single";
    const modeLabel = isMulti ? "Multi-Agent" : "Single-Agent";

    /**
     * Sync the agent's ContextManager with the newly selected model.
     * Called after setContextLimit() so the ContextManager's internal
     * model name and threshold stay in sync with the UI state — preventing
     * the Ctx: display from resetting to 0% after a wizard-based model switch.
     */
    const syncContextManagerModel = (modelName: string, limit: number) => {
      const cm = agentRef?.current?.getContextManager?.();
      if (cm) {
        cm.setModel(modelName);
        cm.setThreshold(limit);
      }
    };

    const getStep1Options = (): string[] => {
      if (isMulti) {
        return [
          `1. Load/Apply Model Preset [${modeLabel}]`,
          `2. List Model Presets [${modeLabel}]`,
          `3. Create Model Preset [${modeLabel}]`,
          `4. Edit Model Preset [${modeLabel}]`,
          `5. Delete Model Preset [${modeLabel}]`,
          `6. Configure Agent Tier Models`,
          "< Back"
        ];
      } else {
        return [
          `1. Load/Apply Model Preset [${modeLabel}]`,
          `2. List Model Presets [${modeLabel}]`,
          `3. Create Model Preset [${modeLabel}]`,
          `4. Edit Model Preset [${modeLabel}]`,
          `5. Delete Model Preset [${modeLabel}]`,
          `6. Configure Single Agent Model`,
          `7. Configure Subagent Models`,
          "< Back"
        ];
      }
    };

    const getProfilePickerOptions = (providerType: string): string[] => {
      const providers = getProviders().filter(p => {
        if (providerType === "anthropic") {
          return p.provider === "anthropic" && !p.baseUrl;
        }
        if (providerType === "custom-anthropic") {
          return p.provider === "anthropic" && !!p.baseUrl;
        }
        return p.provider === providerType;
      });
      return providers.map(p => {
        const apiKey = p.apiKey || "";
        const maskedKey = apiKey
          ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
          : "(no key)";
        return `${p.name} (key: ${maskedKey})`;
      });
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
          `7. Feature: classifier (${formatVal(models.MODEL_MULTI_SUBAGENT_CLASSIFIER)})`,
          `8. Feature: advisor (${formatVal(models.MODEL_MULTI_SUBAGENT_ADVISOR)})`,
          "9. Save Preset & Exit",
          "10. Cancel & Exit",
          "< Back"
        ];
      } else {
        return [
          `1. Single Agent Model (${formatVal(models.MODEL_SINGLE_SUPERAGENT || models.MODEL_SINGLE || models.MODEL)})`,
          `2. Subagent (depth 2) (${formatVal(models.MODEL_SINGLE_SUBAGENT)})`,
          `3. Feature: researcher (${formatVal(models.MODEL_SINGLE_SUBAGENT_RESEARCHER)})`,
          `4. Feature: coder (${formatVal(models.MODEL_SINGLE_SUBAGENT_CODER)})`,
          `5. Feature: reviewer (${formatVal(models.MODEL_SINGLE_SUBAGENT_REVIEWER)})`,
          `6. Feature: classifier (${formatVal(models.MODEL_SINGLE_SUBAGENT_CLASSIFIER)})`,
          `7. Feature: advisor (${formatVal(models.MODEL_SINGLE_SUBAGENT_ADVISOR)})`,
          "8. Save Preset & Exit",
          "9. Cancel & Exit",
          "< Back"
        ];
      }
    };

    const isPresetHandled = await handlePresetStep(step, value, data, ctx, {
      presetMode,
      modeLabel,
      isMulti,
      now,
      syncContextManagerModel,
      getPresetOptionsList,
      getStep1Options,
      getProfilePickerOptions,
      cleanFetchUrl,
    });
    if (isPresetHandled) {
      return;
    }

    if (step === 1) {
      const choice = value.toLowerCase();
      if (choice.includes("load") || choice.includes("apply") || choice === "1. load/apply model preset") {
        setActiveWizard({
          type: "model",
          step: 4,
          data: {},
        });
        const presets = getModelPresets(presetMode);
        const options = presets.map(p => `${p.name} - ${p.description}${p.mode ? ` [${p.mode}]` : ""}`);
        const opts = [...options, "< Back"];
        setWizardOptions(opts);
        setWizardAllOptions?.(opts);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (choice.includes("list") || choice === "2. list model presets") {
        const presets = getModelPresets(presetMode);
        const listStr = presets.map(p => {
          const modeInfo = p.mode ? ` [${p.mode}]` : "";
          const modelsStr = Object.entries(p.models).map(([k, v]) => `    - ${k}: ${v}`).join("\n");
          return `- **${p.name}**${modeInfo}: ${p.description}\n${modelsStr}`;
        }).join("\n");
        addLine({
          type: "system",
          content: `Available Model Presets (${modeLabel}):\n${listStr}`,
          timestamp: now,
        });
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
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
        setInput("");
        return;
      }

      if (choice.includes("edit") || choice === "4. edit model preset") {
        const presets = getModelPresets(presetMode);
        const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
        if (customPresets.length === 0) {
          addLine({
            type: "error",
            content: `No custom presets available to edit for ${modeLabel} mode.`,
            timestamp: now,
          });
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
        const opts = [...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"];
        setWizardOptions(opts);
        setWizardAllOptions?.(opts);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (choice.includes("delete") || choice === "5. delete model preset") {
        const presets = getModelPresets(presetMode);
        const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
        if (customPresets.length === 0) {
          addLine({
            type: "error",
            content: `No custom presets available to delete for ${modeLabel} mode.`,
            timestamp: now,
          });
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
        const opts = [...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"];
        setWizardOptions(opts);
        setWizardAllOptions?.(opts);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if ((choice.includes("configure") && !choice.includes("subagent")) || choice === "6. configure agent tier models" || choice === "6. configure single agent model") {
        if (isMulti) {
          const defaultResolved = getResolvedModelWithProvider("", true);
          const rawMaster = getTierModel("multi", "master") || "";
          const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
          const rawSuperagent = getTierModel("multi", "superagent") || "";
          const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
          const rawSubagent = getTierModel("multi", "subagent") || "";
          const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
          const rawResearcher = getTierModel("multi", "researcher") || "";
          const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
          const rawCoder = getTierModel("multi", "coder") || "";
          const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
          const rawReviewer = getTierModel("multi", "reviewer") || "";
          const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;
          const rawClassifier = getTierModel("multi", "classifier") || "";
          const classifierModelFormatted = rawClassifier ? getResolvedModelWithProvider(rawClassifier, false) : `(use default: ${subagentModelFormatted})`;
          const rawAdvisor = getTierModel("multi", "advisor") || "";
          const advisorModelFormatted = rawAdvisor ? getResolvedModelWithProvider(rawAdvisor, false) : `(use default: ${subagentModelFormatted})`;

          setActiveWizard({
            type: "model",
            step: 50,
            data: {},
          });
          setWizardOptions([
            `1. Master Agent (depth 0) (${masterModelFormatted})`,
            `2. Superagent (depth 1) (${superagentModelFormatted})`,
            `3. Subagent (depth 2) (${subagentModelFormatted})`,
            `4. Feature: researcher (${researcherModelFormatted})`,
            `5. Feature: coder (${coderModelFormatted})`,
            `6. Feature: reviewer (${reviewerModelFormatted})`,
            `7. Feature: classifier (${classifierModelFormatted})`,
            `8. Feature: advisor (${advisorModelFormatted})`,
            `9. All Tiers (Overwrite All)`,
            `< Back`
          ]);
        } else {
          setActiveWizard({
            type: "model",
            step: 2,
            data: { tier: "single" },
          });
          setWizardOptions([
            "1. OpenRouter (Recommended)",
            "2. OpenAI",
            "3. Anthropic",
            "4. Custom OpenAI Endpoint",
            "5. Custom Anthropic Endpoint",
            "6. Google Gemini",
            "7. Not Set (Clear Override)",
            "< Back"
          ]);
        }
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (!isMulti && (choice.includes("subagent") || choice === "7. configure subagent models")) {
        const defaultResolved = getResolvedModelWithProvider("", true);
        const rawSubagent = getTierModel("single", "subagent") || "";
        const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
        const rawResearcher = getTierModel("single", "researcher") || "";
        const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
        const rawCoder = getTierModel("single", "coder") || "";
        const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
        const rawReviewer = getTierModel("single", "reviewer") || "";
        const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;
        const rawClassifier = getTierModel("single", "classifier") || "";
        const classifierModelFormatted = rawClassifier ? getResolvedModelWithProvider(rawClassifier, false) : `(use default: ${subagentModelFormatted})`;
        const rawAdvisor = getTierModel("single", "advisor") || "";
        const advisorModelFormatted = rawAdvisor ? getResolvedModelWithProvider(rawAdvisor, false) : `(use default: ${subagentModelFormatted})`;

        setActiveWizard({
          type: "model",
          step: 50,
          data: {},
        });
        setWizardOptions([
          `1. Subagent (depth 2) (${subagentModelFormatted})`,
          `2. Feature: researcher (${researcherModelFormatted})`,
          `3. Feature: coder (${coderModelFormatted})`,
          `4. Feature: reviewer (${reviewerModelFormatted})`,
          `5. Feature: classifier (${classifierModelFormatted})`,
          `6. Feature: advisor (${advisorModelFormatted})`,
          `7. All Subagent Tiers`,
          `< Back`
        ]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (choice.includes("back") || choice === "< back") {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      setActiveWizard(null);
      setWizardOptions([]);
      setWizardSelectedIndex(0);
    } else if (step === 50) {
      if (value === "< Back" || value === "back") {
        setActiveWizard({
          type: "model",
          step: 1,
          data: {},
        });
        setWizardOptions(getStep1Options());
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      let tier = "";
      const choice = value.toLowerCase();
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
      } else if (choice.includes("classifier")) {
        tier = "classifier";
      } else if (choice.includes("advisor")) {
        tier = "advisor";
      } else if (choice.includes("default model")) {
        tier = "default";
      } else if (choice.includes("all subagent tiers") || choice.includes("all_subagents")) {
        tier = "all_subagents";
      } else if (choice.includes("all tiers")) {
        tier = "all";
      } else {
        if (isMulti) {
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "classifier", "advisor", "all"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "master";
        } else {
          const tiers = ["subagent", "researcher", "coder", "reviewer", "classifier", "advisor", "all_subagents"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "subagent";
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
        "4. Custom OpenAI Endpoint",
        "5. Custom Anthropic Endpoint",
        "6. Google Gemini",
        "7. Not Set (Clear Override)",
        "< Back"
      ]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 2) {
      if (value === "< Back") {
        const defaultResolved = getResolvedModelWithProvider("", true);
        const rawMaster = getTierModel("multi", "master") || "";
        const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
        const rawSuperagent = getTierModel("multi", "superagent") || "";
        const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
        const rawSubagent = getTierModel(isMulti ? "multi" : "single", "subagent") || "";
        const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
        const rawResearcher = getTierModel(isMulti ? "multi" : "single", "researcher") || "";
        const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
        const rawCoder = getTierModel(isMulti ? "multi" : "single", "coder") || "";
        const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
        const rawReviewer = getTierModel(isMulti ? "multi" : "single", "reviewer") || "";
        const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;
        const rawClassifier = getTierModel(isMulti ? "multi" : "single", "classifier") || "";
        const classifierModelFormatted = rawClassifier ? getResolvedModelWithProvider(rawClassifier, false) : `(use default: ${subagentModelFormatted})`;
        const rawAdvisor = getTierModel(isMulti ? "multi" : "single", "advisor") || "";
        const advisorModelFormatted = rawAdvisor ? getResolvedModelWithProvider(rawAdvisor, false) : `(use default: ${subagentModelFormatted})`;

        if (isMulti || (data.tier && data.tier !== "single")) {
          setActiveWizard({
            type: "model",
            step: 50,
            data: { ...data },
          });
          if (isMulti) {
            setWizardOptions([
              `1. Master Agent (depth 0) (${masterModelFormatted})`,
              `2. Superagent (depth 1) (${superagentModelFormatted})`,
              `3. Subagent (depth 2) (${subagentModelFormatted})`,
              `4. Feature: researcher (${researcherModelFormatted})`,
              `5. Feature: coder (${coderModelFormatted})`,
              `6. Feature: reviewer (${reviewerModelFormatted})`,
              `7. Feature: classifier (${classifierModelFormatted})`,
              `8. Feature: advisor (${advisorModelFormatted})`,
              `9. All Tiers (Overwrite All)`,
              `< Back`
            ]);
          } else {
            setWizardOptions([
              `1. Superagent (depth 1) (${superagentModelFormatted})`,
              `2. Subagent (depth 2) (${subagentModelFormatted})`,
              `3. Feature: researcher (${researcherModelFormatted})`,
              `4. Feature: coder (${coderModelFormatted})`,
              `5. Feature: reviewer (${reviewerModelFormatted})`,
              `6. Feature: classifier (${classifierModelFormatted})`,
              `7. Feature: advisor (${advisorModelFormatted})`,
              `8. All Tiers (Overwrite All)`,
              `< Back`
            ]);
          }
        } else {
          setActiveWizard({
            type: "model",
            step: 1,
            data: {},
          });
          setWizardOptions(getStep1Options());
        }
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      // Check if value matches an existing configured provider
      const step2ProvidersList = getConfiguredProviders();
      const step2CleanedVal = value.replace(" [Active]", "").trim();
      const step2FoundProvider = step2ProvidersList.find(p => {
        const optionLabel = `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})`;
        return step2CleanedVal.toLowerCase() === optionLabel.toLowerCase() || step2CleanedVal.toLowerCase() === p.name.toLowerCase();
      });

      if (step2FoundProvider) {
        const profileName = step2FoundProvider.name;
        const providerType = step2FoundProvider.type;
        const resolvedBaseUrl = step2FoundProvider.baseUrl || "";
        const resolvedApiKey = step2FoundProvider.apiKey || "";

        setActiveWizard({
          type: "model",
          step: 15,
          data: { ...data, provider: profileName, providerType },
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
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
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
                    const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                    setWizardOptions(opts);
                    setWizardAllOptions?.(opts);
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
        } else if (providerType === "gemini") {
          initialModels = [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
          ];
          if (resolvedApiKey) {
            setWizardIsLoadingModels(true);
            fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${resolvedApiKey}`)
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.models)) {
                    const modelsList = data.models.map((m: any) => m.name.replace(/^models\//, ""));
                    const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                    setWizardOptions(opts);
                    setWizardAllOptions?.(opts);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "custom-anthropic") {
          initialModels = [
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ];
          if (resolvedBaseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
            fetch(cleanFetchUrl(resolvedBaseUrl), { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                    setWizardOptions(opts);
                    setWizardAllOptions?.(opts);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "custom") {
          initialModels = [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ];
          if (resolvedBaseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
            fetch(cleanFetchUrl(resolvedBaseUrl), { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                    setWizardOptions(opts);
                    setWizardAllOptions?.(opts);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        const initialOpts = [...initialModels, "+ Custom Model (Input manually)", "< Back"];
        setWizardOptions(initialOpts);
        setWizardAllOptions?.(initialOpts);
        setWizardSelectedIndex(0);
        setInput("");
        addLine({
          type: "system",
          content: `Provider profile "${profileName}" selected. Choose a model below:`,
          timestamp: now,
        });
        return;
      }

      if (value.toLowerCase().includes("not set") || value === "5" || value === "6" || value === "7") {
        const tier = data.tier || "";
        let targetLabel = "";
        let didClear = false;
        if (tier === "master") {
          clearTierModel(presetMode, "master");
          targetLabel = "Master Agent (depth 0)";
          didClear = true;
        } else if (tier === "superagent") {
          clearTierModel(presetMode, "superagent");
          targetLabel = "Superagent (depth 1)";
          didClear = true;
        } else if (tier === "subagent") {
          clearTierModel(presetMode, "subagent");
          targetLabel = "Subagent (depth 2)";
          didClear = true;
        } else if (tier === "researcher") {
          clearTierModel(presetMode, "researcher");
          targetLabel = `Subagent "researcher"`;
          didClear = true;
        } else if (tier === "coder") {
          clearTierModel(presetMode, "coder");
          targetLabel = `Subagent "coder"`;
          didClear = true;
        } else if (tier === "reviewer") {
          clearTierModel(presetMode, "reviewer");
          targetLabel = `Subagent "reviewer"`;
          didClear = true;
        } else if (tier === "classifier") {
          clearTierModel(presetMode, "classifier");
          targetLabel = `Subagent "classifier"`;
          didClear = true;
        } else if (tier === "advisor") {
          clearTierModel(presetMode, "advisor");
          targetLabel = `Subagent "advisor"`;
          didClear = true;
        } else if (tier === "all_subagents") {
          clearTierModel(presetMode, "subagent");
          clearTierModel(presetMode, "researcher");
          clearTierModel(presetMode, "coder");
          clearTierModel(presetMode, "reviewer");
          clearTierModel(presetMode, "classifier");
          clearTierModel(presetMode, "advisor");
          targetLabel = "All Subagents";
          didClear = true;
        } else if (tier === "all") {
          setAllTierModels(presetMode, "");
          targetLabel = "All Tiers";
          didClear = true;
        } else if (tier === "single") {
          clearTierModel(presetMode, "master");
          targetLabel = "Single Agent";
          didClear = true;
        }
        if (didClear) {
          const effectiveMasterModel = getEffectiveMasterModel(presetMode) || getDefaultModel();
          setActiveModel(effectiveMasterModel);
          addLine({
            type: "system",
            content: `${targetLabel} model override cleared (not set).`,
            timestamp: now,
          });
        }
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const choice = value.toLowerCase();
      let providerType = "";
      if (choice.includes("openrouter") || choice === "1") {
        providerType = "openrouter";
      } else if ((choice.includes("openai") && !choice.includes("custom")) || choice === "2") {
        providerType = "openai";
      } else if ((choice.includes("anthropic") && !choice.includes("custom")) || choice === "3") {
        providerType = "anthropic";
      } else if ((choice.includes("custom") && choice.includes("openai")) || choice === "4") {
        providerType = "custom";
      } else if ((choice.includes("custom") && choice.includes("anthropic")) || choice === "5") {
        providerType = "custom-anthropic";
      } else if (choice.includes("gemini") || choice.includes("google") || choice === "6") {
        providerType = "gemini";
      } else {
        addLine({
          type: "error",
          content: "Invalid provider type choice.",
          timestamp: now,
        });
        return;
      }

      setActiveWizard({
        type: "model",
        step: 3,
        data: { ...data, providerType },
      });

      const list = getConfiguredProviders();
      const matchingProfiles = list.filter(p => {
        if (providerType === "anthropic") {
          return p.type === "anthropic" && !p.baseUrl;
        }
        if (providerType === "custom-anthropic") {
          return p.type === "anthropic" && !!p.baseUrl;
        }
        return p.type === providerType;
      });
      const profileOptions = formatProviderForPicker(matchingProfiles);

      const opts = [
        ...profileOptions,
        `+ Configure a new ${providerType} profile`,
        "< Back"
      ];
      setWizardOptions(opts);
      setWizardAllOptions?.(opts);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 3) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 2,
          data: { ...data },
        });
        setWizardOptions([
          "1. OpenRouter (Recommended)",
          "2. OpenAI",
          "3. Anthropic",
          "4. Custom OpenAI Endpoint",
          "5. Custom Anthropic Endpoint",
          "6. Google Gemini",
          "7. Not Set (Clear Override)",
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const providerType = data.providerType;
      if (value.startsWith("+ Configure a new")) {
        setActiveWizard({
          type: "model",
          step: 6,
          data: { ...data },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        addLine({
          type: "system",
          content: `Configure new profile. Please enter a profile name (alphanumeric, e.g. ${providerType}_dev):`,
          timestamp: now,
        });
        return;
      }

      const profileName = value.split(" (key:")[0].trim();
      const list = getConfiguredProviders();
      const found = list.find(p => p.name.toLowerCase() === profileName.toLowerCase());
      
      let resolvedApiKey = "";
      let resolvedBaseUrl = "";
      if (found) {
        resolvedBaseUrl = found.baseUrl || "";
        resolvedApiKey = found.apiKey || "";
      }

      setActiveWizard({
        type: "model",
        step: 15,
        data: { ...data, provider: profileName },
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
                const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                setWizardOptions(opts);
                setWizardAllOptions?.(opts);
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
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
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
      } else if (providerType === "gemini") {
        initialModels = [
          "gemini-2.5-flash",
          "gemini-2.5-pro",
          "gemini-2.0-flash",
          "gemini-2.0-flash-lite",
          "gemini-1.5-flash",
          "gemini-1.5-pro",
        ];
        if (resolvedApiKey) {
          setWizardIsLoadingModels(true);
          fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${resolvedApiKey}`)
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.models)) {
                  const modelsList = data.models.map((m: any) => m.name.replace(/^models\//, ""));
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        }
      } else if (providerType === "custom-anthropic") {
        initialModels = [
          "claude-3-5-sonnet-20241022",
          "claude-3-5-haiku-20241022",
          "claude-3-opus-20240229",
        ];
        if (resolvedBaseUrl) {
          setWizardIsLoadingModels(true);
          const headers: Record<string, string> = {};
          if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
          fetch(cleanFetchUrl(resolvedBaseUrl), { headers })
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList = data.data.map((m: any) => m.id);
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        }
      } else if (providerType === "custom") {
        initialModels = [
          "deepseek-chat", "llama-3.3-70b-instruct",
        ];
        if (resolvedBaseUrl) {
          setWizardIsLoadingModels(true);
          const headers: Record<string, string> = {};
          if (resolvedApiKey) headers["Authorization"] = `Bearer ${resolvedApiKey}`;
          fetch(cleanFetchUrl(resolvedBaseUrl), { headers })
            .then(async (res) => {
              if (res.ok) {
                const data = await res.json() as any;
                if (data && Array.isArray(data.data)) {
                  const modelsList = data.data.map((m: any) => m.id);
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
                }
              }
            })
            .catch(() => {})
            .finally(() => setWizardIsLoadingModels(false));
        }
      }

      const initialOpts = [...initialModels, "+ Custom Model (Input manually)", "< Back"];
      setWizardOptions(initialOpts);
      setWizardAllOptions?.(initialOpts);
      setWizardSelectedIndex(0);
      setInput("");
      addLine({
        type: "system",
        content: `Provider profile "${profileName}" selected. Choose a model below:`,
        timestamp: now,
      });
    } else if (step === 6) {
      if (value === "< Back") {
        const providerType = data.providerType;
        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...data },
        });
        const list = getConfiguredProviders();
        const matchingProfiles = list.filter(p => {
          if (providerType === "anthropic") {
            return p.type === "anthropic" && !p.baseUrl;
          }
          if (providerType === "custom-anthropic") {
            return p.type === "anthropic" && !!p.baseUrl;
          }
          return p.type === providerType;
        });
        const profileOptions = formatProviderForPicker(matchingProfiles);
        const opts = [
          ...profileOptions,
          `+ Configure a new ${providerType} profile`,
          "< Back"
        ];
        setWizardOptions(opts);
        setWizardAllOptions?.(opts);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
      const providerType = data.providerType;
      const profileName = nameInput || providerType;

      if (providerType === "custom" || providerType === "custom-anthropic") {
        setActiveWizard({
          type: "model",
          step: 7,
          data: { ...data, name: profileName },
        });
        addLine({
          type: "system",
          content: `Profile name: ${profileName}. Please enter Base URL for Custom Endpoint (e.g. http://localhost:11434/v1):`,
          timestamp: now,
        });
      } else {
        setActiveWizard({
          type: "model",
          step: 8,
          data: { ...data, name: profileName },
        });
        addLine({
          type: "system",
          content: `Profile name: ${profileName}. Please enter API Key:`,
          timestamp: now,
        });
      }
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 7) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 6,
          data: { ...data },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const baseUrl = value.trim();
      setActiveWizard({
        type: "model",
        step: 8,
        data: { ...data, baseUrl },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
      addLine({
        type: "system",
        content: `Base URL: ${baseUrl}. Please enter API Key:`,
        timestamp: now,
      });
    } else if (step === 8) {
      if (value === "< Back") {
        const providerType = data.providerType;
        if (providerType === "custom" || providerType === "custom-anthropic") {
          setActiveWizard({
            type: "model",
            step: 7,
            data: { ...data },
          });
        } else {
          setActiveWizard({
            type: "model",
            step: 6,
            data: { ...data },
          });
        }
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const apiKey = value.trim();
      const providerType = data.providerType;
      const profileName = data.name;
      const baseUrl = data.baseUrl;


      try {
        const newProviderId = profileName.toLowerCase().replace(/[^a-z0-9_-]/g, "");
        addProvider({
          id: newProviderId,
          name: profileName,
          provider: providerType === "custom-anthropic" ? "anthropic" : providerType,
          apiKey: apiKey,
          baseUrl: baseUrl || (providerType === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
        });
        // Activate the newly created provider in all preset tiers
        switchActiveProvider(newProviderId);

        addLine({
          type: "system",
          content: `Successfully configured provider profile: ${profileName} (${providerType})!\nSaved to model-config.json`,
          timestamp: now,
        });
        
        const nextStep = data.isPreset === "true"
          ? Number(data.returnStep)
          : 15;

        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data, provider: profileName },
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
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
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
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
                }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "gemini") {
          initialModels = [
            "gemini-2.5-flash",
            "gemini-2.5-pro",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-1.5-flash",
            "gemini-1.5-pro",
          ];
          if (apiKey) {
            setWizardIsLoadingModels(true);
            fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`)
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                if (data && Array.isArray(data.models)) {
                  const modelsList = data.models.map((m: any) => m.name.replace(/^models\//, ""));
                  const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                  setWizardOptions(opts);
                  setWizardAllOptions?.(opts);
                }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "custom-anthropic") {
          initialModels = [
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229",
          ];
          if (baseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
            fetch(cleanFetchUrl(baseUrl), { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                    setWizardOptions(opts);
                    setWizardAllOptions?.(opts);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        } else if (providerType === "custom") {
          initialModels = [
            "deepseek-chat", "llama-3.3-70b-instruct",
          ];
          if (baseUrl) {
            setWizardIsLoadingModels(true);
            const headers: Record<string, string> = {};
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
            fetch(cleanFetchUrl(baseUrl), { headers })
              .then(async (res) => {
                if (res.ok) {
                  const data = await res.json() as any;
                  if (data && Array.isArray(data.data)) {
                    const modelsList = data.data.map((m: any) => m.id);
                    const opts = [...modelsList, "+ Custom Model (Input manually)", "< Back"];
                    setWizardOptions(opts);
                    setWizardAllOptions?.(opts);
                  }
                }
              })
              .catch(() => {})
              .finally(() => setWizardIsLoadingModels(false));
          }
        }

        const initialOpts = [...initialModels, "+ Custom Model (Input manually)", "< Back"];
        setWizardOptions(initialOpts);
        setWizardAllOptions?.(initialOpts);
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
// step 5 deleted


    } else if (step === 15) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...data },
        });
        const providerType = data.providerType;
        const list = getConfiguredProviders();
        const matchingProfiles = list.filter(p => {
          if (providerType === "anthropic") {
            return p.type === "anthropic" && !p.baseUrl;
          }
          if (providerType === "custom-anthropic") {
            return p.type === "anthropic" && !!p.baseUrl;
          }
          return p.type === providerType;
        });
        const profileOptions = formatProviderForPicker(matchingProfiles);
        const opts = [
          ...profileOptions,
          `+ Configure a new ${providerType} profile`,
          "< Back"
        ];
        setWizardOptions(opts);
        setWizardAllOptions?.(opts);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (value === "+ Custom Model (Input manually)") {
        const currentOptions = (ctx as any).wizardAllOptions && (ctx as any).wizardAllOptions.length > 0 ? (ctx as any).wizardAllOptions : wizardOptions;
        setActiveWizard({
          type: "model",
          step: 16,
          data: { ...data, isPreset: "false", prevStep: "15", modelOptions: JSON.stringify(currentOptions) },
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

      // Model selected
      const modelName = value;
      const currentOptions = (ctx as any).wizardAllOptions && (ctx as any).wizardAllOptions.length > 0 ? (ctx as any).wizardAllOptions : wizardOptions;
      
      setActiveWizard({
        type: "model",
        step: 60,
        data: {
          ...data,
          tempModelName: modelName,
          modelOptions: JSON.stringify(currentOptions),
        },
      });

      const opts = ["1. Yes", "2. No", "< Back"];
      setWizardOptions(opts);
      if (setWizardAllOptions) setWizardAllOptions(opts);
      setWizardSelectedIndex(0);
      setInput("");
      addLine({
        type: "system",
        content: `Does the model "${modelName}" support vision/image inputs?`,
        timestamp: now,
      });
    } else if (step === 60) {
      if (value === "< Back") {
        // Return to step 15
        setActiveWizard({
          type: "model",
          step: 15,
          data: { ...data },
        });
        const opts = data.modelOptions ? JSON.parse(data.modelOptions) : [];
        setWizardOptions(opts);
        if (setWizardAllOptions) setWizardAllOptions(opts);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const lowerVal = value.toLowerCase().trim();
      const supportsVision =
        lowerVal === "1. yes" ||
        lowerVal === "yes" ||
        lowerVal === "y" ||
        lowerVal === "ya" ||
        lowerVal === "true" ||
        lowerVal === "1" ||
        lowerVal.startsWith("1.");
      const modelName = data.tempModelName;

      try {
        const profileName = data.provider;
        const tier = data.tier;
        let targetLabel = "";
        if (tier === "default") {
          switchActiveProvider(profileName);
          setAllTierModels(presetMode, `${profileName.toLowerCase()}@${modelName}`, undefined, supportsVision);
          targetLabel = "Default Model";
        } else if (tier === "all_subagents") {
          const finalModelName = `${profileName.toLowerCase()}@${modelName}`;
          setTierModel(presetMode, "subagent", finalModelName, undefined, supportsVision);
          setTierModel(presetMode, "researcher", finalModelName, undefined, supportsVision);
          setTierModel(presetMode, "coder", finalModelName, undefined, supportsVision);
          setTierModel(presetMode, "reviewer", finalModelName, undefined, supportsVision);
          setTierModel(presetMode, "classifier", finalModelName, undefined, supportsVision);
          setTierModel(presetMode, "rmemory", finalModelName, undefined, supportsVision);
          setTierModel(presetMode, "advisor", finalModelName, undefined, supportsVision);
          targetLabel = "All Subagent Models";
          switchActiveProvider(profileName);
        } else if (tier === "all") {
          const finalModelName = `${profileName.toLowerCase()}@${modelName}`;
          setAllTierModels(presetMode, finalModelName, undefined, supportsVision);
          targetLabel = "All Tiers & Subagents";
          switchActiveProvider(profileName);
        } else {
          const finalModelName = `${profileName.toLowerCase()}@${modelName}`;
          
          if (tier === "master") {
            setTierModel(presetMode, "master", finalModelName, undefined, supportsVision);
            targetLabel = isMulti ? "Master Agent (depth 0) Model" : "Single Agent Model";
          } else if (tier === "superagent") {
            setTierModel(presetMode, "superagent", finalModelName, undefined, supportsVision);
            targetLabel = "Superagent (depth 1) Model";
          } else if (tier === "subagent") {
            setTierModel(presetMode, "subagent", finalModelName, undefined, supportsVision);
            targetLabel = "Subagent (depth 2) Model";
          } else if (tier === "single") {
            setTierModel(presetMode, "master", finalModelName, undefined, supportsVision);
            targetLabel = "Single Agent Model";
          } else {
            setTierModel(presetMode, tier, finalModelName, undefined, supportsVision);
            targetLabel = `Subagent "${tier}" Model`;
          }
        }

        const cleanModelName = modelName.includes("@") ? modelName.substring(modelName.indexOf("@") + 1) : modelName;
        const limit = getContextWindowLimit(cleanModelName);
        
        const isSingle = !isMulti;
        const effectiveModel = isSingle
          ? (getEffectiveMasterModel(isMulti ? "multi" : "single") || getDefaultModel())
          : (getEffectiveMasterModel(isMulti ? "multi" : "single") || getDefaultModel());
        const cleanModel = effectiveModel.includes("@") ? effectiveModel.substring(effectiveModel.indexOf("@") + 1) : effectiveModel;
        const newLimit = getContextWindowLimit(cleanModel);
        setContextLimit(newLimit);
        setActiveModel(effectiveModel);
        syncContextManagerModel(cleanModel, newLimit);
        
        let updatedList = `\n\nUpdated Models:\n`;
        if (isMulti) {
          const masterModel = getTierModel("multi", "master") || "(use default)";
          const superagentModel = getTierModel("multi", "superagent") || "(use default)";
          const subagentModel = getTierModel("multi", "subagent") || "(use default)";
          updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          const allModels = getAllTierModels("multi");
          for (const [key, val] of Object.entries(allModels)) {
            if (key.startsWith("subagent_") && val && val !== "(use default)") {
              const name = key.replace("subagent_", "");
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${val}`;
              }
            }
          }
        } else {
          const singleModel = getEffectiveMasterModel("single") || "(use default)";
          const singleCfg = getTierModelConfig("single", "superagent");
          const visionTag = singleCfg?.supportsVision === true
            ? " [👁 Vision: ON]"
            : singleCfg?.supportsVision === false
            ? " [Vision: OFF]"
            : "";
          updatedList += `  Single Agent: ${singleModel}${visionTag}`;
          const subagentModel = getTierModel("single", "subagent") || "";
          if (subagentModel) {
            updatedList += `\n  Subagent (depth 2): ${subagentModel}`;
          }
          const allModelsSingle = getAllTierModels("single");
          for (const [key, val] of Object.entries(allModelsSingle)) {
            if (key.startsWith("subagent_") && val && val !== "(use default)") {
              const name = key.replace("subagent_", "");
              updatedList += `\n  Subagent "${name}": ${val}`;
            }
          }
        }

        addLine({
          type: "system",
          content: `${targetLabel} successfully changed to: ${modelName} (via provider ${profileName})\nContext limit: ${limit.toLocaleString()} tokens\nSupports Vision: ${supportsVision ? "Yes" : "No"}${updatedList}`,
          timestamp: now,
        });
        
        if (tier === "default" || tier === "all") {
          fetchAndCacheModels()
            .then(() => {
              const newLimit = getContextWindowLimit(cleanModelName);
              setContextLimit(newLimit);
              syncContextManagerModel(cleanModelName, newLimit);
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

    } else if (step === 16) {
      // Step 16: Capture manually entered model ID
      const selectedModel = value.trim();
      if (!selectedModel) {
        addLine({
          type: "error",
          content: "Model ID cannot be empty. Please enter a valid model ID:",
          timestamp: now,
        });
        return;
      }
      
      const isPreset = data.isPreset === "true";
      const prevStep = parseInt(data.prevStep || "15", 10);
      
      if (isPreset) {
        const profileName = data.provider || "";
        const tier = data.tier || "";
        const finalModelName = `${profileName.toLowerCase()}@${selectedModel}`;
        const presetModels: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
        const currentOptions = data.modelOptions ? JSON.parse(data.modelOptions) : [];

        // Transition to vision choice step for preset (step 61 for create, step 62 for edit)
        setActiveWizard({
          type: "model",
          step: prevStep === 24 ? 61 : 62,
          data: {
            ...data,
            tempFinalModelName: finalModelName,
            tempTier: tier,
            tempPresetModels: JSON.stringify(presetModels),
            tempStep: String(prevStep),
            modelOptions: JSON.stringify(currentOptions),
          },
        });

        const opts = ["1. Yes", "2. No", "< Back"];
        setWizardOptions(opts);
        if (setWizardAllOptions) setWizardAllOptions(opts);
        setWizardSelectedIndex(0);
        setInput("");
        addLine({
          type: "system",
          content: `Does the model "${selectedModel}" support vision/image inputs?`,
          timestamp: now,
        });
      } else {
        // Direct flow: Transition to vision choice step for direct configure (step 60)
        const currentOptions = data.modelOptions ? JSON.parse(data.modelOptions) : [];
        
        setActiveWizard({
          type: "model",
          step: 60,
          data: {
            ...data,
            tempModelName: selectedModel,
            modelOptions: JSON.stringify(currentOptions),
          },
        });

        const opts = ["1. Yes", "2. No", "< Back"];
        setWizardOptions(opts);
        if (setWizardAllOptions) setWizardAllOptions(opts);
        setWizardSelectedIndex(0);
        setInput("");
        addLine({
          type: "system",
          content: `Does the model "${selectedModel}" support vision/image inputs?`,
          timestamp: now,
        });
      }


    } else {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 2,
          data: { ...data },
        });
        const list = getConfiguredProviders();
        const providerOptions = getProviderOptionsList(list);
        setWizardOptions(providerOptions);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      const modelName = value;
      try {
        const profileName = data.provider;
        const tier = data.tier;
        let targetLabel = "";
        if (tier === "default") {
          switchActiveProvider(profileName);
          setAllTierModels(presetMode, `${profileName.toLowerCase()}@${modelName}`);
          targetLabel = "Default Model";
        } else if (tier === "all") {
          const finalModelName = `${profileName.toLowerCase()}@${modelName}`;
          setAllTierModels(presetMode, finalModelName);
          targetLabel = "All Tiers & Subagents";
          switchActiveProvider(profileName);
        } else {
          const finalModelName = `${profileName.toLowerCase()}@${modelName}`;
          
          if (tier === "master") {
            setTierModel(presetMode, "master", finalModelName);
            targetLabel = isMulti ? "Master Agent (depth 0) Model" : "Single Agent Model";
          } else if (tier === "superagent") {
            setTierModel(presetMode, "superagent", finalModelName);
            targetLabel = "Superagent (depth 1) Model";
          } else if (tier === "subagent") {
            setTierModel(presetMode, "subagent", finalModelName);
            targetLabel = "Subagent (depth 2) Model";
          } else {
            setTierModel(presetMode, tier, finalModelName);
            targetLabel = `Subagent "${tier}" Model`;
          }
        }

        const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
        const limit = getContextWindowLimit(cleanModelName);
        
        const isSingle = !isMulti;
        const effectiveModel = isSingle
          ? (getEffectiveMasterModel(isMulti ? "multi" : "single") || getDefaultModel())
          : (getEffectiveMasterModel(isMulti ? "multi" : "single") || getDefaultModel());
        const cleanModel = effectiveModel.includes("@") ? effectiveModel.substring(effectiveModel.indexOf("@") + 1) : effectiveModel;
        const newLimit = getContextWindowLimit(cleanModel);
        setContextLimit(newLimit);
        setActiveModel(effectiveModel);
        syncContextManagerModel(cleanModel, newLimit);
        
        const currentModel = getEffectiveMasterModel(isMulti ? "multi" : "single") || getDefaultModel();
        
        let updatedList = `\n\nUpdated Models:\n`;
        if (isMulti) {
          const masterModel = getTierModel("multi", "master") || "(use default)";
          const superagentModel = getTierModel("multi", "superagent") || "(use default)";
          const subagentModel = getTierModel("multi", "subagent") || "(use default)";
          updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          const allModels = getAllTierModels("multi");
          for (const [key, value] of Object.entries(allModels)) {
            if (key.startsWith("subagent_") && value && value !== "(use default)") {
              const name = key.replace("subagent_", "");
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${value}`;
              }
            }
          }
        } else {
          const singleModel = getEffectiveMasterModel(isMulti ? "multi" : "single") || getDefaultModel();
          const subagentModel = getTierModel("single", "subagent") || "(use default)";
          updatedList += `  Single Agent: ${singleModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          const allModelsSingle = getAllTierModels("single");
          for (const [key, value] of Object.entries(allModelsSingle)) {
            if (key.startsWith("subagent_") && value && value !== "(use default)") {
              const name = key.replace("subagent_", "");
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${value}`;
              }
            }
          }
        }

        addLine({
          type: "system",
          content: `${targetLabel} successfully changed to: ${modelName} (via provider ${profileName})\nContext limit: ${limit.toLocaleString()} tokens\nSession only — use Save Preset to persist${updatedList}`,
          timestamp: now,
        });
        
        if (tier === "default" || tier === "all") {
          fetchAndCacheModels()
            .then(() => {
              const newLimit = getContextWindowLimit(cleanModelName);
              setContextLimit(newLimit);
              syncContextManagerModel(cleanModelName, newLimit);
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
  }, [
    setActiveWizard,
    setWizardOptions,
    setWizardSelectedIndex,
    addLine,
    setInput,
    setContextLimit,
    setActiveModel,
    setWizardIsLoadingModels,
    wizardSelectedIndex,
  ]);

  return handleModelWizard;
}
