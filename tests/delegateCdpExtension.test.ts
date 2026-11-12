import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadBridge(options: { attachConflict?: boolean; now?: () => number } = {}) {
  const attached = new Set<number>();
  const calls: Array<{ method: string; params: any }> = [];
  const badges: Array<{ tabId: number; text: string }> = [];
  let onDetachHandler: ((source: any) => void) | undefined;
  const onDetach = { addListener: (fn: any) => { onDetachHandler = fn; } };
  let onEventHandler: ((source: any, method: string, params: any) => void) | undefined;
  const chrome: any = {
    runtime: { lastError: undefined },
    debugger: {
      getTargets: (cb: any) => cb([{ tabId: 10, title: "Example", url: "https://example.com/", attached: false }]),
      attach: ({ tabId }: any, _version: string, cb: any) => {
        if (options.attachConflict) {
          chrome.runtime.lastError = { message: "Another debugger is already attached to the tab" };
          cb();
          chrome.runtime.lastError = undefined;
          return;
        }
        attached.add(tabId);
        cb();
      },
      detach: ({ tabId }: any, cb: any) => { attached.delete(tabId); cb(); },
      sendCommand: (_target: any, method: string, params: any, cb: any) => {
        calls.push({ method, params });
        cb(method === "Page.captureScreenshot" ? { data: "ZmFrZQ==" }
          : method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "script-10" }
          : { ok: true });
      },
      onDetach,
      onEvent: { addListener: (fn: any) => { onEventHandler = fn; } },
    },
    tabs: {
      query: (_query: any, cb: any) => cb([
        { id: 10, title: "Example", url: "https://example.com/", active: true, windowId: 1 },
        { id: 11, title: "Settings", url: "chrome://settings/", active: false, windowId: 1 },
      ]),
      get: (tabId: number, cb: any) => cb({ id: tabId, title: "Example", url: "https://example.com/", windowId: 1 }),
      create: (opts: any, cb: any) => cb({ id: 12, title: "", url: opts.url, windowId: 1 }),
      update: (tabId: number, _opts: any, cb: any) => cb({ id: tabId, windowId: 1 }),
      remove: (_tabId: number, cb: any) => cb(),
    },
    windows: { update: (_id: number, _opts: any, cb: any) => cb({}) },
    action: {
      setBadgeText: async (args: { tabId: number; text: string }) => { badges.push(args); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
  };
  const context: any = { chrome, console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(readFileSync("chrome-extension-delegate/cdpPolicy.js", "utf8"), context);
  vm.runInNewContext(readFileSync("chrome-extension-delegate/cdpBridge.js", "utf8"), context);
  const bridge = context.createDelegateCdpBridge({
    chrome, enabled: () => true, clientId: () => "chrome-work-001", now: options.now,
  });
  return { bridge, attached, calls, badges,
    externalDetach: () => onDetachHandler?.({ tabId: 10 }),
    emitEvent: (method: string, params: any) =>
      onEventHandler?.({ tabId: 10 }, method, params) };
}

describe("Delegate-CDP extension bridge", () => {
  it("keeps manifest content scripts narrow and adds explicit debugger permission", () => {
    const manifest = JSON.parse(readFileSync("chrome-extension-delegate/manifest.json", "utf8"));
    // Delegate-CDP features are supported by 1.8+; 1.9 adds later bridge capabilities.
    expect(manifest.version).toMatch(/^1\.(?:[89]|\d{2,})\.\d+$/);
    expect(manifest.permissions).toContain("debugger");
    expect(manifest.content_scripts[0].matches).toEqual(["https://chatgpt.com/*"]);
  });

  it("lists normal tabs, attaches once, allows screenshot, denies cookies, and detaches only owned target", async () => {
    const { bridge, attached, calls } = loadBridge();
    const targets = await bridge.dispatch("delegate.cdp.list_targets");
    expect(targets).toHaveLength(1);
    expect(targets[0].targetId).toBe("delegate:chrome-work-001:10");

    await bridge.dispatch("delegate.cdp.attach", { tabId: 10 });
    expect(attached.has(10)).toBe(true);
    expect(bridge.listAttachments()).toEqual([expect.objectContaining({ tabId: 10 })]);
    expect(await bridge.health()).toMatchObject({ enabled: true, attachments: 1 });
    await bridge.dispatch("delegate.cdp.command", {
      tabId: 10, method: "Page.captureScreenshot", params: {},
    });
    expect(calls.filter(c => c.method === "Page.captureScreenshot")).toHaveLength(1);
    await expect(bridge.dispatch("delegate.cdp.command", {
      tabId: 10, method: "Network.getCookies", params: {},
    })).rejects.toMatchObject({ code: "DELEGATE_CDP_METHOD_DENIED" });
    await bridge.dispatch("delegate.cdp.detach", { tabId: 10 });
    expect(attached.has(10)).toBe(false);
    expect(bridge.listAttachments()).toEqual([]);
    expect(await bridge.health()).toMatchObject({ enabled: true, attachments: 0 });
  });

  it("allows the safe file upload protocol methods, including chooser events", async () => {
    const { bridge, calls, emitEvent } = loadBridge();
    await bridge.dispatch("delegate.cdp.attach", { tabId: 10 });
    await bridge.dispatch("delegate.cdp.command", {
      tabId: 10, method: "DOM.describeNode", params: { nodeId: 19 },
    });
    await bridge.dispatch("delegate.cdp.command", {
      tabId: 10, method: "DOM.setFileInputFiles", params: { nodeId: 19, files: ["C:\temp\fixture.pdf"] },
    });
    await bridge.dispatch("delegate.cdp.command", {
      tabId: 10, method: "Page.setInterceptFileChooserDialog", params: { enabled: true },
    });
    emitEvent("Page.fileChooserOpened", { backendNodeId: 412, mode: "selectSingle", privatePath: "hidden" });
    const events = await bridge.dispatch("delegate.cdp.events", { tabId: 10 });
    expect(events).toContainEqual(expect.objectContaining({
      method: "Page.fileChooserOpened", backendNodeId: 412, mode: "selectSingle",
    }));
    expect(JSON.stringify(events)).not.toContain("privatePath");
    expect(calls.filter(c => ["DOM.describeNode", "DOM.setFileInputFiles", "Page.setInterceptFileChooserDialog"].includes(c.method))
      .map(c => c.method)).toEqual([
      "DOM.describeNode", "DOM.setFileInputFiles", "Page.setInterceptFileChooserDialog",
    ]);
    await bridge.dispatch("delegate.cdp.detach", { tabId: 10 });
  });

  it("marks only the attached tab, survives navigation, and restores title + badge on detach", async () => {
    const { bridge, calls, badges } = loadBridge();
    await bridge.dispatch("delegate.cdp.attach", { tabId: 10 });
    expect(calls.some(c => c.method === "Page.addScriptToEvaluateOnNewDocument"
      && c.params.source.includes("🔴 CDP · "))).toBe(true);
    expect(calls.some(c => c.method === "Runtime.evaluate"
      && c.params.expression.includes("🔴 CDP · "))).toBe(true);
    expect(badges).toContainEqual({ tabId: 10, text: "CDP" });
    await bridge.dispatch("delegate.cdp.command", { tabId: 10,
      method: "Page.navigate", params: { url: "https://example.com/next" } });
    expect(calls.filter(c => c.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1);
    expect(calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2);
    await bridge.dispatch("delegate.cdp.detach", { tabId: 10 });
    expect(badges[badges.length - 1]).toEqual({ tabId: 10, text: "" });
    expect(calls.filter(c => c.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(2);
  });

  it("shows the actual tab title marker, follows SPA title changes and restores title", async () => {
    const { bridge, calls } = loadBridge();
    await bridge.dispatch("delegate.cdp.attach", { tabId: 10 });
    const show = calls.find(c => c.method === "Runtime.evaluate")?.params.expression;
    expect(typeof show).toBe("string");
    let title = "Tryout Online";
    let mutation: (() => void) | undefined;
    let timer: (() => void) | undefined;
    let watching = false;
    const document: any = {
      head: {},
      addEventListener() {}, removeEventListener() {},
    };
    Object.defineProperty(document, "title", {
      get: () => title,
      set: (next: string) => {
        title = next;
        if (watching) queueMicrotask(() => mutation?.());
      },
    });
    const window: any = {};
    window.top = window;
    const pageContext = {
      window, document, Date, JSON, Number, Math,
      MutationObserver: class {
        constructor(callback: () => void) { mutation = callback; }
        observe() { watching = true; }
        disconnect() { watching = false; }
      },
      setTimeout: (fn: () => void) => { timer = fn; return 1; },
      clearTimeout() { timer = undefined; },
      queueMicrotask,
    };
    expect(vm.runInNewContext(show, pageContext)).toBe(true);
    expect(title).toBe("🔴 CDP · Tryout Online");
    document.title = "Student Dashboard";
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(title).toBe("🔴 CDP · Student Dashboard");
    await bridge.dispatch("delegate.cdp.detach", { tabId: 10 });
    const cleanup = calls.filter(c => c.method === "Runtime.evaluate").at(-1)?.params.expression;
    expect(vm.runInNewContext(cleanup, pageContext)).toBe(true);
    expect(title).toBe("Student Dashboard");

    // If Chrome detached unexpectedly, the in-page expiry still restores it.
    expect(vm.runInNewContext(show, pageContext)).toBe(true);
    expect(title).toBe("🔴 CDP · Student Dashboard");
    timer?.();
    expect(title).toBe("Student Dashboard");
  });

  it("keeps a live attached tab marked using existing background heartbeat", async () => {
    let fakeNow = Date.now();
    const { bridge, calls, badges } = loadBridge({ now: () => fakeNow });
    await bridge.dispatch("delegate.cdp.attach", { tabId: 10 });
    expect(calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);

    // No unnecessary refresh for early heartbeats.
    await bridge.refreshIndicators();
    expect(calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);

    fakeNow += 65_000;
    await bridge.refreshIndicators();
    expect(calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2);
    expect(calls.filter(c => c.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1);
    expect(badges[badges.length - 1]).toEqual({ tabId: 10, text: "CDP" });
    await bridge.dispatch("delegate.cdp.detach", { tabId: 10 });
    await bridge.refreshIndicators();
    expect(calls.filter(c => c.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(2);
    expect(readFileSync("chrome-extension-delegate/background.js", "utf8"))
      .toContain("cdpBridge.refreshIndicators?.()");
  });

  it("clears the per-tab extension badge after external debugger detach", async () => {
    const { bridge, badges, externalDetach } = loadBridge();
    await bridge.dispatch("delegate.cdp.attach", { tabId: 10 });
    externalDetach();
    await Promise.resolve();
    expect(bridge.listAttachments()).toHaveLength(0);
    expect(badges[badges.length - 1]).toEqual({ tabId: 10, text: "" });
  });

  it("surfaces attachment telemetry in popup status code", () => {
    const background = readFileSync("chrome-extension-delegate/background.js", "utf8");
    const popup = readFileSync("chrome-extension-delegate/popup.js", "utf8");
    expect(background).toContain("attachmentCount: cdpAttachments.length");
    expect(background).toContain("attachments: cdpAttachments.map");
    expect(popup).toContain("attachmentCount");
    expect(popup).toContain("tab sedang dikontrol");
  });

  it("preserves an existing debugger owner instead of taking over", async () => {
    const { bridge, attached } = loadBridge({ attachConflict: true });
    await expect(bridge.dispatch("delegate.cdp.attach", { tabId: 10 }))
      .rejects.toMatchObject({ code: "DELEGATE_CDP_DEBUGGER_CONFLICT" });
    expect(attached.has(10)).toBe(false);
  });
});
