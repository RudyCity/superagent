import { filterSuggestions } from "./text.js";
import { getCachedModelIds, listHistorySessions } from "../core/config.js";

export function getDashboardSuggestions(query: string): string[] {
  if (!query.startsWith("/")) return [];
  const commands = [
    "/model", "/login", "/resume", "/clear", "/new", "/exit", 
    "/quit", "/checkpoint", "/install", "/skills", "/procs", 
    "/processes", "/agents", "/worktree", "/worktrees", "/search-history", "/compact", 
    "/init", "/terminal", "/help"
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
