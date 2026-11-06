import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync(
  new URL("../chrome-extension-delegate/tabSingleton.js", import.meta.url), "utf8"
) + String.fromCharCode(10) + readFileSync(
  new URL("../chrome-extension-delegate/background.js", import.meta.url), "utf8"
).replace('importScripts("tabSingleton.js");', "");

type Listener = (event?: any) => void;
function fixture(
  tabs: Array<{ id: number; url: string; active?: boolean; status?: string; title?: string }> = [],
  needsInjection = false,
  emptyHistory = false,
) {
  const tabCalls: Array<{tabId: number; action: string}> = [];
  const injections: Array<{tabId: number;files: string[]}> = [];
  const createdTabs: Array<{id: number;url: string;active?: boolean}> = [];
  const updatedTabs: Array<{id:number;url?:string;active?:boolean}> = [];
  const removedTabs: number[] = [];
  let injected = false;
  const sockets: FakeSocket[] = [];
  const badges: Array<{ text?: string; color?: string; title?: string }> = [];
  const timers = new Map<number, () => void>();
  let nextTimerId = 0;
  let onMessage: (request: any, sender: any, reply: (data: any) => void) => boolean;

  class FakeSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    listeners: Record<string, Listener[]> = {};
    sent: any[] = [];
    constructor(public endpoint: string) { sockets.push(this); }
    addEventListener(name: string, handler: Listener) {
      (this.listeners[name] ||= []).push(handler);
    }
    fire(name: string, event: any = {}) {
      for (const handler of this.listeners[name] || []) handler(event);
    }
    open() { this.readyState = FakeSocket.OPEN; this.fire("open"); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    message(data: any) { this.fire("message", { data: JSON.stringify(data) }); }
    close(code = 1006, reason = "") {
      this.readyState = FakeSocket.CLOSED;
      this.fire("close", { code, reason });
    }
  }

  const stored: Record<string, unknown> = {
    delegateEnabled: true,
    delegateClientId: "delegate-test-profile-001",
    delegateProfileLabel: "Chrome Test",
    delegateAuthToken: "",
  };
  const chrome = {
    storage: { local: {
      setAccessLevel: (_options: { accessLevel: string }, callback: () => void) => callback(),
      get: (_keys: string[], callback: (data: Record<string, unknown>) => void) => callback(stored),
      set: async (update: Record<string, unknown>) => { Object.assign(stored, update); },
    } },
    runtime: {
      id: "delegate-test",
      getURL: (path: string) => "chrome-extension://delegate-test/" + path,
      getManifest: () => ({ version: "1.3.0" }),
      onMessage: { addListener: (handler: typeof onMessage) => { onMessage = handler; } },
      onStartup: { addListener: (_handler: Listener) => {} },
      onInstalled: { addListener: (_handler: Listener) => {} },
    },
    action: {
      setBadgeText: async (value: { text: string }) => { badges.push(value); },
      setBadgeBackgroundColor: async (value: { color: string }) => { badges.push(value); },
      setTitle: async (value: { title: string }) => { badges.push(value); },
    },
    alarms: {
      create: () => {},
      onAlarm: { addListener: (_handler: Listener) => {} },
    },
    scripting: {
      executeScript: async (request: {target: {tabId: number}; files: string[]}) => {
        injections.push({tabId: request.target.tabId, files: request.files});
        injected = true;
      },
    },
    tabs: {
      create: async (options: {url: string; active?: boolean}) => {
        const id = Math.max(0, ...tabs.map(tab => tab.id)) + 1;
        const created = { id, url: options.url, active: options.active };
        tabs.push(created);
        createdTabs.push({ ...created });
        return created;
      },
      get: async (id: number) => tabs.find(t => t.id === id),
      query: async () => tabs,
      update: async (id: number, options: {url?: string; active?: boolean}) => {
        const tab = tabs.find(t => t.id === id);
        if (!tab) throw new Error("missing tab");
        if (options.url !== undefined) tab.url = options.url;
        if (options.active !== undefined) tab.active = options.active;
        updatedTabs.push({ id, ...options });
        return tab;
      },
      remove: async (id: number) => {
        const index = tabs.findIndex(t => t.id === id);
        if (index >= 0) tabs.splice(index, 1);
        removedTabs.push(id);
      },
      sendMessage: async (tabId: number, message: { action: string; method?: string; params?: any }) => {
        tabCalls.push({ tabId, action: message.action });
        if (message.action === "probe" && needsInjection && !injected) {
          throw new Error("Receiving end does not exist");
        }
        if (message.action === "probe") return { ready: true };
        if (message.method === "delegate.doctor") return {
          ok: true,
          result: { ready: true, logged_in: true, stop_visible: tabId === 202 },
        };
        if (message.method === "delegate.list_chats") return { ok: true, result: emptyHistory
          ? { chats: [], complete: true, next_cursor: null }
          : {
              chats: [
                { chat_id: "chat-history-001", title: "History One", url: "https://chatgpt.com/c/chat-history-001" },
                { chat_id: "chat-history-002", title: "History Two", url: "https://chatgpt.com/c/chat-history-002" },
              ], complete: true, next_cursor: null,
            } };
        if (message.method === "delegate.read_chat_full") return { ok: true, result: {
          chat_id: "chat-history-001", messages: [{ index: 0, role: "user", text: "hello" }], next_cursor: null,
        } };
        if (message.method === "delegate.search_current_chat") return { ok: true, result: {
          matched: false, title_match: false, snippets: [], loaded_complete: true, total_message_count: 2,
        } };
        return { ok: true, result: { status: "waiting_for_input" } };
      },
    },
  };
  vm.runInNewContext(background, {
    chrome, WebSocket: FakeSocket,
    setTimeout: (callback: () => void, _ms: number) => {
      const id = ++nextTimerId; timers.set(id, callback); return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: () => 1,
    crypto: { randomUUID: () => "delegate-test-profile-002" },
    navigator: { userAgent: "Chrome Test Agent" },
    Date,
  });

  function ask(action: string, senderUrl = chrome.runtime.getURL("popup.html")): any {
    let reply: any;
    onMessage(
      { scope: "superagent-delegate-v1", action },
      { id: chrome.runtime.id, url: senderUrl },
      (result) => { reply = result; }
    );
    return reply;
  }
  async function update(action: string, options: Record<string, unknown>) {
    return await new Promise<any>((resolve) => onMessage(
      { scope: "superagent-delegate-v1", action, ...options },
      { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") },
      resolve,
    ));
  }
  return { ask, update, sockets, badges, timers, stored, tabCalls, injections, createdTabs, updatedTabs, removedTabs };
}

describe("Delegate connection status", () => {
  it("shows connecting until hello_ack, then ON and connected", () => {
    const { ask, sockets, badges } = fixture();
    expect(sockets).toHaveLength(1);
    expect(sockets[0].endpoint).toBe("ws://127.0.0.1:17341");
    expect(ask("get_status").status.state).toBe("connecting");
    expect(badges.some((entry) => entry.text === "...")).toBe(true);

    sockets[0].open();
    expect(sockets[0].sent[0]).toMatchObject({
      type: "hello", protocol: "superagent-delegate-v1",
      clientId: "delegate-test-profile-001",
    });
    expect(ask("get_status").status.connected).toBe(false);
    sockets[0].message({
      type: "hello_ack", protocol: "superagent-delegate-v1",
    });
    expect(ask("get_status").status.connected).toBe(true);
    expect(ask("get_status").status.state).toBe("connected");
    expect(badges.some((entry) => entry.text === "ON")).toBe(true);
    expect(ask("get_status").status.lastConnectedAt).toBeTypeOf("number");
  });

  it("shows reconnecting when socket closes, manual retry never resends chat", () => {
    const { ask, sockets, badges } = fixture();
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].close();
    const status = ask("get_status").status;
    expect(status.connected).toBe(false);
    expect(status.state).toBe("reconnecting");
    expect(status.nextRetryAt).toBeTypeOf("number");
    expect(badges.some((entry) => entry.text === "OFF")).toBe(true);
    expect(badges.some((entry) => entry.title?.includes("mencoba menyambung ulang"))).toBe(true);
    const retry = ask("reconnect");
    expect(retry.started).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent.map((entry) => entry.type)).toEqual(["hello"]);
  });

  it("can turn this Chrome profile OFF and ON without resending chats", async () => {
    const { ask, update, sockets, stored, badges } = fixture();
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    const off = await update("set_enabled", { enabled: false });
    expect(off.ok).toBe(true);
    expect(off.status.state).toBe("disabled");
    expect(stored.delegateEnabled).toBe(false);
    expect(ask("reconnect").started).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(badges.some((value) => value.title?.includes("nonaktif"))).toBe(true);

    const on = await update("set_enabled", { enabled: true });
    expect(on.ok).toBe(true);
    expect(stored.delegateEnabled).toBe(true);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent.map((value) => value.type)).toEqual(["hello"]);
  });

  it("can label each profile without any ChatGPT side effects", async () => {
    const { update, sockets, stored } = fixture();
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    const renamed = await update("set_label", { label: "Chrome Kerja" });
    expect(renamed.ok).toBe(true);
    expect(stored.delegateProfileLabel).toBe("Chrome Kerja");
    expect(sockets[0].sent.map((value) => value.type)).toEqual(["hello", "client_info"]);
  });

  it("does not disconnect a healthy socket or allow page-origin status access", () => {
    const { ask, sockets } = fixture();
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    expect(ask("reconnect").started).toBe(false);
    expect(sockets).toHaveLength(1);
    expect(ask("get_status", "https://chatgpt.com/c/1")).toBeUndefined();
  });

  it("lists two live tabs with read-only status while retaining their identities", async () => {
    const { sockets, tabCalls, removedTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/first", active: true, status: "complete", title: "First task" },
      { id: 202, url: "https://chatgpt.com/c/second", active: false, status: "complete", title: "Second task" },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({ type: "request", id: "list-two-tabs", method: "delegate.list_tabs", params: {} });
    await new Promise(resolve => setTimeout(resolve, 25));
    const result = sockets[0].sent.find(value => value.id === "list-two-tabs");
    expect(result.ok).toBe(true);
    expect(result.result.total).toBe(2);
    expect(result.result.tabs).toEqual([
      expect.objectContaining({ tabId: 101, title: "First task", status: "idle", ready: true }),
      expect.objectContaining({ tabId: 202, title: "Second task", status: "generating", ready: true }),
    ]);
    expect(tabCalls).toEqual([
      { tabId: 101, action: "execute" }, { tabId: 202, action: "execute" },
    ]);
    expect(removedTabs).toEqual([]);
  });

  it("does not dispatch to a random ChatGPT tab when this profile has two", async () => {
    const { sockets, tabCalls } = fixture([
      { id: 101, url: "https://chatgpt.com/", active: true },
      { id: 202, url: "https://chatgpt.com/c/abc", active: false },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({ type: "request", id: "multi-tabs", method: "delegate.create_chat", params: {} });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tabCalls).toEqual([]);
    const result = sockets[0].sent.find(value => value.type === "response");
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CHATGPT_MULTIPLE_TABS");
  });

  it("opens a separate ChatGPT tab with newTab:true while leaving existing chats alone", async () => {
    const { sockets, tabCalls, createdTabs, removedTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/first", active: true },
      { id: 202, url: "https://chatgpt.com/c/second", active: false },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "multi-tab-new", method: "delegate.create_chat",
      params: { newTab: true },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createdTabs).toEqual([{ id: 203, url: "https://chatgpt.com/", active: true }]);
    expect(tabCalls).toEqual([{ tabId: 203, action: "probe" }]);
    expect(removedTabs).toEqual([]);
    expect(sockets[0].sent.find(value => value.id === "multi-tab-new"))
      .toMatchObject({ ok: true, result: { status: "new_chat", tabId: 203 } });
  });

  it("rejects a new tab request combined with an existing tabId", async () => {
    const { sockets, tabCalls, createdTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/first", active: true },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "conflict", method: "delegate.create_chat",
      params: { newTab: true, tabId: 101 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createdTabs).toEqual([]);
    expect(tabCalls).toEqual([]);
    expect(sockets[0].sent.find(value => value.id === "conflict"))
      .toMatchObject({ ok: false, error: { code: "DELEGATE_INVALID_ARGUMENT" } });
  });

  it("automatically opens ChatGPT when no tab exists and continues the requested RPC once", async () => {
    const { sockets, tabCalls, createdTabs } = fixture([]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "auto-open", method: "delegate.send_message",
      params: { message: "hello" },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createdTabs).toEqual([{ id: 1, url: "https://chatgpt.com/", active: true }]);
    expect(tabCalls).toEqual([
      { tabId: 1, action: "probe" },
      { tabId: 1, action: "execute" },
    ]);
    const result = sockets[0].sent.find(value => value.type === "response");
    expect(result.ok).toBe(true);
  });

  it("uses an inactive disposable history worker even when multiple user ChatGPT tabs exist", async () => {
    const { sockets, createdTabs, removedTabs, tabCalls } = fixture([
      { id: 101, url: "https://chatgpt.com/", active: true },
      { id: 202, url: "https://chatgpt.com/c/abc", active: false },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "history-list", method: "delegate.list_chats",
      params: { cursor: 0, limit: 10 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createdTabs).toEqual([{
      id: 203, url: "https://chatgpt.com/#delegate-history-worker", active: false,
    }]);
    expect(tabCalls).toContainEqual({ tabId: 203, action: "probe" });
    expect(tabCalls).toContainEqual({ tabId: 203, action: "execute" });
    expect(removedTabs).toEqual([203]);
    const response = sockets[0].sent.find(value => value.type === "response");
    expect(response.error).toBeUndefined();
    expect(response).toMatchObject({ ok: true });
    expect(response.result.chats).toHaveLength(2);
  });

  it("falls back to currently open ChatGPT conversation tabs when the history sidebar yields zero chats", async () => {
    const { sockets, createdTabs, removedTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/open-chat-0001", title: "Open Chat One", active: true },
      { id: 102, url: "https://chatgpt.com/c/open-chat-0002?foo=1", title: "Open Chat Two", active: false },
      { id: 103, url: "https://chatgpt.com/", title: "New chat", active: false },
      { id: 104, url: "https://example.com/c/not-chatgpt", title: "Foreign", active: false },
    ], false, true);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "history-open-tabs", method: "delegate.list_chats",
      params: { cursor: 0, limit: 10 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    const response = sockets[0].sent.find(value => value.type === "response");
    expect(response).toMatchObject({
      ok: true,
      result: {
        fallback: "open_tabs",
        complete: false,
        chats: [
          { chat_id: "open-chat-0001", title: "Open Chat One", url: "https://chatgpt.com/c/open-chat-0001" },
          { chat_id: "open-chat-0002", title: "Open Chat Two", url: "https://chatgpt.com/c/open-chat-0002" },
        ],
      },
    });
    expect(createdTabs.at(-1)?.url).toBe("https://chatgpt.com/#delegate-history-worker");
    expect(removedTabs).toContain(createdTabs.at(-1)!.id);
  });

  it("reads a historical chat by navigating only the inactive worker tab", async () => {
    const { sockets, createdTabs, updatedTabs, removedTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/user-active", active: true },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "history-full", method: "delegate.read_chat_full",
      params: { chatId: "chat-history-001", cursor: 0, limit: 40 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createdTabs).toEqual([{
      id: 102, url: "https://chatgpt.com/#delegate-history-worker", active: false,
    }]);
    expect(updatedTabs).toEqual([]);
    expect(removedTabs).toEqual([102]);
    const response = sockets[0].sent.find(value => value.type === "response");
    expect(response).toMatchObject({ ok: true, result: { chat_id: "chat-history-001" } });
  });

  it("searches history through one disposable worker and closes it after scanning", async () => {
    const { sockets, createdTabs, updatedTabs, removedTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/user-active", active: true },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "history-search", method: "delegate.search_history",
      params: { query: "needle-not-in-title", limit: 10, maxChats: 2 },
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(createdTabs).toEqual([{
      id: 102, url: "https://chatgpt.com/#delegate-history-worker", active: false,
    }]);
    expect(updatedTabs).toEqual([]);
    expect(removedTabs).toEqual([102]);
    const response = sockets[0].sent.find(value => value.type === "response");
    expect(response).toMatchObject({
      ok: true,
      result: { returned: 0, scanned_chats: 2, skipped_chats: 0, listed_chats: 2 },
    });
  });

  it("routes concurrent messages to two exact tabs without cross-talk", async () => {
    const { sockets, tabCalls, createdTabs } = fixture([
      { id: 101, url: "https://chatgpt.com/c/first", active: true },
      { id: 202, url: "https://chatgpt.com/c/second", active: false },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "send-first", method: "delegate.send_message",
      params: { tabId: 101, message: "first task" },
    });
    sockets[0].message({
      type: "request", id: "send-second", method: "delegate.send_message",
      params: { tabId: 202, message: "second task" },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tabCalls.filter(call => call.action === "execute"))
      .toEqual([{ tabId: 101, action: "execute" }, { tabId: 202, action: "execute" }]);
    expect(createdTabs).toEqual([]);
    expect(sockets[0].sent.find(value => value.id === "send-first")?.ok).toBe(true);
    expect(sockets[0].sent.find(value => value.id === "send-second")?.ok).toBe(true);
  });

  it("keeps an explicit missing tabId strict instead of opening a replacement tab", async () => {
    const { sockets, createdTabs } = fixture([]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "missing-explicit", method: "delegate.read_chat",
      params: { tabId: 999 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(createdTabs).toEqual([]);
    const result = sockets[0].sent.find(value => value.type === "response");
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("CHATGPT_TAB_NOT_FOUND");
  });

  it("probes and dispatches to the exact selected tabId only", async () => {
    const { sockets, tabCalls } = fixture([
      { id: 101, url: "https://chatgpt.com/", active: true },
      { id: 202, url: "https://chatgpt.com/c/abc", active: false },
    ]);
    sockets[0].open();
    sockets[0].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    sockets[0].message({
      type: "request", id: "tab-202", method: "delegate.read_chat", params: { tabId: 202 },
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tabCalls).toEqual([
      { tabId: 202, action: "probe" },
      { tabId: 202, action: "execute" },
    ]);
    const result = sockets[0].sent.find(value => value.type === "response");
    expect(result.ok).toBe(true);
  });

  it("stores pairing secret in trusted storage and never exposes it in status", async () => {
    const { sockets, stored, update, ask } = fixture();
    const token = "7".repeat(48);
    const outcome = await update("set_pairing", { token });
    expect(outcome.ok).toBe(true);
    expect(outcome.status.authConfigured).toBe(true);
    expect(outcome.status.authToken).toBeUndefined();
    expect(stored.delegateAuthToken).toBe(token);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent[0].authToken).toBe(token);
    sockets[1].message({ type: "hello_ack", protocol: "superagent-delegate-v1" });
    expect(JSON.stringify(ask("get_status"))).not.toContain(token);
  });

  it("refuses short pairing token without changing storage", async () => {
    const { update, stored, sockets } = fixture();
    const outcome = await update("set_pairing", { token: "weak" });
    expect(outcome.ok).toBe(false);
    expect(stored.delegateAuthToken).toBe("");
    expect(sockets).toHaveLength(1);
  });

  it("repairs only a selected ChatGPT tab using the packaged content script", async () => {
    const { update, injections } = fixture([
      {id: 202, url: "https://chatgpt.com/c/safe"},
    ], true);
    const result = await update("attach_content", {tabId: 202});
    expect(result.ok).toBe(true);
    expect(result.repaired).toBe(true);
    expect(injections).toEqual([{tabId: 202, files: ["content.js"]}]);
  });

  it("refuses script injection on any non-ChatGPT URL", async () => {
    const { update, injections } = fixture([
      {id: 101, url: "https://example.com/private"},
    ], true);
    const result = await update("attach_content", {tabId: 101});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("DELEGATE_TAB_ORIGIN_DENIED");
    expect(injections).toEqual([]);
  });

  it("accepts an eight-character terminal pairing code and saves issued token only after ack", async () => {
    const { update, sockets, stored, ask } = fixture();
    const attempt = await update("set_pairing", { token: "ABCD-EFGH" });
    expect(attempt.ok).toBe(true);
    expect(attempt.status.pairingInProgress).toBe(true);
    expect(stored.delegateAuthToken).toBe("");
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sent[0]).toMatchObject({
      type: "hello", pairingCode: "ABCDEFGH",
      clientId: "delegate-test-profile-001",
    });
    expect(sockets[1].sent[0].authToken).toBeUndefined();
    const issued = "f".repeat(64);
    sockets[1].message({
      type: "hello_ack", protocol: "superagent-delegate-v1",
      authToken: issued,
    });
    for (let i = 0; i < 8 && stored.delegateAuthToken !== issued; i++) {
      await Promise.resolve();
    }
    expect(stored.delegateAuthToken).toBe(issued);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ask("get_status").status.connected).toBe(true);
    expect(ask("get_status").status.pairingInProgress).toBe(false);
    expect(JSON.stringify(ask("get_status"))).not.toContain("ABCDEFGH");
    expect(JSON.stringify(ask("get_status"))).not.toContain(issued);
  });

  it("stops automatic retries when server rejects pairing code", async () => {
    const { update, sockets, ask } = fixture();
    await update("set_pairing", { token: "WXYZ-2345" });
    sockets[1].open();
    sockets[1].close(1008, "DELEGATE_PAIR_CODE_INVALID");
    expect(ask("get_status").status.connected).toBe(false);
    expect(ask("get_status").status.nextRetryAt).toBeNull();
    expect(sockets).toHaveLength(2);
    // Reconnect cannot bypass a rejected/expired pair code.
    const retry = ask("reconnect");
    expect(retry.started).toBe(false);
    expect(retry.reason).toBe("pairing_required");
    expect(sockets).toHaveLength(2);
    const next = await update("set_pairing", { token: "ABCD-EFGH" });
    expect(next.ok).toBe(true);
    expect(sockets).toHaveLength(3);
  });
});
