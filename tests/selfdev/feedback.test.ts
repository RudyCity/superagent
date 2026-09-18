import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FeedbackTracker } from "../../src/core/selfdev/feedback.js";

describe("SelfDev FeedbackTracker", () => {
  const workspace = "test-workspace-feedback";

  function createTestTracker(enabled = true) {
    const db = new DatabaseSync(":memory:");
    const tracker = new FeedbackTracker({
      getDb: () => db,
      enabled: () => enabled,
    });
    return { db, tracker };
  }

  it("records metrics idempotently without inflating counters on replay", () => {
    const { tracker } = createTestTracker();

    // Record 'injected' metric for session-1
    tracker.record(workspace, "session-1", "lesson-A", 1, "injected");
    // Replay identical record
    tracker.record(workspace, "session-1", "lesson-A", 1, "injected");

    const metrics1 = tracker.getMetrics(workspace, "lesson-A");
    expect(metrics1.injectedCount).toBe(1);

    // Record 'injected' for a different session
    tracker.record(workspace, "session-2", "lesson-A", 1, "injected");
    const metrics2 = tracker.getMetrics(workspace, "lesson-A");
    expect(metrics2.injectedCount).toBe(2);
  });

  it("aggregates applied, helped, and harmed metrics accurately", () => {
    const { tracker } = createTestTracker();

    tracker.record(workspace, "session-1", "lesson-B", 1, "injected");
    tracker.record(workspace, "session-1", "lesson-B", 1, "applied");
    tracker.record(workspace, "session-1", "lesson-B", 1, "helped");

    tracker.record(workspace, "session-2", "lesson-B", 1, "injected");
    tracker.record(workspace, "session-2", "lesson-B", 1, "applied");
    tracker.record(workspace, "session-2", "lesson-B", 1, "harmed");

    const metrics = tracker.getMetrics(workspace, "lesson-B");
    expect(metrics.injectedCount).toBe(2);
    expect(metrics.appliedCount).toBe(2);
    expect(metrics.helpedCount).toBe(1);
    expect(metrics.harmedCount).toBe(1);
  });

  it("returns zeros and performs no writes when disabled", () => {
    const { tracker } = createTestTracker(false);

    const ok = tracker.record(workspace, "session-1", "lesson-C", 1, "injected");
    expect(ok).toBe(false);

    const metrics = tracker.getMetrics(workspace, "lesson-C");
    expect(metrics.injectedCount).toBe(0);
    expect(metrics.appliedCount).toBe(0);
  });
});
