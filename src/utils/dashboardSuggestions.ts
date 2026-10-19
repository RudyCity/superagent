import fs from "fs";
import path from "path";
import os from "os";
import { filterSuggestions, getActiveCommandContext } from "./text.js";
import { getCachedModelIds, getInstalledSkills, getModelPresets, listHistorySessions, getTrustedDirectories } from "../core/config.js";
import { registry } from "../core/commands/registry.js";
import { backgroundTasks } from "../core/tools.js";

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
  "/stop": "Stop/interrupt currently running tool, process, task, or agent",
  "/cancel": "Stop/interrupt currently running tool, process, task, or agent",
  "/abort": "Stop/interrupt currently running tool, process, task, or agent",
  "/steer": "Interrupt and steer/redirect the agent with feedback or counter-instructions",
  "/sanggah": "Interrupt and steer/redirect the agent with feedback or counter-instructions",
  "/yolo": "Toggle YOLO mode (scoped: project & 1 parent level; full: unrestricted system-wide)",
  "/yolo on": "Enable scoped YOLO mode (auto-approve within project & 1 parent level)",
  "/yolo full": "Enable full YOLO mode (unrestricted auto-approval system-wide)",
  "/yolo off": "Disable YOLO mode and restore standard confirmation prompts",
  "/yolo status": "Check current YOLO mode status (scoped, full, or inactive)",
  "/mcp": "Manage Model Context Protocol (MCP) servers and tunnels",
  "/mcp list": "List all configured MCP servers and active tunnels",
  "/mcp add": "Register a new external MCP server",
  "/mcp remove": "Remove a configured MCP server",
  "/mcp reload": "Reload all active MCP server configurations",
  "/mcp tunnel": "Manage MCP server tunnels (OpenAI Secure MCP or Cloudflare)",
  "/mcp tunnel list": "List active MCP server tunnels and endpoints",
  "/mcp tunnel start": "Start MCP server via tunnel (Cloudflare or OpenAI)",
  "/mcp tunnel start --provider openai": "Start MCP server via OpenAI Secure MCP Tunnel (tunnel-client)",
  "/mcp tunnel start --provider cloudflare": "Start MCP server via Cloudflare quick tunnel (Streamable HTTP)",
  "/mcp tunnel start --openai": "Start MCP server via OpenAI Secure MCP Tunnel (alias for --provider openai)",
  "/mcp tunnel start --tunnel-id": "Start OpenAI Secure MCP Tunnel with a specific tunnel ID",
  "/mcp tunnel start --mcp-auth oauth": "Start MCP server via tunnel with OAuth 2.1 + PKCE authentication",
  "/mcp tunnel start --mcp-auth static-bearer": "Start MCP server via tunnel with static Bearer token authentication",
  "/mcp tunnel start --allow-dangerous": "Start MCP server via tunnel with destructive tools enabled",
  "/mcp tunnel stop": "Stop active MCP server tunnel",
  "/mcp tunnel status": "Check active MCP server tunnel health and public URL",
  "/mcp tunnel doctor": "Diagnose MCP tunnel prerequisites (cloudflared, tunnel-client, credentials)",
  "/muse": "Coordinate with remote AI agent (Muse) over WebSocket (Cloudflare Tunnel) or Telegram bus",
  "/muse status": "Show remote agent configuration, runner mode, and connection status",
  "/muse steer": "Intervene and send counter-instructions to Muse brain (alias: /muse chat)",
  "/muse chat": "Send a chat or steering message directly to Muse brain",
  "/muse tunnel": "Tunnel subcommands (list, start [--https] [--mcp], stop, status, restart, doctor) & setup guide",
  "/muse tunnel --https": "Start Cloudflare HTTPS tunnel for Superagent REST & SSE server (port 7888)",
  "/muse tunnel --mcp": "Start MCP server via tunnel (Streamable HTTP, port 9227)",
  "/muse tunnel list": "List all currently active tunnels across all ports",
  "/muse tunnel start": "Start quick tunnel with copyable prompt (optional: --port <n>)",
  "/muse tunnel start --https": "Start Cloudflare HTTPS tunnel for Superagent REST & SSE server (port 7888)",
  "/muse tunnel start --port": "Start quick tunnel on a custom local port (e.g. --port 9226)",
  "/muse tunnel start --mcp": "Start MCP server via tunnel (Streamable HTTP, port 9227)",
  "/muse tunnel start --mcp --provider openai": "Start MCP server via OpenAI Secure MCP Tunnel (tunnel-client)",
  "/muse tunnel start --mcp --provider cloudflare": "Start MCP server via Cloudflare quick tunnel (Streamable HTTP)",
  "/muse tunnel start --mcp --openai": "Start MCP server via OpenAI Secure MCP Tunnel (alias for --provider openai)",
  "/muse tunnel start --mcp --tunnel-id": "Start OpenAI Secure MCP Tunnel with a specific tunnel ID",
  "/muse tunnel start --mcp --mcp-auth oauth": "Start MCP server via tunnel with OAuth 2.1 + PKCE authentication (for ChatGPT)",
  "/muse tunnel start --mcp --mcp-auth static-bearer": "Start MCP server via tunnel with static Bearer token authentication",
  "/muse tunnel start --mcp --allow-dangerous": "Start MCP server via tunnel with destructive tools enabled",
  "/muse tunnel start --mcp --mcp-port": "Start MCP server via tunnel on a custom port (default: 9227)",
  "/muse tunnel start --mcp --mcp-port 9227": "Start MCP server via tunnel on port 9227",
  "/muse tunnel start --mcp --mcp-auth oauth --allow-dangerous": "Start MCP server via tunnel with OAuth 2.1 and destructive tools",
  "/muse tunnel start --mcp --mcp-auth static-bearer --allow-dangerous": "Start MCP server via tunnel with static Bearer token and destructive tools",
  "/muse tunnel start --mcp --mcp-auth oauth --mcp-port 9227": "Start MCP server via tunnel with OAuth 2.1 on port 9227",
  "/muse tunnel stop": "Stop running quick ephemeral tunnel (optional: --port <n> or all)",
  "/muse tunnel stop --https": "Stop active Cloudflare HTTPS tunnel for Superagent REST server (port 7888)",
  "/muse tunnel stop all": "Stop all running quick tunnels across all ports",
  "/muse tunnel stop --port": "Stop running quick tunnel on a specific port",
  "/muse tunnel stop --mcp": "Stop active MCP server tunnel on port 9227",
  "/muse tunnel stop --mcp-port": "Stop active MCP server tunnel on a specific port",
  "/muse tunnel restart": "Restart active tunnel and watch daemon",
  "/muse tunnel restart --https": "Restart active Cloudflare HTTPS tunnel (port 7888)",
  "/muse tunnel restart --mcp": "Restart active MCP server tunnel (Streamable HTTP, port 9227)",
  "/muse tunnel restart --mcp --mcp-auth oauth": "Restart active MCP server tunnel with OAuth 2.1 + PKCE",
  "/muse tunnel restart --mcp --mcp-auth static-bearer": "Restart active MCP server tunnel with static Bearer token",
  "/muse tunnel restart --mcp --allow-dangerous": "Restart active MCP server tunnel with destructive tools",
  "/muse tunnel restart --mcp-port": "Restart active MCP server tunnel on a specific port",
  "/muse tunnel prompt": "View and copy active connection prompt for Muse without restarting",
  "/muse tunnel prompt --mcp": "View MCP server tunnel connection details and client config",
  "/muse tunnel url": "Display public URL and WSS endpoint of active tunnel",
  "/muse tunnel url --mcp": "Display public URL of active MCP server tunnel",
  "/muse tunnel status": "Check active development tunnel status (optional: --port <n>)",
  "/muse tunnel status --https": "Check active Cloudflare HTTPS tunnel status for Superagent REST server (port 7888)",
  "/muse tunnel status --port": "Check development tunnel status on a specific port",
  "/muse tunnel status --mcp": "Check active MCP server tunnel status on port 9227",
  "/muse tunnel status --mcp-port": "Check active MCP server tunnel status on a specific port",
  "/muse tunnel doctor": "Diagnose tunnel prerequisites (cloudflared, tunnel-client, credentials)",
  "/muse tunnel guide": "View manual Cloudflare Tunnel setup guide",
  "/muse cloudflare": "Cloudflare Tunnel setup guide, quick test commands, and Bearer token generator",
  "/muse doctor": "Run full health and diagnostic checks (cloudflared binary, tunnel-client, ports, credentials)",
  "/muse connect": "Test connectivity to remote Muse brain (WebSocket or Telegram)",
  "/muse start": "Start background watch mode or tunnel daemon",
  "/muse restart": "Restart background watch daemon or active tunnel",
  "/tunnel": "Manage quick tunnels (list, start [--https] [--mcp], stop, status, restart, doctor)",
  "/tunnel --https": "Start Cloudflare HTTPS tunnel for Superagent REST & SSE server (port 7888)",
  "/tunnel --mcp": "Start MCP server via tunnel (Streamable HTTP, port 9227)",
  "/tunnel list": "List all currently active tunnels across all ports",
  "/tunnel start": "Start quick ephemeral tunnel (optional: --port <n>)",
  "/tunnel start --https": "Start Cloudflare HTTPS tunnel for Superagent REST & SSE server (port 7888)",
  "/tunnel start --port": "Start quick tunnel on a custom local port (e.g. --port 9226)",
  "/tunnel start --mcp": "Start MCP server via tunnel (Streamable HTTP, port 9227)",
  "/tunnel start --mcp --provider openai": "Start MCP server via OpenAI Secure MCP Tunnel (tunnel-client)",
  "/tunnel start --mcp --provider cloudflare": "Start MCP server via Cloudflare quick tunnel (Streamable HTTP)",
  "/tunnel start --mcp --openai": "Start MCP server via OpenAI Secure MCP Tunnel (alias for --provider openai)",
  "/tunnel start --mcp --tunnel-id": "Start OpenAI Secure MCP Tunnel with a specific tunnel ID",
  "/tunnel start --mcp --mcp-auth oauth": "Start MCP server via tunnel with OAuth 2.1 + PKCE authentication (for ChatGPT)",
  "/tunnel start --mcp --mcp-auth static-bearer": "Start MCP server via tunnel with static Bearer token authentication",
  "/tunnel start --mcp --allow-dangerous": "Start MCP server via tunnel with destructive tools enabled",
  "/tunnel start --mcp --mcp-port": "Start MCP server via tunnel on a custom port (default: 9227)",
  "/tunnel start --mcp --mcp-port 9227": "Start MCP server via tunnel on port 9227",
  "/tunnel start --mcp --mcp-auth oauth --allow-dangerous": "Start MCP server via tunnel with OAuth 2.1 and destructive tools",
  "/tunnel start --mcp --mcp-auth static-bearer --allow-dangerous": "Start MCP server via tunnel with static Bearer token and destructive tools",
  "/tunnel start --mcp --mcp-auth oauth --mcp-port 9227": "Start MCP server via tunnel with OAuth 2.1 on port 9227",
  "/tunnel stop": "Stop active quick tunnel (optional: --port <n> or all)",
  "/tunnel stop --https": "Stop active Cloudflare HTTPS tunnel for Superagent REST server (port 7888)",
  "/tunnel stop all": "Stop all running quick tunnels across all ports",
  "/tunnel stop --port": "Stop running quick tunnel on a specific port",
  "/tunnel stop --mcp": "Stop active MCP server tunnel on port 9227",
  "/tunnel stop --mcp-port": "Stop active MCP server tunnel on a specific port",
  "/tunnel restart": "Restart active tunnel and watch daemon",
  "/tunnel restart --https": "Restart active Cloudflare HTTPS tunnel (port 7888)",
  "/tunnel restart --mcp": "Restart active MCP server tunnel (Streamable HTTP, port 9227)",
  "/tunnel restart --mcp --mcp-auth oauth": "Restart active MCP server tunnel with OAuth 2.1 + PKCE",
  "/tunnel restart --mcp --mcp-auth static-bearer": "Restart active MCP server tunnel with static Bearer token",
  "/tunnel restart --mcp --allow-dangerous": "Restart active MCP server tunnel with destructive tools",
  "/tunnel restart --mcp-port": "Restart active MCP server tunnel on a specific port",
  "/tunnel prompt": "View and copy active connection prompt for Muse without restarting",
  "/tunnel prompt --mcp": "View MCP server tunnel connection details and client config",
  "/tunnel url": "Display public URL and WSS endpoint of active tunnel",
  "/tunnel url --mcp": "Display public URL of active MCP server tunnel",
  "/tunnel status": "Check active quick tunnel status (optional: --port <n>)",
  "/tunnel status --https": "Check active Cloudflare HTTPS tunnel status for Superagent REST server (port 7888)",
  "/tunnel status --port": "Check quick tunnel status on a specific port",
  "/tunnel status --mcp": "Check active MCP server tunnel status on port 9227",
  "/tunnel status --mcp-port": "Check active MCP server tunnel status on a specific port",
  "/tunnel doctor": "Diagnose tunnel prerequisites (cloudflared, tunnel-client, credentials)",
  "/tunnel guide": "View manual Cloudflare Tunnel setup guide",
  "/tunnels": "List all currently active quick tunnels",
  "/muse watch": "Start persistent watch mode where Superagent is controlled by Muse",
  "/muse watch start": "Start persistent watch mode where Superagent is controlled by Muse",
  "/muse watch stop": "Stop persistent watch mode and return to manual execution",
  "/muse watch status": "Show active watch mode statistics, watched projects, and connection state",
  "/muse watch add": "Add a project directory to watched workspaces at runtime",
  "/muse watch remove": "Remove a project directory from watched workspaces at runtime",
  "/muse watch --ws": "Start persistent watch mode using WebSocket transport (Cloudflare Tunnel)",
  "/muse watch --tunnel": "Start watch daemon over WebSocket with automatic Cloudflare quick tunnel",
  "/muse watch --https": "Start persistent watch mode using Superagent HTTPS REST/SSE server & Cloudflare tunnel",
  "/muse watch --tunnel --https": "Start watch mode over HTTPS with automatic Cloudflare quick tunnel",
  "/muse watch --telegram": "Start persistent watch mode using Telegram group transport",
  "/muse watch --ws --tg-fallback": "Watch via WebSocket and keep Telegram active as fallback transport",
  "/muse watch --tunnel --tg-fallback": "Watch via Cloudflare tunnel and keep Telegram active as fallback transport",
  "/muse unwatch": "Stop persistent watch mode and return to manual execution",
  "/muse stop": "Cancel active remote task and send cancellation notice to Muse",
  "/muse cancel": "Cancel active remote task and send cancellation notice to Muse",
  "/muse new": "Start a fresh session with remote agent (Muse) and reset context",
  "/muse reset": "Reset remote agent (Muse) session context and conversation memory",
  "/muse config": "Configure transport, wsToken, wsPort, workspaces, botToken, or runner mode",
  "/muse config transport": "Switch Muse transport between websocket and telegram",
  "/muse config transport websocket": "Set Muse transport to WebSocket (for Cloudflare Tunnel)",
  "/muse config transport telegram": "Set Muse transport to Telegram group bus",
  "/muse config wsToken": "Set pre-shared Bearer authentication token for WebSocket",
  "/muse config wsToken generate": "Generate a fresh 256-bit cryptographically secure Bearer token",
  "/muse config wsToken refresh": "Trigger automatic zero-downtime token refresh handshake with Muse",
  "/muse config wsToken rotate": "Rotate Bearer token with 5-minute dual-token handover grace period",
  "/muse config tokenTtl": "Set token TTL in seconds for automatic expiration / renewal tracking",
  "/muse config autoTokenRefresh": "Toggle automatic background token refresh handshake (on/off)",
  "/muse config autoTokenRefresh on": "Enable automatic background token refresh handshake",
  "/muse config autoTokenRefresh off": "Disable automatic background token refresh handshake",
  "/muse config wsPort": "Set local WebSocket server listen port (default: 9225)",
  "/muse config wsHost": "Set local WebSocket server host binding (default: 127.0.0.1)",
  "/muse config wsPath": "Set WebSocket URL path endpoint (default: /muse)",
  "/muse config wsMode": "Set WebSocket mode (server or client)",
  "/muse config wsMode server": "Set WebSocket mode to server (local workstation listens)",
  "/muse config wsMode client": "Set WebSocket mode to client (connect to remote endpoint)",
  "/muse config wsRemoteUrl": "Set remote WebSocket URL when in client mode",
  "/muse config cfAccessClientId": "Set Cloudflare Access Service Token Client ID",
  "/muse config cfAccessClientSecret": "Set Cloudflare Access Service Token Client Secret",
  "/muse config workspaces": "Manage multi-project watched workspaces",
  "/muse config workspaces list": "List all currently configured watched project workspaces",
  "/muse config workspaces add": "Add a project directory to configured watched workspaces",
  "/muse config workspaces remove": "Remove a project directory from configured watched workspaces",
  "/muse config as_runner_model": "Automatically route all terminal chat prompts to Muse (on/off)",
  "/muse config as_runner_model on": "Enable automatic routing of terminal chat prompts to Muse",
  "/muse config as_runner_model off": "Disable automatic routing of terminal chat prompts to Muse",
  "/muse config as_runner": "Route terminal chat prompts to Muse without /muse (on/off)",
  "/muse config as_runner on": "Enable automatic routing of terminal chat prompts to Muse",
  "/muse config as_runner off": "Disable automatic routing of terminal chat prompts to Muse",
  "/muse config botToken": "Configure Telegram runner bot token (Bot B)",
  "/muse config groupId": "Configure Telegram private group chat ID (e.g. -100xxxxxxxxxx)",
  "/muse config museBotId": "Configure Telegram user ID of Muse bot (Bot A)",
  "/muse config defaultWorkspace": "Set default workspace directory for remote tasks",
  "/muse config systemPrompt": "Set custom guidance system instructions for Muse remote brain",
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
  const baseSuggestions = [
    `${prefix} list`,
    `${prefix} start --https`,
    `${prefix} start --mcp`,
    `${prefix} start --mcp --provider openai`,
    `${prefix} start --mcp --provider cloudflare`,
    `${prefix} start --mcp --mcp-auth oauth`,
    `${prefix} start`,
    `${prefix} restart`,
    `${prefix} restart --mcp`,
    `${prefix} prompt`,
    `${prefix} prompt --mcp`,
    `${prefix} url`,
    `${prefix} status --https`,
    `${prefix} status --mcp`,
    `${prefix} status`,
    `${prefix} stop --https`,
    `${prefix} stop --mcp`,
    `${prefix} stop`,
    `${prefix} stop all`,
    `${prefix} doctor`,
    `${prefix} start --port`,
    `${prefix} --https`,
    `${prefix} --mcp`,
    `${prefix} guide`,
  ];

  if (query.startsWith(`${prefix} doctor`)) {
    return filterSuggestions([`${prefix} doctor`], query);
  }

  if (query.startsWith(`${prefix} --`)) {
    const flagSuggestions = [
      `${prefix} --https`,
      `${prefix} --mcp`,
      `${prefix} start --https`,
      `${prefix} start --mcp`,
      `${prefix} start --mcp --provider openai`,
      `${prefix} start --mcp --provider cloudflare`,
      `${prefix} start --mcp --mcp-auth oauth`,
      `${prefix} start --mcp --mcp-auth static-bearer`,
      `${prefix} status --https`,
      `${prefix} status --mcp`,
      `${prefix} stop --https`,
      `${prefix} stop --mcp`,
      `${prefix} restart --mcp`,
      `${prefix} prompt --mcp`,
    ];
    return filterSuggestions(flagSuggestions, query);
  }

  if (query.startsWith(`${prefix} stop`)) {
    const stopSuggestions = [
      `${prefix} stop --https`,
      `${prefix} stop --mcp`,
      `${prefix} stop --mcp-port 9227`,
      `${prefix} stop`,
      `${prefix} stop all`,
      `${prefix} stop --port`,
      `${prefix} stop --mcp-port`,
    ];
    try {
      const dir = path.join(os.homedir(), ".superagent-r");
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const match = f.match(/^tunnel-(\d+)\.json$/);
          if (match) {
            stopSuggestions.push(`${prefix} stop --port ${match[1]}`);
          }
          const mcpMatch = f.match(/^mcp-(\d+)\.json$/);
          if (mcpMatch) {
            stopSuggestions.push(`${prefix} stop --mcp-port ${mcpMatch[1]}`);
          }
          const openaiMatch = f.match(/^openai-tunnel-(\d+)\.json$/);
          if (openaiMatch) {
            stopSuggestions.push(`${prefix} stop --mcp-port ${openaiMatch[1]}`);
          }
        }
      }
    } catch {}
    return filterSuggestions(stopSuggestions, query);
  }

  if (query.startsWith(`${prefix} start`)) {
    const startSuggestions = [
      `${prefix} start --https`,
      `${prefix} start --mcp`,
      `${prefix} start --mcp --provider openai`,
      `${prefix} start --mcp --provider cloudflare`,
      `${prefix} start --mcp --openai`,
      `${prefix} start --mcp --tunnel-id`,
      `${prefix} start --mcp --provider openai --tunnel-id`,
      `${prefix} start --mcp --openai --tunnel-id`,
      `${prefix} start --mcp --mcp-auth oauth`,
      `${prefix} start --mcp --mcp-auth static-bearer`,
      `${prefix} start --mcp --allow-dangerous`,
      `${prefix} start --mcp --mcp-port 9227`,
      `${prefix} start --mcp --mcp-auth oauth --allow-dangerous`,
      `${prefix} start --mcp --mcp-auth static-bearer --allow-dangerous`,
      `${prefix} start --mcp --mcp-auth oauth --mcp-port 9227`,
      `${prefix} start --mcp --allow-dangerous --mcp-auth oauth`,
      `${prefix} start --mcp --allow-dangerous --mcp-auth static-bearer`,
      `${prefix} start --mcp-auth oauth`,
      `${prefix} start --mcp-auth static-bearer`,
      `${prefix} start --mcp-port 9227`,
      `${prefix} start`,
      `${prefix} start --port`,
      `${prefix} start --port 9226`,
      `${prefix} start --port 9227`,
    ];
    return filterSuggestions(startSuggestions, query);
  }

  if (query.startsWith(`${prefix} restart`)) {
    const restartSuggestions = [
      `${prefix} restart`,
      `${prefix} restart --https`,
      `${prefix} restart --mcp`,
      `${prefix} restart --mcp --provider openai`,
      `${prefix} restart --mcp --provider cloudflare`,
      `${prefix} restart --mcp --mcp-auth oauth`,
      `${prefix} restart --mcp --mcp-auth static-bearer`,
      `${prefix} restart --mcp --allow-dangerous`,
      `${prefix} restart --mcp --mcp-port 9227`,
      `${prefix} restart --port`,
    ];
    try {
      const dir = path.join(os.homedir(), ".superagent-r");
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const match = f.match(/^tunnel-(\d+)\.json$/);
          if (match) {
            restartSuggestions.push(`${prefix} restart --port ${match[1]}`);
          }
          const mcpMatch = f.match(/^mcp-(\d+)\.json$/);
          if (mcpMatch) {
            restartSuggestions.push(`${prefix} restart --mcp-port ${mcpMatch[1]}`);
          }
          const openaiMatch = f.match(/^openai-tunnel-(\d+)\.json$/);
          if (openaiMatch) {
            restartSuggestions.push(`${prefix} restart --mcp-port ${openaiMatch[1]}`);
          }
        }
      }
    } catch {}
    return filterSuggestions(restartSuggestions, query);
  }

  if (query.startsWith(`${prefix} prompt`)) {
    const promptSuggestions = [
      `${prefix} prompt`,
      `${prefix} prompt --https`,
      `${prefix} prompt --mcp`,
      `${prefix} prompt --mcp-port 9227`,
      `${prefix} prompt --port`,
    ];
    try {
      const dir = path.join(os.homedir(), ".superagent-r");
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const match = f.match(/^tunnel-(\d+)\.json$/);
          if (match) {
            promptSuggestions.push(`${prefix} prompt --port ${match[1]}`);
          }
          const mcpMatch = f.match(/^mcp-(\d+)\.json$/);
          if (mcpMatch) {
            promptSuggestions.push(`${prefix} prompt --mcp-port ${mcpMatch[1]}`);
          }
          const openaiMatch = f.match(/^openai-tunnel-(\d+)\.json$/);
          if (openaiMatch) {
            promptSuggestions.push(`${prefix} prompt --mcp-port ${openaiMatch[1]}`);
          }
        }
      }
    } catch {}
    return filterSuggestions(promptSuggestions, query);
  }

  if (query.startsWith(`${prefix} url`)) {
    const urlSuggestions = [
      `${prefix} url`,
      `${prefix} url --mcp`,
      `${prefix} url --port`,
    ];
    return filterSuggestions(urlSuggestions, query);
  }

  if (query.startsWith(`${prefix} status`)) {
    const statusSuggestions = [
      `${prefix} status --https`,
      `${prefix} status --mcp`,
      `${prefix} status --mcp-port 9227`,
      `${prefix} status`,
      `${prefix} status --port`,
    ];
    try {
      const dir = path.join(os.homedir(), ".superagent-r");
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          const match = f.match(/^tunnel-(\d+)\.json$/);
          if (match) {
            statusSuggestions.push(`${prefix} status --port ${match[1]}`);
          }
          const mcpMatch = f.match(/^mcp-(\d+)\.json$/);
          if (mcpMatch) {
            statusSuggestions.push(`${prefix} status --mcp-port ${mcpMatch[1]}`);
          }
          const openaiMatch = f.match(/^openai-tunnel-(\d+)\.json$/);
          if (openaiMatch) {
            statusSuggestions.push(`${prefix} status --mcp-port ${openaiMatch[1]}`);
          }
        }
      }
    } catch {}
    return filterSuggestions(statusSuggestions, query);
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
      if (sub === "tunnel") {
        const action = parts[2]?.toLowerCase();
        if (action === "start") {
          const startSuggestions = [
            "/mcp tunnel start",
            "/mcp tunnel start --provider openai",
            "/mcp tunnel start --provider cloudflare",
            "/mcp tunnel start --openai",
            "/mcp tunnel start --tunnel-id",
            "/mcp tunnel start --provider openai --tunnel-id",
            "/mcp tunnel start --openai --tunnel-id",
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
            "/mcp tunnel stop all",
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
        if (action === "doctor") {
          return filterSuggestions(["/mcp tunnel doctor"], query);
        }
        if (action === "list") {
          return filterSuggestions(["/mcp tunnel list"], query);
        }
        if (action === "status") {
          return filterSuggestions(["/mcp tunnel status", "/mcp tunnel status --mcp-port 9227"], query);
        }
        const tunnelPossibilities = [
          "/mcp tunnel start",
          "/mcp tunnel start --provider openai",
          "/mcp tunnel start --provider cloudflare",
          "/mcp tunnel start --openai",
          "/mcp tunnel start --tunnel-id",
          "/mcp tunnel start --mcp-auth oauth",
          "/mcp tunnel start --allow-dangerous",
          "/mcp tunnel stop",
          "/mcp tunnel list",
          "/mcp tunnel status",
          "/mcp tunnel doctor",
        ];
        return filterSuggestions(tunnelPossibilities, query);
      }
      const possibilities = [
        "/mcp list",
        "/mcp add",
        "/mcp remove",
        "/mcp reload",
        "/mcp tunnel",
        "/mcp tunnel start",
        "/mcp tunnel start --provider openai",
        "/mcp tunnel start --provider cloudflare",
        "/mcp tunnel start --openai",
        "/mcp tunnel start --tunnel-id",
        "/mcp tunnel stop",
        "/mcp tunnel list",
        "/mcp tunnel status",
        "/mcp tunnel doctor",
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
          "/muse config botToken",
          "/muse config groupId",
          "/muse config museBotId",
          "/muse config defaultWorkspace",
          "/muse config systemPrompt",
        ];
        return filterSuggestions(configPossibilities, query);
      }

      if (sub === "tunnel" || sub === "cloudflare") {
        return getTunnelSubSuggestions(sub === "cloudflare" ? "/muse cloudflare" : "/muse tunnel", query);
      }

      if (sub === "watch") {
        const watchPossibilities = [
          "/muse watch start",
          "/muse watch stop",
          "/muse watch status",
          "/muse watch --tunnel",
          "/muse watch --ws --tg-fallback",
          "/muse watch --https",
          "/muse watch --ws",
          "/muse watch --telegram",
          "/muse watch add",
          "/muse watch remove",
        ];
        return filterSuggestions(watchPossibilities, query);
      }

      const possibilities = [
        "/muse status",
        "/muse tunnel",
        "/muse tunnel list",
        "/muse tunnel start",
        "/muse tunnel start --mcp",
        "/muse tunnel start --mcp --provider openai",
        "/muse tunnel start --mcp --provider cloudflare",
        "/muse tunnel start --mcp --openai",
        "/muse tunnel start --mcp --tunnel-id",
        "/muse tunnel start --mcp --mcp-auth oauth",
        "/muse tunnel start --https",
        "/muse tunnel start --port",
        "/muse tunnel restart",
        "/muse tunnel restart --mcp",
        "/muse tunnel stop",
        "/muse tunnel stop --mcp",
        "/muse tunnel stop all",
        "/muse tunnel status",
        "/muse tunnel status --mcp",
        "/muse tunnel doctor",
        "/muse tunnel prompt",
        "/muse tunnel prompt --mcp",
        "/muse tunnel url",
        "/muse tunnel guide",
        "/muse cloudflare",
        "/muse doctor",
        "/muse connect",
        "/muse start",
        "/muse restart",
        "/muse watch",
        "/muse watch start",
        "/muse watch stop",
        "/muse watch status",
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
        "/muse config botToken",
        "/muse config groupId",
        "/muse config museBotId",
        "/muse config defaultWorkspace",
        "/muse config systemPrompt",
      ];
      return filterSuggestions(possibilities, query);
    }

    if (mainCommand === "/tunnel") {
      return getTunnelSubSuggestions("/tunnel", query);
    }

    if (mainCommand === "/tunnels") {
      return filterSuggestions(["/tunnels", "/tunnel list"], query);
    }

    if (mainCommand === "/yolo" || mainCommand === "/yolomode") {
      const prefix = mainCommand;
      return filterSuggestions([prefix, `${prefix} on`, `${prefix} full`, `${prefix} off`, `${prefix} status`], query);
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
