import { describe, expect, it } from "vitest";
import {
  assessMemoryFreshness,
  buildCompletedTaskSummary,
  detectScopedMemoryConflicts,
  previewMemoryRetention,
  redactMemorySecrets,
} from "../src/core/memoryLifecycle.js";

const now = "2026-10-18T00:00:00.000Z";
const old = "2026-01-01T00:00:00.000Z";
const project = (id: string, content: string, metadata: Record<string, unknown> = {}) => ({
  id, content, scope: "project" as const,
  metadata: { scope: "project", projectId: "p-a", createdAt: old, updatedAt: old, ...metadata },
});

describe("memory lifecycle and recall policy", () => {
  it("applies type-aware freshness without aging out durable preferences", () => {
    const temporary = project("incident", "incident", { memoryType: "temporary" });
    const durable = project("preference", "prefers short reports", { memoryType: "preference", validationStatus: "verified" });
    expect(assessMemoryFreshness(temporary, now)).toMatchObject({ state: "stale", shouldInject: false, reason: "type_specific_freshness_interval_exceeded_7_days" });
    expect(assessMemoryFreshness(durable, now)).toMatchObject({ state: "fresh", shouldInject: true });
  });

  it("never lets age promote an unverified item and excludes quarantined/conflicted/superseded items from injection", () => {
    expect(assessMemoryFreshness(project("u", "old", { validationStatus: "unverified" }), now).state).toBe("unverified");
    expect(assessMemoryFreshness(project("q", "legacy", { reviewState: "quarantined" }), now).shouldInject).toBe(false);
    expect(assessMemoryFreshness(project("c", "one", { lifecycleState: "conflicted" }), now).state).toBe("conflicted");
    expect(assessMemoryFreshness(project("s", "old", { lifecycleState: "superseded" }), now).state).toBe("superseded");
    expect(assessMemoryFreshness(project("x", "expired", { expiresAt: "2026-10-01T00:00:00.000Z" }), now).state).toBe("expired");
  });

  it("detects only explicit same-key conflicts inside the identical scope", () => {
    const conflicts = detectScopedMemoryConflicts([
      project("a", "Runtime uses node 20", { assertionKey: "runtime-version" }),
      project("b", "Runtime uses node 22", { assertionKey: "runtime-version" }),
      { id: "other-project", content: "Runtime uses node 18", scope: "project", metadata: { scope: "project", projectId: "p-b", assertionKey: "runtime-version" } },
      project("same", "Runtime uses node 20", { assertionKey: "runtime-version" }),
      project("no-key", "Runtime uses node 16"),
    ]);
    expect(conflicts).toEqual([{ assertionKey: "runtime-version", scopeKey: "project:p-a", memoryIds: ["a", "b"] }]);
  });

  it("previews stale marking without deleting or touching quarantined/durable memories", () => {
    const preview = previewMemoryRetention([
      project("old-temp", "old incident", { retentionClass: "temporary" }),
      project("owner-review", "unclear", { retentionClass: "temporary", reviewState: "quarantined" }),
      project("durable", "stable pref", { retentionClass: "durable", validationStatus: "verified" }),
    ], { now });
    expect(preview).toMatchObject({ scanned: 3, eligibleToMarkStale: 1, skippedQuarantined: 1, byScope: { project: 1, global: 0 } });
    expect(preview.items[0]).toMatchObject({ id: "old-temp", reason: "type_specific_freshness_interval_exceeded_7_days" });
  });

  it("redacts cookies, credential-bearing URLs, and sensitive command flags", () => {
    const redacted = redactMemorySecrets([
      "cookie=SESSION_COOKIE_VALUE",
      "postgres://user:password123@db.internal/test",
      "--token sk-proj-AbCdEfGhIjKlMnOp",
    ].join(String.fromCharCode(10)));
    expect(redacted).not.toContain("SESSION_COOKIE_VALUE");
    expect(redacted).not.toContain("password123");
    expect(redacted).not.toContain("sk-proj-AbCdEfGhIjKlMnOp");
    expect(redacted).toContain("REDACTED_COOKIE");
    expect(redacted).toContain("REDACTED_CONNECTION_STRING");
  });

  it("builds a summary only for a recorded completed task and persisted same-task evidence, with redaction", () => {
    const common = {
      taskId: "task-1", projectId: "p-a", terminalEventPersisted: true,
      terminalEvent: { id: "event-1", kind: "task_completed", payload: { taskId: "task-1" }, summary: "Completed with api_key=topsecretvalue" },
      evidence: [
        { id: "test-1", taskId: "task-1", persisted: true, kind: "test_result", verifiedSuccess: true },
        { id: "test-2", taskId: "task-2", persisted: true, kind: "test_result", verifiedSuccess: true },
        { id: "missing", taskId: "task-1", persisted: false, kind: "build_result" },
      ],
    };
    expect(buildCompletedTaskSummary({ ...common, terminalEventPersisted: false })).toBeNull();
    expect(buildCompletedTaskSummary({ ...common, terminalEvent: { ...common.terminalEvent, kind: "task_failed" } })).toBeNull();
    const summary = buildCompletedTaskSummary(common)!;
    expect(summary.evidenceIds).toEqual(["test-1"]);
    expect(summary.validationStatus).toBe("verified");
    expect(summary.summary).not.toContain("topsecretvalue");
    const failedCheck = buildCompletedTaskSummary({ ...common, evidence: [{ id: "failed-test", taskId: "task-1", persisted: true, kind: "test_result", verifiedSuccess: false }] });
    expect(failedCheck?.validationStatus).toBe("unverified");
    const mixedChecks = buildCompletedTaskSummary({ ...common, evidence: [
      { id: "passed-test", taskId: "task-1", persisted: true, kind: "test_result", verifiedSuccess: true },
      { id: "failed-build", taskId: "task-1", persisted: true, kind: "build_result", verifiedSuccess: false },
    ] });
    expect(mixedChecks?.validationStatus).toBe("unverified");
  });
});
