import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FileTransferReceiver, FileTransferSender, FILE_TRANSFER_MAX_BYTES,
  FILE_TRANSFER_CHUNK_BYTES, resolveTransferSource,
} from "../src/core/remoteAgent/museFileTransfer.js";
import { validateEnvelope } from "../src/core/remoteAgent/protocol.js";
import type {
  FileOfferEnvelope, FileChunkEnvelope, FileCompleteEnvelope, FileTransferEnvelope,
} from "../src/core/remoteAgent/museFileTransfer.js";

const roots: string[] = [];
async function temp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "muse-transfer-test-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function transferFile(size: number, dropChunkAck = false) {
  const root = await temp();
  const source = path.join(root, "input.csv");
  const destination = path.join(root, "received");
  const bytes = randomBytes(size);
  await fs.writeFile(source, bytes);
  const receiver = new FileTransferReceiver(destination);
  const seen = new Map<number, number>();
  let sender!: FileTransferSender;
  sender = new FileTransferSender(async (frame) => {
    expect(validateEnvelope(frame).valid).toBe(true);
    const ack = await receiver.receive(frame);
    if (frame.kind === "file_chunk") {
      seen.set(frame.index, (seen.get(frame.index) || 0) + 1);
      if (dropChunkAck && frame.index === 2 && seen.get(frame.index) === 1) {
        return true;
      }
    }
    queueMicrotask(() => sender.handleAck(ack));
    return true;
  }, 15, 3);
  const sent = await sender.sendFile(source);
  const received = receiver.getReceipt(sent.transferId);
  expect(received).not.toBeNull();
  expect(received?.sha256).toBe(sent.sha256);
  expect(received?.size).toBe(size);
  expect(received?.chunks).toBe(Math.ceil(size / FILE_TRANSFER_CHUNK_BYTES));
  const reconstructed = await fs.readFile(received!.savedPath);
  expect(reconstructed.equals(bytes)).toBe(true);
  expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(sent.sha256);
  return { sent, seen };
}

describe("Muse verified WebSocket file transfer", () => {
  it("reconstructs and verifies 0.5 MiB CSV without tool-result truncation", async () => {
    const { sent } = await transferFile(512 * 1024);
    expect(sent.chunks).toBe(8);
  });

  it("reconstructs and verifies a 6 MiB CSV, 96 chunks", async () => {
    const { sent } = await transferFile(6 * 1024 * 1024);
    expect(sent.chunks).toBe(96);
  });

  it("retries an unacknowledged chunk without duplicate bytes", async () => {
    const { seen } = await transferFile(512 * 1024, true);
    expect(seen.get(2)).toBe(2);
  });

  it("rejects corrupted whole-file SHA-256 and persists nothing", async () => {
    const root = await temp();
    const receiver = new FileTransferReceiver(path.join(root, "received"));
    const transferId = randomUUID();
    const data = Buffer.from("alpha,beta\n1,2\n");
    const offer: FileOfferEnvelope = {
      v: 1, kind: "file_offer", id: randomUUID(), transfer_id: transferId,
      name: "sample.csv", size: data.length, sha256: "0".repeat(64),
      chunk_bytes: FILE_TRANSFER_CHUNK_BYTES, total_chunks: 1,
    };
    const chunk: FileChunkEnvelope = {
      v: 1, kind: "file_chunk", id: randomUUID(), transfer_id: transferId,
      index: 0, offset: 0, data_base64: data.toString("base64"),
    };
    const done: FileCompleteEnvelope = {
      v: 1, kind: "file_complete", id: randomUUID(), transfer_id: transferId,
    };
    expect((await receiver.receive(offer)).ok).toBe(true);
    expect((await receiver.receive(chunk)).ok).toBe(true);
    const ack = await receiver.receive(done);
    expect(ack.ok).toBe(false);
    expect(ack.error).toContain("SHA-256 mismatch");
    expect(receiver.getReceipt(transferId)).toBeNull();
    await expect(fs.readdir(path.join(root, "received"))).rejects.toThrow();
  });

  it("rejects traversal, invalid chunks and out-of-order frames", async () => {
    const root = await temp();
    const receiver = new FileTransferReceiver(path.join(root, "received"));
    const transferId = randomUUID();
    const base: FileOfferEnvelope = {
      v: 1, kind: "file_offer", id: randomUUID(), transfer_id: transferId,
      name: "valid.csv", size: 4, sha256: createHash("sha256").update("abcd").digest("hex"),
      chunk_bytes: FILE_TRANSFER_CHUNK_BYTES, total_chunks: 1,
    };
    expect(validateEnvelope({ ...base, name: "../secret.csv" }).valid).toBe(false);
    expect((await receiver.receive({ ...base, name: "../secret.csv" })).ok).toBe(false);
    expect((await receiver.receive(base)).ok).toBe(true);
    const malformed: FileChunkEnvelope = {
      v: 1, kind: "file_chunk", id: randomUUID(), transfer_id: transferId,
      index: 1, offset: FILE_TRANSFER_CHUNK_BYTES, data_base64: Buffer.from("abcd").toString("base64"),
    };
    expect((await receiver.receive(malformed)).ok).toBe(false);
    expect((await receiver.receive({ ...malformed, index: 0, offset: 0, data_base64: "invalid***" })).ok).toBe(false);
    expect((await receiver.receive({ ...malformed, index: 0, offset: 0 })).ok).toBe(true);
    expect((await receiver.receive({ ...malformed, index: 0, offset: 0 })).ok).toBe(true);
  });

  it("prevents oversized sources, directory escape and symlinks", async () => {
    const root = await temp();
    const large = path.join(root, "large.csv");
    await fs.writeFile(large, Buffer.alloc(FILE_TRANSFER_MAX_BYTES + 1));
    await expect(resolveTransferSource(large, root)).rejects.toThrow("8 MiB");
    const child = path.join(root, "safe.csv");
    await fs.writeFile(child, "safe");
    expect(await resolveTransferSource("safe.csv", root)).toBe(child);
    const outside = await temp();
    const externalFile = path.join(outside, "private.csv");
    await fs.writeFile(externalFile, "private");
    await expect(resolveTransferSource(externalFile, root)).rejects.toThrow("outside");
    const linked = path.join(root, "link.csv");
    try {
      await fs.symlink(externalFile, linked);
      await expect(resolveTransferSource(linked, root)).rejects.toThrow("non-symlink");
    } catch (error: any) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    }
  });

  it("aborts an in-flight upload without retrying after watcher stop", async () => {
    const root = await temp();
    const source = path.join(root, "file.csv");
    await fs.writeFile(source, "1,2");
    let notify!: () => void;
    const firstSend = new Promise<void>((resolve) => { notify = resolve; });
    let sends = 0;
    const sender = new FileTransferSender(async () => {
      sends++;
      notify();
      return true;
    }, 100, 3);
    const operation = sender.sendFile(source);
    await firstSend;
    sender.abort();
    await expect(operation).rejects.toThrow("aborted");
    expect(sends).toBe(1);
  });

  it("rejects an ACK from a different transfer and fails closed without ACK", async () => {
    const root = await temp();
    const source = path.join(root, "file.csv");
    await fs.writeFile(source, "1,2");
    const sender = new FileTransferSender(async (_frame: FileTransferEnvelope) => true, 5, 1);
    expect(sender.handleAck({
      v: 1, kind: "file_ack", id: randomUUID(), transfer_id: randomUUID(),
      phase: "offer", ok: true,
    })).toBe(false);
    await expect(sender.sendFile(source)).rejects.toThrow("Timed out");
  });
});
