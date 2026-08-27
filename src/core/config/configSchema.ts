/**
 * Hand-rolled schema validator for `~/.superagent-r/model-config.json`.
 *
 * Audit fix H7: the JSON.parse() boundary in `jsonConfig.ts` was
 * returning a value typed as `any`, and downstream code reached into
 * `parsed.providers`, `parsed.presets`, `parsed.settings`, and
 * `parsed.activePresetId` with no validation. A typo in the file,
 * a partially-written config, or a corrupted backup could silently
 * change the type of any field and crash deep inside unrelated
 * subsystems.
 *
 * Why hand-rolled and not zod:
 *  - The project has zero runtime schema-validation dependencies
 *    today. Adding zod would inflate the install footprint and
 *    the bundle size for a single load site.
 *  - The schema is small (3 top-level shapes) and unlikely to grow
 *    in ways a hand-rolled validator cannot handle.
 *  - The validator returns a `Result<T>` and is fully strict-mode
 *    safe; the public surface is one function per shape plus
 *    `validateModelConfig()` for the whole document.
 *
 * If the schema ever grows beyond ~200 lines or needs coercion /
 * refinement that hand-rolling can't express cleanly, we should
 * revisit introducing zod (or a similar library) at that point.
 */
import type {
  GlobalModelConfig,
  ProviderProfile,
  PresetModelsMulti,
  PresetModelsSingle,
  JSONModelPreset,
  SystemSettings,
  TierModelConfig,
  McpServerConfig,
} from "./jsonConfig.js";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/**
 * Run a validator and return a short error list. Throws nothing —
 * a malformed config never crashes the loader; the caller decides
 * whether to fall back to defaults or surface the error.
 */
function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
function fail<T = never>(errors: string[]): ValidationResult<T> {
  return { ok: false, errors };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isOptionalString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function validateProviderProfile(input: unknown): ValidationResult<ProviderProfile> {
  if (!isObject(input)) {
    return fail(["provider must be an object"]);
  }
  const errors: string[] = [];
  if (!isString(input.id) || input.id.trim() === "") errors.push("provider.id: non-empty string required");
  if (!isString(input.name) || input.name.trim() === "") errors.push("provider.name: non-empty string required");
  if (!isString(input.provider) || input.provider.trim() === "") errors.push("provider.provider: non-empty string required");
  if (!isString(input.apiKey)) errors.push("provider.apiKey: string required (may be empty)");
  if (input.baseUrl !== undefined && !isString(input.baseUrl)) {
    errors.push("provider.baseUrl: string or undefined");
  }
  if (errors.length) return fail(errors);
  const out: ProviderProfile = {
    id: input.id as string,
    name: input.name as string,
    provider: input.provider as string,
    apiKey: input.apiKey as string,
    baseUrl: input.baseUrl as string | undefined,
  };
  return ok(out);
}

function validateProviderProfiles(input: unknown): ValidationResult<ProviderProfile[]> {
  if (!Array.isArray(input)) return fail(["providers must be an array"]);
  const out: ProviderProfile[] = [];
  const errors: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = validateProviderProfile(input[i]);
    if (!r.ok) {
      for (const e of r.errors) errors.push(`providers[${i}]: ${e}`);
    } else {
      out.push(r.value);
    }
  }
  if (errors.length) return fail(errors);
  return ok(out);
}

function validateTierModelConfig(input: unknown, path: string): ValidationResult<TierModelConfig> {
  if (!isObject(input)) {
    return fail([`${path}: must be an object`]);
  }
  const errors: string[] = [];
  if (!isString(input.providerProfileId) && input.providerProfileId !== undefined) {
    errors.push(`${path}.providerProfileId: string or undefined`);
  }
  if (!isString(input.model) && input.model !== undefined) {
    errors.push(`${path}.model: string or undefined`);
  }
  if (errors.length) return fail(errors);
  const out: TierModelConfig = {
    providerProfileId: (input.providerProfileId as string) ?? "",
    model: (input.model as string) ?? "",
  };
  return ok(out);
}

function validatePresetMulti(input: unknown): ValidationResult<JSONModelPreset<PresetModelsMulti>> {
  if (!isObject(input)) return fail(["preset must be an object"]);
  const errors: string[] = [];
  if (!isString(input.id) || input.id.trim() === "") errors.push("preset.id: non-empty string required");
  if (!isString(input.name)) errors.push("preset.name: string required");
  if (!isString(input.description)) errors.push("preset.description: string required");
  if (input.tierModels !== undefined) {
    if (!isObject(input.tierModels)) {
      errors.push("preset.tierModels: object or undefined");
    } else {
      const tm = input.tierModels;
      const tiers = [
        "master", "superagent", "subagent", "researcher", "coder", "reviewer",
      ] as const;
      for (const t of tiers) {
        if (tm[t] !== undefined) {
          const r = validateTierModelConfig(tm[t], `tierModels.${t}`);
          if (!r.ok) for (const e of r.errors) errors.push(e);
        }
      }
    }
  }
  if (input.subagentModels !== undefined) {
    if (!isObject(input.subagentModels)) {
      errors.push("preset.subagentModels: object or undefined");
    } else {
      for (const [k, v] of Object.entries(input.subagentModels)) {
        if (v !== undefined) {
          const r = validateTierModelConfig(v, `subagentModels.${k}`);
          if (!r.ok) for (const e of r.errors) errors.push(e);
        }
      }
    }
  }
  if (errors.length) return fail(errors);
  return ok(input as unknown as JSONModelPreset<PresetModelsMulti>);
}

function validatePresetSingle(input: unknown): ValidationResult<JSONModelPreset<PresetModelsSingle>> {
  if (!isObject(input)) return fail(["preset must be an object"]);
  const errors: string[] = [];
  if (!isString(input.id) || input.id.trim() === "") errors.push("preset.id: non-empty string required");
  if (!isString(input.name)) errors.push("preset.name: string required");
  if (!isString(input.description)) errors.push("preset.description: string required");
  if (input.tierModels !== undefined) {
    if (!isObject(input.tierModels)) {
      errors.push("preset.tierModels: object or undefined");
    } else {
      const tm = input.tierModels;
      const tiers = ["master", "superagent", "subagent"] as const;
      for (const t of tiers) {
        if (tm[t] !== undefined) {
          const r = validateTierModelConfig(tm[t], `tierModels.${t}`);
          if (!r.ok) for (const e of r.errors) errors.push(e);
        }
      }
    }
  }
  if (errors.length) return fail(errors);
  return ok(input as unknown as JSONModelPreset<PresetModelsSingle>);
}

function validatePresets(input: unknown): ValidationResult<{
  multi: JSONModelPreset<PresetModelsMulti>[];
  single: JSONModelPreset<PresetModelsSingle>[];
}> {
  if (!isObject(input)) return fail(["presets must be an object"]);
  const errors: string[] = [];
  const multi = Array.isArray(input.multi) ? input.multi : [];
  const single = Array.isArray(input.single) ? input.single : [];
  const multiOut: JSONModelPreset<PresetModelsMulti>[] = [];
  for (let i = 0; i < multi.length; i++) {
    const r = validatePresetMulti(multi[i]);
    if (!r.ok) for (const e of r.errors) errors.push(`presets.multi[${i}]: ${e}`);
    else multiOut.push(r.value);
  }
  const singleOut: JSONModelPreset<PresetModelsSingle>[] = [];
  for (let i = 0; i < single.length; i++) {
    const r = validatePresetSingle(single[i]);
    if (!r.ok) for (const e of r.errors) errors.push(`presets.single[${i}]: ${e}`);
    else singleOut.push(r.value);
  }
  if (errors.length) return fail(errors);
  return ok({ multi: multiOut, single: singleOut });
}

function validateSettings(input: unknown): ValidationResult<SystemSettings> {
  if (!isObject(input)) return fail(["settings must be an object"]);
  // SystemSettings has ~30 fields; we only validate the well-known
  // numeric/boolean ones. Unknown keys pass through and are
  // preserved. This is a balance: we don't want to reject old
  // configs that have new fields the user doesn't know about, but
  // we DO want to reject obvious corruption.
  const errors: string[] = [];
  const numFields = [
    "concurrencyLimit", "rateLimitRpm", "rateLimitCapacity", "simpleTaskFileThreshold",
    "maxChecklistVisible", "maxHistoryVisible", "maxProcsVisible",
    "rmemoryEmbeddingDimensions", "advisorWarningThreshold", "advisorPauseThreshold",
    "advisorErrorThreshold", "contextWindowLimit", "maxIterations",
  ] as const;
  for (const f of numFields) {
    if ((input as any)[f] !== undefined && !isNumber((input as any)[f])) {
      errors.push(`settings.${f}: number required`);
    }
  }
  const boolFields = [
    "forcePromptBasedToolCalling", "enableRmemory", "enableAdvisor",
    "advisorAdaptiveScaling", "advisorPatternMemory", "disableStreaming",
  ] as const;
  for (const f of boolFields) {
    if ((input as any)[f] !== undefined && !isBoolean((input as any)[f])) {
      errors.push(`settings.${f}: boolean required`);
    }
  }
  if (input.simpleTaskKeywords !== undefined && !isStringArray(input.simpleTaskKeywords)) {
    errors.push("settings.simpleTaskKeywords: string[] required");
  }
  if (errors.length) return fail(errors);
  return ok(input as unknown as SystemSettings);
}

function validateMcpServerConfig(input: unknown, path: string): ValidationResult<McpServerConfig> {
  if (!isObject(input)) return fail([`${path}: must be an object`]);
  const errors: string[] = [];
  if (!isString(input.id) || input.id.trim() === "") errors.push(`${path}.id: non-empty string required`);
  if (!isString(input.name) || input.name.trim() === "") errors.push(`${path}.name: non-empty string required`);
  if (!isString(input.command) || input.command.trim() === "") errors.push(`${path}.command: non-empty string required`);
  if (input.args !== undefined && !isStringArray(input.args) && !Array.isArray(input.args)) {
    errors.push(`${path}.args: string[] or undefined`);
  }
  if (input.env !== undefined && !isObject(input.env)) {
    errors.push(`${path}.env: object or undefined`);
  } else if (isObject(input.env)) {
    for (const [k, v] of Object.entries(input.env)) {
      if (!isString(v)) errors.push(`${path}.env.${k}: string required`);
    }
  }
  if (errors.length) return fail(errors);
  return ok(input as unknown as McpServerConfig);
}

function validateMcpServers(input: unknown): ValidationResult<McpServerConfig[]> {
  if (!Array.isArray(input)) return fail(["mcpServers must be an array"]);
  const out: McpServerConfig[] = [];
  const errors: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const r = validateMcpServerConfig(input[i], `mcpServers[${i}]`);
    if (!r.ok) for (const e of r.errors) errors.push(e);
    else out.push(r.value);
  }
  if (errors.length) return fail(errors);
  return ok(out);
}

export function validateModelConfig(input: unknown): ValidationResult<Partial<GlobalModelConfig>> {
  if (!isObject(input)) return fail(["root: must be an object"]);
  const out: Partial<GlobalModelConfig> = {};
  const errors: string[] = [];

  if (input.providers !== undefined) {
    const r = validateProviderProfiles(input.providers);
    if (r.ok) out.providers = r.value;
    else for (const e of r.errors) errors.push(e);
  }
  if (input.presets !== undefined) {
    const r = validatePresets(input.presets);
    if (r.ok) out.presets = r.value as any;
    else for (const e of r.errors) errors.push(e);
  }
  if (input.activePresetId !== undefined) {
    if (!isString(input.activePresetId)) errors.push("activePresetId: string required");
    else out.activePresetId = { multi: input.activePresetId, single: input.activePresetId };
  }
  if (input.settings !== undefined) {
    const r = validateSettings(input.settings);
    if (r.ok) out.settings = r.value;
    else for (const e of r.errors) errors.push(e);
  }
  if (input.mcpServers !== undefined) {
    const r = validateMcpServers(input.mcpServers);
    if (r.ok) out.mcpServers = r.value as any;
    else for (const e of r.errors) errors.push(e);
  }

  if (errors.length) return fail(errors);
  return ok(out);
}
