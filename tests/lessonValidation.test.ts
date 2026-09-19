import { describe, expect, it } from "vitest";
import { isValidLesson } from "../src/core/selfdev/lessonValidation.js";
import { SELFDEV_LIMITS } from "../src/core/selfdev/types.js";

const candidate = () => ({
  id: "lesson-1", version: 1, status: "candidate", workspace: "workspace-1",
  statement: "Run focused tests after changing a parser.", evidenceIds: ["event-1"],
  tags: ["testing"], createdAt: 100, updatedAt: 300,
});
const active = () => ({ ...candidate(), status: "active", approvedBy: "human-1", approvedAt: 200 });

describe("isValidLesson", () => {
  it("accepts valid lifecycle structures without changing the input", () => {
    const lesson = Object.freeze(candidate());
    expect(isValidLesson(lesson)).toBe(true);
    expect(lesson).toEqual(candidate());
    expect(isValidLesson(active())).toBe(true);
    expect(isValidLesson({ ...active(), status: "retired", retiredAt: 300 })).toBe(true);
  });

  it("accepts exact size limits and zero timestamps", () => {
    expect(isValidLesson({
      ...candidate(),
      statement: "s".repeat(SELFDEV_LIMITS.MAX_STATEMENT_LENGTH),
      rationale: "r".repeat(SELFDEV_LIMITS.MAX_RATIONALE_LENGTH),
      evidenceIds: Array.from({ length: SELFDEV_LIMITS.MAX_EVIDENCE_ITEMS }, (_, i) =>
        String(i).padStart(SELFDEV_LIMITS.MAX_EVIDENCE_ID_LENGTH, "e")),
      tags: Array.from({ length: SELFDEV_LIMITS.MAX_TAGS }, (_, i) =>
        String(i).padStart(SELFDEV_LIMITS.MAX_TAG_LENGTH, "t")),
      createdAt: 0, updatedAt: 0,
    })).toBe(true);
  });

  it("allows retirement of a candidate without fabricating approval", () => {
    expect(isValidLesson({ ...candidate(), status: "retired", retiredAt: 300 })).toBe(true);
  });

  for (const value of [null, undefined, [], "lesson", 1, {}]) {
    it(`rejects non-lessons: ${JSON.stringify(value)}`, () => {
      expect(isValidLesson(value)).toBe(false);
    });
  }

  it.each([
    { id: " " }, { workspace: "" }, { statement: " " },
    { statement: "x".repeat(SELFDEV_LIMITS.MAX_STATEMENT_LENGTH + 1) },
    { version: 0 }, { version: 1.5 }, { version: "1" }, { version: Infinity },
    { status: "approved" }, { createdAt: NaN }, { updatedAt: 99 },
    { evidenceIds: [] }, { evidenceIds: [" "] }, { evidenceIds: ["event-1", "event-1"] },
    { evidenceIds: new Array(1) },
    { evidenceIds: Array.from({ length: SELFDEV_LIMITS.MAX_EVIDENCE_ITEMS + 1 }, (_, i) => `event-${i}`) },
    { tags: [42] }, { tags: ["x".repeat(SELFDEV_LIMITS.MAX_TAG_LENGTH + 1)] },
    { rationale: 42 }, { retiredAt: 300 }, { retiredReason: "obsolete" },
    { approvedBy: "human-1", approvedAt: 200 },
  ])("rejects malformed candidate fields: %j", patch => {
    expect(isValidLesson({ ...candidate(), ...patch })).toBe(false);
  });

  it.each([
    { approvedBy: undefined }, { approvedBy: " " }, { approvedAt: undefined },
    { approvedAt: "200" }, { approvedAt: 99 }, { approvedAt: 301 },
  ])("rejects incomplete or inconsistent approval metadata: %j", patch => {
    expect(isValidLesson({ ...active(), ...patch })).toBe(false);
  });

  it("rejects active lessons with no approval metadata", () => {
    expect(isValidLesson({ ...candidate(), status: "active" })).toBe(false);
  });

  it.each([undefined, 99, 199, 301, Infinity])("rejects invalid retirement time: %j", retiredAt => {
    expect(isValidLesson({ ...active(), status: "retired", retiredAt })).toBe(false);
  });
});
