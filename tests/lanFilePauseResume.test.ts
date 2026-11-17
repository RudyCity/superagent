import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const deviceId = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const transferId = "e21956a1-daa6-4f62-a4bd-c31a6c3b105e";
const digest = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");

function harness(mode: "upload" | "download") {
  const elements = new Map<string, any>();
  const get = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      value: "", textContent: "", files: [], disabled: false,
      listeners: new Map<string, Function>(),
      addEventListener(event: string, cb: Function) { this.listeners.set(event, cb); },
    });
    return elements.get(id);
  };
  const requests: Array<{ action: string; seq?: number }> = [];
  const local = Buffer.from("Local transfer ".repeat(650));
  const remote = Buffer.from("Remote owner selected ".repeat(480));
  let sent = 0;
  let received = 0;
  let pausedOnce = false;
  let saved: Buffer | null = null;
  const invoke = async (command: string, input: any) => {
    if (command === "lan_file_save") {
      saved = Buffer.from(input.data, "base64");
      expect(digest(saved)).toBe(input.sha256);
      return { saved: true };
    }
    if (command !== "lan_support_action") throw Error("Unexpected command");
    const { action, payload } = input;
    requests.push({ action, seq: payload.seq });
    if (action === "file_offer") {
      const upload = payload.direction === "upload";
      return { success: true, file: {
        transferId, name: upload ? "local.txt" : "owner.txt",
        size: upload ? local.length : remote.length,
        sha256: upload ? digest(local) : digest(remote),
        chunkBytes: 4096,
      } };
    }
    if (action === "file_put") {
      if (payload.seq * 4096 !== sent) throw Error("Out-of-order upload");
      sent += Buffer.from(payload.data, "base64").length;
      if (!pausedOnce) {
        pausedOnce = true;
        get("lan-file-pause").listeners.get("click")?.();
      }
      return { success: true, result: { seq: payload.seq + 1, received: sent } };
    }
    if (action === "file_get") {
      if (payload.seq * 4096 !== received) throw Error("Out-of-order download");
      const part = remote.subarray(received, received + 4096);
      received += part.length;
      if (!pausedOnce) {
        pausedOnce = true;
        get("lan-file-pause").listeners.get("click")?.();
      }
      return { success: true, result: {
        seq: payload.seq, received, data: part.toString("base64"),
      } };
    }
    if (action === "file_finish") return { success: true, result: {
      ok: true, bytes: mode === "upload" ? local.length : remote.length,
    } };
    if (action === "file_abort") return { success: true };
    throw Error("Unexpected file action " + action);
  };
  const window = { __superagentLanGetSelected: () => ({
    connected: true, id: deviceId, label: "Paired Android", platform: "android",
  }), __TAURI__: { core: { invoke } }, confirm: () => true };
  vm.runInNewContext(script, {
    window, document: { readyState: "complete", getElementById: get },
    crypto: crypto.webcrypto, Uint8Array, Number, Boolean, String, Array, Math, Error,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
  });
  get("lan-file-source").files = [{
    name: "local.txt", size: local.length,
    arrayBuffer: async () => Uint8Array.from(local).buffer,
  }];
  get("lan-file-source").listeners.get("change")?.();
  return {
    get, requests, local, remote, sent: () => sent, received: () => received,
    saved: () => saved, click: (id: string) => get(id).listeners.get("click")?.(),
  };
}

async function eventually(predicate: () => boolean) {
  for (let n = 0; n < 250; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Transfer workflow did not reach expected state");
}

describe("Explicit LAN pause, resume and cancellation", () => {
  it("pauses an active upload at the next chunk boundary, then resumes without another approval", async () => {
    const h = harness("upload");
    h.click("lan-file-send");
    await eventually(() => h.get("lan-file-pause").textContent === "Resume transfer");
    expect(h.sent()).toBe(4096);
    expect(h.requests.some((r) => r.action === "file_finish")).toBe(false);
    expect(h.requests.filter((r) => r.action === "file_offer")).toHaveLength(1);
    h.click("lan-file-pause");
    await eventually(() => h.requests.some((r) => r.action === "file_finish"));
    expect(h.sent()).toBe(h.local.length);
    expect(h.get("lan-file-history").textContent).toContain("local.txt");
    expect(h.get("lan-file-history").textContent).toContain("Verified");
  });
  it("wakes a paused upload on cancellation without continuing the remaining chunks", async () => {
    const h = harness("upload");
    h.click("lan-file-send");
    await eventually(() => h.get("lan-file-pause").textContent === "Resume transfer");
    h.click("lan-file-cancel");
    await eventually(() => h.requests.some((r) => r.action === "file_abort"));
    await eventually(() => h.get("lan-file-pause").disabled === true);
    expect(h.sent()).toBe(4096);
    expect(h.requests.some((r) => r.action === "file_finish")).toBe(false);
  });
  it("pauses a download before the second chunk, then verifies the native save", async () => {
    const h = harness("download");
    h.click("lan-file-receive");
    await eventually(() => h.get("lan-file-pause").textContent === "Resume transfer");
    expect(h.received()).toBe(4096);
    expect(h.saved()).toBeNull();
    h.click("lan-file-pause");
    await eventually(() => h.saved() !== null);
    expect(h.saved()).toEqual(h.remote);
    expect(h.get("lan-file-history").textContent).toContain("Received");
  });
});
