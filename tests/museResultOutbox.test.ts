import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MuseResultOutbox, outboxFile } from "../src/core/remoteAgent/museResultOutbox.js";
import { MuseBatchJournal } from "../src/core/remoteAgent/museBatchJournal.js";
import { MuseWatcher } from "../src/core/remoteAgent/museWatcher.js";
import { validateEnvelope } from "../src/core/remoteAgent/protocol.js";
import type { TaskResultEnvelope } from "../src/core/remoteAgent/protocol.js";
import type { RemoteTransport } from "../src/core/remoteAgent/transport.js";

const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-outbox-"));
  roots.push(root);
  return { root, port: 53013 };
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("phase 4f encrypted result outbox", () => {
  it("encrypts plaintext output at rest, reloads and rejects tampering or conflicting IDs", () => {
    const { root, port } = fixture();
    const outbox = new MuseResultOutbox(port, root);
    const result: TaskResultEnvelope = {
      v: 1, kind: "task_result", id: "batch-1", task_id: "task-1",
      results: [{ id: "call-1", ok: true, output: "PRIVATE_API_KEY_SHOULD_NOT_LEAK" }],
    };
    const first = outbox.put(result);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.result.result_sha256).toBe(first.sha256);
    expect(outbox.put(result).sha256).toBe(first.sha256);
    expect(() => outbox.put({ ...result, results: [{ id: "call-1", ok: true, output: "changed" }] })).toThrow(/Conflicting/);
    const raw = fs.readFileSync(outboxFile(port, root), "utf8");
    expect(raw).not.toContain("PRIVATE_API_KEY_SHOULD_NOT_LEAK");
    const recovered = new MuseResultOutbox(port, root);
    expect(recovered.get("batch-1")).toEqual(first.result);
    const file = outboxFile(port, root);
    const parsed = JSON.parse(raw);
    parsed.entries[0].ciphertext = "AA" + parsed.entries[0].ciphertext.slice(2);
    fs.writeFileSync(file, JSON.stringify(parsed));
    expect(() => new MuseResultOutbox(port, root)).toThrow();
  });

  it("refuses oversized results and never puts plaintext on disk", () => {
    const { root, port } = fixture();
    const outbox = new MuseResultOutbox(port, root);
    const result: TaskResultEnvelope = { v: 1, kind: "task_result", id: "huge",
      task_id: "task-2", results: [{ id: "call", ok: true, output: "z".repeat(110_000) }] };
    expect(() => outbox.put(result)).toThrow(/too large/);
    expect(fs.existsSync(outboxFile(port, root))).toBe(false);
    expect(fs.existsSync(outboxFile(port, root) + ".key")).toBe(false);
  });

  it("keeps an unsent result pending across restart and delivers it only on explicit replay", async () => {
    const { root, port } = fixture();
    let acceptSend = false;
    const sent: TaskResultEnvelope[] = [];
    const transport: RemoteTransport = {
      type: "websocket", start: async () => {}, stop: async () => {},
      sendEnvelope: async message => {
        if (message.kind === "task_result") {
          if (acceptSend) sent.push(message);
          return acceptSend;
        }
        return true;
      },
      isConnected: () => acceptSend,
      getTransportInfo: () => ({ type: "websocket", details: "isolated broken connection" }),
    };
    const firstJournal = new MuseBatchJournal(port, root);
    const first = new MuseWatcher({
      workspaces: [root], announce: false, transport, batchJournal: firstJournal,
      resultOutbox: new MuseResultOutbox(port, root),
    });
    await first.start();
    try {
      await first.handleEnvelope({ v: 1, kind: "task_batch", id: "unsent",
        task_id: "task-unsent", calls: [] });
      await first.waitForIdle();
      expect(firstJournal.get("unsent")?.stage).toBe("result_pending");
      expect(new MuseResultOutbox(port, root).get("unsent")).toMatchObject({
        id: "unsent", task_id: "task-unsent",
      });
      expect(sent).toHaveLength(0);
    } finally { await first.stop(); }
    acceptSend = true;
    const recoveredJournal = new MuseBatchJournal(port, root);
    const restarted = new MuseWatcher({
      workspaces: [root], announce: false, transport,
      batchJournal: recoveredJournal, resultOutbox: new MuseResultOutbox(port, root),
    });
    await restarted.start();
    try {
      await restarted.handleEnvelope({ v: 1, kind: "task_batch",
        id: "unsent", task_id: "task-unsent", calls: [] });
      await restarted.waitForIdle();
      expect(restarted.getStats().batchesExecuted).toBe(0);
      expect(sent).toHaveLength(0);
      expect(await restarted.replayStoredResult("unsent")).toBe(true);
      expect(sent).toHaveLength(1);
      expect(recoveredJournal.get("unsent")?.stage).toBe("delivered");
    } finally { await restarted.stop(); }
  });

  it("replays the saved result explicitly after a restart, does not re-execute tools, and requires matching Muse ACK", async () => {
    const { root, port } = fixture();
    const sent: TaskResultEnvelope[] = [];
    const transport: RemoteTransport = {
      type: "websocket", start: async () => {}, stop: async () => {},
      sendEnvelope: async message => {
        if (message.kind === "task_result") sent.push(message);
        return true;
      },
      isConnected: () => true,
      getTransportInfo: () => ({ type: "websocket", details: "fake secure ws transport" }),
    };
    const firstJournal = new MuseBatchJournal(port, root);
    const first = new MuseWatcher({
      workspaces: [root], announce: false, transport, batchJournal: firstJournal,
      resultOutbox: new MuseResultOutbox(port, root),
    });
    await first.start();
    try {
      await first.handleEnvelope({ v: 1, kind: "task_batch", id: "batch-replay",
        task_id: "task-replay", calls: [] });
      await first.waitForIdle();
      expect(first.getStats().batchesExecuted).toBe(1);
      expect(sent).toHaveLength(1);
      expect(firstJournal.get("batch-replay")?.stage).toBe("delivered");
      expect(firstJournal.get("batch-replay")?.resultAck).toBeUndefined();
    } finally { await first.stop(); }
    const restartedJournal = new MuseBatchJournal(port, root);
    const second = new MuseWatcher({
      workspaces: [root], announce: false, transport,
      batchJournal: restartedJournal, resultOutbox: new MuseResultOutbox(port, root),
    });
    await second.start();
    try {
      await second.handleEnvelope({ v: 1, kind: "task_batch", id: "batch-replay",
        task_id: "task-replay", calls: [] });
      await second.waitForIdle();
      expect(second.getStats().batchesExecuted).toBe(0);
      expect(sent).toHaveLength(1); // NO automatic result replay.
      expect(await second.replayStoredResult("batch-replay")).toBe(true);
      expect(second.getStats().batchesExecuted).toBe(0);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]); // Identical result ID, payload, digest.
      const digest = sent[0].result_sha256!;
      const ack = { v: 1 as const, kind: "result_ack" as const,
        id: "batch-replay", task_id: "task-replay", result_sha256: digest };
      expect(validateEnvelope(ack).valid).toBe(true);
      const spoofed = validateEnvelope(ack, "stranger", "grp", { groupId: "grp", museBotId: "trusted" });
      expect(spoofed.valid).toBe(false);
      await second.handleEnvelope(ack); // no authenticated origin
      await second.handleEnvelope({ ...ack, result_sha256: "e".repeat(64) },
        { transport: "websocket", connectionId: "authenticated-fixture" });
      expect(restartedJournal.summary().acknowledged).toBe(0);
      await second.handleEnvelope(ack, { transport: "websocket", connectionId: "authenticated-fixture" });
      expect(restartedJournal.summary().acknowledged).toBe(1);
      expect(new MuseBatchJournal(port, root).taskRecovery()).toMatchObject([{
        taskId: "task-replay", acknowledged: 1, status: "remote_acknowledged",
      }]);
      expect(await second.replayStoredResult("batch-replay")).toBe(false);
      expect(sent).toHaveLength(2);
    } finally { await second.stop(); }
  });
});
