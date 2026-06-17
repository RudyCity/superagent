import { useCallback } from "react";
import { 
  getConfiguredProviders, 
  switchActiveProvider, 
  fetchAndCacheModels, 
  getContextWindowLimit, 
  updateEnvFile,
  getModelPresets,
  applyModelPreset,
  saveModelPreset,
  deleteModelPreset,
  BUILT_IN_PRESETS,
  getProviderOptionsList,
  addProvider
} from "../../core/config.js";
import type { PresetMode } from "../../core/config.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import type { ChatLine } from "../../core/slash-commands.js";

interface ModelWizardContext {
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
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

    const getStep1Options = (): string[] => {
      return [
        `1. Load/Apply Model Preset [${modeLabel}]`,
        `2. List Model Presets [${modeLabel}]`,
        `3. Create Model Preset [${modeLabel}]`,
        `4. Edit Model Preset [${modeLabel}]`,
        `5. Delete Model Preset [${modeLabel}]`,
        "< Back"
      ];
    };

    const getPresetOptionsList = (models: Record<string, string>): string[] => {
      const formatVal = (val?: string) => val ? val : "(not set)";
      if (isMulti) {
        return [
          `1. Master Agent (depth 0) (${formatVal(models.MODEL_MULTI_DEPTH_0 || models.MODEL_MULTI_DEPT0 || models.MODEL_MULTI_MASTER || models.MODEL_DEPTH_0 || models.MODEL_DEPT0)})`,
          `2. Superagent (depth 1) (${formatVal(models.MODEL_MULTI_DEPTH_1 || models.MODEL_MULTI_DEPT1 || models.MODEL_MULTI_SUPERAGENT || models.MODEL_DEPTH_1 || models.MODEL_DEPT1)})`,
          `3. Subagent (depth 2) (${formatVal(models.MODEL_MULTI_DEPTH_2 || models.MODEL_MULTI_DEPT2 || models.MODEL_MULTI_SUBAGENT || models.MODEL_DEPTH_2 || models.MODEL_DEPT2)})`,
          `4. Subagent: researcher (${formatVal(models.MODEL_MULTI_SUBAGENT_RESEARCHER || models.MODEL_MULTI_RESEARCHER || models.MODEL_SUBAGENT_RESEARCHER || models.MODEL_RESEARCHER)})`,
          `5. Subagent: coder (${formatVal(models.MODEL_MULTI_SUBAGENT_CODER || models.MODEL_MULTI_CODER || models.MODEL_SUBAGENT_CODER || models.MODEL_CODER)})`,
          `6. Subagent: reviewer (${formatVal(models.MODEL_MULTI_SUBAGENT_REVIEWER || models.MODEL_MULTI_REVIEWER || models.MODEL_SUBAGENT_REVIEWER || models.MODEL_REVIEWER)})`,
          "7. Save Preset & Exit",
          "8. Cancel & Exit",
          "< Back"
        ];
      } else {
        return [
          `1. Single Agent Model (${formatVal(models.MODEL_SINGLE || models.MODEL)})`,
          `2. Subagent (depth 2) (${formatVal(models.MODEL_SINGLE_SUBAGENT || models.MODEL_SINGLE_DEPTH_2)})`,
          `3. Subagent: researcher (${formatVal(models.MODEL_SINGLE_SUBAGENT_RESEARCHER || models.MODEL_SINGLE_RESEARCHER)})`,
          `4. Subagent: coder (${formatVal(models.MODEL_SINGLE_SUBAGENT_CODER || models.MODEL_SINGLE_CODER)})`,
          `5. Subagent: reviewer (${formatVal(models.MODEL_SINGLE_SUBAGENT_REVIEWER || models.MODEL_SINGLE_REVIEWER)})`,
          "6. Save Preset & Exit",
          "7. Cancel & Exit",
          "< Back"
        ];
      }
    };

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
        setWizardOptions([...options, "< Back"]);
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
        setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
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
        setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if ((choice.includes("configure") && !choice.includes("subagent")) || choice === "6. configure agent tier models" || choice === "6. configure single agent model") {
        if (isMulti) {
          const getResolvedModelWithProvider = (rawVal: string, isDefault: boolean): string => {
            const mStr = (rawVal || (isDefault ? (process.env.MODEL || getDefaultModel()) : "")).trim();
            if (!mStr) return "(not set)";
            if (mStr.includes(":")) return mStr;
            const activeProvider = (process.env.ACTIVE_PROVIDER || (process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim();
            return `${activeProvider}:${mStr}`;
          };
          const defaultResolved = getResolvedModelWithProvider("", true);
          const rawMaster = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
          const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
          const rawSuperagent = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
          const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
          const rawSubagent = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
          const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
          const rawResearcher = process.env.MODEL_MULTI_SUBAGENT_RESEARCHER || process.env.MODEL_MULTI_RESEARCHER || process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "";
          const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
          const rawCoder = process.env.MODEL_MULTI_SUBAGENT_CODER || process.env.MODEL_MULTI_CODER || process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "";
          const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
          const rawReviewer = process.env.MODEL_MULTI_SUBAGENT_REVIEWER || process.env.MODEL_MULTI_REVIEWER || process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_REVIEWER || "";
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
            `7. All Tiers (Overwrite All)`,
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
            "4. Custom Endpoint",
            "5. Not Set (Clear Override)",
            "< Back"
          ]);
        }
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (!isMulti && (choice.includes("subagent") || choice === "7. configure subagent models")) {
        const getResolvedModelWithProvider = (rawVal: string, isDefault: boolean): string => {
          const mStr = (rawVal || (isDefault ? (process.env.MODEL || getDefaultModel()) : "")).trim();
          if (!mStr) return "(not set)";
          if (mStr.includes(":")) return mStr;
          const activeProvider = (process.env.ACTIVE_PROVIDER || (process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim();
          return `${activeProvider}:${mStr}`;
        };
        const defaultResolved = getResolvedModelWithProvider("", true);
        const rawSubagent = process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "";
        const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
        const rawResearcher = process.env.MODEL_SINGLE_SUBAGENT_RESEARCHER || process.env.MODEL_SINGLE_RESEARCHER || process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "";
        const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
        const rawCoder = process.env.MODEL_SINGLE_SUBAGENT_CODER || process.env.MODEL_SINGLE_CODER || process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "";
        const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
        const rawReviewer = process.env.MODEL_SINGLE_SUBAGENT_REVIEWER || process.env.MODEL_SINGLE_REVIEWER || process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_REVIEWER || "";
        const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

        setActiveWizard({
          type: "model",
          step: 50,
          data: {},
        });
        setWizardOptions([
          `1. Subagent (depth 2) (${subagentModelFormatted})`,
          `2. Subagent: researcher (${researcherModelFormatted})`,
          `3. Subagent: coder (${coderModelFormatted})`,
          `4. Subagent: reviewer (${reviewerModelFormatted})`,
          `5. All Subagent Tiers`,
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
      if (value === "< Back") {
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
      } else if (choice.includes("default model")) {
        tier = "default";
      } else if (choice.includes("all subagent tiers") || choice.includes("all_subagents")) {
        tier = "all_subagents";
      } else if (choice.includes("all tiers")) {
        tier = "all";
      } else {
        if (isMulti) {
          const tiers = ["master", "superagent", "subagent", "researcher", "coder", "reviewer", "all"];
          const idx = wizardSelectedIndex >= 0 ? wizardSelectedIndex : 0;
          tier = tiers[idx] || "master";
        } else {
          const tiers = ["subagent", "researcher", "coder", "reviewer", "all_subagents"];
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
        "4. Custom Endpoint",
        "5. Not Set (Clear Override)",
        "< Back"
      ]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 2) {
      if (value === "< Back") {
        const getResolvedModelWithProvider = (rawVal: string, isDefault: boolean): string => {
          const mStr = (rawVal || (isDefault ? (process.env.MODEL || getDefaultModel()) : "")).trim();
          if (!mStr) return "(not set)";
          if (mStr.includes(":")) return mStr;
          const activeProvider = (process.env.ACTIVE_PROVIDER || (process.env.CUSTOM_BASE_URL ? "custom" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai")).trim();
          return `${activeProvider}:${mStr}`;
        };
        const defaultResolved = getResolvedModelWithProvider("", true);
        const rawMaster = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "";
        const masterModelFormatted = rawMaster ? getResolvedModelWithProvider(rawMaster, false) : `(use default: ${defaultResolved})`;
        const rawSuperagent = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "";
        const superagentModelFormatted = rawSuperagent ? getResolvedModelWithProvider(rawSuperagent, false) : `(use default: ${defaultResolved})`;
        const rawSubagent = isMulti
          ? (process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "")
          : (process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "");
        const subagentModelFormatted = rawSubagent ? getResolvedModelWithProvider(rawSubagent, false) : `(use default: ${defaultResolved})`;
        const rawResearcher = isMulti
          ? (process.env.MODEL_MULTI_SUBAGENT_RESEARCHER || process.env.MODEL_MULTI_RESEARCHER || process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "")
          : (process.env.MODEL_SINGLE_SUBAGENT_RESEARCHER || process.env.MODEL_SINGLE_RESEARCHER || process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_RESEARCHER || "");
        const researcherModelFormatted = rawResearcher ? getResolvedModelWithProvider(rawResearcher, false) : `(use default: ${subagentModelFormatted})`;
        const rawCoder = isMulti
          ? (process.env.MODEL_MULTI_SUBAGENT_CODER || process.env.MODEL_MULTI_CODER || process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "")
          : (process.env.MODEL_SINGLE_SUBAGENT_CODER || process.env.MODEL_SINGLE_CODER || process.env.MODEL_SUBAGENT_CODER || process.env.MODEL_CODER || "");
        const coderModelFormatted = rawCoder ? getResolvedModelWithProvider(rawCoder, false) : `(use default: ${subagentModelFormatted})`;
        const rawReviewer = isMulti
          ? (process.env.MODEL_MULTI_SUBAGENT_REVIEWER || process.env.MODEL_MULTI_REVIEWER || process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_REVIEWER || "")
          : (process.env.MODEL_SINGLE_SUBAGENT_REVIEWER || process.env.MODEL_SINGLE_REVIEWER || process.env.MODEL_SUBAGENT_REVIEWER || process.env.MODEL_RESEARCHER || "");
        const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

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
              `4. Subagent: researcher (${researcherModelFormatted})`,
              `5. Subagent: coder (${coderModelFormatted})`,
              `6. Subagent: reviewer (${reviewerModelFormatted})`,
              `7. All Tiers (Overwrite All)`,
              `< Back`
            ]);
          } else {
            setWizardOptions([
              `1. Superagent (depth 1) (${superagentModelFormatted})`,
              `2. Subagent (depth 2) (${subagentModelFormatted})`,
              `3. Subagent: researcher (${researcherModelFormatted})`,
              `4. Subagent: coder (${coderModelFormatted})`,
              `5. Subagent: reviewer (${reviewerModelFormatted})`,
              `6. All Tiers (Overwrite All)`,
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

      if (value.toLowerCase().includes("not set") || value === "5") {
        const tier = data.tier || "";
        let clearUpdates: Record<string, string> = {};
        let targetLabel = "";
        if (tier === "master") {
          clearUpdates = { MODEL_MULTI_DEPTH_0: "", MODEL_MULTI_DEPT0: "", MODEL_MULTI_MASTER: "", MODEL_DEPTH_0: "", MODEL_DEPT0: "" };
          targetLabel = "Master Agent (depth 0)";
        } else if (tier === "superagent") {
          clearUpdates = { MODEL_MULTI_DEPTH_1: "", MODEL_MULTI_DEPT1: "", MODEL_MULTI_SUPERAGENT: "", MODEL_DEPTH_1: "", MODEL_DEPT1: "" };
          targetLabel = "Superagent (depth 1)";
        } else if (tier === "subagent") {
          clearUpdates = isMulti
            ? { MODEL_MULTI_DEPTH_2: "", MODEL_MULTI_DEPT2: "", MODEL_MULTI_SUBAGENT: "", MODEL_DEPTH_2: "", MODEL_DEPT2: "" }
            : { MODEL_SINGLE_SUBAGENT: "", MODEL_SINGLE_DEPTH_2: "" };
          targetLabel = "Subagent (depth 2)";
        } else if (tier === "researcher") {
          clearUpdates = isMulti
            ? { MODEL_MULTI_SUBAGENT_RESEARCHER: "", MODEL_MULTI_RESEARCHER: "", MODEL_SUBAGENT_RESEARCHER: "", MODEL_RESEARCHER: "" }
            : { MODEL_SINGLE_SUBAGENT_RESEARCHER: "", MODEL_SINGLE_RESEARCHER: "" };
          targetLabel = `Subagent "researcher"`;
        } else if (tier === "coder") {
          clearUpdates = isMulti
            ? { MODEL_MULTI_SUBAGENT_CODER: "", MODEL_MULTI_CODER: "", MODEL_SUBAGENT_CODER: "", MODEL_CODER: "" }
            : { MODEL_SINGLE_SUBAGENT_CODER: "", MODEL_SINGLE_CODER: "" };
          targetLabel = `Subagent "coder"`;
        } else if (tier === "reviewer") {
          clearUpdates = isMulti
            ? { MODEL_MULTI_SUBAGENT_REVIEWER: "", MODEL_MULTI_REVIEWER: "", MODEL_SUBAGENT_REVIEWER: "", MODEL_REVIEWER: "" }
            : { MODEL_SINGLE_SUBAGENT_REVIEWER: "", MODEL_SINGLE_REVIEWER: "" };
          targetLabel = `Subagent "reviewer"`;
        } else if (tier === "all_subagents") {
          clearUpdates = isMulti
            ? {
                MODEL_MULTI_DEPTH_2: "", MODEL_MULTI_DEPT2: "", MODEL_MULTI_SUBAGENT: "",
                MODEL_MULTI_SUBAGENT_RESEARCHER: "", MODEL_MULTI_RESEARCHER: "",
                MODEL_MULTI_SUBAGENT_CODER: "", MODEL_MULTI_CODER: "",
                MODEL_MULTI_SUBAGENT_REVIEWER: "", MODEL_MULTI_REVIEWER: "",
                MODEL_DEPTH_2: "", MODEL_DEPT2: "",
                MODEL_SUBAGENT_RESEARCHER: "", MODEL_RESEARCHER: "",
                MODEL_SUBAGENT_CODER: "", MODEL_CODER: "",
                MODEL_SUBAGENT_REVIEWER: "", MODEL_REVIEWER: "",
              }
            : {
                MODEL_SINGLE_SUBAGENT: "", MODEL_SINGLE_DEPTH_2: "",
                MODEL_SINGLE_SUBAGENT_RESEARCHER: "", MODEL_SINGLE_RESEARCHER: "",
                MODEL_SINGLE_SUBAGENT_CODER: "", MODEL_SINGLE_CODER: "",
                MODEL_SINGLE_SUBAGENT_REVIEWER: "", MODEL_SINGLE_REVIEWER: "",
              };
          targetLabel = "All Subagents";
        } else if (tier === "all") {
          clearUpdates = {
            MODEL_MULTI_DEPTH_0: "", MODEL_MULTI_DEPT0: "", MODEL_MULTI_MASTER: "",
            MODEL_MULTI_DEPTH_1: "", MODEL_MULTI_DEPT1: "", MODEL_MULTI_SUPERAGENT: "",
            MODEL_MULTI_DEPTH_2: "", MODEL_MULTI_DEPT2: "", MODEL_MULTI_SUBAGENT: "",
            MODEL_MULTI_SUBAGENT_RESEARCHER: "", MODEL_MULTI_RESEARCHER: "",
            MODEL_MULTI_SUBAGENT_CODER: "", MODEL_MULTI_CODER: "",
            MODEL_MULTI_SUBAGENT_REVIEWER: "", MODEL_MULTI_REVIEWER: "",
            MODEL_DEPTH_0: "", MODEL_DEPT0: "",
            MODEL_DEPTH_1: "", MODEL_DEPT1: "",
            MODEL_DEPTH_2: "", MODEL_DEPT2: "",
            MODEL_SUBAGENT_RESEARCHER: "", MODEL_RESEARCHER: "",
            MODEL_SUBAGENT_CODER: "", MODEL_CODER: "",
            MODEL_SUBAGENT_REVIEWER: "", MODEL_REVIEWER: "",
          };
          targetLabel = "All Tiers";
        } else if (tier === "single") {
          clearUpdates = { MODEL_SINGLE: "", MODEL: "" };
          targetLabel = "Single Agent";
        }
        if (Object.keys(clearUpdates).length > 0) {
          updateEnvFile(clearUpdates);
          const effectiveMasterModel = isMulti
            ? (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel())
            : (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel());
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
      } else if (choice.includes("openai") || choice === "2") {
        providerType = "openai";
      } else if (choice.includes("anthropic") || choice === "3") {
        providerType = "anthropic";
      } else if (choice.includes("custom") || choice === "4") {
        providerType = "custom";
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
          "4. Custom Endpoint",
          "5. Not Set (Clear Override)",
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
          step: 16,
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
        const prefix = `PROVIDER_${found.name.toUpperCase()}`;
        resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
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
                setWizardOptions([...modelsList, "< Back"]);
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
      addLine({
        type: "system",
        content: `Provider profile "${profileName}" selected. Choose a model below:`,
        timestamp: now,
      });
    } else if (step === 16) {
      if (value === "< Back") {
        const providerType = data.providerType;
        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...data },
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
        setInput("");
        return;
      }

      const nameInput = value.trim().replace(/[^a-zA-Z0-9_-]/g, "");
      const providerType = data.providerType;
      const profileName = nameInput || providerType;

      if (providerType === "custom") {
        setActiveWizard({
          type: "model",
          step: 17,
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
          step: 18,
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
    } else if (step === 17) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 16,
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
        step: 18,
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
    } else if (step === 18) {
      if (value === "< Back") {
        const providerType = data.providerType;
        if (providerType === "custom") {
          setActiveWizard({
            type: "model",
            step: 17,
            data: { ...data },
          });
        } else {
          setActiveWizard({
            type: "model",
            step: 16,
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
        addProvider({
          id: profileName.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
          name: profileName,
          provider: providerType,
          apiKey: apiKey,
          baseUrl: baseUrl || (providerType === "openrouter" ? "https://openrouter.ai/api/v1" : undefined),
        });

        updateEnvFile(updates);

        addLine({
          type: "system",
          content: `Successfully configured provider profile: ${profileName} (${providerType})!\nSaved to global model-config.json`,
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
                  setWizardOptions([...modelsList, "< Back"]);
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
    } else if (step === 15) {
      if (value === "< Back") {
        const providerType = data.providerType;
        setActiveWizard({
          type: "model",
          step: 3,
          data: { ...data },
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
        setInput("");
        return;
      }

      const modelName = value;
      try {
        const profileName = data.provider;
        const tier = data.tier;
        let updates: Record<string, string> = {};

        let envPath = "";
        let targetLabel = "";
        if (tier === "default") {
          switchActiveProvider(profileName);
          envPath = updateEnvFile({ 
            MODEL: modelName,
            [`PROVIDER_${profileName.toUpperCase()}_MODEL`]: modelName
          });
          targetLabel = "Default Model";
        } else if (tier === "all_subagents") {
          const activeProvider = process.env.ACTIVE_PROVIDER || profileName;
          const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
            ? `${profileName.toLowerCase()}:${modelName}`
            : modelName;
          updates = isMulti
            ? {
                MODEL_MULTI_DEPTH_2: finalModelName,
                MODEL_MULTI_DEPT2: finalModelName,
                MODEL_MULTI_SUBAGENT: finalModelName,
                MODEL_MULTI_SUBAGENT_RESEARCHER: finalModelName,
                MODEL_MULTI_RESEARCHER: finalModelName,
                MODEL_MULTI_SUBAGENT_CODER: finalModelName,
                MODEL_MULTI_CODER: finalModelName,
                MODEL_MULTI_SUBAGENT_REVIEWER: finalModelName,
                MODEL_MULTI_REVIEWER: finalModelName,
                MODEL_DEPTH_2: finalModelName,
                MODEL_DEPT2: finalModelName,
                MODEL_SUBAGENT_RESEARCHER: finalModelName,
                MODEL_RESEARCHER: finalModelName,
                MODEL_SUBAGENT_CODER: finalModelName,
                MODEL_CODER: finalModelName,
                MODEL_SUBAGENT_REVIEWER: finalModelName,
                MODEL_REVIEWER: finalModelName
              }
            : {
                MODEL_SINGLE_SUBAGENT: finalModelName,
                MODEL_SINGLE_DEPTH_2: finalModelName,
                MODEL_SINGLE_SUBAGENT_RESEARCHER: finalModelName,
                MODEL_SINGLE_RESEARCHER: finalModelName,
                MODEL_SINGLE_SUBAGENT_CODER: finalModelName,
                MODEL_SINGLE_CODER: finalModelName,
                MODEL_SINGLE_SUBAGENT_REVIEWER: finalModelName,
                MODEL_SINGLE_REVIEWER: finalModelName
              };
          targetLabel = "All Subagent Models";
          switchActiveProvider(profileName);
          envPath = updateEnvFile(updates);
        } else if (tier === "all") {
          const activeProvider = process.env.ACTIVE_PROVIDER || profileName;
          const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
            ? `${profileName.toLowerCase()}:${modelName}`
            : modelName;
          updates = {
            MODEL: modelName,
            MODEL_MULTI_DEPTH_0: finalModelName,
            MODEL_MULTI_DEPT0: finalModelName,
            MODEL_MULTI_MASTER: finalModelName,
            MODEL_MULTI_DEPTH_1: finalModelName,
            MODEL_MULTI_DEPT1: finalModelName,
            MODEL_MULTI_SUPERAGENT: finalModelName,
            MODEL_MULTI_DEPTH_2: finalModelName,
            MODEL_MULTI_DEPT2: finalModelName,
            MODEL_MULTI_SUBAGENT: finalModelName,
            MODEL_MULTI_SUBAGENT_RESEARCHER: finalModelName,
            MODEL_MULTI_RESEARCHER: finalModelName,
            MODEL_MULTI_SUBAGENT_CODER: finalModelName,
            MODEL_MULTI_CODER: finalModelName,
            MODEL_MULTI_SUBAGENT_REVIEWER: finalModelName,
            MODEL_MULTI_REVIEWER: finalModelName,
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
          switchActiveProvider(profileName);
          envPath = updateEnvFile(updates);
        } else {
          const activeProvider = process.env.ACTIVE_PROVIDER || profileName;
          const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
            ? `${profileName.toLowerCase()}:${modelName}`
            : modelName;
          
          if (tier === "master") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_0: finalModelName, MODEL_MULTI_DEPT0: finalModelName, MODEL_MULTI_MASTER: finalModelName, MODEL_DEPTH_0: finalModelName, MODEL_DEPT0: finalModelName }
              : { MODEL_SINGLE: finalModelName, MODEL: finalModelName };
            targetLabel = "Master Agent (depth 0) Model";
          } else if (tier === "superagent") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_1: finalModelName, MODEL_MULTI_DEPT1: finalModelName, MODEL_MULTI_SUPERAGENT: finalModelName, MODEL_DEPTH_1: finalModelName, MODEL_DEPT1: finalModelName }
              : { MODEL_SINGLE: finalModelName, MODEL: finalModelName };
            targetLabel = "Superagent (depth 1) Model";
          } else if (tier === "subagent") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_2: finalModelName, MODEL_MULTI_DEPT2: finalModelName, MODEL_MULTI_SUBAGENT: finalModelName, MODEL_DEPTH_2: finalModelName, MODEL_DEPT2: finalModelName }
              : { MODEL_SINGLE_SUBAGENT: finalModelName, MODEL_SINGLE_DEPTH_2: finalModelName };
            targetLabel = "Subagent (depth 2) Model";
          } else if (tier === "single") {
            updates = { MODEL_SINGLE: finalModelName, MODEL: finalModelName };
            targetLabel = "Single Agent Model";
          } else {
            const typeUpper = tier.toUpperCase();
            updates = isMulti
              ? {
                  [`MODEL_MULTI_SUBAGENT_${typeUpper}`]: finalModelName,
                  [`MODEL_MULTI_${typeUpper}`]: finalModelName,
                  [`MODEL_SUBAGENT_${typeUpper}`]: finalModelName,
                  [`MODEL_${typeUpper}`]: finalModelName
                }
              : {
                  [`MODEL_SINGLE_SUBAGENT_${typeUpper}`]: finalModelName,
                  [`MODEL_SINGLE_${typeUpper}`]: finalModelName
                };
            targetLabel = `Subagent "${tier}" Model`;
          }
          envPath = updateEnvFile(updates);
        }

        const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
        const limit = getContextWindowLimit(cleanModelName);
        
        const isSingle = agentRef?.current?.tier === "single";
        const effectiveModel = isSingle
          ? (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel())
          : (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel());
        const cleanModel = effectiveModel.includes(":") ? effectiveModel.substring(effectiveModel.indexOf(":") + 1) : effectiveModel;
        const newLimit = getContextWindowLimit(cleanModel);
        setContextLimit(newLimit);
        setActiveModel(effectiveModel);
        
        let updatedList = `\n\nUpdated Models:\n`;
        if (isMulti) {
          const masterModel = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          for (const [key, value] of Object.entries(process.env)) {
            if (value && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SUBAGENT_"))) {
              const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
                ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
                : key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${value}`;
              }
            }
          }
        } else {
          const singleModel = process.env.MODEL_SINGLE || "(use default)";
          updatedList += `  Single Agent: ${singleModel}`;
          const subagentModel = process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || "";
          if (subagentModel) {
            updatedList += `\n  Subagent (depth 2): ${subagentModel}`;
          }
          for (const [key, value] of Object.entries(process.env)) {
            if (value && key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
              const name = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
              updatedList += `\n  Subagent "${name}": ${value}`;
            }
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
    } else if (step === 4) {
      if (value === "< Back") {
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
      const presetChoice = value;
      const presetName = presetChoice.split(" - ")[0].trim();
      try {
        const envPath = applyModelPreset(presetName, presetMode);
        const isSingle = !isMulti;
        const nextActiveModel = isSingle
          ? (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel())
          : (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel());
        const limit = getContextWindowLimit(nextActiveModel);
        setContextLimit(limit);
        setActiveModel(nextActiveModel);

        let updatedList = `\n\nUpdated Models:\n`;
        if (isSingle) {
          const singleModel = process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel();
          const subagentModel = process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || "(use default)";
          updatedList += `  Single Agent Model: ${singleModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          for (const [key, val] of Object.entries(process.env)) {
            if (val && key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
              const name = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${val}`;
              }
            } else if (val && key.startsWith("MODEL_SINGLE_") && key !== "MODEL_SINGLE" && key !== "MODEL_SINGLE_SUBAGENT" && key !== "MODEL_SINGLE_DEPTH_2") {
              const name = key.replace("MODEL_SINGLE_", "").toLowerCase();
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${val}`;
              }
            }
          }
        } else {
          const masterModel = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
          const superagentModel = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
          const subagentModel = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
          updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          for (const [key, val] of Object.entries(process.env)) {
            if (val && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SUBAGENT_"))) {
              const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
                ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
                : key.replace("MODEL_SUBAGENT_", "").toLowerCase();
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${val}`;
              }
            }
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
    } else if (step === 20) {
      const name = value.trim();
      if (name.toLowerCase() === "< back" || name.toLowerCase() === "back") {
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
        data: { ...data, presetName: name },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 21) {
      const desc = value.trim();
      if (desc.toLowerCase() === "< back" || desc.toLowerCase() === "back") {
        setActiveWizard({
          type: "model",
          step: 20,
          data: { ...data },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }
      setActiveWizard({
        type: "model",
        step: 22,
        data: { ...data, presetDescription: desc, presetModels: JSON.stringify({}) },
      });
      setActiveWizard({
        type: "model",
        step: 22,
        data: { ...data, presetDescription: desc, presetModels: JSON.stringify({}) },
      });
      setWizardOptions(getPresetOptionsList({}));
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 22 || step === 32) {
      const models: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
      if (value === "< Back") {
        const nextStep = step === 22 ? 21 : 31;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput(step === 22 ? (data.presetDescription || "") : (data.presetDescription || ""));
        return;
      }
      if (value.includes("Save Preset")) {
        const presetName = data.presetName || "";
        const presetDescription = data.presetDescription || "";
        try {
          const savedPath = saveModelPreset(presetName, presetDescription, models, presetMode);

          // Auto-apply the preset after saving
          const envPath = applyModelPreset(presetName, presetMode);
          const isSingle = !isMulti;
          const nextActiveModel = isSingle
            ? (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel())
            : (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel());
          const limit = getContextWindowLimit(nextActiveModel);
          setContextLimit(limit);
          setActiveModel(nextActiveModel);

          let updatedList = `\n\nUpdated Models:\n`;
          if (isSingle) {
            const singleModel = process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel();
            const subagentModel = process.env.MODEL_SINGLE_SUBAGENT || process.env.MODEL_SINGLE_DEPTH_2 || "(use default)";
            updatedList += `  Single Agent Model: ${singleModel}\n` +
              `  Subagent (depth 2): ${subagentModel}`;

            for (const [key, val] of Object.entries(process.env)) {
              if (val && key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
                const name = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
                if (!updatedList.includes(`Subagent "${name}":`)) {
                  updatedList += `\n  Subagent "${name}": ${val}`;
                }
              } else if (val && key.startsWith("MODEL_SINGLE_") && key !== "MODEL_SINGLE" && key !== "MODEL_SINGLE_SUBAGENT" && key !== "MODEL_SINGLE_DEPTH_2") {
                const name = key.replace("MODEL_SINGLE_", "").toLowerCase();
                if (!updatedList.includes(`Subagent "${name}":`)) {
                  updatedList += `\n  Subagent "${name}": ${val}`;
                }
              }
            }
          } else {
            const masterModel = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
            const superagentModel = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
            const subagentModel = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
            updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
              `  Superagent (depth 1): ${superagentModel}\n` +
              `  Subagent (depth 2): ${subagentModel}`;

            for (const [key, val] of Object.entries(process.env)) {
              if (val && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SUBAGENT_"))) {
                const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
                  ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
                  : key.replace("MODEL_SUBAGENT_", "").toLowerCase();
                if (!updatedList.includes(`Subagent "${name}":`)) {
                  updatedList += `\n  Subagent "${name}": ${val}`;
                }
              }
            }
          }

          addLine({
            type: "system",
            content: `Model preset "${presetName}" saved & applied successfully!\nSaved to: ${savedPath}\nApplied to: ${envPath}${updatedList}`,
            timestamp: now,
          });
        } catch (err: any) {
          addLine({
            type: "error",
            content: `Failed to save/apply model preset: ${err.message}`,
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
      else if (value.includes("Single Agent")) tier = "single";

      if (!tier) return;

      const nextStep = step === 22 ? 23 : 33;
      setActiveWizard({
        type: "model",
        step: nextStep,
        data: { ...data, tier },
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
      setInput("");
    } else if (step === 23 || step === 33) {
      if (value === "< Back") {
        const nextStep = step === 23 ? 22 : 32;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data },
        });
        const models: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
        setWizardOptions(getPresetOptionsList(models));
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

      if (value.toLowerCase().includes("not set") || value === "5") {
        const tier = data.tier || "";
        const presetModels: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
        if (tier === "master") {
          delete presetModels.MODEL_MULTI_DEPTH_0;
          delete presetModels.MODEL_MULTI_DEPT0;
          delete presetModels.MODEL_MULTI_MASTER;
          delete presetModels.MODEL_DEPTH_0;
          delete presetModels.MODEL_DEPT0;
        } else if (tier === "superagent") {
          delete presetModels.MODEL_MULTI_DEPTH_1;
          delete presetModels.MODEL_MULTI_DEPT1;
          delete presetModels.MODEL_MULTI_SUPERAGENT;
          delete presetModels.MODEL_DEPTH_1;
          delete presetModels.MODEL_DEPT1;
        } else if (tier === "subagent") {
          if (isMulti) {
            delete presetModels.MODEL_MULTI_DEPTH_2;
            delete presetModels.MODEL_MULTI_DEPT2;
            delete presetModels.MODEL_MULTI_SUBAGENT;
            delete presetModels.MODEL_DEPTH_2;
            delete presetModels.MODEL_DEPT2;
          } else {
            delete presetModels.MODEL_SINGLE_SUBAGENT;
            delete presetModels.MODEL_SINGLE_DEPTH_2;
          }
        } else if (tier === "researcher") {
          if (isMulti) {
            delete presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER;
            delete presetModels.MODEL_MULTI_RESEARCHER;
            delete presetModels.MODEL_SUBAGENT_RESEARCHER;
            delete presetModels.MODEL_RESEARCHER;
          } else {
            delete presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER;
            delete presetModels.MODEL_SINGLE_RESEARCHER;
          }
        } else if (tier === "coder") {
          if (isMulti) {
            delete presetModels.MODEL_MULTI_SUBAGENT_CODER;
            delete presetModels.MODEL_MULTI_CODER;
            delete presetModels.MODEL_SUBAGENT_CODER;
            delete presetModels.MODEL_CODER;
          } else {
            delete presetModels.MODEL_SINGLE_SUBAGENT_CODER;
            delete presetModels.MODEL_SINGLE_CODER;
          }
        } else if (tier === "reviewer") {
          if (isMulti) {
            delete presetModels.MODEL_MULTI_SUBAGENT_REVIEWER;
            delete presetModels.MODEL_MULTI_REVIEWER;
            delete presetModels.MODEL_SUBAGENT_REVIEWER;
            delete presetModels.MODEL_REVIEWER;
          } else {
            delete presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER;
            delete presetModels.MODEL_SINGLE_REVIEWER;
          }
        } else if (tier === "single") {
          delete presetModels.MODEL_SINGLE;
          delete presetModels.MODEL;
        }

        const nextStep = step === 23 ? 22 : 32;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data, presetModels: JSON.stringify(presetModels) },
        });

        setWizardOptions(getPresetOptionsList(presetModels));
        setWizardSelectedIndex(0);
        setInput("");
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
        addLine({
          type: "error",
          content: "Invalid provider type choice.",
          timestamp: now,
        });
        return;
      }

      const nextStep = step === 23 ? 25 : 35;
      setActiveWizard({
        type: "model",
        step: nextStep,
        data: { ...data, providerType },
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
      setInput("");
    } else if (step === 25 || step === 35) {
      if (value === "< Back") {
        const nextStep = step === 25 ? 23 : 33;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data },
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
        setInput("");
        return;
      }

      const providerType = data.providerType;
      if (value.startsWith("+ Configure a new")) {
        const nextModelStep = step === 25 ? 24 : 34;
        setActiveWizard({
          type: "model",
          step: 16,
          data: { ...data, isPreset: "true", returnStep: String(nextModelStep) },
        });
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        addLine({
          type: "system",
          content: `Configure new profile for Preset. Please enter a profile name (alphanumeric, e.g. ${providerType}_preset):`,
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
        const prefix = `PROVIDER_${found.name.toUpperCase()}`;
        resolvedApiKey = process.env[`${prefix}_API_KEY`] || "";
      }

      const nextStep = step === 25 ? 24 : 34;
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
    } else if (step === 24 || step === 34) {
      if (value === "< Back") {
        const nextStep = step === 24 ? 25 : 35;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data },
        });
        const providerType = data.providerType;
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
        setInput("");
        return;
      }

      const modelName = value;
      const profileName = data.provider || "";
      const tier = data.tier || "";
      
      const activeProvider = process.env.ACTIVE_PROVIDER || "";
      const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
        ? `${profileName.toLowerCase()}:${modelName}`
        : modelName;

      const presetModels: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};

      if (tier === "master") {
        presetModels.MODEL_MULTI_DEPTH_0 = finalModelName;
        presetModels.MODEL_MULTI_DEPT0 = finalModelName;
        presetModels.MODEL_MULTI_MASTER = finalModelName;
        presetModels.MODEL_DEPTH_0 = finalModelName;
        presetModels.MODEL_DEPT0 = finalModelName;
      } else if (tier === "superagent") {
        presetModels.MODEL_MULTI_DEPTH_1 = finalModelName;
        presetModels.MODEL_MULTI_DEPT1 = finalModelName;
        presetModels.MODEL_MULTI_SUPERAGENT = finalModelName;
        presetModels.MODEL_DEPTH_1 = finalModelName;
        presetModels.MODEL_DEPT1 = finalModelName;
      } else if (tier === "subagent") {
        if (isMulti) {
          presetModels.MODEL_MULTI_DEPTH_2 = finalModelName;
          presetModels.MODEL_MULTI_DEPT2 = finalModelName;
          presetModels.MODEL_MULTI_SUBAGENT = finalModelName;
          presetModels.MODEL_DEPTH_2 = finalModelName;
          presetModels.MODEL_DEPT2 = finalModelName;
        } else {
          presetModels.MODEL_SINGLE_SUBAGENT = finalModelName;
          presetModels.MODEL_SINGLE_DEPTH_2 = finalModelName;
        }
      } else if (tier === "researcher") {
        if (isMulti) {
          presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER = finalModelName;
          presetModels.MODEL_MULTI_RESEARCHER = finalModelName;
          presetModels.MODEL_SUBAGENT_RESEARCHER = finalModelName;
          presetModels.MODEL_RESEARCHER = finalModelName;
        } else {
          presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER = finalModelName;
          presetModels.MODEL_SINGLE_RESEARCHER = finalModelName;
        }
      } else if (tier === "coder") {
        if (isMulti) {
          presetModels.MODEL_MULTI_SUBAGENT_CODER = finalModelName;
          presetModels.MODEL_MULTI_CODER = finalModelName;
          presetModels.MODEL_SUBAGENT_CODER = finalModelName;
          presetModels.MODEL_CODER = finalModelName;
        } else {
          presetModels.MODEL_SINGLE_SUBAGENT_CODER = finalModelName;
          presetModels.MODEL_SINGLE_CODER = finalModelName;
        }
      } else if (tier === "reviewer") {
        if (isMulti) {
          presetModels.MODEL_MULTI_SUBAGENT_REVIEWER = finalModelName;
          presetModels.MODEL_MULTI_REVIEWER = finalModelName;
          presetModels.MODEL_SUBAGENT_REVIEWER = finalModelName;
          presetModels.MODEL_REVIEWER = finalModelName;
        } else {
          presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER = finalModelName;
          presetModels.MODEL_SINGLE_REVIEWER = finalModelName;
        }
      } else if (tier === "default") {
        presetModels.MODEL = finalModelName;
      } else if (tier === "single") {
        presetModels.MODEL_SINGLE = finalModelName;
        presetModels.MODEL = finalModelName;
      }

      const nextStep = step === 24 ? 22 : 32;
      setActiveWizard({
        type: "model",
        step: nextStep,
        data: { ...data, presetModels: JSON.stringify(presetModels) },
      });

      setWizardOptions(getPresetOptionsList(presetModels));
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 30) {
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
          isMulti ? "6. Configure Agent Tier Models" : "6. Configure Single Agent Model",
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
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
        data: { ...data, presetName: name, presetDescription: desc, presetModels: JSON.stringify(models) },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 31) {
      const desc = value.trim();
      if (desc.toLowerCase() === "< back" || desc.toLowerCase() === "back") {
        setActiveWizard({
          type: "model",
          step: 30,
          data: { ...data },
        });
        const presets = getModelPresets(presetMode);
        const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
        setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }
      const updatedDesc = desc || data.presetDescription || "";
      const models: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
      
      setActiveWizard({
        type: "model",
        step: 32,
        data: { ...data, presetDescription: updatedDesc }
      });

      setWizardOptions(getPresetOptionsList(models));
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 40) {
      if (value === "< Back") {
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
      const choice = value;
      const name = choice.split(" - ")[0].trim();
      setActiveWizard({
        type: "model",
        step: 41,
        data: { ...data, presetName: name },
      });
      setWizardOptions(["1. Yes, delete it", "2. No, cancel"]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 41) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 40,
          data: { ...data },
        });
        const presets = getModelPresets(presetMode);
        const customPresets = presets.filter(p => !BUILT_IN_PRESETS.some(bp => bp.name === p.name));
        setWizardOptions([...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }
      const choice = value;
      const name = data.presetName || "";
      const doDelete = choice.includes("Yes") || choice.includes("delete");
      if (doDelete) {
        try {
          const savedPath = deleteModelPreset(name, presetMode);
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
        let updates: Record<string, string> = {};

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
          const activeProvider = process.env.ACTIVE_PROVIDER || "";
          const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
            ? `${profileName.toLowerCase()}:${modelName}`
            : modelName;
          updates = {
            MODEL: modelName,
            MODEL_MULTI_DEPTH_0: finalModelName,
            MODEL_MULTI_DEPT0: finalModelName,
            MODEL_MULTI_MASTER: finalModelName,
            MODEL_MULTI_DEPTH_1: finalModelName,
            MODEL_MULTI_DEPT1: finalModelName,
            MODEL_MULTI_SUPERAGENT: finalModelName,
            MODEL_MULTI_DEPTH_2: finalModelName,
            MODEL_MULTI_DEPT2: finalModelName,
            MODEL_MULTI_SUBAGENT: finalModelName,
            MODEL_MULTI_SUBAGENT_RESEARCHER: finalModelName,
            MODEL_MULTI_RESEARCHER: finalModelName,
            MODEL_MULTI_SUBAGENT_CODER: finalModelName,
            MODEL_MULTI_CODER: finalModelName,
            MODEL_MULTI_SUBAGENT_REVIEWER: finalModelName,
            MODEL_MULTI_REVIEWER: finalModelName,
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
          switchActiveProvider(profileName);
          envPath = updateEnvFile(updates);
        } else {
          const activeProvider = process.env.ACTIVE_PROVIDER || "";
          const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
            ? `${profileName.toLowerCase()}:${modelName}`
            : modelName;
          
          if (tier === "master") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_0: finalModelName, MODEL_MULTI_DEPT0: finalModelName, MODEL_MULTI_MASTER: finalModelName, MODEL_DEPTH_0: finalModelName, MODEL_DEPT0: finalModelName }
              : { MODEL_SINGLE: finalModelName, MODEL: finalModelName };
            targetLabel = "Master Agent (depth 0) Model";
          } else if (tier === "superagent") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_1: finalModelName, MODEL_MULTI_DEPT1: finalModelName, MODEL_MULTI_SUPERAGENT: finalModelName, MODEL_DEPTH_1: finalModelName, MODEL_DEPT1: finalModelName }
              : { MODEL_SINGLE: finalModelName, MODEL: finalModelName };
            targetLabel = "Superagent (depth 1) Model";
          } else if (tier === "subagent") {
            updates = isMulti
              ? { MODEL_MULTI_DEPTH_2: finalModelName, MODEL_MULTI_DEPT2: finalModelName, MODEL_MULTI_SUBAGENT: finalModelName, MODEL_DEPTH_2: finalModelName, MODEL_DEPT2: finalModelName }
              : { MODEL_SINGLE_SUBAGENT: finalModelName, MODEL_SINGLE_DEPTH_2: finalModelName };
            targetLabel = "Subagent (depth 2) Model";
          } else {
            const typeUpper = tier.toUpperCase();
            updates = isMulti
              ? {
                  [`MODEL_MULTI_SUBAGENT_${typeUpper}`]: finalModelName,
                  [`MODEL_MULTI_${typeUpper}`]: finalModelName,
                  [`MODEL_SUBAGENT_${typeUpper}`]: finalModelName,
                  [`MODEL_${typeUpper}`]: finalModelName
                }
              : {
                  [`MODEL_SINGLE_SUBAGENT_${typeUpper}`]: finalModelName,
                  [`MODEL_SINGLE_${typeUpper}`]: finalModelName
                };
            targetLabel = `Subagent "${tier}" Model`;
          }
          envPath = updateEnvFile(updates);
        }

        const cleanModelName = modelName.includes(":") ? modelName.substring(modelName.indexOf(":") + 1) : modelName;
        const limit = getContextWindowLimit(cleanModelName);
        
        const isSingle = agentRef?.current?.tier === "single";
        const effectiveModel = isSingle
          ? (process.env.MODEL_SINGLE || process.env.MODEL || getDefaultModel())
          : (process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel());
        const cleanModel = effectiveModel.includes(":") ? effectiveModel.substring(effectiveModel.indexOf(":") + 1) : effectiveModel;
        const newLimit = getContextWindowLimit(cleanModel);
        setContextLimit(newLimit);
        setActiveModel(effectiveModel);
        
        const currentModel = process.env.MODEL || getDefaultModel();
        const masterModel = process.env.MODEL_MULTI_DEPTH_0 || process.env.MODEL_MULTI_DEPT0 || process.env.MODEL_MULTI_MASTER || process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || "(use default)";
        const superagentModel = process.env.MODEL_MULTI_DEPTH_1 || process.env.MODEL_MULTI_DEPT1 || process.env.MODEL_MULTI_SUPERAGENT || process.env.MODEL_DEPTH_1 || process.env.MODEL_DEPT1 || "(use default)";
        const subagentModel = process.env.MODEL_MULTI_DEPTH_2 || process.env.MODEL_MULTI_DEPT2 || process.env.MODEL_MULTI_SUBAGENT || process.env.MODEL_DEPTH_2 || process.env.MODEL_DEPT2 || "(use default)";
        
        let updatedList = `\n\nUpdated Models:\n` +
          `  Master Agent (depth 0): ${masterModel}\n` +
          `  Superagent (depth 1): ${superagentModel}\n` +
          `  Subagent (depth 2): ${subagentModel}`;

        for (const [key, value] of Object.entries(process.env)) {
          if (value && (key.startsWith("MODEL_MULTI_SUBAGENT_") || key.startsWith("MODEL_SUBAGENT_"))) {
            const name = key.startsWith("MODEL_MULTI_SUBAGENT_")
              ? key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase()
              : key.replace("MODEL_SUBAGENT_", "").toLowerCase();
            if (!updatedList.includes(`Subagent "${name}":`)) {
              updatedList += `\n  Subagent "${name}": ${value}`;
            }
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
