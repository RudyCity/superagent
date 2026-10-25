import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MuseBatchJournal, museJournalFile } from "../src/core/remoteAgent/museBatchJournal.js";
import { handleChannelHostCliCommand, runChannelHost } from "../src/core/runtime/channelHost.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import type { RemoteTransport } from "../src/core/remoteAgent/transport.js";

const owned: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-recovery-"));
  owned.push(dir);
  return { dir, port: 49261 };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of owned.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("phase 4e conservative task recovery and reconciliation", () => {
  it("restores task lifecycle facts and immutable evidence review without replay", () => {
    const { dir, port } = fixture();
    const first = new MuseBatchJournal(port, dir);
    first.observeTask("task-a", "accepted");
    first.claim("batch-a", "task-a", 2);
    first.transition("batch-a", "uncertain");
    first.observeTask("task-a", "done_seen");
    const recovered = new MuseBatchJournal(port, dir);
    expect(recovered.taskRecovery()).toMatchObject([{
      taskId: "task-a", phase: "done_seen", status: "needs_review", batches: 1,
      requiringReview: 1, reviewed: 0,
    }]);
    const proof = "b".repeat(64);
    const decision = recovered.reconcile("batch-a", "effect_verified", proof);
    expect(decision.stage).toBe("uncertain");
    expect(decision.review).toMatchObject({ outcome: "effect_verified", evidenceSha256: proof });
    expect(recovered.reconcile("batch-a", "effect_verified", proof).review).toEqual(decision.review);
    expect(() => recovered.reconcile("batch-a", "no_effect_verified", proof)).toThrow(/Conflicting/);
    expect(() => recovered.transition("batch-a", "result_pending")).toThrow(/immutable/);
    const rebooted = new MuseBatchJournal(port, dir);
    expect(rebooted.taskRecovery()).toMatchObject([{
      taskId: "task-a", status: "reviewed_no_replay", reviewed: 1, requiringReview: 0,
    }]);
    expect(rebooted.summary()).toMatchObject({
      uncertain: 1, reviewed: 1, requiresReconciliation: 0,
    });
    expect(rebooted.claim("batch-a", "task-a", 2)).toBe(false);
    const raw = fs.readFileSync(museJournalFile(port, dir), "utf8");
    expect(raw).not.toContain("tool arguments");
    expect(raw).not.toContain("workspace");
    expect(raw).not.toContain("prompt");
  });

  it("refuses unsupported decisions, corrupt lifecycle metadata and delivered reviews", () => {
    const { dir, port } = fixture();
    const journal = new MuseBatchJournal(port, dir);
    journal.claim("pending", "task-a", 0);
    journal.claim("sent", "task-b", 0);
    journal.transition("sent", "result_pending");
    journal.transition("sent", "delivered");
    expect(() => journal.reconcile("unknown", "effect_verified", "d".repeat(64))).toThrow(/Unknown/);
    expect(() => journal.reconcile("pending", "effect_verified", "short")).toThrow(/evidence/);
    expect(() => journal.reconcile("sent", "effect_verified", "c".repeat(64))).toThrow(/Delivered/);
    journal.observeTask("task-a", "done_seen");
    journal.observeTask("task-a", "accepted"); // Must never regress done_seen.
    expect(new MuseBatchJournal(port, dir).taskRecovery().find(t => t.taskId === "task-a")?.phase).toBe("done_seen");
    const document = JSON.parse(fs.readFileSync(museJournalFile(port, dir), "utf8"));
    document.taskSignals.push({ taskId: "task-a", phase: "accepted", observedAt: Date.now() });
    fs.writeFileSync(museJournalFile(port, dir), JSON.stringify(document));
    expect(() => new MuseBatchJournal(port, dir)).toThrow(/duplicate/i);
  });

  it("records Muse task request/done signal metadata with no task text or response", async () => {
    const { dir, port } = fixture();
    const journal = new MuseBatchJournal(port, dir);
    const emitted: string[] = [];
    const transport: RemoteTransport = {
      type: "https",
      start: async () => {},
      stop: async () => {},
      sendEnvelope: async () => { emitted.push("message"); return true; },
      isConnected: () => true,
      getTransportInfo: () => ({ type: "https", details: "fake" }),
    };
    const watcher = new MuseWatcher({
      workspaces: [dir], transport, announce: false, batchJournal: journal,
    });
    await watcher.start();
    try {
      await watcher.handleEnvelope({
        v: 1, kind: "task_request", id: "task-observed", task: "PRIVATE task text",
        workspace: dir, tools: [],
      });
      await watcher.handleEnvelope({
        v: 1, kind: "task_done", task_id: "task-observed",
        summary: "PRIVATE summary",
      });
      await watcher.waitForIdle();
      const restored = new MuseBatchJournal(port, dir);
      expect(restored.taskRecovery()).toMatchObject([{
        taskId: "task-observed", phase: "done_seen", status: "metadata_only",
      }]);
      const saved = fs.readFileSync(museJournalFile(port, dir), "utf8");
      expect(saved).not.toContain("PRIVATE");
      expect(saved).not.toContain(dir);
    } finally { await watcher.stop(); }
  });

  it("allows only offline explicit reconciliations, never a live owner", async () => {
    const { dir, port } = fixture();
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".superagent-r"), { recursive: true });
    const homeMock = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      const journal = new MuseBatchJournal(port);
      journal.claim("cli-batch", "cli-task", 1);
      const digest = "a".repeat(64);
      const args = [
        "reconcile", "--port", String(port), "--batch-id", "cli-batch",
        "--decision", "no_effect_verified", "--evidence-sha256", digest,
        "--confirm", "cli-batch",
      ];
      await expect(handleChannelHostCliCommand(args.slice(0, -1).concat("different"))).rejects.toThrow(/requires exact/);
      const discovery = path.join(home, ".superagent-r", "channel-host-" + port + ".json");
      fs.writeFileSync(discovery, "{}");
      await expect(handleChannelHostCliCommand(args)).rejects.toThrow(/registered/);
      fs.rmSync(discovery);
      const fakeLock = museJournalFile(port) + ".review.lock";
      fs.writeFileSync(fakeLock, "busy");
      await expect(runChannelHost({
        port, wsPort: 9225, mode: "idle",
      })).rejects.toThrow(/under offline reconciliation/);
      fs.rmSync(fakeLock);
      expect(await handleChannelHostCliCommand(args)).toBe(false);
      expect(new MuseBatchJournal(port).get("cli-batch")?.review?.outcome).toBe("no_effect_verified");
      expect(fs.existsSync(fakeLock)).toBe(false);
      expect(new MuseBatchJournal(port).claim("cli-batch", "cli-task", 1)).toBe(false);
    } finally { homeMock.mockRestore(); }
  });
});
