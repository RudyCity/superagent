import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

class FakeElement {
  value = ""; hidden = false; disabled = false; textContent = ""; src = "";
  dataset: Record<string,string> = {};
  callbacks = new Map<string, Array<() => void>>();
  addEventListener(name: string, fn: () => void) {
    this.callbacks.set(name, [...(this.callbacks.get(name) || []), fn]);
  }
  click() { this.callbacks.get("click")?.forEach(fn => fn()); }
  replaceChildren() {}
  append() {}
  removeAttribute() {}
}

describe("Tray private operator UX remains fail closed", () => {
  it("displays NOT CONFIGURED, uses native review and revokes without leaking preview credentials", async () => {
    const source = readFileSync(path.resolve("apps/superagent-tray/ui/desktop-live.js"), "utf8");
    const html = readFileSync(path.resolve("apps/superagent-tray/ui/index.html"), "utf8");
    for (const id of ["desktop-live-remote-state", "desktop-live-remote-detail",
      "desktop-live-remote-review", "desktop-live-takeover"]) {
      expect(html).toContain(`id="${id}"`);
    }
    const ids = ["page-desktop-live", "desktop-live-refresh", "desktop-live-start",
      "desktop-live-stop", "desktop-live-target", "desktop-live-quality", "desktop-live-image",
      "desktop-live-placeholder", "desktop-live-status", "desktop-live-remote-state",
      "desktop-live-remote-detail", "desktop-live-remote-review", "desktop-live-takeover"];
    const elements = new Map(ids.map(id => [id, new FakeElement()]));
    const events = new Map<string, () => void>();
    const calls: { action: string; payload: unknown }[] = [];
    const document = {
      hidden: false, readyState: "complete",
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
      addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    };
    const window = {
      addEventListener: (name: string, fn: () => void) => events.set(name, fn),
      __TAURI__: { core: { invoke: async (_name: string, { action, payload }:
        { action: string; payload: unknown }) => {
        calls.push({ action, payload });
        if (action === "remote-status") return {
          success: true, state: "NOT_CONFIGURED", viewAvailable: false,
          inputAvailable: false, approvalAvailable: false, viewerCertificateSha256: null,
        };
        if (action === "remote-review") return { success: true, state: "NOT_CONFIGURED", approved: false };
        if (action === "remote-stop") return { success: true, state: "NOT_CONFIGURED" };
        throw Error(`Unexpected action ${action}`);
      } } },
    };
    vm.runInNewContext(source, { document, window, performance: { now: () => 1000 }, setTimeout });
    const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
    await tick();
    expect(elements.get("desktop-live-remote-state")?.textContent).toBe("NOT CONFIGURED");
    elements.get("desktop-live-remote-review")?.click();
    await tick(); await tick();
    expect(calls.some(x => x.action === "remote-review")).toBe(true);
    elements.get("desktop-live-takeover")?.click();
    await tick();
    expect(calls.some(x => x.action === "remote-stop")).toBe(true);
    (document as { hidden: boolean }).hidden = true;
    events.get("visibilitychange")?.();
    await tick();
    events.get("pagehide")?.();
    await tick();
    expect(calls.filter(x => x.action === "remote-stop").length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.payload).toBeNull();
      expect(["remote-status", "remote-review", "remote-stop"]).toContain(call.action);
    }
  });
});
