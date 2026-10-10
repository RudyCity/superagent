/**
 * diagnosticsMcpTools.ts — Process inspection, port diagnostics, and graceful termination tools for MCP.
 */

import { McpToolResult } from "../types.js";
import {
  inspectPortTool,
  freePortTool,
  findProcessTool,
  killProcessTool,
} from "../../tools/processInspectionTools.js";

function toResult(res: unknown): McpToolResult {
  const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  const isError =
    typeof res === "string" &&
    (res.startsWith("Error:") ||
      res.startsWith("Failed to") ||
      res.includes("remains occupied"));
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleInspectPort(args: any): Promise<McpToolResult> {
  try {
    const res = await inspectPortTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `inspect_port error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleFreePort(args: any): Promise<McpToolResult> {
  try {
    const res = await freePortTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `free_port error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleFindProcess(args: any): Promise<McpToolResult> {
  try {
    const res = await findProcessTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `find_process error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleKillProcess(args: any): Promise<McpToolResult> {
  try {
    const res = await killProcessTool.execute(args || {}, process.cwd());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `kill_process error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export const DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_inspect_port: "safe",
  superagent_free_port: "dangerous",
  superagent_find_process: "safe",
  superagent_kill_process: "dangerous",
};

export const DIAGNOSTICS_MCP_TOOL_DEFS = [
  {
    name: "superagent_inspect_port",
    description:
      "Inspect a TCP port (1-65535) to discover which process is listening on it, including PID, process name, full command line, and whether it is a Superagent background task.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "The TCP port number to inspect (1-65535), e.g. 3000, 7001, 8080.",
        },
      },
      required: ["port"],
    },
  },
  {
    name: "superagent_free_port",
    description:
      "Safely terminate the specific process occupying a TCP port and its child process tree, preventing port conflicts (EADDRINUSE) without killing unrelated services.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "The TCP port number to release, e.g. 3000, 7001, 8080.",
        },
        force: {
          type: "boolean",
          description: "Whether to force-kill if graceful termination does not release the port within 2s (default: true).",
        },
      },
      required: ["port"],
    },
  },
  {
    name: "superagent_find_process",
    description:
      "Search active system processes or Superagent tasks by port number, process name (e.g. 'bun', 'vite'), or command line substring.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Port number, process name, or command substring to search for.",
        },
        limit: {
          type: "number",
          description: "Maximum number of process matches to return (default: 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "superagent_kill_process",
    description:
      "Safely terminate a specific process by its PID and its child process tree, verifying against critical operating system processes.",
    inputSchema: {
      type: "object",
      properties: {
        pid: {
          type: "number",
          description: "The Process ID (PID) to terminate.",
        },
        force: {
          type: "boolean",
          description: "Whether to force-kill if graceful termination fails (default: true).",
        },
      },
      required: ["pid"],
    },
  },
];

export async function dispatchDiagnosticsMcpTool(name: string, args: any): Promise<McpToolResult | null> {
  switch (name) {
    case "superagent_inspect_port":
      return await handleInspectPort(args);
    case "superagent_free_port":
      return await handleFreePort(args);
    case "superagent_find_process":
    case "superagent_find_processes":
      return await handleFindProcess(args);
    case "superagent_kill_process":
      return await handleKillProcess(args);
    default:
      return null;
  }
}
