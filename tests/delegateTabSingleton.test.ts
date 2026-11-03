import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(
  new URL("../chrome-extension-delegate/tabSingleton.js", import.meta.url), "utf8",
);
type Tab = {
  id: number; url: string; active: boolean; status: string;
  lastAccessed?: number; pinned?: boolean; incognito?: boolean;
  discarded?: boolean; audible?: boolean;
};
type Inspection = { ready: boolean; safeToClose: boolean; reason: string };
const chat = (id: number, options: Partial<Tab> = {}): Tab => ({
  id, url: "https://chatgpt.com/", active: false, status: "complete",
  lastAccessed: id, ...options,
});
const safe: Inspection = { ready: true, safeToClose: true, reason: "verified_idle" };
const blocked = (reason: string): Inspection => ({ ready: true, safeToClose: false, reason });

function fixture(items: Tab[], checks: Record<number, Inspection> = {}) {
  const tabs = new Map(items.map(tab => [tab.id, { ...tab }]));
  const closed: number[] = [];
  const inspected: number[] = [];
  const handlers: Record<string, (data?: any) => void> = {};
  let active = true;
  let isBusy = false;
  let afterInspect: ((id: number) => void) | undefined;
  const scheduled = new Map<number, () => void>();
  let nextTimer = 0;
  const chrome = {
    tabs: {
      query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      get: async (id: number) => {
        const entry = tabs.get(id);
        if (!entry) throw new Error("Tab not found");
        return { ...entry };
      },
      sendMessage: async (id: number, message: { action: string }) => {
        expect(message.action).toBe("inspect_tab");
        inspected.push(id);
        afterInspect?.(id);
        return checks[id] || safe;
      },
      remove: async (id: number) => {
        if (!tabs.has(id)) throw new Error("Cannot remove missing tab");
        closed.push(id);
        tabs.delete(id);
      },
      onCreated: { addListener: (handler: any) => { handlers.created = handler; } },
      onUpdated: { addListener: (handler: any) => { handlers.updated = handler; } },
      onActivated: { addListener: (handler: any) => { handlers.activated = handler; } },
      onRemoved: { addListener: (handler: any) => { handlers.removed = handler; } },
    },
  };
  const runtime: any = {
    console,
    setTimeout: (callback: () => void) => {
      const id = ++nextTimer;
      scheduled.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => scheduled.delete(id),
    Date,
  };
  vm.runInNewContext(script, runtime, { filename: "tabSingleton.js" });
  const manager = runtime.createDelegateTabSingleton({
    chrome,
    enabled: () => active,
    busy: () => isBusy,
    ensureContent: async () => {},
  });
  manager.register();
  return {
    manager, tabs, closed, inspected, handlers,
    setActive: (v: boolean) => { active = v; },
    setBusy: (v: boolean) => { isBusy = v; },
    onInspect: (fn: (id: number) => void) => { afterInspect = fn; },
    fireScheduled: async () => {
      const pending = [...scheduled.values()];
      scheduled.clear();
      for (const callback of pending) callback();
      // The delayed callback launches an asynchronous cleanup.
      await new Promise<void>(resolve => setTimeout(resolve, 15));
    },
  };
}

describe("Delegate single-safe-tab policy", () => {
  it("keeps the active ChatGPT tab and closes only verified idle duplicates", async () => {
    const f = fixture([
      chat(10, { active: true, lastAccessed: 90 }),
      chat(20, { url: "https://chatgpt.com/c/finished", lastAccessed: 40 }),
      chat(30),
    ]);
    const status = await f.manager.cleanup();
    expect(status.primaryTabId).toBe(10);
    expect([...f.closed].sort()).toEqual([20, 30]);
    expect(status.remainingTabs).toBe(1);
    expect(f.tabs.size).toBe(1);
  });

  it("protects a draft and keeps its tab over an active empty ChatGPT tab", async () => {
    const f = fixture([
      chat(10, { active: true }),
      chat(20, { url: "https://chatgpt.com/c/draft" }),
    ], { 20: blocked("draft_present") });
    const out = await f.manager.cleanup();
    expect(out.primaryTabId).toBe(20);
    expect(f.closed).toEqual([10]);
    expect(f.tabs.has(20)).toBe(true);
  });

  it("never closes multiple protected tabs, even when this leaves more than one", async () => {
    const f = fixture([
      chat(10, { active: true }),
      chat(20, { url: "https://chatgpt.com/c/generating" }),
      chat(30, { url: "https://chatgpt.com/c/draft" }),
    ], { 20: blocked("generating"), 30: blocked("draft_present") });
    const out = await f.manager.cleanup();
    expect(f.closed).toEqual([10]);
    expect(out.remainingTabs).toBe(2);
    expect(out.protectedTabs).toEqual([{ tabId: 30, reason: "draft_present" }]);
  });

  it("does not close any tab while a newly opened ChatGPT page is unverified", async () => {
    const f = fixture([
      chat(1, { url: "https://chatgpt.com/c/important", active: false }),
      chat(2, { status: "loading", active: true }),
    ]);
    const out = await f.manager.cleanup();
    expect(f.closed).toEqual([]);
    expect(out.remainingTabs).toBe(2);
    expect(out.protectedTabs).toEqual([{ tabId: 2, reason: "not_loaded" }]);
  });

  it("keeps pinned tabs and closes only verified idle duplicates", async () => {
    const f = fixture([
      chat(1, { active: true }),
      chat(2, { pinned: true }),
      chat(3),
    ]);
    const out = await f.manager.cleanup();
    expect([...f.closed].sort()).toEqual([1, 3]);
    expect(out.primaryTabId).toBe(2);
    expect(f.tabs.has(2)).toBe(true);
  });

  it("does not close a tab that becomes active during the safety check", async () => {
    const f = fixture([chat(1, { active: true }), chat(2)]);
    f.onInspect(id => {
      if (id === 2) f.tabs.get(2)!.active = true;
    });
    const out = await f.manager.cleanup();
    expect(f.closed).toEqual([]);
    expect(out.protectedTabs).toEqual([
      { tabId: 1, reason: "tab_activation_changed" },
      { tabId: 2, reason: "tab_activation_changed" },
    ]);
  });

  it("does not mix normal and incognito browser contexts", async () => {
    const f = fixture([
      chat(1, { active: true }),
      chat(2),
      chat(3, { incognito: true, active: true }),
      chat(4, { incognito: true }),
    ]);
    const out = await f.manager.cleanup();
    expect([...f.closed].sort()).toEqual([2, 4]);
    expect(out.remainingTabs).toBe(2);
  });

  it("does nothing when disabled or when a delegate RPC is in flight", async () => {
    const f = fixture([chat(1, { active: true }), chat(2)]);
    f.setActive(false);
    await f.manager.cleanup();
    expect(f.closed).toEqual([]);
    f.setActive(true);
    f.setBusy(true);
    await f.manager.cleanup();
    expect(f.closed).toEqual([]);
    f.setBusy(false);
    await f.manager.cleanup();
    expect(f.closed).toEqual([2]);
  });

  it("automatically closes a verified duplicate after onUpdated, not during the event", async () => {
    const f = fixture([chat(1, { active: true }), chat(2)]);
    expect(Object.keys(f.handlers).sort()).toEqual(["activated", "created", "removed", "updated"]);
    f.handlers.updated(2, { status: "complete" }, chat(2));
    expect(f.closed).toHaveLength(0); // Event handler only schedules cleanup.
    await f.fireScheduled();
    expect(f.closed).toEqual([2]);
    expect(f.manager.status().remainingTabs).toBe(1);
  });
});
