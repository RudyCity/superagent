import type { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";

function emit(ctx: SlashCommandContext, type: "system" | "error", content: string): void {
  ctx.addLine({ type, content, timestamp: Date.now() });
}

function serverStatusLabel(status?: string, error?: string): string {
  if (status === "connected") return "CONNECTED";
  if (status === "connecting") return error?.includes("waiting for the local callback") ? "WAITING FOR OAUTH" : "CONNECTING";
  if (status === "error") return "ERROR";
  if (status === "disconnected") return "DISCONNECTED";
  return "IDLE / NOT CONNECTED";
}

export const statusCommand: SlashCommand = {
  name: "status",
  description: "Show aggregated status for Telegram, MCP servers, and all SuperAgent tunnels",
  async execute(args, ctx) {
    if (args.trim().toLowerCase() === "processes") {
      try {
        const { formatProcessStatus } = await import("./processStatusViews.js");
        emit(ctx, "system", await formatProcessStatus(ctx.agent?.workingDirectory ?? process.cwd()));
      } catch {
        emit(ctx, "error", "Process diagnostics unavailable; ownership remains unverified.");
      }
      return;
    }
    if (args.trim().toLowerCase() !== "all") {
      emit(ctx, "system", [
        "Usage: /status all",
        "Shows Telegram/API, Telegram fallback, configured MCP servers, MCP tunnel, REST/SSE tunnel, and Muse WebSocket tunnel status.",
      ].join("\n"));
      return;
    }

    const lines = [
      "SUPERAGENT — ALL SERVICE STATUS",
      `Checked at: ${new Date().toLocaleString()}`,
      "Read-only check; no services were started, stopped, or restarted.",
      "",
    ];

    // Telegram: the Bot API is remote, so status probes reachability; stop-all can only stop local watchers.
    try {
      const { loadRemoteAgentConfig } = await import("../remoteAgent/config.js");
      const cfg = loadRemoteAgentConfig();
      const { MuseClient } = await import("../remoteAgent/museClient.js");
      const { isMuseWatcherActive, TELEGRAM_FALLBACK_KEY } = await import("../remoteAgent/museWatcher.js");
      lines.push("TELEGRAM");
      lines.push(`- Bot token: ${cfg.botToken ? "CONFIGURED" : "MISSING"}`);
      lines.push(`- Group ID: ${cfg.groupId ? "CONFIGURED" : "MISSING"}`);
      lines.push(`- Muse bot ID: ${cfg.museBotId ? "CONFIGURED" : "MISSING"}`);
      if (cfg.botToken) {
        try {
          const me = await new MuseClient(cfg).getMeInfo();
          lines.push(`- Bot API: ${me.ok ? `ONLINE (${me.username ? "@" + me.username : me.firstName || "bot"})` : "ERROR (API rejected the request)"}`);
        } catch {
          lines.push("- Bot API: UNREACHABLE / ERROR");
        }
      } else {
        lines.push("- Bot API: NOT CHECKED (token missing)");
      }
      lines.push(`- Telegram fallback watcher: ${isMuseWatcherActive(TELEGRAM_FALLBACK_KEY) ? "ACTIVE" : "INACTIVE"}`);
    } catch {
      lines.push("TELEGRAM", "- Status check: ERROR (could not inspect Telegram configuration)");
    }
    lines.push("");

    // Configured MCP client servers are distinct from the MCP public tunnel.
    try {
      const { loadModelConfig } = await import("../config/jsonConfig.js");
      const { connectedServers } = await import("../mcp/McpManager.js");
      const config = loadModelConfig();
      const configured = Object.entries(config.mcpServers || {});
      lines.push(`MCP CLIENT SERVERS (${configured.length} configured)`);
      if (configured.length === 0) {
        lines.push("- No MCP client servers configured.");
      } else {
        for (const [name] of configured) {
          const connected = connectedServers.get(name.toLowerCase());
          lines.push(`- ${name}: ${serverStatusLabel(connected?.status, connected?.error)}`);
          if (connected?.status === "error" && connected.error) lines.push(`  Details: ${connected.error.slice(0, 180)}`);
        }
      }
      const extraConnected = [...connectedServers.keys()].filter((name) => !configured.some(([configuredName]) => configuredName.toLowerCase() === name.toLowerCase()));
      for (const name of extraConnected) {
        const connected = connectedServers.get(name);
        lines.push(`- ${name} (runtime only): ${serverStatusLabel(connected?.status, connected?.error)}`);
      }
    } catch {
      lines.push("MCP CLIENT SERVERS", "- Status check: ERROR");
    }
    lines.push("");

    let activeMcp: Array<any> = [];
    try {
      const { listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
      activeMcp = listActiveMcpServers();
      lines.push(`MCP TUNNEL (${activeMcp.length} active)`);
      if (activeMcp.length === 0) {
        lines.push("- INACTIVE");
      } else {
        for (const server of activeMcp) {
          const provider = server.tunnelProvider === "openai" ? "OpenAI Secure MCP Tunnel" : "Cloudflare Quick Tunnel";
          const owner = server.pid === process.pid ? "this process" : `PID ${server.pid}`;
          lines.push(`- Port ${server.port}: ACTIVE — ${provider}; owner ${owner}; auth ${server.authMode || "unknown"}`);
          if (server.openAiTunnelId) lines.push(`  Tunnel ID: ${server.openAiTunnelId}`);
          if (server.publicUrl) lines.push(`  Endpoint: ${server.publicUrl}`);
        }
      }
    } catch {
      lines.push("MCP TUNNEL", "- Status check: ERROR");
    }
    lines.push("");

    try {
      const { listActiveTunnels } = await import("../remoteAgent/cloudflareTunnel.js");
      const tunnels = listActiveTunnels();
      const muse = tunnels.filter((tunnel) => tunnel.serviceKind === "muse-websocket");
      const restSse = tunnels.filter((tunnel) => tunnel.serviceKind === "superagent-http");
      const mcpHttp = tunnels.filter((tunnel) => tunnel.serviceKind === "mcp-http");
      const unknown = tunnels.filter((tunnel) => !tunnel.serviceKind || tunnel.serviceKind === "unknown");

      lines.push(`REST/SSE PUBLIC TUNNEL (${restSse.length} active)`);
      if (restSse.length === 0) lines.push("- INACTIVE");
      for (const tunnel of restSse) lines.push(`- Port ${tunnel.port}: ACTIVE — ${tunnel.publicUrl} (PID ${tunnel.pid})`);
      lines.push("");

      const { isMuseWatcherActive } = await import("../remoteAgent/museWatcher.js");
      lines.push(`MUSE WEBSOCKET TUNNEL (${muse.length} active)`);
      lines.push(`- Primary Muse watcher: ${isMuseWatcherActive() ? "ACTIVE" : "INACTIVE"}`);
      if (muse.length === 0) lines.push("- INACTIVE");
      for (const tunnel of muse) lines.push(`- Port ${tunnel.port}: ACTIVE — ${tunnel.wssUrl || tunnel.publicUrl} (PID ${tunnel.pid})`);
      lines.push("");

      lines.push(`CLOUDFLARE MCP TUNNEL METADATA (${mcpHttp.length} active)`);
      if (mcpHttp.length === 0) lines.push("- INACTIVE");
      for (const tunnel of mcpHttp) lines.push(`- Port ${tunnel.port}: ACTIVE — ${tunnel.publicUrl} (PID ${tunnel.pid})`);

      if (unknown.length > 0) {
        lines.push("", `UNCLASSIFIED TUNNELS (${unknown.length})`);
        for (const tunnel of unknown) lines.push(`- Port ${tunnel.port}: UNKNOWN SERVICE KIND — ${tunnel.publicUrl}`);
      }

      lines.push(
        "",
        "COMMANDS",
        "- Stop managed services and tunnels: /stop all",
        "- Check one domain: /telegram doctor, /mcp tunnel doctor, /server tunnel doctor, /muse doctor",
      );
    } catch {
      lines.push("TUNNELS", "- Status check: ERROR (could not inspect tunnel registry)");
    }

    // Shared classifier does not own MCP or tunnel lifecycle.
    try {
      const {sharedSenopatiStatus}=await import("../senopatiSharedClient.js");
      const {readSenopatiWatchdogStatus}=await import("../senopatiWatchdogStatus.js");
      const model=await sharedSenopatiStatus();
      const owner=readSenopatiWatchdogStatus();
      lines.push(
        "SENOPATI LOCAL INFERENCE",
        "- Shared model: "+(model ? "ONLINE PID "+model.pid+" ("+model.rssMiB+" MiB)":"OFFLINE / legacy fallback"),
        "- Watchdog: "+(owner?.alive ? "ACTIVE PID "+owner.pid:"OFFLINE"),
        "- Classifier does not grant tool or tenant permissions",
        "",
      );
    }catch {
      lines.push("SENOPATI LOCAL INFERENCE","- Status unavailable","");
    }
    emit(ctx, "system", lines.join("\n"));
  },
};

export async function stopAllManagedServices(ctx: SlashCommandContext): Promise<void> {
  const outcomes: string[] = ["SUPERAGENT — STOP ALL", "Stopping SuperAgent-managed service connections, watchers, and tunnel exposures.", "Telegram's remote Bot API itself cannot be stopped from this app.", ""];

  // Disconnect configured MCP client servers. Configurations and credentials remain intact.
  try {
    const { closeMcpServers } = await import("../mcp/McpManager.js");
    await closeMcpServers();
    outcomes.push("MCP client servers: disconnected; saved configurations preserved.");
  } catch (error) {
    outcomes.push(`MCP client servers: ERROR — ${error instanceof Error ? error.message : String(error)}`);
  }

  // Stop locally-owned MCP tunnel servers; never signal a different SuperAgent process.
  const handledMcpPorts = new Set<number>();
  try {
    const { listActiveMcpServers, stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
    const { readManagedMcpTunnelLease, stopManagedMcpTunnelOwner } = await import("../runtime/mcpManagedTunnelOwner.js");
    const mcpServers = listActiveMcpServers();
    for (const server of mcpServers) {
      handledMcpPorts.add(server.port);
      if (server.pid !== process.pid) {
        let lease = null;
        try { lease = readManagedMcpTunnelLease(server.port); } catch {}
        if (lease && lease.pid === server.pid) {
          try {
            const stopped = await stopManagedMcpTunnelOwner(server.port, { force: true });
            if (stopped.stopped) {
              outcomes.push(`MCP tunnel port ${server.port}: STOPPED (managed owner PID ${server.pid}).`);
            } else {
              outcomes.push(`MCP tunnel port ${server.port}: DRAINING (PID ${server.pid}; ${stopped.activeSessions} session(s) remain).`);
            }
          } catch (error) {
            outcomes.push(`MCP tunnel port ${server.port}: ERROR — ${error instanceof Error ? error.message : String(error)}`);
          }
          continue;
        }
        outcomes.push(`MCP tunnel port ${server.port}: SKIPPED (owned by PID ${server.pid}; stop it from that instance).`);
        continue;
      }
      try {
        await stopMcpTunnel(server.port);
        outcomes.push(`MCP tunnel port ${server.port}: STOPPED.`);
      } catch (error) {
        outcomes.push(`MCP tunnel port ${server.port}: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (mcpServers.length === 0) outcomes.push("MCP tunnel: no active MCP tunnel servers found.");
  } catch (error) {
    outcomes.push(`MCP tunnel: ERROR — ${error instanceof Error ? error.message : String(error)}`);
  }

  // Snapshot tunnel metadata and shut down only services explicitly tagged as SuperAgent-owned.
  try {
    const { listActiveTunnels, stopQuickTunnel } = await import("../remoteAgent/cloudflareTunnel.js");
    const { stopOwnedMuseTunnel } = await import("../remoteAgent/museWatcherTunnel.js");
    const tunnels = listActiveTunnels();

    const museTunnels = tunnels.filter((tunnel) => tunnel.serviceKind === "muse-websocket");
    for (const tunnel of museTunnels) {
      try {
        const stopped = await stopOwnedMuseTunnel(tunnel.port);
        outcomes.push(`Muse WebSocket tunnel port ${tunnel.port}: ${stopped ? "STOPPED" : "already inactive or ownership not verified"}.`);
      } catch (error) {
        outcomes.push(`Muse WebSocket tunnel port ${tunnel.port}: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (museTunnels.length === 0) outcomes.push("Muse WebSocket tunnel: no active tunnel found.");

    // Stop any remaining Cloudflare MCP tunnels after the MCP server has been closed.
    const mcpTunnels = tunnels.filter((tunnel) => tunnel.serviceKind === "mcp-http");
    for (const tunnel of mcpTunnels) {
      if (handledMcpPorts.has(tunnel.port)) {
        const server = (await import("../mcp/mcpTunnel.js")).listActiveMcpServers().find((entry) => entry.port === tunnel.port);
        if (server && server.pid !== process.pid) {
          let lease = null;
          try { lease = (await import("../runtime/mcpManagedTunnelOwner.js")).readManagedMcpTunnelLease(tunnel.port); } catch {}
          if (!lease) continue;
        }
      }
      try {
        const stopped = await stopQuickTunnel(tunnel.port, "mcp-http");
        outcomes.push(`Cloudflare MCP tunnel port ${tunnel.port}: ${stopped ? "STOPPED" : "already inactive or ownership not verified"}.`);
      } catch (error) {
        outcomes.push(`Cloudflare MCP tunnel port ${tunnel.port}: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const restSseTunnels = tunnels.filter((tunnel) => tunnel.serviceKind === "superagent-http");
    for (const tunnel of restSseTunnels) {
      try {
        const stopped = await stopQuickTunnel(tunnel.port, "superagent-http");
        outcomes.push(`REST/SSE tunnel port ${tunnel.port}: ${stopped ? "STOPPED" : "already inactive or ownership not verified"}.`);
      } catch (error) {
        outcomes.push(`REST/SSE tunnel port ${tunnel.port}: ERROR — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (restSseTunnels.length === 0) outcomes.push("REST/SSE tunnel: no active tunnel found.");

    const unknown = tunnels.filter((tunnel) => !tunnel.serviceKind || tunnel.serviceKind === "unknown");
    if (unknown.length > 0) {
      outcomes.push(`Unclassified tunnels: left untouched (${unknown.map((tunnel) => `port ${tunnel.port}`).join(", ")}); ownership cannot be verified.`);
    }
  } catch (error) {
    outcomes.push(`Tunnel shutdown: ERROR — ${error instanceof Error ? error.message : String(error)}`);
  }

  // Stop all local watchers, including a Telegram fallback watcher that has no tunnel.
  try {
    const { stopAllMuseWatchers } = await import("../remoteAgent/museWatcher.js");
    const count = await stopAllMuseWatchers();
    outcomes.push(`Local Muse/Telegram fallback watchers: stopped ${count}.`);
  } catch (error) {
    outcomes.push(`Local Muse/Telegram fallback watchers: ERROR — ${error instanceof Error ? error.message : String(error)}`);
  }

  outcomes.push("", "Saved Telegram/MCP configuration was not deleted. Use /status all to verify the remaining state.");
  emit(ctx, "system", outcomes.join("\n"));
}

registry.register(statusCommand);
