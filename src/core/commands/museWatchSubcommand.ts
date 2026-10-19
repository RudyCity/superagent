import path from "path";
import type { SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  RemoteAgentTransport,
} from "../remoteAgent/config.js";
import type { MuseWatcherOptions } from "../remoteAgent/museWatcher.js";

/**
 * Handles `/muse watch` and `/muse unwatch` subcommands.
 */
export async function handleMuseWatchSubcommand(
  parts: string[],
  ctx: SlashCommandContext,
  now: number
): Promise<void> {
  const subcommand = (parts[0] || "").toLowerCase();
  const action = subcommand === "unwatch" ? "stop" : (parts[1]?.toLowerCase() || "start");
  const hasServerExposureFlag = parts.some((p) => ["--https", "--http", "--web"].includes(p.toLowerCase()));
  if (hasServerExposureFlag) {
    ctx.addLine({ type: "error", content: "Muse watch no longer manages REST/SSE exposure. Use /server tunnel for the HTTP server.", timestamp: now });
    return;
  }
  const hasTelegramFallbackFlag = parts.some((p) => ["--tg-fallback", "--telegram-fallback"].includes(p.toLowerCase()));
  if (hasTelegramFallbackFlag) {
    ctx.addLine({ type: "error", content: "Telegram fallback is managed independently. Use /telegram fallback start|stop.", timestamp: now });
    return;
  }
  const {
    startMuseWatcher,
    stopMuseWatcher,
    isMuseWatcherActive,
    getMuseWatcher,
  } = await import("../remoteAgent/museWatcher.js");

  if (action === "stop") {
    if (!isMuseWatcherActive()) {
      ctx.addLine({
        type: "system",
        content: "[Muse Watch] Muse watch mode is not currently running. Telegram fallback and REST/SSE services were not changed.",
        timestamp: now,
      });
      return;
    }
    await stopMuseWatcher();
    ctx.addLine({
      type: "system",
      content: "[Muse Watch] Muse watch mode stopped. Telegram fallback and REST/SSE services were not changed.",
      timestamp: now,
    });
    return;
  }

  if (action === "status") {
    const watcher = getMuseWatcher();
    const stats = watcher?.getStats();

    if (!stats || !stats.isRunning) {
      ctx.addLine({
        type: "system",
        content: "[Muse Watch] Watch mode is INACTIVE. Run '/muse watch' or '/muse watch start' to activate. Use /telegram fallback status or /server tunnel status to inspect other services.",
        timestamp: now,
      });
      return;
    }

    const wsLines = stats.workspaces && stats.workspaces.length > 1
      ? `- Watched Projects (${stats.workspaces.length}):\n${stats.workspaces.map((w, i) => `   ${i + 1}. ${path.basename(w)} (${w})`).join("\n")}`
      : `- Workspace         : ${stats.workspace}`;

    const lines = [
      "Muse Watch Mode: ACTIVE",
      `- Transport         : ${stats.transportDetails || stats.transport || "telegram"}`,
      stats.tunnelUrl ? `- Public URL        : ${stats.tunnelUrl}` : null,
      wsLines,
      `- Uptime            : ${stats.uptimeSeconds}s`,
      `- Batches Executed  : ${stats.batchesExecuted}`,
      `- Tasks Completed   : ${stats.tasksCompleted}`,
      `- Active Task       : ${stats.activeTaskId || "none (idle, waiting for remote requests)"}`,
    ].filter(Boolean);
    ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: now });
    return;
  }

  if (action === "add") {
    const dirToAdd = parts.slice(2).join(" ").trim();
    if (!dirToAdd) {
      ctx.addLine({
        type: "error",
        content: "Usage: /muse watch add <project_directory>",
        timestamp: now,
      });
      return;
    }
    const resolved = path.resolve(dirToAdd);
    addWatchedWorkspace(resolved);
    const watcher = getMuseWatcher();
    if (watcher && isMuseWatcherActive()) {
      watcher.addWorkspace(resolved);
    }
    ctx.addLine({
      type: "system",
      content: `[Muse Watch] Added project "${path.basename(resolved)}" (${resolved}) to watched projects.`,
      timestamp: now,
    });
    return;
  }

  if (action === "remove") {
    const dirToRem = parts.slice(2).join(" ").trim();
    if (!dirToRem) {
      ctx.addLine({
        type: "error",
        content: "Usage: /muse watch remove <project_directory>",
        timestamp: now,
      });
      return;
    }
    const resolved = path.resolve(dirToRem);
    removeWatchedWorkspace(resolved);
    const watcher = getMuseWatcher();
    if (watcher && isMuseWatcherActive()) {
      watcher.removeWorkspace(resolved);
    }
    ctx.addLine({
      type: "system",
      content: `[Muse Watch] Removed project "${path.basename(resolved)}" (${resolved}) from watched projects.`,
      timestamp: now,
    });
    return;
  }

  // Collect Muse-only watch options. Telegram fallback and REST/SSE exposure
  // are managed by their own command domains.
  const isWs = parts.some((p) => p === "--ws" || p === "--websocket");
  const isTg = parts.some((p) => p === "--telegram" || p === "--tg");
  const isTunnel = parts.some((p) => p === "--tunnel" || p === "--quick-tunnel");
  const portArgIdx = parts.findIndex((p) => p === "--port" || p === "-p");
  let portOverride: number | undefined;
  if (portArgIdx !== -1 && parts[portArgIdx + 1]) {
    const parsed = parseInt(parts[portArgIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) portOverride = parsed;
    else {
      ctx.addLine({ type: "error", content: "Invalid --port. Use an integer between 1 and 65535.", timestamp: now });
      return;
    }
  }

  const cfg = loadRemoteAgentConfig();
  const transportType: RemoteAgentTransport = (isWs || isTunnel)
    ? "websocket"
    : isTg
      ? "telegram"
      : (cfg.transport || "telegram");

  const rawDirs = parts.slice(1).filter((p) => {
    if (p.toLowerCase() === "start") return false;
    if (
      p === "--ws" ||
      p === "--websocket" ||
      p === "--telegram" ||
      p === "--tg" ||
      p === "--tunnel" ||
      p === "--quick-tunnel" ||
      p === "--port" ||
      p === "-p"
    )
      return false;
    if (portArgIdx !== -1 && (p === parts[portArgIdx + 1])) return false;
    return true;
  });
  const targetDirs = rawDirs
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .map((d) => path.resolve(d));

  const allWatched = targetDirs.length > 0
    ? targetDirs
    : getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);

  // If already active:
  if (isMuseWatcherActive()) {
    const watcher = getMuseWatcher();
    if (targetDirs.length > 0 && watcher) {
      for (const d of targetDirs) {
        watcher.addWorkspace(d);
      }
      ctx.addLine({
        type: "system",
        content: `[Muse Watch] Added ${targetDirs.length} project(s) to running watch session:\n${targetDirs.map((d, i) => `  ${i + 1}. ${path.basename(d)} (${d})`).join("\n")}`,
        timestamp: now,
      });
      return;
    }
    ctx.addLine({
      type: "system",
      content: "[Muse Watch] Watch mode is already running. Superagent is actively controlled by Muse.\nRun '/muse watch stop' to deactivate.",
      timestamp: now,
    });
    return;
  }

  const primaryWatcherOptions: MuseWatcherOptions = {
      workspace: allWatched[0] || ctx.agent?.workingDirectory || process.cwd(),
      workspaces: allWatched,
      transportType,
      tunnel: isTunnel,
      isHttps: false,
      wsPort: portOverride,
      agent: ctx.agent,
      onProgress: (msg) => {
        ctx.addLine({
          type: "system",
          content: `[Muse Progress] ${msg}`,
          timestamp: Date.now(),
        });
      },
      onToolStart: (toolCall, description) => {
        if (ctx.agent?.onEvent) {
          ctx.agent.onEvent({
            type: "tool_start",
            toolCall,
            description,
          });
          return;
        }
        ctx.addLine({
          type: "tool_start",
          content: `⚡ ${description}\n   Detail: ${toolCall.name}(${JSON.stringify(toolCall.args || {})})`,
          timestamp: Date.now(),
        });
      },
      onToolEnd: (toolCall, toolResult, description) => {
        if (ctx.agent?.onEvent) {
          ctx.agent.onEvent({
            type: "tool_end",
            toolCall,
            toolResult,
            description,
          });
          return;
        }
        ctx.addLine({
          type: "tool_end",
          content: `✔ ${description}`,
          timestamp: Date.now(),
        });
      },
      onLine: (line) => {
        ctx.addLine({
          type: (line.type as any) || "system",
          content: line.content,
          timestamp: line.timestamp || Date.now(),
        });
      },
    };

  try {
    await startMuseWatcher(primaryWatcherOptions);


  } catch (err: any) {
    ctx.addLine({
      type: "error",
      content: `[Muse Watch] Failed to start watch mode: ${err.message}`,
      timestamp: now,
    });
  }
}
