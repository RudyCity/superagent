import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(
  new URL("../chrome-extension-delegate/tabSingleton.js", import.meta.url), "utf8",
);
type Tab = {
  id: number; url: string; active: boolean;
  lastAccessed?: number; incognito?: boolean; status?: string;
};
const chat = (id: number, options: Partial<Tab> = {}): Tab => ({
  id, url: "https://chatgpt.com/", active: false, status: "complete", ...options,
});

function fixture(items: Tab[]) {
  const tabs = new Map(items.map(tab => [tab.id, { ...tab }]));
  const closed: number[] = [];
  const handlers: Record<string, (...args: any[]) => void> = {};
  const scheduled = new Map<number, () => void>();
  let nextTimer = 0;
  let active = true;
  let queryCount = 0;
  const chrome = {
    tabs: {
      query: async () => {
        queryCount++;
        return [...tabs.values()].map(tab => ({ ...tab }));
      },
      remove: async (id: number) => { closed.push(id); tabs.delete(id); },
      sendMessage: async () => { throw new Error("Multi-tab policy must not inspect content"); },
      onCreated: { addListener: (fn: any) => { handlers.created = fn; } },
      onUpdated: { addListener: (fn: any) => { handlers.updated = fn; } },
      onActivated: { addListener: (fn: any) => { handlers.activated = fn; } },
      onRemoved: { addListener: (fn: any) => { handlers.removed = fn; } },
    },
  };
  const runtime: any = {
    setTimeout: (cb: () => void) => { const id = ++nextTimer; scheduled.set(id, cb); return id; },
    clearTimeout: (id: number) => scheduled.delete(id),
    Date,
  };
  vm.runInNewContext(script, runtime, { filename: "tabSingleton.js" });
  const manager = runtime.createDelegateTabSingleton({
    chrome, enabled: () => active, busy: () => false,
    ensureContent: async () => { throw new Error("No inspections permitted"); },
  });
  manager.register();
  return {
    manager, tabs, closed, handlers,
    setActive: (value: boolean) => { active = value; },
    queries: () => queryCount,
    fireScheduled: async () => {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const cb of callbacks) cb();
      await new Promise<void>(resolve => setTimeout(resolve, 15));
    },
  };
}

describe("Delegate non-destructive multi-tab policy", () => {
  it("preserves all independent conversations and reports exact IDs", async () => {
    const f = fixture([
      chat(10, { active: true }),
      chat(20, { url: "https://chatgpt.com/c/finished" }),
      chat(30, { url: "https://chatgpt.com/c/other" }),
    ]);
    const out = await f.manager.cleanup();
    expect(out.mode).toBe("multi-tab");
    expect(out.activeTabId).toBe(10);
    expect(out.primaryTabId).toBe(10);
    expect(out.tabIds).toEqual([10, 20, 30]);
    expect(out.remainingTabs).toBe(3);
    expect(out.lastClosedTabIds).toEqual([]);
    expect(f.closed).toEqual([]);
    expect(f.tabs.size).toBe(3);
  });

  it("does not close even an idle duplicate URL or a blank homepage", async () => {
    const f = fixture([
      chat(1, { active: true }),
      chat(2),
      chat(3, { url: "https://chatgpt.com/c/same" }),
      chat(4, { url: "https://chatgpt.com/c/same" }),
    ]);
    await f.manager.cleanup();
    expect(f.closed).toEqual([]);
    expect(f.manager.status().remainingTabs).toBe(4);
  });

  it("preserves incognito, pinned, draft and generating tabs without probing", async () => {
    const f = fixture([
      chat(10, { active: true }),
      chat(20, { incognito: true }),
      chat(30, { status: "loading" }),
    ]);
    const out = await f.manager.cleanup();
    expect(out.remainingTabs).toBe(3);
    expect(f.closed).toEqual([]);
  });

  it("updates counts after tab lifecycle events without tab removal", async () => {
    const f = fixture([chat(1, { active: true })]);
    expect(Object.keys(f.handlers).sort()).toEqual(["activated", "created", "removed", "updated"]);
    f.tabs.set(2, chat(2, { url: "https://chatgpt.com/c/new" }));
    f.handlers.created(chat(2));
    await f.fireScheduled();
    expect(f.manager.status().tabIds).toEqual([1, 2]);
    f.tabs.delete(1); // external user close, never initiated by extension
    f.handlers.removed(1);
    await f.fireScheduled();
    expect(f.manager.status().tabIds).toEqual([2]);
    expect(f.closed).toEqual([]);
  });

  it("does not query when extension is disabled", async () => {
    const f = fixture([chat(1), chat(2)]);
    f.setActive(false);
    await f.manager.cleanup();
    expect(f.queries()).toBe(0);
    expect(f.closed).toEqual([]);
    f.setActive(true);
    const out = await f.manager.cleanup();
    expect(out.remainingTabs).toBe(2);
  });

  it("does not include non-ChatGPT tabs in the registry", async () => {
    const f = fixture([
      chat(1, { active: true }),
      { id: 2, url: "https://example.com/", active: false },
    ]);
    const out = await f.manager.cleanup();
    expect(out.tabIds).toEqual([1]);
    expect(out.remainingTabs).toBe(1);
  });
});
