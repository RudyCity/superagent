/**
 * Shared types and constants for the Self-Dev System (Phase 1).
 *
 * The Self-Dev System is a closed-loop pipeline where the agent learns from
 * its own execution history: events are collected (collector.ts), persisted
 * (store.ts), distilled into lessons (later phase), and injected back into
 * prompts (later phase).
 *
 * These types are the single source of truth shared by the collector,
 * event store, lesson store, and the future distiller/injector modules.
 */

/**
 * Minimal structural interface for a synchronous SQLite database handle.
 *
 * Satisfied by `node:sqlite` `DatabaseSync`, `bun:sqlite` `Database`, and the
 * wrapped handle returned by `getHistoryDb()` in `src/core/storage/historyDb.ts`.
 * Declared here so the selfdev modules never depend on a specific driver and
 * tests can inject an in-memory database.
 */
export interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDbLike {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatementLike;
}

/** Hard size bounds. All persisted content is bounded before write. */
export const SELFDEV_LIMITS = Object.freeze({
  /** Maximum length of a single event summary (characters). */
  MAX_SUMMARY_LENGTH: 2000,
  /** Maximum number of evidence ids per event or lesson. */
  MAX_EVIDENCE_ITEMS: 20,
  /** Maximum length of a single evidence id (characters). */
  MAX_EVIDENCE_ID_LENGTH: 200,
  /** Maximum number of tags per event or lesson. */
  MAX_TAGS: 20,
  /** Maximum length of a single tag (characters). */
  MAX_TAG_LENGTH: 64,
  /** Maximum serialized JSON size of an event payload (characters). */
  MAX_PAYLOAD_JSON_LENGTH: 16384,
  /** Maximum number of events in a single batch write. */
  MAX_BATCH_SIZE: 100,
  /** Default cap of retained events per workspace (oldest pruned first). */
  MAX_EVENTS_PER_WORKSPACE: 5000,
  /** Maximum number of lessons retained in the lesson store. */
  MAX_LESSONS: 500,
  /** Maximum length of a lesson statement (characters). */
  MAX_STATEMENT_LENGTH: 2000,
  /** Maximum length of a lesson rationale (characters). */
  MAX_RATIONALE_LENGTH: 4000,
  /** Maximum length of session id / workspace strings (characters). */
  MAX_CONTEXT_ID_LENGTH: 200,
  /** Maximum number of rows scanned when filtering by tag in JS. */
  MAX_LIST_SCAN: 5000,
  /** Hard cap for any list query limit parameter. */
  MAX_LIST_LIMIT: 1000,
} as const);

/** Kinds of self-dev events the collector can record. */
export const SELFDEV_EVENT_KINDS = [
  "task_started",
  "task_completed",
  "task_failed",
  "command_executed",
  "test_result",
  "build_result",
  "review_finding",
  "user_feedback",
  "lesson_proposed",
  "lesson_approved",
  "lesson_retired",
  "custom",
] as const;

export type SelfDevEventKind = (typeof SELFDEV_EVENT_KINDS)[number];

/** Lifecycle status of a lesson. Transitions: candidate -> active -> retired. */
export const SELFDEV_LESSON_STATUSES = ["candidate", "active", "retired"] as const;

export type SelfDevLessonStatus = (typeof SELFDEV_LESSON_STATUSES)[number];

/** Input for recording a new self-dev event. `id`/`ts` default when omitted. */
export interface SelfDevEventInput {
  id?: string;
  ts?: number;
  sessionId: string;
  workspace: string;
  kind: SelfDevEventKind;
  summary: string;
  /** Evidence references (ids of commands, files, tests, prior events...). */
  evidence?: string[];
  tags?: string[];
  /** Optional structured payload; bounded and redacted before persistence. */
  payload?: Record<string, unknown>;
}

/** A persisted self-dev event. */
export interface SelfDevEvent {
  id: string;
  ts: number;
  sessionId: string;
  workspace: string;
  kind: SelfDevEventKind;
  summary: string;
  evidence: string[];
  tags: string[];
  payload?: Record<string, unknown>;
  /** Number of redactions applied before persistence (0 when clean). */
  redactionCount: number;
}

/** Filter and pagination options for listing events. */
export interface SelfDevEventQuery {
  sessionId?: string;
  workspace?: string;
  kind?: SelfDevEventKind;
  /** Match events containing every given tag. */
  tags?: string[];
  since?: number;
  until?: number;
  /** Default 100, hard-capped at SELFDEV_LIMITS.MAX_LIST_LIMIT. */
  limit?: number;
  offset?: number;
}

/** Input for proposing a new lesson (starts as "candidate"). */
export interface SelfDevLessonInput {
  id?: string;
  workspace: string;
  statement: string;
  rationale?: string;
  /** Required: non-empty list of evidence ids backing the lesson. */
  evidenceIds: string[];
  tags?: string[];
}

/** A versioned lesson in the self-dev knowledge store. */
export interface SelfDevLesson {
  id: string;
  /** Monotonic version, incremented on every accepted mutation. */
  version: number;
  status: SelfDevLessonStatus;
  workspace: string;
  statement: string;
  rationale?: string;
  evidenceIds: string[];
  tags: string[];
  createdAt: number;
  updatedAt: number;
  approvedBy?: string;
  approvedAt?: number;
  retiredAt?: number;
  retiredReason?: string;
}

/** Patch for updating a lesson while it is still a candidate. */
export interface SelfDevLessonUpdate {
  statement?: string;
  rationale?: string;
  evidenceIds?: string[];
  tags?: string[];
}

/** Filter options for listing lessons. */
export interface SelfDevLessonQuery {
  workspace?: string;
  status?: SelfDevLessonStatus;
}

/** On-disk shape of the versioned lesson store JSON file. */
export interface SelfDevStoreData {
  schemaVersion: number;
  updatedAt: number;
  lessons: SelfDevLesson[];
}

/** Current schema version of the lesson store JSON file. */
export const SELFDEV_STORE_SCHEMA_VERSION = 1;

/** Self-dev configuration. Disabled by default; opt-in only. */
export interface SelfDevConfig {
  /** Master switch. When false, no events or lesson mutations are recorded. */
  enabled: boolean;
  /** Whether event collection is active when `enabled` is true. */
  collectionEnabled: boolean;
  /** Whether lesson injection into prompts is active (used by injector phase). */
  injectionEnabled: boolean;
  /** Redact common secret patterns before persistence. Default true. */
  redactSecrets: boolean;
  /** Retention cap of events per workspace. */
  maxEventsPerWorkspace: number;
  /** Maximum events per batch write. */
  maxBatchSize: number;
  /** Maximum number of lessons retained in the JSON store. */
  maxLessons: number;
  /** When true, lesson evidence ids must exist in the event store. */
  requireKnownEvidence: boolean;
  /** Optional override path for the lessons JSON file (tests, custom setups). */
  storePath?: string;
}

/** Default configuration: the whole self-dev system is OFF. */
export const DEFAULT_SELF_DEV_CONFIG: Readonly<SelfDevConfig> = Object.freeze({
  enabled: false,
  collectionEnabled: true,
  injectionEnabled: true,
  redactSecrets: true,
  maxEventsPerWorkspace: SELFDEV_LIMITS.MAX_EVENTS_PER_WORKSPACE,
  maxBatchSize: SELFDEV_LIMITS.MAX_BATCH_SIZE,
  maxLessons: SELFDEV_LIMITS.MAX_LESSONS,
  requireKnownEvidence: false,
});

/**
 * Merge a partial override onto the defaults with numeric clamping.
 * Returns a fresh mutable copy; the default constant is never mutated.
 */
export function resolveSelfDevConfig(overrides?: Partial<SelfDevConfig>): SelfDevConfig {
  const merged: SelfDevConfig = { ...DEFAULT_SELF_DEV_CONFIG, ...(overrides ?? {}) };
  merged.maxEventsPerWorkspace = clampInt(
    merged.maxEventsPerWorkspace,
    1,
    SELFDEV_LIMITS.MAX_EVENTS_PER_WORKSPACE,
  );
  merged.maxBatchSize = clampInt(merged.maxBatchSize, 1, SELFDEV_LIMITS.MAX_BATCH_SIZE);
  merged.maxLessons = clampInt(merged.maxLessons, 1, SELFDEV_LIMITS.MAX_LESSONS);
  if (merged.storePath !== undefined && (typeof merged.storePath !== "string" || merged.storePath.trim() === "")) {
    delete merged.storePath;
  }
  return merged;
}

function clampInt(value: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return max;
  return Math.min(max, Math.max(min, n));
}

/** Result of a single record attempt through the collector. */
export interface SelfDevRecordResult {
  recorded: boolean;
  event?: SelfDevEvent;
  /** Machine-readable reason when not recorded (e.g. "disabled"). */
  reason?: string;
}

/** Result of a batch record attempt through the collector. */
export interface SelfDevBatchResult {
  recorded: SelfDevEvent[];
  skipped: Array<{ index: number; reason: string }>;
}
