import { ensureGlobalConfigDir, getRootConfigDir } from "./paths.js";
import { loadModelConfig, getActivePreset, savePreset, saveModelConfig } from "./jsonConfig.js";
// Populate process.env with settings from model-config.json on startup.
// Provider credentials are resolved directly from JSON config — no env var population needed.
try {
    const config = loadModelConfig();
    if (config.settings) {
        const s = config.settings;
        if (s.concurrencyLimit !== undefined) {
            process.env.SUPERAGENT_MAX_CONCURRENCY = String(s.concurrencyLimit);
        }
        if (s.rateLimitRpm !== undefined) {
            process.env.SUPERAGENT_RATE_LIMIT_RPM = String(s.rateLimitRpm);
        }
        if (s.rateLimitCapacity !== undefined) {
            process.env.SUPERAGENT_RATE_LIMIT_CAPACITY = String(s.rateLimitCapacity);
        }
        if (s.disableStreaming !== undefined) {
            process.env.DISABLE_STREAMING = s.disableStreaming ? "true" : "";
        }
        if (s.contextWindowLimit !== undefined && s.contextWindowLimit > 0) {
            process.env.CONTEXT_WINDOW_LIMIT = String(s.contextWindowLimit);
        }
        if (s.maxIterations !== undefined) {
            process.env.MAX_ITERATIONS = String(s.maxIterations);
        }
    }
}
catch (error) {
    // Ignore errors during initial startup load
}
function parseTierConfig(val) {
    // Use `@` as the profile/model separator to avoid ambiguity with model names
    // that themselves contain `:`, e.g. openrouter/nex-agi/nex-n2-pro:free.
    const atIndex = (val || "").indexOf("@");
    if (atIndex > 0) {
        return { providerProfileId: val.substring(0, atIndex), model: val.substring(atIndex + 1) };
    }
    // Backward compatibility: legacy values used `:` as the separator.
    const colonIndex = (val || "").indexOf(":");
    if (colonIndex > 0 && !val.substring(0, colonIndex).includes("/")) {
        return { providerProfileId: val.substring(0, colonIndex), model: val.substring(colonIndex + 1) };
    }
    return { providerProfileId: "default-openai", model: val || "gpt-4o" };
}
/**
 * Update runtime config: syncs updates to process.env (in-memory) and
 * persists relevant changes to model-config.json (synchronous).
 *
 * .env file is NO LONGER used — all persistent config lives in model-config.json.
 */
export function updateEnvFile(updates) {
    ensureGlobalConfigDir();
    // Update process.env so changes are immediate in memory
    for (const [key, val] of Object.entries(updates)) {
        if (val === "") {
            delete process.env[key];
        }
        else {
            process.env[key] = val;
        }
    }
    // Synchronize MODEL_MULTI_* / MODEL_SINGLE_* keys to the active preset in model-config.json.
    // This is SYNCHRONOUS to prevent data loss if the process exits (Ctrl+C) before an async
    // promise resolves.
    const multiKeys = Object.keys(updates).filter(k => k.startsWith("MODEL_MULTI_"));
    const singleKeys = Object.keys(updates).filter(k => k.startsWith("MODEL_SINGLE_"));
    if (multiKeys.length > 0 || singleKeys.length > 0) {
        try {
            const modesToSync = [];
            if (multiKeys.length > 0)
                modesToSync.push("multi");
            if (singleKeys.length > 0)
                modesToSync.push("single");
            if (modesToSync.length === 0) {
                if (process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true") {
                    modesToSync.push("multi");
                }
                else {
                    modesToSync.push("single");
                }
            }
            for (const mode of modesToSync) {
                const keysForMode = mode === "multi" ? multiKeys : singleKeys;
                if (keysForMode.length === 0)
                    continue;
                const preset = getActivePreset(mode);
                if (!preset.models.subagentDetails) {
                    preset.models.subagentDetails = {};
                }
                for (const key of keysForMode) {
                    const val = updates[key];
                    const isClear = !val || val.trim() === "";
                    if (mode === "multi") {
                        if (key === "MODEL_MULTI_MASTER") {
                            if (!isClear)
                                preset.models.master = parseTierConfig(val);
                        }
                        else if (key === "MODEL_MULTI_SUPERAGENT") {
                            if (!isClear)
                                preset.models.superagent = parseTierConfig(val);
                        }
                        else if (key === "MODEL_MULTI_SUBAGENT") {
                            if (!isClear)
                                preset.models.subagentDefault = parseTierConfig(val);
                        }
                        else if (key.startsWith("MODEL_MULTI_SUBAGENT_")) {
                            const type = key.replace("MODEL_MULTI_SUBAGENT_", "").toLowerCase();
                            if (isClear) {
                                delete preset.models.subagentDetails[type];
                            }
                            else {
                                preset.models.subagentDetails[type] = parseTierConfig(val);
                            }
                        }
                    }
                    else {
                        if (key === "MODEL_SINGLE_SUPERAGENT") {
                            if (!isClear)
                                preset.models.superagent = parseTierConfig(val);
                        }
                        else if (key === "MODEL_SINGLE_SUBAGENT") {
                            if (!isClear)
                                preset.models.subagentDefault = parseTierConfig(val);
                        }
                        else if (key.startsWith("MODEL_SINGLE_SUBAGENT_")) {
                            const type = key.replace("MODEL_SINGLE_SUBAGENT_", "").toLowerCase();
                            if (isClear) {
                                delete preset.models.subagentDetails[type];
                            }
                            else {
                                preset.models.subagentDetails[type] = parseTierConfig(val);
                            }
                        }
                    }
                }
                savePreset(mode, preset);
            }
        }
        catch (err) {
            // Ignore sync errors
        }
    }
    // Synchronize settings updates to model-config.json (synchronous)
    const settingKeys = Object.keys(updates).filter(k => k === "SUPERAGENT_MAX_CONCURRENCY" ||
        k === "SUPERAGENT_RATE_LIMIT_RPM" ||
        k === "SUPERAGENT_RATE_LIMIT_CAPACITY" ||
        k === "DISABLE_STREAMING" ||
        k === "CONTEXT_WINDOW_LIMIT" ||
        k === "MAX_CONTEXT_TOKENS" ||
        k === "MAX_ITERATIONS");
    if (settingKeys.length > 0) {
        try {
            const config = loadModelConfig();
            if (!config.settings) {
                config.settings = { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60, disableStreaming: false, contextWindowLimit: 0, maxIterations: 50 };
            }
            for (const key of settingKeys) {
                const val = updates[key];
                if (key === "SUPERAGENT_MAX_CONCURRENCY") {
                    config.settings.concurrencyLimit = parseInt(val, 10) || 0;
                }
                else if (key === "SUPERAGENT_RATE_LIMIT_RPM") {
                    config.settings.rateLimitRpm = parseInt(val, 10) || 0;
                }
                else if (key === "SUPERAGENT_RATE_LIMIT_CAPACITY") {
                    config.settings.rateLimitCapacity = parseInt(val, 10) || 0;
                }
                else if (key === "DISABLE_STREAMING") {
                    config.settings.disableStreaming = val === "true";
                }
                else if (key === "CONTEXT_WINDOW_LIMIT" || key === "MAX_CONTEXT_TOKENS") {
                    config.settings.contextWindowLimit = parseInt(val, 10) || 0;
                }
                else if (key === "MAX_ITERATIONS") {
                    config.settings.maxIterations = parseInt(val, 10) || 50;
                }
            }
            saveModelConfig(config);
        }
        catch (err) {
            // Ignore sync errors
        }
    }
    // Return the JSON config path (for backward compatibility with callers that use the return value)
    return getRootConfigDir() + "/model-config.json";
}
//# sourceMappingURL=env.js.map