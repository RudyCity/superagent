import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isValidLesson } from "./lessonValidation.js";
import {
  SELFDEV_LIMITS,
  SELFDEV_STORE_SCHEMA_VERSION,
  type SelfDevLesson,
  type SelfDevLessonStatus,
  type SelfDevLessonUpdate,
  type SelfDevStoreData,
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
  evidenceEvents?: unknown[];
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as any).code === code;
}

function copyLesson(lesson: SelfDevLesson): SelfDevLesson {
  return JSON.parse(JSON.stringify(lesson));
}

/**
 * Service for trusted human review and lifecycle management of Self-Dev lessons.
 * Lifecycle: candidate -> active -> retired.
 * Editing an active lesson resets its status to candidate, invalidating approval.
 */
export class ReviewService {
  readonly #path: string;
  readonly #enabled: () => boolean;
  readonly #eventStore?: SelfDevEventStore;
  readonly #maxLessons: number;

  constructor(options: ReviewServiceOptions) {
    if (typeof options.storePath !== "string" || !isAbsolute(options.storePath)) {
      throw new Error("storePath must be absolute");
    }
    this.#path = options.storePath;
    this.#enabled = options.enabled ?? (() => true);
    this.#eventStore = options.eventStore;
    this.#maxLessons = options.maxLessons ?? SELFDEV_LIMITS.MAX_LESSONS;
  }

  async list(workspace: string, status?: SelfDevLessonStatus): Promise<SelfDevLesson[]> {
    if (!this.#enabled()) return [];
    const data = await this.#read();
    return data.lessons.filter(l => l.workspace === workspace && (status === undefined || l.status === status));
  }

  async get(workspace: string, id: string): Promise<SelfDevLesson | undefined> {
    if (!this.#enabled()) return undefined;
    const data = await this.#read();
    return data.lessons.find(l => l.workspace === workspace && l.id === id);
  }

  async inspect(workspace: string, id: string): Promise<ReviewInspectResult | undefined> {
    const lesson = await this.get(workspace, id);
    if (!lesson) return undefined;

    let evidenceEvents: unknown[] | undefined;
    if (this.#eventStore && lesson.evidenceIds.length > 0) {
      evidenceEvents = lesson.evidenceIds
        .map(eid => this.#eventStore!.get(eid))
        .filter(Boolean);
    }

    return {
      lesson,
      evidenceEvents,
    };
  }

  /**
   * Approves a candidate lesson and activates it.
   * Enforces:
   * - Must be currently in candidate status.
   * - Version must match expectedVersion.
   * - Sets approvedBy and approvedAt.
   * - Increments version.
   */
  async approve(
    workspace: string,
    id: string,
    expectedVersion: number,
    approvedBy: string = "human_user"
  ): Promise<SelfDevLesson> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");
    if (!approvedBy.trim()) throw new Error("Approver identifier is required");

    return this.#mutate(data => {
      const idx = data.lessons.findIndex(l => l.workspace === workspace && l.id === id);
      if (idx < 0) throw new Error("Lesson not found");

      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status !== "candidate") throw new Error(`Cannot approve lesson with status: ${current.status}`);

      const now = Date.now();
      const updated: SelfDevLesson = {
        ...copyLesson(current),
        status: "active",
        version: current.version + 1,
        approvedBy: approvedBy.trim(),
        approvedAt: now,
        updatedAt: Math.max(now, current.updatedAt),
      };

      if (!isValidLesson(updated)) throw new Error("Invalid lesson after approval");
      data.lessons[idx] = updated;
      return copyLesson(updated);
    });
  }

  /**
   * Rejects a candidate lesson, removing it from active consideration.
   */
  async reject(workspace: string, id: string, expectedVersion: number, reason: string = "rejected_by_user"): Promise<void> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");

    await this.#mutate(data => {
      const idx = data.lessons.findIndex(l => l.workspace === workspace && l.id === id);
      if (idx < 0) throw new Error("Lesson not found");

      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status !== "candidate") throw new Error(`Cannot reject non-candidate lesson: ${current.status}`);

      // Delete rejected candidate completely
      data.lessons.splice(idx, 1);
    });
  }

  /**
   * Retires an active lesson so it is no longer injected into prompts.
   */
  async retire(workspace: string, id: string, expectedVersion: number, reason: string): Promise<SelfDevLesson> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");
    if (!reason.trim()) throw new Error("Retirement reason is required");

    return this.#mutate(data => {
      const idx = data.lessons.findIndex(l => l.workspace === workspace && l.id === id);
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
        retiredReason: reason.trim().slice(0, SELFDEV_LIMITS.MAX_RATIONALE_LENGTH),
        updatedAt: Math.max(now, current.updatedAt),
      };

      if (!isValidLesson(updated)) throw new Error("Invalid lesson after retirement");
      data.lessons[idx] = updated;
      return copyLesson(updated);
    });
  }

  /**
   * Edits a lesson. If the lesson was active, editing demotes it back to candidate status.
   */
  async edit(
    workspace: string,
    id: string,
    expectedVersion: number,
    patch: SelfDevLessonUpdate
  ): Promise<SelfDevLesson> {
    if (!this.#enabled()) throw new Error("Self-dev review is disabled");

    return this.#mutate(data => {
      const idx = data.lessons.findIndex(l => l.workspace === workspace && l.id === id);
      if (idx < 0) throw new Error("Lesson not found");

      const current = data.lessons[idx];
      if (current.version !== expectedVersion) throw new Error("Lesson version conflict");
      if (current.status === "retired") throw new Error("Cannot edit a retired lesson");

      const now = Date.now();
      const nextStatement = patch.statement !== undefined ? patch.statement.trim() : current.statement;
      const nextRationale = patch.rationale !== undefined ? patch.rationale.trim() : current.rationale;
      const nextEvidence = patch.evidenceIds !== undefined ? [...patch.evidenceIds] : current.evidenceIds;
      const nextTags = patch.tags !== undefined ? [...patch.tags] : current.tags;

      // Invalidate approval if it was active
      const updated: SelfDevLesson = {
        id: current.id,
        workspace: current.workspace,
        statement: nextStatement,
        ...(nextRationale !== undefined ? { rationale: nextRationale } : {}),
        evidenceIds: nextEvidence,
        tags: nextTags,
        version: current.version + 1,
        status: "candidate", // Reset to candidate
        createdAt: current.createdAt,
        updatedAt: Math.max(now, current.updatedAt),
      };

      if (!isValidLesson(updated)) throw new Error("Invalid lesson after edit");
      data.lessons[idx] = updated;
      return copyLesson(updated);
    });
  }

  async #read(): Promise<SelfDevStoreData> {
    const file = await open(this.#path, "r").catch(error => {
      if (hasCode(error, "ENOENT")) return undefined;
      throw error;
    });
    if (!file) return { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: 0, lessons: [] };

    try {
      const stat = await file.stat();
      if (stat.size > 16 * 1024 * 1024) throw new Error("Store file too large");
      const content = await file.readFile("utf8");
      if (!content.trim()) return { schemaVersion: SELFDEV_STORE_SCHEMA_VERSION, updatedAt: 0, lessons: [] };
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.lessons)) {
        throw new Error("Invalid store structure");
      }
      return parsed as SelfDevStoreData;
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
      } catch (err) {
        if (hasCode(err, "EEXIST")) {
          await new Promise(res => setTimeout(res, 20));
          continue;
        }
        throw err;
      }
    }

    if (!lockFd) throw new Error("Could not acquire store lock");

    try {
      const data = await this.#read();
      const result = mutator(data);
      data.updatedAt = Date.now();

      const tmpPath = `${this.#path}.${randomUUID()}.tmp`;
      const tmpFile = await open(tmpPath, "w");
      try {
        await tmpFile.writeFile(JSON.stringify(data, null, 2), "utf8");
        await tmpFile.sync();
      } finally {
        await tmpFile.close();
      }

      await rename(tmpPath, this.#path);
      return result;
    } finally {
      await lockFd.close();
      await unlink(lockPath).catch(() => {});
    }
  }
}
