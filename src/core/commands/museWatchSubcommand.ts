import path from "path";
import type { SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  getWatchedWorkspaces,
  addWatchedWorkspace,
  removeWatchedWorkspace,
  RemoteAgentTransport,
} from "../remoteAgent/config.js";

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
  const {
    startMuseWatcher,
    stopMuseWatcher,
    isMuseWatcherActive,
    getMuseWatcher,
  } = await import("../remoteAgent/museWatcher.js");

  if (action === "stop") {
    let stoppedAny = false;
    if (isMuseWatcherActive()) {
      await stopMuseWatcher();
      stoppedAny = true;
    }
    const { getTunnelStatus, stopQuickTunnel } = await import("../remoteAgent/cloudflareTunnel.js");
    const httpsTunnel = getTunnelStatus(7888);
    if (httpsTunnel.isRunning) {
      await stopQuickTunnel(7888);
      stoppedAny = true;
    }
    if (!stoppedAny) {
      ctx.addLine({
        type: "system",
        content: "[Muse Watch] Watch mode is not currently running.",
        timestamp: now,
      });
      return;
    }
    ctx.addLine({
      type: "system",
      content: "[Muse Watch] Watch mode stopped successfully.",
      timestamp: now,
    });
    return;
  }

  if (action === "status") {
    const watcher = getMuseWatcher();
    const stats = watcher?.getStats();
    const { getTunnelStatus } = await import("../remoteAgent/cloudflareTunnel.js");
    const httpsTunnel = getTunnelStatus(7888);

    if (!stats || !stats.isRunning) {
      if (httpsTunnel.isRunning) {
        const { getServerAuthToken } = await import("../utils/serverSecurity.js");
        const serverToken = getServerAuthToken();
        ctx.addLine({
          type: "system",
          content: [
            "Muse Watch Mode: ACTIVE (HTTPS REST/SSE Server)",
            `- Transport         : HTTP REST/SSE Server (port ${httpsTunnel.port || 7888})`,
            `- Public HTTPS URL  : ${httpsTunnel.publicUrl}`,
            `- Local Target      : ${httpsTunnel.localUrl || `http://127.0.0.1:${httpsTunnel.port || 7888}`}`,
            `- Server Port       : ${httpsTunnel.port || 7888}`,
            `- Process PID       : ${httpsTunnel.pid}`,
            `- Uptime            : ${httpsTunnel.uptimeSeconds}s`,
            `- Bearer Token      : ${serverToken}`,
            "",
            "Run '/muse watch stop' or '/muse tunnel stop --https' to stop.",
          ].join("\n"),
          timestamp: now,
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: "[Muse Watch] Watch mode is INACTIVE. Run '/muse watch' or '/muse watch start' to activate.",
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

  // Collect directories and flags: /muse watch [start] [--ws] [--tunnel] [--https] [dir1] [dir2] ...
  const isWs = parts.some((p) => p === "--ws" || p === "--websocket");
  const isTg = parts.some((p) => p === "--telegram" || p === "--tg");
  const isTunnel = parts.some((p) => p === "--tunnel" || p === "--quick-tunnel");
  const isHttps = parts.some((p) => p === "--https" || p === "--http" || p === "--web");
  const portArgIdx = parts.findIndex((p) => p === "--port" || p === "-p");
  let portOverride: number | undefined;
  if (portArgIdx !== -1 && parts[portArgIdx + 1]) {
    const parsed = parseInt(parts[portArgIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
  }

  const cfg = loadRemoteAgentConfig();
  const transportType: RemoteAgentTransport = isHttps
    ? "https"
    : (isWs || isTunnel)
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
      p === "--https" ||
      p === "--http" ||
      p === "--web" ||
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

  try {
    await startMuseWatcher({
      workspace: allWatched[0] || ctx.agent?.workingDirectory || process.cwd(),
      workspaces: allWatched,
      transportType,
      tunnel: isTunnel || isHttps,
      isHttps: isHttps,
      wsPort: portOverride || (isHttps ? 7888 : undefined),
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
    });
  } catch (err: any) {
    ctx.addLine({
      type: "error",
      content: `[Muse Watch] Failed to start watch mode: ${err.message}`,
      timestamp: now,
    });
  }
}
