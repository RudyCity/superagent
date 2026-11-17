import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const deviceId = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const transferId = "e21956a1-daa6-4f62-a4bd-c31a6c3b105e";
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");

function harness(mode: "queue" | "lost-upload" | "lost-download" | "mismatch" = "queue") {
  const fields = new Map<string, any>();
  const el = (id: string): any => {
    if (!fields.has(id)) fields.set(id, {
      value: "", textContent: "", disabled: false, files: [], listeners: new Map<string, Function>(),
      addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); },
    });
    return fields.get(id);
  };
  const fileOffers: string[] = [];
  const saved: Buffer[] = [];
  const actions: Array<{ action: string; seq?: number }> = [];
  const received = Buffer.from("remote-owner-content");
  const completed: string[] = [];
  let active: { name: string; size: number; sha256: string; direction: string } | null = null;
  let uploaded: Buffer[] = [];
  let downloadSequence = 0;
  let lostOnce = false;
  const invoke = async (command: string, args: any) => {
    if (command === "lan_file_save") {
      const bytes = Buffer.from(args.data, "base64");
      if (sha256(bytes) !== args.sha256) throw Error("Unexpected downloaded SHA-256");
      saved.push(bytes);
      return { saved: true };
    }
    if (command !== "lan_support_action") throw Error("Unexpected native command");
    const { action, payload } = args;
    actions.push({ action, seq: payload.seq });
    if (action === "file_offer") {
      active = payload.direction === "upload"
        ? { name: payload.name, size: payload.size, sha256: payload.sha256, direction: "upload" }
        : { name: "owner.txt", size: received.length, sha256: sha256(received), direction: "download" };
      fileOffers.push(active.name);
      uploaded = [];
      downloadSequence = 0;
      return { success: true, file: { transferId, ...active, chunkBytes: 4096 } };
    }
    if (action === "file_put") {
      if (payload.seq !== uploaded.length) throw Error("Unexpected repeated upload");
      uploaded.push(Buffer.from(payload.data, "base64"));
      if (mode === "lost-upload" && !lostOnce) {
        lostOnce = true;
        throw Error("Transport lost acknowledgement after writing");
      }
      return { success: true, result: {
        seq: uploaded.length, received: Buffer.concat(uploaded).length,
      } };
    }
    if (action === "file_get") {
      if (payload.seq === downloadSequence) downloadSequence++;
      else if (payload.seq !== downloadSequence - 1) throw Error("Bad read cursor");
      if (mode === "lost-download" && !lostOnce) {
        lostOnce = true;
        throw Error("Transport lost response after reading");
      }
      const offset = payload.seq * 4096;
      const chunk = received.subarray(offset, offset + 4096);
      return { success: true, result: {
        seq: payload.seq, received: offset + chunk.length, data: chunk.toString("base64"),
      } };
    }
    if (action === "file_status") {
      if (!active) throw Error("Missing transfer");
      const seq = active.direction === "upload" ? uploaded.length : downloadSequence;
      const size = active.direction === "upload" ? Buffer.concat(uploaded).length
        : Math.min(received.length, downloadSequence * 4096);
      return { success: true, result: {
        ok: true, transferId, ...active,
        sha256: mode === "mismatch" ? "0".repeat(64) : active.sha256,
        seq, received: size,
      } };
    }
    if (action === "file_finish") {
      if (!active) throw Error("Missing transfer");
      const total = active.direction === "upload" ? Buffer.concat(uploaded).length : received.length;
      completed.push(active.name);
      return { success: true, result: { ok: true, bytes: total } };
    }
    if (action === "file_abort") return { success: true };
    throw Error("Unsupported action " + action);
  };
  const window = {
    __superagentLanGetSelected: () => ({
      connected: true, id: deviceId, label: "Approved Android", platform: "android",
    }),
    __TAURI__: { core: { invoke } }, confirm: () => true,
  };
  vm.runInNewContext(script, {
    window, document: { readyState: "complete", getElementById: el },
    crypto: crypto.webcrypto, Uint8Array, Array, Number, String, Boolean, Error, Math,
    btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
  });
  const select = (items: Array<{ name: string; data: Buffer }>) => {
    el("lan-file-source").files = items.map(({ name, data }) => ({
      name, size: data.length, arrayBuffer: async () => Uint8Array.from(data).buffer,
    }));
    el("lan-file-source").listeners.get("change")?.();
  };
  const click = (id: string) => el(id).listeners.get("click")?.();
  return { el, select, click, actions, completed, fileOffers, saved, received };
}

async function eventually(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Timed out waiting for LAN transfer UI");
}

describe("LAN transfer queue and uncertain ACK recovery", () => {
  it("queues two owner-approved files sequentially, with two independent verified commits", async () => {
    const h = harness();
    h.select([{ name: "first.txt", data: Buffer.from("FIRST") },
      { name: "second.txt", data: Buffer.from("SECOND") }]);
    h.click("lan-file-send");
    await eventually(() => h.el("lan-file-info").textContent.includes("Sent 2/2"));
    expect(h.fileOffers).toEqual(["first.txt", "second.txt"]);
    expect(h.completed).toEqual(["first.txt", "second.txt"]);
    expect(h.actions.filter((a) => a.action === "file_finish")).toHaveLength(2);
    expect(h.el("lan-file-progress").value).toBe(100);
  });

  it("does not replay mutating upload when a lost response was already accepted", async () => {
    const h = harness("lost-upload");
    h.select([{ name: "report.txt", data: Buffer.from("HELLO") }]);
    h.click("lan-file-send");
    await eventually(() => h.completed.length === 1);
    expect(h.actions.filter((a) => a.action === "file_put")).toHaveLength(1);
    expect(h.actions.filter((a) => a.action === "file_status")).toHaveLength(1);
  });

  it("re-reads a checkpoint-verified prior download chunk after a lost response", async () => {
    const h = harness("lost-download");
    h.click("lan-file-receive");
    await eventually(() => h.saved.length === 1);
    expect(h.saved[0]).toEqual(h.received);
    expect(h.actions.filter((a) => a.action === "file_get").map((a) => a.seq))
      .toEqual([0, 0]);
    expect(h.actions.filter((a) => a.action === "file_status")).toHaveLength(1);
  });
});
