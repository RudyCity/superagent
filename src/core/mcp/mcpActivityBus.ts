/**
 * mcpActivityBus.ts — Real-time event bus for Model Context Protocol (MCP) activity.
 *
 * Broadcasts MCP tool calls, results, client connections, and discovery events
 * to active Superagent UI sessions (conversation log / chat sheet) both in-process
 * and cross-process via an append-only JSONL journal (~/.superagent-r/mcp-activity.jsonl).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import { summarizeArgs } from "./mcpLogSanitizer.js";

export type McpActivityType = "tool_call" | "client_connect" | "client_disconnect" | "tool_list" | "auth";

export interface McpActivityEvent {
  type: McpActivityType;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  output?: string;
  sessionId?: string;
  clientId?: string;
  timestamp: number;
}

interface McpJournalEntry {
  ts: number;
  pid: number;
  event: McpActivityEvent;
  chatLine: string;
}

const MCP_ACTIVITY_JOURNAL = path.join(os.homedir(), ".superagent-r", "mcp-activity.jsonl");

class McpActivityEmitter extends EventEmitter {}

const emitter = new McpActivityEmitter();
emitter.setMaxListeners(100);

/**
 * Format an MCP activity event into a clear, structured chat sheet string.
 */
export function formatMcpActivityForChat(event: McpActivityEvent): string {
  switch (event.type) {
    case "tool_call": {
      const tool = event.tool || "unknown_tool";
      const statusIcon = event.ok ? "✓" : "✗";
      const statusText = event.ok ? "Success" : "Failed";
      const durationStr = event.durationMs !== undefined ? ` (${event.durationMs}ms)` : "";
      const argsStr = event.args ? summarizeArgs(event.args, 250) : "{}";
      const lines = [
        `[MCP] ${event.ok ? "⚡" : "❌"} Tool Call: ${tool} [${statusIcon} ${statusText}${durationStr}]`,
        `Arguments: ${argsStr}`,
      ];
      if (!event.ok && event.error) {
        const errPreview = event.error.length > 300 ? event.error.slice(0, 297) + "..." : event.error;
        lines.push(`Error: ${errPreview}`);
      } else if (event.output) {
        const preview = event.output.length > 350 ? event.output.slice(0, 347) + "..." : event.output;
        lines.push(`Output: ${preview}`);
      }
      return lines.join("\n");
    }
    case "client_connect": {
      const sessionPart = event.sessionId ? ` (Session: ${event.sessionId.slice(0, 8)}...)` : "";
      const clientPart = event.clientId ? `\nIdentity: ${event.clientId}` : "";
      return `[MCP] 🔗 Client Connected${sessionPart}${clientPart}`;
    }
    case "client_disconnect": {
      const sessionPart = event.sessionId ? ` (Session: ${event.sessionId.slice(0, 8)}...)` : "";
      return `[MCP] 🔌 Client Disconnected${sessionPart}`;
    }
    case "tool_list": {
      return `[MCP] 📋 Tools Discovery: ${event.output || "Available tools advertised to client"}`;
    }
    case "auth": {
      return `[MCP] 🛡️ OAuth Authorized: ${event.output || `Client ${event.clientId || "unknown"}`}`;
    }
    default:
      return `[MCP] Activity: ${event.output || event.type}`;
  }
}

/**
 * Emit an MCP activity event.
 * Dispatches to all in-memory subscribers and persists to the activity journal for cross-process visibility.
 */
export function emitMcpActivity(event: McpActivityEvent): void {
  const chatLine = formatMcpActivityForChat(event);

  // In-memory dispatch
  emitter.emit("activity", event);
  emitter.emit("chat_line", chatLine, event);

  // Cross-process dispatch via append-only journal
  try {
    const dir = path.dirname(MCP_ACTIVITY_JOURNAL);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const entry: McpJournalEntry = {
      ts: event.timestamp || Date.now(),
      pid: process.pid,
      event,
      chatLine,
    };
    fs.appendFileSync(MCP_ACTIVITY_JOURNAL, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Journal write failure must never disrupt tool execution
  }
}

/**
 * Subscribe to formatted chat lines from MCP activity.
 * Handles both in-process events immediately and cross-process events via journal tailing.
 * Returns an unsubscribe cleanup function.
 */
export function subscribeToMcpActivity(onLine: (line: string, event?: McpActivityEvent) => void): () => void {
  const handler = (line: string, evt: McpActivityEvent) => {
    try {
      onLine(line, evt);
    } catch {}
  };
  emitter.on("chat_line", handler);

  // Cross-process file polling for entries written by other PIDs
  let lastFileSize = 0;
  try {
    if (fs.existsSync(MCP_ACTIVITY_JOURNAL)) {
      lastFileSize = fs.statSync(MCP_ACTIVITY_JOURNAL).size;
    }
  } catch {}

  const pollInterval = setInterval(() => {
    try {
      if (!fs.existsSync(MCP_ACTIVITY_JOURNAL)) return;
      const stat = fs.statSync(MCP_ACTIVITY_JOURNAL);
      if (stat.size <= lastFileSize) return;

      const fd = fs.openSync(MCP_ACTIVITY_JOURNAL, "r");
      const readLength = stat.size - lastFileSize;
      const buffer = Buffer.alloc(readLength);
      fs.readSync(fd, buffer, 0, readLength, lastFileSize);
      fs.closeSync(fd);
      lastFileSize = stat.size;

      const chunk = buffer.toString("utf8");
      const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry: McpJournalEntry = JSON.parse(line);
          // Only process foreign process events to avoid duplicate local dispatches
          if (entry && entry.pid !== process.pid && entry.chatLine) {
            onLine(entry.chatLine, entry.event);
          }
        } catch {}
      }
    } catch {}
  }, 1000);

  return () => {
    emitter.off("chat_line", handler);
    clearInterval(pollInterval);
  };
}

/**
 * Direct listener for raw McpActivityEvent objects.
 */
export function onMcpActivity(listener: (event: McpActivityEvent) => void): () => void {
  emitter.on("activity", listener);
  return () => {
    emitter.off("activity", listener);
  };
}
