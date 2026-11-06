import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import { parseTrayLanAction } from "../src/core/runtime/trayLanBridge.js";

const js = fs.readFileSync("apps/superagent-tray/ui/lan-devices.js", "utf8");
const html = fs.readFileSync("apps/superagent-tray/ui/index.html", "utf8");
const rust = fs.readFileSync("apps/superagent-tray/src-tauri/src/main.rs", "utf8");

describe("Network segment LAN discovery authorization boundary", () => {
  it("requires explicit segment in Core, rejects path/secrets/unknown fields", () => {
    expect(parseTrayLanAction({ action: "discover", segment: "Lab-C" })).toMatchObject({
      action: "discover", args: { segment: "Lab-C" },
    });
    for (const bad of [
      { action: "discover" },
      { action: "discover", segment: "" },
      { action: "discover", segment: "AB" },
      { action: "discover", segment: " spaces" },
      { action: "discover", segment: "three " },
      { action: "discover", segment: "../secret" },
      { action: "discover", segment: ".abc" },
      { action: "discover", segment: "x".repeat(33) },
      { action: "discover", segment: "A\nB" },
      { action: "discover", segment: "Lab-C", token: "bogus" },
      { action: "discover", segment: 1234 },
    ]) expect(() => parseTrayLanAction(bad)).toThrow();
    expect(parseTrayLanAction({ action: "list" }).action).toBe("list");
  });
  it("Tray/Tauri expose only segment-filtered discovery, no plaintext password flow", () => {
    expect(js).toContain('invoke("discover", targetIp ? { segment, targetIp } : { segment })');
    expect(js).toContain("state.segmentRevision++");
    expect(js).toContain("scanRevision !== state.segmentRevision");
    expect(js).not.toContain("localStorage");
    expect(rust).toContain('"discover" => &["segment", "targetIp"]');
    expect(rust).toContain('data["segment"].as_str()');
    expect(html).toContain('id="lan-segment-name"');
    expect(html).toContain('id="lan-direct-ip"');
  });

  it("does not accept network scan without segment or repaint earlier results after segment change", async () => {
    type El = any;
    const elements = new Map<string, El>();
    const create = () => {
      const el: El = {
        value: "", checked: false, disabled: false, hidden: false, textContent: "",
        children: [] as any[], listeners: new Map<string, Function>(),
        classList: { toggle() {} }, className: "", type: "", focus() {}, setAttribute() {},
        append(...parts: any[]) { this.children.push(...parts); },
        replaceChildren(...parts: any[]) { this.children = parts; },
        addEventListener(event: string, cb: Function) { this.listeners.set(event, cb); },
      };
      return el;
    };
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, create());
      return elements.get(id);
    };
    get("page-lan-devices").hidden = true;
    const requests: Array<{ action: string; payload: any }> = [];
    let unblock: null | ((v: any) => void) = null;
    const pending = new Promise((resolve) => { unblock = resolve; });
    const window = { __TAURI__: { core: { invoke: async (_: unknown, data: any) => {
      requests.push(data);
      if (data.action === "discover") return pending;
      if (data.action === "list") return { success: true, devices: [] };
      throw Error("Unexpected action");
    } } } };
    vm.runInNewContext(js, {
      window, document: { readyState: "complete", getElementById: get, createElement: create },
      Number, String, Array, Boolean, Error, Object,
    });
    const click = (id: string) => get(id).listeners.get("click")?.();
    click("lan-discovery-scan");
    expect(requests.filter((r) => r.action === "discover")).toHaveLength(0);
    get("lan-segment-name").value = "Alpha Team";
    get("lan-segment-name").listeners.get("input")?.();
    click("lan-discovery-scan");
    expect(requests.filter((r) => r.action === "discover").map((r) => r.payload))
      .toEqual([{ segment: "Alpha Team" }]);
    get("lan-segment-name").value = "Beta Team";
    get("lan-segment-name").listeners.get("input")?.();
    unblock!({ success: true, devices: [{ name: "ALPHA ONLY", address: "192.168.1.4",
      port: 17845, platform: "android" }] });
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(get("lan-discovered").children.some((item: any) =>
      item.children?.some((c: any) => c.textContent === "ALPHA ONLY"))).toBe(false);
  });
});
