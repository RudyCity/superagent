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
  const isTgFallback = parts
    .slice(1)
    .some((p) => {
      const flag = p.toLowerCase();
      return flag === "--tg-fallback" || flag === "--telegram-fallback";
    });
  const nonFlagParts = parts.slice(1).filter((p) => !p.startsWith("-"));
  const rawAction = (nonFlagParts[0] || (isHttps ? "start" : "")).toLowerCase();
  const cfg = loadRemoteAgentConfig();
  const host = cfg.wsHost || "127.0.0.1";
  const port = cfg.wsPort || 9225;
  const pathEndpoint = cfg.wsPath || "/muse";
  let token = cfg.wsToken;
  const mcpOnlyRequested = parts.some((p) => p.toLowerCase() === "--mcp");
  const needsMuseToken = ["start", "quick", "run", "prompt", "url", "link"].includes(rawAction);

  // Read-only/status/stop commands and MCP-only mode must not mutate Muse configuration.
  if (!token && !isHttps && !mcpOnlyRequested && needsMuseToken) {
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
    clearWsRemoteUrl,
    formatActiveTunnels,
    buildMuseConnectionPrompt,
    copyTextToClipboard,
  } = await import("../remoteAgent/cloudflareTunnel.js");
  const {
    startMuseWatcher,
    stopMuseWatcher,
    isMuseWatcherActive,
    TELEGRAM_FALLBACK_KEY,
  } = await import("../remoteAgent/museWatcher.js");
  const { stopOwnedMuseTunnel } = await import("../remoteAgent/museWatcherTunnel.js");

  // Optional Telegram fallback watcher: when --tg-fallback is passed, keep a
  // Telegram-transport watcher active alongside the tunnel so Muse stays
  // reachable if the tunnel drops.
  const startTelegramFallback = async (workspaces: string[]) => {
    if (!isTgFallback) return;
    if (isMuseWatcherActive(TELEGRAM_FALLBACK_KEY)) return;
    try {
      await startMuseWatcher({
        workspace: workspaces[0] || ctx.agent?.workingDirectory || process.cwd(),
        workspaces,
        transportType: "telegram",
        fallback: true,
        tunnel: false,
        isHttps: false,
        wsPort: undefined,
        agent: ctx.agent,
        onProgress: (msg: string) => {
          ctx.addLine({
            type: "system",
            content: `[Muse Progress] ${msg}`,
            timestamp: Date.now(),
          });
        },
        onLine: (line: { type: string; content: string; timestamp?: number }) => {
          ctx.addLine({
            type: (line.type as any) || "system",
            content: line.content,
            timestamp: line.timestamp || Date.now(),
          });
        },
      });
      ctx.addLine({
        type: "system",
        content:
          "[Muse Watch] Telegram fallback transport is ACTIVE \u2014 Muse stays reachable via Telegram if the tunnel drops.",
        timestamp: Date.now(),
      });
    } catch (fallbackErr: any) {
      ctx.addLine({
        type: "error",
        content: `[Muse Watch] Telegram fallback failed to start: ${fallbackErr.message}`,
        timestamp: Date.now(),
      });
    }
  };

  // /muse tunnel list: WSS tunnels + cross-workspace MCP servers
  if (rawAction === "list" || rawAction === "ls" || rawAction === "active") {
    const tunnels = listActiveTunnels();
    const { listActiveMcpServers, formatActiveMcpServers } = await import("../mcp/mcpTunnel.js");
    ctx.addLine({
      type: "system",
      content: `${formatActiveTunnels(tunnels)}\n\n${formatActiveMcpServers(listActiveMcpServers())}`,
      timestamp: now,
    });
    return;
  }

  // /muse tunnel restart
  if (rawAction === "restart") {
    const rawArgs = parts.slice(1).filter((p) => p.toLowerCase() !== rawAction && p.toLowerCase() !== "tunnel" && p.toLowerCase() !== "cloudflare");
    const mcpPortArgIdx = rawArgs.findIndex((a) => a.toLowerCase() === "--mcp-port");
    const wantsMcpRestart = rawArgs.some((a) => a.toLowerCase() === "--mcp") || mcpPortArgIdx !== -1;
    if (wantsMcpRestart) {
      let mcpPort = 9227;
      if (mcpPortArgIdx !== -1 && rawArgs[mcpPortArgIdx + 1]) {
        const parsed = parseInt(rawArgs[mcpPortArgIdx + 1], 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
          ctx.addLine({ type: "error", content: "Invalid --mcp-port value.", timestamp: now });
          return;
        }
        mcpPort = parsed;
      }
      const { stopMcpTunnel, listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
      const target = listActiveMcpServers().find((m) => m.port === mcpPort);
      if (target && target.pid !== process.pid) {
        ctx.addLine({ type: "error", content: `MCP server on port ${mcpPort} is owned by PID ${target.pid}; stop it from its owning instance before restarting.`, timestamp: now });
        return;
      }
      if (target) await stopMcpTunnel(mcpPort);
      const restartParts = parts.filter((p) => p.toLowerCase() !== "restart");
      restartParts.splice(1, 0, "start");
      return handleMuseTunnelSubcommand(restartParts, ctx, Date.now());
    }
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
    const wantMcpPrompt = rawArgs.some((a) => a.toLowerCase() === "--mcp");
    const mcpPortArgIdx = rawArgs.findIndex((a) => a.toLowerCase() === "--mcp-port");
    const mcpPromptRequested = wantMcpPrompt || mcpPortArgIdx !== -1;
    let mcpPromptPort = 9227;
    if (mcpPortArgIdx !== -1 && rawArgs[mcpPortArgIdx + 1]) {
      const parsed = parseInt(rawArgs[mcpPortArgIdx + 1], 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
        ctx.addLine({ type: "error", content: "Invalid --mcp-port value.", timestamp: now });
        return;
      }
      mcpPromptPort = parsed;
    }
    const { listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
    const mcpServers = listActiveMcpServers();
    const activeMcp = mcpPromptRequested ? mcpServers.find((m) => m.port === mcpPromptPort) : undefined;

    if (activeMcp) {
      const configJson = JSON.stringify({
        superagent: {
          url: activeMcp.publicUrl,
        },
      }, null, 2);
      const copied = await copyTextToClipboard(configJson);
      ctx.addLine({
        type: "system",
        content: [
          `MCP Server via Tunnel (port ${activeMcp.port}):`,
          `- Public Endpoint : ${activeMcp.publicUrl}`,
          `- Tool Mode      : ${activeMcp.toolMode === "dangerous" ? "FULL (37 tools)" : "SAFE (read-only)"}`,
          `- Auth Mode      : ${activeMcp.authMode || "static-bearer"}`,
          "",
          copied ? "MCP client config (copied to clipboard):" : "MCP client config:",
          configJson,
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

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

    // MCP via tunnel flags: /muse tunnel start --mcp [--mcp-port <n>] [--allow-dangerous]
    const wantMcp = rawArgs.some((a) => a.toLowerCase() === "--mcp");
    const mcpPortArgIdx = rawArgs.findIndex((a) => a.toLowerCase() === "--mcp-port");
    let mcpPort = 9227;
    if (mcpPortArgIdx !== -1 && rawArgs[mcpPortArgIdx + 1]) {
      const parsed = parseInt(rawArgs[mcpPortArgIdx + 1], 10);
      if (!isNaN(parsed) && parsed > 0 && parsed < 65536) mcpPort = parsed;
    }
    const { getYoloModeState } = await import("../permissions.js");
    const allowDangerous = rawArgs.some((a) => a.toLowerCase() === "--allow-dangerous") || (getYoloModeState() !== "off");
    const mcpAuthArgIdx = rawArgs.findIndex((a) => a.toLowerCase() === "--mcp-auth");
    let mcpAuthMode: "static-bearer" | "oauth" = "static-bearer";
    if (mcpAuthArgIdx !== -1 && rawArgs[mcpAuthArgIdx + 1]) {
      const v = rawArgs[mcpAuthArgIdx + 1].toLowerCase();
      if (v === "oauth" || v === "static-bearer") {
        mcpAuthMode = v;
      } else {
        ctx.addLine({
          type: "error",
          content: `[MCP Tunnel] Invalid --mcp-auth value "${rawArgs[mcpAuthArgIdx + 1]}". Use static-bearer or oauth.`,
          timestamp: Date.now(),
        });
        return;
      }
    }

    // --- MCP-only mode: /muse tunnel start --mcp (WSS tunnel NOT started) ---
    if (wantMcp) {
      const { startMcpTunnel, listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
      if (listActiveMcpServers().some((m) => m.port === mcpPort)) {
        ctx.addLine({
          type: "system",
          content: `[MCP Tunnel] MCP server is ALREADY ACTIVE on port ${mcpPort}.`,
          timestamp: Date.now(),
        });
        return;
      }
      if (allowDangerous && mcpAuthMode === "static-bearer") {
        ctx.addLine({
          type: "system",
          content: [
            "!! WARNING: --allow-dangerous in static-bearer mode exposes destructive tools",
            "!! (command execution, file writes, agent control) to anyone holding the bearer token.",
            "!! For ChatGPT write access, prefer --mcp-auth oauth instead.",
          ].join("\n"),
          timestamp: Date.now(),
        });
      }
      try {
        const mcpInfo = await startMcpTunnel({ port: mcpPort, allowDangerous, authMode: mcpAuthMode });
        ctx.addLine({
          type: "system",
          content: (() => {
            const toolModeLine = `- Tool mode    : ${mcpInfo.dangerous ? `FULL (${mcpInfo.toolCount} tools)` : `SAFE (${mcpInfo.toolCount} read-only)`}`;
            if (mcpInfo.authMode === "oauth") {
              return [
                "-------------------------------------------------------------",
                "  MCP via Tunnel Online! (OAuth mode)",
                "-------------------------------------------------------------",
                `- MCP Endpoint : ${mcpInfo.publicUrl}`,
                `- Local        : ${mcpInfo.localUrl}`,
                "- Auth mode    : oauth (OAuth 2.1 + PKCE)",
                `- Discovery    : ${mcpInfo.oauthDiscoveryUrl}`,
                `- Scopes       : mcp:tools${mcpInfo.dangerous ? " mcp:tools:write" : ""}`,
                toolModeLine,
                `- Audit log    : ${mcpInfo.auditLogPath}`,
                "",
                "One-time bootstrap approval code (shown ONCE, never stored):",
                `- ${mcpInfo.bootstrapCode}`,
                "",
                "ChatGPT setup:",
                "1. In ChatGPT, add an MCP server with the MCP Endpoint URL above.",
                "2. In Advanced OAuth settings, enter any OAuth client ID (e.g. chatgpt) and leave secret blank.",
                "3. Complete the OAuth authorization in your browser using the bootstrap code.",
                "4. Approve scopes; safe tools are callable after approval.",
                "",
                "Flags: --mcp-auth oauth | --allow-dangerous (needs mcp:tools:write) | --mcp-port <n>",
                "Stop: /muse tunnel stop",
                "",
                "!! URL is public - OAuth authorization is the ONLY access control.",
                "!! Bootstrap code is shown once. Rotate: /muse tunnel restart --mcp",
              ].join("\n");
            }
            return [
              "-------------------------------------------------------------",
              "  MCP via Tunnel Online!",
              "-------------------------------------------------------------",
              `- MCP Endpoint : ${mcpInfo.publicUrl}`,
              `- Local        : ${mcpInfo.localUrl}`,
              `- Bearer token : ${mcpInfo.bearerToken}`,
              toolModeLine,
              `- Audit log    : ${mcpInfo.auditLogPath}`,
              "",
              "MCP client config (copy-paste):",
              `{ "superagent": { "url": "${mcpInfo.publicUrl}", "headers": { "Authorization": "Bearer token ${mcpInfo.bearerToken}" } } }`,
              "",
              "Flags: --mcp-auth oauth (ChatGPT) | --allow-dangerous (destructive tools) | --mcp-port <n> (multi-project)",
              "Stop: /muse tunnel stop",
              "",
              "!! URL is public - Bearer token is the ONLY access control.",
              "!! Bearer token shown once, never stored. Rotate: /muse tunnel restart --mcp",
            ].join("\n");
          })(),
          timestamp: Date.now(),
        });
      } catch (mcpErr: any) {
        ctx.addLine({
          type: "error",
          content: `[MCP Tunnel] Failed: ${mcpErr?.message || String(mcpErr)}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    const initialTask = rawArgs
      .filter((a, idx, arr) => {
        if (a === "--port" || a === "-p" || a === "--https" || a === "--http" || a === "--web") return false;
        if (a === "--mcp" || a === "--mcp-port" || a === "--allow-dangerous" || a === "--mcp-auth") return false;
        if (idx > 0 && (arr[idx - 1] === "--port" || arr[idx - 1] === "-p" || arr[idx - 1] === "--mcp-port" || arr[idx - 1] === "--mcp-auth")) return false;
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
            `To stop the tunnel, run: /muse tunnel stop --https${portOverride ? ` --port ${portOverride}` : ""}`,
          ].join("\n"),
          timestamp: now,
        });
        await startTelegramFallback(watchedWorkspaces);
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

      await startTelegramFallback(watchedWorkspaces);

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
      const { stopAllMuseWatchers } = await import("../remoteAgent/museWatcher.js");
      const museTunnelUrls = listActiveTunnels()
        .filter((t) => t.serviceKind === "muse-websocket" && t.wssUrl)
        .map((t) => t.wssUrl!);
      const watcherCount = await stopAllMuseWatchers();
      const count = await stopAllQuickTunnels();
      for (const wssUrl of museTunnelUrls) clearWsRemoteUrl(wssUrl);
      const { stopAllMcpServers } = await import("../mcp/mcpTunnel.js");
      await stopAllMcpServers();
      ctx.addLine({
        type: "system",
        content: `[Cloudflare Tunnel] Stopped ${count} quick tunnel${count === 1 ? "" : "s"} and ${watcherCount} watch daemon${watcherCount === 1 ? "" : "s"} across all workspaces.`,
        timestamp: Date.now(),
      });
      return;
    }

    const wantMcpStop = rawArgs.some((a) => a.toLowerCase() === "--mcp");
    const mcpPortStopIdx = rawArgs.findIndex((a) => a.toLowerCase() === "--mcp-port");
    if (wantMcpStop || mcpPortStopIdx !== -1) {
      let mcpPortStop = 9227;
      if (mcpPortStopIdx !== -1 && rawArgs[mcpPortStopIdx + 1]) {
        const parsed = parseInt(rawArgs[mcpPortStopIdx + 1], 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
          ctx.addLine({ type: "error", content: "Invalid --mcp-port value.", timestamp: now });
          return;
        }
        mcpPortStop = parsed;
      }
      const { stopMcpTunnel, listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
      const mcpTarget = listActiveMcpServers().find((m) => m.port === mcpPortStop);
      if (!mcpTarget) {
        ctx.addLine({ type: "system", content: `No MCP server is currently active on port ${mcpPortStop}.`, timestamp: now });
      } else if (mcpTarget.pid !== process.pid) {
        ctx.addLine({
          type: "system",
          content: `MCP server on port ${mcpPortStop} is owned by another instance (PID ${mcpTarget.pid}, workspace ${mcpTarget.workspace || "unknown"}) and cannot be stopped from here.`,
          timestamp: now,
        });
      } else {
        await stopMcpTunnel(mcpPortStop);
        ctx.addLine({ type: "system", content: `MCP server (port ${mcpPortStop}) stopped successfully.`, timestamp: Date.now() });
      }
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
    if (isMuseWatcherActive(TELEGRAM_FALLBACK_KEY)) {
      await stopMuseWatcher(TELEGRAM_FALLBACK_KEY);
      stoppedAny = true;
      stoppedParts.push("Telegram fallback watcher");
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

    const wantMcpStatus = rawArgs.some((a) => a.toLowerCase() === "--mcp");
    const mcpPortArgIdx = rawArgs.findIndex((a) => a.toLowerCase() === "--mcp-port");
    const mcpStatusRequested = wantMcpStatus || mcpPortArgIdx !== -1;
    let mcpPortStatus = 9227;
    if (mcpPortArgIdx !== -1 && rawArgs[mcpPortArgIdx + 1]) {
      const parsed = parseInt(rawArgs[mcpPortArgIdx + 1], 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
        ctx.addLine({ type: "error", content: "Invalid --mcp-port value.", timestamp: now });
        return;
      }
      mcpPortStatus = parsed;
    }
    const { listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
    const mcpServers = listActiveMcpServers();
    const activeMcp = mcpStatusRequested ? mcpServers.find((m) => m.port === mcpPortStatus) : undefined;

    if (activeMcp) {
      ctx.addLine({
        type: "system",
        content: [
          `MCP Server via Tunnel Status (port ${activeMcp.port}): ACTIVE`,
          `- Public Endpoint : ${activeMcp.publicUrl}`,
          `- Local Target   : ${activeMcp.localUrl}`,
          `- Tool Mode      : ${activeMcp.toolMode === "dangerous" ? "FULL (37 tools)" : "SAFE (read-only)"}`,
          `- Auth Mode      : ${activeMcp.authMode || "static-bearer"}`,
          `- Process PID    : ${activeMcp.pid}`,
          `- Uptime         : ${activeMcp.uptimeSeconds}s`,
          "",
          `To stop it, run: /muse tunnel stop --mcp-port ${activeMcp.port}`,
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    if (mcpStatusRequested) {
      ctx.addLine({
        type: "system",
        content: `MCP Server via Tunnel Status (port ${effectivePort}): INACTIVE\nRun '/muse tunnel start --mcp' to launch.`,
        timestamp: now,
      });
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
    "  /muse tunnel start --mcp     - Start MCP server via tunnel (Streamable HTTP, port 9227)",
    "  /muse tunnel start --mcp --mcp-auth oauth - Start MCP server via tunnel with OAuth 2.1 + PKCE",
    "  /muse tunnel stop            - Stop running quick tunnel (optional: --port <n> or all)",
    "  /muse tunnel stop --https    - Stop Cloudflare HTTPS tunnel (port 7888)",
    "  /muse tunnel stop --mcp      - Stop active MCP server tunnel (port 9227)",
    "  /muse tunnel restart         - Restart active Cloudflare Tunnel and watch daemon",
    "  /muse tunnel restart --mcp   - Restart active MCP server tunnel (port 9227)",
    "  /muse tunnel status          - Check current tunnel status (optional: --port <n>)",
    "  /muse tunnel status --https  - Check Cloudflare HTTPS tunnel status (port 7888)",
    "  /muse tunnel status --mcp    - Check MCP server tunnel status (port 9227)",
    "  /muse tunnel msg <message>   - Send message to connected Muse via tunnel",
    "  /muse tunnel prompt          - View and copy connection prompt for Muse without starting",
    "  /muse tunnel prompt --mcp    - View MCP server tunnel connection details and client config",
    "  /muse tunnel guide           - View full manual Cloudflare setup guide",
    "  /tunnel start [--https] [--mcp] - Shortcut: start quick tunnel with optional --https or --mcp",
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
