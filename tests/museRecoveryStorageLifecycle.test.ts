import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseResultOutbox, outboxFile } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseExecutionCheckpoint, executionCheckpointFile } from "../src/core/remoteAgent/museExecutionCheckpoint.js";
import { MuseRecoveryStorageLifecycle } from "../src/core/remoteAgent/museRecoveryStorageLifecycle.js";
import { MuseRecoveryOrchestrator } from "../src/core/remoteAgent/museRecoveryOrchestrator.js";
import { handleChannelHostCliCommand } from "../src/core/runtime/channelHost.js";

const dirs: string[] = [];
function fixture(rootOverride?: string) {
  const root = rootOverride ?? fs.mkdtempSync(path.join(os.tmpdir(), "muse-retention-"));
  if (!rootOverride) dirs.push(root);
  const port = 53449;
  const journal = new MuseBatchJournal(port, root);
  const outbox = new MuseResultOutbox(port, root);
  const execution = new MuseExecutionCheckpoint(port, root);
  const lifecycle = new MuseRecoveryStorageLifecycle(journal, execution, outbox);
  const add = (id: string, opts: { ack?: boolean; intent?: boolean; payload?: boolean } = {}) => {
    journal.claim(id, "task-" + id, 1);
    if (opts.intent !== false) {
      execution.store({ v: 1, kind: "task_batch", id, task_id: "task-" + id,
        calls: [{ id: "c1", tool: "write", args: { content: "PRIVATE_RETENTION_ARGUMENT" } }] }, root);
    }
    if (opts.payload !== false) {
      journal.transition(id, "result_pending");
      const { sha256 } = outbox.put({ v: 1, kind: "task_result", id,
        task_id: "task-" + id, results: [{ id: "c1", ok: true, output: "PRIVATE_RETENTION_RESULT" }] });
      journal.transition(id, "delivered");
      if (opts.ack) journal.acknowledgeResult(id, "task-" + id, sha256);
      return sha256;
    }
    return null;
  };
  return { root, port, journal, outbox, execution, lifecycle, add };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("phase 4i ACK-bounded encrypted recovery payload lifecycle", () => {
  it("retains result and intent until ACK age reached; keeps permanent journal dedupe after explicit cleanup", () => {
    const s = fixture();
    s.add("aged", { ack: true });
    const before = s.lifecycle.assess("aged");
    expect(before.status).toBe("retention_period");
    expect(() => s.lifecycle.pruneOne("aged")).toThrow(/minimum_receipt_age/);
    expect(s.lifecycle.assess("aged", 7, Date.now() + 8 * 86_400_000).status).toBe("eligible");
    expect(s.lifecycle.plan(0)[0]).toMatchObject({
      batchId: "aged", status: "eligible", canPrune: true, resultPresent: true, intentPresent: true,
    });
    const report = s.lifecycle.pruneOne("aged", 0);
    expect(report).toMatchObject({
      batchId: "aged", cleanupTombstone: true, releasedResult: true, releasedIntent: true,
    });
    const journal = new MuseBatchJournal(s.port, s.root);
    const record = journal.get("aged");
    expect(record?.resultAck?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record?.payloadReleasedAt).toBeGreaterThanOrEqual(record!.resultAck!.receivedAt);
    expect(journal.claim("aged", "task-aged", 1)).toBe(false);
    expect(new MuseResultOutbox(s.port, s.root).count()).toBe(0);
    expect(new MuseExecutionCheckpoint(s.port, s.root).info("aged")).toBeNull();
    expect(fs.existsSync(outboxFile(s.port, s.root) + ".key")).toBe(true);
    expect(fs.existsSync(executionCheckpointFile(s.port, s.root) + ".key")).toBe(true);
    expect(new MuseRecoveryOrchestrator(journal,
      new MuseExecutionCheckpoint(s.port, s.root),
      new MuseResultOutbox(s.port, s.root)).assess("aged")).toMatchObject({
        decision: "acknowledged", canRequestUntouchedResume: false, canRequestResultReplay: false,
        reason: "acknowledged_payload_release_recorded",
      });
    expect(s.lifecycle.assess("aged").status).toBe("already_released");
  });

  it("never prunes unacknowledged, manually reviewed, mismatched or missing records", () => {
    const s = fixture();
    s.add("unacked");
    expect(s.lifecycle.assess("unacked", 0).status).toBe("not_acknowledged");
    expect(() => s.lifecycle.pruneOne("unacked", 0)).toThrow(/receipt_required/);
    s.add("mismatch");
    expect(s.journal.acknowledgeResult("mismatch", "task-mismatch", "0".repeat(64))).toBe(true);
    expect(s.lifecycle.assess("mismatch", 0)).toMatchObject({
      status: "integrity_blocked", reason: "receipt_outbox_mismatch",
    });
    expect(() => s.lifecycle.pruneOne("mismatch", 0)).toThrow(/receipt_outbox_mismatch/);
    expect(() => s.lifecycle.pruneOne("not-found", 0)).toThrow(/Unknown retention batch/);
    s.journal.claim("review", "task-review", 1);
    s.journal.transition("review", "uncertain");
    s.journal.reconcile("review", "effect_verified", "f".repeat(64));
    expect(s.lifecycle.assess("review", 0).status).toBe("not_acknowledged");
    expect(s.outbox.get("unacked")).not.toBeNull();
  });

  it("recovers from a crash after tombstone, between removing result and intent, without replay", () => {
    const s = fixture();
    const digest = s.add("partial-cleanup", { ack: true })!;
    s.journal.markPayloadReleased("partial-cleanup", digest);
    const reload1 = MuseRecoveryStorageLifecycle.load(s.port, s.root);
    expect(reload1.assess("partial-cleanup", 7).status).toBe("cleanup_incomplete");
    expect(reload1.pruneOne("partial-cleanup", 7)).toMatchObject({
      releasedResult: true, releasedIntent: true,
    });
    const persisted = MuseRecoveryStorageLifecycle.load(s.port, s.root);
    expect(persisted.assess("partial-cleanup").status).toBe("already_released");
    expect(() => persisted.pruneOne("partial-cleanup", 0)).toThrow(/payload_released/);

    const t = fixture();
    const hash = t.add("half", { ack: true })!;
    t.journal.markPayloadReleased("half", hash);
    t.outbox.releaseAcknowledgedPayload("half", hash);
    const retry = MuseRecoveryStorageLifecycle.load(t.port, t.root);
    expect(retry.assess("half").status).toBe("cleanup_incomplete");
    const result = retry.pruneOne("half");
    expect(result.releasedResult).toBe(false);
    expect(result.releasedIntent).toBe(true);
    expect(new MuseBatchJournal(t.port, t.root).claim("half", "task-half", 1)).toBe(false);
  });

  it("offline CLI dry run is read-only; prune requires exact ID, exclusive lock, no live registration", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "muse-retention-home-"));
    dirs.push(home);
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const root = path.join(home, ".superagent-r");
    const s = fixture(root);
    s.add("prunable", { ack: true });
    const captured: string[] = [];
    const logger = vi.spyOn(console, "log").mockImplementation((...msg) => { captured.push(msg.join(" ")); });
    const original = fs.readFileSync(outboxFile(s.port, root), "utf8");
    await expect(handleChannelHostCliCommand(["retention", "--port", String(s.port),
      "--min-age-days", "0"])).resolves.toBe(false);
    const allLogs = captured.join("\n");
    expect(allLogs).toContain("eligible");
    expect(allLogs).not.toContain("PRIVATE_RETENTION_ARGUMENT");
    expect(allLogs).not.toContain("PRIVATE_RETENTION_RESULT");
    expect(fs.readFileSync(outboxFile(s.port, root), "utf8")).toBe(original);
    const args = ["prune", "--port", String(s.port), "--batch-id", "prunable",
      "--confirm", "prunable", "--min-age-days", "0"];
    await expect(handleChannelHostCliCommand(args.filter(item => item !== "prunable")))
      .rejects.toThrow();
    const reg = path.join(root, "channel-host-" + s.port + ".json");
    fs.writeFileSync(reg, "stale-owner-guard");
    await expect(handleChannelHostCliCommand(args)).rejects.toThrow(/registered channel-host owner/);
    fs.rmSync(reg);
    const lock = museJournalFile(s.port, root) + ".review.lock";
    fs.writeFileSync(lock, "existing owner");
    await expect(handleChannelHostCliCommand(args)).rejects.toThrow();
    fs.rmSync(lock);
    await expect(handleChannelHostCliCommand(args)).resolves.toBe(false);
    expect(fs.existsSync(lock)).toBe(false);
    expect(new MuseRecoveryStorageLifecycle(
      new MuseBatchJournal(s.port, root),
      new MuseExecutionCheckpoint(s.port, root),
      new MuseResultOutbox(s.port, root)).assess("prunable").status).toBe("already_released");
    expect(fs.readFileSync(museJournalFile(s.port, root), "utf8")).toContain("prunable");
    logger.mockRestore();
  });
});
