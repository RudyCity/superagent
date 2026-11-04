import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const base = new URL("../chrome-extension-chatgpt-optimizer/", import.meta.url);
const probeCode = fs.readFileSync(new URL("tab-reload.js", base), "utf8");
const popupCode = fs.readFileSync(new URL("popup-reload.js", base), "utf8");

const chatUrl = (id: string) => `https://chatgpt.com/c/${id}`;
const CHAT_A = chatUrl("12345678-abcd-1234-abcd-123456789001");
const CHAT_B = chatUrl("12345678-abcd-1234-abcd-123456789002");

function safetyFixture(options: {
  path?: string;
  draft?: string;
  generating?: boolean;
  attachment?: boolean;
  dialog?: boolean;
  loading?: boolean;
  composer?: boolean;
  messages?: boolean;
} = {}) {
  let listener: Function = () => {};
  const editor = {
    isConnected: true,
    value: options.draft ?? "",
    getClientRects: () => [1],
  };
  const control = {
    isConnected: true,
    getClientRects: () => [1],
    getAttribute: (name: string) =>
      name === "aria-label" && options.generating ? "Stop generating" : "",
    matches: (selector: string) => !!options.generating && selector.includes("stop-button"),
  };
  const node = { isConnected: true, getClientRects: () => [1] };
  const document = {
    readyState: options.loading ? "loading" : "complete",
    querySelectorAll: (selector: string) => {
      if (selector.includes("#prompt-textarea")) return options.composer === false ? [] : [editor];
      if (selector === "button") return options.generating ? [control] : [];
      if (selector.includes("attachment-preview")) return options.attachment ? [node] : [];
      if (selector.includes('dialog[open]')) return options.dialog ? [node] : [];
      if (selector.includes("data-message-author-role")) return options.messages === false ? [] : [node];
      return [];
    },
  };
  const chrome = {
    runtime: {
      id: "extension-id",
      onMessage: { addListener: (fn: Function) => { listener = fn; } },
    },
  };
  vm.runInNewContext(probeCode, {
    chrome, location: { pathname: options.path || "/c/12345678-abcd-1234-abcd-123456789001" }, document,
  });
  function call(senderId = "extension-id", action = "inspect_reload"): any {
    let response: any;
    const result = listener({
      scope: "chatgpt-optimizer-target-reload-v1", action,
    }, { id: senderId }, (out: any) => { response = out; });
    return { response, result };
  }
  return { call };
}

class FakeElement {
  id: string;
  tagName: string;
  value = "";
  textContent = "";
  title = "";
  disabled = false;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  events: Record<string, () => void> = {};
  constructor(tag: string, id = "") { this.tagName = tag.toUpperCase(); this.id = id; }
  appendChild(node: FakeElement) { this.children.push(node); return node; }
  replaceChildren(...nodes: FakeElement[]) { this.children = [...nodes]; this.value = ""; }
  addEventListener(name: string, cb: () => void) { this.events[name] = cb; }
  trigger(name: string) { this.events[name]?.(); }
}

function popupFixture(options: {
  tabs?: Array<{ id: number; url: string; title: string; windowId: number }>;
  activeId?: number;
  safety?: { ok: boolean; safe?: boolean; reason?: string };
  secondUrl?: string;
  noContent?: boolean;
} = {}) {
  const tabs = options.tabs || [
    { id: 101, url: CHAT_A, title: "Conversation A", windowId: 1 },
    { id: 102, url: CHAT_B, title: "Conversation B", windowId: 2 },
  ];
  const nodes: Record<string, FakeElement> = Object.fromEntries(
    ["reload-chat-select", "reload-chat", "refresh-chat-tabs", "reload-chat-status"].map(
      (id) => [id, new FakeElement("div", id)],
    ),
  );
  const calls = { queried: [] as string[], inspected: [] as number[], reloaded: [] as number[], fetched: 0 };
  const fetchCounts = new Map<number, number>();
  const chrome = {
    tabs: {
      async query(query: any) {
        calls.queried.push(query.url ? "all" : "active");
        return query.url ? tabs : tabs.filter((tab) => tab.id === (options.activeId ?? 101));
      },
      async get(tabId: number) {
        const result = tabs.find((tab) => tab.id === tabId);
        if (!result) throw Error("Tab gone");
        const count = (fetchCounts.get(tabId) || 0) + 1;
        fetchCounts.set(tabId, count);
        return { ...result, url: count >= 2 && options.secondUrl ? options.secondUrl : result.url };
      },
      async sendMessage(tabId: number, message: any) {
        calls.inspected.push(tabId);
        expect(message).toEqual({ scope: "chatgpt-optimizer-target-reload-v1", action: "inspect_reload" });
        if (options.noContent) throw Error("Not connected");
        return options.safety || { ok: true, safe: true, reason: "The selected conversation is idle." };
      },
      async reload(tabId: number) { calls.reloaded.push(tabId); },
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
  return { nodes, calls, tick };
}

describe("ChatGPT Optimizer: selected-chat reload guard", () => {
  it("allows reload inspection for idle, fully loaded saved conversations", () => {
    expect(safetyFixture().call().response).toEqual({
      ok: true, safe: true, reason: "The selected conversation is idle.",
    });
  });

  it("blocks generating, draft, uploading, dialog, loading and incomplete conversations", () => {
    for (const scenario of [
      { generating: true }, { draft: "Please don't lose my work" },
      { attachment: true }, { dialog: true }, { loading: true },
      { composer: false }, { messages: false }, { path: "/" },
    ]) {
      const { response } = safetyFixture(scenario).call();
      expect(response.ok).toBe(true);
      expect(response.safe).toBe(false);
      expect(typeof response.reason).toBe("string");
      expect(JSON.stringify(response)).not.toContain("Please don't lose my work");
    }
  });

  it("ignores messages from other extensions and unknown actions", () => {
    const fixture = safetyFixture();
    expect(fixture.call("wrong-extension")).toEqual({ response: undefined, result: false });
    expect(fixture.call("extension-id", "reload_now").response).toEqual({
      ok: false, reason: "Unknown action",
    });
  });

  it("reloads only the selected chat tab, not other open Chrome tabs", async () => {
    const p = popupFixture();
    await p.tick();
    expect(p.nodes["reload-chat-select"].children).toHaveLength(3);
    p.nodes["reload-chat-select"].value = "102";
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.calls.inspected).toEqual([102]);
    expect(p.calls.reloaded).toEqual([102]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("All other tabs are untouched");
  });

  it("does not reload a tab whose safety inspection reports a draft or stream", async () => {
    const p = popupFixture({ safety: { ok: true, safe: false, reason: "An unsent message draft is present." } });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.calls.inspected).toEqual([101]);
    expect(p.calls.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("draft");
  });

  it("blocks reload if the selected tab navigates after inspection", async () => {
    const p = popupFixture({ secondUrl: CHAT_B });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.calls.inspected).toEqual([101]);
    expect(p.calls.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("changed");
  });

  it("fails closed when the content script is not installed", async () => {
    const p = popupFixture({ noContent: true });
    await p.tick();
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.calls.reloaded).toEqual([]);
    expect(p.nodes["reload-chat-status"].textContent).toContain("Could not reload safely");
  });

  it("excludes other sites and unsaved/new-chat pages from selection", async () => {
    const p = popupFixture({ tabs: [
      { id: 1, url: "https://evil.example/c/12345678-abcd-1234-abcd-123456789003", title: "Wrong host", windowId: 1 },
      { id: 2, url: "https://chatgpt.com/", title: "New chat", windowId: 1 },
      { id: 3, url: CHAT_B, title: "Chat B", windowId: 2 },
    ], activeId: 1 });
    await p.tick();
    expect(p.nodes["reload-chat-select"].children).toHaveLength(2);
    expect(p.nodes["reload-chat-select"].value).toBe("3");
    p.nodes["reload-chat"].trigger("click");
    await p.tick();
    expect(p.calls.reloaded).toEqual([3]);
  });
});
