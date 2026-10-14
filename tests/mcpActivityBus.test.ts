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

  it("filters in-memory activity by workspace so only matching terminal receives it", () => {
    const wsA = path.resolve("D:/projects/alpha");
    const wsB = path.resolve("D:/projects/beta");

    const receivedA: string[] = [];
    const receivedB: string[] = [];

    const unsubA = subscribeToMcpActivity((line) => receivedA.push(line), { workspace: wsA });
    const unsubB = subscribeToMcpActivity((line) => receivedB.push(line), { workspace: wsB });

    try {
      emitMcpActivity({
        type: "tool_call",
        tool: "superagent_read_files",
        args: { paths: ["alpha.ts"] },
        ok: true,
        workspace: wsA,
        timestamp: Date.now(),
      });

      emitMcpActivity({
        type: "tool_call",
        tool: "superagent_write_files",
        args: { files: [{ path: "beta.ts" }] },
        ok: true,
        workspace: wsB,
        timestamp: Date.now(),
      });

      expect(receivedA.length).toBe(1);
      expect(receivedA[0]).toContain("superagent_read_files");
      expect(receivedA[0]).not.toContain("superagent_write_files");

      expect(receivedB.length).toBe(1);
      expect(receivedB[0]).toContain("superagent_write_files");
      expect(receivedB[0]).not.toContain("superagent_read_files");
    } finally {
      unsubA();
      unsubB();
    }
  });

  it("correctly identifies matching and non-matching workspaces with isWorkspaceMatch", async () => {
    const { isWorkspaceMatch } = await import("../src/core/mcp/mcpActivityBus.js");

    // Exact match
    expect(isWorkspaceMatch("D:/proj/alpha", "D:/proj/alpha")).toBe(true);

    // Case insensitivity
    if (process.platform === "win32") {
      expect(isWorkspaceMatch("d:/proj/alpha", "D:/PROJ/ALPHA")).toBe(true);
    }

    // Worktree / subfolder
    expect(isWorkspaceMatch("D:/proj/alpha/packages/core", "D:/proj/alpha")).toBe(true);
    expect(isWorkspaceMatch("D:/proj/alpha", "D:/proj/alpha/packages/core")).toBe(true);

    // Different workspaces
    expect(isWorkspaceMatch("D:/proj/alpha", "D:/proj/beta")).toBe(false);
    expect(isWorkspaceMatch("D:/proj/superagent", "D:/proj/t-line")).toBe(false);
  });
});


