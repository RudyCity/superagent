import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
const script = fs.readFileSync("apps/superagent-tray/ui/lan-large-receive.js", "utf8");
const deviceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function harness(cancel = false) {
  const elements = new Map<string, any>();
  const el = (id: string): any => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", disabled: false, value: 0,
      listeners: new Map<string, Function>(),
      addEventListener(event: string, callback: Function) {
        this.listeners.set(event, callback);
      },
    });
    return elements.get(id);
  };
  let checks = 0;
  let state = "transferring";
  const requests: any[] = [];
  const invoke = async (command: string, args: any) => {
    expect(command).toBe("lan_support_action");
    requests.push(args);
    if (args.action === "file_receive_v2_start") {
      expect(args.payload).toEqual({ deviceId });
      return { success: true, job: { id: jobId } };
    }
    if (args.action === "file_receive_v2_status") {
      checks++;
      if (!cancel && checks > 1) state = "completed";
      return { success: true, job: { id: jobId, name: "owner-large.bin",
        status: state, size: 5 * 1024 * 1024,
        received: state === "completed" ? 5 * 1024 * 1024 : 2048,
        speedBytesPerSecond: 1024, saved: state === "completed" } };
    }
    if (args.action === "file_receive_v2_cancel") {
      state = "cancelled";
      return { success: true, job: { id: jobId, status: state } };
    }
    throw Error("Unexpected action");
  };
  let confirmations = 0;
  const window: any = {
    __TAURI__: { core: { invoke } }, __superagentLanRelayBusy: false,
    __superagentLanGetSelected: () => ({
      id: deviceId, connected: true, platform: "android",
    }),
    confirm: () => { confirmations++; return true; },
  };
  vm.runInNewContext(script, {
    window, document: { readyState: "complete", getElementById: el },
    setTimeout: (fn: Function) => setTimeout(() => fn(), 5),
    Promise, Array, Set, String, Number, Math, Error,
  });
  return { window, el, requests, confirmations: () => confirmations,
    click: (id: string) => el(id).listeners.get("click")?.() };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Large receive UI timed out");
}
describe("Native V2 large source receive pane", () => {
  it("starts a native Core job and reports verified 256-MiB-capable disk receive", async () => {
    const h = harness();
    h.click("lan-large-receive-start");
    await waitFor(() => h.el("lan-large-receive-status").textContent.includes("completed"));
    expect(h.confirmations()).toBe(1);
    expect(h.requests[0].action).toBe("file_receive_v2_start");
    expect(h.requests.filter(r => r.action === "file_receive_v2_status").length).toBeGreaterThan(1);
    expect(h.el("lan-large-receive-progress").value).toBe(100);
    expect(h.el("lan-large-receive-status").textContent).toContain("KiB/s");
    await waitFor(() => h.window.__superagentLanLargeReceiveBusy === false);
  });
  it("requests an explicit cancel instead of silently disconnecting the source", async () => {
    const h = harness(true);
    h.click("lan-large-receive-start");
    await waitFor(() => h.requests.some(r => r.action === "file_receive_v2_status"));
    h.click("lan-large-receive-cancel");
    await waitFor(() => h.requests.some(r => r.action === "file_receive_v2_cancel"));
    await waitFor(() => h.el("lan-large-receive-status").textContent.includes("cancelled"));
    expect(h.requests.every(r => r.action.startsWith("file_receive_v2_"))).toBe(true);
  });
});
