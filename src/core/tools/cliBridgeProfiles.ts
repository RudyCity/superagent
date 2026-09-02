/**
 * cliBridgeProfiles.ts — Per-CLI configuration profiles for the
 * `cli_bridge` tool.
 *
 * A "profile" is a per-CLI bundle of:
 *   - defaultArgs         : flags prepended to every invocation
 *   - resumeFlag          : flag used by `session.resume` to continue context
 *   - resumeArgStyle      : "value" (--flag <id>) or "equals" (--flag=<id>) or "none"
 *   - skillsArg           : flag used to register an extra skill directory
 *                          (e.g. AGY: --add-dir, repeated per skill)
 *   - skillsRepeatable    : true if the flag can be repeated (e.g. --add-dir)
 *   - skillsRegistry      : named skills for this profile (name → path)
 *   - autoDetect          : if true (default), auto-include AGENTS.md etc.
 *   - promptAsArg         : whether to auto-append the prompt as the last arg
 *   - promptSubcommand    : subcommand to invoke the prompt (e.g. Codex: ["exec"])
 *   - defaultPromptTemplate : template with {system}/{prompt} placeholders
 *   - interactiveFlag     : flag that makes the CLI enter interactive mode
 *   - envPassthrough      : env vars that MUST be present in the subprocess
 *   - envAllowList        : if non-empty, only these env vars are forwarded
 *
 * Built-in defaults cover codex / claude / agy. User can override by placing
 * a JSON file at `~/.superagent-r/cli-bridge/profiles.json` whose keys are
 * alias names and whose values are partial profiles. The loader deep-merges
 * partial profiles on top of the built-in defaults.
 *
 * Example override:
 *   {
 *     "agy": { "defaultArgs": ["--effort", "high"] }
 *   }
 */

import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";

// ─── Public types ────────────────────────────────────────────────────────

export interface SkillEntry {
  path: string;
  description?: string;
  autoLoad?: boolean;
}

export interface CliProfile {
  alias: string;
  defaultArgs: string[];
  resumeFlag: string | null;
  resumeArgStyle: "value" | "equals" | "none";
  skillsArg: string | null;
  skillsRepeatable: boolean;
  /** v1.5.16: named skills (name → path/description/autoLoad). */
  skillsRegistry: Record<string, SkillEntry>;
  /** v1.5.16: if true, auto-include AGENTS.md/CLAUDE.md/etc from cwd. */
  autoDetect: boolean;
  promptAsArg: boolean;
  promptSubcommand: string[];
  /**
   * v1.5.16: template applied to {system} and {prompt} before the prompt
   * is appended. Default: `"{system}\n\n{prompt}"`. If the template
   * contains {prompt}, the {prompt} placeholder is replaced. If it
   * contains {system} and no system is provided, the placeholder is
   * removed cleanly.
   */
  defaultPromptTemplate: string;
  interactiveFlag: string | null;
  envPassthrough: string[];
  envAllowList: string[] | null;
  /** Bumped when the shape changes; loader uses this to log a warning. */
  schemaVersion: number;
}

export const PROFILE_SCHEMA_VERSION = 2;
export const PROFILE_FILE_NAME = "cli-bridge/profiles.json";

// ─── Built-in defaults ───────────────────────────────────────────────────

export function builtinProfiles(): Record<string, CliProfile> {
  return {
    codex: {
      alias: "codex",
      defaultArgs: ["--skip-git-repo-check"],
      resumeFlag: "resume",
      resumeArgStyle: "value",
      skillsArg: "cd",
      skillsRepeatable: false,
      skillsRegistry: {},
      autoDetect: true,
      promptAsArg: true,
      promptSubcommand: ["exec"],
      defaultPromptTemplate: "{system}\n\n{prompt}",
      interactiveFlag: null,
      envPassthrough: ["OPENAI_API_KEY", "CODEX_HOME"],
      envAllowList: null,
      schemaVersion: PROFILE_SCHEMA_VERSION,
    },
    claude: {
      alias: "claude",
      defaultArgs: [],
      resumeFlag: "continue",
      resumeArgStyle: "value",
      skillsArg: "add-dir",
      skillsRepeatable: true,
      skillsRegistry: {
        // No built-ins — Claude Code reads CLAUDE.md automatically
        // when --add-dir is given, so we don't predefine anything.
      },
      autoDetect: true,
      promptAsArg: true,
      promptSubcommand: ["--print"],
      defaultPromptTemplate: "{system}\n\n{prompt}",
      interactiveFlag: null,
      envPassthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
      envAllowList: null,
      schemaVersion: PROFILE_SCHEMA_VERSION,
    },
    agy: {
      alias: "agy",
      defaultArgs: [],
      resumeFlag: "continue",
      resumeArgStyle: "value",
      skillsArg: "add-dir",
      skillsRepeatable: true,
      skillsRegistry: {},
      autoDetect: true,
      promptAsArg: true,
      promptSubcommand: ["-p"],
      defaultPromptTemplate: "{system}\n\n{prompt}",
      interactiveFlag: "i",
      envPassthrough: ["ANTIGRAVITY_API_KEY", "AGY_HOME"],
      envAllowList: null,
      schemaVersion: PROFILE_SCHEMA_VERSION,
    },
  };
}

// ─── Loader ──────────────────────────────────────────────────────────────

let cachedProfiles: Record<string, CliProfile> | null = null;
let cachedOverrideMtime = 0;

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(override)) {
    const v = (override as any)[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

/**
 * Load all profiles (built-ins + user overrides). Cached in-memory; cached
 * busts when the override file's mtime changes.
 */
export function loadProfiles(): Record<string, CliProfile> {
  const base = builtinProfiles();
  const overridePath = path.join(getRootConfigDir(), PROFILE_FILE_NAME);

  let override: Record<string, Partial<CliProfile>> = {};
  let mtime = 0;
  try {
    if (fs.existsSync(overridePath)) {
      mtime = fs.statSync(overridePath).mtimeMs;
      const raw = fs.readFileSync(overridePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        override = parsed;
      }
    }
  } catch {
    // Bad JSON or unreadable file — fall back to defaults silently.
    override = {};
  }

  if (cachedProfiles && mtime === cachedOverrideMtime) {
    return cachedProfiles;
  }

  const merged: Record<string, CliProfile> = {};
  const allKeys = new Set([...Object.keys(base), ...Object.keys(override)]);
  for (const key of allKeys) {
    const b = base[key];
    if (!b) {
      // User defined a profile for a CLI we don't know about — pass through
      // with sensible defaults for any missing fields.
      const o = override[key] as any;
      merged[key] = {
        alias: key,
        defaultArgs: o.defaultArgs ?? [],
        resumeFlag: o.resumeFlag ?? null,
        resumeArgStyle: o.resumeArgStyle ?? "value",
        skillsArg: o.skillsArg ?? null,
        skillsRepeatable: o.skillsRepeatable ?? false,
        skillsRegistry: o.skillsRegistry ?? {},
        autoDetect: o.autoDetect ?? true,
        promptAsArg: o.promptAsArg ?? true,
        promptSubcommand: o.promptSubcommand ?? [],
        defaultPromptTemplate: o.defaultPromptTemplate ?? "{system}\n\n{prompt}",
        interactiveFlag: o.interactiveFlag ?? null,
        envPassthrough: o.envPassthrough ?? [],
        envAllowList: o.envAllowList ?? null,
        schemaVersion: o.schemaVersion ?? PROFILE_SCHEMA_VERSION,
      };
      continue;
    }
    merged[key] = deepMerge(b, override[key] ?? {});
    merged[key].alias = key;
    merged[key].schemaVersion = PROFILE_SCHEMA_VERSION;
    // v1.5.16: make sure new fields always have values even if the user
    // overrode only some fields. `??` on the right side handles the case
    // where deepMerge replaced the field with `undefined` or never set it.
    if (!merged[key].skillsRegistry) merged[key].skillsRegistry = {};
    if (typeof merged[key].autoDetect !== "boolean") merged[key].autoDetect = true;
    if (typeof merged[key].defaultPromptTemplate !== "string") {
      merged[key].defaultPromptTemplate = "{system}\n\n{prompt}";
    }
  }

  cachedProfiles = merged;
  cachedOverrideMtime = mtime;
  return merged;
}

/**
 * Get a single profile by alias. Returns `null` if unknown.
 */
export function getProfile(alias: string): CliProfile | null {
  const all = loadProfiles();
  return all[alias.toLowerCase()] ?? null;
}

/**
 * Build the full argv for `session.create` using the profile's defaults +
 * caller-supplied skills. If `conversationId` is given, the resume flag is
 * prepended. If `interactive` is true and the profile defines an
 * interactiveFlag, that flag is added.
 */
export function buildSessionArgv(
  profile: CliProfile,
  opts: {
    skills?: string[];
    conversationId?: string;
    resume?: boolean;
    interactive?: boolean;
    extraArgs?: string[];
  } = {}
): string[] {
  const argv: string[] = [];

  if (opts.resume && profile.resumeFlag) {
    argv.push(`--${profile.resumeFlag}`);
    if (opts.conversationId && profile.resumeArgStyle === "value") {
      argv.push(opts.conversationId);
    } else if (opts.conversationId && profile.resumeArgStyle === "equals") {
      // merge into the previous --flag
      argv[argv.length - 1] = `${argv[argv.length - 1]}=${opts.conversationId}`;
    }
  }

  if (profile.defaultArgs && profile.defaultArgs.length > 0) {
    argv.push(...profile.defaultArgs);
  }

  if (opts.interactive && profile.interactiveFlag) {
    // "i" → "-i"; "interactive" → "--interactive"
    const flag = profile.interactiveFlag.length === 1 ? `-${profile.interactiveFlag}` : `--${profile.interactiveFlag}`;
    argv.push(flag);
  }

  if (opts.skills && opts.skills.length > 0 && profile.skillsArg) {
    if (profile.skillsRepeatable) {
      for (const s of opts.skills) {
        argv.push(`--${profile.skillsArg}`, s);
      }
    } else {
      // Single-slot skillsArg (e.g. Codex's --cd): use the first skill only
      argv.push(`--${profile.skillsArg}`, opts.skills[0]);
    }
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    argv.push(...opts.extraArgs);
  }

  return argv;
}

/**
 * Build the env for the subprocess. If `envAllowList` is set, only those
 * keys (plus `envPassthrough`) are forwarded. Otherwise we forward
 * `envPassthrough` keys from `process.env` and let the rest of the env
 * pass through unchanged.
 */
export function buildSessionEnv(
  profile: CliProfile,
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = profile.envAllowList
    ? {}
    : { ...process.env };

  for (const k of profile.envPassthrough) {
    if (process.env[k] !== undefined) {
      env[k] = process.env[k];
    }
  }

  for (const [k, v] of Object.entries(overrides)) {
    env[k] = v;
  }

  return env;
}

/** Test-only: drop cache. */
export function __resetProfileCacheForTests(): void {
  cachedProfiles = null;
  cachedOverrideMtime = 0;
}

/**
 * v1.5.16: Apply the profile's `defaultPromptTemplate` to substitute
 * `{system}` and `{prompt}`. If `system` is empty, the `{system}` token
 * (and any leftover blank lines it leaves behind) are removed cleanly.
 *
 * The substitution is intentionally simple and string-based — we never
 * `eval` or `exec` the template. Unknown `{xxx}` tokens are left as-is
 * (so the user can see typos).
 *
 * Examples:
 *   applyPromptTemplate("{system}\n\n{prompt}", { system: "X", prompt: "Y" })
 *     → "X\n\nY"
 *   applyPromptTemplate("{system}\n\n{prompt}", { system: "", prompt: "Y" })
 *     → "Y"   (cleaned: empty system + leading blank line collapsed)
 *   applyPromptTemplate("Role: {system}\n\n{prompt}", { system: "expert", prompt: "review this" })
 *     → "Role: expert\n\nreview this"
 */
export function applyPromptTemplate(
  template: string,
  vars: { system?: string; prompt: string }
): string {
  const systemText = (vars.system ?? "").trim();
  const promptText = vars.prompt ?? "";
  // Replace {system} with the system text, or empty if none.
  let out = template.replace(/\{system\}/g, systemText);
  out = out.replace(/\{prompt\}/g, promptText);
  // Cleanup: collapse "X\n\n\nY" → "X\n\nY" and " \n\nY" → "Y"
  out = out.replace(/\n{3,}/g, "\n\n");
  // If system was empty, leading "\n\n" before the prompt is removed
  if (!systemText) {
    out = out.replace(/^\s*\n+/, "");
  }
  return out;
}
