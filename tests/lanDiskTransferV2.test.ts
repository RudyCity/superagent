import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LanDiskTargetV2, LAN_V2_CHUNK_BYTES, LAN_V2_MAX_BYTES } from "../src/core/lanRemote/streamTransferV2.js";

const roots: string[] = [];
async function target() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-v2-test-"));
  roots.push(root);
  return { root, engine: new LanDiskTargetV2(root) };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const hash = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
const feed = async (engine: LanDiskTargetV2, id: string, bytes: Buffer, offset = 0) => {
  for (let p = offset, seq = Math.ceil(offset / LAN_V2_CHUNK_BYTES); p < bytes.length; seq++) {
    const part = bytes.subarray(p, p + LAN_V2_CHUNK_BYTES);
    const ack = await engine.put(id, seq, part.toString("base64"));
    p += part.length;
    expect(ack).toEqual({ ok: true, seq: seq + 1, received: p });
  }
};

describe("LAN target V2 encrypted-session, disk-backed staging", () => {
  it("accepts a file larger than the V1 4-MiB limit without keeping chunks in RAM", async () => {
    const { engine, root } = await target();
    const bytes = crypto.randomBytes(4 * 1024 * 1024 + 7);
    const offer = await engine.offerUpload("archive.bin", bytes.length, hash(bytes));
    expect(offer.chunkBytes).toBe(16 * 1024);
    expect(offer.resumed).toBe(false);
    await feed(engine, offer.transferId, bytes);
    const done = await engine.finish(offer.transferId);
    expect(done.bytes).toBe(bytes.length);
    expect(await fs.readFile(done.savedTo)).toEqual(bytes);
    expect(path.dirname(done.savedTo)).toBe(root);
    expect((await fs.readdir(path.join(root, ".superagent-v2-partials")))).toEqual([]);
  }, 45_000);

  it("restores a checkpoint from disk after process recreation, requiring another explicit offer", async () => {
    const { root, engine } = await target();
    const bytes = crypto.randomBytes(3 * LAN_V2_CHUNK_BYTES + 111);
    const digest = hash(bytes);
    const old = await engine.offerUpload("resume.bin", bytes.length, digest);
    await feed(engine, old.transferId, bytes.subarray(0, 2 * LAN_V2_CHUNK_BYTES));
    const revived = new LanDiskTargetV2(root);
    const offer = await revived.offerUpload("resume.bin", bytes.length, digest);
    expect(offer.resumed).toBe(true);
    expect(offer.transferId).toBe(old.transferId);
    expect(offer.received).toBe(2 * LAN_V2_CHUNK_BYTES);
    expect(offer.seq).toBe(2);
    await feed(revived, offer.transferId, bytes, offer.received);
    const saved = await revived.finish(offer.transferId);
    expect(await fs.readFile(saved.savedTo)).toEqual(bytes);
  });

  it("fails closed on an unexpected sequence, corruption, incomplete commit or unsafe path", async () => {
    const { engine, root } = await target();
    const bytes = crypto.randomBytes(LAN_V2_CHUNK_BYTES + 27);
    const offer = await engine.offerUpload("test.bin", bytes.length, hash(bytes));
    await expect(engine.put(offer.transferId, 1, bytes.subarray(0, 9).toString("base64"))).rejects.toThrow("Out-of-order");
    await expect(engine.put(offer.transferId, 0, bytes.subarray(0, 9).toString("base64"))).rejects.toThrow("full");
    await expect(engine.finish(offer.transferId)).rejects.toThrow("Incomplete");
    await feed(engine, offer.transferId, bytes);
    const staging = path.join(root, ".superagent-v2-partials", offer.transferId + ".part");
    const handle = await fs.open(staging, "r+");
    try { await handle.write(Buffer.from([0]), 0, 1, 0); }
    finally { await handle.close(); }
    await expect(engine.finish(offer.transferId)).rejects.toThrow("SHA-256");
    expect((await fs.readdir(root)).filter(x => x.endsWith(".bin"))).toEqual([]);
    await engine.abort(offer.transferId);
    await expect(engine.offerUpload("../secret", 99, "a".repeat(64))).rejects.toThrow();
    await expect(engine.offerUpload("folder.safolder", 99, "a".repeat(64))).rejects.toThrow();
    await expect(engine.offerUpload("too-big.bin", LAN_V2_MAX_BYTES + 1, "a".repeat(64))).rejects.toThrow();
  });

  it("does not overwrite completed destinations or resume content with a different digest", async () => {
    const { root, engine } = await target();
    const bytes = Buffer.from("owner-approved");
    const old = await engine.offerUpload("one.txt", bytes.length, hash(bytes));
    await feed(engine, old.transferId, bytes);
    const done = await engine.finish(old.transferId);
    expect(await engine.finish(old.transferId)).toEqual(done);
    const newEngine = new LanDiskTargetV2(root);
    const newOffer = await newEngine.offerUpload("one.txt", bytes.length, hash(Buffer.from("different-data!")));
    expect(newOffer.resumed).toBe(false);
    expect(newOffer.transferId).not.toBe(old.transferId);
    await newEngine.abort(newOffer.transferId);
    expect(await fs.readFile(done.savedTo)).toEqual(bytes);
  });

  it("reoffers the same live file only after controller owner approval and retains its cursor", async () => {
    const { engine } = await target();
    const bytes = crypto.randomBytes(3 * LAN_V2_CHUNK_BYTES);
    const digest = hash(bytes);
    const first = await engine.offerUpload("same.bin", bytes.length, digest);
    await engine.put(first.transferId, 0, bytes.subarray(0, LAN_V2_CHUNK_BYTES).toString("base64"));
    const second = await engine.offerUpload("same.bin", bytes.length, digest);
    expect(second.transferId).toBe(first.transferId);
    expect(second.resumed).toBe(true);
    expect(second.received).toBe(LAN_V2_CHUNK_BYTES);
    await expect(engine.offerUpload("different.bin", bytes.length, digest))
      .rejects.toThrow("Another V2 transfer");
    await feed(engine, first.transferId, bytes, second.received);
    const finished = await engine.finish(first.transferId);
    expect(await fs.readFile(finished.savedTo)).toEqual(bytes);
  });

  it("rejects racing duplicate chunks without advancing the same checkpoint twice", async () => {
    const { engine } = await target();
    const bytes = crypto.randomBytes(2 * LAN_V2_CHUNK_BYTES);
    const offer = await engine.offerUpload("racing.bin", bytes.length, hash(bytes));
    const payload = bytes.subarray(0, LAN_V2_CHUNK_BYTES).toString("base64");
    const outcomes = await Promise.allSettled([
      engine.put(offer.transferId, 0, payload),
      engine.put(offer.transferId, 0, payload),
    ]);
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(x => x.status === "rejected")).toHaveLength(1);
    expect(engine.status(offer.transferId).received).toBe(LAN_V2_CHUNK_BYTES);
    await feed(engine, offer.transferId, bytes, LAN_V2_CHUNK_BYTES);
    const done = await engine.finish(offer.transferId);
    expect(await fs.readFile(done.savedTo)).toEqual(bytes);
  });

  it("does not retain cancelled bytes", async () => {
    const { root, engine } = await target();
    const offer = await engine.offerUpload("cancel.txt", LAN_V2_CHUNK_BYTES * 2, "a".repeat(64));
    await engine.put(offer.transferId, 0, Buffer.alloc(LAN_V2_CHUNK_BYTES).toString("base64"));
    expect((await engine.status(offer.transferId)).received).toBe(LAN_V2_CHUNK_BYTES);
    await engine.abort(offer.transferId);
    await expect(engine.finish(offer.transferId)).rejects.toThrow("Unknown");
    expect((await fs.readdir(path.join(root, ".superagent-v2-partials")))).toEqual([]);
  });
});
