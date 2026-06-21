import { getProviders, loadModelConfig, getActivePreset, mutateModelConfig } from "./jsonConfig.js";
export function getConfiguredProviders() {
    const providers = getProviders();
    const config = loadModelConfig();
    const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
    const mode = isMulti ? "multi" : "single";
    const activePreset = getActivePreset(mode);
    const tierConfig = mode === "multi" ? activePreset.models.master : activePreset.models.superagent;
    const activeProfileId = tierConfig?.providerProfileId || "";
    const list = providers
        .filter((p) => p.apiKey && p.apiKey.trim() !== "")
        .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.provider,
        apiKey: p.apiKey,
        baseUrl: p.baseUrl,
        isActive: p.id === activeProfileId,
    }));
    return list;
}
export function switchActiveProvider(name) {
    const config = loadModelConfig();
    const provider = config.providers.find((p) => p.id === name || p.name.toLowerCase() === name.toLowerCase());
    if (!provider) {
        console.warn(`[WARNING] switchActiveProvider: Provider "${name}" not found in providers array. ` +
            `Available: [${config.providers.map(p => p.id).join(", ")}]. ` +
            `The preset tiers may reference a non-existent provider. ` +
            `Run /login add to create this provider profile.`);
        return false;
    }
    const tierUpdate = { providerProfileId: provider.id };
    // Reload latest config and patch only providerProfileId fields inside active presets.
    // Only update tiers that don't already have a providerProfileId set.
    mutateModelConfig((freshConfig) => {
        for (const mode of ["multi", "single"]) {
            const activeId = freshConfig.activePresetId?.[mode];
            const presetsList = freshConfig.presets?.[mode];
            const activePreset = presetsList?.find((p) => p.id === activeId) || presetsList?.[0];
            if (!activePreset?.models)
                continue;
            if (mode === "multi") {
                if (!activePreset.models.master?.providerProfileId) {
                    activePreset.models.master = { ...activePreset.models.master, ...tierUpdate };
                }
            }
            if (!activePreset.models.superagent?.providerProfileId) {
                activePreset.models.superagent = { ...activePreset.models.superagent, ...tierUpdate };
            }
            if (activePreset.models.subagentDefault && !activePreset.models.subagentDefault.providerProfileId) {
                activePreset.models.subagentDefault = { ...activePreset.models.subagentDefault, ...tierUpdate };
            }
            if (activePreset.models.subagentDetails) {
                for (const key of Object.keys(activePreset.models.subagentDetails)) {
                    if (!activePreset.models.subagentDetails[key]?.providerProfileId) {
                        activePreset.models.subagentDetails[key] = { ...activePreset.models.subagentDetails[key], ...tierUpdate };
                    }
                }
            }
        }
    });
    return true;
}
export function getProviderOptionsList(list) {
    const options = list.map((p) => `${p.name} (${p.type}${p.baseUrl ? ` - ${p.baseUrl}` : ""})${p.isActive ? " [Active]" : ""}`);
    const defaultTemplates = [
        "1. OpenRouter (Recommended)",
        "2. OpenAI",
        "3. Anthropic",
        "4. Custom Endpoint",
    ];
    const templatesToShow = defaultTemplates.filter((t) => {
        const lowerT = t.toLowerCase();
        let nameToMatch = "";
        if (lowerT.includes("openrouter"))
            nameToMatch = "openrouter";
        else if (lowerT.includes("openai"))
            nameToMatch = "openai";
        else if (lowerT.includes("anthropic"))
            nameToMatch = "anthropic";
        else if (lowerT.includes("custom"))
            nameToMatch = "custom";
        return !list.some((p) => p.name.toLowerCase() === nameToMatch);
    });
    return [...options, ...templatesToShow, "< Back"];
}
/**
 * Get the active provider type name from JSON config.
 */
export function getActiveProviderName() {
    const list = getConfiguredProviders();
    const active = list.find((p) => p.isActive);
    return active ? active.type : (list[0]?.type || "openai");
}
/**
 * Resolve a raw model value to "provider:model" format.
 * Reads fallback from JSON config, not env var.
 */
export function getResolvedModelWithProvider(rawVal, isDefault, fallbackModel) {
    const defaultFromConfig = fallbackModel || getEffectiveMasterModel("auto") || "gpt-4o";
    const mStr = (rawVal || (isDefault ? defaultFromConfig : "")).trim();
    if (!mStr)
        return "(not set)";
    if (mStr.includes(":"))
        return mStr;
    const activeProvider = getActiveProviderName();
    return `${activeProvider}:${mStr}`;
}
/**
 * Format provider list for wizard profile picker (with masked API key + [Active]).
 */
export function formatProviderForPicker(list) {
    return list.map((p) => {
        const apiKey = p.apiKey || "";
        const maskedKey = apiKey
            ? (apiKey.length > 8 ? `${apiKey.slice(0, 6)}...${apiKey.slice(-4)}` : "...")
            : "(no key)";
        const activeLabel = p.isActive ? " [Active]" : "";
        return `${p.name} (key: ${maskedKey})${activeLabel}`;
    });
}
/**
 * Format provider list for log display (with masked API key, base URL, [Active]).
 */
export function formatProviderForLog(list) {
    return list
        .map((p) => {
        const masked = p.apiKey
            ? (p.apiKey.length <= 8 ? "*".repeat(p.apiKey.length) : `${p.apiKey.slice(0, 4)}...${p.apiKey.slice(-4)}`)
            : "None";
        const baseStr = p.baseUrl ? ` (Base URL: ${p.baseUrl})` : "";
        const activeLabel = p.isActive ? " [Active]" : "";
        return `  - ${p.name} [${p.type}] (API Key: ${masked})${baseStr}${activeLabel}`;
    })
        .join("\n");
}
function resolveMode(mode) {
    if (mode === "auto") {
        return (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true") ? "multi" : "single";
    }
    return mode;
}
/**
 * Get the effective master/primary model name from JSON config.
 * For multi mode: returns master model.
 * For single mode: returns superagent model.
 * Falls back to "gpt-4o" if nothing is set.
 */
export function getEffectiveMasterModel(mode = "auto") {
    const m = resolveMode(mode);
    const preset = getActivePreset(m);
    if (m === "multi") {
        return preset.models.master?.model || preset.models.superagent?.model || "gpt-4o";
    }
    return preset.models.superagent?.model || "gpt-4o";
}
/**
 * Get a specific tier's model from JSON config.
 * @param mode "multi" | "single" | "auto"
 * @param tier Tier name: "master", "superagent", "subagent", "researcher", "coder", "reviewer", or any subagent name
 * @returns The model string, or "" if not set
 */
export function getTierModel(mode, tier) {
    const m = resolveMode(mode);
    const preset = getActivePreset(m);
    const key = tier.toLowerCase();
    if (key === "master") {
        return (m === "multi" ? preset.models.master?.model : preset.models.superagent?.model) || "";
    }
    if (key === "superagent") {
        return preset.models.superagent?.model || "";
    }
    if (key === "subagent") {
        return preset.models.subagentDefault?.model || "";
    }
    // Named subagent (researcher, coder, reviewer, etc.)
    return preset.models.subagentDetails?.[key]?.model || "";
}
export function getTierModelWithProvider(mode, tier) {
    const m = resolveMode(mode);
    const preset = getActivePreset(m);
    const key = tier.toLowerCase();
    let tierConfig;
    if (key === "master") {
        tierConfig = m === "multi" ? preset.models.master : preset.models.superagent;
    }
    else if (key === "superagent") {
        tierConfig = preset.models.superagent;
    }
    else if (key === "subagent") {
        tierConfig = preset.models.subagentDefault;
    }
    else {
        tierConfig = preset.models.subagentDetails?.[key];
    }
    if (!tierConfig?.model)
        return "";
    if (tierConfig.providerProfileId) {
        return `${tierConfig.providerProfileId}@${tierConfig.model}`;
    }
    return tierConfig.model;
}
/**
 * Set a specific tier's model in JSON config and persist.
 * @param mode "multi" | "single" | "auto"
 * @param tier Tier name
 * @param modelName The model string to set
 * @param providerProfileId Optional provider profile ID
 */
export function setTierModel(mode, tier, modelName, providerProfileId) {
    const m = resolveMode(mode);
    const key = tier.toLowerCase();
    const update = { model: modelName };
    if (providerProfileId)
        update.providerProfileId = providerProfileId;
    mutateModelConfig((config) => {
        const activeId = config.activePresetId?.[m];
        const presetsList = config.presets?.[m];
        const preset = presetsList?.find((p) => p.id === activeId) || presetsList?.[0];
        if (!preset?.models)
            return;
        if (key === "master") {
            if (m === "multi") {
                preset.models.master = { ...preset.models.master, ...update };
            }
            else {
                preset.models.superagent = { ...preset.models.superagent, ...update };
            }
        }
        else if (key === "superagent") {
            preset.models.superagent = { ...preset.models.superagent, ...update };
        }
        else if (key === "subagent") {
            preset.models.subagentDefault = { ...preset.models.subagentDefault, ...update };
        }
        else {
            if (!preset.models.subagentDetails)
                preset.models.subagentDetails = {};
            preset.models.subagentDetails[key] = { ...preset.models.subagentDetails[key], ...update };
        }
    });
}
/**
 * Set ALL tiers' models at once in JSON config and persist.
 */
export function setAllTierModels(mode, modelName, providerProfileId) {
    const m = resolveMode(mode);
    const update = { model: modelName };
    if (providerProfileId)
        update.providerProfileId = providerProfileId;
    mutateModelConfig((config) => {
        const activeId = config.activePresetId?.[m];
        const presetsList = config.presets?.[m];
        const preset = presetsList?.find((p) => p.id === activeId) || presetsList?.[0];
        if (!preset?.models)
            return;
        if (m === "multi") {
            preset.models.master = { ...preset.models.master, ...update };
        }
        preset.models.superagent = { ...preset.models.superagent, ...update };
        preset.models.subagentDefault = { ...preset.models.subagentDefault, ...update };
        if (preset.models.subagentDetails) {
            for (const key of Object.keys(preset.models.subagentDetails)) {
                preset.models.subagentDetails[key] = { ...preset.models.subagentDetails[key], ...update };
            }
        }
    });
}
/**
 * Clear a specific tier's model override (set to empty string).
 */
export function clearTierModel(mode, tier) {
    setTierModel(mode, tier, "");
}
/**
 * Get all tier models as a display-ready record.
 * Returns keys like: master, superagent, subagentDefault, and subagentDetails entries.
 */
export function getAllTierModels(mode) {
    const m = resolveMode(mode);
    const preset = getActivePreset(m);
    const result = {};
    if (m === "multi") {
        result.master = getTierModelWithProvider(m, "master") || "(use default)";
    }
    else {
        result.singleAgent = getTierModelWithProvider(m, "singleAgent") || "(use default)";
    }
    result.superagent = getTierModelWithProvider(m, "superagent") || "(use default)";
    result.subagentDefault = getTierModelWithProvider(m, "subagent") || "(use default)";
    if (preset.models.subagentDetails) {
        for (const [name, cfg] of Object.entries(preset.models.subagentDetails)) {
            const c = cfg;
            if (c?.model)
                result[`subagent_${name}`] = getTierModelWithProvider(m, name);
        }
    }
    return result;
}
//# sourceMappingURL=providers.js.map