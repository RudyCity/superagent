import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { LanFileRelayManager } from "../src/core/lanRemote/fileRelayManager.js";
const src = "11111111-1111-4111-8111-111111111111";
const dst = "22222222-2222-4222-8222-222222222222";
const srcHandle = "33333333-3333-4333-8333-333333333333";
const dstHandle = "44444444-4444-4444-8444-444444444444";
const CHUNK = 16 * 1024;
const digest = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
async function waitFor(predicate: () => boolean) {
  for (let n = 0; n < 600; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("V2 relay did not reach expected terminal status");
}
function harness(options: { resumed?: boolean; networkFail?: boolean; sourcePlatform?: string } = {}) {
  const sourceBytes = crypto.randomBytes(4 * 1024 * 1024 + 63);
  const checksum = digest(sourceBytes);
  const existing = options.resumed ? CHUNK * 2 : 0;
  const targetBytes = Buffer.alloc(sourceBytes.length);
  sourceBytes.copy(targetBytes, 0, 0, existing);
  let readCount = 0, sentCount = 0, writeOffset = existing;
  const aborted: string[] = [];
  const api: any = {
    list() {
      return [{ id: src, connected: true, transport: "lan", platform: options.sourcePlatform || "windows" },
        { id: dst, connected: true, transport: "lan", platform: "android" }];
    },
    async offerV2Source(id: string) {
      expect(id).toBe(src);
      return { ok: true, version: 2, transferId: srcHandle, direction: "download",
        name: "large.bin", size: sourceBytes.length, sha256: checksum,
        chunkBytes: CHUNK, seq: 0, received: 0, resumed: false };
    },
    async offerV2Upload(id: string, meta: any) {
      expect(id).toBe(dst);
      expect(meta).toEqual({ name: "large.bin", size: sourceBytes.length, sha256: checksum });
      return { ok: true, version: 2, transferId: dstHandle, direction: "upload",
        ...meta, chunkBytes: CHUNK, seq: existing / CHUNK, received: existing,
        resumed: existing > 0 };
    },
    async getV2(id: string, handle: string, seq: number) {
      expect(id).toBe(src); expect(handle).toBe(srcHandle);
      readCount++;
      const offset = seq * CHUNK;
      const part = sourceBytes.subarray(offset, offset + CHUNK);
      return { seq, received: offset + part.length, data: part.toString("base64") };
    },
    async putV2(id: string, handle: string, seq: number, data: string) {
      expect(id).toBe(dst); expect(handle).toBe(dstHandle);
      if (options.networkFail) throw Error("LAN connection lost");
      const part = Buffer.from(data, "base64");
      expect(seq * CHUNK).toBe(writeOffset);
      part.copy(targetBytes, writeOffset);
      writeOffset += part.length; sentCount++;
      return { seq: seq + 1, received: writeOffset };
    },
    async statusV2(id: string) {
      return id === src
        ? { transferId: srcHandle, sha256: checksum, name: "large.bin",
          size: sourceBytes.length, seq: readCount, received: readCount * CHUNK }
        : { transferId: dstHandle, sha256: checksum, name: "large.bin",
          size: sourceBytes.length, seq: Math.ceil(writeOffset / CHUNK), received: writeOffset };
    },
    async finishV2Source() { return { ok: true, bytes: sourceBytes.length }; },
    async finishV2Upload() {
      expect(targetBytes).toEqual(sourceBytes);
      return { ok: true, bytes: sourceBytes.length, savedTo: "Downloads/SuperAgent LAN" };
    },
    async abortV2(id: string) { aborted.push(id); },
  };
  const manager = new LanFileRelayManager(api);
  return { manager, aborted, sourceBytes, getReadCount: () => readCount,
    getSentCount: () => sentCount, existing };
}
describe("P1 device-to-device large-file relay V2", () => {
  it("streams >4 MiB Windows to Android with independent owner approvals and bounded chunks", async () => {
    const h = harness();
    const job = h.manager.start(src, dst, "v2");
    await waitFor(() => h.manager.status(job.id).status === "completed");
    expect(h.manager.status(job.id).transferred).toBe(h.sourceBytes.length);
    expect(h.getReadCount()).toBe(Math.ceil(h.sourceBytes.length / CHUNK));
    expect(h.getSentCount()).toBe(h.getReadCount());
    expect(h.aborted).toEqual([]);
  }, 40_000);
  it("verifies the full source while skipping a previously approved destination checkpoint", async () => {
    const h = harness({ resumed: true });
    const job = h.manager.start(src, dst, "v2");
    await waitFor(() => h.manager.status(job.id).status === "completed");
    expect(h.getReadCount()).toBe(Math.ceil(h.sourceBytes.length / CHUNK));
    expect(h.getSentCount()).toBe(h.getReadCount() - h.existing / CHUNK);
  }, 40_000);
  it("retains V2 target partial bytes only when a network error makes result uncertain", async () => {
    const h = harness({ networkFail: true });
    const job = h.manager.start(src, dst, "v2");
    await waitFor(() => h.manager.status(job.id).status === "failed");
    await waitFor(() => h.aborted.includes(src));
    expect(h.aborted).not.toContain(dst);
    expect(h.manager.status(job.id).error).toContain("checkpoint retained");
  });
  it("accepts a freshly approved Android V2 source for Android-to-Android large relay", async () => {
    const h = harness({ sourcePlatform: "android" });
    const job = h.manager.start(src, dst, "v2");
    await waitFor(() => h.manager.status(job.id).status === "completed");
    expect(h.manager.status(job.id).transferred).toBe(h.sourceBytes.length);
    expect(h.aborted).toEqual([]);
  }, 40_000);
});
