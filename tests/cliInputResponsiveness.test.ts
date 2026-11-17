import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import * as inkModule from "ink";
import { MultiAgentDashboard } from "../src/components/multi-agent-dashboard.js";
import { appendDashboardLiveLog, normalizeDashboardLiveLog, MAX_DASHBOARD_LIVE_LOG_CHARS } from "../src/utils/dashboardLiveLog.js";

describe("multi-agent CLI input responsiveness", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(inkModule, "useApp").mockReturnValue({ exit: vi.fn() } as any);
    vi.spyOn(inkModule, "useInput").mockImplementation(() => {});
    vi.spyOn(inkModule, "useStdin").mockReturnValue({
      stdin: process.stdin,
      isRawMode: false,
      setRawMode: vi.fn(),
      internal_eventEmitter: { on: vi.fn(), off: vi.fn() },
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a bounded, activity-triggered log flush rather than a 0ms idle poll", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let emitLog: ((message: string) => void) | undefined;
    const agent = {
      getHistory: () => ({ getMessages: () => [] }),
      getCurrentHistoryFilePath: () => "test-session.json",
      getPlanFilePath: () => "test-plan.md",
      getTaskFilePath: () => "test-task.md",
      isAgentRunning: () => false,
    };

    const view = inkModule.render(
      React.createElement(MultiAgentDashboard, {
        agent: agent as any,
        registerLogHandler: (handler: (message: string) => void) => { emitLog = handler; },
      }),
    );

    try {
      expect(emitLog).toBeTypeOf("function");
      expect(intervalSpy.mock.calls.every(([, delay]) => delay !== 0)).toBe(true);
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 48)).toHaveLength(0);

      emitLog!("[MASTER] first");
      emitLog!("[AGENT] streaming");
      emitLog!("[AGENT] more output");

      // Multiple messages per frame must produce exactly one flush timer.
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 48)).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 90));

      emitLog!("[MASTER] next burst");
      expect(timeoutSpy.mock.calls.filter(([, delay]) => delay === 48)).toHaveLength(2);
    } finally {
      view.unmount();
    }
  });
});

describe("bounded dashboard log normalization", () => {
  it("retains the agent tag and recent output without unbounded growth", () => {
    const long = "[AGENT]" + "a".repeat(MAX_DASHBOARD_LIVE_LOG_CHARS + 200);
    const normalized = normalizeDashboardLiveLog(long);
    expect(normalized.length).toBeLessThanOrEqual(MAX_DASHBOARD_LIVE_LOG_CHARS);
    expect(normalized.startsWith("[AGENT]")).toBe(true);
    expect(normalized).toContain("older live output omitted");
    expect(normalized.endsWith("a".repeat(200))).toBe(true);
  });

  it("stays bounded across many appended streaming fragments", () => {
    let live = "[AGENT] Initial output";
    for (let i = 0; i < 100; i++) {
      live = appendDashboardLiveLog(live, "x".repeat(2000));
    }
    expect(live.length).toBeLessThanOrEqual(MAX_DASHBOARD_LIVE_LOG_CHARS);
    expect(live.startsWith("[AGENT]")).toBe(true);
    expect(live.endsWith("x".repeat(1000))).toBe(true);
  });

  it("normalizes carriage-return progress output", () => {
    const live = appendDashboardLiveLog("[AGENT] Step one\\r", "Step two");
    expect(live).not.toContain("\\r");
  });
});
