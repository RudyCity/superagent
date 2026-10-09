import { describe, it, expect, beforeEach } from "vitest";
import { RealtimeAdvisor } from "../src/core/advisor.js";
import {
  sanitizeToolArgsForFingerprint,
  sortedJsonStringify,
  buildCallKey,
  detectCycle,
  computeResultSignature,
  type HistoryEntry,
} from "../src/core/advisorHelpers.js";
import {
  logAdvisorEvent,
  getAdvisorEvents,
  clearAdvisorEvents,
  getAdvisorMetrics,
} from "../src/core/advisorLogger.js";
import type { ToolCall, ToolResult } from "../src/core/conversation.js";

describe("RealtimeAdvisor - Performance & Architecture Optimizations", () => {
  beforeEach(() => {
    clearAdvisorEvents();
  });

  it("sanitizes huge tool arguments to prevent CPU and memory bloat", () => {
    const hugePayload = "A".repeat(500000); // 500KB string
    const sanitized = sanitizeToolArgsForFingerprint({
      TargetFile: "src/large.ts",
      CodeContent: hugePayload,
      nested: { content: hugePayload },
    }) as any;

    expect(sanitized.TargetFile).toBe("src/large.ts");
    expect(sanitized.CodeContent.length).toBeLessThan(200);
    expect(sanitized.CodeContent).toContain("...[len:500000]");
    expect(sanitized.nested.content.length).toBeLessThan(200);
  });

  it("buildCallKey produces fast deterministic sorted keys with large arguments", () => {
    const hugePayload = "X".repeat(200000);
    const toolCalls: ToolCall[] = [
      { id: "1", name: "write_to_file", args: { TargetFile: "file.ts", CodeContent: hugePayload } },
    ];

    const key = buildCallKey(toolCalls);
    expect(key).toContain("write_to_file:");
    expect(key).toContain("file.ts");
    expect(key.length).toBeLessThan(300);
  });

  it("bounds recentReads memory map per agent", () => {
    const advisor = new RealtimeAdvisor({
      warningThreshold: 10,
      pauseThreshold: 20,
    });

    for (let i = 0; i < 150; i++) {
      advisor.evaluateStep(
        [{ id: `read-${i}`, name: "read", args: { filePath: `src/file_${i}.ts` } }],
        [{ toolCallId: `read-${i}`, name: "read", result: `content ${i}` }]
      );
    }

    const health = advisor.getHealthScore();
    expect(health).toBe(100);
  });

  it("bounds tracked agent states to prevent leaks from ephemeral subagents", () => {
    const advisor = new RealtimeAdvisor();

    for (let i = 0; i < 40; i++) {
      advisor.evaluateStep(
        [{ id: "1", name: "view_file", args: { filePath: "src/index.ts" } }],
        [{ toolCallId: "1", name: "view_file", result: "ok" }],
        `subagent-${i}`
      );
    }

    // Still evaluates accurately
    const evalResult = advisor.evaluateStep(
      [{ id: "2", name: "view_file", args: { filePath: "src/index.ts" } }],
      [{ toolCallId: "2", name: "view_file", result: "ok" }],
      "subagent-39"
    );
    expect(evalResult.action).toBe("pass");
  });

  it("in-memory event logging operates without blocking and provides fast metrics", () => {
    logAdvisorEvent({
      agentId: "single",
      action: "warn_agent",
      reason: "alternating_loop_warning",
      toolNames: ["control_chrome_cdp"],
      consecutiveCount: 3,
      message: "Browser audit warning",
      suggestion: "Navigate to next page",
    });

    const events = getAdvisorEvents(10);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[events.length - 1].reason).toBe("alternating_loop_warning");

    const metrics = getAdvisorMetrics();
    expect(metrics.totalWarnings).toBeGreaterThanOrEqual(1);
    expect(metrics.reasonsCount["alternating_loop_warning"]).toBeGreaterThanOrEqual(1);
  });

  it("resets advisor logs and caches cleanly via clearAdvisorEvents", () => {
    logAdvisorEvent({
      action: "warn_agent",
      reason: "loop_warning",
      message: "test",
    });

    expect(getAdvisorEvents().length).toBeGreaterThan(0);
    const cleared = clearAdvisorEvents();
    expect(cleared).toBe(true);
    expect(getAdvisorEvents().length).toBe(0);
  });
});
