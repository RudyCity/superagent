import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadModelConfig } from "../config/jsonConfig.js";
import type { Tool } from "../tools/types.js";
import {
  allTools,
  masterToolset,
  superagentToolset,
  defaultSubagentToolset,
  subagentToolsets,
} from "../tools/index.js";

export interface ConnectedMcpServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: string[];
  status: "connected" | "connecting" | "error";
  error?: string;
}

export const connectedServers = new Map<string, ConnectedMcpServer>();
let loadedMcpTools: Tool[] = [];

/**
 * Initializes and connects to all configured MCP servers.
 * Discovered tools are dynamically mapped and registered into the agent's toolsets.
 */
export async function initMcpServers(): Promise<void> {
  // Clear any existing connections first
  await closeMcpServers();

  const config = loadModelConfig();
  if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
    return;
  }

  const serverConfigs = config.mcpServers;
  const initPromises = Object.entries(serverConfigs).map(async ([name, srvConfig]) => {
    const serverName = name.trim().toLowerCase();
    
    // Setup env merging process.env with configured env
    const mergedEnv = {
      ...process.env,
      ...(srvConfig.env || {}),
    } as Record<string, string>;

    const transport = new StdioClientTransport({
      command: srvConfig.command,
      args: srvConfig.args || [],
      env: mergedEnv,
      // Pipe stderr so MCP subprocess output (e.g. pip install logs) does NOT
      // bleed into Superagent's terminal UI. We capture it for error reporting.
      stderr: "pipe",
    });

    const client = new Client(
      {
        name: "superagent-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    const connectionRecord: ConnectedMcpServer = {
      name: serverName,
      client,
      transport,
      tools: [],
      status: "connecting",
    };
    connectedServers.set(serverName, connectionRecord);

    // Accumulate piped stderr from the MCP subprocess (installation logs, boot messages, etc.)
    // so it is available for error reporting without leaking to the Superagent terminal.
    let stderrBuffer = "";
    const stderrStream = transport.stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        // Keep last 4 KB to avoid unbounded growth
        if (stderrBuffer.length > 4096) {
          stderrBuffer = stderrBuffer.slice(-4096);
        }
      });
    }

    try {
      await client.connect(transport);
      const toolsResult = await client.listTools();
      const toolsList = toolsResult.tools || [];
      
      connectionRecord.status = "connected";

      for (const tool of toolsList) {
        const prefixedName = `${serverName}_${tool.name}`;
        connectionRecord.tools.push(prefixedName);

        // Map MCP tool to Superagent's internal Tool interface
        const mappedTool: Tool = {
          name: prefixedName,
          description: tool.description || `MCP Tool from server ${serverName}: ${tool.name}`,
          parameters: (tool.inputSchema || {}) as Record<string, unknown>,
          execute: async (args: Record<string, unknown>) => {
            const response = await client.callTool({
              name: tool.name,
              arguments: args,
            });

            if (response && Array.isArray(response.content)) {
              return response.content
                .map((c: any) => {
                  if (c.type === "text") return c.text;
                  if (c.type === "image") return `[Image Content (${c.mimeType || "image/png"})]`;
                  return JSON.stringify(c);
                })
                .join("\n");
            }
            return JSON.stringify(response);
          },
        };

        loadedMcpTools.push(mappedTool);
      }
    } catch (err: any) {
      connectionRecord.status = "error";
      // Combine the JS error message with any captured stderr for a richer error report
      const detail = stderrBuffer.trim()
        ? `${err.message || String(err)}\nServer stderr:\n${stderrBuffer.trim()}`
        : (err.message || String(err));
      connectionRecord.error = detail;
      // Write to log rather than process.stderr to avoid polluting the Superagent UI
      process.stderr.write(`[MCP] Failed to connect to server "${serverName}": ${detail}\n`);
    }
  });

  await Promise.all(initPromises);

  // Register newly loaded tools into all toolsets
  if (loadedMcpTools.length > 0) {
    allTools.push(...loadedMcpTools);
    masterToolset.push(...loadedMcpTools);
    superagentToolset.push(...loadedMcpTools);
    defaultSubagentToolset.push(...loadedMcpTools);
    for (const key of Object.keys(subagentToolsets)) {
      subagentToolsets[key].push(...loadedMcpTools);
    }
  }
}

/**
 * Gracefully disconnects and stops all active MCP servers.
 * Removes registered MCP tools from toolsets.
 */
export async function closeMcpServers(): Promise<void> {
  // Disconnect all clients
  for (const srv of connectedServers.values()) {
    try {
      await srv.transport.close();
    } catch (err: any) {
      // Ignore disconnect errors
    }
  }
  connectedServers.clear();

  // Remove registered MCP tools from all toolsets
  if (loadedMcpTools.length > 0) {
    const toRemoveNames = new Set(loadedMcpTools.map((t) => t.name));

    const filterArray = (arr: any[]) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const item = arr[i];
        const name = typeof item === "string" ? item : item?.name;
        if (name && toRemoveNames.has(name)) {
          arr.splice(i, 1);
        }
      }
    };

    filterArray(allTools);
    filterArray(masterToolset);
    filterArray(superagentToolset);
    filterArray(defaultSubagentToolset);
    for (const key of Object.keys(subagentToolsets)) {
      filterArray(subagentToolsets[key]);
    }

    loadedMcpTools = [];
  }
}
