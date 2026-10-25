import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseResultOutbox, outboxFile } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseExecutionCheckpoint, executionCheckpointFile } from "../src/core/remoteAgent/museExecutionCheckpoint.js";
import { MuseTombstoneArchive } from "../src/core/remoteAgent/museTombstoneArchive.js";
import {
  inspectMuseRecoveryStorage, makeMuseRecoveryBackup, restoreMarker,
  verifyMuseRecoveryBackup, restoreMuseRecoveryBackup,
} from "../src/core/remoteAgent/museRecoveryBackup.js";
import { handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";

const roots: string[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-backup-"));
  roots.push(home);
  const root = path.join(home, "active");
  fs.mkdirSync(root);
  const port = 52371;
  const journal = new MuseBatchJournal(port, root);
  const outbox = new MuseResultOutbox(port, root);
  const execution = new MuseExecutionCheckpoint(port, root);
  const acked = "archived-ack";
  journal.claim(acked, "task-archived", 0);
  journal.transition(acked, "result_pending");
  const digest = outbox.put({
    v: 1, kind: "task_result", id: acked, task_id: "task-archived", results: [],
  }).sha256;
  journal.transition(acked, "delivered");
  journal.acknowledgeResult(acked, "task-archived", digest);
  journal.markPayloadReleased(acked, digest);
  outbox.releaseAcknowledgedPayload(acked, digest);
  journal.archiveFinalized([acked], outbox, execution);
  journal.claim("active-unresolved", "task-unresolved", 1);
  execution.store({
    v: 1, kind: "task_batch", id: "active-unresolved", task_id: "task-unresolved",
    calls: [{ id: "a", tool: "write", args: { content: "SECRET_MUSE_INTENT" } }],
  }, root);
  journal.claim("unacked-result", "task-result", 0);
  journal.transition("unacked-result", "result_pending");
  outbox.put({
    v: 1, kind: "task_result", id: "unacked-result", task_id: "task-result",
    results: [{ id: "res", ok: true, output: "SECRET_MUSE_OUTPUT" }],
  });
  const destination = path.join(home, "bundle");
  const restored = path.join(home, "restored");
  return { home, root, port, destination, restored, journal, outbox, execution };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("phase 4k authenticated recovery archive backup/restore", () => {
  it("backs up complete private port state, restores only empty target, and retains all replay tombstones", () => {
    const s = fixture();
    const origin = inspectMuseRecoveryStorage(s.port, s.root);
    expect(origin).toMatchObject({
      active: 2, archived: 1, encryptedResults: 1, encryptedIntents: 1,
      integrityBlocked: 0,
    });
    const result = makeMuseRecoveryBackup(s.port, s.destination, s.root);
    expect(result).toEqual(origin);
    expect(verifyMuseRecoveryBackup(s.destination, s.port)).toEqual(origin);
    const manifest = JSON.parse(fs.readFileSync(path.join(s.destination, "recovery-bundle.json"), "utf8"));
    const names = manifest.files.map((file: { name: string }) => file.name);
    expect(names).toContain("muse-tombstones-" + s.port + ".key");
    expect(names).toContain("muse-results-" + s.port + ".json.key");
    expect(names).toContain("muse-execution-" + s.port + ".json.key");
    expect(names.some((n: string) => n.startsWith("muse-tombstones-" + s.port + "/"))).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain("SECRET_MUSE");
    expect(fs.readFileSync(outboxFile(s.port, s.destination), "utf8")).not.toContain("SECRET_MUSE_OUTPUT");
    const restored = restoreMuseRecoveryBackup(s.port, s.destination, s.restored);
    expect(restored).toEqual(origin);
    expect(fs.existsSync(restoreMarker(s.port, s.restored))).toBe(false);
    const rebooted = new MuseBatchJournal(s.port, s.restored);
    expect(rebooted.claim("archived-ack", "other", 0)).toBe(false);
    expect(rebooted.claim("active-unresolved", "other", 0)).toBe(false);
    expect(rebooted.claim("unacked-result", "other", 0)).toBe(false);
    expect(new MuseExecutionCheckpoint(s.port, s.restored).info("active-unresolved")).toMatchObject({
      canResumeUntouched: true,
    });
    expect(new MuseResultOutbox(s.port, s.restored).get("unacked-result")).toMatchObject({
      task_id: "task-result",
    });
    expect(() => makeMuseRecoveryBackup(s.port, s.destination, s.root)).toThrow(/already exists/);
    expect(() => restoreMuseRecoveryBackup(s.port, s.destination, s.root)).toThrow(/contains per-port history/);
  });

  it("fails closed on tampered result, missing archive/key, cross-port replay and missing journal", () => {
    const s = fixture();
    makeMuseRecoveryBackup(s.port, s.destination, s.root);
    const outbox = outboxFile(s.port, s.destination);
    const contents = fs.readFileSync(outbox);
    fs.writeFileSync(outbox, Buffer.concat([contents, Buffer.from("BROKEN")]));
    expect(() => verifyMuseRecoveryBackup(s.destination, s.port)).toThrow(/digest mismatch/);
    fs.writeFileSync(outbox, contents);
    expect(() => verifyMuseRecoveryBackup(s.destination, s.port + 1)).toThrow(/manifest/);
    const archive = new MuseTombstoneArchive(s.port, s.destination);
    const segment = fs.readdirSync(archive.folder)[0];
    fs.rmSync(path.join(archive.folder, segment));
    expect(() => verifyMuseRecoveryBackup(s.destination, s.port)).toThrow();
    expect(() => restoreMuseRecoveryBackup(s.port, s.destination, s.restored)).toThrow();
    expect(fs.existsSync(museJournalFile(s.port, s.restored))).toBe(false);
    const second = fixture();
    makeMuseRecoveryBackup(second.port, second.destination, second.root);
    fs.rmSync(path.join(second.destination, "muse-tombstones-" + second.port + ".key"));
    expect(() => verifyMuseRecoveryBackup(second.destination, second.port)).toThrow();
    const third = fixture();
    fs.rmSync(museJournalFile(third.port, third.root));
    expect(() => inspectMuseRecoveryStorage(third.port, third.root)).toThrow(/No durable/);
  });

  it("recovery restore crash leaves startup-blocking marker and requires operator inspection", () => {
    const s = fixture();
    makeMuseRecoveryBackup(s.port, s.destination, s.root);
    const open = fs.openSync;
    const watcher = vi.spyOn(fs, "openSync").mockImplementation(((name: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (String(name) === museJournalFile(s.port, s.restored)) throw new Error("SIMULATED_MID_RESTORE_CRASH");
      return open(name, flags as string, mode);
    }) as typeof fs.openSync);
    expect(() => restoreMuseRecoveryBackup(s.port, s.destination, s.restored)).toThrow(/SIMULATED/);
    watcher.mockRestore();
    expect(fs.existsSync(restoreMarker(s.port, s.restored))).toBe(true);
    expect(() => new MuseBatchJournal(s.port, s.restored)).toThrow(/Incomplete/);
    expect(() => restoreMuseRecoveryBackup(s.port, s.destination, s.restored)).toThrow(/Incomplete prior/);
    expect(fs.existsSync(executionCheckpointFile(s.port, s.restored))).toBe(true);
    expect(fs.existsSync(museJournalFile(s.port, s.restored))).toBe(false);
  });

  it("rejects symlinks and nested backup destinations, does not overwrite other history", () => {
    const s = fixture();
    expect(() => makeMuseRecoveryBackup(s.port, path.join(s.root, "nested"), s.root))
      .toThrow(/outside/);
    makeMuseRecoveryBackup(s.port, s.destination, s.root);
    const restored = path.join(s.home, "fresh-target");
    fs.mkdirSync(restored);
    fs.writeFileSync(path.join(restored, "muse-results-" + s.port + ".json"), "existing");
    expect(() => restoreMuseRecoveryBackup(s.port, s.destination, restored))
      .toThrow(/contains per-port history/);
    expect(fs.existsSync(restoreMarker(s.port, restored))).toBe(false);
    const other = fixture();
    makeMuseRecoveryBackup(other.port, other.destination, other.root);
    const index = museJournalFile(other.port, other.destination);
    const raw = fs.readFileSync(index);
    fs.rmSync(index);
    try {
      fs.symlinkSync(museJournalFile(other.port, other.root), index);
      expect(() => verifyMuseRecoveryBackup(other.destination, other.port)).toThrow();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    }
    if (fs.lstatSync(index).isSymbolicLink()) fs.rmSync(index);
    fs.writeFileSync(index, raw);
  });

  it("CLI backup/verify/restore is offline-locked, respects registered owners, never prints secret keys", async () => {
    const s = fixture();
    // CLI resolves per-port files inside homedir/.superagent-r.
    const root = path.join(s.home, ".superagent-r");
    fs.renameSync(s.root, root);
    vi.spyOn(os, "homedir").mockReturnValue(s.home);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
    const port = String(s.port);
    const lock = museJournalFile(s.port, root) + ".review.lock";
    const registration = path.join(root, "channel-host-" + port + ".json");
    const backup = ["backup", "--port", port, "--destination", s.destination];
    fs.writeFileSync(registration, "stale-owner");
    await expect(handleChannelHostCliCommand(backup)).rejects.toThrow(/registered/);
    fs.rmSync(registration);
    fs.writeFileSync(lock, "owner-elsewhere");
    await expect(handleChannelHostCliCommand(backup)).rejects.toThrow();
    fs.rmSync(lock);
    await expect(handleChannelHostCliCommand(backup)).resolves.toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    await expect(handleChannelHostCliCommand(["verify-backup", "--port", port,
      "--source", s.destination])).resolves.toBe(false);
    await expect(handleChannelHostCliCommand(["verify-store", "--port", port])).resolves.toBe(false);
    await expect(handleChannelHostCliCommand(["restore-backup", "--port", port,
      "--source", s.destination, "--confirm-port", "9999"])).rejects.toThrow(/confirm-port/);
    // Existing journal prevents silent rollback of an older snapshot.
    await expect(handleChannelHostCliCommand(["restore-backup", "--port", port,
      "--source", s.destination, "--confirm-port", port])).rejects.toThrow(/contains per-port history/);
    expect(output.join("\n")).not.toContain("SECRET_MUSE");
    expect(output.join("\n")).not.toContain("keyPath");

    // Simulate migration to a fresh empty owner storage namespace. The old
    // folder is preserved externally, rather than overwritten in place.
    const parked = path.join(s.home, "parked-original");
    fs.renameSync(root, parked);
    fs.mkdirSync(root);
    await expect(handleChannelHostCliCommand(["restore-backup", "--port", port,
      "--source", s.destination, "--confirm-port", port])).resolves.toBe(false);
    expect(fs.existsSync(restoreMarker(s.port, root))).toBe(false);
    const reloaded = new MuseBatchJournal(s.port, root);
    expect(reloaded.claim("archived-ack", "new-owner", 0)).toBe(false);
    expect(reloaded.claim("active-unresolved", "new-owner", 0)).toBe(false);
    expect(reloaded.archivedCount()).toBe(1);
  });
});
