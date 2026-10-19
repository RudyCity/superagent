import { SlashCommand } from "./types.js";
import { loadModelConfig, saveModelConfig } from "../config/jsonConfig.js";
import { initMcpServers, connectedServers } from "../mcp/McpManager.js";
import { getMcpTunnelProvidersHelp } from "./commandCatalog.js";
import { registry } from "./registry.js";

export const mcpCommand: SlashCommand = {
  name: "mcp",
  description: "Manage MCP (Model Context Protocol) servers. Subcommands: list, add, remove, reload",
  async execute(args, ctx) {
    const now = Date.now();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const config = loadModelConfig();
      const configuredServers = config.mcpServers || {};
      const configuredNames = Object.keys(configuredServers);

      if (configuredNames.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No MCP servers configured.\n\nUse `/mcp add <name> <command> [args...]` to add a server, or configure it directly in `model-config.json`.",
          timestamp: now,
        });
        return;
      }

      let output = `🔌 Configured MCP Servers (${configuredNames.length}):\n`;
      for (const name of configuredNames) {
        const srvConfig = configuredServers[name];
        const conn = connectedServers.get(name.toLowerCase());
        const statusStr = conn
          ? conn.status === "connected"
            ? "✅ Connected"
            : conn.status === "connecting"
            ? conn.error?.includes("waiting for the local callback") ? "🔐 Waiting for OAuth approval" : "⏳ Connecting"
            : `❌ Error (${conn.error || "Unknown error"})`
          : "💤 Disconnected/Idle";

        output += `\n• [${name}] - ${statusStr}\n`;
        if (srvConfig.transport === "http" || srvConfig.transport === "streamable-http") {
          output += "  Transport: " + srvConfig.transport + "\n";
          output += "  URL: " + srvConfig.url + "\n";
          if (srvConfig.oauth) output += "  OAuth: enabled\n";
        } else if (srvConfig.transport === "stdio") {
          output += "  Command: " + srvConfig.command + " " + (srvConfig.args || []).join(" ") + "\n";
        }
        if (conn?.status === "connecting" && conn.error) output += "  Details: " + conn.error + "\n";
        if (conn && conn.tools && conn.tools.length > 0) {
          output += `  Tools (${conn.tools.length}): ${conn.tools.join(", ")}\n`;
        } else if (conn && conn.status === "connected") {
          output += `  Tools: None exposed\n`;
        }
      }

      ctx.addLine({
        type: "system",
        content: output,
        timestamp: now,
      });
      return;
    }

    if (subcommand === "add-http") {
      const name = parts[1];
      const rawUrl = parts[2];
      if (!name || !rawUrl) {
        ctx.addLine({
          type: "error",
          content: "Usage: /mcp add-http <name> <url> [--oauth]",
          timestamp: now,
        });
        return;
      }
      let url: URL;
      try {
        url = new URL(rawUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("HTTP(S) URL required");
      } catch {
        ctx.addLine({
          type: "error",
          content: "URL must be a valid absolute HTTP(S) URL.",
          timestamp: now,
        });
        return;
      }

      const config = loadModelConfig();
      if (!config.mcpServers) config.mcpServers = {};
      config.mcpServers[name] = {
        transport: "http",
        url: url.toString(),
        oauth: parts.slice(3).some((part) => part.toLowerCase() === "--oauth"),
      };
      if (!saveModelConfig(config)) {
        ctx.addLine({ type: "error", content: "Failed to save MCP configuration.", timestamp: Date.now() });
        return;
      }

      try {
        await initMcpServers();
        const conn = connectedServers.get(name.toLowerCase());
        if (conn?.status === "connected") {
          ctx.addLine({ type: "system", content: "Connected remote MCP server \"" + name + "\". Tools: " + conn.tools.join(", "), timestamp: Date.now() });
        } else if (conn?.status === "connecting" && conn.error?.includes("waiting for the local callback")) {
          ctx.addLine({ type: "system", content: "OAuth browser login opened for \"" + name + "\". Complete approval in the browser; SuperAgent will load its tools afterward.", timestamp: Date.now() });
        } else {
          ctx.addLine({ type: "error", content: "Remote MCP server \"" + name + "\" did not connect: " + (conn?.error || "Unknown error"), timestamp: Date.now() });
        }
      } catch (error) {
        ctx.addLine({ type: "error", content: "Failed to initialize MCP servers: " + (error instanceof Error ? error.message : String(error)), timestamp: Date.now() });
      }
      return;
    }

    if (subcommand === "add") {
      const name = parts[1];
      const command = parts[2];
      const serverArgs = parts.slice(3);

      if (!name || !command) {
        ctx.addLine({
          type: "error",
          content: "Usage: /mcp add <name> <command> [args...]\nExample: /mcp add everything npx -y @modelcontextprotocol/server-everything",
          timestamp: now,
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Adding MCP server "${name}"...`,
        timestamp: now,
      });

      const config = loadModelConfig();
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      config.mcpServers[name] = {
        transport: "stdio",
        command,
        args: serverArgs,
      };

      const saved = saveModelConfig(config);
      if (!saved) {
        ctx.addLine({
          type: "error",
          content: "Failed to save configuration to model-config.json",
          timestamp: Date.now(),
        });
        return;
      }

      try {
        await initMcpServers();
        const conn = connectedServers.get(name.toLowerCase());
        if (conn && conn.status === "connected") {
          ctx.addLine({
            type: "system",
            content: `✓ Successfully added and connected to MCP server "${name}"!\nLoaded tools: ${conn.tools.join(", ")}`,
            timestamp: Date.now(),
          });
        } else {
          ctx.addLine({
            type: "error",
            content: `MCP server "${name}" was added to configuration, but failed to connect: ${conn?.error || "Unknown error"}`,
            timestamp: Date.now(),
          });
        }
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to initialize MCP servers: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "remove" || subcommand === "delete") {
      const name = parts[1];
      if (!name) {
        ctx.addLine({
          type: "error",
          content: "Usage: /mcp remove <name>\nExample: /mcp remove everything",
          timestamp: now,
        });
        return;
      }

      const config = loadModelConfig();
      if (!config.mcpServers || !config.mcpServers[name]) {
        ctx.addLine({
          type: "error",
          content: `MCP server "${name}" is not configured.`,
          timestamp: now,
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Removing MCP server "${name}"...`,
        timestamp: now,
      });

      delete config.mcpServers[name];
      const saved = saveModelConfig(config);
      if (!saved) {
        ctx.addLine({
          type: "error",
          content: "Failed to save configuration to model-config.json",
          timestamp: Date.now(),
        });
        return;
      }

      try {
        await initMcpServers();
        ctx.addLine({
          type: "system",
          content: `✓ Successfully removed MCP server "${name}" and refreshed toolsets.`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to reload MCP servers after removal: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "reload") {
      ctx.addLine({
        type: "system",
        content: "Reloading all configured MCP servers and toolsets...",
        timestamp: now,
      });

      try {
        await initMcpServers();
        ctx.addLine({
          type: "system",
          content: "✓ Successfully reloaded all MCP servers and updated toolsets.",
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to reload MCP servers: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subcommand === "tunnel") {
      const tunnelAction = (parts[1] || "list").toLowerCase();
      const rawArgs = parts.slice(2);

      if (tunnelAction === "providers") {
        ctx.addLine({ type: "system", content: getMcpTunnelProvidersHelp(), timestamp: now });
        return;
      }

      if (tunnelAction === "list" || tunnelAction === "status") {
        const { listActiveMcpServers, formatActiveMcpServers } = await import("../mcp/mcpTunnel.js");
        ctx.addLine({
          type: "system",
          content: formatActiveMcpServers(listActiveMcpServers()),
          timestamp: now,
        });
        return;
      }

      if (tunnelAction === "doctor") {
        const providerIdx = rawArgs.findIndex((a) => a === "--provider");
        const provider = providerIdx === -1 ? "openai" : rawArgs[providerIdx + 1]?.toLowerCase();
        if (provider !== "openai" && provider !== "cloudflare") {
          ctx.addLine({ type: "error", content: "Unsupported MCP tunnel doctor provider. Use --provider openai or --provider cloudflare.", timestamp: now });
          return;
        }
        if (provider === "cloudflare") {
          const { findCloudflaredBinary } = await import("../remoteAgent/cloudflareTunnel.js");
          const binary = await findCloudflaredBinary();
          const { listActiveMcpServers } = await import("../mcp/mcpTunnel.js");
          const active = listActiveMcpServers().filter((server) => server.tunnelProvider === "cloudflare");
          const lines = [
            "Cloudflare MCP Tunnel Doctor",
            "- cloudflared: " + (binary || "NOT FOUND"),
            "- Active Cloudflare MCP tunnels: " + active.length,
          ];
          ctx.addLine({ type: binary ? "system" : "error", content: lines.join("\n"), timestamp: now });
          return;
        }
        const { runTunnelClientDoctor } = await import("../mcp/openaiTunnelClient.js");
        const profileIdx = rawArgs.findIndex((a) => a === "--profile");
        const profile = profileIdx !== -1 ? rawArgs[profileIdx + 1] : undefined;
        const tunnelIdIdx = rawArgs.findIndex((a) => a === "--tunnel-id");
        const tunnelId = tunnelIdIdx !== -1 ? rawArgs[tunnelIdIdx + 1] : undefined;
        const apiKeyIdx = rawArgs.findIndex((a) => a === "--api-key" || a === "--control-plane-key");
        const apiKey = apiKeyIdx !== -1 ? rawArgs[apiKeyIdx + 1] : undefined;

        ctx.addLine({ type: "system", content: "Running OpenAI Secure MCP tunnel-client doctor check...", timestamp: now });
        const docResult = await runTunnelClientDoctor({ profile, tunnelId, apiKey });
        ctx.addLine({
          type: docResult.success ? "system" : "error",
          content: "[OpenAI tunnel-client doctor]\n" + docResult.output,
          timestamp: Date.now(),
        });
        return;
      }

      if (tunnelAction === "restart") {
        const portIdx = rawArgs.findIndex((a) => a === "--port" || a === "--mcp-port" || a === "-p");
        let port = 9227;
        if (portIdx !== -1 && rawArgs[portIdx + 1]) {
          const parsed = Number.parseInt(rawArgs[portIdx + 1], 10);
          if (!Number.isInteger(parsed) || parsed <= 0 || parsed >= 65536) {
            ctx.addLine({ type: "error", content: "Invalid MCP tunnel port.", timestamp: now });
            return;
          }
          port = parsed;
        }
        const { listActiveMcpServers, stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
        const active = listActiveMcpServers().find((server) => server.port === port);
        if (active?.pid && active.pid !== process.pid) {
          ctx.addLine({ type: "error", content: "MCP tunnel on port " + port + " is owned by PID " + active.pid + ". Stop/restart it from its owning SuperAgent instance.", timestamp: now });
          return;
        }
        const restartArgs = [...rawArgs];
        const hasProvider = restartArgs.includes("--provider") || restartArgs.includes("--openai") || restartArgs.includes("--openai-tunnel") || restartArgs.includes("--tunnel-id");
        if (active && !hasProvider) {
          restartArgs.push("--provider", active.tunnelProvider || "cloudflare");
          if (active.tunnelProvider === "openai" && active.openAiTunnelId) restartArgs.push("--tunnel-id", active.openAiTunnelId);
        }
        if (active?.authMode && !restartArgs.includes("--mcp-auth")) restartArgs.push("--mcp-auth", active.authMode);
        if (active?.toolMode === "dangerous" && !restartArgs.includes("--allow-dangerous")) restartArgs.push("--allow-dangerous");
        if (active) await stopMcpTunnel(port);
        await mcpCommand.execute("tunnel start " + restartArgs.join(" "), ctx);
        return;
      }

      if (tunnelAction === "stop") {
        const portIdx = rawArgs.findIndex((a) => a === "--port" || a === "--mcp-port" || a === "-p");
        let port = 9227;
        if (portIdx !== -1 && rawArgs[portIdx + 1]) {
          const parsed = parseInt(rawArgs[portIdx + 1], 10);
          if (parsed > 0) port = parsed;
        }
        const { stopMcpTunnel } = await import("../mcp/mcpTunnel.js");
        await stopMcpTunnel(port);
        ctx.addLine({
          type: "system",
          content: `MCP tunnel on port ${port} stopped.`,
          timestamp: Date.now(),
        });
        return;
      }

      if (tunnelAction === "start") {
        const portIdx = rawArgs.findIndex((a) => a === "--port" || a === "--mcp-port" || a === "-p");
        let port = 9227;
        if (portIdx !== -1 && rawArgs[portIdx + 1]) {
          const parsed = parseInt(rawArgs[portIdx + 1], 10);
          if (parsed > 0) port = parsed;
        }
        const providerIdx = rawArgs.findIndex((a) => a === "--provider");
        const wantOpenAi = rawArgs.some((a) => a === "--openai" || a === "--openai-tunnel");
        let provider: "cloudflare" | "openai" = wantOpenAi ? "openai" : "cloudflare";
        if (providerIdx !== -1) {
          const p = rawArgs[providerIdx + 1]?.toLowerCase();
          if (p !== "openai" && p !== "cloudflare") {
            ctx.addLine({
              type: "error",
              content: `Unsupported MCP tunnel provider "${rawArgs[providerIdx + 1] || "(missing)"}". Supported providers: cloudflare, openai. See /mcp tunnel providers.`,
              timestamp: now,
            });
            return;
          }
          provider = p;
        }
        const tunnelIdIdx = rawArgs.findIndex((a) => a === "--tunnel-id");
        let tunnelId: string | undefined;
        if (tunnelIdIdx !== -1 && rawArgs[tunnelIdIdx + 1]) {
          tunnelId = rawArgs[tunnelIdIdx + 1].trim();
          provider = "openai";
        }
        const apiKeyIdx = rawArgs.findIndex((a) => a === "--api-key" || a === "--control-plane-key");
        const apiKey = apiKeyIdx !== -1 ? rawArgs[apiKeyIdx + 1]?.trim() : undefined;
        const profileIdx = rawArgs.findIndex((a) => a === "--profile");
        const profile = profileIdx !== -1 ? rawArgs[profileIdx + 1]?.trim() : undefined;
        const allowDangerous = rawArgs.some((a) => a === "--allow-dangerous");
        const authModeIdx = rawArgs.findIndex((a) => a === "--mcp-auth" || a === "--auth");
        let authMode: "static-bearer" | "oauth" | undefined;
        if (authModeIdx !== -1 && rawArgs[authModeIdx + 1]) {
          const mode = rawArgs[authModeIdx + 1].toLowerCase();
          if (mode === "oauth" || mode === "static-bearer") {
            authMode = mode;
          } else {
            ctx.addLine({
              type: "error",
              content: `Invalid --mcp-auth value "${rawArgs[authModeIdx + 1]}". Use static-bearer or oauth.`,
              timestamp: now,
            });
            return;
          }
        }

        const { startMcpTunnel } = await import("../mcp/mcpTunnel.js");
        try {
          const info = await startMcpTunnel({
            port,
            allowDangerous,
            authMode,
            tunnelProvider: provider,
            tunnelId,
            openAiApiKey: apiKey,
            openAiProfile: profile,
          });

          if (info.tunnelProvider === "openai") {
            const lines = [
              "OpenAI Secure MCP Tunnel Online!",
              `- Tunnel ID    : ${info.openAiTunnelId}`,
              `- Local MCP URL: ${info.localUrl}`,
              info.adminUrl ? `- Admin UI     : ${info.adminUrl}` : "",
              `- Auth Mode    : ${info.authMode}`,
              `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
            ];
            if (info.authMode === "oauth") {
              lines.push(
                `- Discovery    : ${info.oauthDiscoveryUrl}`,
                "",
                "One-time bootstrap approval code (shown ONCE, never stored):",
                `  - ${info.bootstrapCode}`,
              );
            }
            lines.push(
              "",
              "Responses API tool definition:",
              JSON.stringify({
                model: "gpt-4o",
                input: "Use the private MCP server to answer my request.",
                tools: [{ type: "mcp", server_label: "superagent_mcp", tunnel_id: info.openAiTunnelId }],
              }, null, 2),
            );
            ctx.addLine({
              type: "system",
              content: lines.filter(Boolean).join("\n"),
              timestamp: Date.now(),
            });
          } else {
            const lines = [
              "MCP via Cloudflare Tunnel Online!",
              `- Endpoint     : ${info.publicUrl}`,
              `- Local URL    : ${info.localUrl}`,
              `- Auth Mode    : ${info.authMode}`,
            ];
            if (info.authMode === "oauth") {
              lines.push(
                `- Discovery    : ${info.oauthDiscoveryUrl}`,
                `- Scopes       : mcp:tools${info.dangerous ? " mcp:tools:write" : ""}`,
                `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
                `- Audit Log    : ${info.auditLogPath}`,
                "",
                "One-time bootstrap approval code (shown ONCE, never stored):",
                `  - ${info.bootstrapCode}`,
                "",
                "Client setup (e.g. ChatGPT / Gemini):",
                `  1. Set MCP server URL to: ${info.publicUrl}`,
                "  2. Authentication: OAuth",
                "  3. Open browser authorization page when prompted and paste the bootstrap code above to approve.",
              );
            } else {
              lines.push(
                `- Bearer Token : ${info.bearerToken}`,
                `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
              );
            }
            ctx.addLine({
              type: "system",
              content: lines.join("\n"),
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `Failed to start MCP tunnel: ${err.message}`,
            timestamp: Date.now(),
          });
        }
        return;
      }

      ctx.addLine({
        type: "error",
        content: `Unknown tunnel action "${tunnelAction}". Available: providers, start, stop, restart, list, status, doctor`,
        timestamp: now,
      });
      return;
    }

    ctx.addLine({
      type: "error",
      content: `Unknown subcommand "${subcommand}". Available subcommands: list, add, remove, reload, tunnel`,
      timestamp: now,
    });
  },
};

registry.register(mcpCommand);
