import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  formatMcpActivityForChat,
  emitMcpActivity,
  subscribeToMcpActivity,
  onMcpActivity,
  type McpActivityEvent,
} from "../src/core/mcp/mcpActivityBus.js";

describe("mcpActivityBus", () => {
  it("formats successful tool_call event with arguments and output preview", () => {
    const event: McpActivityEvent = {
      type: "tool_call",
      tool: "superagent_read_file",
      args: { path: "package.json" },
      ok: true,
      durationMs: 42,
      output: '{"name": "superagent"}',
      timestamp: Date.now(),
    };
    const formatted = formatMcpActivityForChat(event);
    expect(formatted).toContain("[MCP] ⚡ Tool Call: superagent_read_file [✓ Success (42ms)]");
    expect(formatted).toContain('Arguments: {"path":"package.json"}');
    expect(formatted).toContain('Output: {"name": "superagent"}');
  });

  it("formats failed tool_call event with error message", () => {
    const event: McpActivityEvent = {
      type: "tool_call",
      tool: "superagent_exec_command",
      args: { command: "exit 1" },
      ok: false,
      durationMs: 15,
      error: "Command failed with exit code 1",
      timestamp: Date.now(),
    };
    const formatted = formatMcpActivityForChat(event);
    expect(formatted).toContain("[MCP] ❌ Tool Call: superagent_exec_command [✗ Failed (15ms)]");
    expect(formatted).toContain('Arguments: {"command":"exit 1"}');
    expect(formatted).toContain("Error: Command failed with exit code 1");
  });

  it("formats client_connect and client_disconnect events", () => {
    const connectEvt: McpActivityEvent = {
      type: "client_connect",
      sessionId: "session-12345678",
      clientId: "chatgpt",
      timestamp: Date.now(),
    };
    const formattedConnect = formatMcpActivityForChat(connectEvt);
    expect(formattedConnect).toContain("[MCP] 🔗 Client Connected (Session: session-...)");
    expect(formattedConnect).toContain("Identity: chatgpt");

    const disconnectEvt: McpActivityEvent = {
      type: "client_disconnect",
      sessionId: "session-12345678",
      timestamp: Date.now(),
    };
    const formattedDisconnect = formatMcpActivityForChat(disconnectEvt);
    expect(formattedDisconnect).toContain("[MCP] 🔌 Client Disconnected (Session: session-...)");
  });

  it("broadcasts event to in-memory listeners and cleans up on unsubscribe", () => {
    const received: string[] = [];
    const unsubscribe = subscribeToMcpActivity((line) => {
      received.push(line);
    });

    emitMcpActivity({
      type: "tool_call",
      tool: "superagent_list_files",
      args: { directory: "." },
      ok: true,
      durationMs: 10,
      output: "10 files found",
      timestamp: Date.now(),
    });

    expect(received.length).toBe(1);
    expect(received[0]).toContain("superagent_list_files");

    unsubscribe();

    emitMcpActivity({
      type: "tool_call",
      tool: "superagent_get_status",
      ok: true,
      timestamp: Date.now(),
    });

    // Should not receive any more events after unsubscribe
    expect(received.length).toBe(1);
  });
});
