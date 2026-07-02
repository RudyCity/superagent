import { describe, it, expect } from "vitest";
import React from "react";
import { AgentSession } from "../src/components/multi-agent-dashboard.js";
import {
  parseLogGroups,
  computeLogGroupBoundaries,
  computeWrappedLogs,
} from "../src/utils/dashboardLogFormatter.js";

describe("dashboardLogFormatter", () => {
  const mockSession: AgentSession = {
    id: "session-1",
    type: "MASTER",
    task: "Test task",
    status: "WORKING",
    tokens: 100,
    logs: [
      "[USER] Hello there",
      "[AGENT] I will run a git command",
      "[TOOL:START] git status",
      "[TOOL:OK] Output: On branch main\nYour branch is up to date.",
      "[AGENT] Done!",
    ],
    branch: "main",
  };

  it("should parse log groups correctly and merge tool start/ok pairs", () => {
    const groups = parseLogGroups(mockSession);

    // Expected groups:
    // 0: [USER] Hello there
    // 1: [AGENT] I will run a git command
    // 2: [TOOL:START] git status (merged with [TOOL:OK])
    // 3: [AGENT] Done!
    expect(groups.length).toBe(4);

    expect(groups[0].label).toBe("👤 USER");
    expect(groups[0].rawLines).toEqual(["Hello there"]);
    expect(groups[0].groupIndex).toBe(0);

    expect(groups[1].label).toBe("🧠 AGENT");
    expect(groups[1].rawLines).toEqual(["I will run a git command"]);
    expect(groups[1].groupIndex).toBe(1);

    expect(groups[2].label).toBe("🔧 TOOL START");
    expect(groups[2].rawLines).toEqual(["git status"]);
    expect(groups[2].groupIndex).toBe(2);
    expect(groups[2].nestLevel).toBe(1); // Nested under AGENT
    expect(groups[2].mergedResult).toBeDefined();
    expect(groups[2].mergedResult?.isError).toBe(false);
    expect(groups[2].mergedResult?.lines).toEqual([
      "Output: On branch main\nYour branch is up to date.",
    ]);

    expect(groups[3].label).toBe("🧠 AGENT");
    expect(groups[3].rawLines).toEqual(["Done!"]);
    expect(groups[3].groupIndex).toBe(3);
  });

  it("should match boundary line counts between computeLogGroupBoundaries and computeWrappedLogs", () => {
    const feedWidth = 80;
    const isHistoryTruncated = false;

    // Test with all groups collapsed
    const collapsedGroups = new Set<number>();
    const boundariesCollapsed = computeLogGroupBoundaries(
      mockSession,
      feedWidth,
      isHistoryTruncated,
      collapsedGroups
    );
    const wrappedCollapsed = computeWrappedLogs(
      mockSession,
      feedWidth,
      isHistoryTruncated,
      collapsedGroups
    );

    // The last boundary's endLine should equal (wrappedCollapsed.length - 1)
    const lastBoundaryCollapsed = boundariesCollapsed[boundariesCollapsed.length - 1];
    expect(lastBoundaryCollapsed.endLine).toBe(wrappedCollapsed.length - 1);

    // Test with tool group (index 2) expanded
    const expandedGroups = new Set<number>([2]);
    const boundariesExpanded = computeLogGroupBoundaries(
      mockSession,
      feedWidth,
      isHistoryTruncated,
      expandedGroups
    );
    const wrappedExpanded = computeWrappedLogs(
      mockSession,
      feedWidth,
      isHistoryTruncated,
      expandedGroups
    );

    const lastBoundaryExpanded = boundariesExpanded[boundariesExpanded.length - 1];
    expect(lastBoundaryExpanded.endLine).toBe(wrappedExpanded.length - 1);
  });
});
