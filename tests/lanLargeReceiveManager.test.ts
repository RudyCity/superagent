import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { LanLargeFileReceiveManager } from "../src/core/lanRemote/fileReceiveManager.js";
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const targetId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CHUNK = 16 * 1024;
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Large-file direct receive did not settle");
}
function harness(options: { corrupted?: boolean; failAt?: number; platform?: string } = {}) {
  const bytes = crypto.randomBytes(4 * 1024 * 1024 + 57);
  const hash = digest(bytes);
  let received = 0;
  let failing = options.failAt !== undefined;
  let sourceReads = 0;
  let puts = 0;
  let saved = false;
  let aborted = 0;
  let suspended = 0;
  const stored = Buffer.alloc(bytes.length);
  const disk: any = {
    async offerUpload(name: string, size: number, sha256: string) {
      expect({ name, size, sha256 }).toEqual({
        name: "owner-large.bin", size: bytes.length, sha256: hash,
      });
      return { ok: true, version: 2, transferId: targetId,
        name, size, sha256, chunkBytes: CHUNK, seq: Math.ceil(received / CHUNK),
        received, resumed: received > 0 };
    },
    async put(id: string, seq: number, data: string) {
      expect(id).toBe(targetId);
      expect(seq * CHUNK).toBe(received);
      const part = Buffer.from(data, "base64");
      part.copy(stored, received);
      received += part.length;
      puts++;
      return { ok: true, seq: seq + 1, received };
    },
    async finish(id: string) {
      expect(id).toBe(targetId);
      expect(digest(stored)).toBe(hash);
      saved = true;
      return { ok: true, bytes: bytes.length, savedTo: "Downloads/SuperAgent LAN/Received" };
    },
    async abort() { aborted++; },
    suspend() { suspended++; },
  };
  const api: any = {
    list() { return [{ id: deviceId, connected: true,
      platform: options.platform || "android", transport: "lan" }]; },
    async offer(id: string) {
      expect(id).toBe(deviceId);
      return { transferId: sourceId, name: "owner-large.bin",
        size: bytes.length, sha256: hash, chunkBytes: CHUNK };
    },
    async get(id: string, transferId: string, seq: number) {
      expect(id).toBe(deviceId);
      expect(transferId).toBe(sourceId);
      sourceReads++;
      if (failing && seq === options.failAt) {
        failing = false;
        throw Error("LAN connection lost");
      }
      const offset = seq * CHUNK;
      const part = Buffer.from(bytes.subarray(offset, offset + CHUNK));
      if (options.corrupted && seq === 1) part[0] ^= 0xff;
      return { seq, received: offset + part.length,
        data: part.toString("base64") };
    },
    async status() {
      if (options.failAt !== undefined) throw Error("LAN connection lost");
      return { transferId: sourceId, name: "owner-large.bin",
        size: bytes.length, sha256: hash, seq: sourceReads,
        received: sourceReads * CHUNK };
    },
    async finish() { return { ok: true, bytes: bytes.length }; },
    async abort() {},
  };
  const manager = new LanLargeFileReceiveManager(api, disk);
  return { manager, bytes, gets: () => sourceReads, puts: () => puts,
    stored: () => received, saved: () => saved, aborted: () => aborted,
    suspended: () => suspended };
}
describe("Core-owned direct Android/Windows large file receive", () => {
  it("streams >4MiB of owner-selected remote data into a verified local disk sink", async () => {
    const h = harness();
    const job = h.manager.start(deviceId);
    await until(() => h.manager.status(job.id).status === "completed");
    expect(h.manager.status(job.id)).toMatchObject({
      name: "owner-large.bin", size: h.bytes.length,
      received: h.bytes.length, saved: true,
    });
    expect(h.stored()).toBe(h.bytes.length);
    expect(h.puts()).toBe(Math.ceil(h.bytes.length / CHUNK));
    expect(h.saved()).toBe(true);
  }, 30_000);
  it("keeps the local checkpoint on uncertain network failure for fresh approved retry", async () => {
    const h = harness({ failAt: 3 });
    const first = h.manager.start(deviceId);
    await until(() => h.manager.status(first.id).status === "failed");
    expect(h.suspended()).toBe(1);
    expect(h.aborted()).toBe(0);
    expect(h.stored()).toBe(3 * CHUNK);
    const second = h.manager.start(deviceId);
    await until(() => h.manager.status(second.id).status === "completed");
    expect(h.puts()).toBe(Math.ceil(h.bytes.length / CHUNK));
    expect(h.saved()).toBe(true);
  }, 30_000);
  it("fails on tampered source data without publishing the destination", async () => {
    const h = harness({ corrupted: true });
    const job = h.manager.start(deviceId);
    await until(() => h.manager.status(job.id).status === "failed");
    expect(h.saved()).toBe(false);
    expect(h.aborted()).toBe(1);
    expect(h.manager.status(job.id).error).toContain("SHA-256");
  }, 30_000);
  it("denies disconnected and unauthorized targets", () => {
    const h = harness({ platform: "unknown" });
    expect(() => h.manager.start(deviceId)).toThrow("Connect");
    expect(() => h.manager.start("not-a-device")).toThrow("Invalid");
  });
});
