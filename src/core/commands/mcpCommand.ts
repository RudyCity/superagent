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
            ? "⏳ Connecting"
            : `❌ Error (${conn.error || "Unknown error"})`
          : "💤 Disconnected/Idle";

        output += `\n• [${name}] - ${statusStr}\n`;
        output += `  Command: ${srvConfig.command} ${(srvConfig.args || []).join(" ")}\n`;
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

    ctx.addLine({
      type: "error",
      content: `Unknown subcommand "${subcommand}". Available subcommands: list, add, remove, reload`,
      timestamp: now,
    });
  },
};

registry.register(mcpCommand);
