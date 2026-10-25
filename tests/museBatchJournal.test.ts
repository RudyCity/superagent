import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import type { RemoteTransport } from "../src/core/remoteAgent/transport.js";

const owned: string[] = [];
function makeFixture(): { root: string; port: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-journal-"));
  owned.push(root);
  return { root, port: 48001 };
}
afterEach(() => {
  for (const dir of owned.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable Muse batch checkpoint", () => {
  it("survives process-memory loss and never reclaims a prior batch ID", () => {
    const { root, port } = makeFixture();
    const first = new MuseBatchJournal(port, root);
    expect(first.claim("batch-a", "task-a", 2)).toBe(true);
    expect(first.claim("batch-a", "task-a", 2)).toBe(false);
    const second = new MuseBatchJournal(port, root);
    expect(second.claim("batch-a", "task-a", 2)).toBe(false);
    expect(second.summary()).toMatchObject({ started: 1, requiresReconciliation: 1 });
    second.transition("batch-a", "result_pending");
    expect(new MuseBatchJournal(port, root).summary()).toMatchObject({
      resultPending: 1, requiresReconciliation: 1,
    });
    second.transition("batch-a", "delivered");
    const rebooted = new MuseBatchJournal(port, root);
    expect(rebooted.summary()).toMatchObject({ delivered: 1, requiresReconciliation: 0 });
    expect(rebooted.claim("batch-a", "task-a", 2)).toBe(false);
    expect(() => rebooted.transition("batch-a", "uncertain")).toThrow();
    expect(fs.readFileSync(museJournalFile(port, root), "utf8")).not.toContain("secret");
  });

  it("keeps unconfirmed tool operations blocked and fails closed on invalid checkpoint", () => {
    const { root, port } = makeFixture();
    const journal = new MuseBatchJournal(port, root);
    journal.claim("executing", "task-live", 1);
    journal.claim("aborted", "task-old", 1);
    journal.transition("aborted", "uncertain");
    expect(new MuseBatchJournal(port, root).summary()).toMatchObject({
      started: 1, uncertain: 1, requiresReconciliation: 2,
    });
    expect(() => journal.claim("executing", "task-live", 1)).not.toThrow();
    fs.writeFileSync(museJournalFile(port, root), '{"version":1,"ownerPort":9999,"batches":[]}');
    expect(() => new MuseBatchJournal(port, root)).toThrow(/schema/);
  });

  it("keeps tools from running again after a watcher restart with same checkpoint", async () => {
    const { root, port } = makeFixture();
    const envelope = {
      v: 1 as const, kind: "task_batch" as const,
      id: "durable-once", task_id: "task-1", calls: [],
    };
    const outputs: string[] = [];
    const transport: RemoteTransport = {
      type: "https",
      start: async () => {},
      stop: async () => {},
      sendEnvelope: async message => { outputs.push(message.kind); return true; },
      isConnected: () => true,
      getTransportInfo: () => ({ type: "https", details: "isolated fake transport" }),
    };
    const first = new MuseWatcher({
      workspaces: [root], transport, announce: false,
      batchJournal: new MuseBatchJournal(port, root),
    });
    await first.start();
    try {
      await first.handleEnvelope(envelope);
      await first.waitForIdle();
      expect(first.getStats().batchesExecuted).toBe(1);
      expect(outputs.filter(kind => kind === "task_result")).toHaveLength(1);
      expect(new MuseBatchJournal(port, root).summary().delivered).toBe(1);
    } finally { await first.stop(); }
    const second = new MuseWatcher({
      workspaces: [root], transport, announce: false,
      batchJournal: new MuseBatchJournal(port, root),
    });
    await second.start();
    try {
      await second.handleEnvelope(envelope);
      await second.waitForIdle();
      expect(second.getStats().batchesExecuted).toBe(0);
      expect(outputs.filter(kind => kind === "task_result")).toHaveLength(1);
    } finally { await second.stop(); }
  });
});
