import fs from "fs";
import { getModelConfigPath, ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
const DEFAULT_CONFIG = {
    settings: {
        concurrencyLimit: 0,
        rateLimitRpm: 60,
        rateLimitCapacity: 60,
        disableStreaming: false,
        contextWindowLimit: 0,
        maxIterations: 50,
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
// Modification time (ms) of the file that produced `cachedConfig`. Used to detect
// out-of-band writes (a second process / terminal / spawned agent) so we don't keep
// serving — and worse, re-saving — a stale in-memory snapshot that is missing
// providers another process added. -1 means "unknown".
let cachedConfigMtimeMs = -1;
function safeMtimeMs(p) {
    try {
        return fs.statSync(p).mtimeMs;
    }
    catch {
        return -1;
    }
}
export function clearModelConfigCache() {
    cachedConfig = null;
    cachedConfigMtimeMs = -1;
}
export function loadModelConfig() {
    const configPath = getModelConfigPath();
    if (cachedConfig) {
        // Serve the cache only if the file on disk hasn't changed since we cached it.
        // If another process rewrote model-config.json, fall through and reload so we
        // pick up providers/presets we don't know about yet.
        const diskMtime = safeMtimeMs(configPath);
        if (diskMtime === -1 || diskMtime === cachedConfigMtimeMs) {
            return cachedConfig;
        }
    }
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, "utf-8");
            const parsed = JSON.parse(data);
            // Basic migrations/fallback validation
            if (!parsed?.providers) {
                // File exists but the providers field is missing/invalid. Back up before touching it.
                try {
                    const backupPath = configPath + ".corrupt-" + Date.now();
                    fs.copyFileSync(configPath, backupPath);
                    console.warn(`model-config.json had invalid providers field. Backed up to: ${backupPath}`);
                }
                catch { }
                // Try to recover real providers (with their API keys) from the newest backup
                // that still has them, so we don't silently destroy the user's credentials.
                const recoveredProviders = recoverProvidersFromBackups(configPath);
                const fallbackConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
                if (recoveredProviders && recoveredProviders.length > 0) {
                    fallbackConfig.providers = recoveredProviders;
                    console.warn(`[WARNING] model-config.json providers were invalid. Recovered ${recoveredProviders.length} provider profile(s) from a backup.`);
                }
                else {
                    console.warn(`[WARNING] model-config.json providers were invalid and no backup with providers was found. Reset to defaults. Re-add credentials with /login.`);
                }
                if (parsed?.presets) {
                    fallbackConfig.presets = parsed.presets;
                }
                if (parsed?.activePresetId) {
                    fallbackConfig.activePresetId = parsed.activePresetId;
                }
                if (parsed?.settings) {
                    fallbackConfig.settings = parsed.settings;
                }
                cachedConfig = fallbackConfig;
                // saveModelConfig refreshes cachedConfigMtimeMs after writing.
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
                // Repair stale providerProfileIds: if a preset references a non-existent provider,
                // replace it with a valid provider that has an API key (or the first provider).
                const providerIds = new Set((parsed.providers || []).map((p) => p.id));
                const firstProviderWithKey = (parsed.providers || []).find((p) => p.apiKey && p.apiKey.trim() !== "");
                const fallbackProviderId = firstProviderWithKey?.id || parsed.providers?.[0]?.id || "";
                if (fallbackProviderId) {
                    let repaired = false;
                    for (const mode of ["multi", "single"]) {
                        const presetsList = parsed.presets?.[mode];
                        if (!presetsList)
                            continue;
                        for (const preset of presetsList) {
                            if (!preset?.models)
                                continue;
                            const models = preset.models;
                            const tierKeys = ["master", "superagent", "subagentDefault"];
                            for (const key of tierKeys) {
                                if (models[key]?.providerProfileId && !providerIds.has(models[key].providerProfileId)) {
                                    models[key].providerProfileId = fallbackProviderId;
                                    repaired = true;
                                }
                            }
                            if (models.subagentDetails) {
                                for (const subKey of Object.keys(models.subagentDetails)) {
                                    if (models.subagentDetails[subKey]?.providerProfileId && !providerIds.has(models.subagentDetails[subKey].providerProfileId)) {
                                        models.subagentDetails[subKey].providerProfileId = fallbackProviderId;
                                        repaired = true;
                                    }
                                }
                            }
                        }
                    }
                    if (repaired) {
                        // Persist the repaired config with retry for Windows EPERM
                        try {
                            const tmpPath = configPath + ".tmp";
                            fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), "utf-8");
                            for (let attempt = 0; attempt <= 3; attempt++) {
                                try {
                                    fs.renameSync(tmpPath, configPath);
                                    break;
                                }
                                catch (renameErr) {
                                    if (attempt < 3 && (renameErr?.code === "EPERM" || renameErr?.code === "EBUSY")) {
                                        const end = Date.now() + (attempt + 1) * 50;
                                        while (Date.now() < end) { /* busy wait */ }
                                        continue;
                                    }
                                    throw renameErr;
                                }
                            }
                        }
                        catch {
                            // Ignore repair write errors
                        }
                    }
                }
                cachedConfig = parsed;
                cachedConfigMtimeMs = safeMtimeMs(configPath);
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
        cachedConfigMtimeMs = -1;
        console.error("CRITICAL: Failed to persist model-config.json to disk. Credentials will be lost on restart. Check permissions for: " + getRootConfigDir());
    }
    return cachedConfig;
}
/**
 * Scan model-config.json backups (.corrupt-* and .tmp) newest-first and return the
 * first valid, non-empty providers array found. Used to recover credentials when the
 * live file's providers field is missing/invalid, so a transient bad write doesn't
 * permanently destroy the user's API keys.
 */
function recoverProvidersFromBackups(configPath) {
    try {
        const dir = configPath.substring(0, Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")));
        const base = configPath.substring(Math.max(configPath.lastIndexOf("/"), configPath.lastIndexOf("\\")) + 1);
        if (!dir || !fs.existsSync(dir))
            return null;
        const candidates = fs
            .readdirSync(dir)
            .filter((f) => f.startsWith(base + ".corrupt-"))
            .map((f) => {
            const full = dir + "/" + f;
            return { full, mtime: safeMtimeMs(full) };
        })
            .sort((a, b) => b.mtime - a.mtime);
        for (const c of candidates) {
            try {
                const parsed = JSON.parse(fs.readFileSync(c.full, "utf-8"));
                if (Array.isArray(parsed?.providers) && parsed.providers.length > 0) {
                    return parsed.providers;
                }
            }
            catch {
                // Skip unreadable/invalid backup
            }
        }
    }
    catch {
        // Ignore recovery errors
    }
    return null;
}
/**
 * Merge the providers we're about to save with whatever providers currently exist on
 * disk. Any provider id that exists on disk but is missing from `config` is preserved
 * (appended), so a stale in-memory snapshot from another process can never silently
 * delete provider profiles + API keys. Providers present in `config` always win for
 * matching ids (this is how legitimate updates take effect).
 *
 * This is intentionally skipped for explicit deletions (see removeProvider).
 */
function mergeProvidersWithDisk(config, configPath) {
    try {
        if (!fs.existsSync(configPath))
            return;
        const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (!Array.isArray(onDisk?.providers))
            return;
        const inMemoryIds = new Set((config.providers || []).map((p) => p.id));
        for (const diskProvider of onDisk.providers) {
            if (diskProvider?.id && !inMemoryIds.has(diskProvider.id)) {
                config.providers.push(diskProvider);
            }
        }
    }
    catch {
        // If the on-disk file is unreadable, fall through and write what we have.
    }
}
/**
 * Merge the presets we're about to save with whatever presets currently exist on disk.
 * Any preset id (per mode) that exists on disk but is missing from `config` is preserved,
 * so a stale in-memory snapshot from another process can never silently delete a preset
 * the user created in a different process. Presets present in `config` win for matching ids.
 *
 * Intentionally skipped for explicit deletions (see deletePreset).
 */
function mergePresetsWithDisk(config, configPath) {
    try {
        if (!fs.existsSync(configPath))
            return;
        const onDisk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        if (!onDisk?.presets)
            return;
        for (const mode of ["multi", "single"]) {
            const diskList = onDisk.presets?.[mode];
            if (!Array.isArray(diskList))
                continue;
            if (!config.presets)
                continue;
            const memList = config.presets[mode];
            if (!Array.isArray(memList))
                continue;
            const memIds = new Set(memList.map((p) => p?.id));
            for (const diskPreset of diskList) {
                if (diskPreset?.id && !memIds.has(diskPreset.id)) {
                    memList.push(diskPreset);
                }
            }
        }
    }
    catch {
        // If the on-disk file is unreadable, fall through and write what we have.
    }
}
export function saveModelConfig(config, options = {}) {
    const { mergeProviders = true, mergePresets = true } = options;
    const configPath = getModelConfigPath();
    try {
        ensureGlobalConfigDir();
        // Guard against stale-snapshot overwrites: if another process added providers or
        // presets since this config was loaded, preserve them instead of clobbering the file.
        if (mergeProviders && Array.isArray(config.providers)) {
            mergeProvidersWithDisk(config, configPath);
        }
        if (mergePresets && config.presets) {
            mergePresetsWithDisk(config, configPath);
        }
        // Atomic write: write to a temp file first, then rename.
        // This prevents file corruption if the process is killed (Ctrl+C, crash)
        // during the write — the original file stays intact until rename completes.
        const tmpPath = configPath + ".tmp";
        fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
        // Retry logic for Windows EPERM: antivirus, Windows Search Indexer, or
        // OneDrive may momentarily lock the target file. Retry up to 3 times
        // with a short delay between attempts.
        const MAX_RETRIES = 3;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                fs.renameSync(tmpPath, configPath);
                break; // Success
            }
            catch (renameErr) {
                if (attempt < MAX_RETRIES && (renameErr?.code === "EPERM" || renameErr?.code === "EBUSY" || renameErr?.code === "ENOENT")) {
                    // ENOENT can happen under concurrent test/process interference if tmp or target
                    // is briefly removed between write and rename. Recreate tmp from current config
                    // and retry.
                    try {
                        if (!fs.existsSync(tmpPath)) {
                            fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
                        }
                    }
                    catch { }
                    // Wait briefly before retrying (50ms, 100ms, 150ms)
                    const waitMs = (attempt + 1) * 50;
                    const end = Date.now() + waitMs;
                    while (Date.now() < end) { /* busy wait — short duration */ }
                    continue;
                }
                throw renameErr; // Re-throw if not transient or retries exhausted
            }
        }
        cachedConfig = config;
        cachedConfigMtimeMs = safeMtimeMs(configPath);
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
    mutateModelConfig((config) => {
        const index = config.providers.findIndex((p) => p.id === profile.id);
        if (index !== -1) {
            config.providers[index] = profile;
        }
        else {
            config.providers.push(profile);
        }
    });
}
export function removeProvider(id) {
    // Explicit deletion: bypass provider merge guard so removed provider stays deleted.
    mutateModelConfig((config) => {
        config.providers = config.providers.filter((p) => p.id !== id);
    }, { mergeProviders: false });
}
/**
 * Get system settings with defaults filled in for any missing fields.
 */
export function getSettings() {
    const config = loadModelConfig();
    const s = config.settings || {};
    return {
        concurrencyLimit: s.concurrencyLimit ?? 0,
        rateLimitRpm: s.rateLimitRpm ?? 60,
        rateLimitCapacity: s.rateLimitCapacity ?? 60,
        disableStreaming: s.disableStreaming ?? false,
        contextWindowLimit: s.contextWindowLimit ?? 0,
        maxIterations: s.maxIterations ?? 50,
    };
}
/**
 * Update one or more settings and persist to model-config.json.
 */
export function updateSettings(updates) {
    const config = loadModelConfig();
    if (!config.settings) {
        config.settings = { ...DEFAULT_CONFIG.settings };
    }
    Object.assign(config.settings, updates);
    saveModelConfig(config);
}
export function getPresets(mode) {
    return loadModelConfig().presets[mode];
}
/**
 * Reload latest config from disk, apply a mutation, then persist in one save.
 * Use this for provider/model/preset writes that would otherwise do read-mutate-save
 * on a possibly stale cached snapshot.
 */
export function mutateModelConfig(mutator, options) {
    clearModelConfigCache();
    const config = loadModelConfig();
    mutator(config);
    if (!saveModelConfig(config, options)) {
        throw new Error("Failed to save model config to disk. Check permissions for: " + getRootConfigDir());
    }
}
export function savePreset(mode, preset) {
    mutateModelConfig((config) => {
        const presetsList = config.presets[mode];
        const index = presetsList.findIndex((p) => p.id === preset.id);
        if (index !== -1) {
            presetsList[index] = preset;
        }
        else {
            presetsList.push(preset);
        }
    });
}
export function deletePreset(mode, id) {
    // Reload from disk first so we delete against the current on-disk preset set.
    mutateModelConfig((config) => {
        config.presets[mode] = config.presets[mode].filter((p) => p.id !== id);
    }, { mergePresets: false });
}
export function getActivePresetId(mode) {
    const config = loadModelConfig();
    return config.activePresetId?.[mode] || DEFAULT_CONFIG.activePresetId[mode];
}
export function setActivePresetId(mode, id) {
    mutateModelConfig((config) => {
        config.activePresetId[mode] = id;
    });
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