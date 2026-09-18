import { normalizeSelfDevConfig } from "../config/selfdevConfig.js";
import { dataRecord, fields, identity, integer, invalid, kind, stringList, validateEvent } from "./eventValidation.js";
import { SELFDEV_LIMITS as L, type SelfDevConfig, type SelfDevEvent, type SelfDevEventInput, type SelfDevEventQuery, type SqliteDbLike } from "./types.js";
export type { SqliteDbLike } from "./types.js";

export interface SelfDevEventStoreOptions {
  workspace: string;
  getDb: () => SqliteDbLike;
  config?: Partial<SelfDevConfig>;
}
const schema = `
CREATE TABLE IF NOT EXISTS selfdev_events (
  workspace TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL,
  session_id TEXT NOT NULL, kind TEXT NOT NULL, event_json TEXT NOT NULL,
  PRIMARY KEY (workspace, id)
);
CREATE INDEX IF NOT EXISTS selfdev_events_workspace_time ON selfdev_events(workspace, ts DESC, id DESC);
`;

/** Metadata-only evidence; DB lifetime belongs to the caller. No imports acquire a DB. */
export class SelfDevEventStore {
  private readonly workspace: string;
  private readonly config: SelfDevConfig;
  private readonly getDb: () => SqliteDbLike;
  private db?: SqliteDbLike;

  constructor(options: SelfDevEventStoreOptions) {
    this.workspace = identity(options.workspace);
    this.config = normalizeSelfDevConfig(options.config);
    this.getDb = options.getDb;
  }
  isEnabled(): boolean { return this.config.enabled; }
  isCollectionEnabled(): boolean { return this.config.enabled && this.config.collectionEnabled; }
  getBatchLimit(): number { return this.config.maxBatchSize; }

  private database(): SqliteDbLike {
    if (!this.db) {
      const db = this.getDb();
      db.exec(schema);
      this.db = db;
    }
    return this.db;
  }
  private decode(row: unknown): SelfDevEvent | undefined {
    if (row === undefined) return undefined;
    if (!row || typeof row !== "object" || !("event_json" in row) || typeof row.event_json !== "string" || row.event_json.length > 40000) return invalid();
    const data = dataRecord(JSON.parse(row.event_json) as unknown);
    const { redactionCount, ...input } = data;
    const count = integer(redactionCount);
    const event = validateEvent(input, this.workspace);
    return { ...event, redactionCount: count + event.redactionCount };
  }
  private find(db: SqliteDbLike, id: string): SelfDevEvent | undefined {
    return this.decode(db.prepare("SELECT event_json FROM selfdev_events WHERE workspace = ? AND id = ?").get(this.workspace, id));
  }
  record(input: SelfDevEventInput): SelfDevEvent | undefined { return this.recordBatch([input])[0]; }

  recordBatch(inputs: readonly SelfDevEventInput[]): SelfDevEvent[] {
    if (!this.isCollectionEnabled()) return [];
    if (!Array.isArray(inputs) || inputs.length > this.config.maxBatchSize) return invalid();
    // Validate the entire batch before acquiring the database or mutating storage.
    const events: SelfDevEvent[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const d = Object.getOwnPropertyDescriptor(inputs, String(i));
      if (!d || !("value" in d)) return invalid();
      events.push(validateEvent(d.value, this.workspace));
    }
    if (!events.length) return [];
    const db = this.database();
    // A savepoint is atomic both alone and inside an existing caller transaction.
    db.exec("SAVEPOINT selfdev_evidence_write");
    try {
      const insert = db.prepare("INSERT INTO selfdev_events (workspace, id, ts, session_id, kind, event_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace, id) DO NOTHING");
      const result: SelfDevEvent[] = [];
      for (const event of events) {
        insert.run(this.workspace, event.id, event.ts, event.sessionId, event.kind, JSON.stringify(event));
        const saved = this.find(db, event.id);
        if (!saved) return invalid();
        result.push(saved);
      }
      db.prepare("DELETE FROM selfdev_events WHERE workspace = ? AND id IN (SELECT id FROM selfdev_events WHERE workspace = ? ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?)")
        .run(this.workspace, this.workspace, this.config.maxEventsPerWorkspace);
      db.exec("RELEASE SAVEPOINT selfdev_evidence_write");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK TO SAVEPOINT selfdev_evidence_write"); }
      finally { db.exec("RELEASE SAVEPOINT selfdev_evidence_write"); }
      throw error;
    }
  }
  get(id: string): SelfDevEvent | undefined {
    if (!this.isEnabled()) return undefined;
    return this.find(this.databaseAfterId(id), id);
  }
  private databaseAfterId(id: string): SqliteDbLike {
    identity(id, L.MAX_EVIDENCE_ID_LENGTH);
    return this.database();
  }
  hasEvidence(id: string): boolean { return this.get(id) !== undefined; }

  list(query: SelfDevEventQuery = {}): SelfDevEvent[] {
    if (!this.isEnabled()) return [];
    const q = dataRecord(query);
    fields(q, ["workspace", "sessionId", "kind", "tags", "since", "until", "limit", "offset"]);
    if (q.workspace !== undefined && identity(q.workspace) !== this.workspace) return invalid();
    const limit = q.limit === undefined ? 100 : Math.min(integer(q.limit), L.MAX_LIST_LIMIT);
    const offset = q.offset === undefined ? 0 : integer(q.offset, L.MAX_LIST_SCAN);
    const clauses = ["workspace = ?"];
    const params: unknown[] = [this.workspace];
    if (q.sessionId !== undefined) { clauses.push("session_id = ?"); params.push(identity(q.sessionId)); }
    if (q.kind !== undefined) { clauses.push("kind = ?"); params.push(kind(q.kind)); }
    if (q.since !== undefined) { clauses.push("ts >= ?"); params.push(integer(q.since)); }
    if (q.until !== undefined) { clauses.push("ts <= ?"); params.push(integer(q.until)); }
    if (typeof q.since === "number" && typeof q.until === "number" && q.since > q.until) return invalid();
    const tags = stringList(q.tags, L.MAX_TAGS, L.MAX_TAG_LENGTH);
    if (limit === 0) return [];
    const db = this.database();
    // Bound the SQL scan as well as returned rows; filter tags before pagination.
    const scan = tags.length ? L.MAX_LIST_SCAN : limit;
    const rows = db.prepare(`SELECT event_json FROM selfdev_events WHERE ${clauses.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, scan, tags.length ? 0 : offset);
    const result: SelfDevEvent[] = [];
    for (const row of rows) {
      const event = this.decode(row);
      if (event && tags.every(tag => event.tags.includes(tag))) result.push(event);
    }
    return tags.length ? result.slice(offset, offset + limit) : result;
  }
}
