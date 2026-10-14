import type { SqliteDbLike } from "./types.js";

export type SelfDevMetricKind = "injected" | "applied" | "helped" | "harmed";

export interface LessonMetrics {
  lessonId: string;
  injectedCount: number;
  appliedCount: number;
  helpedCount: number;
  harmedCount: number;
  lastRecordedAt?: number;
}
export type FeedbackRecordStatus = "recorded" | "duplicate" | "disabled" | "invalid_input" | "storage_error";
export interface FeedbackRecordResult { status: FeedbackRecordStatus; }
export interface FeedbackRecord {
  workspace: string;
  sessionId: string;
  lessonId: string;
  version: number;
  metric: SelfDevMetricKind;
  ts: number;
}

const MAX_FEEDBACK_RECORDS = 5000;
const FEEDBACK_SCHEMA = `
CREATE TABLE IF NOT EXISTS selfdev_feedback (
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  metric TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (workspace, session_id, lesson_id, version, metric)
);
CREATE INDEX IF NOT EXISTS idx_selfdev_feedback_lesson ON selfdev_feedback(workspace, lesson_id);
`;

export interface FeedbackStoreOptions {
  getDb: () => SqliteDbLike;
  enabled?: () => boolean;
}

/** Idempotent workspace-scoped feedback. No lesson text or raw task content is stored. */
export class FeedbackTracker {
  readonly #getDb: () => SqliteDbLike;
  readonly #enabled: () => boolean;
  #db?: SqliteDbLike;

  constructor(options: FeedbackStoreOptions) {
    this.#getDb = options.getDb;
    this.#enabled = options.enabled ?? (() => true);
  }

  private get database(): SqliteDbLike {
    if (!this.#db) {
      const db = this.#getDb();
      db.exec(FEEDBACK_SCHEMA);
      this.#db = db;
    }
    return this.#db;
  }

  recordDetailed(workspace: string, sessionId: string, lessonId: string, version: number, metric: SelfDevMetricKind): FeedbackRecordResult {
    if (!this.#enabled()) return { status: "disabled" };
    if (!workspace.trim() || workspace.length > 200 || !sessionId.trim() || sessionId.length > 200 || !lessonId.trim() || lessonId.length > 200 ||
        !Number.isSafeInteger(version) || version < 1 ||
        !["injected", "applied", "helped", "harmed"].includes(metric)) return { status: "invalid_input" };
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO selfdev_feedback (workspace, session_id, lesson_id, version, metric, ts)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(workspace, sessionId, lessonId, version, metric, Date.now());
      const changed = this.database.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
      return { status: Number(changed?.count) === 1 ? "recorded" : "duplicate" };
    } catch {
      return { status: "storage_error" };
    }
  }

  /** Backward-compatible boolean API; true only if a new row was inserted. */
  record(workspace: string, sessionId: string, lessonId: string, version: number, metric: SelfDevMetricKind): boolean {
    return this.recordDetailed(workspace, sessionId, lessonId, version, metric).status === "recorded";
  }

  getMetrics(workspace: string, lessonId: string): LessonMetrics {
    const metrics: LessonMetrics = { lessonId, injectedCount: 0, appliedCount: 0, helpedCount: 0, harmedCount: 0 };
    if (!this.#enabled()) return metrics;
    try {
      const rows = this.database.prepare(`
        SELECT metric, COUNT(DISTINCT session_id || ':' || version) AS cnt, MAX(ts) AS last_ts
        FROM selfdev_feedback WHERE workspace = ? AND lesson_id = ? GROUP BY metric
      `).all(workspace, lessonId) as Array<{ metric: string; cnt: number; last_ts?: number }>;
      for (const row of rows) {
        const count = Number(row.cnt) || 0;
        if (row.metric === "injected") metrics.injectedCount = count;
        else if (row.metric === "applied") metrics.appliedCount = count;
        else if (row.metric === "helped") metrics.helpedCount = count;
        else if (row.metric === "harmed") metrics.harmedCount = count;
        metrics.lastRecordedAt = Math.max(metrics.lastRecordedAt ?? 0, Number(row.last_ts) || 0) || undefined;
      }
    } catch { /* diagnostics degrade to zero counts on storage errors */ }
    return metrics;
  }

  listMetrics(workspace: string): LessonMetrics[] {
    if (!this.#enabled() || !workspace.trim()) return [];
    try {
      const rows = this.database.prepare(`
        SELECT lesson_id AS lessonId, metric, COUNT(DISTINCT session_id || ':' || version) AS cnt, MAX(ts) AS last_ts
        FROM selfdev_feedback WHERE workspace = ? GROUP BY lesson_id, metric ORDER BY lesson_id
      `).all(workspace) as Array<{ lessonId: string; metric: string; cnt: number; last_ts?: number }>;
      const byId = new Map<string, LessonMetrics>();
      for (const row of rows) {
        const item = byId.get(row.lessonId) ?? {
          lessonId: row.lessonId, injectedCount: 0, appliedCount: 0, helpedCount: 0, harmedCount: 0,
        };
        const count = Number(row.cnt) || 0;
        if (row.metric === "injected") item.injectedCount = count;
        else if (row.metric === "applied") item.appliedCount = count;
        else if (row.metric === "helped") item.helpedCount = count;
        else if (row.metric === "harmed") item.harmedCount = count;
        item.lastRecordedAt = Math.max(item.lastRecordedAt ?? 0, Number(row.last_ts) || 0) || undefined;
        byId.set(row.lessonId, item);
      }
      return [...byId.values()];
    } catch { return []; }
  }

  listRecords(workspace: string): FeedbackRecord[] {
    if (!this.#enabled() || !workspace.trim()) return [];
    try {
      return this.database.prepare(`
        SELECT workspace, session_id AS sessionId, lesson_id AS lessonId, version, metric, ts
        FROM selfdev_feedback WHERE workspace = ? ORDER BY ts, lesson_id LIMIT ${MAX_FEEDBACK_RECORDS}
      `).all(workspace) as FeedbackRecord[];
    } catch { return []; }
  }

  getRecordCount(workspace: string): number {
    if (!workspace.trim()) return 0;
    try {
      const row = this.database.prepare("SELECT COUNT(*) AS count FROM selfdev_feedback WHERE workspace = ?").get(workspace) as { count?: number } | undefined;
      return Math.max(0, Number(row?.count) || 0);
    } catch { return 0; }
  }

  /** Atomic restore into a workspace with no prior feedback rows. */
  restoreRecords(workspace: string, records: FeedbackRecord[]): number {
    if (!Array.isArray(records) || records.length > MAX_FEEDBACK_RECORDS ||
        records.some(record => record.workspace !== workspace || !record.sessionId?.trim() || record.sessionId.length > 200 || !record.lessonId?.trim() || record.lessonId.length > 200 ||
          !Number.isSafeInteger(record.version) || record.version < 1 || !Number.isSafeInteger(record.ts) || record.ts < 0 ||
          !["injected", "applied", "helped", "harmed"].includes(record.metric))) {
      throw new Error("Invalid feedback restore records or workspace mismatch");
    }
    const keys = new Set<string>();
    for (const record of records) {
      const key = JSON.stringify([record.sessionId, record.lessonId, record.version, record.metric]);
      if (keys.has(key)) throw new Error("Duplicate feedback record in restore bundle");
      keys.add(key);
    }
    const db = this.database;
    if (this.getRecordCount(workspace) > 0) throw new Error("Restore requires an empty target workspace feedback store");
    db.exec("SAVEPOINT selfdev_restore_feedback");
    try {
      const insert = db.prepare("INSERT INTO selfdev_feedback (workspace, session_id, lesson_id, version, metric, ts) VALUES (?, ?, ?, ?, ?, ?)");
      for (const record of records) insert.run(workspace, record.sessionId, record.lessonId, record.version, record.metric, record.ts);
      db.exec("RELEASE SAVEPOINT selfdev_restore_feedback");
      return records.length;
    } catch (error) {
      try { db.exec("ROLLBACK TO SAVEPOINT selfdev_restore_feedback"); }
      finally { db.exec("RELEASE SAVEPOINT selfdev_restore_feedback"); }
      throw error;
    }
  }

  /** Compensating rollback for a failed import into a pre-verified empty workspace. */
  removeWorkspaceRecords(workspace: string): number {
    if (!workspace.trim()) return 0;
    try {
      this.database.prepare("DELETE FROM selfdev_feedback WHERE workspace = ?").run(workspace);
      const row = this.database.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
      return Math.max(0, Number(row?.count) || 0);
    } catch { return 0; }
  }

  deleteBefore(workspace: string, cutoffMs: number): number {
    if (!this.#enabled() || !workspace.trim() || !Number.isSafeInteger(cutoffMs) || cutoffMs < 0) return 0;
    try {
      this.database.prepare("DELETE FROM selfdev_feedback WHERE workspace = ? AND ts < ?").run(workspace, cutoffMs);
      const result = this.database.prepare("SELECT changes() AS count").get() as { count?: number } | undefined;
      return Math.max(0, Number(result?.count) || 0);
    } catch { return 0; }
  }
}
