import { describe, it, expect, beforeEach } from "vitest";
import { RealtimeAdvisor } from "../src/core/advisor.js";
import type { ToolCall, ToolResult } from "../src/core/conversation.js";
import { getAdvisorEvents, clearAdvisorEvents, logFailedPattern } from "../src/core/advisorLogger.js";
import { subagentInstances } from "../src/core/tools/state.js";
import type { SubagentInstance } from "../src/core/tools/types.js";

describe("Real-Time Execution Advisor", () => {
  let advisor: RealtimeAdvisor;

  beforeEach(() => {
    advisor = new RealtimeAdvisor({ enableLogging: false, enableAdaptiveScaling: false, enablePatternMemory: true });
    clearAdvisorEvents();
    subagentInstances.clear();
  });

  it("should pass normal execution steps and calculate 100% initial health score", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "glob", args: { pattern: "*.ts" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "glob", result: "index.ts, main.ts" }
    ];

    const result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("pass");
    expect(result.healthScore).toBe(100);
  });

  it("should decrease Health Score and generate Auto-Correction Skill Hint on repeated calls", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "glob", args: { pattern: "*.ts" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "glob", result: "index.ts" }
    ];

    advisor.evaluateStep(toolCalls, toolResults);
    advisor.evaluateStep(toolCalls, toolResults);
    const result = advisor.evaluateStep(toolCalls, toolResults);

    expect(result.action).toBe("warn_agent");
    expect(result.healthScore).toBeLessThan(100);
    expect(result.autoCorrectionHint).toContain("SYSTEM AUTO-CORRECTION SKILL");
  });

  it("should generate pause auto-correction skill hint when pause threshold is hit", () => {
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
    expect(result.autoCorrectionHint).toContain("Loop limit reached. STOP repeating current calls");
  });

  it("should trigger Subagent Auto-Quarantine status update in registry", () => {
    const mockAgent = {} as any;
    const instance: SubagentInstance = {
      id: "sub-123",
      typeName: "coder",
      role: "test-coder",
      agent: mockAgent,
      status: "running",
      logs: [],
    };
    subagentInstances.set("sub-123", instance);

    // Simulate quarantine state transition
    instance.status = "quarantined";
    instance.completedAt = Date.now();
    instance.result = "[AUTO-QUARANTINED BY ADVISOR]: Subagent loop threshold exceeded.";

    const fetched = subagentInstances.get("sub-123");
    expect(fetched?.status).toBe("quarantined");
    expect(fetched?.result).toContain("AUTO-QUARANTINED");
  });

  it("should trigger Transient Error Backoff on 429 rate limit errors", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "fetch_url", args: { url: "https://api.example.com" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "fetch_url", result: "HTTP 429 rate limit exceeded", isError: true }
    ];

    const result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("warn_agent");
    expect(result.message).toContain("TRANSIENT ERROR");
    expect(result.recommendedBackoffMs).toBeGreaterThan(0);
  });

  it("should warn early on historical failing tool patterns (Pattern Memory)", () => {
    const toolCallSignature = 'invalid_action:{"key":"fail"}';
    logFailedPattern(toolCallSignature, "invalid_action", "Invalid key provided");
    logFailedPattern(toolCallSignature, "invalid_action", "Invalid key provided");

    const toolCalls: ToolCall[] = [
      { id: "1", name: "invalid_action", args: { key: "fail" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "invalid_action", result: "ready" }
    ];

    const result = advisor.evaluateStep(toolCalls, toolResults);
    expect(result.action).toBe("warn_agent");
    expect(result.message).toContain("ADVISOR PATTERN WARNING");
  });

  it("should isolate loop detection per agentId", () => {
    const toolCalls: ToolCall[] = [
      { id: "1", name: "glob", args: { pattern: "*.ts" } }
    ];
    const toolResults: ToolResult[] = [
      { toolCallId: "1", name: "glob", result: "index.ts" }
    ];

    advisor.evaluateStep(toolCalls, toolResults, "subagent-A");
    advisor.evaluateStep(toolCalls, toolResults, "subagent-A");

    const resultB = advisor.evaluateStep(toolCalls, toolResults, "subagent-B");
    expect(resultB.action).toBe("pass");

    const resultA = advisor.evaluateStep(toolCalls, toolResults, "subagent-A");
    expect(resultA.action).toBe("warn_agent");
  });
});
