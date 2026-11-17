import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const shaScript = fs.readFileSync("apps/superagent-tray/ui/lan-sha256.js", "utf8");
const transferScript = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const deviceId = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const transferId = "e21956a1-daa6-4f62-a4bd-c31a6c3b105e";
const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const CHUNK = 16 * 1024;

function harness(options: { lostAck?: boolean; resumeBytes?: number; platform?: string } = {}) {
  const elements = new Map<string, any>();
  const el = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", value: "", files: [], disabled: false,
      listeners: new Map<string, Function>(),
      addEventListener(event: string, cb: Function) { this.listeners.set(event, cb); },
    });
    return elements.get(id);
  };
  const data = crypto.randomBytes(4 * 1024 * 1024 + 11);
  const digest = sha256(data);
  const requests: Array<{ action: string; seq?: number }> = [];
  let offset = options.resumeBytes || 0;
  let lostOnce = false;
  let finished = false;
  let requestedHash = "";
  const invoke = async (command: string, input: any) => {
    if (command !== "lan_support_action") throw Error("Unexpected native command");
    const { action, payload } = input;
    requests.push({ action, seq: payload.seq });
    if (action === "file_v2_offer") {
      requestedHash = payload.sha256;
      if (payload.sha256 !== digest || payload.size !== data.length || payload.name !== "large.bin")
        throw Error("Bad streaming digest or file metadata");
      return { success: true, file: {
        ok: true, version: 2, transferId, direction: "upload",
        name: "large.bin", size: data.length, sha256: digest,
        chunkBytes: CHUNK, seq: offset / CHUNK, received: offset,
        resumed: offset > 0,
      } };
    }
    if (action === "file_v2_put") {
      if (payload.seq * CHUNK !== offset) throw Error("Unexpected V2 replay");
      const bytes = Buffer.from(payload.data, "base64");
      if (!bytes.equals(data.subarray(offset, offset + bytes.length)))
        throw Error("Chunk contents mutated");
      offset += bytes.length;
      if (options.lostAck && !lostOnce) {
        lostOnce = true;
        throw Error("Response lost AFTER authenticated target committed bytes");
      }
      return { success: true, result: { ok: true, seq: payload.seq + 1, received: offset } };
    }
    if (action === "file_v2_status") {
      return { success: true, result: {
        ok: true, version: 2, transferId, direction: "upload",
        name: "large.bin", size: data.length, sha256: digest,
        seq: Math.ceil(offset / CHUNK), received: offset,
      } };
    }
    if (action === "file_v2_finish") {
      if (offset !== data.length) throw Error("Incomplete file");
      finished = true;
      return { success: true, result: { ok: true, bytes: offset, savedTo: "Downloads/SuperAgent LAN" } };
    }
    if (action === "file_v2_abort") return { success: true };
    throw Error("Unexpected V2 action " + action);
  };
  const window: Record<string, any> = {
    __TAURI__: { core: { invoke } }, confirm: () => true,
    __superagentLanGetSelected: () => ({
      connected: true, id: deviceId, label: "Approved Windows",
      platform: options.platform || "windows",
    }),
  };
  const globals = { window, document: { readyState: "complete", getElementById: el },
    crypto: crypto.webcrypto, Uint8Array, Uint32Array, DataView, Array, Number,
    Boolean, String, Math, Date, Error,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  };
  vm.runInNewContext(shaScript, globals);
  vm.runInNewContext(transferScript, globals);
  const file = {
    name: "large.bin", size: data.length,
    arrayBuffer: () => { throw Error("Large file must never be loaded whole"); },
    slice(start: number, end?: number) {
      const bytes = data.subarray(start, Math.min(end ?? data.length, data.length));
      return { arrayBuffer: async () => Uint8Array.from(bytes).buffer };
    },
  };
  el("lan-file-source").files = [file];
  el("lan-file-source").listeners.get("change")?.();
  return { el, requests, digest, requestedHash: () => requestedHash,
    finished: () => finished, offset: () => offset,
    click: (id: string) => el(id).listeners.get("click")?.() };
}

async function eventually(predicate: () => boolean, timeout = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("V2 streaming operation timed out");
}

describe("Desktop LAN V2 user-selected Blob streaming", () => {
  it("streams a >4-MiB file without calling file.arrayBuffer", async () => {
    const h = harness();
    h.click("lan-file-send");
    await eventually(h.finished);
    expect(h.offset()).toBe(4 * 1024 * 1024 + 11);
    expect(h.requestedHash()).toBe(h.digest);
    expect(h.requests.filter(a => a.action === "file_v2_offer")).toHaveLength(1);
    expect(h.requests.some(a => a.action === "file_offer")).toBe(false);
    expect(h.el("lan-file-history").textContent).toContain("V2 verified");
  }, 40_000);

  it("resumes from a target-validated boundary and reconciles one lost ACK", async () => {
    const h = harness({ resumeBytes: CHUNK, lostAck: true });
    h.click("lan-file-send");
    await eventually(h.finished);
    expect(h.requests.filter(a => a.action === "file_v2_put")[0].seq).toBe(1);
    expect(h.requests.filter(a => a.action === "file_v2_status")).toHaveLength(1);
    expect(h.el("lan-file-history").textContent).toContain("V2 resumed & verified");
  }, 40_000);

  it("streams a large upload to an owner-approved Android V2 target", async () => {
    const h = harness({ platform: "android" });
    h.click("lan-file-send");
    await eventually(h.finished);
    expect(h.requests.filter(a => a.action === "file_v2_offer")).toHaveLength(1);
    expect(h.offset()).toBe(4 * 1024 * 1024 + 11);
    expect(h.el("lan-file-history").textContent).toContain("V2 verified");
  }, 40_000);

  it("rejects targets without an allowed V2-capable platform", async () => {
    const h = harness({ platform: "unknown" });
    h.click("lan-file-send");
    expect(h.requests.some(a => a.action === "file_v2_offer")).toBe(false);
    expect(h.el("lan-file-info").textContent).toContain("No valid target sessions");
  });
});
