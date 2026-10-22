import { Tool } from "./types.js";
import { loadModelConfig, saveModelConfig } from "../config/jsonConfig.js";
import { initMcpServers, refreshMcpServerTools, reconnectMcpServer, connectedServers, getMcpConnectionDiagnostics } from "../mcp/McpManager.js";
import { mcpToolMetrics } from "../mcp/mcpToolMetrics.js";

export const manageMcpTool: Tool = {
  name: "manage_mcp",
  description: "Manage MCP (Model Context Protocol) servers. Use this to list, add, remove, or reload MCP servers so they can expose new tools to you.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "remove", "reload", "refresh", "reconnect", "stats"],
        description: "The action to perform: 'list' configured servers and status; 'add' a new server; 'remove' a server; 'reload' all connections, or 'refresh' tools in-place, or 'reconnect' one server.",
      },
      name: {
        type: "string",
        description: "The unique name of the MCP server. Required for 'add' and 'remove'.",
      },
      transport: {
        type: "string",
        enum: ["stdio", "http", "streamable-http"],
        description: "Transport to use when adding a server. Defaults to stdio.",
      },
      url: {
        type: "string",
        description: "Remote Streamable HTTP MCP endpoint URL. Required when transport is http.",
      },
      headersFromEnv: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "HTTP header name -> environment variable name. Do not place raw tokens in model-config.json.",
      },
      oauth: {
        type: "boolean",
        description: "Enable OAuth 2.1 browser login for remote HTTP MCP servers.",
      },
      command: {
        type: "string",
        description: "The command to run the MCP server (e.g., 'npx', 'node'). Required for 'add'.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the MCP server command. Optional for 'add'.",
      },
      autoReconnect: {
        type: "boolean",
        description: "Reconnect after unexpected disconnect (default on; OAuth requires explicit opt-in).",
      },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Environment variables to pass to the MCP server. Optional for 'add'.",
      },
    },
    required: ["action"],
  },
  execute: async (args) => {
    const action = args.action as string;
    const name = args.name as string | undefined;

    if (action === "list") {
      const config = loadModelConfig();
      const mcpConfigs = config.mcpServers || {};
      const serverNames = Object.keys(mcpConfigs);
      if (serverNames.length === 0) {
        return "No MCP servers configured.";
      }

      let result = `Configured MCP Servers (${serverNames.length}):\n`;
      for (const srvName of serverNames) {
        const srvConfig = mcpConfigs[srvName];
        const conn = connectedServers.get(srvName.toLowerCase());
        const status = conn ? conn.status : "disconnected";
        const error = conn?.error ? ` (Error: ${conn.error})` : "";
        result += `- [${srvName}] | Status: ${status}${error}\n`;
        const retry = getMcpConnectionDiagnostics(srvName);
        if (retry.attempts > 0) result += `  Reconnect: attempt ${retry.attempts}; next delay: ${retry.nextDelayMs ?? "none"} ms
`;
        if (!("command" in srvConfig)) {
          result += "  Transport: " + srvConfig.transport + "\n";
          result += "  URL: " + srvConfig.url + "\n";
          if (srvConfig.oauth) result += "  OAuth: enabled\n";
        } else {
          result += "  Command: " + srvConfig.command + " " + (srvConfig.args || []).join(" ") + "\n";
        }
        if (conn && conn.tools && conn.tools.length > 0) {
          result += `  Tools: ${conn.tools.join(", ")}\n`;
        }
      }
      return result;
    }

    if (action === "add") {
      if (!name) return "Error: 'name' is required to add an MCP server.";
      const config = loadModelConfig();
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      const transport = (args.transport as string | undefined) || "stdio";
      if (transport === "http" || transport === "streamable-http") {
        const url = args.url as string | undefined;
        if (!url) return "Error: 'url' is required for HTTP MCP servers.";
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "Error: MCP HTTP URL must use http or https.";
        } catch {
          return "Error: 'url' must be a valid absolute HTTP(S) URL.";
        }
        config.mcpServers[name] = {
          transport,
          url,
          headersFromEnv: (args.headersFromEnv as Record<string, string>) || {},
          oauth: Boolean(args.oauth),
          autoReconnect: typeof args.autoReconnect === "boolean" ? args.autoReconnect : undefined,
        };
      } else {
        if (!args.command) return "Error: 'command' is required for stdio MCP servers.";
        config.mcpServers[name] = {
          transport: "stdio",
          command: args.command as string,
          args: (args.args as string[]) || [],
          env: (args.env as Record<string, string>) || {},
          autoReconnect: typeof args.autoReconnect === "boolean" ? args.autoReconnect : undefined,
        };
      }
      saveModelConfig(config);
      await initMcpServers();
      const conn = connectedServers.get(name.toLowerCase());
      if (conn && conn.status === "connected") {
        return `Successfully added and connected MCP server "${name}". Discovered tools: ${conn.tools.join(", ")}`;
      }
      return `Added MCP server "${name}" to config, but connection failed: ${conn?.error || "Unknown connection error"}`;
    }

    if (action === "remove") {
      if (!name) {
        return "Error: 'name' is required to remove an MCP server.";
      }
      const config = loadModelConfig();
      if (!config.mcpServers || !config.mcpServers[name]) {
        return `Error: MCP server "${name}" is not configured.`;
      }
      delete config.mcpServers[name];
      saveModelConfig(config);
      await initMcpServers();
      return `Successfully removed MCP server "${name}" and refreshed toolsets.`;
    }

    if (action === "stats") {
      const metrics = mcpToolMetrics.snapshot(name || undefined).slice(0, 40);
      if (!metrics.length) return "No MCP tool execution metrics recorded.";
      return metrics.map((metric) =>
        `${metric.tool}: calls=${metric.calls} failures=${metric.failures} avgMs=${Math.round(metric.totalDurationMs / metric.calls)} lastMs=${metric.lastDurationMs}`
      ).join("\n");
    }

    if (action === "refresh") {
      if (!name) return "Error: 'name' is required to refresh a single MCP server.";
      const server = connectedServers.get(name.toLowerCase());
      if (!server || server.status !== "connected") return `Error: MCP server "${name}" is not connected.`;
      try {
        const changed = await refreshMcpServerTools(name);
        return `MCP server "${name}" tools ${changed ? "refreshed" : "already up to date"}; total: ${server.tools.length}.`;
      } catch {
        return `Error refreshing MCP server "${name}". Inspect MCP connection status for diagnostics.`;
      }
    }

    if (action === "reconnect") {
      if (!name) return "Error: 'name' is required to reconnect an MCP server.";
      try {
        const server = await reconnectMcpServer(name);
        return server?.status === "connected"
          ? `MCP server "${name}" reconnected; tools: ${server.tools.length}.`
          : `MCP server "${name}" did not reconnect. Check the configuration and status.`;
      } catch {
        return `MCP server "${name}" reconnect failed. Check status for diagnostics.`;
      }
    }

    if (action === "reload") {
      await initMcpServers();
      return "Successfully reloaded all MCP servers and updated toolsets.";
    }

    return `Error: Unknown action "${action}".`;
  },
};
