/**
 * cliBridgeSkills.ts — Global skill registry + project-root auto-detect for
 * the `cli_bridge` tool.
 *
 * Two responsibilities:
 *   1. Load the global skill registry from
 *      `~/.superagent-r/cli-bridge/skills.json`. Each entry maps a short
 *      name (e.g. "security") to a path + description. Profiles can also
 *      define their own local registry, which takes precedence.
 *   2. Auto-detect skill markdown files in a project root:
 *         AGENTS.md      — universal agent guidance (read by AGY, Codex, Claude)
 *         AGENTS.local.md — gitignored local override, if present
 *         CLAUDE.md      — Claude Code convention
 *         AGY.md         — AGY-specific
 *         CODEX.md       — Codex-specific
 *
 * Auto-detect only runs when the profile's `autoDetect` is true (default).
 *
 * Why a separate file: keeps the (larger) profile/session modules focused
 * on session lifecycle, and makes it easy to test the registry loader in
 * isolation.
 */

import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";

// ─── Public types ────────────────────────────────────────────────────────

export interface SkillEntry {
  /** Filesystem path (directory or markdown file) the CLI can consume. */
  path: string;
  /** Optional human-readable description. */
  description?: string;
  /**
   * If true, this skill is automatically added to every session that uses
   * the owning profile. Defaults to false.
   */
  autoLoad?: boolean;
}

export type GlobalSkillRegistry = Record<string, SkillEntry>;

/** v1.5.16: Schema version. Bumped when the JSON shape changes. */
export const SKILL_REGISTRY_SCHEMA_VERSION = 1;
export const SKILL_REGISTRY_FILE_NAME = "cli-bridge/skills.json";

/** v1.5.16: Filenames we look for in auto-detect, in priority order. */
export const AUTO_DETECT_FILES = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "AGY.md",
  "CODEX.md",
];

// ─── Global registry loader ─────────────────────────────────────────────

let cachedRegistry: GlobalSkillRegistry | null = null;
let cachedRegistryMtime = 0;

/**
 * Load the global skill registry. Cached in-memory; cached entry is
 * dropped when the file's mtime changes.
 */
export function loadGlobalSkillRegistry(): GlobalSkillRegistry {
  const filePath = path.join(getRootConfigDir(), SKILL_REGISTRY_FILE_NAME);

  let mtime = 0;
  let parsed: any = {};
  try {
    if (fs.existsSync(filePath)) {
      mtime = fs.statSync(filePath).mtimeMs;
      const raw = fs.readFileSync(filePath, "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj;
      }
    }
  } catch {
    // Bad JSON or unreadable — fall back to empty registry silently.
    parsed = {};
  }

  if (cachedRegistry && mtime === cachedRegistryMtime) {
    return cachedRegistry;
  }

  const out: GlobalSkillRegistry = {};
  for (const [name, val] of Object.entries(parsed)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, any>;
    if (typeof v.path !== "string" || v.path.length === 0) continue;
    out[name] = {
      path: v.path,
      description: typeof v.description === "string" ? v.description : undefined,
      autoLoad: v.autoLoad === true,
    };
  }
  cachedRegistry = out;
  cachedRegistryMtime = mtime;
  return out;
}

/** Test-only: drop the cache. */
export function __resetSkillRegistryCacheForTests(): void {
  cachedRegistry = null;
  cachedRegistryMtime = 0;
}

// ─── Auto-detect ────────────────────────────────────────────────────────

export interface AutoDetectResult {
  /** Absolute paths to files that exist in `cwd`. */
  paths: string[];
  /** The basename of each path (for debugging). */
  names: string[];
}

/**
 * Scan `cwd` for the standard agent-skill markdown files. Returns only
 * the ones that actually exist on disk. Empty array if none found.
 *
 * Note: this is intentionally NOT recursive. AGENTS.md etc. live at the
 * project root by convention; if a user wants to register nested skills
 * they should put them in skills.json with explicit paths.
 */
export function autoDetectSkillFiles(cwd: string): AutoDetectResult {
  const paths: string[] = [];
  const names: string[] = [];
  for (const name of AUTO_DETECT_FILES) {
    const full = path.join(cwd, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) {
        paths.push(full);
        names.push(name);
      }
    } catch {
      // file doesn't exist — skip silently
    }
  }
  return { paths, names };
}

// ─── Skill resolution ──────────────────────────────────────────────────

/**
 * Resolve a list of skill names/paths into a deduplicated list of paths.
 *
 * Resolution order (first match wins per item):
 *   1. If the item looks like a filesystem path (contains `/` or `\`, or
 *      starts with `~` or a drive letter), use it as-is.
 *   2. Else look it up in `profileRegistry`.
 *   3. Else look it up in the global registry.
 *   4. Else: skip with a console warning (do not throw — be lenient).
 *
 * Always returns a stable order:
 *   - user-supplied list first (in the order the user provided)
 *   - then auto-load skills from the profile registry
 *   - then auto-load skills from the global registry
 *   - then auto-detected files
 *
 * Duplicate paths are removed (first occurrence wins).
 */
export interface ResolveSkillsOpts {
  /** What the user/caller supplied (names or paths, mixed). */
  requested?: string[];
  /** Profile's local skill registry (takes precedence over global). */
  profileRegistry?: Record<string, SkillEntry>;
  /** Auto-detect config: false to disable, true to use cwd. */
  autoDetect?: boolean;
  /** When autoDetect is true, the cwd to scan. */
  cwd?: string;
}

export interface ResolvedSkills {
  /** Final deduped list of absolute paths to add. */
  paths: string[];
  /** For diagnostics: which names could not be resolved. */
  unresolved: string[];
}

export function resolveSkills(opts: ResolveSkillsOpts): ResolvedSkills {
  const seen = new Set<string>();
  const paths: string[] = [];
  const unresolved: string[] = [];

  const push = (p: string) => {
    // Normalize so dedupe works on Windows backslashes vs POSIX slashes.
    const norm = path.resolve(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      paths.push(norm);
    }
  };

  const looksLikePath = (s: string) =>
    s.includes("/") || s.includes("\\") || s.startsWith("~") || /^[A-Za-z]:/.test(s);

  const profileReg = opts.profileRegistry ?? {};
  const globalReg = loadGlobalSkillRegistry();

  // 1. User-supplied items.
  for (const item of opts.requested ?? []) {
    if (looksLikePath(item)) {
      push(item);
    } else if (profileReg[item]) {
      push(profileReg[item].path);
    } else if (globalReg[item]) {
      push(globalReg[item].path);
    } else {
      unresolved.push(item);
    }
  }

  // 2. Auto-load skills from the profile registry.
  for (const [name, entry] of Object.entries(profileReg)) {
    if (entry.autoLoad) push(entry.path);
  }

  // 3. Auto-load skills from the global registry.
  for (const [name, entry] of Object.entries(globalReg)) {
    if (entry.autoLoad) push(entry.path);
  }

  // 4. Auto-detect from cwd.
  if (opts.autoDetect !== false && opts.cwd) {
    const ad = autoDetectSkillFiles(opts.cwd);
    for (const p of ad.paths) push(p);
  }

  return { paths, unresolved };
}
