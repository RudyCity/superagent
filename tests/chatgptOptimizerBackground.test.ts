import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../chrome-extension-chatgpt-optimizer/background.js", import.meta.url), "utf8");
const ALARM = "chatgpt-optimizer-sidebar-sync-v2";
const KEY = "superagentChatGPTLiteSettings";

function harness() {
  let settings: any = { enabled: true, sidebarSync: true, sidebarInterval: 60 };
  const alarms: { name: string; options: any }[] = [];
  const cleared: string[] = [];
  const sent: { tabId: number; message: any }[] = [];
  let queryCalls = 0;
  let alarmCallback: Function = () => {};
  let storageCallback: Function = () => {};
  const tabs = [
    { id: 11, windowId: 1, active: false },
    { id: 12, windowId: 1, active: true },
    { id: 22, windowId: 2, active: true },
    { id: 23, windowId: 2, active: false },
    { id: 31, windowId: 3, active: false },
  ];
  const chrome = {
    storage: {
      local: { get: async (_key: string) => ({ [KEY]: settings }) },
      onChanged: { addListener: (callback: Function) => { storageCallback = callback; } },
    },
    alarms: {
      create: async (name: string, options: any) => { alarms.push({ name, options }); },
      clear: async (name: string) => { cleared.push(name); },
      onAlarm: { addListener: (callback: Function) => { alarmCallback = callback; } },
    },
    runtime: {
      onInstalled: { addListener: (_cb: Function) => {} },
      onStartup: { addListener: (_cb: Function) => {} },
    },
    tabs: {
      query: async (_query: any) => { queryCalls++; return tabs; },
      sendMessage: async (tabId: number, message: any) => { sent.push({ tabId, message }); },
    },
  };
  vm.runInNewContext(source, { chrome, console });
  const tick = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  function update(next: any) {
    settings = { ...settings, ...next };
    storageCallback({ [KEY]: { newValue: settings } }, "local");
  }
  const trigger = (name = ALARM) => alarmCallback({ name });
  return { tick, alarms, cleared, sent, update, trigger, queries: () => queryCalls };
}

describe("ChatGPT Optimizer MV3 multi-window synchronization", () => {
  it("creates a repeating alarm without fetching or retaining chat content", async () => {
    const h = harness();
    await h.tick();
    expect(h.alarms[0]).toEqual({
      name: ALARM, options: { delayInMinutes: 1, periodInMinutes: 1 },
    });
    expect(source).not.toMatch(/fetch\s*\(|Authorization|accessToken|conversation\.title|\.reload\s*\(/);
  });

  it("wakes a ChatGPT tab in each window, preferring the active tab", async () => {
    const h = harness();
    await h.tick();
    h.trigger();
    await h.tick();
    expect(h.sent.map((entry) => entry.tabId)).toEqual([12, 22, 31]);
    expect(h.sent.every((entry) =>
      entry.message.scope === "chatgpt-optimizer-sidebar-v1" &&
      entry.message.action === "background_refresh",
    )).toBe(true);
  });

  it("ignores unrelated alarms", async () => {
    const h = harness();
    await h.tick();
    h.trigger("other-alarm");
    await h.tick();
    expect(h.queries()).toBe(0);
  });

  it("updates the period when settings change, and disables scheduling", async () => {
    const h = harness();
    await h.tick();
    h.update({ sidebarInterval: 30 });
    await h.tick();
    expect(h.alarms.at(-1)?.options.periodInMinutes).toBe(0.5);
    h.update({ sidebarInterval: 300 });
    await h.tick();
    expect(h.alarms.at(-1)?.options.periodInMinutes).toBe(5);
    const count = h.alarms.length;
    h.update({ sidebarSync: false });
    await h.tick();
    expect(h.cleared.length).toBeGreaterThan(1);
    expect(h.alarms).toHaveLength(count);
  });
});
