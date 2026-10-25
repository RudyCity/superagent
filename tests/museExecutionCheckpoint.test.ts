import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MuseExecutionCheckpoint, executionCheckpointFile } from "../src/core/remoteAgent/museExecutionCheckpoint.js";
import { MuseBatchJournal } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseResultOutbox } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import { executeBatch } from "../src/core/remoteAgent/batchExecutor.js";
import type { TaskBatchEnvelope } from "../src/core/remoteAgent/protocol.js";
import type { RemoteTransport } from "../src/core/remoteAgent/transport.js";

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-execution-"));
  roots.push(root);
  return { root, port: 53931 };
};
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const batch = (id: string, calls: TaskBatchEnvelope["calls"] = []): TaskBatchEnvelope => ({
  v: 1, kind: "task_batch", id, task_id: "task-" + id, calls,
});
const transport = (received: string[]): RemoteTransport => ({
  type: "websocket", start: async () => {}, stop: async () => {},
  sendEnvelope: async value => { received.push(value.kind); return true; },
  isConnected: () => true,
  getTransportInfo: () => ({ type: "websocket", details: "isolated synthetic connection" }),
});
describe("phase 4g encrypted execution checkpoint and controlled resume", () => {
  it("encrypts intent and durably persists attempted/completed tool boundaries", () => {
    const { root, port } = fixture();
    const intent = batch("sensitive", [{ id: "c1", tool: "write",
      args: { content: "SECRET_THAT_MUST_NEVER_BE_PLAINTEXT" } }]);
    const checkpoint = new MuseExecutionCheckpoint(port, root);
    checkpoint.store(intent, root);
    const disk = fs.readFileSync(executionCheckpointFile(port, root), "utf8");
    expect(disk).not.toContain("SECRET_THAT_MUST_NEVER_BE_PLAINTEXT");
    expect(disk).not.toContain(root);
    checkpoint.markStarted(intent.id, "c1");
    checkpoint.markFinished(intent.id, "c1");
    const fresh = new MuseExecutionCheckpoint(port, root);
    expect(fresh.info(intent.id)).toMatchObject({
      started: 1, finished: 1, reserved: false, canResumeUntouched: false,
    });
    expect(fresh.reserveUntouched(intent.id, [root])).toBeNull();
    expect(() => fresh.markStarted(intent.id, "c1")).toThrow();
    const data = JSON.parse(disk);
    data.tag = "a".repeat(32);
    fs.writeFileSync(executionCheckpointFile(port, root), JSON.stringify(data));
    expect(() => new MuseExecutionCheckpoint(port, root)).toThrow();
  });

  it("permits exactly one explicit zero-tool-start recovery across host memory loss", async () => {
    const { root, port } = fixture();
    const original = batch("untouched", [{ id: "c1", tool: "no_such_tool", args: {} }]);
    const journal = new MuseBatchJournal(port, root);
    journal.claim(original.id, original.task_id, original.calls.length);
    const checkpoint = new MuseExecutionCheckpoint(port, root);
    checkpoint.store(original, root);
    // Simulated process crash AFTER claim + encrypted seal but BEFORE call start.
    const saved = new MuseExecutionCheckpoint(port, root);
    expect(saved.reserveUntouched(original.id, [path.join(root, "wrong")])).toBeNull();
    const sent: string[] = [];
    const watcher = new MuseWatcher({
      workspaces: [root], transport: transport(sent), announce: false,
      batchJournal: new MuseBatchJournal(port, root),
      resultOutbox: new MuseResultOutbox(port, root),
      executionCheckpoint: saved,
    });
    await watcher.start();
    try {
      expect(await watcher.resumeUntouchedBatch("untouched")).toBe(true);
      await watcher.waitForIdle();
      expect(watcher.getStats().batchesExecuted).toBe(1);
      expect(sent.filter(kind => kind === "task_result")).toHaveLength(1);
      expect(saved.info("untouched")).toMatchObject({
        started: 1, finished: 1, reserved: true, canResumeUntouched: false,
      });
      expect(await watcher.resumeUntouchedBatch("untouched")).toBe(false);
    } finally { await watcher.stop(); }
    const restarted = new MuseExecutionCheckpoint(port, root);
    expect(restarted.reserveUntouched(original.id, [root])).toBeNull();
    // Original workspace selection is stable, even if a batch used a project
    // name that could resolve differently after watch-list reordering.
    const second = batch("workspace-pin", []);
    second.project = "ambiguous-project";
    restarted.store(second, root);
    expect(restarted.reserveUntouched(second.id, [root])?.workspace).toBe(root);
  });

  it("refuses to resume a batch after ANY call attempted, including a started but unfinished tool", async () => {
    const { root, port } = fixture();
    const envelope = batch("partial", [
      { id: "read-1", tool: "read", args: { filePaths: ["secrets.txt"] } },
      { id: "cmd-2", tool: "run_command", args: { command: "echo should-not-run" } },
    ]);
    const journal = new MuseBatchJournal(port, root);
    journal.claim(envelope.id, envelope.task_id, envelope.calls.length);
    const original = new MuseExecutionCheckpoint(port, root);
    original.store(envelope, root);
    original.markStarted("partial", "read-1"); // crashed while first tool active
    const watcher = new MuseWatcher({
      workspaces: [root], transport: transport([]), announce: false,
      batchJournal: new MuseBatchJournal(port, root),
      resultOutbox: new MuseResultOutbox(port, root),
      executionCheckpoint: new MuseExecutionCheckpoint(port, root),
    });
    await watcher.start();
    try {
      expect(await watcher.resumeUntouchedBatch("partial")).toBe(false);
      expect(watcher.getStats().batchesExecuted).toBe(0);
      expect(new MuseExecutionCheckpoint(port, root).info("partial")).toMatchObject({
        started: 1, finished: 0, reserved: false, canResumeUntouched: false,
      });
    } finally { await watcher.stop(); }
  });

  it("fails closed if durable before-tool boundary cannot be written", async () => {
    const { root } = fixture();
    await expect(executeBatch([{ id: "one", tool: "no_such_tool" }], {
      workspace: root, beforeToolInvoke: () => { throw new Error("CHECKPOINT_DISK_FAIL"); },
    })).rejects.toThrow("CHECKPOINT_DISK_FAIL");
  });
});
