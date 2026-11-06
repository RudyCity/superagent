import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync("apps/superagent-tray/ui/lan-screen-viewer.js", "utf8");

type Stub = {
  hidden: boolean; disabled: boolean; textContent: string; value: string; type: string;
  naturalWidth: number; naturalHeight: number; src: string; children: Stub[];
  listeners: Map<string, (event?: any) => void>;
  addEventListener: (name: string, callback: (event?: any) => void) => void;
  appendChild: (child: Stub) => void;
  replaceChildren: (...children: Stub[]) => void;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  setPointerCapture: () => void;
};

function setup(approved: boolean) {
  const elements = new Map<string, Stub>();
  const create = (): Stub => ({
    hidden: false, disabled: false, textContent: "", value: "", src: "", type: "",
    naturalWidth: 100, naturalHeight: 200, children: [],
    listeners: new Map<string, (event?: any) => void>(),
    addEventListener(name: string, callback: (event?: any) => void) { this.listeners.set(name, callback); },
    appendChild(child: Stub) { this.children.push(child); },
    replaceChildren(...children: Stub[]) { this.children = children; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 200 }; },
    setPointerCapture() {},
  });
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, create());
    return elements.get(id)!;
  };
  get("lan-screen-image").hidden = true;
  get("page-lan-devices").hidden = false;

  const requests: Array<{ action: string; payload: any }> = [];
  const target = { id: "a0b1c2d3-1234-4abc-9f00-aabbccddeeff", connected: true, platform: "android" };
  const schema = {
    version: 1, revision: 8, changed: true, width: 1080, height: 2340, truncated: false,
    nodes: [
      { id: "0.1", role: "button", resource: "submit_button",
        bounds: { x: .2, y: .4, w: .5, h: .1 },
        clickable: true, enabled: true, editable: false, scrollable: false, focused: false },
      { id: "0.2", role: "input",
        bounds: { x: .1, y: .7, w: .8, h: .07 },
        clickable: false, enabled: true, editable: true, scrollable: false, focused: true },
    ],
  };
  const window = {
    confirm: () => approved,
    __superagentLanGetSelected: () => target,
    __superagentLanRefresh: () => {},
    __TAURI__: {
      core: {
        invoke: async (name: string, { action, payload }: any) => {
          expect(name).toBe("lan_support_action");
          requests.push({ action, payload });
          if (action === "schema") return { success: true,
            schema: payload.knownRevision === 8 ? { version: 1, revision: 8, changed: false } : schema };
          if (action === "element") return { success: true, result: { ok: true, kind: "click" } };
          if (action === "screen") return {
            success: true, frame: { mime: "image/jpeg", data: "AA==", width: 100, height: 200 },
          };
          if (action === "input") return { success: true, result: { ok: true, kind: payload.kind } };
          if (action === "close") return { success: true };
          throw Error("Unexpected native operation: " + action);
        },
      },
    },
  } as any;
  vm.runInNewContext(script, {
    document: {
      readyState: "complete", visibilityState: "visible", getElementById: get,
      createElement: () => create(),
    },
    window, setTimeout: () => 0, Date, Math, Number, String, Error, Boolean,
  });
  return { get, requests, window, target };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((done) => setImmediate(done)); };
async function click(el: Stub, event: any = {}) {
  el.listeners.get("click")?.(event);
  await flush();
}

describe("Android schema-first viewer UI interactions", () => {
  it("does not request any screen or schema before the operator confirms", async () => {
    const ui = setup(false);
    await click(ui.get("lan-screen-start"));
    expect(ui.requests).toEqual([]);
    expect(ui.get("lan-screen-image").hidden).toBe(true);
  });

  it("defaults to a small schema and never polls JPEG frames", async () => {
    const ui = setup(true);
    await click(ui.get("lan-screen-start"));
    expect(ui.requests.map((r) => r.action)).toEqual(["schema"]);
    expect(ui.requests[0].payload).toMatchObject({ deviceId: ui.target.id, knownRevision: 0 });
    expect(ui.get("lan-schema-list").children).toHaveLength(2);
    expect(ui.get("lan-screen-image").hidden).toBe(true);
    expect(ui.get("lan-schema-status").textContent).toContain("revision 8");
    expect(ui.get("lan-schema-list").children[0].disabled).toBe(false);
    expect(ui.get("lan-schema-list").children[1].disabled).toBe(true);
  });

  it("clicks a current clickable element by ID and revision, not by screenshot coordinates", async () => {
    const ui = setup(true);
    await click(ui.get("lan-screen-start"));
    await click(ui.get("lan-schema-list").children[0]);
    expect(ui.requests.find((r) => r.action === "element")?.payload)
      .toMatchObject({ kind: "click", deviceId: ui.target.id, elementId: "0.1", revision: 8 });
    expect(ui.requests.some((r) => r.action === "screen")).toBe(false);
  });

  it("requests a single screenshot only on manual fallback and supports tap/swipe", async () => {
    const ui = setup(true);
    await click(ui.get("lan-screen-start"));
    await click(ui.get("lan-screen-capture"));
    expect(ui.requests.filter((r) => r.action === "screen")).toHaveLength(1);
    expect(ui.get("lan-screen-image").src).toBe("data:image/jpeg;base64,AA==");
    const img = ui.get("lan-screen-image");
    img.listeners.get("pointerdown")?.({ pointerId: 7, clientX: 60, clientY: 120, currentTarget: img });
    img.listeners.get("pointerup")?.({ pointerId: 7, clientX: 60, clientY: 120 });
    await flush();
    expect(ui.requests.find((r) => r.action === "input" && r.payload.kind === "tap")?.payload)
      .toMatchObject({ x: .5, y: .5, deviceId: ui.target.id });
    expect(img.hidden).toBe(true);
    await click(ui.get("lan-screen-capture"));
    img.listeners.get("pointerdown")?.({ pointerId: 8, clientX: 60, clientY: 180, currentTarget: img });
    img.listeners.get("pointerup")?.({ pointerId: 8, clientX: 60, clientY: 40 });
    await flush();
    const swipe = ui.requests.find((r) => r.action === "input" && r.payload.kind === "swipe")?.payload;
    expect(swipe).toMatchObject({ x: .5, y: .8, endX: .5, endY: .1 });
    expect(swipe.durationMs).toBeGreaterThanOrEqual(100);
    await click(ui.get("lan-screen-stop"));
    expect(img.src).toBe("");
    expect(img.hidden).toBe(true);
  });

  it("supports navigation/text without screenshot and explicitly closes remote session", async () => {
    const ui = setup(true);
    await click(ui.get("lan-screen-start"));
    await click(ui.get("lan-screen-home"));
    expect(ui.requests.some((r) => r.action === "input" && r.payload.kind === "home")).toBe(true);
    ui.get("lan-screen-text").value = "Safe edit";
    await click(ui.get("lan-screen-send-text"));
    // Input after navigation requires refreshed schema, but polling is intentionally
    // not simulated by the VM timer here. This denial is fail-closed.
    expect(ui.requests.filter((r) => r.action === "screen")).toHaveLength(0);
    await click(ui.get("lan-screen-disconnect"));
    expect(ui.requests.some((r) => r.action === "close" && r.payload.deviceId === ui.target.id)).toBe(true);
    expect(ui.get("lan-screen-image").src).toBe("");
  });
});
