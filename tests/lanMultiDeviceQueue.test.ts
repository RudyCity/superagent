import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
const script = fs.readFileSync("apps/superagent-tray/ui/lan-file-transfer.js", "utf8");
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const transferId = "e21956a1-daa6-4f62-a4bd-c31a6c3b105e";
const targets = [{ id: a, connected: true, label: "Approved PC", platform: "windows" },
  { id: b, connected: true, label: "Approved Android", platform: "android" }];

function harness(cancelAfterFirst: boolean | "fail-second" = false) {
  const fields = new Map<string, any>();
  const el = (id: string): any => {
    if (!fields.has(id)) fields.set(id, {
      value: "", checked: false, textContent: "", disabled: false, files: [],
      listeners: new Map<string, Function>(),
      addEventListener(event: string, cb: Function) { this.listeners.set(event, cb); },
    });
    return fields.get(id);
  };
  const offers: string[] = [];
  const finished: string[] = [];
  const confirmations: string[] = [];
  let failedOnce = false;
  let remote: string = "";
  const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");
  const invoke = async (command: string, args: any) => {
    if (command !== "lan_support_action") throw Error("Unexpected command");
    const { action, payload } = args;
    if (action === "file_offer") {
      remote = payload.deviceId;
      offers.push(remote + ":" + payload.name);
      if (cancelAfterFirst === "fail-second" && offers.length === 2 && !failedOnce) {
        failedOnce = true;
        throw Error("Owner declined the second file.");
      }
      return { success: true, file: { transferId, name: payload.name,
        size: payload.size, sha256: payload.sha256, chunkBytes: 4096 } };
    }
    if (action === "file_put") {
      if (payload.deviceId !== remote) throw Error("Chunk routed to the wrong target");
      const bytes = Buffer.from(payload.data, "base64");
      return { success: true, result: { ok: true, seq: payload.seq + 1,
        received: bytes.length } };
    }
    if (action === "file_finish") {
      if (payload.deviceId !== remote) throw Error("Commit sent to a different target");
      finished.push(remote);
      if (cancelAfterFirst === true && finished.length === 1)
        el("lan-file-cancel").listeners.get("click")?.();
      return { success: true, result: { ok: true, bytes: 3 } };
    }
    if (action === "file_abort") return { success: true };
    throw Error("Unexpected action " + action);
  };
  const window: Record<string, any> = {
    __TAURI__: { core: { invoke } }, confirm: (message: string) => {
      confirmations.push(message); return true;
    },
    __superagentLanGetSelected: () => targets[0],
    __superagentLanListTransferTargets: () => targets,
  };
  vm.runInNewContext(script, { window, document: { readyState: "complete", getElementById: el },
    crypto: crypto.webcrypto, Uint8Array, Array, Number, Boolean, String, Date, Math, Error, Set,
    btoa: (v: string) => Buffer.from(v, "binary").toString("base64"),
    atob: (v: string) => Buffer.from(v, "base64").toString("binary"),
  });
  el("lan-file-send-all").checked = true;
  el("lan-file-source").files = ["one.txt", "two.txt"].map(name => ({
    name, size: 3, arrayBuffer: async () => Uint8Array.from(Buffer.from("abc")).buffer,
  }));
  el("lan-file-source").listeners.get("change")?.();
  return { el, offers, finished, confirmations,
    send: () => el("lan-file-send").listeners.get("click")?.(),
    retry: () => el("lan-file-retry").listeners.get("click")?.() };
}
async function until(test: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (test()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Multi-device send did not settle");
}
describe("LAN opt-in multi-device queue", () => {
  it("requires four independent approvals and commits two files to two devices sequentially", async () => {
    const h = harness();
    h.send();
    await until(() => h.finished.length === 4);
    expect(h.offers).toEqual([
      a + ":one.txt", a + ":two.txt", b + ":one.txt", b + ":two.txt",
    ]);
    expect(h.finished).toEqual([a, a, b, b]);
    expect(h.el("lan-file-progress").value).toBe(100);
  });
  it("retains the failed item and unsent devices for a separately confirmed retry", async () => {
    const h = harness("fail-second");
    h.send();
    await until(() => h.el("lan-file-info").textContent.includes("Send failed"));
    expect(h.finished).toEqual([a]);
    expect(h.el("lan-file-retry").disabled).toBe(false);
    h.retry();
    await until(() => h.finished.length === 4);
    expect(h.offers).toEqual([
      a + ":one.txt", a + ":two.txt", a + ":two.txt",
      b + ":one.txt", b + ":two.txt",
    ]);
    expect(h.confirmations.at(-1)).toContain("UNKNOWN outcome");
  });

  it("does not continue to next device after an owner cancel", async () => {
    const h = harness(true);
    h.send();
    await until(() => h.finished.length === 1);
    await until(() => h.el("lan-file-info").textContent.includes("Send failed"));
    // The current in-flight finish may have completed. No other target is sent.
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(h.offers).toEqual([a + ":one.txt"]);
  });
});
