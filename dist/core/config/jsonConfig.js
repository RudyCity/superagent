import fs from "fs";
import { getModelConfigPath, ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
const DEFAULT_CONFIG = {
    settings: {
        concurrencyLimit: 0,
        rateLimitRpm: 60,
        rateLimitCapacity: 60,
    },
    providers: [
        {
            id: "default-anthropic",
            name: "Default Anthropic",
            provider: "anthropic",
            apiKey: "",
            baseUrl: "",
        },
        {
            id: "default-openai",
            name: "Default OpenAI",
            provider: "openai",
            apiKey: "",
            baseUrl: "",
        }
    ],
    presets: {
        multi: [
            {
                id: "default-multi",
                name: "Default Multi-Agent Setup",
                description: "Standard configuration using Claude Sonnet and GPT-4o-mini",
                models: {
                    master: {
                        providerProfileId: "default-anthropic",
                        model: "claude-3-5-sonnet-20241022",
                    },
                    superagent: {
                        providerProfileId: "default-anthropic",
                        model: "claude-3-5-sonnet-20241022",
                    },
                    subagentDefault: {
                        providerProfileId: "default-openai",
                        model: "gpt-4o-mini",
                    },
                    subagentDetails: {},
                },
            },
        ],
        single: [
            {
                id: "default-single",
                name: "Default Single-Agent Setup",
                description: "Standard single-agent setup using Claude Sonnet and GPT-4o-mini",
                models: {
                    superagent: {
                        providerProfileId: "default-anthropic",
                        model: "claude-3-5-sonnet-20241022",
                    },
                    subagentDefault: {
                        providerProfileId: "default-openai",
                        model: "gpt-4o-mini",
                    },
                    subagentDetails: {},
                },
            },
        ],
    },
    activePresetId: {
        multi: "default-multi",
        single: "default-single",
    },
};
let cachedConfig = null;
export function clearModelConfigCache() {
    cachedConfig = null;
}
export function loadModelConfig() {
    if (cachedConfig) {
        return cachedConfig;
    }
    const configPath = getModelConfigPath();
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, "utf-8");
            const parsed = JSON.parse(data);
            // Basic migrations/fallback validation
            if (!parsed?.providers) {
                // File exists but providers field is invalid/missing — back up before repairing
                try {
                    const backupPath = configPath + ".corrupt-" + Date.now();
                    fs.copyFileSync(configPath, backupPath);
                    console.warn(`model-config.json had invalid providers field. Backed up to: ${backupPath}`);
                }
                catch { }
                // Repair: keep any existing presets/activePresetId, only reset providers to defaults
                const fallbackConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
                if (parsed?.presets) {
                    fallbackConfig.presets = parsed.presets;
                }
                if (parsed?.activePresetId) {
                    fallbackConfig.activePresetId = parsed.activePresetId;
                }
                if (parsed?.settings) {
                    fallbackConfig.settings = parsed.settings;
                }
                console.warn(`[WARNING] model-config.json providers were invalid. Reset to defaults. Presets and settings preserved.`);
                cachedConfig = fallbackConfig;
                saveModelConfig(fallbackConfig);
            }
            else {
                // Validate and repair missing presets / activePresetId (e.g. from older app versions)
                if (!parsed.presets || !parsed.presets.multi || !parsed.presets.single) {
                    parsed.presets = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets));
                }
                if (!parsed.activePresetId || !parsed.activePresetId.multi || !parsed.activePresetId.single) {
                    parsed.activePresetId = JSON.parse(JSON.stringify(DEFAULT_CONFIG.activePresetId));
                }
                cachedConfig = parsed;
            }
            return cachedConfig;
        }
    }
    catch (error) {
        console.error("Error reading model-config.json:", error);
        // Back up the corrupted file before overwriting with defaults
        try {
            if (fs.existsSync(configPath)) {
                const backupPath = configPath + ".corrupt-" + Date.now();
                fs.copyFileSync(configPath, backupPath);
                console.warn(`model-config.json was corrupted. Backed up to: ${backupPath}`);
            }
        }
        catch { }
    }
    // Fallback to default — do NOT set cachedConfig until save succeeds
    const defaultConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    const saveResult = saveModelConfig(defaultConfig);
    if (saveResult) {
        cachedConfig = defaultConfig;
    }
    else {
        // Save failed (e.g. directory creation failed). Set cache anyway so the app
        // can still function in-memory, but log a critical warning.
        cachedConfig = defaultConfig;
        console.error("CRITICAL: Failed to persist model-config.json to disk. Credentials will be lost on restart. Check permissions for: " + getRootConfigDir());
    }
    return cachedConfig;
}
export function saveModelConfig(config) {
    const configPath = getModelConfigPath();
    try {
        ensureGlobalConfigDir();
        // Atomic write: write to a temp file first, then rename.
        // This prevents file corruption if the process is killed (Ctrl+C, crash)
        // during the write — the original file stays intact until rename completes.
        const tmpPath = configPath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
        fs.renameSync(tmpPath, configPath);
        cachedConfig = config;
        return true;
    }
    catch (error) {
        console.error("Error writing model-config.json:", error);
        // Clean up temp file if rename failed but write succeeded
        try {
            fs.unlinkSync(configPath + ".tmp");
        }
        catch { }
        return false;
    }
}
export function getProviders() {
    return loadModelConfig().providers;
}
export function addProvider(profile) {
    const config = loadModelConfig();
    const index = config.providers.findIndex((p) => p.id === profile.id);
    if (index !== -1) {
        config.providers[index] = profile;
    }
    else {
        config.providers.push(profile);
    }
    if (!saveModelConfig(config)) {
        throw new Error("Failed to save provider credentials to disk. Check permissions for: " + getRootConfigDir());
    }
}
export function removeProvider(id) {
    const config = loadModelConfig();
    config.providers = config.providers.filter((p) => p.id !== id);
    if (!saveModelConfig(config)) {
        throw new Error("Failed to save provider removal to disk. Check permissions for: " + getRootConfigDir());
    }
}
export function getPresets(mode) {
    return loadModelConfig().presets[mode];
}
export function savePreset(mode, preset) {
    const config = loadModelConfig();
    const presetsList = config.presets[mode];
    const index = presetsList.findIndex((p) => p.id === preset.id);
    if (index !== -1) {
        presetsList[index] = preset;
    }
    else {
        presetsList.push(preset);
    }
    if (!saveModelConfig(config)) {
        throw new Error("Failed to save preset to disk. Check permissions for: " + getRootConfigDir());
    }
}
export function deletePreset(mode, id) {
    const config = loadModelConfig();
    config.presets[mode] = config.presets[mode].filter((p) => p.id !== id);
    if (!saveModelConfig(config)) {
        throw new Error("Failed to save preset deletion to disk. Check permissions for: " + getRootConfigDir());
    }
}
export function getActivePresetId(mode) {
    const config = loadModelConfig();
    return config.activePresetId?.[mode] || DEFAULT_CONFIG.activePresetId[mode];
}
export function setActivePresetId(mode, id) {
    const config = loadModelConfig();
    config.activePresetId[mode] = id;
    if (!saveModelConfig(config)) {
        throw new Error("Failed to save active preset ID to disk. Check permissions for: " + getRootConfigDir());
    }
}
export function getActivePreset(mode) {
    const config = loadModelConfig();
    const activeId = getActivePresetId(mode);
    const presetsList = config.presets?.[mode];
    if (presetsList) {
        const preset = presetsList.find((p) => p.id === activeId);
        if (preset) {
            return preset;
        }
        // Fallback to the first preset in the list
        if (presetsList.length > 0) {
            return presetsList[0];
        }
    }
    // Last resort: return a DEEP COPY of the default to prevent mutating DEFAULT_CONFIG
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG.presets[mode][0]));
}
export function getActiveConfigAudit(overrideMode) {
    const mode = overrideMode || (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true" ? "multi" : "single");
    const preset = getActivePreset(mode);
    let lines = [
        `│ ✦ Active Preset   : ${preset.name} (${mode}-agent mode)`
    ];
    if (mode === "multi") {
        const m = preset.models;
        lines.push(`│ ✦ Master Agent    : ${m.master?.providerProfileId || "(default)"} ➔ ${m.master?.model || "(not set)"}`);
        lines.push(`│ ✦ Superagent      : ${m.superagent?.providerProfileId || "(default)"} ➔ ${m.superagent?.model || "(not set)"}`);
        lines.push(`│ ✦ Subagent Default: ${m.subagentDefault?.providerProfileId || "(default)"} ➔ ${m.subagentDefault?.model || "(not set)"}`);
        if (m.subagentDetails && Object.keys(m.subagentDetails).length > 0) {
            for (const [t, cfg] of Object.entries(m.subagentDetails)) {
                lines.push(`│ ✦ Subagent (${t}): ${cfg.providerProfileId} ➔ ${cfg.model}`);
            }
        }
    }
    else {
        const m = preset.models;
        lines.push(`│ ✦ Superagent      : ${m.superagent?.providerProfileId || "(default)"} ➔ ${m.superagent?.model || "(not set)"}`);
        lines.push(`│ ✦ Subagent Default: ${m.subagentDefault?.providerProfileId || "(default)"} ➔ ${m.subagentDefault?.model || "(not set)"}`);
        if (m.subagentDetails && Object.keys(m.subagentDetails).length > 0) {
            for (const [t, cfg] of Object.entries(m.subagentDetails)) {
                lines.push(`│ ✦ Subagent (${t}): ${cfg.providerProfileId} ➔ ${cfg.model}`);
            }
        }
    }
    return lines.join("\n");
}
/**
 * Get model info for display purposes from JSON config.
 * Returns formatted model strings for each tier.
 */
export function getModelInfoForDisplay(isMulti) {
    const mode = isMulti ? "multi" : "single";
    const preset = getActivePreset(mode);
    const config = loadModelConfig();
    const models = preset.models || {};
    // Get active provider from the main tier config
    const mainTier = isMulti ? models.master : models.superagent;
    const activeProvider = mainTier?.providerProfileId || "";
    const formatModel = (tier) => {
        if (!tier?.model)
            return "(use default)";
        if (tier.providerProfileId) {
            const profile = config.providers.find(p => p.id === tier.providerProfileId);
            if (profile) {
                return `${profile.provider}@${tier.model}`;
            }
        }
        return tier.model;
    };
    const subagentDetails = {};
    if (models.subagentDetails) {
        for (const [type, cfg] of Object.entries(models.subagentDetails)) {
            if (cfg && typeof cfg === "object" && "model" in cfg) {
                subagentDetails[type] = formatModel(cfg);
            }
        }
    }
    return {
        activeProvider,
        master: formatModel(models.master),
        superagent: formatModel(models.superagent),
        subagentDefault: formatModel(models.subagentDefault),
        subagentDetails,
    };
}
//# sourceMappingURL=jsonConfig.js.map