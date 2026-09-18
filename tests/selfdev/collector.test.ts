import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SelfDevCollector } from "../../src/core/selfdev/collector.js";
import { SelfDevEventStore } from "../../src/core/selfdev/eventStore.js";
import type { SelfDevEventInput } from "../../src/core/selfdev/types.js";
const input: SelfDevEventInput = { id: "id", workspace: "ws", sessionId: "session", kind: "custom", summary: "Summary" };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const store = new SelfDevEventStore({ workspace: "ws", getDb: () => db, config: { enabled: true, maxBatchSize: 2 } });
  return { db, store, collector: new SelfDevCollector(store) };
}
describe("validated collector", () => {
  it("returns safe disabled results without acquiring DB", () => {
    const getDb = vi.fn(() => { throw new Error("unexpected"); });
    const collector = new SelfDevCollector(new SelfDevEventStore({ workspace: "ws", getDb }));
    expect(collector.record(input)).toEqual({ recorded: false, reason: "disabled" });
    expect(collector.recordBatch([input])).toEqual({ recorded: [], skipped: [{ index: 0, reason: "disabled" }] });
    expect(getDb).not.toHaveBeenCalled();
  });
  it("returns redacted events and safely reports validation failures", () => {
    const { collector } = setup();
    expect(collector.record({ ...input, summary: "password=topsecret" })).toMatchObject({ recorded: true, event: { summary: "[REDACTED]" } });
    expect(collector.record({ ...input, kind: "bad" } as unknown as SelfDevEventInput)).toEqual({ recorded: false, reason: "invalid_input" });
  });
  it("makes batches all-or-nothing with bounded skipped results", () => {
    const { collector, store } = setup();
    expect(collector.recordBatch([input, { ...input, id: "other", workspace: "foreign" }])).toEqual({ recorded: [], skipped: [{ index: 0, reason: "invalid_input" }, { index: 1, reason: "invalid_input" }] });
    expect(store.list()).toEqual([]);
    expect(collector.recordBatch(new Array<SelfDevEventInput>(10000))).toEqual({ recorded: [], skipped: [{ index: -1, reason: "invalid_input" }] });
    expect(collector.recordBatch([input]).recorded).toHaveLength(1);
  });
  it("does not expose database error messages or leave partial evidence", () => {
    const { collector, store, db } = setup();
    store.record(input);
    db.exec("CREATE TRIGGER fail BEFORE INSERT ON selfdev_events WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'password=topsecret'); END");
    expect(collector.record({ ...input, id: "bad" })).toEqual({ recorded: false, reason: "storage_error" });
    const result = collector.recordBatch([{ ...input, id: "good" }, { ...input, id: "bad" }]);
    expect(result.skipped.every(item => item.reason === "storage_error")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("topsecret");
    expect(store.hasEvidence("good")).toBe(false);
  });
});
