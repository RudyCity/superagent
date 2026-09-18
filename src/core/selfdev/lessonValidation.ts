import { SELFDEV_LIMITS as limits, type SelfDevLesson } from "./types.js";

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function strings(value: unknown, maxItems: number, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems &&
    Array.from(value).every(item => text(item, maxLength)) && new Set(value).size === value.length;
}

/**
 * Validate persisted lesson structure without coercion or mutation.
 * Approval metadata is not proof of human authorization; evidence existence,
 * workspace ownership, and revision-bound approval require trusted services.
 */
export function isValidLesson(value: unknown): value is SelfDevLesson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const lesson = value as Record<string, unknown>;
  if (!text(lesson.id, limits.MAX_CONTEXT_ID_LENGTH) ||
      !timestamp(lesson.version) || lesson.version < 1 ||
      !["candidate", "active", "retired"].includes(lesson.status as string) ||
      !text(lesson.workspace, limits.MAX_CONTEXT_ID_LENGTH) ||
      !text(lesson.statement, limits.MAX_STATEMENT_LENGTH) ||
      (lesson.rationale !== undefined && !text(lesson.rationale, limits.MAX_RATIONALE_LENGTH)) ||
      !strings(lesson.evidenceIds, limits.MAX_EVIDENCE_ITEMS, limits.MAX_EVIDENCE_ID_LENGTH) ||
      lesson.evidenceIds.length === 0 ||
      !strings(lesson.tags, limits.MAX_TAGS, limits.MAX_TAG_LENGTH) ||
      !timestamp(lesson.createdAt) || !timestamp(lesson.updatedAt) ||
      lesson.updatedAt < lesson.createdAt) return false;

  const hasApproval = lesson.approvedBy !== undefined || lesson.approvedAt !== undefined;
  if (hasApproval && (!text(lesson.approvedBy, limits.MAX_CONTEXT_ID_LENGTH) ||
      !timestamp(lesson.approvedAt) || lesson.approvedAt < lesson.createdAt ||
      lesson.approvedAt > lesson.updatedAt)) return false;
  if (lesson.status === "active" && !hasApproval) return false;
  if (lesson.status === "candidate" && hasApproval) return false;

  if (lesson.retiredReason !== undefined &&
      !text(lesson.retiredReason, limits.MAX_RATIONALE_LENGTH)) return false;
  if (lesson.status === "retired") {
    return timestamp(lesson.retiredAt) && lesson.retiredAt >= lesson.createdAt &&
      lesson.retiredAt <= lesson.updatedAt &&
      (!hasApproval || lesson.retiredAt >= (lesson.approvedAt as number));
  }
  return lesson.retiredAt === undefined && lesson.retiredReason === undefined;
}
