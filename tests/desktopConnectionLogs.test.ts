import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { queryConnectionLogs } from "../src/core/runtime/desktopConnectionLogs.js";

describe("desktopConnectionLogs engine", () => {
  it("filters and sorts logs across mocked sources in test directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sa-test-conn-"));
    const logsDir = path.join(tempDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true });

    // Mock delegate log file
    const delegateLog = path.join(logsDir, "delegate-connections-2026-11-04.jsonl");
    fs.writeFileSync(
      delegateLog,
      [
        JSON.stringify({
          timestamp: "2026-11-04T08:00:00.000Z",
          event: "socket_open",
          listenerPort: 17341,
          endpoint: "ws://127.0.0.1:17341",
          remoteAddress: "127.0.0.1",
          remotePort: 52000,
        }),
        JSON.stringify({
          timestamp: "2026-11-04T08:00:05.000Z",
          event: "connected",
          listenerPort: 17341,
          endpoint: "ws://127.0.0.1:17341",
          clientId: "client-omega",
          profileLabel: "Chrome Beta",
          connectedDurationMs: 3500,
        }),
        JSON.stringify({
          timestamp: "2026-11-04T08:00:10.000Z",
          event: "handshake_rejected",
          listenerPort: 17341,
          endpoint: "ws://127.0.0.1:17341",
          reasonCode: "TOKEN_EXPIRED",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    // Mock MCP activity
    const mcpLog = path.join(tempDir, "mcp-activity.jsonl");
    fs.writeFileSync(
      mcpLog,
      JSON.stringify({
        ts: 1793779215000,
        pid: 9999,
        event: {
          type: "tool_call",
          tool: "superagent_read_file",
          ok: true,
          durationMs: 45,
        },
        chatLine: "[MCP] Read file operation",
      }) + "\n",
      "utf8",
    );

    // Query 1: All items
    const res1 = queryConnectionLogs({}, tempDir);
    expect(res1.totalCount).toBe(4);
    expect(res1.items.length).toBe(4);
    expect(res1.sourceStats.delegate).toBe(3);
    expect(res1.sourceStats.mcp).toBe(1);
    expect(res1.directionStats.in).toBe(3);
    expect(res1.directionStats.out).toBe(1);

    // Query 2: Filter direction = "out"
    const res2 = queryConnectionLogs({ direction: "out" }, tempDir);
    expect(res2.totalCount).toBe(1);
    expect(res2.items[0].source).toBe("mcp");
    expect(res2.items[0].event).toBe("tool_call:superagent_read_file");

    // Query 3: Search for "TOKEN_EXPIRED"
    const res3 = queryConnectionLogs({ search: "token_expired" }, tempDir);
    expect(res3.totalCount).toBe(1);
    expect(res3.items[0].event).toBe("handshake_rejected");
    expect(res3.items[0].status).toBe("error");

    // Query 4: Pagination
    const res4 = queryConnectionLogs({ page: 1, pageSize: 2 }, tempDir);
    expect(res4.totalCount).toBe(4);
    expect(res4.pageSize).toBe(2);
    expect(res4.totalPages).toBe(2);
    expect(res4.items.length).toBe(2);
    expect(res4.hasNext).toBe(true);

    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
