import type { SqliteDbLike } from "./types.js";

export type SelfDevMetricKind = "injected" | "applied" | "helped" | "harmed";

export interface LessonMetrics {
  lessonId: string;
  injectedCount: number;
  appliedCount: number;
  helpedCount: number;
  harmedCount: number;
}

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

/**
 * Idempotent feedback and telemetry tracker for Self-Dev lesson usage.
 * Prevents double-counting via compound primary key (workspace, session_id, lesson_id, version, metric).
 */
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

  /**
   * Records a metric event idempotently.
   * If the same session/lesson/version/metric was already recorded, it is a no-op.
   */
  record(
    workspace: string,
    sessionId: string,
    lessonId: string,
    version: number,
    metric: SelfDevMetricKind
  ): boolean {
    if (!this.#enabled()) return false;
    if (!workspace.trim() || !sessionId.trim() || !lessonId.trim() || version < 1) {
      return false;
    }

    try {
      const stmt = this.database.prepare(`
        INSERT OR IGNORE INTO selfdev_feedback (workspace, session_id, lesson_id, version, metric, ts)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(workspace, sessionId, lessonId, version, metric, Date.now());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Aggregates feedback metrics for a specific lesson in a workspace.
   */
  getMetrics(workspace: string, lessonId: string): LessonMetrics {
    const defaultMetrics: LessonMetrics = {
      lessonId,
      injectedCount: 0,
      appliedCount: 0,
      helpedCount: 0,
      harmedCount: 0,
    };

    if (!this.#enabled()) return defaultMetrics;

    try {
      const rows = this.database
        .prepare(`
          SELECT metric, COUNT(DISTINCT session_id || ':' || version) as cnt
          FROM selfdev_feedback
          WHERE workspace = ? AND lesson_id = ?
          GROUP BY metric
        `)
        .all(workspace, lessonId) as Array<{ metric: string; cnt: number }>;

      for (const row of rows) {
        if (row.metric === "injected") defaultMetrics.injectedCount = row.cnt;
        else if (row.metric === "applied") defaultMetrics.appliedCount = row.cnt;
        else if (row.metric === "helped") defaultMetrics.helpedCount = row.cnt;
        else if (row.metric === "harmed") defaultMetrics.harmedCount = row.cnt;
      }

      return defaultMetrics;
    } catch {
      return defaultMetrics;
    }
  }
}
