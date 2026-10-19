import { SlashCommand } from "./types.js";
import { loadModelConfig, saveModelConfig } from "../config/jsonConfig.js";
import { initMcpServers, connectedServers } from "../mcp/McpManager.js";
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
        const { runTunnelClientDoctor } = await import("../mcp/openaiTunnelClient.js");
        const profileIdx = rawArgs.findIndex((a) => a === "--profile");
        const profile = profileIdx !== -1 ? rawArgs[profileIdx + 1] : undefined;
        const tunnelIdIdx = rawArgs.findIndex((a) => a === "--tunnel-id");
        const tunnelId = tunnelIdIdx !== -1 ? rawArgs[tunnelIdIdx + 1] : undefined;
        const apiKeyIdx = rawArgs.findIndex((a) => a === "--api-key" || a === "--control-plane-key");
        const apiKey = apiKeyIdx !== -1 ? rawArgs[apiKeyIdx + 1] : undefined;

        ctx.addLine({ type: "system", content: "Running tunnel-client doctor check...", timestamp: now });
        const docResult = await runTunnelClientDoctor({ profile, tunnelId, apiKey });
        ctx.addLine({
          type: docResult.success ? "system" : "error",
          content: `[tunnel-client doctor]\n${docResult.output}`,
          timestamp: Date.now(),
        });
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
        if (providerIdx !== -1 && rawArgs[providerIdx + 1]) {
          const p = rawArgs[providerIdx + 1].toLowerCase();
          if (p === "openai" || p === "cloudflare") provider = p;
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

        const { startMcpTunnel } = await import("../mcp/mcpTunnel.js");
        try {
          const info = await startMcpTunnel({
            port,
            allowDangerous,
            tunnelProvider: provider,
            tunnelId,
            openAiApiKey: apiKey,
            openAiProfile: profile,
          });

          if (info.tunnelProvider === "openai") {
            ctx.addLine({
              type: "system",
              content: [
                "OpenAI Secure MCP Tunnel Online!",
                `- Tunnel ID    : ${info.openAiTunnelId}`,
                `- Local MCP URL: ${info.localUrl}`,
                info.adminUrl ? `- Admin UI     : ${info.adminUrl}` : "",
                `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
                "",
                "Responses API tool definition:",
                JSON.stringify({
                  model: "gpt-4o",
                  input: "Use the private MCP server to answer my request.",
                  tools: [{ type: "mcp", server_label: "superagent_mcp", tunnel_id: info.openAiTunnelId }],
                }, null, 2),
              ].filter(Boolean).join("\n"),
              timestamp: Date.now(),
            });
          } else {
            ctx.addLine({
              type: "system",
              content: [
                "MCP via Cloudflare Tunnel Online!",
                `- Endpoint     : ${info.publicUrl}`,
                `- Local URL    : ${info.localUrl}`,
                `- Bearer Token : ${info.bearerToken}`,
                `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
              ].join("\n"),
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
        content: `Unknown tunnel action "${tunnelAction}". Available: start, stop, list, status, doctor`,
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
