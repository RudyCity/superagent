import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const feedbackScript = fs.readFileSync("apps/superagent-tray/ui/feedback.js", "utf8");
const lanScript = fs.readFileSync("apps/superagent-tray/ui/lan-devices.js", "utf8");
const matrix = { size: 21, cells: "1".repeat(441) };
const invite = () => ({
  success: true, invite: {
    inviteId: "11111111-2222-4333-8444-555555555555",
    expiresAt: Date.now() + 600000,
    setup: JSON.stringify({ url: "https://example.test", token: "redacted" }),
    qrMatrix: matrix,
  },
});
const apk = () => ({
  success: true, apk: {
    heartbeatId: "a".repeat(64), expiresAt: Date.now() + 600000,
    size: 6_000_000, sha256: "b".repeat(64),
    filename: "SuperAgent-Android-test.apk", qrMatrix: matrix,
  },
});

function mount() {
  const nodes = new Map<string, any>();
  function node(): any {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el: any = {
      textContent: "", children: [], hidden: false, disabled: false,
      className: "", style: {}, type: "", width: 320, height: 320,
      listeners: new Map<string, (...args: any[]) => unknown>(),
      classList: { add: (v: string) => classes.add(v), remove: (v: string) => classes.delete(v),
        contains: (v: string) => classes.has(v), toggle: (v: string, on: boolean) =>
          on ? classes.add(v) : classes.delete(v) },
      getAttribute: (k: string) => attrs.get(k) ?? null,
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
      addEventListener(k: string, cb: (...args: any[]) => unknown) { el.listeners.set(k, cb); },
      append(...items: any[]) { for (const item of items) { item.parent = el; el.children.push(item); } },
      replaceChildren(...items: any[]) { el.children = []; el.append(...items); },
      remove() { if (el.parent) el.parent.children = el.parent.children.filter((x: any) => x !== el); },
      click() { el.listeners.get("click")?.({ preventDefault() {} }); },
      getContext: () => ({ imageSmoothingEnabled: false, fillRect() {}, clearRect() {} }),
      focus() {},
    };
    return el;
  }
  const get = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  const pending: Record<string, ((value?: any) => unknown) | null> = {
    tunnel_invite: null, apk_download_qr: null,
  };
  const calls: string[] = [];
  let heartbeatTick: (() => void) | null = null;
  let rejectNext: Error | null = null;
  let delayed = false;
  let pendingResolve: ((v: unknown) => void) | null = null;
  let pendingReject: ((v: unknown) => void) | null = null;
  const invoke = async (_name: string, { action }: any) => {
    calls.push(action);
    if (action === "list") return { success: true, devices: [], pairingRequests: [], tunnelDevices: [] };
    if (action === "qr_heartbeat") return { valid: true, state: "active",
      tunnelActive: true, remainingMs: 20000, expiresAt: Date.now() + 20000 };
    if (action === "tunnel_invite" || action === "apk_download_qr") {
      if (delayed) return await new Promise((resolve, reject) => {
        pendingResolve = resolve; pendingReject = reject;
      });
      if (rejectNext) { const error = rejectNext; rejectNext = null; throw error; }
      return action === "tunnel_invite" ? invite() : apk();
    }
    throw Error("Unexpected " + action);
  };
  const window: any = {
    __TAURI__: { core: { invoke } },
    addEventListener() {},
    setInterval: (fn: () => void) => { heartbeatTick = fn; return 1; },
    clearInterval() {},
  };
  const document: any = {
    readyState: "complete", visibilityState: "visible",
    getElementById: get, createElement: node, addEventListener() {},
  };
  get("page-lan-devices").hidden = true;
  get("toast").hidden = true;
  get("lan-tunnel-invite").textContent = "Create connect QR";
  get("lan-apk-download-qr").textContent = "Create APK download QR";
  const context = { document, window, navigator: {}, Date, Math, Number, String,
    Boolean, Error, Object, Array, Map, Set,
    setTimeout: (_fn: unknown, _delay: number) => 1, clearTimeout() {} };
  vm.runInNewContext(feedbackScript, context);
  vm.runInNewContext(lanScript, context);
  return { get, calls, window,
    heartbeat: () => heartbeatTick?.(), defer: () => { delayed = true; },
    resolve: (value: unknown) => { delayed = false; pendingResolve?.(value); },
    reject: (error: Error) => { delayed = false; pendingReject?.(error); },
    failNext: (error: Error) => { rejectNext = error; },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

describe("QR async feedback in native Tray webview", () => {
  it("connect QR visibly loads, blocks duplicate calls, then shows one verified success toast", async () => {
    const ui = mount();
    ui.defer();
    ui.get("lan-tunnel-invite").click();
    await flush();
    expect(ui.calls.filter((x) => x === "tunnel_invite")).toHaveLength(1);
    expect(ui.get("lan-tunnel-invite").disabled).toBe(true);
    expect(ui.get("lan-tunnel-invite").textContent).toContain("Creating");
    expect(ui.get("lan-tunnel-invite").getAttribute("aria-busy")).toBe("true");
    expect(ui.get("lan-tunnel-status").textContent).toContain("75 seconds");
    expect(ui.get("toast").children).toHaveLength(0);
    ui.get("lan-tunnel-invite").click();
    expect(ui.calls.filter((x) => x === "tunnel_invite")).toHaveLength(1);
    ui.resolve(invite());
    await flush();
    expect(ui.get("lan-tunnel-invite").textContent).toBe("Create connect QR");
    expect(ui.get("lan-tunnel-invite").disabled).toBe(false);
    expect(ui.get("lan-tunnel-invite").getAttribute("aria-busy")).toBeNull();
    expect(ui.get("lan-tunnel-qr-card").hidden).toBe(false);
    expect(ui.get("toast").children[0].children[0].textContent).toContain("Connection QR ready");
    expect(ui.get("toast").children).toHaveLength(1);
  });

  it("APK QR shows loading, exposes verified metadata and does not claim downloaded", async () => {
    const ui = mount();
    ui.defer();
    ui.get("lan-apk-download-qr").click();
    await flush();
    expect(ui.get("lan-apk-download-qr").disabled).toBe(true);
    expect(ui.get("lan-apk-download-qr").textContent).toContain("Preparing");
    expect(ui.get("toast").children).toHaveLength(0);
    ui.resolve(apk());
    await flush();
    expect(ui.get("lan-apk-download-qr").textContent).toBe("Create APK download QR");
    expect(ui.get("lan-apk-meta").textContent).toContain("SuperAgent-Android-test.apk");
    expect(ui.get("lan-apk-qr-card").hidden).toBe(false);
    expect(ui.get("toast").children[0].children[0].textContent).toContain("APK download QR ready");
    expect(ui.get("toast").children[0].children[0].textContent).not.toContain("downloaded");
  });

  it("heartbeat performs silent background refresh without fake button interaction", async () => {
    const ui = mount();
    ui.get("lan-tunnel-invite").click();
    await flush();
    expect(ui.calls.filter((x) => x === "tunnel_invite")).toHaveLength(1);
    expect(ui.get("toast").children).toHaveLength(1);
    ui.heartbeat();
    await flush();
    expect(ui.calls.filter((x) => x === "tunnel_invite")).toHaveLength(2);
    expect(ui.get("lan-tunnel-invite").textContent).toBe("Create connect QR");
    expect(ui.get("toast").children).toHaveLength(1);
  });

  it("timeout remains unknown, preserves valid QR, and suppresses unsafe background retry", async () => {
    const ui = mount();
    ui.get("lan-tunnel-invite").click();
    await flush();
    expect(ui.get("lan-tunnel-qr-card").hidden).toBe(false);
    ui.failNext(Error("request timed out after 75s"));
    ui.get("lan-tunnel-invite").click();
    await flush();
    expect(ui.get("lan-tunnel-status").textContent).toContain("unverified");
    expect(ui.get("lan-tunnel-qr-card").hidden).toBe(false);
    expect(ui.get("toast").children.at(-1).getAttribute("role")).toBe("alert");
    expect(ui.get("toast").children.at(-1).children[0].textContent).not.toContain("ready");
    const oldCount = ui.calls.filter((x) => x === "tunnel_invite").length;
    ui.heartbeat();
    await flush();
    expect(ui.calls.filter((x) => x === "tunnel_invite")).toHaveLength(oldCount);
    expect(ui.get("lan-tunnel-invite").disabled).toBe(false);
  });
});
