/**
 * types.ts — Shared types for Superagent MCP Tool Handlers.
 */

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ServerInfo {
  port: number;
  pid: number;
  authToken?: string;
  startedAt?: number;
}
