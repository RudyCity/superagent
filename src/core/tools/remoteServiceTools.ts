/**
 * remoteServiceTools.ts — Tools for inspecting live status of /muse tunnel, MCP, and Telegram.
 */

import { Tool } from "./types.js";
import { getRemoteServiceStatus, formatRemoteServiceStatus } from "../remoteAgent/remoteStatusService.js";

export const getRemoteServiceStatusTool: Tool = {
  name: "get_remote_service_status",
  description: "Inspect the real-time operational status of /muse tunnel (Cloudflare quick tunnels & WebSocket bridge), MCP (MCP servers exposed via tunnel/HTTP and connected client MCPs), and Telegram (Muse Telegram watcher, fallback watcher, and Gateway Telegram channel). Returns live endpoints, ports, PIDs, uptimes, and connection status.",
  parameters: {
    type: "object",
    properties: {
      service: {
        type: "string",
        enum: ["all", "tunnel", "mcp", "telegram"],
        description: "Filter by specific service or inspect 'all'. Default is 'all'.",
      },
      detailed: {
        type: "boolean",
        description: "Whether to return detailed endpoint, tool, and diagnostic information. Default is true.",
      },
    },
  },
  execute: async (args) => {
    const rawService = typeof args?.service === "string" ? args.service.toLowerCase().trim() : "all";
    const service: "all" | "tunnel" | "mcp" | "telegram" =
      rawService === "tunnel" || rawService === "mcp" || rawService === "telegram"
        ? rawService
        : "all";
    const detailed = args?.detailed !== false;
    const status = await getRemoteServiceStatus(service);
    return formatRemoteServiceStatus(status, service, detailed);
  },
};
