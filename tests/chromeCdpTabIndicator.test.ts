import { describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import {
  CDP_TAB_PREFIX,
  buildCdpTabIndicatorJs,
  showManagedCdpTabIndicator,
  hideManagedCdpTabIndicator,
  forgetManagedCdpTabIndicators,
} from "../src/core/tools/chromeCdpTabIndicator.js";

function page() {
  let title = "Tryout Online";
  let observer: (() => void) | null = null;
  let observing = false;
  let timeout: (() => void) | null = null;
  const doc = {
    head: {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as any;
  Object.defineProperty(doc, "title", {
    get: () => title,
    set(value: string) {
      title = value;
      if (observing && observer) queueMicrotask(observer);
    },
  });
  const win: any = {};
  win.top = win;
  const context = {
    window: win, document: doc, Date, Number, Math, JSON,
    MutationObserver: class {
      constructor(handler: () => void) { observer = handler; }
      observe() { observing = true; }
      disconnect() { observing = false; }
    },
    queueMicrotask,
    setTimeout: (fn: () => void) => { timeout = fn; return 1; },
    clearTimeout: () => { timeout = null; },
  };
  return {
    evaluate: (source: string) => vm.runInNewContext(source, context),
    get title() { return title; },
    changeTitle(value: string) { doc.title = value; },
    async tick() {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    expire() { timeout?.(); },
  };
}

describe("managed CDP visible tab indicator", () => {
  it("marks only the targeted browser title, preserves SPA updates and restores final title", async () => {
    const tab = page();
    const expiry = Date.now() + 180_000;
    expect(tab.evaluate(buildCdpTabIndicatorJs("show", expiry))).toBe(true);
    expect(tab.title).toBe(CDP_TAB_PREFIX + "Tryout Online");
    tab.changeTitle("Tryout Online · Dashboard");
    await tab.tick();
    expect(tab.title).toBe(CDP_TAB_PREFIX + "Tryout Online · Dashboard");
    expect(tab.evaluate(buildCdpTabIndicatorJs("show", expiry))).toBe(true);
    expect(tab.title).toBe(CDP_TAB_PREFIX + "Tryout Online · Dashboard");
    expect(tab.evaluate(buildCdpTabIndicatorJs("hide"))).toBe(true);
    expect(tab.title).toBe("Tryout Online · Dashboard");
    tab.changeTitle("Standalone page");
    await tab.tick();
    expect(tab.title).toBe("Standalone page");
  });

  it("restores the title when the remote owner lease expires unexpectedly", () => {
    const tab = page();
    tab.evaluate(buildCdpTabIndicatorJs("show", Date.now() + 3_000));
    expect(tab.title).toContain(CDP_TAB_PREFIX);
    tab.expire();
    expect(tab.title).toBe("Tryout Online");
    expect(tab.evaluate(buildCdpTabIndicatorJs("show", Date.now() - 1))).toBe(false);
  });

  it("registers across page navigation, replaces the old script and removes it on release", async () => {
    forgetManagedCdpTabIndicators();
    const calls: Array<{ method: string; params?: any }> = [];
    let counter = 0;
    const send = async (_target: any, method: string, params?: any) => {
      calls.push({ method, params });
      if (method === "Page.addScriptToEvaluateOnNewDocument")
        return { identifier: "tab-script-" + (++counter) };
      return {};
    };
    const target = { id: "T-tab-indicator", webSocketDebuggerUrl: "ws://127.0.0.1/test" };
    const expiry = Date.now() + 90_000;
    expect(await showManagedCdpTabIndicator(send, target, expiry)).toBe(true);
    expect(await showManagedCdpTabIndicator(send, target, expiry)).toBe(true);
    await hideManagedCdpTabIndicator(send, target);
    expect(calls.map(c => c.method)).toEqual([
      "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate",
      "Page.removeScriptToEvaluateOnNewDocument",
      "Page.addScriptToEvaluateOnNewDocument", "Runtime.evaluate",
      "Page.removeScriptToEvaluateOnNewDocument", "Runtime.evaluate",
    ]);
    expect(calls.filter(c => c.method === "Page.removeScriptToEvaluateOnNewDocument")
      .map(c => c.params.identifier)).toEqual(["tab-script-1", "tab-script-2"]);
    expect(calls[calls.length - 1].params.expression).toContain("'hide'");
    forgetManagedCdpTabIndicators();
  });

  it("does not multiply scripts when registration removal fails", async () => {
    forgetManagedCdpTabIndicators();
    const calls: string[] = [];
    const target = { id: "T-unavailable" };
    const send = async (_target: any, method: string) => {
      calls.push(method);
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "owned" };
      if (method === "Page.removeScriptToEvaluateOnNewDocument") throw Error("Browser disconnected");
      return {};
    };
    expect(await showManagedCdpTabIndicator(send, target, Date.now() + 60_000)).toBe(true);
    expect(await showManagedCdpTabIndicator(send, target, Date.now() + 60_000)).toBe(false);
    expect(calls.filter(method => method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);
    forgetManagedCdpTabIndicators();
  });

  it("mounts and removes the floating status pill in a DOM environment", () => {
    let title = "My Facebook Page";
    const elements = new Map<string, any>();
    const bodyChildren: any[] = [];
    const body = {
      appendChild: (child: any) => {
        bodyChildren.push(child);
        if (child.id) elements.set(child.id, child);
      },
    };
    const doc = {
      head: {},
      body,
      title,
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tag: string) => {
        let shadowContent = "";
        const el: any = {
          tagName: tag.toUpperCase(),
          id: "",
          style: {},
          parentNode: body,
          attachShadow: () => ({
            set innerHTML(val: string) { shadowContent = val; },
            get innerHTML() { return shadowContent; },
            querySelector: (sel: string) => {
              if (sel === ".sa-close-btn") return { addEventListener: vi.fn() };
              return null;
            },
          }),
        };
        return el;
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(doc, "title", {
      get: () => title,
      set: (val: string) => { title = val; },
    });
    const win: any = {};
    win.top = win;
    const context = {
      window: win, document: doc, Date, Number, Math, JSON,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      queueMicrotask,
      setTimeout: () => 1,
      clearTimeout: () => {},
    };

    const expiry = Date.now() + 60_000;
    const showCode = buildCdpTabIndicatorJs("show", expiry);
    const result = vm.runInNewContext(showCode, context);
    expect(result).toBe(true);
    expect(doc.title).toContain(CDP_TAB_PREFIX);
    expect(doc.getElementById("__superagent_cdp_floating_pill_host__")).toBeDefined();

    // Hiding should remove the pill host from DOM
    const hideCode = buildCdpTabIndicatorJs("hide");
    vm.runInNewContext(hideCode, context);
    expect(doc.title).toBe("My Facebook Page");
  });
});
