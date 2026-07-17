import { describe, it, expect, beforeEach } from "vitest";
import { RealtimeAdvisor } from "../src/core/advisor.js";
import type { ToolCall, ToolResult } from "../src/core/conversation.js";

describe("Real-Time Execution Advisor", () => {
  let advisor: RealtimeAdvisor;

  beforeEach(() => {
    advisor = new RealtimeAdvisor();
  });

  it("should pass normal execution steps", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "glob", args: { pattern: "*.ts" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "glob", result: "index.ts, main.ts" }
    ];

    const result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pass");
  });

  it("should warn agent on 3 consecutively identical tool calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "glob", args: { pattern: "*.ts" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "glob", result: "index.ts" }
    ];

    // First call
    let result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pass");

    // Second call
    result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pass");

    // Third call
    result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("warn_agent");
    expect(result.message).toContain("executed the exact same tool calls");
    expect(result.message).toContain("glob");
  });

  it("should warn agent differently on 3 consecutively identical failing tool calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "run_command", args: { command: "npm test" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "run_command", result: "Build failed", isError: true }
    ];

    // First call
    let result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pass");

    // Second call
    result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pass");

    // Third call
    result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("warn_agent");
    expect(result.message).toContain("returned errors");
    expect(result.message).toContain("run_command");
  });

  it("should pause execution on 5 consecutively identical tool calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "glob", args: { pattern: "*.ts" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "glob", result: "index.ts" }
    ];

    for (let i = 0; i < 4; i++) {
      advisor.evaluateStep(toolCalls, toolResults);
    }

    const result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pause_execution");
    expect(result.message).toContain("infinite loop");
  });

  it("should warn immediately on unregistered or not found tool calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "invalid_tool", args: {} }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "invalid_tool", result: "Error: invalid_tool is not a registered tool", isError: true }
    ];

    const result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("warn_agent");
    expect(result.message).toContain("verify that this tool is available");
  });

  it("should warn on 5 consecutive failures across any tool calls", () => {
    const toolCalls1: ToolCall[] = [{ id: "1", name: "read", args: { path: "a.ts" } }];
    const toolResults1: ToolResult[] = [{ toolCallId: "1", name: "read", result: "error", isError: true }];
    const toolCalls2: ToolCall[] = [{ id: "2", name: "glob", args: { pattern: "*.js" } }];
    const toolResults2: ToolResult[] = [{ toolCallId: "2", name: "glob", result: "error", isError: true }];

    // 4 failures
    advisor.evaluateStep(toolCalls1, toolResults1);
    advisor.evaluateStep(toolCalls1, toolResults1);
    advisor.evaluateStep(toolCalls2, toolResults2);
    advisor.evaluateStep(toolCalls2, toolResults2);

    // 5th failure
    const result = advisor.evaluateStep(toolCalls1, toolResults1);
    expect(result.action).toBe("warn_agent");
    expect(result.message).toContain("5 consecutive tool execution errors");
  });
});
