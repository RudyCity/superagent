import fs from "fs";
import path from "path";
import os from "os";
import { filterSuggestions, getActiveCommandContext } from "./text.js";
import { getCachedModelIds, getInstalledSkills, getModelPresets, listHistorySessions, getTrustedDirectories } from "../core/config.js";
import { registry } from "../core/commands/registry.js";
import { backgroundTasks } from "../core/tools.js";
import {
  MUSE_TUNNEL_SUGGESTIONS,
  TELEGRAM_SUGGESTIONS,
  MCP_TUNNEL_SUGGESTIONS,
  MCP_USE_SUGGESTIONS,
  STUDIO_SUGGESTIONS,
  SERVER_TUNNEL_SUGGESTIONS,
  BRAIN_SUGGESTIONS,
  BRAIN_SUGGESTION_DESCRIPTIONS,
} from "../core/commands/commandCatalog.js";

const DASHBOARD_DISABLED_COMMANDS = new Set(["/goal"]);

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  "/internal-hooks": "Manage custom internal hook tools — init, dev, or select active hooks",
  "/ih": "Manage custom internal hook tools — init, dev, or select active hooks",
  "/model": "Switch active LLM model or configure per-tier models",
  "/mode": "View or switch active operational mode (/mode implement, /mode ask, /mode debug)",
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
  "/session": "Manage and inspect conversation sessions (/session inspect <id>)",
  "/peer": "Inspect another terminal session's progress and tasks (/peer <sessionId>)",
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
  "/status": "Show aggregated health for Telegram, MCP servers, and all SuperAgent tunnels",
  "/status all": "Summarize Telegram, MCP, REST/SSE, and Muse tunnel state without changing anything",
  "/stop": "Stop/interrupt currently running tool, process, task, or agent",
  "/stop all": "Disconnect managed MCP clients and stop owned Telegram fallback, MCP, REST/SSE, and Muse services/tunnels",
  "/cancel": "Stop/interrupt currently running tool, process, task, or agent",
  "/abort": "Stop/interrupt currently running tool, process, task, or agent",
  "/steer": "Interrupt and steer/redirect the agent with feedback or counter-instructions",
  "/sanggah": "Interrupt and steer/redirect the agent with feedback or counter-instructions",
  "/security": "Inspect sandbox status and manage access blocklists",
  "/security sandbox status": "Report effective OS isolation status",
  "/security sandbox doctor": "Diagnose OS isolation prerequisites",
  "/security sandbox enable": "Validate sandbox provisioning (refuses unsafe in-process enable)",
  "/security sandbox disable": "Validate sandbox shutdown (no OS ACL changes)",
  "/security block add": "Add a persistent application-level path/drive block",
  "/security block remove": "Remove an application path/drive block",
  "/security block list": "List blocked folders and drives",
  "/security block check": "Check if path matches the blocklist",
  "/security block clear": "Clear all application path blocks",
  "/yolo": "Toggle YOLO mode (scoped: project & 1 parent level; full: unrestricted system-wide)",
  "/yolo on": "Enable scoped YOLO mode (auto-approve within project & 1 parent level)",
  "/yolo full": "Enable full YOLO mode (unrestricted auto-approval system-wide)",
  "/yolo block add": "Block a path or drive even in Full YOLO",
  "/yolo block remove": "Remove a path or drive block",
  "/yolo block list": "List blocked paths and drives",
  "/yolo block check": "Check access for a path",
  "/yolo block clear": "Clear YOLO blocklist",
  "/yolo off": "Disable YOLO mode and restore standard confirmation prompts",
  "/yolo status": "Check current YOLO mode status (scoped, full, or inactive)",
  "/mcp": "Manage MCP servers and MCP tunnel providers.",
  "/mcp list": "List configured MCP servers.",
  "/mcp add": "Register an external MCP server.",
  "/mcp remove": "Remove a configured MCP server.",
  "/mcp reload": "Reload MCP server configurations.",
  "/mcp use": "Display or select MCP tool exposure mode for newly started servers.",
  "/mcp use gateway": "Use compact MCP gateway with search, describe, execute, and status.",
  "/mcp use full": "Use the complete authorized MCP tools catalog (compatibility option).",
  "/mcp use status": "Show active and saved MCP tool exposure settings.",
  "/mcp tunnel": "Manage provider-specific MCP tunnel lifecycle.",
  "/mcp tunnel providers": "List supported MCP tunnel providers and their requirements.",
  "/mcp tunnel list": "List active MCP server tunnels and endpoints.",
  "/mcp tunnel start": "Start an MCP server using the selected provider.",
  "/mcp tunnel start --provider openai": "Start OpenAI Secure MCP Tunnel using tunnel-client.",
  "/mcp tunnel start --provider cloudflare": "Start MCP server through Cloudflare Quick Tunnel.",
  "/mcp tunnel start --tunnel-id": "Set the OpenAI Secure MCP Tunnel ID.",
  "/mcp tunnel start --mcp-auth oauth": "Enable OAuth 2.1 and PKCE authentication.",
  "/mcp tunnel start --mcp-auth static-bearer": "Use static Bearer authentication.",
  "/mcp tunnel start --allow-dangerous": "Opt in to potentially destructive MCP tools.",
  "/mcp tunnel restart": "Restart an MCP tunnel while preserving its provider when possible.",
  "/mcp tunnel stop": "Stop an MCP tunnel.",
  "/mcp tunnel status": "Show MCP tunnel status.",
  "/mcp tunnel doctor": "Diagnose one MCP tunnel provider; use --provider openai or --provider cloudflare.",
  "/muse": "Coordinate Muse tasks, watch sessions, and Muse WebSocket connectivity.",
  "/muse status": "Show Muse task, watcher, and Muse WebSocket status only.",
  "/muse steer": "Steer an active Muse task.",
  "/muse chat": "Deprecated alias. Use /telegram send for Telegram or /muse steer for Muse.",
  "/muse tunnel": "Manage only Muse WebSocket tunnels.",
  "/muse tunnel list": "List Muse WebSocket tunnels only.",
  "/muse tunnel start": "Start the Muse WebSocket watcher and Cloudflare tunnel.",
  "/muse tunnel start --port": "Start Muse WebSocket on a custom port.",
  "/muse tunnel stop": "Stop Muse WebSocket tunnels only.",
  "/muse tunnel stop all": "Stop all Muse WebSocket tunnels without stopping MCP or Telegram.",
  "/muse tunnel restart": "Restart Muse WebSocket tunnel and watcher.",
  "/muse tunnel prompt": "View or copy the Muse connection prompt.",
  "/muse tunnel url": "Display the active Muse WebSocket URL.",
  "/muse tunnel status": "Check Muse WebSocket tunnel status only.",
  "/muse tunnel doctor": "Diagnose Muse WebSocket and Cloudflare prerequisites.",
  "/muse tunnel guide": "Show Muse-only WebSocket setup guidance.",
  "/muse tunnel --https": "Deprecated. Use /server tunnel.",
  "/muse tunnel start --https": "Deprecated. Use /server tunnel start.",
  "/muse tunnel stop --https": "Deprecated. Use /server tunnel stop.",
  "/muse tunnel status --https": "Deprecated. Use /server tunnel status.",
  "/muse tunnel --mcp": "Deprecated. Use /mcp tunnel.",
  "/muse tunnel start --mcp": "Deprecated. Use /mcp tunnel start.",
  "/muse tunnel start --mcp --provider openai": "Deprecated. Use /mcp tunnel start --provider openai --tunnel-id <id>.",
  "/muse tunnel start --mcp --provider cloudflare": "Deprecated. Use /mcp tunnel start --provider cloudflare.",
  "/muse tunnel stop --mcp": "Deprecated. Use /mcp tunnel stop.",
  "/muse tunnel status --mcp": "Deprecated. Use /mcp tunnel status.",
  "/muse tunnel prompt --mcp": "Deprecated. Use /mcp tunnel list.",
  "/muse cloudflare": "Deprecated Muse-only setup alias. Use /muse tunnel.",
  "/muse doctor": "Diagnose Muse transport and watch readiness. Use /telegram doctor for Telegram API health.",
  "/muse connect": "Test the configured Muse transport.",
  "/muse start": "Start the Muse watch daemon.",
  "/muse restart": "Restart the Muse watcher.",
  "/muse watch": "Start Muse watch mode for one or more workspaces.",
  "/muse watch start": "Start the Muse watcher.",
  "/muse watch stop": "Stop only the Muse watcher.",
  "/muse watch status": "Show only Muse watcher status.",
  "/muse host status": "Inspect verified independent Muse and Telegram channel owners.",
  "/muse host help": "Show explicit commands to safely control an independent channel host.",
  "/muse host steer": "Send an operator instruction to a verified independent host over authenticated IPC.",
  "/muse host task": "Dispatch a Muse task through an independently owned channel.",
  "/muse host abort": "Request cancellation of an active Muse batch via independent channel IPC.",
  "/muse host replay-result": "Explicitly resend a previously encrypted result; never repeat tool execution.",
  "/muse watch add": "Add a workspace to Muse watch.",
  "/muse watch remove": "Remove a workspace from Muse watch.",
  "/muse watch --ws": "Use Muse WebSocket transport.",
  "/muse watch --tunnel": "Start Muse watch with the Muse WebSocket tunnel.",
  "/muse watch --telegram": "Use Telegram as the Muse transport adapter.",
  "/muse watch --https": "Deprecated. Use /server tunnel.",
  "/muse watch --tunnel --https": "Deprecated. Use /server tunnel.",
  "/muse watch --ws --tg-fallback": "Deprecated. Use /telegram fallback start|stop.",
  "/muse watch --tunnel --tg-fallback": "Deprecated. Use /telegram fallback start|stop.",
  "/muse unwatch": "Stop only the Muse watcher.",
  "/muse stop": "Cancel active Muse work.",
  "/muse cancel": "Cancel active Muse work.",
  "/muse new": "Start a fresh Muse session.",
  "/muse reset": "Reset remote Muse session context.",
  "/muse config": "Configure Muse transport, WebSocket, workspaces, and runner mode.",
  "/muse config transport": "Select the Muse transport adapter.",
  "/muse config transport websocket": "Select Muse WebSocket transport.",
  "/muse config transport telegram": "Select the Telegram Muse transport adapter.",
  "/muse config wsToken": "Configure Muse WebSocket authentication.",
  "/muse config wsToken generate": "Generate a WebSocket bearer token.",
  "/muse config as_runner_model": "Configure whether normal prompts are automatically routed through Muse.",
  "/muse config as_runner_model on": "Enable Muse as the default prompt runner.",
  "/muse config as_runner_model off": "Disable Muse as the default prompt runner.",
  "/muse config wsPort": "Configure the Muse WebSocket port.",
  "/muse config wsHost": "Configure the Muse WebSocket host.",
  "/muse config wsPath": "Configure the Muse WebSocket path.",
  "/muse config wsMode": "Select Muse WebSocket server or client mode.",
  "/muse config cfAccessClientId": "Configure Cloudflare Access Client ID.",
  "/muse config cfAccessClientSecret": "Configure Cloudflare Access Client Secret.",
  "/muse config workspaces": "Configure watched workspaces.",
  "/muse config defaultWorkspace": "Set the default Muse workspace.",
  "/muse config systemPrompt": "Set custom Muse instructions.",
  "/muse config botToken": "Deprecated alias. Use /telegram config botToken.",
  "/muse config groupId": "Deprecated alias. Use /telegram config groupId.",
  "/muse config museBotId": "Deprecated alias. Use /telegram config museBotId.",
  "/telegram": "Manage direct Telegram bot and group operations separately from Muse steering.",
  "/telegram help": "Show Telegram commands for status, doctor, send, config, and fallback.",
  "/telegram status": "Show Telegram configuration and Bot API status.",
  "/telegram doctor": "Diagnose Telegram configuration, API access, and fallback watcher.",
  "/telegram send": "Send only to the configured Telegram group; does not steer Muse.",
  "/telegram config": "View or update Telegram bot and group settings.",
  "/telegram fallback": "Start, stop, or inspect the Telegram fallback watcher.",
  "/server": "Manage Superagent REST/SSE server exposure.",
  "/server tunnel": "Manage only the REST/SSE tunnel, separate from Muse and MCP.",
  "/server tunnel doctor": "Check cloudflared availability and REST/SSE tunnel status.",
  "/tunnel": "Deprecated Muse-only alias for compatibility. Use /mcp tunnel for MCP and /server tunnel for REST/SSE.",
  "/tunnel list": "Deprecated Muse-only tunnel list alias.",
  "/tunnel start": "Deprecated Muse-only alias. Use /muse tunnel start.",
  "/tunnel start --port": "Deprecated Muse-only alias. Use /muse tunnel start --port.",
  "/tunnel start --https": "Deprecated. Use /server tunnel start.",
  "/tunnel start --mcp": "Deprecated. Use /mcp tunnel start.",
  "/tunnel start --mcp --provider openai": "Deprecated. Use /mcp tunnel start --provider openai --tunnel-id <id>.",
  "/tunnel start --mcp --provider cloudflare": "Deprecated. Use /mcp tunnel start --provider cloudflare.",
  "/tunnel stop": "Deprecated Muse-only alias. Use /muse tunnel stop.",
  "/tunnel stop all": "Deprecated Muse-only alias. Stops Muse WebSocket tunnels only, not MCP or REST/SSE.",
  "/tunnel stop --port": "Deprecated Muse-only alias. Use /muse tunnel stop --port.",
  "/tunnel stop --https": "Deprecated. Use /server tunnel stop.",
  "/tunnel stop --mcp": "Deprecated. Use /mcp tunnel stop.",
  "/tunnel status": "Deprecated Muse-only alias. Use /muse tunnel status.",
  "/tunnel status --port": "Deprecated Muse-only alias. Use /muse tunnel status --port.",
  "/tunnel status --https": "Deprecated. Use /server tunnel status.",
  "/tunnel status --mcp": "Deprecated. Use /mcp tunnel status.",
  "/tunnel doctor": "Deprecated Muse-only alias. Use /muse tunnel doctor.",
  "/tunnel guide": "Deprecated Muse-only alias. Use /muse tunnel guide.",
  "/tunnels": "Deprecated alias for /muse tunnel list.",
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

function getTunnelSubSuggestions(prefix: string, query: string): string[] {
  const baseSuggestions = MUSE_TUNNEL_SUGGESTIONS.map((suggestion) =>
    suggestion.replace(/^\/muse tunnel/, prefix)
  );

  if (query.startsWith(`${prefix} doctor`)) {
    return filterSuggestions([`${prefix} doctor`], query);
  }

  // Muse tunnels are not MCP or REST/SSE tunnels. Port selection is the only
  // tunnel-specific option exposed in this command context.
  if (query.startsWith(`${prefix} --`)) {
    return filterSuggestions([
      `${prefix} start --port`,
      `${prefix} status --port`,
      `${prefix} stop --port`,
      `${prefix} restart --port`,
    ], query);
  }

  if (query.startsWith(`${prefix} stop`)) {
    return filterSuggestions([`${prefix} stop`, `${prefix} stop all`, `${prefix} stop --port`], query);
  }

  if (query.startsWith(`${prefix} start`)) {
    return filterSuggestions([`${prefix} start`, `${prefix} start --port`, `${prefix} start --port 9226`], query);
  }

  if (query.startsWith(`${prefix} restart`)) {
    return filterSuggestions([`${prefix} restart`, `${prefix} restart --port`], query);
  }

  if (query.startsWith(`${prefix} prompt`)) {
    return filterSuggestions([`${prefix} prompt`, `${prefix} prompt --port`], query);
  }

  if (query.startsWith(`${prefix} url`)) {
    return filterSuggestions([`${prefix} url`, `${prefix} url --port`], query);
  }

  if (query.startsWith(`${prefix} status`)) {
    return filterSuggestions([`${prefix} status`, `${prefix} status --port`], query);
  }

  return filterSuggestions(baseSuggestions, query);
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

    if (mainCommand === "/brain" || mainCommand === "/scratch") {
      const candidates = BRAIN_SUGGESTIONS.map(cmd =>
        mainCommand === "/scratch" ? cmd.replace(/^\/brain/, "/scratch") : cmd);
      return filterSuggestions(candidates, query);
    }

    if (mainCommand === "/studio") {
      return filterSuggestions([...STUDIO_SUGGESTIONS], query);
    }

    if (mainCommand === "/status") {
      return filterSuggestions(["/status all"], query);
    }

    if (mainCommand === "/stop") {
      return filterSuggestions(["/stop", "/stop all"], query);
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

    if (mainCommand === "/mode") {
      const modeOptions = [
        "/mode implement",
        "/mode ask",
        "/mode debug",
        "/mode plan",
        "/mode research",
        "/mode review",
      ];
      return filterSuggestions(modeOptions, query);
    }

    if (mainCommand === "/mcp") {
      const sub = parts[1]?.toLowerCase();
      // Keep tool-catalog mode suggestions within /mcp use rather than mixing
      // unrelated tunnel commands. Handles /mcp use, /mcp use <partial>,
      // and trailing spaces for T-Line Tab cycling.
      if (sub === "use") {
        return filterSuggestions([...MCP_USE_SUGGESTIONS], query);
      }
      if (sub === "tunnel") {
        const action = parts[2]?.toLowerCase();
        if (action === "start") {
          const startSuggestions = [
            ...MCP_TUNNEL_SUGGESTIONS.filter((suggestion) => suggestion.startsWith("/mcp tunnel start")),
            "/mcp tunnel start --mcp-auth oauth",
            "/mcp tunnel start --mcp-auth static-bearer",
            "/mcp tunnel start --allow-dangerous",
            "/mcp tunnel start --mcp-port 9227",
          ];
          return filterSuggestions(startSuggestions, query);
        }
        if (action === "stop") {
          const stopSuggestions = [
            "/mcp tunnel stop",
            "/mcp tunnel stop --mcp-port 9227",
          ];
          try {
            const dir = path.join(os.homedir(), ".superagent-r");
            if (fs.existsSync(dir)) {
              for (const f of fs.readdirSync(dir)) {
                const mcpMatch = f.match(/^mcp-(\d+)\.json$/);
                if (mcpMatch) stopSuggestions.push(`/mcp tunnel stop --mcp-port ${mcpMatch[1]}`);
                const openaiMatch = f.match(/^openai-tunnel-(\d+)\.json$/);
                if (openaiMatch) stopSuggestions.push(`/mcp tunnel stop --mcp-port ${openaiMatch[1]}`);
              }
            }
          } catch {}
          return filterSuggestions(stopSuggestions, query);
        }
        if (action === "providers") {
          return filterSuggestions(["/mcp tunnel providers"], query);
        }
        if (action === "restart") {
          return filterSuggestions(["/mcp tunnel restart", "/mcp tunnel restart --provider openai", "/mcp tunnel restart --provider cloudflare"], query);
        }
        if (action === "doctor") {
          return filterSuggestions(["/mcp tunnel doctor --provider openai", "/mcp tunnel doctor --provider cloudflare"], query);
        }
        if (action === "list") {
          return filterSuggestions(["/mcp tunnel list"], query);
        }
        if (action === "status") {
          return filterSuggestions(["/mcp tunnel status", "/mcp tunnel status --mcp-port 9227"], query);
        }
        return filterSuggestions(MCP_TUNNEL_SUGGESTIONS, query);
      }
      const possibilities = [
        "/mcp list",
        "/mcp add",
        "/mcp add-http",
        "/mcp remove",
        "/mcp reload",
        "/mcp use",
        ...MCP_USE_SUGGESTIONS,
        "/mcp tunnel",
        ...MCP_TUNNEL_SUGGESTIONS,
      ];
      return filterSuggestions(possibilities, query);
    }
    
    if (mainCommand === "/login") {
      if (parts.length >= 2 && parts[1].toLowerCase() === "add") {
        const providers = ["openrouter", "openai", "anthropic", "gemini", "kilo", "custom"];
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
        `${parts[0]} audit`,
        `${parts[0]} standard`,
        `${parts[0]} metrics`,
        `${parts[0]} reset`,
        `${parts[0]} warn=5`,
        `${parts[0]} pause=8`,
        `${parts[0]} error=5`,
        `${parts[0]} adaptive=on`,
        `${parts[0]} pattern=on`,
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

    if (mainCommand === "/telegram") {
      return filterSuggestions(TELEGRAM_SUGGESTIONS, query);
    }

    if (mainCommand === "/server") {
      const sub = parts[1]?.toLowerCase();
      if (sub === "tunnel") {
        return filterSuggestions(SERVER_TUNNEL_SUGGESTIONS, query);
      }
      return filterSuggestions(["/server help", "/server tunnel", ...SERVER_TUNNEL_SUGGESTIONS], query);
    }

    if (mainCommand === "/muse") {
      const sub = parts[1]?.toLowerCase();
      if (sub === "config") {
        const configKey = parts[2]?.toLowerCase();
        if (configKey === "as_runner_model" || configKey === "as_runner") {
          const togglePossibilities = [
            `/muse config ${parts[2]} on`,
            `/muse config ${parts[2]} off`,
          ];
          return filterSuggestions(togglePossibilities, query);
        }
        if (configKey === "transport") {
          const transportPossibilities = [
            "/muse config transport websocket",
            "/muse config transport telegram",
          ];
          return filterSuggestions(transportPossibilities, query);
        }
        if (configKey === "wstoken" || configKey === "token" || configKey === "ws_token") {
          const tokenPossibilities = [
            `/muse config ${parts[2]} generate`,
            `/muse config ${parts[2]} refresh`,
            `/muse config ${parts[2]} rotate`,
          ];
          return filterSuggestions(tokenPossibilities, query);
        }
        if (configKey === "autotokenrefresh" || configKey === "auto_token_refresh") {
          const togglePossibilities = [
            `/muse config ${parts[2]} on`,
            `/muse config ${parts[2]} off`,
          ];
          return filterSuggestions(togglePossibilities, query);
        }
        if (configKey === "wsmode" || configKey === "ws_mode") {
          const modePossibilities = [
            `/muse config ${parts[2]} server`,
            `/muse config ${parts[2]} client`,
          ];
          return filterSuggestions(modePossibilities, query);
        }
        if (configKey === "workspaces" || configKey === "workspace" || configKey === "projects") {
          const wsPossibilities = [
            `/muse config ${parts[2]} list`,
            `/muse config ${parts[2]} add`,
            `/muse config ${parts[2]} remove`,
          ];
          return filterSuggestions(wsPossibilities, query);
        }
        const configPossibilities = [
          "/muse config transport",
          "/muse config transport websocket",
          "/muse config transport telegram",
          "/muse config wsToken",
          "/muse config wsToken generate",
          "/muse config wsToken refresh",
          "/muse config wsToken rotate",
          "/muse config tokenTtl",
          "/muse config autoTokenRefresh",
          "/muse config autoTokenRefresh on",
          "/muse config autoTokenRefresh off",
          "/muse config wsPort",
          "/muse config wsHost",
          "/muse config wsPath",
          "/muse config wsMode",
          "/muse config wsMode server",
          "/muse config wsMode client",
          "/muse config wsRemoteUrl",
          "/muse config cfAccessClientId",
          "/muse config cfAccessClientSecret",
          "/muse config workspaces",
          "/muse config workspaces list",
          "/muse config workspaces add",
          "/muse config workspaces remove",
          "/muse config as_runner_model",
          "/muse config as_runner_model on",
          "/muse config as_runner_model off",
          "/muse config as_runner",
          "/muse config as_runner on",
          "/muse config as_runner off",
          "/muse config defaultWorkspace",
          "/muse config systemPrompt",
          "/telegram config",
        ];
        return filterSuggestions(configPossibilities, query);
      }

      if (sub === "tunnel" || sub === "cloudflare") {
        return getTunnelSubSuggestions(sub === "cloudflare" ? "/muse cloudflare" : "/muse tunnel", query);
      }

      if (sub === "host") {
        return filterSuggestions([
          "/muse host status", "/muse host help", "/muse host steer",
          "/muse host task", "/muse host abort", "/muse host replay-result",
        ], query);
      }
      if (sub === "watch") {
        const watchPossibilities = [
          "/muse watch start",
          "/muse watch stop",
          "/muse watch status",
          "/muse watch --tunnel",
          "/muse watch --ws",
          "/muse watch --telegram",
          "/muse watch add",
          "/muse watch remove",
          "/telegram fallback status",
        ];
        return filterSuggestions(watchPossibilities, query);
      }

      const possibilities = [
        "/muse status",
        "/muse tunnel",
        ...MUSE_TUNNEL_SUGGESTIONS,
        "/muse cloudflare",
        "/muse doctor",
        "/muse connect",
        "/muse start",
        "/muse restart",
        "/muse watch",
        "/muse watch start",
        "/muse watch stop",
        "/muse watch status",
        "/muse host status",
        "/muse host help",
        "/muse host steer",
        "/muse host task",
        "/muse host abort",
        "/muse host replay-result",
        "/muse watch add",
        "/muse watch remove",
        "/muse watch --ws",
        "/muse watch --tunnel",
        "/muse watch --telegram",
        "/muse unwatch",
        "/muse stop",
        "/muse cancel",
        "/muse steer",
        "/muse chat",
        "/muse new",
        "/muse reset",
        "/muse config",
        "/muse config transport",
        "/muse config transport websocket",
        "/muse config transport telegram",
        "/muse config wsToken",
        "/muse config wsToken generate",
        "/muse config wsPort",
        "/muse config wsHost",
        "/muse config wsPath",
        "/muse config wsMode",
        "/muse config cfAccessClientId",
        "/muse config cfAccessClientSecret",
        "/muse config workspaces",
        "/muse config workspaces list",
        "/muse config workspaces add",
        "/muse config workspaces remove",
        "/muse config as_runner_model",
        "/muse config as_runner_model on",
        "/muse config as_runner_model off",
        "/muse config as_runner",
        "/muse config as_runner on",
        "/muse config as_runner off",
        "/muse config defaultWorkspace",
        "/muse config systemPrompt",
        "/telegram help",
        "/telegram status",
        "/telegram send",
        "/telegram config",
        "/mcp tunnel providers",
        "/server tunnel",
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/tunnel") {
      return filterSuggestions([
        "/tunnel list",
        "/tunnel start",
        "/tunnel start --port",
        "/tunnel stop",
        "/tunnel stop all",
        "/tunnel stop --port",
        "/tunnel status",
        "/tunnel status --port",
        "/tunnel doctor",
        "/tunnel guide",
      ], query);
    }

    if (mainCommand === "/tunnels") {
      return filterSuggestions(["/tunnels", "/tunnel list"], query);
    }

    if (mainCommand === "/security") {
      return filterSuggestions(["/security", "/security sandbox status", "/security sandbox doctor", "/security sandbox enable", "/security sandbox disable", "/security block add", "/security block remove", "/security block list", "/security block check", "/security block clear"], query);
    }

    if (mainCommand === "/yolo" || mainCommand === "/yolomode") {
      const prefix = mainCommand;
      return filterSuggestions([prefix, `${prefix} on`, `${prefix} full`, `${prefix} off`, `${prefix} status`, `${prefix} block add`, `${prefix} block remove`, `${prefix} block list`, `${prefix} block check`, `${prefix} block clear`], query);
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
  for (const [suggestion, description] of Object.entries(BRAIN_SUGGESTION_DESCRIPTIONS)) {
    desc[suggestion] = description;
    desc[suggestion.replace(/^\/brain/, "/scratch")] = description;
  }
  for (const suggestion of BRAIN_SUGGESTIONS) {
    if (!desc[suggestion]) {
      desc[suggestion] = "Session Brain — " + suggestion.slice("/brain ".length);
      desc[suggestion.replace(/^\/brain/, "/scratch")] = desc[suggestion];
    }
  }
  for (const suggestion of STUDIO_SUGGESTIONS) {
    desc[suggestion] = "SuperAgent Studio — " + suggestion.replace("/studio ", "");
  }
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
