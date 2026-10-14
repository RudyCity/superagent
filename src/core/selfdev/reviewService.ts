import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isValidLesson } from "./lessonValidation.js";
import { MAX_REVIEW_DECISIONS } from "./candidateStore.js";
import {
  SELFDEV_LIMITS,
  SELFDEV_STORE_SCHEMA_VERSION,
  type SelfDevLesson,
  type SelfDevLessonStatus,
  type SelfDevLessonUpdate,
  type SelfDevReviewDecision,
  type SelfDevStoreData,
  type SelfDevEvent,
} from "./types.js";
import type { SelfDevEventStore } from "./eventStore.js";

export interface ReviewServiceOptions {
  storePath: string;
  enabled?: () => boolean;
  eventStore?: SelfDevEventStore;
  maxLessons?: number;
}

export interface ReviewInspectResult {
  lesson: SelfDevLesson;
  evidenceEvents?: SelfDevEvent[];
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as any).code === code;
}

function copyLesson(lesson: SelfDevLesson): SelfDevLesson {
  return JSON.parse(JSON.stringify(lesson));
}

function redactReviewReason(input: string): string {
  return input.trim()
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s)\]}]+/gi, "[URL REDACTED]")
    .slice(0, 500);
}

function appendDecision(
  data: SelfDevStoreData,
  details: Omit<SelfDevReviewDecision, "timestamp">,
): void {
  const actor = details.actor.trim().slice(0, 120) || "human_reviewer";
  const reason = details.reason === undefined ? undefined : redactReviewReason(details.reason);
  const decision: SelfDevReviewDecision = {
    workspace: details.workspace,
    lessonId: details.lessonId,
    lessonVersion: details.lessonVersion,
    action: details.action,
    actor,
    timestamp: Date.now(),
    ...(reason ? { reason } : {}),
  };
  if ((data.reviewDecisions ?? []).length >= MAX_REVIEW_DECISIONS) throw new Error("Review audit limit reached; export/retention is required before more decisions.");
  data.reviewDecisions = [...(data.reviewDecisions ?? []), decision];
}

/**
 * Service for trusted human review and lifecycle management of Self-Dev lessons.
 * Review audit records are persisted in the same atomic JSON replacement as lesson mutations.
 * Editing an active lesson demotes it to candidate and invalidates approval.
 */
export class ReviewService {
  readonly #path: string;
  readonly #enabled: () => boolean;
  readonly #eventStore?: SelfDevEventStore;
  readonly #maxLessons: number;

  constructor(options: ReviewServiceOptions) {
    if (typeof options.storePath !== "string" || !isAbsolute(options.storePath)) throw new Error("storePath must be absolute");
    this.#path = options.storePath;
    this.#enabled = options.enabled ?? (() => true);
    this.#eventStore = options.eventStore;
    this.#maxLessons = options.maxLessons ?? SELFDEV_LIMITS.MAX_LESSONS;
  }

  async list(workspace: string, status?: SelfDevLessonStatus): Promise<SelfDevLesson[]> {
    if (!this.#enabled()) return [];
    const data = await this.#read();
    return data.lessons.filter(lesson => lesson.workspace === workspace && (status === undefined || lesson.status === status));
  }

  async get(workspace: string, id: string): Promise<SelfDevLesson | undefined> {
    if (!this.#enabled()) return undefined;
    const data = await this.#read();
    const lesson = data.lessons.find(item => item.workspace === workspace && item.id === id);
    return lesson ? copyLesson(lesson) : undefined;
  }

  async inspect(workspace: string, id: string): Promise<ReviewInspectResult | undefined> {
    const lesson = await this.get(workspace, id);
    if (!lesson) return undefined;
    let evidenceEvents: SelfDevEvent[] | undefined;
    if (this.#eventStore && lesson.evidenceIds.length > 0) {
      evidenceEvents = lesson.evidenceIds
        .map(evidenceId => this.#eventStore!.get(evidenceId))
        .filter((event): event is SelfDevEvent => event !== undefined && event.workspace === workspace);
    }
    return { lesson, evidenceEvents };
  }

  async getReviewDecisions(workspace: string, limit = 50): Promise<SelfDevReviewDecision[]> {
    if (!this.#enabled() || !workspace.trim()) return [];
    const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, MAX_REVIEW_DECISIONS)) : 50;
    const data = await this.#read();
    return (data.reviewDecisions ?? [])
      .filter((item): item is SelfDevReviewDecision =>
        !!item && item.workspace === workspace &&
        typeof item.lessonId === "string" &&
        ["approved", "rejected", "retired", "edited"].includes(item.action) &&
        typeof item.actor === "string" && Number.isSafeInteger(item.timestamp))
      .slice(-safeLimit)
      .reverse()
      .map(item => ({ ...item }));
  }

  async approve(workspace: string, id: string, expectedVersion: number, approvedBy = "human_user"): Promise<SelfDevLesson> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");
    if (!approvedBy.trim()) throw new Error("Approver identifier is required");
    return this.#mutate(data => {
      const idx = data.lessons.findIndex(lesson => lesson.workspace === workspace && lesson.id === id);
      if (idx < 0) throw new Error("Lesson not found");
      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status !== "candidate") throw new Error(`Cannot approve lesson with status: ${current.status}`);
      if (this.#eventStore &&
          (!current.evidenceIds.length || current.evidenceIds.some(evidenceId => !this.#eventStore!.hasEvidence(evidenceId)))) {
        throw new Error("Cannot approve lesson: supporting evidence is missing or invalid");
      }
      const now = Date.now();
      const updated: SelfDevLesson = {
        ...copyLesson(current),
        status: "active",
        version: current.version + 1,
        approvedBy: approvedBy.trim().slice(0, 120),
        approvedAt: now,
        updatedAt: Math.max(now, current.updatedAt),
      };
      if (!isValidLesson(updated)) throw new Error("Invalid lesson after approval");
      data.lessons[idx] = updated;
      appendDecision(data, {
        workspace, lessonId: current.id, lessonVersion: current.version,
        action: "approved", actor: approvedBy, reason: "Approved after evidence review.",
      });
      return copyLesson(updated);
    });
  }

  async reject(
    workspace: string,
    id: string,
    expectedVersion: number,
    reason = "rejected_by_user",
    rejectedBy = "human_reviewer",
  ): Promise<void> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");
    await this.#mutate(data => {
      const idx = data.lessons.findIndex(lesson => lesson.workspace === workspace && lesson.id === id);
      if (idx < 0) throw new Error("Lesson not found");
      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status !== "candidate") throw new Error(`Cannot reject non-candidate lesson: ${current.status}`);
      appendDecision(data, {
        workspace, lessonId: current.id, lessonVersion: current.version,
        action: "rejected", actor: rejectedBy, reason,
      });
      data.lessons.splice(idx, 1);
    });
  }

  async retire(
    workspace: string,
    id: string,
    expectedVersion: number,
    reason: string,
    retiredBy = "human_reviewer",
  ): Promise<SelfDevLesson> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");
    if (!reason.trim()) throw new Error("Retirement reason is required");
    return this.#mutate(data => {
      const idx = data.lessons.findIndex(lesson => lesson.workspace === workspace && lesson.id === id);
      if (idx < 0) throw new Error("Lesson not found");
      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status !== "active") throw new Error(`Cannot retire lesson with status: ${current.status}`);
      const now = Date.now();
      const updated: SelfDevLesson = {
        ...copyLesson(current),
        status: "retired",
        version: current.version + 1,
        retiredAt: now,
        retiredReason: redactReviewReason(reason).slice(0, SELFDEV_LIMITS.MAX_RATIONALE_LENGTH),
        updatedAt: Math.max(now, current.updatedAt),
      };
      if (!isValidLesson(updated)) throw new Error("Invalid lesson after retirement");
      data.lessons[idx] = updated;
      appendDecision(data, {
        workspace, lessonId: current.id, lessonVersion: current.version,
        action: "retired", actor: retiredBy, reason,
      });
      return copyLesson(updated);
    });
  }

  async edit(
    workspace: string,
    id: string,
    expectedVersion: number,
    patch: SelfDevLessonUpdate,
    editedBy = "human_reviewer",
  ): Promise<SelfDevLesson> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");
    return this.#mutate(data => {
      const idx = data.lessons.findIndex(lesson => lesson.workspace === workspace && lesson.id === id);
      if (idx < 0) throw new Error("Lesson not found");
      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status === "retired") throw new Error("Cannot edit a retired lesson");
      const nextStatement = patch.statement !== undefined ? patch.statement.trim() : current.statement;
      const nextRationale = patch.rationale !== undefined ? patch.rationale.trim() : current.rationale;
      const nextEvidence = patch.evidenceIds !== undefined ? [...patch.evidenceIds] : current.evidenceIds;
      const nextTags = patch.tags !== undefined ? [...patch.tags] : current.tags;
      const now = Date.now();
      const updated: SelfDevLesson = {
        id: current.id,
        workspace: current.workspace,
        statement: nextStatement,
        ...(nextRationale !== undefined ? { rationale: nextRationale } : {}),
        evidenceIds: nextEvidence,
        tags: nextTags,
        version: current.version + 1,
        status: "candidate",
        createdAt: current.createdAt,
        updatedAt: Math.max(now, current.updatedAt),
      };
      if (!isValidLesson(updated)) throw new Error("Invalid lesson after edit");
      data.lessons[idx] = updated;
      appendDecision(data, {
        workspace, lessonId: current.id, lessonVersion: current.version,
        action: "edited", actor: editedBy, reason: "Lesson edited; any previous approval was cleared.",
      });
      return copyLesson(updated);
    });
  }

  async #read(): Promise<SelfDevStoreData> {
    const file = await open(this.#path, "r").catch(error => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!file) return { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: 0, lessons: [], reviewDecisions: [] };
    try {
      const stat = await file.stat();
      if (stat.size > 16 * 1024 * 1024) throw new Error("Store file too large");
      const content = await file.readFile("utf8");
      if (!content.trim()) return { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: 0, lessons: [], reviewDecisions: [] };
      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).lessons)) throw new Error("Invalid store structure");
      const record = parsed as SelfDevStoreData;
      if (record.reviewDecisions !== undefined && !Array.isArray(record.reviewDecisions)) throw new Error("Invalid review audit data");
      return record;
    } finally {
      await file.close();
    }
  }

  async #mutate<T>(mutator: (data: SelfDevStoreData) => T): Promise<T> {
    const lockPath = this.#path + ".lock";
    let lockFd;
    const start = Date.now();
    while (!lockFd && Date.now() - start < 5000) {
      try {
        lockFd = await open(lockPath, "wx");
      } catch (error) {
        if (hasCode(error, "EEXIST")) {
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }
        throw error;
      }
    }
    if (!lockFd) throw new Error("Could not acquire store lock");
    try {
      const data = await this.#read();
      const result = mutator(data);
      const resultTime = result && typeof result === "object" && "updatedAt" in result &&
        typeof (result as { updatedAt?: unknown }).updatedAt === "number" ? (result as { updatedAt: number }).updatedAt : 0;
      data.updatedAt = Math.max(Date.now(), data.updatedAt, resultTime);
      const tempPath = `${this.#path}.${randomUUID()}.tmp`;
      const tmpFile = await open(tempPath, "w");
      let renamed = false;
      try {
        await tmpFile.writeFile(JSON.stringify(data, null, 2), "utf8");
        await tmpFile.sync();
      } finally {
        await tmpFile.close();
      }
      try {
        await rename(tempPath, this.#path);
        renamed = true;
      } finally {
        if (!renamed) await unlink(tempPath).catch(() => {});
      }
      return result;
    } finally {
      await lockFd.close();
      await unlink(lockPath).catch(() => {});
    }
  }
}
