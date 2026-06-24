import { filterSuggestions } from "./text.js";
import { getCachedModelIds, getInstalledSkills, listHistorySessions } from "../core/config.js";
import { registry } from "../core/commands/registry.js";
import { backgroundTasks } from "../core/tools.js";

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  "/model": "Switch active LLM model or configure per-tier models",
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
  "/search-history": "Search through previous session histories",
  "/compact": "Summarize conversation to free up context window",
  "/init": "Run project system audit and setup",
  "/terminal": "Spawn a visible terminal window or run presets",
  "/help": "Show available commands and usage",
  "/goal": "Activate Goal Mode for long-running overnight tasks",
  "/settings": "Show current rate limit & concurrency settings",
  "/setting-concurrency": "Set LLM concurrency limit (0 or 1)",
  "/setting-rpm": "Set rate limit RPM",
  "/setting-capacity": "Set rate limit capacity",
  "/setting-streaming": "Enable or disable streaming (on or off)",
  "/setting-context-limit": "Set custom context window limit (0 = auto)",
  "/setting-max-iterations": "Set max agent loop iterations",
  "/setting-tencentdb": "Configure TencentDB memory strategy and gateway URL",
};

export function getDashboardSuggestions(query: string): string[] {
  if (!query.startsWith("/")) return [];
  const skillCommands = getInstalledSkills().map(s => {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return `/skill-${slug}`;
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
  ];
  const parts = query.split(/\s+/);
  const mainCommand = parts[0].toLowerCase();
  
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
      const providers = ["openrouter", "openai", "anthropic", "custom"];
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
  
  if (mainCommand === "/resume") {
    const sessionsList = listHistorySessions(true);
    const possibilities = sessionsList.map((s, idx) => `/resume ${idx + 1}`);
    return filterSuggestions(possibilities, query);
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

  if (mainCommand === "/worktree" || mainCommand === "/worktrees") {
    const possibilities = [
      `${parts[0]} list`,
      `${parts[0]} prune`,
      `${parts[0]} remove`
    ];
    return filterSuggestions(possibilities, query);
  }

  if (mainCommand === "/setting-tencentdb") {
    const possibilities = [
      "/setting-tencentdb on",
      "/setting-tencentdb off",
      "/setting-tencentdb status",
      "/setting-tencentdb show-bg-procs",
      "/setting-tencentdb hide-bg-procs",
    ];
    return filterSuggestions(possibilities, query);
  }

  return [];
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
    desc[`/skill-${slug}`] = s.description;
  }
  return desc;
}
