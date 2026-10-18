import { describe, expect, it } from "vitest";
import {
  MEMORY_RECORD_SCHEMA_VERSION,
  createMemoryRecordMetadata,
  isMemoryRecordMetadata,
} from "../src/core/memoryRecord.js";

describe("versioned persistent memory record metadata", () => {
  it("creates an identity-bearing, project-scoped record with provenance", () => {
    const metadata = createMemoryRecordMetadata({
      memoryId: "build-command",
      memoryType: "decision",
      scope: "project",
      projectId: "p_project_a",
      sessionId: "session-123",
      taskId: "task-456",
      source: "rmemory_save",
      agentTier: "superagent",
      now: "2026-10-18T10:00:00.000Z",
      evidence: [{ id: "test-run-9", kind: "test", reference: "tests/build.test.ts", status: "passed" }],
    });

    expect(metadata).toMatchObject({
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
      memoryId: "build-command",
      type: "memory",
      memoryType: "decision",
      scope: "project",
      projectId: "p_project_a",
      sessionId: "session-123",
      taskId: "task-456",
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
      validationStatus: "unverified",
      provenance: {
        source: "rmemory_save",
        agentTier: "superagent",
        sessionId: "session-123",
        taskId: "task-456",
      },
      evidence: [{ id: "test-run-9", kind: "test", reference: "tests/build.test.ts", status: "passed" }],
    });
    expect(isMemoryRecordMetadata(metadata)).toBe(true);
  });

  it("omits project identity for explicit global preferences", () => {
    const metadata = createMemoryRecordMetadata({
      memoryId: "answer-style",
      memoryType: "preference",
      scope: "global",
      projectId: "must-not-leak-project",
      source: "memory-command",
      now: "2026-10-18T10:00:00.000Z",
    });

    expect(metadata.scope).toBe("global");
    expect("projectId" in metadata).toBe(false);
    expect(isMemoryRecordMetadata(metadata)).toBe(true);
  });

  it("preserves creation time on update while refreshing updated time", () => {
    const original = createMemoryRecordMetadata({
      memoryId: "decision-1",
      scope: "project",
      projectId: "p_project_a",
      source: "rmemory_save",
      now: "2026-10-01T00:00:00.000Z",
    });
    const updated = createMemoryRecordMetadata({
      memoryId: "decision-1",
      scope: "project",
      projectId: "p_project_a",
      source: "rmemory_save",
      existingMetadata: original,
      now: "2026-10-18T10:00:00.000Z",
    });

    expect(updated.createdAt).toBe("2026-10-01T00:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-10-18T10:00:00.000Z");
    expect(updated.validationStatus).toBe("unverified");
  });

  it("rejects unstable IDs and project records without canonical project identity", () => {
    expect(() => createMemoryRecordMetadata({ memoryId: "  ", scope: "global", source: "test" })).toThrow(/memoryId/i);
    expect(() => createMemoryRecordMetadata({ memoryId: "x".repeat(161), scope: "global", source: "test" })).toThrow(/160 characters/i);
    expect(() => createMemoryRecordMetadata({ memoryId: "project-note", scope: "project", source: "test" })).toThrow(/projectId/i);
  });

  it("does not treat legacy or malformed metadata as a current schema record", () => {
    expect(isMemoryRecordMetadata({ scope: "project", projectId: "p_a" })).toBe(false);
    expect(isMemoryRecordMetadata({
      schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
      memoryId: "bad-evidence",
      type: "memory",
      memoryType: "fact",
      scope: "global",
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
      validationStatus: "verified",
      provenance: { source: "test" },
      evidence: [{ id: "e", kind: "test", reference: "x".repeat(241) }],
    })).toBe(false);
    expect(isMemoryRecordMetadata({
      schemaVersion: 99,
      memoryId: "note",
      type: "memory",
      memoryType: "fact",
      scope: "global",
      createdAt: "2026-10-18T10:00:00.000Z",
      updatedAt: "2026-10-18T10:00:00.000Z",
      validationStatus: "verified",
      provenance: { source: "test" },
    })).toBe(false);
  });
});
