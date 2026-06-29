import { Tool } from "./types.js";
import { loadModelConfig, saveModelConfig } from "../config/jsonConfig.js";
import { initMcpServers, connectedServers } from "../mcp/McpManager.js";

export const manageMcpTool: Tool = {
  name: "manage_mcp",
  description: "Manage MCP (Model Context Protocol) servers. Use this to list, add, remove, or reload MCP servers so they can expose new tools to you.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "remove", "reload"],
        description: "The action to perform: 'list' configured servers and status; 'add' a new server; 'remove' a server; 'reload' connections.",
      },
      name: {
        type: "string",
        description: "The unique name of the MCP server. Required for 'add' and 'remove'.",
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
        result += `  Command: ${srvConfig.command} ${(srvConfig.args || []).join(" ")}\n`;
        if (conn && conn.tools && conn.tools.length > 0) {
          result += `  Tools: ${conn.tools.join(", ")}\n`;
        }
      }
      return result;
    }

    if (action === "add") {
      if (!name || !args.command) {
        return "Error: Both 'name' and 'command' are required to add an MCP server.";
      }
      const config = loadModelConfig();
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      config.mcpServers[name] = {
        command: args.command as string,
        args: (args.args as string[]) || [],
        env: (args.env as Record<string, string>) || {},
      };
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

    if (action === "reload") {
      await initMcpServers();
      return "Successfully reloaded all MCP servers and updated toolsets.";
    }

    return `Error: Unknown action "${action}".`;
  },
};
