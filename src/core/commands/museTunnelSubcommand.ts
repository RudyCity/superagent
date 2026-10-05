import path from "path";
import { SlashCommandContext } from "./types.js";
import {
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  generateSecureWsToken,
  getWatchedWorkspaces,
  maskSecret,
} from "../remoteAgent/config.js";

/**
 * Handles `/muse tunnel` and `/muse cloudflare` subcommands.
 */
export async function handleMuseTunnelSubcommand(
  parts: string[],
  ctx: SlashCommandContext,
  now: number
): Promise<void> {
  const isHttps = parts
    .slice(1)
    .some((p) => p.toLowerCase() === "--https" || p.toLowerCase() === "--http" || p.toLowerCase() === "--web");
  const nonFlagParts = parts.slice(1).filter((p) => !p.startsWith("-"));
  const rawAction = (nonFlagParts[0] || (isHttps ? "start" : "")).toLowerCase();
  const cfg = loadRemoteAgentConfig();
  const host = cfg.wsHost || "127.0.0.1";
  const port = cfg.wsPort || 9225;
  const pathEndpoint = cfg.wsPath || "/muse";
  let token = cfg.wsToken;

  if (!token && !isHttps) {
    token = generateSecureWsToken();
    updateRemoteAgentConfig({ wsToken: token, transport: "websocket" });
    ctx.addLine({
      type: "system",
      content: `[Muse Security] Generated new Bearer token: ${token}`,
      timestamp: now,
    });
  }

  const {
    startQuickTunnel,
    stopQuickTunnel,
    stopAllQuickTunnels,
    getTunnelStatus,
    listActiveTunnels,
    formatActiveTunnels,
    buildMuseConnectionPrompt,
    copyTextToClipboard,
  } = await import("../remoteAgent/cloudflareTunnel.js");
  const {
    startMuseWatcher,
    stopMuseWatcher,
    isMuseWatcherActive,
  } = await import("../remoteAgent/museWatcher.js");

  // /muse tunnel list
  if (rawAction === "list" || rawAction === "ls" || rawAction === "active") {
    const tunnels = listActiveTunnels();
    ctx.addLine({
      type: "system",
      content: formatActiveTunnels(tunnels),
      timestamp: now,
    });
    return;
  }

  // /muse tunnel restart
  if (rawAction === "restart") {
    const rawArgs = parts.slice(1).filter((p) => p.toLowerCase() !== rawAction && p.toLowerCase() !== "tunnel" && p.toLowerCase() !== "cloudflare");
    const portArgIdx = rawArgs.findIndex((a) => a === "--port" || a === "-p");
    let portOverride: number | undefined;
    if (portArgIdx !== -1 && rawArgs[portArgIdx + 1]) {
      const parsed = parseInt(rawArgs[portArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
    }
    const effectivePort = portOverride || (isHttps ? 7888 : port);

    ctx.addLine({
      type: "system",
      content: `[Cloudflare Tunnel] Restarting quick tunnel on port ${effectivePort}...`,
      timestamp: now,
    });

    if (isHttps) {
      const existing = getTunnelStatus(effectivePort);
      if (existing.isRunning) {
        await stopQuickTunnel(effectivePort);
      }
    } else {
      if (isMuseWatcherActive(effectivePort)) {
        await stopMuseWatcher(effectivePort);
      }
      const existing = getTunnelStatus(effectivePort);
      if (existing.isRunning) {
        await stopQuickTunnel(effectivePort);
      }
    }

    // Now re-run with action "start"
    const restartParts = parts.filter((p) => p.toLowerCase() !== "restart");
    restartParts.splice(1, 0, "start");
    return handleMuseTunnelSubcommand(restartParts, ctx, Date.now());
  }

  // /muse tunnel prompt / url / link
  if (rawAction === "prompt" || rawAction === "url" || rawAction === "link") {
    const rawArgs = parts.slice(1).filter((p) => p.toLowerCase() !== rawAction && p.toLowerCase() !== "tunnel" && p.toLowerCase() !== "cloudflare");
    const portArgIdx = rawArgs.findIndex((a) => a === "--port" || a === "-p");
    let portOverride: number | undefined;
    if (portArgIdx !== -1 && rawArgs[portArgIdx + 1]) {
      const parsed = parseInt(rawArgs[portArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
    }
    const effectivePort = portOverride || (isHttps ? 7888 : port);
    const existing = getTunnelStatus(effectivePort);

    if (!existing.isRunning) {
      ctx.addLine({
        type: "system",
        content: `[Cloudflare Tunnel] No quick tunnel is currently active on port ${effectivePort}.\nRun '/muse tunnel start${portOverride ? ` --port ${portOverride}` : ""}' to launch.`,
        timestamp: now,
      });
      return;
    }

    if (isHttps) {
      const { getServerAuthToken } = await import("../utils/serverSecurity.js");
      const serverToken = getServerAuthToken(effectivePort);
      const curlSnippet = `curl -H "Authorization: Bearer ${serverToken}" ${existing.publicUrl}/api/status`;
      const copied = await copyTextToClipboard(curlSnippet);
      ctx.addLine({
        type: "system",
        content: [
          `Cloudflare HTTPS Tunnel (port ${effectivePort}):`,
          `- Public HTTPS URL : ${existing.publicUrl}`,
          `- Local Target     : ${existing.localUrl || `http://${host}:${effectivePort}`}`,
          `- Bearer Token     : ${serverToken}`,
          "",
          copied ? "Curl snippet copied to clipboard:" : "Curl snippet:",
          curlSnippet,
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
    const musePrompt = buildMuseConnectionPrompt({
      wssUrl: existing.wssUrl || "",
      token: token || "",
      publicUrl: existing.publicUrl,
      localUrl: existing.localUrl,
      workspaces: watchedWorkspaces,
      cfClientId: cfg.cfAccessClientId,
      cfClientSecret: cfg.cfAccessClientSecret,
    });
    const copied = await copyTextToClipboard(musePrompt);

    ctx.addLine({
      type: "system",
      content: [
        `Cloudflare Quick Tunnel (port ${effectivePort}):`,
        `- Public URL   : ${existing.publicUrl}`,
        `- WSS Endpoint : ${existing.wssUrl}`,
        `- Local Target : ${existing.localUrl}`,
        `- Process PID  : ${existing.pid}`,
        `- Bearer Token : ${token || "(none)"}`,
        "",
        copied ? "Prompt for Muse (copied to clipboard):" : "Prompt for Muse:",
        "-----------------------------------------------------------------------------",
        musePrompt,
        "-----------------------------------------------------------------------------",
      ].join("\n"),
      timestamp: now,
    });
    return;
  }

  // /muse tunnel start
  if (rawAction === "start" || rawAction === "quick" || rawAction === "run") {
    const rawArgs = parts.slice(1).filter((p) => p.toLowerCase() !== rawAction && p.toLowerCase() !== "tunnel" && p.toLowerCase() !== "cloudflare");
    const portArgIdx = rawArgs.findIndex((a) => a === "--port" || a === "-p");
    let portOverride: number | undefined;
    if (portArgIdx !== -1 && rawArgs[portArgIdx + 1]) {
      const parsed = parseInt(rawArgs[portArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
    }

    const initialTask = rawArgs
      .filter((a, idx, arr) => {
        if (a === "--port" || a === "-p" || a === "--https" || a === "--http" || a === "--web") return false;
        if (idx > 0 && (arr[idx - 1] === "--port" || arr[idx - 1] === "-p")) return false;
        return true;
      })
      .join(" ")
      .trim();

    const effectivePort = portOverride || (isHttps ? 7888 : port);
    const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
    const existing = getTunnelStatus(effectivePort);
    const watcherActive = isMuseWatcherActive(effectivePort);

    if (isHttps) {
      const { getServerAuthToken } = await import("../utils/serverSecurity.js");
      const { ensureSuperagentServer } = await import("../remoteAgent/cloudflareTunnel.js");

      if (existing.isRunning) {
        const serverToken = getServerAuthToken(effectivePort);
        const curlSnippet = `curl -H "Authorization: Bearer ${serverToken}" ${existing.publicUrl}/api/status`;
        const copied = await copyTextToClipboard(curlSnippet);

        ctx.addLine({
          type: "system",
          content: [
            "[Cloudflare HTTPS Tunnel] Quick tunnel and HTTP server are ALREADY ACTIVE:",
            `- Public HTTPS URL : ${existing.publicUrl}`,
            `- Local Target     : ${existing.localUrl || `http://${host}:${effectivePort}`}`,
            `- Server Port      : ${effectivePort}`,
            `- Process PID      : ${existing.pid}`,
            `- Uptime           : ${existing.uptimeSeconds}s`,
            `- Bearer Token     : ${serverToken}`,
            "",
            copied
              ? "Test with curl (copied to clipboard, ready to run):"
              : "Test with curl (copy & run):",
            "-----------------------------------------------------------------------------",
            curlSnippet,
            "-----------------------------------------------------------------------------",
            "",
            `To stop the tunnel, run: /muse tunnel stop --https${portOverride ? ` --port ${portOverride}` : ""}`,
          ].join("\n"),
          timestamp: now,
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `[Cloudflare HTTPS Tunnel] Starting Superagent HTTP REST/SSE server (port ${effectivePort}) in WATCH mode with Cloudflare quick tunnel...`,
        timestamp: now,
      });

      try {
        if (watcherActive) {
          await stopMuseWatcher(effectivePort);
        }

        await startMuseWatcher({
          workspace: watchedWorkspaces[0] || ctx.agent?.workingDirectory || process.cwd(),
          workspaces: watchedWorkspaces,
          transportType: "https",
          wsPort: effectivePort,
          tunnel: true,
          isHttps: true,
          agent: ctx.agent,
          onProgress: (msg) => {
            ctx.addLine({
              type: "system",
              content: `[Muse Progress] ${msg}`,
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
        return;
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `[Cloudflare HTTPS Tunnel Error] ${err?.message || String(err)}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (existing.isRunning) {
      const musePrompt = buildMuseConnectionPrompt({
        wssUrl: existing.wssUrl || "",
        token: token || "",
        publicUrl: existing.publicUrl,
        localUrl: existing.localUrl,
        workspaces: watchedWorkspaces,
        cfClientId: cfg.cfAccessClientId,
        cfClientSecret: cfg.cfAccessClientSecret,
        task: initialTask,
      });
      const copied = await copyTextToClipboard(musePrompt);

      ctx.addLine({
        type: "system",
        content: [
          "[Cloudflare Tunnel] Quick tunnel and WebSocket server are ALREADY ACTIVE:",
          `- Public URL   : ${existing.publicUrl}`,
          `- WSS Endpoint : ${existing.wssUrl}`,
          `- Local Target : ${existing.localUrl}`,
          `- Process PID  : ${existing.pid}`,
          `- Uptime       : ${existing.uptimeSeconds}s`,
          `- Bearer Token : ${token}`,
          "",
          copied
            ? "Prompt for Muse (copied to clipboard, ready to send):"
            : "Prompt for Muse (copy & send to Muse):",
          "-----------------------------------------------------------------------------",
          musePrompt,
          "-----------------------------------------------------------------------------",
          "",
          `To stop the tunnel, run: /muse tunnel stop${portOverride ? ` --port ${portOverride}` : ""}`,
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    ctx.addLine({
      type: "system",
      content: `[Cloudflare Tunnel] Starting Superagent WebSocket server (port ${effectivePort}) and Cloudflare quick tunnel...`,
      timestamp: now,
    });

    try {
      if (watcherActive) {
        await stopMuseWatcher(effectivePort);
      }

      await startMuseWatcher({
        workspace: watchedWorkspaces[0] || ctx.agent?.workingDirectory || process.cwd(),
        workspaces: watchedWorkspaces,
        transportType: "websocket",
        tunnel: true,
        wsPort: effectivePort,
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

      const meta = getTunnelStatus(effectivePort);
      const effectiveWss = meta.wssUrl || `wss://${meta.publicUrl?.replace(/^https?:\/\//, "")}${pathEndpoint}`;

      const musePrompt = buildMuseConnectionPrompt({
        wssUrl: effectiveWss,
        token: token || "",
        publicUrl: meta.publicUrl,
        localUrl: meta.localUrl || `http://${host}:${effectivePort}`,
        workspaces: watchedWorkspaces,
        cfClientId: cfg.cfAccessClientId,
        cfClientSecret: cfg.cfAccessClientSecret,
        task: initialTask,
      });
      const copied = await copyTextToClipboard(musePrompt);

      ctx.addLine({
        type: "system",
        content: [
          "═════════════════════════════════════════════════════════════════════════════",
          "  Cloudflare Quick Ephemeral Tunnel Online!",
          "═════════════════════════════════════════════════════════════════════════════",
          `- Public URL   : ${meta.publicUrl}`,
          `- WSS Endpoint : ${effectiveWss}`,
          `- Local Target : ${meta.localUrl || `http://${host}:${effectivePort}`}`,
          `- Process PID  : ${meta.pid}`,
          `- Bearer Token : ${token}`,
          "═════════════════════════════════════════════════════════════════════════════",
          "",
          copied
            ? "Prompt for Muse (copied to clipboard, ready to send):"
            : "Prompt for Muse (copy & send to Muse):",
          "-----------------------------------------------------------------------------",
          musePrompt,
          "-----------------------------------------------------------------------------",
          "",
          "Superagent is actively listening in WATCH mode over WebSocket.",
          "When Muse connects and sends remote tasks or tool batches, Superagent will execute them locally and report back in real time.",
          "Run '/muse tunnel stop' to terminate the tunnel at any time.",
        ].join("\n"),
        timestamp: Date.now(),
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `[Cloudflare Tunnel] Error: ${err?.message}`,
        timestamp: Date.now(),
      });
    }
    return;
  }

  // /muse tunnel stop
  if (rawAction === "stop") {
    const rawArgs = parts.slice(1).filter((p) => p.toLowerCase() !== rawAction && p.toLowerCase() !== "tunnel" && p.toLowerCase() !== "cloudflare");
    const isAll = rawArgs.includes("all") || rawArgs.includes("--all") || rawArgs.includes("-a");
    if (isAll) {
      if (isMuseWatcherActive()) {
        await stopMuseWatcher();
      }
      const count = await stopAllQuickTunnels();
      ctx.addLine({
        type: "system",
        content: `[Cloudflare Tunnel] Stopped ${count} active quick tunnel${count === 1 ? "" : "s"}.`,
        timestamp: Date.now(),
      });
      return;
    }

    const portArgIdx = rawArgs.findIndex((a) => a === "--port" || a === "-p");
    let portOverride: number | undefined;
    if (portArgIdx !== -1 && rawArgs[portArgIdx + 1]) {
      const parsed = parseInt(rawArgs[portArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
    }

    const effectivePort = portOverride || (isHttps ? 7888 : port);

    if (isHttps) {
      const existing = getTunnelStatus(effectivePort);
      if (existing.isRunning) {
        await stopQuickTunnel(effectivePort);
        ctx.addLine({
          type: "system",
          content: `[Cloudflare HTTPS Tunnel] Quick tunnel (port ${effectivePort}) stopped successfully.`,
          timestamp: Date.now(),
        });
      } else {
        ctx.addLine({
          type: "system",
          content: `[Cloudflare HTTPS Tunnel] No quick tunnel is currently running on port ${effectivePort}.`,
          timestamp: now,
        });
      }
      return;
    }

    let stoppedAny = false;
    if (isMuseWatcherActive(effectivePort)) {
      await stopMuseWatcher(effectivePort);
      stoppedAny = true;
    }
    const existing = getTunnelStatus(effectivePort);
    if (existing.isRunning) {
      await stopQuickTunnel(effectivePort);
      stoppedAny = true;
    }
    if (!stoppedAny) {
      ctx.addLine({
        type: "system",
        content: `[Cloudflare Tunnel] No quick tunnel is currently running${portOverride ? ` on port ${portOverride}` : ""}.`,
        timestamp: now,
      });
      return;
    }
    ctx.addLine({
      type: "system",
      content: `[Cloudflare Tunnel] Quick tunnel (port ${effectivePort}) and WebSocket watch daemon stopped successfully.`,
      timestamp: Date.now(),
    });
    return;
  }

  // /muse tunnel status
  if (rawAction === "status") {
    const rawArgs = parts.slice(1).filter((p) => p.toLowerCase() !== rawAction && p.toLowerCase() !== "tunnel" && p.toLowerCase() !== "cloudflare");
    const portArgIdx = rawArgs.findIndex((a) => a === "--port" || a === "-p");
    let portOverride: number | undefined;
    if (portArgIdx !== -1 && rawArgs[portArgIdx + 1]) {
      const parsed = parseInt(rawArgs[portArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0) portOverride = parsed;
    }

    const effectivePort = portOverride || (isHttps ? 7888 : port);
    let existing = getTunnelStatus(effectivePort);
    if (!existing.isRunning && !portOverride && !isHttps) {
      const active = listActiveTunnels();
      if (active.length > 0) {
        existing = { isRunning: true, ...active[0] };
      }
    }

    if (isHttps) {
      const { getServerAuthToken } = await import("../utils/serverSecurity.js");
      const serverToken = getServerAuthToken(effectivePort);
      if (existing.isRunning) {
        ctx.addLine({
          type: "system",
          content: [
            `Cloudflare HTTPS Tunnel Status (port ${effectivePort}): ACTIVE`,
            `- Public HTTPS URL : ${existing.publicUrl}`,
            `- Local Target     : ${existing.localUrl || `http://${host}:${effectivePort}`}`,
            `- Server Port      : ${effectivePort}`,
            `- Process PID      : ${existing.pid}`,
            `- Uptime           : ${existing.uptimeSeconds}s`,
            `- Bearer Token     : ${serverToken}`,
            "",
            `Test: curl -H "Authorization: Bearer ${serverToken}" ${existing.publicUrl}/api/status`,
            "",
            `To stop it, run: /muse tunnel stop --https${portOverride ? ` --port ${portOverride}` : ""}`,
          ].join("\n"),
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "system",
          content: `Cloudflare HTTPS Tunnel Status (port ${effectivePort}): INACTIVE\nRun '/muse tunnel start --https' to launch.`,
          timestamp: now,
        });
      }
      return;
    }

    const reportPort = portOverride || existing.port;
    const titlePrefix = reportPort
      ? `Cloudflare Quick Tunnel Status (port ${reportPort}):`
      : "Cloudflare Quick Tunnel Status:";

    if (existing.isRunning) {
      ctx.addLine({
        type: "system",
        content: [
          `${titlePrefix} ACTIVE`,
          `- Public URL   : ${existing.publicUrl}`,
          `- WSS Endpoint : ${existing.wssUrl}`,
          `- Local Target : ${existing.localUrl}`,
          `- Process PID  : ${existing.pid}`,
          `- Uptime       : ${existing.uptimeSeconds}s`,
          `- Bearer Token : ${token ? maskSecret(token) : "(none)"}`,
          "",
          `To stop it, run: /muse tunnel stop${portOverride ? ` --port ${portOverride}` : ""}`,
        ].join("\n"),
        timestamp: now,
      });
    } else {
      ctx.addLine({
        type: "system",
        content: `${titlePrefix} INACTIVE\nRun '/muse tunnel start${portOverride ? ` --port ${portOverride}` : ""}' to launch a quick development tunnel.`,
        timestamp: now,
      });
    }
    return;
  }

  // Fallback: Guide & Subcommands overview
  const currentStatus = getTunnelStatus();
  const statusPrefix = currentStatus.isRunning
    ? `[Cloudflare Tunnel] Quick tunnel is ACTIVE (PID: ${currentStatus.pid}, URL: ${currentStatus.publicUrl})\n\n`
    : "";

  const guide = [
    "═════════════════════════════════════════════════════════════════════════════",
    "  Cloudflare Tunnel Setup & Ephemeral Subcommands for Muse",
    "═════════════════════════════════════════════════════════════════════════════",
    "",
    "Subcommands:",
    "  /muse tunnel list            - List all currently active Cloudflare tunnels",
    "  /muse tunnel start           - Start quick ephemeral tunnel in background (optional: --port <n>)",
    "  /muse tunnel start --https   - Start Cloudflare HTTPS tunnel for Superagent REST/SSE server (port 7888)",
    "  /muse tunnel stop            - Stop running quick tunnel (optional: --port <n> or all)",
    "  /muse tunnel stop --https    - Stop Cloudflare HTTPS tunnel (port 7888)",
    "  /muse tunnel restart         - Restart active Cloudflare Tunnel and watch daemon",
    "  /muse tunnel status          - Check current tunnel status (optional: --port <n>)",
    "  /muse tunnel status --https  - Check Cloudflare HTTPS tunnel status (port 7888)",
    "  /muse tunnel prompt          - View and copy connection prompt for Muse without starting",
    "  /muse tunnel guide           - View full manual Cloudflare setup guide",
    "  /tunnel start [--https]      - Shortcut: start quick tunnel with optional --https",
    "",
    "1. Prerequisites:",
    "   Install cloudflared: winget install Cloudflare.cloudflared (or brew install cloudflared)",
    "",
    "2. Quick Ephemeral Tunnel (Development):",
    `   cloudflared tunnel --url http://${host}:${port}`,
    `   Connect Muse over WSS to: wss://<subdomain>.trycloudflare.com${pathEndpoint}`,
    "",
    "3. Production Ingress config (~/.cloudflared/config.yml):",
    "   ingress:",
    "     - hostname: muse.yourdomain.com",
    `       service: ws://${host}:${port}`,
    "     - service: http_status:404",
    "",
    "4. Edge Security (Zero Trust Access):",
    "   Set Service Token in Superagent:",
    "   /muse config cfAccessClientId <CLIENT_ID>",
    "   /muse config cfAccessClientSecret <CLIENT_SECRET>",
    "",
    "5. Multi-Project & Multi-Tunnel Isolation:",
    "   - Run multiple tunnels on separate ports concurrently:",
    "     Terminal 1 (Project A): /muse tunnel start",
    "     Terminal 2 (Project B): /muse tunnel start --port 9226",
    "   - Or watch multiple projects under a single tunnel:",
    "     /muse watch <dir1> <dir2> --tunnel",
    "",
    "6. Authentication Token:",
    `   Authorization: Bearer ${token}`,
    "",
    "7. Start Daemon with Tunnel:",
    "   /muse watch --tunnel",
    "═════════════════════════════════════════════════════════════════════════════",
  ];

  ctx.addLine({ type: "system", content: statusPrefix + guide.join("\n"), timestamp: now });
}
