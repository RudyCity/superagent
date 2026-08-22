import fs from "fs";
import path from "path";
import { filterSuggestions, getActiveCommandContext } from "./text.js";
import { getCachedModelIds, getInstalledSkills, getModelPresets, listHistorySessions, getTrustedDirectories } from "../core/config.js";
import { registry } from "../core/commands/registry.js";
import { backgroundTasks } from "../core/tools.js";

const DASHBOARD_DISABLED_COMMANDS = new Set(["/goal"]);

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  "/internal-hooks": "Manage custom internal hook tools — init, dev, or select active hooks",
  "/ih": "Manage custom internal hook tools — init, dev, or select active hooks",
  "/model": "Switch active LLM model or configure per-tier models",
  "/mp": "Quick-switch model preset (e.g. /mp fast, /mp default). Shortcut: /mp-<name>",
  "/login": "Add API credentials or switch active provider",
  "/resume": "Resume a previous session from history",
  "/clear": "Clear the visual log screen",
  "/new": "Start a fresh conversation session",
  "/exit": "Exit the application",
  "/quit": "Exit the application",
  "/checkpoint": "Save or restore a session state snapshot",
  "/install": "Install skills from a remote GitHub repository",
  "/skills": "Browse all installed automation skills",
  "/skill": "Browse all installed automation skills",
  "/procs": "Display active background processes",
  "/processes": "Display active background processes",
  "/agents": "List active subagents and configured types",
  "/worktree": "Manage git worktrees",
  "/worktrees": "Manage git worktrees",
  "/workspace": "Manage local & SSH remote project workspaces",
  "/w": "Manage local & SSH remote project workspaces",
  "/search-history": "Search through previous session histories",
  "/history": "Manage SQLite history database — export, backup, or migrate sessions",
  "/compact": "Summarize conversation to free up context window",
  "/init": "Run project system audit and setup",
  "/terminal": "Spawn a visible terminal window or run presets",
  "/help": "Show available commands and usage",
  "/settings": "Show current rate limit & concurrency settings",
  "/setting-concurrency": "Set LLM concurrency limit (0 or 1)",
  "/setting-rpm": "Set rate limit RPM",
  "/setting-capacity": "Set rate limit capacity",
  "/setting-streaming": "Enable or disable streaming (on or off)",
  "/setting-context-limit": "Set custom context window limit (0 = auto)",
  "/setting-max-iterations": "Set max agent loop iterations",
  "/setting-checklist-limit": "Set checklist visible limit",
  "/setting-history-limit": "Set checklist history visible limit",
  "/setting-procs-limit": "Set processes visible limit",
  "/setting-hide-timeline": "Hide or show the timeline lines connecting turns (on or off)",
  "/setting-classifier": "Enable or disable multi-category request classifier (on or off)",
  "/setting-classifier-threshold": "Set classifier heuristic confidence threshold (high, medium, low)",
  "/setting-advisor": "Enable or disable the Real-Time Execution Advisor (on or off)",
};

const RESUME_SCAN_LIMIT = 100;
const RESUME_SUGGESTIONS_TTL_MS = 5000;
const RESUME_REFRESH_DEBOUNCE_MS = 150;

let resumeSuggestionsCache: { isMulti: boolean; possibilities: string[]; fetchedAt: number } | null = null;
let resumeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function computeResumePossibilities(isMulti: boolean): string[] {
  const sessionsList = listHistorySessions(isMulti, false, undefined, 20, undefined, undefined, RESUME_SCAN_LIMIT).slice(0, 10);
  return sessionsList.map((s, idx) => `/resume ${idx + 1}`);
}

function scheduleResumeRefresh(isMulti: boolean): void {
  if (resumeRefreshTimer) clearTimeout(resumeRefreshTimer);
  resumeRefreshTimer = setTimeout(() => {
    resumeRefreshTimer = null;
    try {
      resumeSuggestionsCache = {
        isMulti,
        possibilities: computeResumePossibilities(isMulti),
        fetchedAt: Date.now(),
      };
    } catch {}
  }, RESUME_REFRESH_DEBOUNCE_MS);
}

/** Cached /resume suggestions: repeated keystrokes return the cached list instantly
 * and coalesce stale-data refreshes behind a trailing debounce. */
function getResumePossibilities(): string[] {
  const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
  if (!resumeSuggestionsCache || resumeSuggestionsCache.isMulti !== isMulti) {
    resumeSuggestionsCache = {
      isMulti,
      possibilities: computeResumePossibilities(isMulti),
      fetchedAt: Date.now(),
    };
    return resumeSuggestionsCache.possibilities;
  }
  if (Date.now() - resumeSuggestionsCache.fetchedAt >= RESUME_SUGGESTIONS_TTL_MS) {
    scheduleResumeRefresh(isMulti);
  }
  return resumeSuggestionsCache.possibilities;
}

export function getDashboardSuggestions(originalQuery: string, cursorPosition: number = originalQuery.length): string[] {
  const context = getActiveCommandContext(originalQuery, cursorPosition);
  if (!context) return [];

  const { commandSegment, isBang } = context;
  let query = commandSegment;
  if (isBang) {
    query = `/terminal ${commandSegment.slice(1)}`;
  }

  const getRawSuggestions = () => {
    if (!query.startsWith("/")) return [];
    const skillCommands = getInstalledSkills().map(s => {
      const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
      return `/${slug}`;
    });

    const commands = [
      ...new Set(
        registry.getAll().flatMap(cmd => {
          const names = [`/${cmd.name}`];
          if (cmd.aliases) names.push(...cmd.aliases.map(a => `/${a}`));
          return names;
        })
      ),
      ...skillCommands
    ].filter(name => !DASHBOARD_DISABLED_COMMANDS.has(name.toLowerCase()));
    const parts = query.split(/\s+/);
    const mainCommand = parts[0].toLowerCase();

    if (mainCommand === "/mp") {
      const presets = getModelPresets();
      const presetSuggestions = presets.length > 0
        ? presets.map(p => `/mp ${p.name}`)
        : ["/mp fast", "/mp default", "/mp balanced"];
      const searchTerm = query.replace(/^\/mp\s*/i, "").trim();
      return searchTerm
        ? filterSuggestions(presetSuggestions, query)
        : presetSuggestions;
    }

    if (mainCommand.startsWith("/mp-")) {
      const presets = getModelPresets();
      const presetSuggestions = presets.length > 0
        ? presets.map(p => `/mp-${p.name}`)
        : ["/mp-fast", "/mp-default", "/mp-balanced"];
      return filterSuggestions(presetSuggestions, query);
    }

    if (parts.length === 1) {
      return filterSuggestions(commands, query);
    }

    if (mainCommand === "/model") {
      if (parts.length >= 2 && parts[1].toLowerCase() === "preset") {
        const presetSuggestions = [
          "/model preset list",
          "/model preset save",
        ];
        const searchTerm = query.replace(/^\/model\s+preset\s*/i, "").trim();
        return searchTerm
          ? filterSuggestions(presetSuggestions, query)
          : presetSuggestions;
      }
      const possibilities = [
        "/model preset",
        "/model master",
        "/model superagent",
        "/model subagent",
      ];
      const fallbackModels = [
        "google/gemini-2.5-flash",
        "google/gemini-2.5-pro",
        "anthropic/claude-3-5-sonnet",
        "openai/gpt-4o",
        "openai/gpt-4o-mini"
      ];
      const cachedIds = getCachedModelIds();
      const modelList = cachedIds.length > 0 ? cachedIds : fallbackModels;
      possibilities.push(...modelList.map(m => `/model ${m}`));
      const searchTerm = query.replace(/^\/model\s*/i, "").trim();
      return searchTerm
        ? filterSuggestions(possibilities, searchTerm)
        : possibilities.slice(0, 12);
    }
    
    if (mainCommand === "/login") {
      if (parts.length >= 2 && parts[1].toLowerCase() === "add") {
        const providers = ["openrouter", "openai", "anthropic", "gemini", "custom"];
        const possibilities = providers.map(p => `/login add ${p}`);
        return filterSuggestions(possibilities, query);
      }
      if (parts.length >= 2 && parts[1].toLowerCase() === "remove") {
        return ["/login remove <provider_id>"].filter(p => p.startsWith(query));
      }
      const possibilities = ["/login add", "/login list", "/login remove"];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/checkpoint") {
      const possibilities = ["/checkpoint list", "/checkpoint restore", "/checkpoint delete"];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/history") {
      const possibilities = ["/history stats", "/history tag", "/history export", "/history backup", "/history migrate", "/history clean"];
      return filterSuggestions(possibilities, query);
    }
    
    if (mainCommand === "/resume") {
      return filterSuggestions(getResumePossibilities(), query);
    }

    if (mainCommand === "/terminal") {
      if (query.startsWith("/terminal stop")) {
        const stopSuggestions = ["/terminal stop all"];
        for (const [id] of backgroundTasks.entries()) {
          if (id.startsWith("term-")) stopSuggestions.push(`/terminal stop ${id}`);
        }
        return stopSuggestions.filter(p => p.startsWith(query));
      }
      if (query.startsWith("/terminal bg")) {
        const bgSuggestions = ["/terminal bg preset"];
        return bgSuggestions.filter(p => p.startsWith(query));
      }
      const possibilities = [
        "/terminal init",
        "/terminal bg",
        "/terminal stop",
        "/terminal stop all",
        "/terminal all",
        "/terminal preset"
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/processes" || mainCommand === "/procs") {
      if (query.startsWith(`${mainCommand} stop`)) {
        const stopSuggestions = [`${mainCommand} stop all`];
        for (const [id] of backgroundTasks.entries()) {
          stopSuggestions.push(`${mainCommand} stop ${id}`);
        }
        return stopSuggestions.filter(p => p.startsWith(query));
      }
      const possibilities = [`${mainCommand} stop`, `${mainCommand} stop all`];
      return possibilities.filter(p => p.startsWith(query));
    }

    if (mainCommand === "/workspace" || mainCommand === "/w") {
      if (parts.length >= 2 && parts[1].toLowerCase() === "use") {
        const dirs = getTrustedDirectories();
        const possibilities = dirs.map((_dir: string, idx: number) => `${parts[0]} use ${idx + 1}`);
        return filterSuggestions(possibilities, query);
      }
      const possibilities = [
        `${parts[0]} status`,
        `${parts[0]} add`,
        `${parts[0]} add ssh://user@host:port/path?key=key.pem`,
        `${parts[0]} use`
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/worktree" || mainCommand === "/worktrees") {
      const possibilities = [
        `${parts[0]} list`,
        `${parts[0]} prune`,
        `${parts[0]} remove`
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/setting-hide-timeline") {
      const possibilities = [
        "/setting-hide-timeline on",
        "/setting-hide-timeline off",
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/setting-advisor" || mainCommand === "/advisor") {
      const possibilities = [
        `${parts[0]} on`,
        `${parts[0]} off`,
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/setting-classifier" || mainCommand === "/classifier") {
      const possibilities = [
        `${parts[0]} on`,
        `${parts[0]} off`,
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/setting-classifier-threshold" || mainCommand === "/classifier-threshold") {
      const possibilities = [
        `${parts[0]} high`,
        `${parts[0]} medium`,
        `${parts[0]} low`,
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/memory") {
      const possibilities = [
        "/memory status",
        "/memory sync",
        "/memory search",
        "/memory add",
        "/memory delete",
        "/memory list-scenes",
        "/memory read-scene",
        "/memory read-persona",
        "/memory help"
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/setting-rmemory") {
      const possibilities = [
        "/setting-rmemory on",
        "/setting-rmemory off",
        "/setting-rmemory provider",
        "/setting-rmemory provider local",
        "/setting-rmemory provider openai",
        "/setting-rmemory model",
        "/setting-rmemory dimensions"
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/internal-hooks" || mainCommand === "/ih") {
      const subSuggestions = [`${parts[0]} init`, `${parts[0]} dev`, `${parts[0]} list`, `${parts[0]} active`];
      if (parts.length === 1) {
        return subSuggestions;
      }
      const sub = parts[1]?.toLowerCase();
      if (sub === "dev" || sub === "init") {
        const hooksRoot = path.join(process.cwd(), "internal-hooks");
        let hookDirs: string[] = [];
        if (fs.existsSync(hooksRoot)) {
          try {
            hookDirs = fs.readdirSync(hooksRoot, { withFileTypes: true })
              .filter(item => item.isDirectory())
              .map(item => `${parts[0]} ${sub} ${item.name}`);
          } catch {}
        }
        if (sub === "dev") {
          hookDirs.push(
            `${parts[0]} ${sub} off`,
            `${parts[0]} ${sub} stop`,
            `${parts[0]} ${sub} clear`,
            `${parts[0]} ${sub} none`
          );
        }
        if (hookDirs.length > 0) {
          return filterSuggestions(hookDirs, query);
        }
      }
      return filterSuggestions(subSuggestions, query);
    }

    return [];
  };

  const res = getRawSuggestions();
  if (isBang) {
    return res.map(s => {
      if (s.startsWith("/terminal")) {
        const suffix = s.slice(9);
        if (suffix.startsWith(" ")) {
          return `!${suffix.trim()}`;
        }
        return `!${suffix}`;
      }
      return s;
    });
  }
  return res;
}


export function getSuggestionDescriptions(): Record<string, string> {
  const desc: Record<string, string> = { ...BUILTIN_DESCRIPTIONS };
  // Auto-populate descriptions from registry for any command without a manual entry
  for (const cmd of registry.getAll()) {
    const key = `/${cmd.name}`;
    if (!desc[key] && cmd.description) desc[key] = cmd.description;
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        const aliasKey = `/${alias}`;
        if (!desc[aliasKey] && cmd.description) desc[aliasKey] = cmd.description;
      }
    }
  }
  for (const s of getInstalledSkills()) {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    desc[`/${slug}`] = s.description;
  }
  // Add descriptions for model preset suggestions (/mp <name> and /mp-<name>)
  for (const p of getModelPresets()) {
    const modeLabel = p.mode === "single" ? "Single-Agent" : "Multi-Agent";
    const presetDesc = `Switch to model preset "${p.name}" [${modeLabel}] — ${p.description}`;
    desc[`/mp ${p.name}`] = presetDesc;
    desc[`/mp-${p.name}`] = presetDesc;
  }
  return desc;
}
