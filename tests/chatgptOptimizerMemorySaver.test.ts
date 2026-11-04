import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const root = new URL("../chrome-extension-chatgpt-optimizer/", import.meta.url);
const probeCode = fs.readFileSync(new URL("tab-sleep.js", root), "utf8");
const workerCode = fs.readFileSync(new URL("memory-worker.js", root), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", root), "utf8"));
const CHAT = "https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789001";

function probeHarness(options: {
  hidden?: boolean; editorReady?: boolean; draft?: string; hasTurns?: boolean;
  generating?: boolean; dialog?: boolean; upload?: boolean; recording?: boolean;
  complete?: boolean; path?: string;
} = {}) {
  let listener: Function = () => {};
  const node = {
    isConnected: true,
    value: options.draft || "",
    textContent: options.draft || "",
    getClientRects: () => [1],
    matches: (query: string) => query.includes("stop-button") && !!options.generating,
    getAttribute: (key: string) => key === "aria-label" ?
      options.generating ? "Stop generating" : options.recording ? "End call" : null : null,
  };
  const doc = {
    hidden: options.hidden !== false,
    readyState: options.complete === false ? "loading" : "complete",
    querySelectorAll(query: string) {
      if (query.includes("#prompt-textarea")) return options.editorReady === false ? [] : [node];
      if (query.includes('[data-testid="stop-button"]')) return options.generating ? [node] : [];
      if (query.includes('[role="dialog"]')) return options.dialog ? [node] : [];
      if (query.includes("attachment-preview")) return options.upload ? [node] : [];
      if (query.includes('button[aria-label*="End call"]')) return options.recording ? [node] : [];
      if (query === 'textarea,[contenteditable="true"]') return options.draft ? [node] : [];
      if (query.includes("conversation-turn-")) return options.hasTurns === false ? [] : [node];
      return [];
    },
  };
  const chrome = {
    runtime: { id: "memory-extension", onMessage: { addListener: (cb: Function) => { listener = cb; } } },
  };
  vm.runInNewContext(probeCode, {
    chrome, document: doc,
    location: { pathname: options.path || "/c/12345678-abcd-1234-abcd-123456789001" },
  });
  let response: any;
  const returned = listener(
    { scope: "chatgpt-optimizer-tab-sleep-v1", action: "inspect_sleep" },
    { id: "memory-extension" },
    (value: any) => { response = value; },
  );
  return { response, returned };
}

const baseTab = (id: number, props: Record<string, any> = {}) => ({
  id, url: CHAT, active: false, highlighted: false, pinned: false,
  audible: false, autoDiscardable: true, discarded: false,
  status: "complete", ...props,
});

function workerHarness(options: {
  tabs?: ReturnType<typeof baseTab>[];
  probe?: Record<number, any>;
  raceActive?: number;
  refuse?: number;
} = {}) {
  let listener: Function = () => {};
  let tabs = options.tabs || [
    baseTab(1, { active: true }),
    baseTab(2), baseTab(3),
    baseTab(4, { pinned: true }),
    baseTab(5, { audible: true }),
    baseTab(6, { discarded: true }),
    baseTab(7, { url: "https://chatgpt.com/" }),
  ];
  const discarded: number[] = [];
  const probed: number[] = [];
  const chrome = {
    runtime: {
      id: "memory-extension",
      onMessage: { addListener(cb: Function) { listener = cb; } },
    },
    tabs: {
      async query(_params: any) { return tabs; },
      async sendMessage(id: number, message: any) {
        probed.push(id);
        expect(message).toEqual({
          scope: "chatgpt-optimizer-tab-sleep-v1", action: "inspect_sleep",
        });
        return options.probe?.[id] || { ok: true, safe: true };
      },
      async get(id: number) {
        const tab = tabs.find((tab) => tab.id === id);
        return { ...tab, active: options.raceActive === id };
      },
      async discard(id: number) {
        if (options.refuse === id) return undefined;
        discarded.push(id);
        const tab = tabs.find((tab) => tab.id === id)!;
        tab.discarded = true;
        return { ...tab };
      },
    },
  };
  vm.runInNewContext(workerCode, { chrome, URL, Number, Promise });
  async function call(action: string, senderId = "memory-extension"): Promise<any> {
    return await new Promise((resolve) => listener(
      { scope: "chatgpt-optimizer-memory-v1", action },
      { id: senderId }, resolve,
    ));
  }
  return { call, discarded, probed, tabs };
}

describe("ChatGPT Optimizer: idle-tab guard", () => {
  it("protects active and loading chats, even if a saved URL is present", () => {
    expect(probeHarness({ hidden: false }).response.safe).toBe(false);
    expect(probeHarness({ complete: false }).response.safe).toBe(false);
  });
  it("protects draft, uploads, generation, dialogs, voice, and incomplete DOM", () => {
    for (const option of [
      { draft: "I am typing" }, { upload: true }, { generating: true },
      { dialog: true }, { recording: true }, { editorReady: false }, { hasTurns: false },
      { path: "/" },
    ]) {
      const result = probeHarness(option).response;
      expect(result.safe).toBe(false);
      expect(JSON.stringify(result)).not.toContain("I am typing");
    }
  });
  it("marks loaded, idle, hidden saved-chat tabs as eligible", () => {
    expect(probeHarness().response).toEqual({
      ok: true, safe: true, reason: "Background saved chat is idle.",
    });
  });
});

describe("ChatGPT Optimizer: explicit Chrome memory saver", () => {
  it("never discards an active, pinned, audible, discarded or unsaved tab", async () => {
    const h = workerHarness();
    const summary = await h.call("sleep_others");
    expect(summary.ok).toBe(true);
    expect(summary.sleeping).toBe(2);
    expect(h.probed).toEqual([2, 3]);
    expect(h.discarded).toEqual([2, 3]);
    expect(summary.noMemoryMeasurement).toBe(true);
  });
  it("denies sleeping on content-script veto, tab activation race and Chrome refusal", async () => {
    const h = workerHarness({
      tabs: [baseTab(1), baseTab(2), baseTab(3)],
      probe: { 1: { ok: true, safe: false, reason: "Unsent draft exists." } },
      raceActive: 2, refuse: 3,
    });
    const summary = await h.call("sleep_others");
    expect(summary.sleeping).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(1);
    expect(h.discarded).toEqual([]);
  });
  it("only enumerates in status mode and requires extension-origin messages", async () => {
    const h = workerHarness();
    const status = await h.call("status");
    expect(status.backgroundCount).toBe(2);
    expect(status.sleepingCount).toBe(1);
    expect(h.discarded).toHaveLength(0);
    const wrong = h.call("sleep_others", "wrong-ext");
    // Unknown senders get no response; do not await an unresolved Promise.
    void wrong;
    expect(h.discarded).toHaveLength(0);
  });
  it("requires explicit user action and has no automatic discard timer", () => {
    expect(workerCode).not.toMatch(/onAlarm|onInstalled|setInterval|setTimeout|onStartup/);
    expect(workerCode).toContain('message.action !== "sleep_others"');
    expect(manifest.content_scripts[0].js).toContain("tab-sleep.js");
    expect(manifest.permissions).toEqual(["storage", "tabs", "alarms"]);
  });
});
