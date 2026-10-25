import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseResultOutbox } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseExecutionCheckpoint } from "../src/core/remoteAgent/museExecutionCheckpoint.js";
import { MuseTombstoneArchive } from "../src/core/remoteAgent/museTombstoneArchive.js";
import { MuseRecoveryOrchestrator } from "../src/core/remoteAgent/museRecoveryOrchestrator.js";
import { handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";

const dirs: string[] = [];
const fixture = (homeRoot?: string) => {
  const root = homeRoot || fs.mkdtempSync(path.join(os.tmpdir(), "muse-tombstone-"));
  if (!homeRoot) dirs.push(root);
  const port = 53124;
  const journal = new MuseBatchJournal(port, root);
  const outbox = new MuseResultOutbox(port, root);
  const execution = new MuseExecutionCheckpoint(port, root);
  const addAcked = (id: string) => {
    expect(journal.claim(id, "task-" + id, 0)).toBe(true);
    journal.transition(id, "result_pending");
    const sealed = outbox.put({ v: 1, kind: "task_result", id, task_id: "task-" + id, results: [] });
    journal.transition(id, "delivered");
    journal.acknowledgeResult(id, "task-" + id, sealed.sha256);
    journal.markPayloadReleased(id, sealed.sha256);
    outbox.releaseAcknowledgedPayload(id, sealed.sha256);
  };
  return { root, port, journal, outbox, execution, addAcked };
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("Phase 4j immutable archive and crash-safe journal compaction", () => {
  it("archives ACKed and payload-free tombstones but retains duplicate rejection after restarts", () => {
    const s = fixture();
    s.addAcked("sealed-a");
    s.addAcked("sealed-b");
    expect(s.journal.claim("still-running", "task-active", 1)).toBe(true);
    const archived = s.journal.archiveFinalized(["sealed-a", "sealed-b"], s.outbox, s.execution);
    expect(archived.archived).toBe(2);
    expect(archived.segment).toMatch(/^[a-f0-9]{32}\.json$/);
    expect(s.journal.summary()).toMatchObject({ started: 1, archived: 2 });
    expect(s.journal.list().map(r => r.batchId)).toEqual(["still-running"]);
    expect(s.journal.claim("sealed-a", "new-task", 0)).toBe(false);
    const restarted = new MuseBatchJournal(s.port, s.root);
    expect(restarted.get("sealed-a")).toMatchObject({
      stage: "delivered", taskId: "task-sealed-a",
    });
    expect(restarted.claim("sealed-b", "different", 0)).toBe(false);
    expect(restarted.summary().archived).toBe(2);
    const r = new MuseRecoveryOrchestrator(restarted,
      new MuseExecutionCheckpoint(s.port, s.root),
      new MuseResultOutbox(s.port, s.root));
    expect(r.assess("sealed-a")).toMatchObject({
      decision: "acknowledged", canRequestResultReplay: false, canRequestUntouchedResume: false,
    });
    expect(() => restarted.transition("sealed-a", "uncertain")).toThrow();
  });

  it("refuses unacknowledged, unreleased, active and wrong-port archive inputs", () => {
    const s = fixture();
    s.addAcked("ready");
    s.journal.claim("unacked", "task-u", 0);
    s.journal.transition("unacked", "result_pending");
    s.journal.transition("unacked", "delivered");
    expect(() => s.journal.archiveFinalized(["unacked"], s.outbox, s.execution)).toThrow();
    expect(() => s.journal.archiveFinalized(["ready", "ready"], s.outbox, s.execution)).toThrow();
    const other = new MuseResultOutbox(s.port + 1, s.root);
    expect(() => s.journal.archiveFinalized(["ready"], other, s.execution)).toThrow(/owner identity/);
    s.addAcked("present-payload");
    s.outbox.put({ v: 1, kind: "task_result", id: "present-payload",
      task_id: "task-present-payload", results: [] });
    expect(() => s.journal.archiveFinalized(["present-payload"], s.outbox, s.execution)).toThrow(/already-released/);
    expect(s.journal.claim("ready", "new", 0)).toBe(false);
  });

  it("refuses startup if a referenced segment was deleted, modified or signing key removed", () => {
    const s = fixture();
    s.addAcked("tamper");
    const archived = s.journal.archiveFinalized(["tamper"], s.outbox, s.execution);
    const store = new MuseTombstoneArchive(s.port, s.root);
    const file = path.join(store.folder, archived.segment);
    const raw = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, raw.replace("task-tamper", "task-other"));
    expect(() => new MuseBatchJournal(s.port, s.root)).toThrow(/integrity/);
    fs.writeFileSync(file, raw);
    expect(new MuseBatchJournal(s.port, s.root).claim("tamper", "task", 0)).toBe(false);
    fs.rmSync(store.keyPath);
    expect(() => new MuseBatchJournal(s.port, s.root)).toThrow();
    const next = fixture();
    next.addAcked("missing");
    const name = next.journal.archiveFinalized(["missing"], next.outbox, next.execution).segment;
    fs.rmSync(path.join(new MuseTombstoneArchive(next.port, next.root).folder, name));
    expect(() => new MuseBatchJournal(next.port, next.root)).toThrow();
    fs.rmSync(museJournalFile(next.port, next.root));
    expect(() => new MuseBatchJournal(next.port, next.root)).toThrow(/journal missing/);
  });

  it("crash after durable segment but before journal rename keeps all IDs in active journal", () => {
    const s = fixture();
    s.addAcked("crash-gap");
    const original = fs.readFileSync(museJournalFile(s.port, s.root), "utf8");
    const rename = fs.renameSync;
    const fault = vi.spyOn(fs, "renameSync").mockImplementation((from, dest) => {
      if (String(dest) === museJournalFile(s.port, s.root)) throw new Error("SIMULATED_JOURNAL_CRASH");
      return rename(from, dest);
    });
    expect(() => s.journal.archiveFinalized(["crash-gap"], s.outbox, s.execution)).toThrow(/SIMULATED/);
    fault.mockRestore();
    expect(fs.readFileSync(museJournalFile(s.port, s.root), "utf8")).toBe(original);
    const reboot = new MuseBatchJournal(s.port, s.root);
    expect(reboot.archivedCount()).toBe(0);
    expect(reboot.claim("crash-gap", "different-task", 0)).toBe(false);
    expect(reboot.archiveFinalized(["crash-gap"], new MuseResultOutbox(s.port, s.root),
      new MuseExecutionCheckpoint(s.port, s.root)).archived).toBe(1);
    expect(new MuseBatchJournal(s.port, s.root).claim("crash-gap", "other", 0)).toBe(false);
  });

  it("compacts a full 1000-entry journal and permits more unique batches without replay", () => {
    const s = fixture();
    s.addAcked("oldest");
    const existing = JSON.parse(fs.readFileSync(museJournalFile(s.port, s.root), "utf8"));
    const stamp = Date.now();
    existing.batches.push(...Array.from({ length: 999 }, (_, i) => ({
      batchId: "entry-" + String(i).padStart(4, "0"), taskId: "task-" + i,
      stage: "started", callsCount: 1, recordedAt: stamp, updatedAt: stamp,
    })));
    fs.writeFileSync(museJournalFile(s.port, s.root), JSON.stringify(existing));
    const full = new MuseBatchJournal(s.port, s.root);
    expect(full.list()).toHaveLength(1000);
    expect(() => full.claim("entry-1000", "task-new", 0)).toThrow(/cap/);
    expect(full.archiveFinalized(["oldest"], new MuseResultOutbox(s.port, s.root),
      new MuseExecutionCheckpoint(s.port, s.root)).archived).toBe(1);
    expect(full.claim("entry-1000", "task-new", 0)).toBe(true);
    const next = new MuseBatchJournal(s.port, s.root);
    expect(next.claim("oldest", "task-another", 0)).toBe(false);
    expect(next.claim("entry-1000", "task-another", 0)).toBe(false);
  });

  it("verifies multi-segment manifests and rejects repeated/overlapping archived IDs", () => {
    const s = fixture();
    s.addAcked("segment-one");
    s.addAcked("segment-two");
    s.journal.archiveFinalized(["segment-one"], s.outbox, s.execution);
    s.journal.archiveFinalized(["segment-two"], s.outbox, s.execution);
    expect(new MuseBatchJournal(s.port, s.root).archivedCount()).toBe(2);
    const file = museJournalFile(s.port, s.root);
    const original = fs.readFileSync(file, "utf8");
    const copy = JSON.parse(original);
    copy.archives.push(copy.archives[0]);
    fs.writeFileSync(file, JSON.stringify(copy));
    expect(() => new MuseBatchJournal(s.port, s.root)).toThrow(/descriptor|archive/i);
    const overlap = JSON.parse(original);
    const timestamp = Date.now();
    overlap.batches.push({
      batchId: "segment-one", taskId: "task-overlap", callsCount: 0,
      stage: "started", recordedAt: timestamp, updatedAt: timestamp,
    });
    fs.writeFileSync(file, JSON.stringify(overlap));
    expect(() => new MuseBatchJournal(s.port, s.root)).toThrow(/overlapping/);
    fs.writeFileSync(file, original);
    expect(new MuseBatchJournal(s.port, s.root).claim("segment-one", "new", 0)).toBe(false);
  });

  it("offline dry-run and confirmed compaction honor exclusive lock and stale owner fencing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-tombstone-home-"));
    dirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const root = path.join(home, ".superagent-r");
    const s = fixture(root);
    s.addAcked("cli-eligible");
    const captured: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { captured.push(args.join(" ")); });
    const args = ["compact", "--port", String(s.port), "--confirm-port", String(s.port)];
    await expect(handleChannelHostCliCommand(["archive", "--port", String(s.port)])).resolves.toBe(false);
    expect(captured.join("\n")).toContain("cli-eligible");
    expect(new MuseBatchJournal(s.port, s.root).archivedCount()).toBe(0);
    await expect(handleChannelHostCliCommand(args.slice(0, -1))).rejects.toThrow(/confirm-port/);
    const registered = path.join(root, "channel-host-" + s.port + ".json");
    fs.writeFileSync(registered, "stale");
    await expect(handleChannelHostCliCommand(args)).rejects.toThrow(/registered/);
    fs.rmSync(registered);
    const lock = museJournalFile(s.port, root) + ".review.lock";
    fs.writeFileSync(lock, "live owner lock");
    await expect(handleChannelHostCliCommand(args)).rejects.toThrow();
    fs.rmSync(lock);
    await expect(handleChannelHostCliCommand(args)).resolves.toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    const persisted = new MuseBatchJournal(s.port, s.root);
    expect(persisted.archivedCount()).toBe(1);
    expect(persisted.get("cli-eligible")?.stage).toBe("delivered");
    expect(captured.join("\n")).not.toContain("PRIVATE");
    await expect(handleChannelHostCliCommand(["recovery", "--port", String(s.port),
      "--batch-id", "cli-eligible"])).resolves.toBe(false);
    expect(captured.join("\n")).toContain("acknowledged_payload_release_recorded");
  });
});
