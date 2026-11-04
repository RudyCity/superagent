import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const base = new URL("../chrome-extension-chatgpt-optimizer/", import.meta.url);
const probeCode = fs.readFileSync(new URL("tab-reload.js", base), "utf8");
const popupCode = fs.readFileSync(new URL("popup-reload.js", base), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", base), "utf8"));
const CHAT_A = "https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789001";
const CHAT_B = "https://chatgpt.com/c/12345678-abcd-1234-abcd-123456789002";
const ERROR = "Could not load this ChatGPT conversation";

function safetyFixture(options: {
  path?: string;
  readyState?: string;
  draft?: string;
  generating?: boolean;
  attachment?: boolean;
  dialog?: boolean;
  errorText?: string;
  quoted?: boolean;
  errorHidden?: boolean;
  retryLabel?: string;
  retryDisabled?: boolean;
  missingRetry?: boolean;
  onlyLoadedChat?: boolean;
} = {}) {
  let listener: Function = () => {};
  let nativeClicks = 0;
  const isVisible = () => [1];
  const editor = { isConnected: true, value: options.draft || "", getClientRects: isVisible };
  const stop = {
    isConnected: true, getClientRects: isVisible,
    getAttribute: (name: string) => name === "aria-label" ? "Stop generating" : null,
    matches: (selector: string) => selector.includes("stop-button"),
  };
  const retry = {
    isConnected: true,
    getClientRects: isVisible,
    disabled: !!options.retryDisabled,
    innerText: options.retryLabel === undefined ? "Try again" : options.retryLabel,
    getAttribute: (name: string) => name === "aria-disabled" && options.retryDisabled ? "true" : null,
    closest: (_selector: string) => null,
    click: () => { nativeClicks++; },
  };
  const body = {
    matches: (selector: string) => selector.includes("body"),
    parentElement: null,
    querySelectorAll: () => [],
  };
  const card = {
    matches: (_selector: string) => false,
    parentElement: body,
    querySelectorAll: (_selector: string) => options.missingRetry ? [] : [retry],
  };
  const heading = {
    isConnected: true, getClientRects: () => options.errorHidden ? [] : [1],
    textContent: options.errorText || ERROR,
    closest: (_selector: string) => options.quoted ? { tagName: "ARTICLE" } : null,
    parentElement: card,
  };
  const document = {
    readyState: options.readyState || "complete",
    querySelectorAll: (selector: string) => {
      if (selector.includes("#prompt-textarea")) return options.onlyLoadedChat ? [] : [editor];
      if (selector === "button") return options.generating ? [stop] : [];
      if (selector.includes("attachment-preview")) return options.attachment ? [editor] : [];
      if (selector.includes('dialog[open]')) return options.dialog ? [editor] : [];
      if (selector.includes("main h1")) return options.onlyLoadedChat ? [] : [heading];
      return [];
    },
  };
  const chrome = {
    runtime: {
      id: "optimizer-ext",
      onMessage: { addListener(fn: Function) { listener = fn; } },
    },
  };
  const context = {
    chrome, document,
    location: { pathname: options.path ?? "/c/12345678-abcd-1234-abcd-123456789001" },
    Date,
  };
  vm.runInNewContext(probeCode, context);
  function call(action = "inspect_retry", expectedPath?: string, senderId = "optimizer-ext") {
    let response: any;
    const returned = listener({
      scope: "chatgpt-optimizer-target-reload-v1",
      action, expectedPath,
    }, { id: senderId }, (out: any) => { response = out; });
    return { response, returned };
  }
  return { call, clicks: () => nativeClicks };
}

class FakeElement {
  value = "";
  textContent = "";
  disabled = false;
  title = "";
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  events: Record<string, () => void> = {};
  constructor(public tag: string) {}
  appendChild(node: FakeElement) { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeElement[]) { this.children = nodes; this.value = ""; }
  addEventListener(name: string, fn: () => void) { this.events[name] = fn; }
  trigger(name: string) { this.events[name]?.(); }
}

function popupFixture(options: {
  tabs?: { id: number; url: string; title: string; windowId: number }[];
  activeId?: number;
  safety?: any;
  action?: any;
  changedUrl?: string;
  noContent?: boolean;
} = {}) {
  const tabs = options.tabs || [
    { id: 101, url: CHAT_A, title: "Conversation A", windowId: 1 },
    { id: 102, url: CHAT_B, title: "Conversation B", windowId: 2 },
  ];
  const nodes: Record<string, FakeElement> = Object.fromEntries(
    ["reload-chat-select", "reload-chat", "refresh-chat-tabs", "reload-chat-status"]
      .map((id) => [id, new FakeElement(id)]),
  );
  const sent: { tabId: number; message: any }[] = [];
  const reloaded: number[] = [];
  const fetchCounts = new Map<number, number>();
  const chrome = {
    tabs: {
      async query(query: any) {
        return query.url ? tabs : tabs.filter((tab) => tab.id === (options.activeId ?? 101));
      },
      async get(id: number) {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error("Missing tab");
        const count = (fetchCounts.get(id) || 0) + 1;
        fetchCounts.set(id, count);
        return { ...tab, url: count >= 2 && options.changedUrl ? options.changedUrl : tab.url };
      },
      async sendMessage(tabId: number, message: any) {
        sent.push({ tabId, message });
        if (options.noContent) throw new Error("No content script");
        if (message.action === "inspect_retry") return options.safety || {
          ok: true, safe: true, recovery: true, method: "native_try_again",
        };
        if (message.action === "retry_conversation") return options.action || {
          ok: true, triggered: true, method: "native_try_again",
        };
        throw new Error("Unexpected action");
      },
      async reload(id: number) { reloaded.push(id); },
    },
  };
  const document = {
    getElementById: (id: string) => nodes[id],
    createElement: (tag: string) => new FakeElement(tag),
  };
  vm.runInNewContext(popupCode, { chrome, document, URL, Number });
  const tick = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { nodes, sent, reloaded, tick };
}

describe("ChatGPT Optimizer: native retry probe", () => {
  it("finds the native Try again control in the conversation error card", () => {
    const h = safetyFixture();
    expect(h.call().response).toMatchObject({
      ok: true, safe: true, recovery: true, method: "native_try_again",
    });
    expect(h.clicks()).toBe(0);
  });

  it("triggers only the native control, without changing the URL or reloading", () => {
    const h = safetyFixture();
    const result = h.call("retry_conversation", "/c/12345678-abcd-1234-abcd-123456789001");
    expect(result.response).toMatchObject({
      ok: true, triggered: true, method: "native_try_again",
    });
    expect(h.clicks()).toBe(1);
    expect(h.call("inspect_retry").response.safe).toBe(false);
  });

  it("rejects a different chat path before attempting a retry", () => {
    const h = safetyFixture();
    expect(h.call("retry_conversation", "/c/12345678-abcd-1234-abcd-123456789099").response.safe).toBe(false);
    expect(h.clicks()).toBe(0);
  });

  it("does not confuse quoted or hidden error text with the actual error screen", () => {
    for (const options of [{ quoted: true }, { errorHidden: true }, { onlyLoadedChat: true },
      { errorText: "User said: Could not load this ChatGPT conversation" }]) {
      const h = safetyFixture(options);
      expect(h.call("retry_conversation").response.safe).toBe(false);
      expect(h.clicks()).toBe(0);
    }
  });

  it("never retries when a draft, streaming response, attachment or dialog is present", () => {
    for (const options of [
      { draft: "Do not lose this draft" },
      { generating: true },
      { attachment: true },
      { dialog: true },
      { readyState: "loading" },
    ]) {
      const h = safetyFixture(options);
      const result = h.call("retry_conversation").response;
      expect(result.safe).toBe(false);
      expect(JSON.stringify(result)).not.toContain("Do not lose this draft");
      expect(h.clicks()).toBe(0);
    }
  });

  it("reports when ChatGPT's Try again control is absent, renamed or disabled", () => {
    for (const options of [
      { missingRetry: true }, { retryLabel: "Regenerate response" },
      { retryDisabled: true },
    ]) {
      const h = safetyFixture(options);
      expect(h.call("retry_conversation").response.safe).toBe(false);
      expect(h.clicks()).toBe(0);
    }
  });

  it("will not retry an unsaved page or accept external extension commands", () => {
    const notChat = safetyFixture({ path: "/" });
    expect(notChat.call("retry_conversation").response.safe).toBe(false);
    const h = safetyFixture();
    expect(h.call("retry_conversation", undefined, "unknown-extension")).toEqual({
      response: undefined, returned: false,
    });
    expect(h.call("reload_page").response).toEqual({ ok: false, reason: "Unknown action" });
    expect(h.clicks()).toBe(0);
  });

  it("enforces a retry cooldown; no automatic retry loop", () => {
    const h = safetyFixture();
    expect(h.call("retry_conversation").response.triggered).toBe(true);
    expect(h.call("retry_conversation").response.safe).toBe(false);
    expect(h.clicks()).toBe(1);
  });
});

describe("ChatGPT Optimizer: popup's selected-chat in-page recovery", () => {
  it("never calls chrome.tabs.reload or changes active tab URL", () => {
    expect(popupCode).not.toMatch(/chrome\.tabs\.reload|chrome\.tabs\.update|location\.reload|location\.assign|location\.replace/);
    expect(probeCode).not.toMatch(/location\.reload|location\.assign|history\.pushState|history\.replaceState|\.innerHTML\s*=/);
    expect(manifest.permissions).toEqual(["storage", "tabs", "alarms"]);
    expect(manifest.version).toBe("0.4.1");
  });

  it("triggers in-page retry only on the selected tab", async () => {
    const p = popupFixture();
    await p.tick();
    expect(p.nodes["reload-chat-select"].children.length).toBe(3);
    p.nodes["reload-chat-select"].value = "102";
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.sent.map((s) => s.tabId)).toEqual([102, 102]);
    expect(p.sent.map((s) => s.message.action)).toEqual(["inspect_retry", "retry_conversation"]);
    expect(p.sent[0].message.expectedPath).toBe("/c/12345678-abcd-1234-abcd-123456789002");
    expect(p.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("Page was not reloaded");
  });

  it("blocks action if the selected tab navigates after inspection", async () => {
    const p = popupFixture({ changedUrl: CHAT_B });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.sent.map((s) => s.message.action)).toEqual(["inspect_retry"]);
    expect(p.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("changed");
  });

  it("does nothing if no native retry control is available", async () => {
    const p = popupFixture({
      safety: { ok: true, safe: false, reason: "Native Try again control not found" },
    });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.sent).toHaveLength(1);
    expect(p.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("not found");
  });

  it("reports failure without pretending recovery succeeded", async () => {
    const p = popupFixture({
      action: { ok: true, triggered: false, reason: "Try again disappeared" },
    });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.sent).toHaveLength(2);
    expect(p.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("disappeared");
  });

  it("rejects unconnected content scripts without a tab reload", async () => {
    const p = popupFixture({ noContent: true });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("Could not reach the selected ChatGPT tab");
  });

  it("filters out other origins and new/unsaved chat pages", async () => {
    const p = popupFixture({
      tabs: [
        { id: 1, url: "https://wrong.example/c/12345678-abcd-1234-abcd-123456789003", title: "Wrong", windowId: 1 },
        { id: 2, url: "https://chatgpt.com/", title: "New chat", windowId: 1 },
        { id: 3, url: CHAT_B, title: "Chat B", windowId: 2 },
      ],
      activeId: 2,
    });
    await p.tick();
    expect(p.nodes["reload-chat-select"].children.length).toBe(2);
    expect(p.nodes["reload-chat-select"].value).toBe("3");
  });
});
