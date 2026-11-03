import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync(
  new URL("../chrome-extension-delegate/background.js", import.meta.url), "utf8"
);

type Listener = (event?: any) => void;
function fixture(
  tabs: Array<{ id: number; url: string; active?: boolean }> = [],
  needsInjection = false,
) {
  const tabCalls: Array<{tabId: number; action: string}> = [];
  const injections: Array<{tabId: number;files: string[]}> = [];
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
      get: async (id: number) => tabs.find(t => t.id === id),
      query: async () => tabs,
      sendMessage: async (tabId: number, message: { action: string }) => {
        tabCalls.push({ tabId, action: message.action });
        if (message.action === "probe" && needsInjection && !injected) {
          throw new Error("Receiving end does not exist");
        }
        return message.action === "probe"
          ? { ready: true } : { ok: true, result: { status: "waiting_for_input" } };
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
  return { ask, update, sockets, badges, timers, stored, tabCalls, injections };
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
    const next = await update("set_pairing", { token: "ABCD-EFGH" });
    expect(next.ok).toBe(true);
    expect(sockets).toHaveLength(3);
  });
});
