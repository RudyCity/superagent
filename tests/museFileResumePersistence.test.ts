import { describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileTransferSender, FILE_TRANSFER_CHUNK_BYTES,
  type FileAckEnvelope, type FileTransferEnvelope,
} from "../src/core/remoteAgent/museFileTransfer.js";
import { DurableMuseFileReceiver } from "../src/core/remoteAgent/museFileReceiverPersistent.js";

async function fixture(size = 512 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "muse-persist-"));
  const source = path.join(root, "input.csv");
  const bytes = randomBytes(size);
  await fs.writeFile(source, bytes);
  return { root, source, bytes, storage: path.join(root, "inbox"), checkpointDir: path.join(root, "outbox") };
}

describe("Durable Muse receiver with checkpoint / resume", () => {
  it("survives interrupted transfer and sender/receiver restart, resumes at first missing chunk", async () => {
    const f = await fixture(6 * 1024 * 1024);
    try {
      let receiver = new DurableMuseFileReceiver(f.storage);
      let firstSender!: FileTransferSender;
      let accepted = 0;
      firstSender = new FileTransferSender(async (frame) => {
        if (frame.kind === "file_chunk" && frame.index >= 12) return false;
        const ack = await receiver.receive(frame as any);
        if (frame.kind === "file_chunk") accepted++;
        queueMicrotask(() => firstSender.handleAck(ack));
        return true;
      }, 500, 1);
      await expect(firstSender.sendFile(f.source, { checkpointDir: f.checkpointDir }))
        .rejects.toThrow("Timed out");
      expect(accepted).toBe(12);

      // Re-create both instances; source checkpoint and receiver manifest are both on disk.
      receiver = new DurableMuseFileReceiver(f.storage);
      let secondSender!: FileTransferSender;
      let firstIndex = -1;
      let lastStatus = 0;
      let resumed = false;
      secondSender = new FileTransferSender(async (frame) => {
        if (frame.kind === "file_chunk" && firstIndex < 0) firstIndex = frame.index;
        const ack = await receiver.receive(frame as any);
        queueMicrotask(() => secondSender.handleAck(ack));
        return true;
      }, 300, 2);
      const done = await secondSender.sendFile(f.source, {
        checkpointDir: f.checkpointDir,
        onProgress: (p) => { lastStatus = p.percent; resumed = p.resumed; },
      });
      expect(firstIndex).toBe(12);
      expect(lastStatus).toBe(100);
      expect(resumed).toBe(true);
      const receipt = await receiver.getReceipt(done.transferId);
      expect(receipt?.sha256).toBe(createHash("sha256").update(f.bytes).digest("hex"));
      expect((await fs.readFile(receipt!.savedPath)).equals(f.bytes)).toBe(true);
      // Complete ACK is idempotent even after the receiver restarts.
      const ack = await new DurableMuseFileReceiver(f.storage).receive({
        v: 1, kind: "file_complete", id: randomUUID(), transfer_id: done.transferId,
      });
      expect(ack.ok).toBe(true);
      expect((await fs.readdir(f.checkpointDir)).filter(n => n.endsWith(".json"))).toEqual([]);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  }, 25_000);

  it("rejects whole-file checksum failures and enforces receiver byte quota", async () => {
    const f = await fixture(1024);
    try {
      const receiver = new DurableMuseFileReceiver(f.storage, { maxStorageBytes: 900 });
      const offer = {
        v: 1 as const, kind: "file_offer" as const, id: randomUUID(),
        transfer_id: randomUUID(), name: "example.csv", size: 1024,
        sha256: "a".repeat(64), chunk_bytes: FILE_TRANSFER_CHUNK_BYTES, total_chunks: 1,
      };
      expect((await receiver.receive(offer)).error).toBe("Receiver quota reached");
      expect((await fs.readdir(f.storage)).some(n => n.endsWith(".part"))).toBe(false);
    } finally {
      await fs.rm(f.root, { recursive: true, force: true });
    }
  });

  it("rejects forged duplicate data instead of ACKing arbitrary retransmissions", async () => {
    const f = await fixture(1024);
    try {
      const receiver = new DurableMuseFileReceiver(f.storage);
      const transferId = randomUUID();
      const offer = {
        v: 1 as const, kind: "file_offer" as const, id: randomUUID(),
        transfer_id: transferId, name: "example.csv", size: 1024,
        sha256: createHash("sha256").update(f.bytes).digest("hex"),
        chunk_bytes: FILE_TRANSFER_CHUNK_BYTES, total_chunks: 1,
      };
      expect((await receiver.receive(offer)).ok).toBe(true);
      const good = {
        v: 1 as const, kind: "file_chunk" as const, id: randomUUID(), transfer_id: transferId,
        index: 0, offset: 0, data_base64: f.bytes.toString("base64"),
      };
      expect((await receiver.receive(good)).ok).toBe(true);
      expect((await receiver.receive({ ...good, data_base64: Buffer.alloc(1024).toString("base64") })).ok).toBe(false);
      expect((await receiver.receive({ ...good, id: randomUUID() })).ok).toBe(true);
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });

  it("expires receiving and completed files according to retention configuration", async () => {
    const f = await fixture(2);
    try {
      const receiver = new DurableMuseFileReceiver(f.storage, { expireAfterMs: 1 });
      const offer = {
        v: 1 as const, kind: "file_offer" as const, id: randomUUID(),
        transfer_id: randomUUID(), name: "example.csv", size: 2,
        sha256: "0".repeat(64), chunk_bytes: FILE_TRANSFER_CHUNK_BYTES, total_chunks: 1,
      };
      expect((await receiver.receive(offer)).ok).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(await receiver.prune()).toBe(1);
      expect((await receiver.getReceipt(offer.transfer_id))).toBeNull();
    } finally { await fs.rm(f.root, { recursive: true, force: true }); }
  });
});
