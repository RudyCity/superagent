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
import { handleProviderStep } from "./useModelProviders.js";

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
      const providers = getConfiguredProviders().filter(p => {
        if (providerType === "anthropic") {
          return p.type === "anthropic" && !p.baseUrl;
        }
        if (providerType === "custom-anthropic") {
          return p.type === "anthropic" && !!p.baseUrl;
        }
        return p.type === providerType;
      });
      return formatProviderForPicker(providers);
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
    } else {
      await handleProviderStep(step, value, data, ctx, {
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
