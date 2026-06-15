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
  BUILT_IN_PRESETS
} from "../../core/config.js";
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

    if (step === 1) {
      const choice = value.toLowerCase();
      if (choice.includes("back") || choice === "< back") {
        setActiveWizard(null);
        setWizardOptions([]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }

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
      const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
      setWizardOptions(providerOptions);
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
        const rawReviewer = process.env.MODEL_SUBAGENT_RESEARCHER || process.env.MODEL_REVIEWER || "";
        const reviewerModelFormatted = rawReviewer ? getResolvedModelWithProvider(rawReviewer, false) : `(use default: ${subagentModelFormatted})`;

        setActiveWizard({
          type: "model",
          step: 50,
          data: { ...data },
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
        data: { ...data, provider: providerProfileName },
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
    } else if (step === 4) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 1,
          data: {},
        });
        setWizardOptions([
          "1. Load/Apply Model Preset",
          "2. List Model Presets",
          "3. Create Model Preset",
          "4. Edit Model Preset",
          "5. Delete Model Preset",
          "6. Configure Agent Tier Models",
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }
      const presetChoice = value;
      const presetName = presetChoice.split(" - ")[0].trim();
      try {
        const envPath = applyModelPreset(presetName);
        const isSingle = agentRef?.current?.tier === "single";
        const nextActiveModel = isSingle
          ? (process.env.MODEL || getDefaultModel())
          : (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel());
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
    } else if (step === 20) {
      const name = value.trim();
      if (name.toLowerCase() === "< back" || name.toLowerCase() === "back") {
        setActiveWizard({
          type: "model",
          step: 1,
          data: {},
        });
        setWizardOptions([
          "1. Load/Apply Model Preset",
          "2. List Model Presets",
          "3. Create Model Preset",
          "4. Edit Model Preset",
          "5. Delete Model Preset",
          "6. Configure Agent Tier Models",
          "< Back"
        ]);
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
        "9. Cancel & Exit",
        "< Back"
      ]);
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

      const nextStep = step === 22 ? 23 : 33;
      setActiveWizard({
        type: "model",
        step: nextStep,
        data: { ...data, tier },
      });

      const list = getConfiguredProviders();
      const options = list.map(p => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
      const providerOptions = options.length > 0 ? [...options, "< Back"] : ["1. OpenRouter (Recommended)", "2. OpenAI", "3. Anthropic", "4. Custom Endpoint", "< Back"];
      setWizardOptions(providerOptions);
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
          "9. Cancel & Exit",
          "< Back"
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

      const nextStep = step === 23 ? 24 : 34;
      setActiveWizard({
        type: "model",
        step: nextStep,
        data: { ...data, provider: providerProfileName },
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
    } else if (step === 24 || step === 34) {
      if (value === "< Back") {
        const nextStep = step === 24 ? 23 : 33;
        setActiveWizard({
          type: "model",
          step: nextStep,
          data: { ...data },
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
      const profileName = data.provider || "";
      const tier = data.tier || "";
      
      const activeProvider = process.env.ACTIVE_PROVIDER || "";
      const finalModelName = profileName.toLowerCase() !== activeProvider.toLowerCase()
        ? `${profileName.toLowerCase()}:${modelName}`
        : modelName;

      const presetModels: Record<string, string> = data.presetModels ? JSON.parse(data.presetModels) : {};

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

      const nextStep = step === 24 ? 22 : 32;
      setActiveWizard({
        type: "model",
        step: nextStep,
        data: { ...data, presetModels: JSON.stringify(presetModels) },
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
        "9. Cancel & Exit",
        "< Back"
      ]);
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
          "1. Load/Apply Model Preset",
          "2. List Model Presets",
          "3. Create Model Preset",
          "4. Edit Model Preset",
          "5. Delete Model Preset",
          "6. Configure Agent Tier Models",
          "< Back"
        ]);
        setWizardSelectedIndex(0);
        setInput("");
        return;
      }
      const choice = value;
      const name = choice.split(" - ")[0].trim();
      const presets = getModelPresets();
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
        const presets = getModelPresets();
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
        "9. Cancel & Exit",
        "< Back"
      ]);
      setWizardSelectedIndex(0);
      setInput("");
    } else if (step === 40) {
      if (value === "< Back") {
        setActiveWizard({
          type: "model",
          step: 1,
          data: {},
        });
        setWizardOptions([
          "1. Load/Apply Model Preset",
          "2. List Model Presets",
          "3. Create Model Preset",
          "4. Edit Model Preset",
          "5. Delete Model Preset",
          "6. Configure Agent Tier Models",
          "< Back"
        ]);
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
        const presets = getModelPresets();
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
          data: { ...data },
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
        const profileName = data.provider;
        const tier = data.tier;
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
        
        const isSingle = agentRef?.current?.tier === "single";
        const effectiveModel = isSingle
          ? (process.env.MODEL || getDefaultModel())
          : (process.env.MODEL_DEPTH_0 || process.env.MODEL_DEPT0 || process.env.MODEL || getDefaultModel());
        const cleanModel = effectiveModel.includes(":") ? effectiveModel.substring(effectiveModel.indexOf(":") + 1) : effectiveModel;
        const newLimit = getContextWindowLimit(cleanModel);
        setContextLimit(newLimit);
        setActiveModel(effectiveModel);
        
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
