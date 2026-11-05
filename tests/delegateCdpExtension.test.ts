import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadBridge(options: { attachConflict?: boolean } = {}) {
  const attached = new Set<number>();
  const calls: Array<{ method: string; params: any }> = [];
  const onDetach = { addListener: (_fn: any) => {} };
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
        cb(method === "Page.captureScreenshot" ? { data: "ZmFrZQ==" } : { ok: true });
      },
      onDetach,
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
  };
  const context: any = { chrome, console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(readFileSync("chrome-extension-delegate/cdpPolicy.js", "utf8"), context);
  vm.runInNewContext(readFileSync("chrome-extension-delegate/cdpBridge.js", "utf8"), context);
  const bridge = context.createDelegateCdpBridge({
    chrome, enabled: () => true, clientId: () => "chrome-work-001",
  });
  return { bridge, attached, calls };
}

describe("Delegate-CDP extension bridge", () => {
  it("keeps manifest content scripts narrow and adds explicit debugger permission", () => {
    const manifest = JSON.parse(readFileSync("chrome-extension-delegate/manifest.json", "utf8"));
    expect(manifest.version).toBe("1.8.0");
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
