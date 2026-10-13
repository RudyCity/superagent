import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { areAllTasksCompleted } from "../src/hooks/useChecklistAutoHide.js";

describe("areAllTasksCompleted helper", () => {
  it("returns false for empty task lists", () => {
    expect(areAllTasksCompleted([])).toBe(false);
    expect(areAllTasksCompleted(null as any)).toBe(false);
  });

  it("returns false when any task is pending", () => {
    const tasks = [
      { status: "x", text: "First task" },
      { status: " ", text: "Second task" },
    ];
    expect(areAllTasksCompleted(tasks)).toBe(false);
  });

  it("returns false when any task is in progress", () => {
    const tasks = [
      { status: "x", text: "First task" },
      { status: "/", text: "Active task" },
    ];
    expect(areAllTasksCompleted(tasks)).toBe(false);
  });

  it("returns false when any task has error or paused status", () => {
    expect(areAllTasksCompleted([{ status: "error", text: "Broken task" }])).toBe(false);
    expect(areAllTasksCompleted([{ status: "paused", text: "Paused task" }])).toBe(false);
  });

  it("returns true when all tasks have completed status 'x'", () => {
    const tasks = [
      { status: "x", text: "Task 1" },
      { status: "x", text: "Task 2" },
      { status: "x", text: "Task 3" },
    ];
    expect(areAllTasksCompleted(tasks)).toBe(true);
  });

  describe("multi-agent dynamic overrides", () => {
    it("treats task matching running superagent as in-progress", () => {
      const instances = new Map<string, any>();
      instances.set("inst-1", { role: "auth-feature", status: "running" });

      const tasks = [
        { status: "x", text: "Implement auth-feature" },
      ];

      // Even though task status is 'x', the matching instance is running
      expect(areAllTasksCompleted(tasks, true, instances)).toBe(false);
    });

    it("treats task matching completed superagent as completed", () => {
      const instances = new Map<string, any>();
      instances.set("inst-1", { role: "auth-feature", status: "completed" });

      const tasks = [
        { status: " ", text: "Implement auth-feature" },
      ];

      // Task status was pending ' ', but matching instance is completed
      expect(areAllTasksCompleted(tasks, true, instances)).toBe(true);
    });

    it("treats merge/cleanup task as in-progress when superagent completed", () => {
      const instances = new Map<string, any>();
      instances.set("inst-1", { role: "auth-feature", status: "completed" });

      const tasks = [
        { status: "x", text: "Merge and cleanup auth-feature" },
      ];

      // Merge/cleanup task stays in progress until explicitly resolved
      expect(areAllTasksCompleted(tasks, true, instances)).toBe(false);
    });
  });
});

describe("auto-hide decay calculations", () => {
  it("calculates remaining seconds correctly over a 5-second countdown", () => {
    const startTime = 100000;
    const delaySeconds = 5;

    const getRemaining = (now: number) => {
      const elapsed = now - startTime;
      return Math.max(0, Math.ceil((delaySeconds * 1000 - elapsed) / 1000));
    };

    expect(getRemaining(startTime)).toBe(5);
    expect(getRemaining(startTime + 1000)).toBe(4);
    expect(getRemaining(startTime + 2000)).toBe(3);
    expect(getRemaining(startTime + 3000)).toBe(2);
    expect(getRemaining(startTime + 4000)).toBe(1);
    expect(getRemaining(startTime + 5000)).toBe(0);
    expect(getRemaining(startTime + 6000)).toBe(0);
  });
});
