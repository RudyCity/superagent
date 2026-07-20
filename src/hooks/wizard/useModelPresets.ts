import { 
  getModelPresets, 
  applyModelPreset, 
  saveModelPreset, 
  deleteModelPreset, 
  BUILT_IN_PRESETS,
  getEffectiveMasterModel,
  getContextWindowLimit,
  getAllTierModels,
  getTierModelWithProvider,
  getProviders,
} from "../../core/config.js";
import { getDefaultModel } from "../../core/slash-commands.js";
import type { PresetMode } from "../../core/config.js";
import { resolveProfileFromPicker, fetchModelsForProvider, getFallbackModels } from "../../core/loginWizardLogic.js";

interface ModelWizardContext {
  setActiveWizard: React.Dispatch<React.SetStateAction<any>>;
  setWizardOptions: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardAllOptions?: React.Dispatch<React.SetStateAction<string[]>>;
  setWizardSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  addLine: (line: any) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  setContextLimit: React.Dispatch<React.SetStateAction<number>>;
  setActiveModel: React.Dispatch<React.SetStateAction<string>>;
  setWizardIsLoadingModels: React.Dispatch<React.SetStateAction<boolean>>;
  wizardSelectedIndex: number;
  wizardOptions: string[];
  wizardIsLoadingModels: boolean;
  agentRef?: React.MutableRefObject<any>;
}

export async function handlePresetStep(
  step: number,
  value: string,
  data: Record<string, string>,
  ctx: ModelWizardContext,
  extra: {
    presetMode: PresetMode;
    modeLabel: string;
    isMulti: boolean;
    now: number;
    syncContextManagerModel: (modelName: string, limit: number) => void;
    getPresetOptionsList: (models: Record<string, string>) => string[];
    getStep1Options: () => string[];
    getProfilePickerOptions: (providerType: string) => string[];
    cleanFetchUrl: (url: string | undefined) => string;
  }
): Promise<boolean> {
  const presetSteps = [4, 20, 21, 22, 23, 24, 25, 30, 31, 32, 33, 34, 35, 40, 41, 61, 62];
  if (!presetSteps.includes(step)) {
    return false;
  }

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
    wizardOptions,
  } = ctx;

  const {
    presetMode,
    modeLabel,
    isMulti,
    now,
    syncContextManagerModel,
    getPresetOptionsList,
    getStep1Options,
    getProfilePickerOptions,
    cleanFetchUrl,
  } = extra;

  if (step === 4) {
    if (value === "< Back") {
      setActiveWizard({
        type: "model",
        step: 1,
        data: {},
      });
      setWizardOptions(getStep1Options());
      setWizardSelectedIndex(0);
      setInput("");
      return true;
    }
    const presetChoice = value;
    const presetName = presetChoice.split(" - ")[0].trim();
    try {
      applyModelPreset(presetName, presetMode, false);
      const isSingle = !isMulti;
      const nextActiveModel = getEffectiveMasterModel(presetMode) || getDefaultModel();
      const limit = getContextWindowLimit(nextActiveModel);
      setContextLimit(limit);
      setActiveModel(nextActiveModel);
      syncContextManagerModel(nextActiveModel, limit);

      let updatedList = `\n\nUpdated Models:\n`;
      if (isSingle) {
        const singleModel = getEffectiveMasterModel("single") || getDefaultModel();
        const subagentModel = getTierModelWithProvider("single", "subagent") || "(use default)";
        updatedList += `  Single Agent Model: ${singleModel}\n` +
          `  Subagent (depth 2): ${subagentModel}`;

        const allModels = getAllTierModels("single");
        for (const [key, val] of Object.entries(allModels)) {
          if (key.startsWith("subagent_") && val && val !== "(use default)") {
            const name = key.replace("subagent_", "");
            if (!updatedList.includes(`Subagent "${name}":`)) {
              updatedList += `\n  Subagent "${name}": ${val}`;
            }
          }
        }
      } else {
        const masterModel = getTierModelWithProvider("multi", "master") || "(use default)";
        const superagentModel = getTierModelWithProvider("multi", "superagent") || "(use default)";
        const subagentModel = getTierModelWithProvider("multi", "subagent") || "(use default)";
        updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
          `  Superagent (depth 1): ${superagentModel}\n` +
          `  Subagent (depth 2): ${subagentModel}`;

        const allModelsMulti = getAllTierModels("multi");
        for (const [key, val] of Object.entries(allModelsMulti)) {
          if (key.startsWith("subagent_") && val && val !== "(use default)") {
            const name = key.replace("subagent_", "");
            if (!updatedList.includes(`Subagent "${name}":`)) {
              updatedList += `\n  Subagent "${name}": ${val}`;
            }
          }
        }
      }

      addLine({
        type: "system",
        content: `Model preset "${presetName}" applied successfully!${updatedList}`,
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
      return true;
    }
    if (!name) {
      addLine({
        type: "error",
        content: "Preset name cannot be empty.",
        timestamp: now,
      });
      return true;
    }
    if (BUILT_IN_PRESETS.some(bp => bp.name === name.toLowerCase())) {
      addLine({
        type: "error",
        content: `Cannot overwrite built-in preset "${name}".`,
        timestamp: now,
      });
      return true;
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
      return true;
    }
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
      setInput(data.presetDescription || "");
      return true;
    }
    if (value.includes("Save Preset")) {
      const presetName = data.presetName || "";
      const presetDescription = data.presetDescription || "";
      try {
        const savedPath = saveModelPreset(presetName, presetDescription, models, presetMode);

        applyModelPreset(presetName, presetMode, false);
        const isSingle = !isMulti;
        const nextActiveModel = getEffectiveMasterModel(presetMode) || getDefaultModel();
        const limit = getContextWindowLimit(nextActiveModel);
        setContextLimit(limit);
        setActiveModel(nextActiveModel);
        syncContextManagerModel(nextActiveModel, limit);

        let updatedList = `\n\nUpdated Models:\n`;
        if (isSingle) {
          const singleModel = getEffectiveMasterModel("single") || getDefaultModel();
          const subagentModel = getTierModelWithProvider("single", "subagent") || "(use default)";
          updatedList += `  Single Agent Model: ${singleModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          const allModels = getAllTierModels("single");
          for (const [key, val] of Object.entries(allModels)) {
            if (key.startsWith("subagent_") && val && val !== "(use default)") {
              const name = key.replace("subagent_", "");
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${val}`;
              }
            }
          }
        } else {
          const masterModel = getTierModelWithProvider("multi", "master") || "(use default)";
          const superagentModel = getTierModelWithProvider("multi", "superagent") || "(use default)";
          const subagentModel = getTierModelWithProvider("multi", "subagent") || "(use default)";
          updatedList += `  Master Agent (depth 0): ${masterModel}\n` +
            `  Superagent (depth 1): ${superagentModel}\n` +
            `  Subagent (depth 2): ${subagentModel}`;

          const allModelsMulti = getAllTierModels("multi");
          for (const [key, val] of Object.entries(allModelsMulti)) {
            if (key.startsWith("subagent_") && val && val !== "(use default)") {
              const name = key.replace("subagent_", "");
              if (!updatedList.includes(`Subagent "${name}":`)) {
                updatedList += `\n  Subagent "${name}": ${val}`;
              }
            }
          }
        }

        addLine({
          type: "system",
          content: `Model preset "${presetName}" saved & applied successfully!\nSaved to: ${savedPath}${updatedList}`,
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
      return true;
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
      return true;
    }

    let tier = "";
    if (value.includes("Master Agent")) tier = "master";
    else if (value.includes("Superagent")) tier = "superagent";
    else if (value.includes("depth 2")) tier = "subagent";
    else if (value.includes("researcher")) tier = "researcher";
    else if (value.includes("coder")) tier = "coder";
    else if (value.includes("reviewer")) tier = "reviewer";
    else if (value.includes("classifier")) tier = "classifier";
    else if (value.includes("advisor")) tier = "advisor";
    else if (value.includes("Default Model")) tier = "default";
    else if (value.includes("Single Agent")) tier = "single";

    if (!tier) return true;

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
      "4. Custom OpenAI Endpoint",
      "5. Custom Anthropic Endpoint",
      "6. Google Gemini",
      "7. Not Set (Clear Override)",
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
      return true;
    }

    if (value.toLowerCase().includes("not set") || value === "5" || value === "6" || value === "7") {
      const tier = data.tier || "";
      const presetModels: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
      if (tier === "master") {
        delete presetModels.MODEL_MULTI_MASTER;
      } else if (tier === "superagent") {
        delete presetModels.MODEL_MULTI_SUPERAGENT;
      } else if (tier === "subagent") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT;
        }
      } else if (tier === "researcher") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER;
        }
      } else if (tier === "coder") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT_CODER;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT_CODER;
        }
      } else if (tier === "reviewer") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT_REVIEWER;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER;
        }
      } else if (tier === "classifier") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT_CLASSIFIER;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT_CLASSIFIER;
        }
      } else if (tier === "advisor") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT_ADVISOR;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT_ADVISOR;
        }
      } else if (tier === "rmemory") {
        if (isMulti) {
          delete presetModels.MODEL_MULTI_SUBAGENT_RMEMORY;
        } else {
          delete presetModels.MODEL_SINGLE_SUBAGENT_RMEMORY;
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
      return true;
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
      return true;
    }

    const nextStep = step === 23 ? 25 : 35;
    setActiveWizard({
      type: "model",
      step: nextStep,
      data: { ...data, providerType },
    });

    const profileOptions = getProfilePickerOptions(providerType);

    const opts = [
      ...profileOptions,
      `+ Configure a new ${providerType} profile`,
      "< Back"
    ];
    setWizardOptions(opts);
    setWizardAllOptions?.(opts);
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
        "4. Custom OpenAI Endpoint",
        "5. Custom Anthropic Endpoint",
        "6. Google Gemini",
        "7. Not Set (Clear Override)",
        "< Back"
      ]);
      setWizardSelectedIndex(0);
      setInput("");
      return true;
    }

    const providerType = data.providerType;
    if (value.startsWith("+ Configure a new")) {
      const nextModelStep = step === 25 ? 24 : 34;
      setActiveWizard({
        type: "model",
        step: 6,
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
      return true;
    }

    const found = resolveProfileFromPicker(value, providerType, getProviders());
    const profileName = found ? found.name : value.replace(/^\d+\.\s*/, "").split(" (key:")[0].trim();
    const resolvedApiKey = found?.apiKey || "";
    const resolvedBaseUrl = found?.baseUrl || "";

    const nextStep = step === 25 ? 24 : 34;
    setActiveWizard({
      type: "model",
      step: nextStep,
      data: { ...data, provider: profileName },
    });

    const fallbackModels = getFallbackModels(providerType as any);
    const initialOpts = [...fallbackModels, "+ Custom Model (Input manually)", "< Back"];
    setWizardOptions(initialOpts);
    setWizardAllOptions?.(initialOpts);
    setWizardSelectedIndex(0);
    setInput("");

    setWizardIsLoadingModels(true);
    fetchModelsForProvider(providerType, resolvedApiKey, resolvedBaseUrl)
      .then((fetched) => {
        if (fetched.length > 0) {
          const opts = [...fetched, "+ Custom Model (Input manually)", "< Back"];
          setWizardOptions(opts);
          setWizardAllOptions?.(opts);
        }
      })
      .catch(() => {})
      .finally(() => setWizardIsLoadingModels(false));
    setWizardAllOptions?.(initialOpts);
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
      const profileOptions = getProfilePickerOptions(providerType);
      const opts = [
        ...profileOptions,
        `+ Configure a new ${providerType} profile`,
        "< Back"
      ];
      setWizardOptions(opts);
      setWizardAllOptions?.(opts);
      setWizardSelectedIndex(0);
      setInput("");
      return true;
    }

    if (value === "+ Custom Model (Input manually)") {
      const currentOptions = wizardOptions;
      setActiveWizard({
        type: "model",
        step: 16,
        data: { ...data, isPreset: "true", prevStep: String(step), modelOptions: JSON.stringify(currentOptions) },
      });
      setWizardOptions([]);
      setWizardSelectedIndex(0);
      setInput("");
      addLine({
        type: "system",
        content: "Please enter the custom model ID manually (e.g., meta-llama/llama-3-70b-instruct):",
        timestamp: now,
      });
      return true;
    }

    const modelName = value;
    const profileName = data.provider || "";
    const tier = data.tier || "";
    
    const finalModelName = `${profileName.toLowerCase()}@${modelName}`;
    const presetModels: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};
    const currentOptions = wizardOptions;

    setActiveWizard({
      type: "model",
      step: step === 24 ? 61 : 62,
      data: {
        ...data,
        tempFinalModelName: finalModelName,
        tempTier: tier,
        tempPresetModels: JSON.stringify(presetModels),
        tempStep: String(step),
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
  } else if (step === 30) {
    if (value === "< Back") {
      setActiveWizard({
        type: "model",
        step: 1,
        data: {},
      });
      setWizardOptions(getStep1Options());
      setWizardSelectedIndex(0);
      setInput("");
      return true;
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
      const opts = [...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"];
      setWizardOptions(opts);
      setWizardAllOptions?.(opts);
      setWizardSelectedIndex(0);
      setInput("");
      return true;
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
      return true;
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
      const opts = [...customPresets.map(p => `${p.name} - ${p.description}`), "< Back"];
      setWizardOptions(opts);
      setWizardAllOptions?.(opts);
      setWizardSelectedIndex(0);
      setInput("");
      return true;
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
  } else if (step === 61 || step === 62) {
    if (value === "< Back") {
      const prevStep = step === 61 ? 24 : 34;
      setActiveWizard({
        type: "model",
        step: prevStep,
        data: { ...data },
      });
      const opts = data.modelOptions ? JSON.parse(data.modelOptions) : [];
      setWizardOptions(opts);
      if (setWizardAllOptions) setWizardAllOptions(opts);
      setWizardSelectedIndex(0);
      setInput("");
      return true;
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
    const finalModelName = data.tempFinalModelName;
    const tier = data.tempTier;
    const presetModels: Record<string, string> = data.tempPresetModels ? JSON.parse(data.tempPresetModels) : {};

    if (tier === "master") {
      presetModels.MODEL_MULTI_MASTER = finalModelName;
      presetModels.MODEL_MULTI_MASTER_VISION = String(supportsVision);
    } else if (tier === "superagent") {
      presetModels.MODEL_MULTI_SUPERAGENT = finalModelName;
      presetModels.MODEL_MULTI_SUPERAGENT_VISION = String(supportsVision);
    } else if (tier === "subagent") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_VISION = String(supportsVision);
      }
    } else if (tier === "researcher") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_RESEARCHER_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_RESEARCHER_VISION = String(supportsVision);
      }
    } else if (tier === "coder") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT_CODER = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_CODER_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT_CODER = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_CODER_VISION = String(supportsVision);
      }
    } else if (tier === "reviewer") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT_REVIEWER = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_REVIEWER_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_REVIEWER_VISION = String(supportsVision);
      }
    } else if (tier === "classifier") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT_CLASSIFIER = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_CLASSIFIER_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT_CLASSIFIER = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_CLASSIFIER_VISION = String(supportsVision);
      }
    } else if (tier === "advisor") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT_ADVISOR = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_ADVISOR_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT_ADVISOR = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_ADVISOR_VISION = String(supportsVision);
      }
    } else if (tier === "rmemory") {
      if (isMulti) {
        presetModels.MODEL_MULTI_SUBAGENT_RMEMORY = finalModelName;
        presetModels.MODEL_MULTI_SUBAGENT_RMEMORY_VISION = String(supportsVision);
      } else {
        presetModels.MODEL_SINGLE_SUBAGENT_RMEMORY = finalModelName;
        presetModels.MODEL_SINGLE_SUBAGENT_RMEMORY_VISION = String(supportsVision);
      }
    } else if (tier === "default") {
      presetModels.MODEL = finalModelName;
      presetModels.MODEL_VISION = String(supportsVision);
      if (!isMulti) {
        presetModels.MODEL_SINGLE_SUPERAGENT = finalModelName;
        presetModels.MODEL_SINGLE_SUPERAGENT_VISION = String(supportsVision);
      }
    } else if (tier === "single") {
      presetModels.MODEL_SINGLE_SUPERAGENT = finalModelName;
      presetModels.MODEL_SINGLE_SUPERAGENT_VISION = String(supportsVision);
      presetModels.MODEL_SINGLE = finalModelName;
      presetModels.MODEL_SINGLE_VISION = String(supportsVision);
      presetModels.MODEL = finalModelName;
      presetModels.MODEL_VISION = String(supportsVision);
    }

    const nextStep = step === 61 ? 22 : 32;
    setActiveWizard({
      type: "model",
      step: nextStep,
      data: { ...data, presetModels: JSON.stringify(presetModels) },
    });

    setWizardOptions(getPresetOptionsList(presetModels));
    setWizardSelectedIndex(0);
    setInput("");
  }

  return true;
}
