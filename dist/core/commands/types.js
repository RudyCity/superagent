import { getEffectiveMasterModel, getActiveProviderName } from "../config.js";
export function getProviderLabel() {
    return getActiveProviderName();
}
export function getDefaultModel() {
    return getEffectiveMasterModel("auto") || "gpt-4o";
}
export function formatPresetValue(preset) {
    if (!preset)
        return "";
    if (typeof preset === "string") {
        return preset;
    }
    if (Array.isArray(preset)) {
        return `[ ${preset.map(p => formatPresetValue(p)).join(" ; ")} ]`;
    }
    if (typeof preset === "object" && preset !== null) {
        const parts = [];
        if (preset.command) {
            parts.push(`cmd: "${preset.command}"`);
        }
        if (preset.description) {
            parts.push(`desc: "${preset.description}"`);
        }
        if (preset.cwd) {
            parts.push(`cwd: "${preset.cwd}"`);
        }
        if (preset.background) {
            parts.push("bg: true");
        }
        if (preset.env && Object.keys(preset.env).length > 0) {
            parts.push(`env: ${JSON.stringify(preset.env)}`);
        }
        return `{ ${parts.join(", ")} }`;
    }
    return JSON.stringify(preset);
}
export function getPresetLabel(key, val) {
    if (val && typeof val === "object" && val.name) {
        return val.name;
    }
    return key;
}
export function findPreset(presets, nameOrKey) {
    if (presets[nameOrKey] !== undefined) {
        return { key: nameOrKey, value: presets[nameOrKey] };
    }
    const lowerName = nameOrKey.toLowerCase();
    for (const k of Object.keys(presets)) {
        if (k.toLowerCase() === lowerName) {
            return { key: k, value: presets[k] };
        }
        const val = presets[k];
        if (val && typeof val === "object" && val.name && String(val.name).toLowerCase() === lowerName) {
            return { key: k, value: val };
        }
    }
    return null;
}
//# sourceMappingURL=types.js.map