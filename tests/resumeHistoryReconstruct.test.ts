import { describe, it, expect } from "vitest";
import { reconstructChatLines, reconstructDashboardLogs } from "../src/utils/uiHelpers.js";
import type { Message } from "../src/core/conversation.js";

describe("reconstructChatLines", () => {
  it("reconstructs assistant tool calls and maps tool results into mergedResult", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Please check package.json",
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: "I will read package.json",
        toolCalls: [
          {
            id: "call_123",
            name: "read_file",
            args: { filePath: "package.json" },
          },
        ],
        timestamp: 1001,
      },
      {
        role: "tool",
        content: "",
        toolResults: [
          {
            toolCallId: "call_123",
            name: "read_file",
            result: '{"name": "superagent", "version": "1.0.0"}',
            isError: false,
          },
        ],
        timestamp: 1002,
      },
      {
        role: "assistant",
        content: "The package name is superagent.",
        timestamp: 1003,
      },
    ];

    const lines = reconstructChatLines(messages);
    expect(lines.length).toBe(3);

    const toolLine = lines[1];
    expect(toolLine.type).toBe("assistant");
    expect(toolLine.children).toBeDefined();
    expect(toolLine.children!.length).toBe(1);

    const child = toolLine.children![0];
    expect(child.type).toBe("tool_start");
    expect(child.mergedResult).toBeDefined();
    expect(child.mergedResult!.isError).toBe(false);
    expect(child.mergedResult!.content).toContain("superagent");
  });

  it("safely handles non-string tool results without crashing", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_obj",
            name: "get_status",
            args: {},
          },
        ],
        toolResults: [
          {
            toolCallId: "call_obj",
            name: "get_status",
            result: { status: "ok", code: 200 } as any,
          },
        ],
        timestamp: 2000,
      },
    ];

    const lines = reconstructChatLines(messages);
    expect(lines.length).toBe(1);
    expect(lines[0].children!.length).toBe(1);
    expect(lines[0].children![0].mergedResult).toBeDefined();
    expect(lines[0].children![0].mergedResult!.content).toContain('"status":"ok"');
  });

  it("handles tool results stored as JSON strings", () => {
    const messages: any[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: JSON.stringify([
          {
            id: "call_json",
            name: "list_directory",
            args: { dirPath: "." },
          },
        ]),
        toolResults: JSON.stringify([
          {
            toolCallId: "call_json",
            name: "list_directory",
            result: "file1.ts\nfile2.ts",
          },
        ]),
        timestamp: 3000,
      },
    ];

    const lines = reconstructChatLines(messages);
    expect(lines.length).toBe(1);
    expect(lines[0].children!.length).toBe(1);
    expect(lines[0].children![0].mergedResult!.content).toContain("file1.ts");
  });

  it("reconstructs standalone tool messages that lacked preceding assistant tool calls", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "run command",
        timestamp: 4000,
      },
      {
        role: "tool",
        content: "",
        toolResults: [
          {
            toolCallId: "call_orphan",
            name: "execute_command",
            result: "done successfully",
          },
        ],
        timestamp: 4001,
      },
    ];

    const lines = reconstructChatLines(messages);
    expect(lines.length).toBe(2);
    expect(lines[1].type).toBe("assistant");
    expect(lines[1].children!.length).toBe(1);
    expect(lines[1].children![0].mergedResult!.content).toContain("done successfully");
  });
});

describe("reconstructDashboardLogs", () => {
  it("generates [TOOL START] and [TOOL END] pairs for multi-agent dashboard", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: "Search for files",
        timestamp: 5000,
      },
      {
        role: "assistant",
        content: "Searching...",
        reasoning: "Let's find the files",
        toolCalls: [
          {
            id: "call_search",
            name: "find_files",
            args: { pattern: "*.ts" },
          },
        ],
        toolResults: [
          {
            toolCallId: "call_search",
            name: "find_files",
            result: "src/index.ts\nsrc/app.tsx",
            isError: false,
          },
        ],
        timestamp: 5001,
      },
      {
        role: "assistant",
        content: "Found 2 files.",
        timestamp: 5002,
      },
    ];

    const logs = reconstructDashboardLogs(messages);

    expect(logs).toContain("[USER] Search for files");
    expect(logs.some((l) => l.startsWith("[REASONING]"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[TOOL START]"))).toBe(true);
    expect(logs.some((l) => l.startsWith("[TOOL END]") && l.includes("Completed"))).toBe(true);
    expect(logs.some((l) => l.includes("src/index.ts"))).toBe(true);
    expect(logs).toContain("[AGENT] Found 2 files.");
  });

  it("handles error tool results with Failed status in dashboard logs", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_fail",
            name: "execute_command",
            args: { command: "invalid_cmd" },
          },
        ],
        toolResults: [
          {
            toolCallId: "call_fail",
            name: "execute_command",
            result: "command not found: invalid_cmd",
            isError: true,
          },
        ],
        timestamp: 6000,
      },
    ];

    const logs = reconstructDashboardLogs(messages);
    expect(logs.some((l) => l.startsWith("[TOOL START]"))).toBe(true);
    const endLog = logs.find((l) => l.startsWith("[TOOL END]"));
    expect(endLog).toBeDefined();
    expect(endLog).toContain("Failed");
    expect(endLog).toContain("command not found");
  });
});
