import { filterSuggestions } from "./text.js";
import { getCachedModelIds, getInstalledSkills, listHistorySessions } from "../core/config.js";

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
  "/tasks": "Display active task checklist and progress",
};

export function getDashboardSuggestions(query: string): string[] {
  if (!query.startsWith("/")) return [];
  const skillCommands = getInstalledSkills().map(s => {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    return `/skill-${slug}`;
  });

  const commands = [
    "/model", "/login", "/resume", "/clear", "/new", "/exit", 
    "/quit", "/checkpoint", "/install", "/skills", "/procs", 
    "/processes", "/agents", "/worktree", "/worktrees", "/search-history", "/compact", 
    "/init", "/terminal", "/help", "/tasks",
    ...skillCommands
  ];
  const parts = query.split(/\s+/);
  const mainCommand = parts[0].toLowerCase();
  
  if (parts.length === 1) {
    return filterSuggestions(commands, query);
  }
  
  if (mainCommand === "/model") {
    const fallbackModels = [
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
      "anthropic/claude-3-5-sonnet",
      "openai/gpt-4o",
      "openai/gpt-4o-mini"
    ];
    const cachedIds = getCachedModelIds();
    const modelList = cachedIds.length > 0 ? cachedIds : fallbackModels;
    const possibilities = modelList.map(m => `/model ${m}`);
    const searchTerm = query.replace(/^\/model\s*/i, "").trim();
    return searchTerm
      ? filterSuggestions(possibilities, searchTerm)
      : possibilities.slice(0, 10);
  }
  
  if (mainCommand === "/login") {
    const providers = ["openrouter", "openai", "anthropic"];
    const possibilities = providers.map(p => `/login ${p}`);
    return filterSuggestions(possibilities, query);
  }
  
  if (mainCommand === "/resume") {
    const sessionsList = listHistorySessions(true);
    const possibilities = sessionsList.map((s, idx) => `/resume ${idx + 1}`);
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
  
  return [];
}

export function getSuggestionDescriptions(): Record<string, string> {
  const desc: Record<string, string> = { ...BUILTIN_DESCRIPTIONS };
  for (const s of getInstalledSkills()) {
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    desc[`/skill-${slug}`] = s.description;
  }
  return desc;
}
