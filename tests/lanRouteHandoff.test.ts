import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
const script = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const moved = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const handle = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const fingerprint = "f".repeat(64);

function harness(newFingerprint = fingerprint) {
  const nodes = new Map<string, any>();
  const el = (id: string): any => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", value: "", files: [],
      disabled: false, listeners: new Map<string, Function>(),
      addEventListener(event: string, fn: Function) { this.listeners.set(event, fn); } });
    return nodes.get(id);
  };
  let current: any = { id: source, platform: "windows", connected: true,
    label: "Same PC LAN", fingerprint, transport: "lan" };
  const next = { id: moved, platform: "windows", connected: true,
    label: "Same PC Tunnel", fingerprint: newFingerprint, transport: "tunnel" };
  const operations: string[] = [];
  const invoke = async (kind: string, args: any) => {
    if (kind !== "lan_support_action") throw Error("Unexpected command");
    const { action, payload } = args;
    operations.push(action + ":" + payload.deviceId);
    if (action === "file_offer") return { success: true, file: {
      transferId: handle, name: "owner.txt", size: 3, sha256: payload.sha256, chunkBytes: 4096,
    } };
    if (action === "file_put") {
      if (payload.deviceId === source) throw Error("LAN connection lost");
      return { success: true, result: { seq: payload.seq + 1, received: 3 } };
    }
    if (action === "file_status") throw Error("LAN disconnected");
    if (action === "file_abort") return { success: true };
    if (action === "file_finish") return { success: true, result: { ok: true, bytes: 3 } };
    throw Error("Unexpected action " + action);
  };
  let approvals = 0;
  const window: any = {
    __TAURI__: { core: { invoke } },
    __superagentLanGetSelected: () => current,
    __superagentLanListTransferTargets: () => [current],
    confirm: () => { approvals++; return true; },
  };
  const context = { window, document: { readyState: "complete", getElementById: el },
    crypto: crypto.webcrypto, Uint8Array, Array, Number, Boolean, String, Date, Math, Error, Set,
    btoa: (v: string) => Buffer.from(v, "binary").toString("base64"),
    atob: (v: string) => Buffer.from(v, "base64").toString("binary"),
  };
  vm.runInNewContext(script, context);
  el("lan-file-source").files = [{
    name: "owner.txt", size: 3, arrayBuffer: async () => Uint8Array.from(Buffer.from("abc")).buffer,
  }];
  el("lan-file-source").listeners.get("change")?.();
  return {
    el, operations, approvals: () => approvals,
    click: (id: string) => el(id).listeners.get("click")?.(),
    switchRoute: () => { current = next; window.__superagentLanFilesRefresh?.(); },
  };
}
async function waitFor(fn: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Expected route handoff state was not reached");
}
describe("Manual LAN-to-Tunnel resume with exact pinned target", () => {
  it("rebinds only a matching TLS certificate after two owner confirmations", async () => {
    const h = harness();
    h.click("lan-file-send");
    await waitFor(() => h.el("lan-file-info").textContent.startsWith("Send failed"));
    h.switchRoute();
    expect(h.el("lan-file-handoff").disabled).toBe(false);
    h.click("lan-file-handoff");
    await waitFor(() => h.operations.includes("file_finish:" + moved));
    expect(h.operations.filter(x => x === "file_offer:" + moved)).toHaveLength(1);
    expect(h.approvals()).toBeGreaterThanOrEqual(3);
  });
  it("never routes a retry to a different pinned device fingerprint", async () => {
    const h = harness("0".repeat(64));
    h.click("lan-file-send");
    await waitFor(() => h.el("lan-file-info").textContent.startsWith("Send failed"));
    h.switchRoute();
    expect(h.el("lan-file-handoff").disabled).toBe(true);
    h.click("lan-file-handoff");
    expect(h.operations.includes("file_offer:" + moved)).toBe(false);
    expect(h.el("lan-file-info").textContent).toContain("fingerprint");
  });
});
