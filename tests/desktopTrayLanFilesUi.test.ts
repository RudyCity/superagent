import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const id = "a0b1c2d3-1234-4abc-9f00-aabbccddeeff";
const tid = "e21956a1-daa6-4f62-a4bd-c31a6c3b105e";
type NodeStub = {
  value: string; disabled: boolean; files: any[]; max: number; textContent: string; listeners: Map<string, Function>;
  addEventListener: (key: string, cb: Function) => void;
};
function setup(sourceBytes = Buffer.from("Example transfer ".repeat(490))) {
  const all = new Map<string, NodeStub>();
  const get = (id: string) => {
    if (!all.has(id)) {
      const el: NodeStub = { value: "", disabled: false, files: [], textContent: "", max: 100,
        listeners: new Map(), addEventListener(key: string, cb: Function) { this.listeners.set(key, cb); },
      };
      all.set(id, el);
    }
    return all.get(id)!;
  };
  const approvedTarget = { id, label: "Test Android phone", platform: "android", connected: true };
  const requests: Array<{ action: string; payload: any }> = [];
  const saved: Array<{ name: string; bytes: Buffer; sha: string }> = [];
  const upload: Buffer[] = [];
  const inbound = Buffer.from(sourceBytes);
  const sha = crypto.createHash("sha256").update(inbound).digest("hex");
  let badHash = false;
  let accepted = true;
  const invoke = async (name: string, options: any) => {
    if (name === "lan_file_save") {
      const bytes = Buffer.from(options.data, "base64");
      expect(crypto.createHash("sha256").update(bytes).digest("hex")).toBe(options.sha256);
      saved.push({ name: options.name, bytes, sha: options.sha256 });
      return { saved: true, bytes: bytes.length };
    }
    expect(name).toBe("lan_support_action");
    const { action, payload } = options;
    requests.push({ action, payload });
    if (action === "file_offer") {
      if (!accepted) throw Error("Owner denied");
      const direction = payload.direction;
      return {
        success: true, file: {
          transferId: tid, direction, chunkBytes: 4096,
          name: direction === "upload" ? payload.name : "owner.txt",
          size: direction === "upload" ? payload.size : inbound.length,
          sha256: direction === "upload" ? payload.sha256 : (badHash ? "0".repeat(64) : sha),
        },
      };
    }
    if (action === "file_put") {
      upload.push(Buffer.from(payload.data, "base64"));
      const received = Buffer.concat(upload).length;
      return { success: true, result: { ok: true, received, seq: payload.seq + 1 } };
    }
    if (action === "file_get") {
      const offset = payload.seq * 4096;
      const data = inbound.subarray(offset, offset + 4096);
      return { success: true, result: { ok: true, data: data.toString("base64"), seq: payload.seq,
        received: offset + data.length } };
    }
    if (action === "file_finish") return {
      success: true, result: { ok: true, bytes: upload.length ? Buffer.concat(upload).length : inbound.length,
        savedTo: "Downloads/SuperAgent LAN" },
    };
    if (action === "file_abort") return { success: true };
    throw Error("Unexpected action: " + action);
  };
  const window = { __superagentLanGetSelected: () => approvedTarget, __TAURI__: { core: { invoke } },
    confirm: () => true } as any;
  const sandbox = { window, document: { readyState: "complete", getElementById: get },
    crypto: crypto.webcrypto, btoa: (str: string) => Buffer.from(str, "binary").toString("base64"),
    atob: (str: string) => Buffer.from(str, "base64").toString("binary"),
    Uint8Array, Array, Number, String, Error, Boolean, Math,
  };
  vm.runInNewContext(source, sandbox);
  const choose = () => {
    get("lan-file-source").files = [{
      name: "report.txt", size: sourceBytes.length,
      arrayBuffer: async () => Uint8Array.from(sourceBytes).buffer,
    }];
    get("lan-file-source").listeners.get("change")?.();
  };
  return { window, requests, saved, upload, choose, get,
    changeApproval: (value: boolean) => { accepted = value; },
    changeHash: (value: boolean) => { badHash = value; } };
}
async function until(predicate: () => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("Timed out waiting for UI transfer to finish");
}
describe("LAN Devices file send/receive WebView workflow", () => {
  it("never sends bytes without an explicit source file and device selection", async () => {
    const ui = setup();
    expect(ui.get("lan-file-send").disabled).toBe(true);
    ui.choose();
    expect(ui.get("lan-file-send").disabled).toBe(false);
  });
  it("sends a user-selected file in ordered, SHA-256-verified chunks", async () => {
    const ui = setup();
    ui.choose();
    ui.get("lan-file-send").listeners.get("click")?.();
    await until(() => ui.get("lan-file-info").textContent.includes("File sent, SHA-256"));
    expect(ui.requests[0].action).toBe("file_offer");
    expect(ui.requests[0].payload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ui.requests.filter((r) => r.action === "file_put")).toHaveLength(3);
    expect(ui.requests.filter((r) => r.action === "file_finish")).toHaveLength(1);
    expect(Buffer.concat(ui.upload)).toEqual(Buffer.from("Example transfer ".repeat(490)));
  });
  it("receives a preselected owner file, hashes it and asks native Save As", async () => {
    const ui = setup();
    ui.get("lan-file-receive").listeners.get("click")?.();
    await until(() => ui.saved.length > 0 && ui.get("lan-file-info").textContent.includes("saved"));
    expect(ui.saved[0].name).toBe("owner.txt");
    expect(ui.saved[0].bytes).toEqual(Buffer.from("Example transfer ".repeat(490)));
    expect(ui.requests.filter((r) => r.action === "file_get")).toHaveLength(3);
    expect(ui.get("lan-file-info").textContent).toContain("saved");
  });
  it("does not save corrupted downloads and rejects denied transfers", async () => {
    const ui = setup();
    ui.changeHash(true);
    ui.get("lan-file-receive").listeners.get("click")?.();
    await until(() => ui.get("lan-file-info").textContent.includes("Receive failed"));
    expect(ui.saved).toHaveLength(0);
    expect(ui.requests.map((r) => r.action)).toContain("file_abort");
    ui.changeHash(false);
    ui.changeApproval(false);
    ui.choose();
    ui.get("lan-file-send").listeners.get("click")?.();
    await until(() => ui.get("lan-file-info").textContent.includes("Send failed"));
    expect(ui.upload).toHaveLength(0);
  });
});
