export type PresetMode = "multi" | "single";
export interface ModelPreset {
    name: string;
    description: string;
    models: Record<string, string>;
}
/** New separated JSON structure */
export interface ModelPresetsFile {
    multi: ModelPreset[];
    single: ModelPreset[];
}
export declare function getCustomPresetsPath(): string;
export declare const BUILT_IN_PRESETS: ModelPreset[];
/**
 * Get all model presets for a specific mode.
 * - mode is REQUIRED — presets are physically separated by mode in the JSON file.
 * - If mode is omitted, returns all presets from both sections (with mode tag for display).
 */
export declare function getModelPresets(mode?: PresetMode): (ModelPreset & {
    mode?: PresetMode;
})[];
/**
 * Save a model preset into the mode-specific section of model-presets.json.
 * - mode is REQUIRED to determine which section to store in.
 *   Defaults to "multi" if not provided (backward compat).
 */
export declare function saveModelPreset(name: string, description: string, models?: Record<string, string>, mode?: PresetMode): string;
/**
 * Apply a model preset by name from a specific mode section.
 * - mode is REQUIRED to know which section to search.
 *   Defaults to "multi" if not provided.
 */
export declare function applyModelPreset(name: string, mode?: PresetMode): void;
/**
 * Delete a model preset by name from a specific mode section.
 */
export declare function deleteModelPreset(name: string, mode?: PresetMode): string;
/**
 * Update a model preset by name in a specific mode section.
 */
export declare function updateModelPreset(name: string, description: string, models?: Record<string, string>, mode?: PresetMode): string;
//# sourceMappingURL=presets.d.ts.map