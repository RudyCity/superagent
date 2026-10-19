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
  now: number,
  options: { internalServerHttp?: boolean } = {}
): Promise<void> {
  const isHttps = parts
    .slice(1)
    .some((p) => p.toLowerCase() === "--https" || p.toLowerCase() === "--http" || p.toLowerCase() === "--web");
  const isInternalServerHttp = options.internalServerHttp === true;
  const normalizedArgs = parts.slice(1).map((p) => p.toLowerCase());
  const mcpOnlyFlags = new Set([
    "--mcp", "--mcp-port", "--mcp-auth", "--provider", "--tunnel-id",
    "--api-key", "--control-plane-key", "--profile", "--tunnel-profile",
    "--openai", "--openai-tunnel", "--allow-dangerous",
  ]);
  const wrongDomainFlag = normalizedArgs.find((p) => mcpOnlyFlags.has(p));
  if (wrongDomainFlag) {
    ctx.addLine({
      type: "error",
      content: `MCP option "${wrongDomainFlag}" is not supported under /muse tunnel. Use /mcp tunnel (for example: /mcp tunnel start --provider openai --tunnel-id <id>).`,
      timestamp: now,
    });
    return;
  }
  if (normalizedArgs.includes("--internal-server-http")) {
    ctx.addLine({ type: "error", content: "Internal routing flags cannot be used manually. Use /server tunnel for REST/SSE exposure.", timestamp: now });
    return;
  }
  if (normalizedArgs.some((arg) => arg === "--tg-fallback" || arg === "--telegram-fallback")) {
    ctx.addLine({ type: "error", content: "Telegram fallback is managed independently. Use /telegram fallback start|stop.", timestamp: now });
    return;
  }
  if (isHttps && !isInternalServerHttp) {
    const nonFlagParts = parts.slice(1).filter((p) => !p.startsWith("-"));
    const action = (nonFlagParts[0] || "start").toLowerCase();
    ctx.addLine({
      type: "error",
      content: `SuperAgent REST/SSE exposure is managed separately. Use /server tunnel ${action}${parts.some((p) => /^--port$/i.test(p)) ? " --port <n>" : ""}.`,
      timestamp: now,
    });
    return;
  }
  const nonFlagParts = parts.slice(1).filter((p) => !p.startsWith("-"));
  const rawAction = (nonFlagParts[0] || (isHttps ? "start" : "")).toLowerCase();
  const cfg = loadRemoteAgentConfig();
  const host = cfg.wsHost || "127.0.0.1";
  const port = cfg.wsPort || 9225;
  const pathEndpoint = cfg.wsPath || "/muse";
  let token = cfg.wsToken;
  const needsMuseToken = ["start", "quick", "run", "prompt", "url", "link"].includes(rawAction);

  // Read-only/status/stop commands must not mutate Muse configuration.
  if (!token && !isHttps && needsMuseToken) {
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
    getTunnelStatus,
    listActiveTunnels,
    clearWsRemoteUrl,
    formatActiveTunnels,
    buildMuseConnectionPrompt,
    copyTextToClipboard,
  } = await import("../remoteAgent/cloudflareTunnel.js");
  const {
    startMuseWatcher,
    stopMuseWatcher,
    isMuseWatcherActive,
  } = await import("../remoteAgent/museWatcher.js");
  const { stopOwnedMuseTunnel } = await import("../remoteAgent/museWatcherTunnel.js");

  // /muse tunnel list: Muse WebSocket tunnels only
  if (rawAction === "list" || rawAction === "ls" || rawAction === "active") {
    const tunnels = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
    ctx.addLine({ type: "system", content: formatActiveTunnels(tunnels), timestamp: now });
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
    const existingForRestart = getTunnelStatus(effectivePort);
    const expectedRestartKind = isHttps ? "superagent-http" : "muse-websocket";
    if (existingForRestart.isRunning && existingForRestart.serviceKind !== expectedRestartKind) {
      ctx.addLine({
        type: "error",
        content: `Cannot restart port ${effectivePort}: tunnel kind is ${existingForRestart.serviceKind || "unknown (legacy state)"}, expected ${expectedRestartKind}. Stop/reconcile the owning service first.`,
        timestamp: now,
      });
      return;
    }

    ctx.addLine({
      type: "system",
      content: `[Cloudflare Tunnel] Restarting quick tunnel on port ${effectivePort}...`,
      timestamp: now,
    });

    if (isHttps) {
      const existing = getTunnelStatus(effectivePort);
      if (existing.isRunning && existing.serviceKind === "superagent-http") {
        await stopQuickTunnel(effectivePort, "superagent-http");
      }
    } else {
      if (isMuseWatcherActive(effectivePort)) {
        await stopMuseWatcher(effectivePort);
      }
      const existing = getTunnelStatus(effectivePort);
      if (existing.isRunning && existing.serviceKind === "muse-websocket") {
        await stopOwnedMuseTunnel(effectivePort);
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
    let existing = getTunnelStatus(effectivePort);
    const expectedServiceKind = isHttps ? "superagent-http" : "muse-websocket";
    if (
      existing.isRunning &&
      existing.serviceKind &&
      existing.serviceKind !== "unknown" &&
      existing.serviceKind !== expectedServiceKind
    ) {
      ctx.addLine({ type: "error", content: `Port ${effectivePort} belongs to ${existing.serviceKind}, not ${expectedServiceKind}.`, timestamp: now });
      return;
    }
    if (!existing.isRunning && !portOverride && !isHttps) {
      const active = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
      if (active.length > 0) {
        existing = { isRunning: true, ...active[0] };
      }
    }

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
      .filter((arg, idx, arr) => {
        if (["--port", "-p", "--https", "--http", "--web"].includes(arg)) return false;
        if (idx > 0 && ["--port", "-p"].includes(arr[idx - 1])) return false;
        return true;
      })
      .join(" ")
      .trim();

    const effectivePort = portOverride || (isHttps ? 7888 : port);
    const watchedWorkspaces = getWatchedWorkspaces(cfg, ctx.agent?.workingDirectory);
    let existing = getTunnelStatus(effectivePort);
    const expectedServiceKind = isHttps ? "superagent-http" : "muse-websocket";
    if (
      existing.isRunning &&
      existing.serviceKind &&
      existing.serviceKind !== "unknown" &&
      existing.serviceKind !== expectedServiceKind
    ) {
      ctx.addLine({
        type: "error",
        content: `Port ${effectivePort} already belongs to ${existing.serviceKind}; refusing to treat it as ${expectedServiceKind}. Use another port or stop the owning service explicitly.`,
        timestamp: now,
      });
      return;
    }
    if (!existing.isRunning && !portOverride && !isHttps) {
      const active = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
      if (active.length > 0) {
        existing = { isRunning: true, ...active[0] };
      }
    }
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
            `To stop it, run: /server tunnel stop${portOverride ? ` --port ${portOverride}` : ""}`,
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
      const museTunnels = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
      let watcherCount = 0;
      for (const tunnel of museTunnels) {
        if (isMuseWatcherActive(tunnel.port)) {
          await stopMuseWatcher(tunnel.port);
          watcherCount++;
        }
        if (tunnel.wssUrl) clearWsRemoteUrl(tunnel.wssUrl);
        await stopOwnedMuseTunnel(tunnel.port);
      }
      ctx.addLine({ type: "system", content: "[Muse Tunnel] Stopped " + museTunnels.length + " Muse WebSocket tunnel(s) and " + watcherCount + " associated watcher(s). MCP and Telegram services were not changed.", timestamp: Date.now() });
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
      if (existing.isRunning && existing.serviceKind === "superagent-http") {
        const stopped = await stopQuickTunnel(effectivePort, "superagent-http");
        ctx.addLine({
          type: stopped ? "system" : "error",
          content: stopped
            ? `[Cloudflare HTTPS Tunnel] Quick tunnel (port ${effectivePort}) stopped successfully.`
            : `[Cloudflare HTTPS Tunnel] Tunnel on port ${effectivePort} was not stopped; ownership could not be verified.`,
          timestamp: Date.now(),
        });
      } else if (existing.isRunning) {
        ctx.addLine({
          type: "error",
          content: `[Cloudflare HTTPS Tunnel] Refusing to stop port ${effectivePort}: kind is ${existing.serviceKind || "unknown (legacy state)"}, not superagent-http.`,
          timestamp: now,
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
    const stoppedParts: string[] = [];
    if (isMuseWatcherActive(effectivePort)) {
      await stopMuseWatcher(effectivePort);
      stoppedAny = true;
      stoppedParts.push("WebSocket watch daemon");
    }
    let targetPortToStop = effectivePort;
    let existing = getTunnelStatus(effectivePort);
    if (!existing.isRunning && !portOverride) {
      const active = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
      if (active.length === 1) {
        targetPortToStop = active[0].port;
        existing = getTunnelStatus(targetPortToStop);
      }
    }
    if (existing.isRunning && existing.serviceKind === "muse-websocket") {
      const stopped = await stopOwnedMuseTunnel(targetPortToStop);
      if (stopped) {
        stoppedAny = true;
        stoppedParts.push(`Muse WebSocket tunnel (port ${targetPortToStop})`);
      }
    } else if (existing.isRunning) {
      ctx.addLine({
        type: "error",
        content: `[Cloudflare Tunnel] Refusing to stop port ${targetPortToStop}: kind is ${existing.serviceKind || "unknown (legacy state)"}, not muse-websocket.`,
        timestamp: now,
      });
    }
    if (!stoppedAny) {
      ctx.addLine({
        type: "system",
        content: `[Cloudflare Tunnel] No owned Muse tunnel is currently running${portOverride ? ` on port ${portOverride}` : ""}.`,
        timestamp: now,
      });
      return;
    }
    ctx.addLine({
      type: "system",
      content: `[Cloudflare Tunnel] Stopped successfully: ${stoppedParts.join(", ")}.`,
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
    if (!isHttps && existing.serviceKind !== "muse-websocket") existing = { ...existing, isRunning: false };
    if (!existing.isRunning && !portOverride && !isHttps) {
      const active = listActiveTunnels().filter((t) => t.serviceKind === "muse-websocket");
      if (active.length > 0) existing = { isRunning: true, ...active[0] };
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
            `To stop it, run: /server tunnel stop${portOverride ? ` --port ${portOverride}` : ""}`,
          ].join("\n"),
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "system",
          content: `SuperAgent REST/SSE tunnel (port ${effectivePort}): INACTIVE\nRun '/server tunnel start' to launch.`,
          timestamp: now,
        });
      }
      return;
    }

    const reportPort = portOverride || existing.port;
    const titlePrefix = reportPort
      ? `Muse WebSocket Tunnel Status (port ${reportPort}):`
      : "Muse WebSocket Tunnel Status:";

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

  // /muse tunnel msg <text> — send message to connected Muse via tunnel
  if (rawAction === "msg" || rawAction === "message" || rawAction === "chat") {
    const actionIdx = parts.findIndex((p) => p.toLowerCase() === rawAction);
    const text = parts.slice(actionIdx + 1).join(" ").trim();
    if (!text) {
      ctx.addLine({
        type: "system",
        content: "Usage: /muse tunnel msg <message> — send chat message to connected Muse.",
        timestamp: now,
      });
      return;
    }
    const { sendChatToMuse } = await import("../remoteAgent/museChat.js");
    const res = await sendChatToMuse(text);
    ctx.addLine({
      type: res.ok ? "system" : "error",
      content: `[Muse Chat] ${res.detail}`,
      timestamp: Date.now(),
    });
    return;
  }

  // Muse-only guide & subcommands overview.
  const currentStatusRaw = getTunnelStatus();
  const currentStatus = currentStatusRaw.serviceKind === "muse-websocket"
    ? currentStatusRaw
    : { ...currentStatusRaw, isRunning: false };
  const statusPrefix = currentStatus.isRunning
    ? `[Muse WebSocket Tunnel] ACTIVE (PID: ${currentStatus.pid}, URL: ${currentStatus.publicUrl})\n\n`
    : "";

  const guide = [
    "═════════════════════════════════════════════════════════════════════════════",
    "  Muse WebSocket Tunnel Setup & Subcommands",
    "═════════════════════════════════════════════════════════════════════════════",
    "",
    "Subcommands:",
    "  /muse tunnel list            - List active Muse WebSocket tunnels only",
    "  /muse tunnel start           - Start Muse WebSocket watcher and Cloudflare tunnel",
    "  /muse tunnel start --port <n> - Use a custom WebSocket port",
    "  /muse tunnel stop            - Stop Muse WebSocket tunnel(s) only",
    "  /muse tunnel stop all        - Stop all Muse WebSocket tunnels only",
    "  /muse tunnel restart         - Restart Muse WebSocket tunnel and watcher",
    "  /muse tunnel status          - Check Muse WebSocket tunnel status",
    "  /muse tunnel doctor          - Diagnose Muse WebSocket/Cloudflare prerequisites",
    "  /muse tunnel msg <message>   - Send a chat message to connected Muse",
    "  /muse tunnel prompt          - View/copy the Muse connection prompt",
    "  /muse tunnel guide           - Show this Muse-only setup guide",
    "  /tunnel                     - Deprecated Muse-only alias for /muse tunnel",
    "",
    "1. Prerequisites:",
    "   - Install cloudflared: winget install Cloudflare.cloudflared (or brew install cloudflared)",
    "",
    "2. Quick ephemeral Cloudflare tunnel:",
    `   cloudflared tunnel --url http://${host}:${port}`,
    `   Connect Muse over WSS to: wss://<subdomain>.trycloudflare.com${pathEndpoint}`,
    "",
    "3. Production ingress example (~/.cloudflared/config.yml):",
    "   ingress:",
    "     - hostname: muse.yourdomain.com",
    `       service: ws://${host}:${port}`,
    "     - service: http_status:404",
    "",
    "4. Optional Cloudflare Access Service Token:",
    "   /muse config cfAccessClientId <CLIENT_ID>",
    "   /muse config cfAccessClientSecret <CLIENT_SECRET>",
    "",
    "5. Multiple Muse workspaces:",
    "   - Start on separate ports: /muse tunnel start and /muse tunnel start --port 9226",
    "   - Or watch several projects under one Muse session: /muse watch <dir1> <dir2> --tunnel",
    "",
    "6. Start the Muse watch daemon with a tunnel:",
    "   /muse watch --tunnel",
    "═════════════════════════════════════════════════════════════════════════════",
  ];

  ctx.addLine({ type: "system", content: statusPrefix + guide.join("\n"), timestamp: now });
}
