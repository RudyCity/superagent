import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { FeedbackTracker } from "../../src/core/selfdev/feedback.js";

describe("Selfdev feedback extended contract", () => {
  const dbs: DatabaseSync[] = [];
  const create = (enabled = true) => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    return { db, tracker: new FeedbackTracker({ getDb: () => db as any, enabled: () => enabled }) };
  };
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it("reports new insert separately from duplicate, disabled, and invalid feedback", () => {
    const { tracker } = create();
    expect(tracker.recordDetailed("w", "s", "lesson", 1, "injected")).toEqual({ status: "recorded" });
    expect(tracker.recordDetailed("w", "s", "lesson", 1, "injected")).toEqual({ status: "duplicate" });
    expect(tracker.recordDetailed("", "s", "lesson", 1, "injected")).toEqual({ status: "invalid_input" });
    const { tracker: disabled } = create(false);
    expect(disabled.recordDetailed("w", "s", "lesson", 1, "helped")).toEqual({ status: "disabled" });
  });

  it("provides per-lesson metrics and last-recorded timestamp within exact workspace", () => {
    const { tracker } = create();
    tracker.record("workspace-a", "session-a", "lesson-a", 1, "injected");
    tracker.record("workspace-a", "session-a", "lesson-a", 1, "applied");
    tracker.record("workspace-a", "session-b", "lesson-a", 1, "helped");
    tracker.record("workspace-b", "session-c", "lesson-a", 1, "harmed");
    const metrics = tracker.listMetrics("workspace-a");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ lessonId: "lesson-a", injectedCount: 1, appliedCount: 1, helpedCount: 1, harmedCount: 0 });
    expect(metrics[0].lastRecordedAt).toBeGreaterThan(0);
    expect(tracker.getRecordCount("workspace-a")).toBe(3);
    expect(tracker.getRecordCount("workspace-b")).toBe(1);
  });

  it("restores records only into an empty exact workspace and preserves original timestamps", () => {
    const { tracker } = create();
    const records = [{ workspace: "w", sessionId: "s1", lessonId: "l1", version: 2, metric: "helped" as const, ts: 123456 }];
    expect(tracker.restoreRecords("w", records)).toBe(1);
    expect(tracker.listRecords("w")).toEqual(records);
    expect(() => tracker.restoreRecords("w", records)).toThrow(/empty target/i);
    expect(() => tracker.restoreRecords("other", records)).toThrow(/workspace mismatch/i);
  });
});
