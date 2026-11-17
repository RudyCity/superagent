import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { LanFileRelayManager } from "../src/core/lanRemote/fileRelayManager.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const destinationId = "22222222-2222-4222-8222-222222222222";
const sourceHandle = "33333333-3333-4333-8333-333333333333";
const destinationHandle = "44444444-4444-4444-8444-444444444444";
const digest = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

async function until(predicate: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Relay did not settle");
}

function setup(options: { lostGetAck?: boolean; lostPutAck?: boolean; corrupted?: boolean } = {}) {
  const selected = Buffer.from("owner selected ".repeat(570));
  const sourceHash = digest(selected);
  const destination = Buffer.alloc(selected.length);
  let received = 0;
  let seq = 0;
  let lastGet = -1;
  let lostGet = false;
  let lostPut = false;
  const requests: string[] = [];
  const api: any = {
    list() {
      return [sourceId, destinationId].map(id => ({
        id, connected: true, transport: "lan", platform: "android",
      }));
    },
    async offer(id: string, direction: string, metadata?: any) {
      requests.push("offer:" + id + ":" + direction);
      if (id === sourceId && direction === "download" && !metadata)
        return { transferId: sourceHandle, name: "owner.txt", size: selected.length,
          sha256: sourceHash, chunkBytes: 4096 };
      if (id === destinationId && direction === "upload") {
        expect(metadata).toEqual({ name: "owner.txt", size: selected.length, sha256: sourceHash });
        return { transferId: destinationHandle, name: "owner.txt", size: selected.length,
          sha256: sourceHash, chunkBytes: 4096 };
      }
      throw Error("Wrong endpoint offer");
    },
    async get(id: string, handle: string, n: number) {
      requests.push("get:" + n);
      expect(id).toBe(sourceId);
      expect(handle).toBe(sourceHandle);
      expect(n).toBeLessThan(Math.ceil(selected.length / 4096));
      if (n !== lastGet && n !== lastGet + 1) throw Error("Invalid get order");
      const offset = n * 4096;
      const part = Buffer.from(selected.subarray(offset, offset + 4096));
      if (options.corrupted && n === 1) part[0] ^= 255;
      lastGet = Math.max(lastGet, n);
      if (options.lostGetAck && !lostGet) {
        lostGet = true;
        throw Error("Source reply lost");
      }
      return { data: part.toString("base64"), received: offset + part.length, seq: n };
    },
    async put(id: string, handle: string, n: number, payload: string) {
      requests.push("put:" + n);
      expect(id).toBe(destinationId);
      expect(handle).toBe(destinationHandle);
      expect(n).toBe(seq);
      const bytes = Buffer.from(payload, "base64");
      bytes.copy(destination, received);
      received += bytes.length; seq++;
      if (options.lostPutAck && !lostPut) {
        lostPut = true;
        throw Error("Target reply lost after commit");
      }
      return { seq, received };
    },
    async status(id: string) {
      requests.push("status:" + id);
      if (id === sourceId) return { transferId: sourceHandle, sha256: sourceHash,
        name: "owner.txt", size: selected.length, seq: lastGet + 1,
        received: Math.min(selected.length, (lastGet + 1) * 4096) };
      return { transferId: destinationHandle, sha256: sourceHash,
        name: "owner.txt", size: selected.length, seq, received };
    },
    async finish(id: string) {
      requests.push("finish:" + id);
      if (id === destinationId) {
        if (!destination.equals(selected)) throw Error("Checksum mismatch");
        return { ok: true, bytes: destination.length };
      }
      return { ok: true, bytes: selected.length };
    },
    async abort(id: string) {
      requests.push("abort:" + id);
    },
  };
  return { manager: new LanFileRelayManager(api), requests, selected };
}

describe("Two-owner-approved LAN device relay", () => {
  it("transfers without a Tray file picker, preserving exact owner metadata", async () => {
    const h = setup();
    const job = h.manager.start(sourceId, destinationId);
    await until(() => h.manager.status(job.id).status === "completed");
    const status = h.manager.status(job.id);
    expect(status.transferred).toBe(h.selected.length);
    expect(status.name).toBe("owner.txt");
    expect(h.requests.slice(0, 2)).toEqual([
      "offer:" + sourceId + ":download", "offer:" + destinationId + ":upload",
    ]);
    expect(h.requests.at(-2)).toBe("finish:" + sourceId);
    expect(h.requests.at(-1)).toBe("finish:" + destinationId);
  });

  it("recovers lost source read reply and lost destination write ack using checkpoints", async () => {
    const h = setup({ lostGetAck: true, lostPutAck: true });
    const job = h.manager.start(sourceId, destinationId);
    await until(() => h.manager.status(job.id).status === "completed");
    expect(h.requests).toContain("status:" + sourceId);
    expect(h.requests).toContain("status:" + destinationId);
    expect(h.requests.filter(x => x === "put:0")).toHaveLength(1);
  });

  it("fails closed on a corrupted source chunk and cleans both approved endpoints", async () => {
    const h = setup({ corrupted: true });
    const job = h.manager.start(sourceId, destinationId);
    await until(() => h.manager.status(job.id).status === "failed");
    expect(h.requests).not.toContain("finish:" + destinationId);
    await until(() => h.requests.includes("abort:" + destinationId));
    expect(h.manager.status(job.id).error).toContain("not verified");
  });

  it("denies same-device relay, and cancels while owner approval is pending", async () => {
    const h = setup();
    expect(() => h.manager.start(sourceId, sourceId)).toThrow("two different");
    const job = h.manager.start(sourceId, destinationId);
    h.manager.cancel(job.id);
    await until(() => h.manager.status(job.id).status === "cancelled");
    expect(h.manager.status(job.id).status).toBe("cancelled");
    expect(() => h.manager.start(sourceId, sourceId)).toThrow();
  });
});
