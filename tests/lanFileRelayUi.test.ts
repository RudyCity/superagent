import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
const script = fs.readFileSync("apps/superagent-tray/ui/lan-file-relay.js", "utf8");
const source = "11111111-1111-4111-8111-111111111111";
const destination = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

function harness(cancel = false) {
  const fields = new Map<string, any>();
  const el = (id: string): any => {
    if (!fields.has(id)) fields.set(id, {
      value: "", textContent: "", disabled: false, children: [], listeners: new Map<string, Function>(),
      addEventListener(event: string, fn: Function) { this.listeners.set(event, fn); },
      replaceChildren(...items: any[]) { this.children = items; },
    });
    return fields.get(id);
  };
  let active = "transferring";
  let confirmations = 0;
  let refreshes = 0;
  let statusChecks = 0;
  const requests: Array<{ action: string; payload: any }> = [];
  const invoke = async (command: string, args: any) => {
    if (command !== "lan_support_action") throw Error("Wrong native command");
    requests.push(args);
    const { action, payload } = args;
    if (action === "file_relay_start") {
      expect(payload).toEqual({ sourceId: source, destinationId: destination });
      return { success: true, job: { id: jobId } };
    }
    if (action === "file_relay_status") {
      statusChecks++;
      if (!cancel && statusChecks > 1) active = "completed";
      return { success: true, job: { id: jobId, name: "owner.txt",
        size: 4096, transferred: active === "completed" ? 4096 : 2048,
        speedBytesPerSecond: 1024, status: active, error: null } };
    }
    if (action === "file_relay_cancel") {
      active = "cancelled";
      return { success: true, job: { id: jobId } };
    }
    throw Error("Unexpected action " + action);
  };
  const window: any = {
    confirm: () => { confirmations++; return true; },
    __TAURI__: { core: { invoke } },
    __superagentLanGetSelected: () => ({
      id: source, connected: true, platform: "android", label: "Source phone",
    }),
    __superagentLanListTransferTargets: () => [
      { id: source, connected: true, platform: "android", label: "Source phone" },
      { id: destination, connected: true, platform: "windows", label: "Destination PC", transport: "lan" },
    ],
    __superagentLanFilesRefresh: () => { refreshes++; },
  };
  const context = {
    window,
    document: { readyState: "complete", getElementById: el,
      createElement: () => ({ value: "", textContent: "" }) },
    setTimeout: (cb: Function) => setTimeout(() => cb(), 5),
    Promise, Set, Array, Math, Number, String, Error,
  };
  vm.runInNewContext(script, context);
  el("lan-relay-destination").value = destination;
  el("lan-relay-destination").listeners.get("change")?.();
  return {
    el, requests, confirmations: () => confirmations,
    refreshes: () => refreshes, statusChecks: () => statusChecks,
    click: (id: string) => el(id).listeners.get("click")?.(),
  };
}
async function waitFor(fn: () => boolean) {
  for (let n = 0; n < 250; n++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw Error("Relay UI did not reach expected state");
}
describe("Native Tray device relay view", () => {
  it("allows a different approved destination, polls and shows success without exposing file bytes", async () => {
    const h = harness();
    h.click("lan-relay-start");
    await waitFor(() => h.el("lan-relay-status").textContent.includes("completed"));
    expect(h.confirmations()).toBe(1);
    expect(h.requests[0].action).toBe("file_relay_start");
    expect(h.requests.filter(x => x.action === "file_relay_status").length).toBeGreaterThan(1);
    expect(h.el("lan-relay-progress").value).toBe(100);
    expect(h.el("lan-relay-status").textContent).toContain("KiB/s");
    expect(h.refreshes()).toBeGreaterThan(0);
  });
  it("uses a separate cancel action instead of silently closing the target support session", async () => {
    const h = harness(true);
    h.click("lan-relay-start");
    await waitFor(() => h.statusChecks() > 0);
    h.click("lan-relay-cancel");
    await waitFor(() => h.requests.some(x => x.action === "file_relay_cancel"));
    await waitFor(() => h.el("lan-relay-status").textContent.includes("cancelled"));
    expect(h.requests.every(x => x.action.startsWith("file_relay_"))).toBe(true);
  });
});
