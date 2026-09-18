import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SelfDevEventStore } from "../../src/core/selfdev/eventStore.js";
import { SELFDEV_LIMITS as L, type SelfDevConfig, type SelfDevEventInput, type SqliteDbLike } from "../../src/core/selfdev/types.js";

const databases: DatabaseSync[] = [];
function database(): DatabaseSync { const db = new DatabaseSync(":memory:"); databases.push(db); return db; }
function input(id = "event", overrides: Partial<SelfDevEventInput> = {}): SelfDevEventInput {
  return { id, ts: 10, workspace: "workspace-a", sessionId: "session", kind: "test_result", summary: "Tests passed", ...overrides };
}
function store(db: SqliteDbLike, workspace = "workspace-a", config: Partial<SelfDevConfig> = {}): SelfDevEventStore {
  return new SelfDevEventStore({ workspace, getDb: () => db, config: { enabled: true, ...config } });
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

describe("bounded SQLite evidence store", () => {
  it("does not acquire a DB when disabled, even for invalid input", () => {
    const getDb = vi.fn(() => { throw new Error("must not acquire"); });
    const disabled = new SelfDevEventStore({ workspace: "workspace-a", getDb });
    expect(disabled.record(null as unknown as SelfDevEventInput)).toBeUndefined();
    expect(disabled.recordBatch([])).toEqual([]);
    expect(disabled.list()).toEqual([]);
    expect(disabled.get("")).toBeUndefined();
    expect(disabled.hasEvidence("id")).toBe(false);
    expect(getDb).not.toHaveBeenCalled();
  });
  it("disables collection independently and fails closed on malformed config", () => {
    const getDb = vi.fn(() => { throw new Error("must not acquire"); });
    for (const config of [{ enabled: true, collectionEnabled: false }, { enabled: "true" }, { enabled: true, redactSecrets: 1 }]) {
      const disabled = new SelfDevEventStore({ workspace: "workspace-a", getDb, config: config as Partial<SelfDevConfig> });
      expect(disabled.record(input())).toBeUndefined();
    }
    expect(getDb).not.toHaveBeenCalled();
  });
  it("roundtrips events, generates IDs and uses parameterized workspace/ID values", () => {
    const db = database();
    const evidence = store(db);
    const saved = evidence.record(input("id' OR 1=1 --", { payload: { count: 3, nested: [true, null] }, tags: ["unit", "unit"] }));
    expect(saved).toMatchObject({ id: "id' OR 1=1 --", tags: ["unit"], redactionCount: 0 });
    expect(evidence.get("id' OR 1=1 --")).toEqual(saved);
    expect(evidence.get("missing")).toBeUndefined();
    expect(evidence.record(input(undefined, { id: undefined, ts: undefined }))?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(evidence.hasEvidence("id' OR 1=1 --")).toBe(true);
  });
  it("isolates reads, writes, same IDs and retention by exact workspace", () => {
    const db = database();
    const a = store(db, "workspace-a", { maxEventsPerWorkspace: 1 });
    const b = store(db, "workspace-b");
    b.record(input("same", { workspace: "workspace-b", summary: "B" }));
    a.record(input("same")); a.record(input("new", { ts: 20 }));
    expect(a.get("same")).toBeUndefined();
    expect(b.get("same")?.summary).toBe("B");
    expect(a.list().map(event => event.id)).toEqual(["new"]);
    expect(() => a.record(input("x", { workspace: "workspace-b" }))).toThrow();
    expect(() => a.list({ workspace: "workspace-b" })).toThrow();
  });
  it("never replaces original evidence for duplicate IDs within or across batches", () => {
    const evidence = store(database());
    const original = evidence.record(input("same", { payload: { token: "private" } }));
    const duplicate = evidence.record(input("same", { ts: 999, summary: "Changed", evidence: ["other"] }));
    expect(duplicate).toEqual(original);
    const batch = evidence.recordBatch([input("batch", { summary: "First" }), input("batch", { summary: "Second" })]);
    expect(batch[1]).toEqual(batch[0]);
    expect(evidence.list()).toHaveLength(2);
  });
  it("prunes oldest timestamp with deterministic ties, without touching other workspaces", () => {
    const evidence = store(database(), "workspace-a", { maxEventsPerWorkspace: 2 });
    evidence.recordBatch([input("a", { ts: 1 }), input("b", { ts: 2 }), input("c", { ts: 2 })]);
    expect(evidence.list().map(event => event.id)).toEqual(["c", "b"]);
    evidence.record(input("older", { ts: 0 }));
    expect(evidence.list().map(event => event.id)).toEqual(["c", "b"]);
  });
  it("validates whole batches before database acquisition", () => {
    const getDb = vi.fn(() => database());
    const evidence = new SelfDevEventStore({ workspace: "workspace-a", getDb, config: { enabled: true } });
    expect(() => evidence.recordBatch([input("valid"), input("bad", { ts: NaN })])).toThrow();
    expect(() => evidence.recordBatch(new Array<SelfDevEventInput>(2))).toThrow();
    expect(getDb).not.toHaveBeenCalled();
    expect(evidence.recordBatch([])).toEqual([]);
    expect(getDb).not.toHaveBeenCalled();
  });
  it("rolls back inserts on actual SQLite failure and remains usable", () => {
    const db = database(); const evidence = store(db);
    evidence.record(input("before"));
    db.exec("CREATE TRIGGER reject_bad BEFORE INSERT ON selfdev_events WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'forced'); END");
    expect(() => evidence.recordBatch([input("good"), input("bad")])).toThrow("forced");
    expect(evidence.list().map(event => event.id)).toEqual(["before"]);
    evidence.record(input("after"));
    expect(evidence.hasEvidence("after")).toBe(true);
  });
  it("rolls back inserts when retention fails, including inside an outer transaction", () => {
    const db = database(); const evidence = store(db, "workspace-a", { maxEventsPerWorkspace: 1 });
    evidence.record(input("before"));
    db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON selfdev_events BEGIN SELECT RAISE(ABORT, 'retention failed'); END");
    db.exec("BEGIN");
    expect(() => evidence.record(input("new", { ts: 20 }))).toThrow("retention failed");
    expect(evidence.list().map(event => event.id)).toEqual(["before"]);
    db.exec("COMMIT");
  });
  it("supports caller rollback after a successful nested savepoint", () => {
    const db = database(); const evidence = store(db);
    evidence.record(input("before")); db.exec("BEGIN");
    evidence.record(input("nested")); db.exec("ROLLBACK");
    expect(evidence.hasEvidence("nested")).toBe(false);
  });
  it("filters tags before pagination and bounds query numbers", () => {
    const evidence = store(database());
    evidence.recordBatch([input("a", { ts: 1, tags: ["yes"] }), input("b", { ts: 2 }), input("c", { ts: 3, tags: ["yes"] })]);
    expect(evidence.list({ tags: ["yes"], offset: 1, limit: 1 }).map(event => event.id)).toEqual(["a"]);
    expect(evidence.list({ since: 2, until: 3, kind: "test_result", sessionId: "session" })).toHaveLength(2);
    expect(evidence.list({ limit: 0 })).toEqual([]);
    expect(evidence.list({ limit: Number.MAX_SAFE_INTEGER })).toHaveLength(3);
    expect(evidence.list({ offset: L.MAX_LIST_SCAN })).toEqual([]);
    for (const query of [{ offset: L.MAX_LIST_SCAN + 1 }, { limit: -1 }, { limit: NaN }, { offset: 0.5 }, { since: 4, until: 2 }, { kind: "unknown" }, { tags: [""] }]) {
      expect(() => evidence.list(query as Parameters<typeof evidence.list>[0])).toThrow();
    }
  });
  it.each([
    { summary: "" }, { summary: "x".repeat(L.MAX_SUMMARY_LENGTH + 1) }, { id: "x".repeat(201) },
    { sessionId: "" }, { ts: -1 }, { ts: Infinity }, { ts: 0.1 }, { kind: "not-a-kind" },
    { evidence: [""] }, { tags: new Array(21).fill("tag") }, { payload: [] }, { extra: "unknown" },
  ])("rejects malformed runtime event %j", patch => {
    const evidence = store(database());
    expect(() => evidence.record({ ...input(), ...patch } as SelfDevEventInput)).toThrow();
  });
  it("enforces batch and payload caps before persisting", () => {
    const evidence = store(database(), "workspace-a", { maxBatchSize: 2 });
    expect(() => evidence.recordBatch([input("a"), input("b"), input("c")])).toThrow();
    expect(() => evidence.record(input("large", { payload: { text: "x".repeat(L.MAX_PAYLOAD_JSON_LENGTH) } }))).toThrow();
    expect(() => evidence.record(input("escaped", { payload: { text: "\u0000".repeat(3000) } }))).toThrow();
    expect(evidence.list()).toEqual([]);
  });
  it("redacts nested secrets, payload fields and raw transcripts before SQL persistence", () => {
    const db = database(); const evidence = store(db, "workspace-a", { redactSecrets: false });
    const event = evidence.record(input("redacted", {
      summary: "Bearer abcdef12345 password=hidden sk-proj-1234567890",
      evidence: ["token=hidden"], tags: ["api_key=hidden"],
      payload: { nested: [{ apiKey: "hidden", harmless: "ghp_123456789012" }], messages: ["raw dialogue"], stdout: "raw log", private_key: "key bytes", url: "https://name:pass@example.com/path" },
    }));
    const serialized = String((db.prepare("SELECT event_json FROM selfdev_events").get() as { event_json: string }).event_json);
    for (const secret of ["abcdef12345", "hidden", "sk-proj-1234567890", "ghp_123456789012", "raw dialogue", "raw log", "key bytes", "name:pass"]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(event?.redactionCount).toBeGreaterThan(0);
    expect(evidence.get("redacted")).toEqual(event);
  });
  it("rejects circular, deep, unsupported and accessor payloads without executing getters", () => {
    const evidence = store(database());
    const circular: Record<string, unknown> = {}; circular.self = circular;
    let deep: Record<string, unknown> = {}; for (let i = 0; i < 10; i++) deep = { child: deep };
    const getter = vi.fn(() => "secret");
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: getter });
    for (const payload of [circular, deep, accessor, { value: BigInt(1) }, { value: undefined }, { value: () => 1 }, { value: new Date() }, { value: Symbol("x") }, { value: new Array(2) }, { password: circular }, { value: NaN }]) {
      expect(() => evidence.record(input("invalid", { payload }))).toThrow();
    }
    expect(getter).not.toHaveBeenCalled();
    expect(evidence.list()).toEqual([]);
  });
});
