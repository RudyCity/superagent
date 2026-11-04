import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const base = new URL("../chrome-extension-chatgpt-lite/", import.meta.url);
const policyCode = fs.readFileSync(new URL("policy.js", base), "utf8");
const sidebarCode = fs.readFileSync(new URL("sidebar.js", base), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", base), "utf8"));

class FakeNode {
  tagName: string;
  className = "";
  textContent = "";
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  hidden = false;
  disabled = false;
  title = "";
  type = "";

  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }

  get classList() {
    return { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  }
  setAttribute(key: string, val: string) { this.attrs.set(key, val); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  addEventListener(_type: string, _fn: unknown) {}
  append(...nodes: FakeNode[]) { for (const child of nodes) this.appendChild(child); }
  appendChild(node: FakeNode) { this.insertBefore(node, null); }
  insertBefore(node: FakeNode, ref: FakeNode | null) {
    if (node.parentElement) {
      node.parentElement.children = node.parentElement.children.filter((item) => item !== node);
    }
    node.parentElement = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index < 0) this.children.push(node);
    else this.children.splice(index, 0, node);
  }
  replaceChildren(...nodes: FakeNode[]) {
    for (const node of this.children) node.parentElement = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
      this.parentElement = null;
    }
  }
  closest(selector: string): FakeNode | null {
    const wanted = selector.startsWith(".") ? selector.slice(1) : null;
    for (let node: FakeNode | null = this; node; node = node.parentElement) {
      if (wanted && node.classList.contains(wanted)) return node;
      if (selector === "[data-sg-opt-sidebar]" && node.attrs.has("data-sg-opt-sidebar")) return node;
    }
    return null;
  }
  walk() {
    const result: FakeNode[] = [];
    const visit = (node: FakeNode) => { result.push(node); for (const child of node.children) visit(child); };
    visit(this);
    return result;
  }
  querySelectorAll(selector: string) {
    return this.walk().filter((node) => {
      if (selector === 'button[data-app-action-sidebar-section-toggle]') {
        return node.tagName === "BUTTON" && node.attrs.has("data-app-action-sidebar-section-toggle");
      }
      if (selector === 'a[href^="/c/"]') {
        return node.tagName === "A" && (node.attrs.get("href") || "").startsWith("/c/");
      }
      if (selector.startsWith(".")) return node.classList.contains(selector.slice(1));
      return false;
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}

const chatId = (i: number) => `12345678-aaaa-bbbb-cccc-${String(i).padStart(12, "0")}`;
const record = (i: number, title = `Chat ${i}`, time = i) =>
  ({ id: chatId(i), title, update_time: time, is_archived: false, is_temporary_chat: false });

function setup(options: { items?: any[]; noToken?: boolean; apiFailure?: boolean; sidebarEnabled?: boolean } = {}) {
  const body = new FakeNode("body");
  const nav = new FakeNode("nav");
  nav.setAttribute("aria-label", "Chat history");
  body.append(nav);
  const section = new FakeNode("div");
  section.className = "group/nav-section";
  const header = new FakeNode("div");
  const toggle = new FakeNode("button");
  toggle.textContent = "Recents";
  toggle.setAttribute("data-app-action-sidebar-section-toggle", "");
  toggle.setAttribute("aria-expanded", "true");
  header.append(toggle);
  const nativeList = new FakeNode("div");
  const nativeLink = new FakeNode("a");
  nativeLink.setAttribute("href", `/c/${chatId(1)}`);
  nativeList.append(nativeLink);
  section.append(header, nativeList);
  nav.append(section);
  const docListeners: Record<string, Function> = {};
  const windowListeners: Record<string, Function> = {};
  const document = {
    body, hidden: false,
    querySelector: (s: string) => s === 'nav[aria-label="Chat history"]' ? nav : null,
    createElement: (tag: string) => new FakeNode(tag),
    addEventListener: (type: string, cb: Function) => { docListeners[type] = cb; },
  };
  let now = 25000;
  let data = options.items || [record(1), record(2)];
  let listener: Function = () => {};
  let settingsListener: Function = () => {};
  let requests: { url: string; hasAuthorization: boolean }[] = [];
  const settings = { enabled: true, mode: "render", sidebarSync: options.sidebarEnabled !== false, sidebarInterval: 60 };
  const chrome = {
    runtime: { id: "optimizer-sidebar-test", onMessage: { addListener(fn: Function) { listener = fn; } } },
    storage: {
      local: { async get() { return { superagentChatGPTLiteSettings: settings }; } },
      onChanged: { addListener(fn: Function) { settingsListener = fn; } },
    },
  };
  async function fetchMock(url: string, init: any) {
    requests.push({ url, hasAuthorization: !!init?.headers?.Authorization });
    if (url === "/api/auth/session") {
      return { ok: true, json: async () => options.noToken ? {} : { accessToken: "fake-secret-never-saved" } };
    }
    return { ok: !options.apiFailure, json: async () => ({ items: data, total: data.length }) };
  }
  const context: any = {
    chrome, document, window: { addEventListener: (type: string, cb: Function) => { windowListeners[type] = cb; } },
    fetch: fetchMock, console, Date: { now: () => now },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(policyCode, context, { filename: "policy.js" });
  vm.runInNewContext(sidebarCode, context, { filename: "sidebar.js" });
  const ready = new Promise<void>((resolve) => setImmediate(resolve));
  async function call(action: string): Promise<any> {
    return await new Promise((resolve) => listener(
      { scope: "chatgpt-optimizer-sidebar-v1", action },
      { id: "optimizer-sidebar-test" }, resolve,
    ));
  }
  return {
    ready, body, nav, section, nativeList, toggle, requests, context, docListeners, windowListeners,
    call,
    changeSettings: (newSettings: any) => settingsListener({
      superagentChatGPTLiteSettings: { newValue: newSettings },
    }, "local"),
    setData: (next: any[]) => { data = next; },
    advance: (ms = 20000) => { now += ms; },
    getLinks: () => (section.querySelector(".sg-opt-sidebar-links")?.querySelectorAll('a[href^="/c/"]') || []),
    getLive: () => section.querySelector(".sg-opt-sidebar"),
  };
}

describe("ChatGPT Optimizer: sidebar sync policy", () => {
  it("normalizes intervals and malformed records without exposing response fields", () => {
    const context: any = {};
    vm.runInNewContext(policyCode, context);
    const p = context.ChatGPTLitePolicy;
    expect(p.normalizeSettings({ sidebarSync: 1, sidebarInterval: 0 }).sidebarSync).toBe(true);
    expect(p.normalizeSettings({ sidebarInterval: 999 }).sidebarInterval).toBe(60);
    expect(p.normalizeSettings({ sidebarInterval: 120 }).sidebarInterval).toBe(120);
    const chats = p.normalizeSidebarChats([
      record(2, "Valid\nChat", 2), record(1, "", 1), record(2, "Updated title", 4),
      { id: "../../evil", title: "Invalid" }, { ...record(3), is_archived: true },
    ]);
    expect(chats.length).toBe(2);
    expect(chats[0].title).toBe("Updated title");
    expect(chats[0]).toEqual({ id: chatId(2), title: "Updated title", timestamp: 4 });
    expect(chats[1].title).toBe("Untitled chat");
  });

  it("manifest loads sidebar scripts with no new permissions or external origins", () => {
    expect(manifest.content_scripts[0].js).toEqual(["policy.js", "content.js", "sidebar.js"]);
    expect(manifest.content_scripts[0].css).toEqual(["content.css", "sidebar.css"]);
    expect(manifest.permissions).toEqual(["storage", "tabs"]);
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*"]);
    expect(sidebarCode).not.toMatch(/location\.reload|history\.pushState|\.innerHTML\s*=|document\.cookie|localStorage|WebSocket/);
  });
});

describe("ChatGPT Optimizer: live recent list", () => {
  it("fetches authenticated history from the same site and adds only missing chat links", async () => {
    const h = setup();
    await h.ready;
    const result = await h.call("status");
    expect(result.ok).toBe(true);
    expect(result.state.phase).toBe("ready");
    expect(result.state.serverCount).toBe(2);
    expect(result.state.missingCount).toBe(1);
    expect(h.getLive()?.parentElement).toBe(h.section);
    expect(h.getLinks().length).toBe(1);
    expect(h.getLinks()[0].getAttribute("href")).toBe(`/c/${chatId(2)}`);
    expect(h.nativeList.children[0].getAttribute("href")).toBe(`/c/${chatId(1)}`);
    expect(h.requests.some((r) => r.url.includes("/api/auth/session"))).toBe(true);
    expect(h.requests.filter((r) => r.url.includes("/backend-api/")).every((r) => r.hasAuthorization)).toBe(true);
    expect(JSON.stringify(result.state)).not.toContain("fake-secret");
  });

  it("finds a new chat on subsequent fetch without reloading or replacing native sidebar", async () => {
    const h = setup({ items: [record(1)] });
    await h.ready;
    expect((await h.call("status")).state.missingCount).toBe(0);
    h.setData([record(1), record(9)]);
    h.advance();
    const result = await h.call("refresh");
    expect(result.state.missingCount).toBe(1);
    expect(h.getLinks()[0].getAttribute("href")).toBe(`/c/${chatId(9)}`);
    expect(h.nativeList.children[0].getAttribute("href")).toBe(`/c/${chatId(1)}`);
  });

  it("removes duplicate links when native ChatGPT navigation catches up", async () => {
    const h = setup();
    await h.ready;
    expect(h.getLinks().length).toBe(1);
    const native = new FakeNode("a");
    native.setAttribute("href", `/c/${chatId(2)}`);
    h.nativeList.append(native);
    expect((await h.call("status")).state.missingCount).toBe(0);
    expect(h.getLinks().length).toBe(0);
    expect(h.nativeList.children.length).toBe(2);
  });

  it("keeps two independent Chrome profiles synchronized via server reads", async () => {
    const browserA = setup({ items: [record(1), record(7)] });
    const browserB = setup({ items: [record(1), record(7)] });
    await Promise.all([browserA.ready, browserB.ready]);
    expect((await browserA.call("status")).state.missingCount).toBe(1);
    expect((await browserB.call("status")).state.missingCount).toBe(1);
    expect(browserA.getLinks()[0].getAttribute("href")).toBe(browserB.getLinks()[0].getAttribute("href"));
  });

  it("stops refreshing when disabled and removes extension-owned sidebar only", async () => {
    const h = setup();
    await h.ready;
    expect(h.getLive()).not.toBeNull();
    h.changeSettings({ enabled: true, sidebarSync: false });
    const status = await h.call("status");
    expect(status.state.enabled).toBe(false);
    expect(h.getLive()).toBeNull();
    const before = h.requests.length;
    h.advance();
    await h.call("refresh");
    expect(h.requests.length).toBe(before);
    expect(h.nativeList.children.length).toBe(1);
  });

  it("does not call history endpoint without a session and never displays token", async () => {
    const h = setup({ noToken: true });
    await h.ready;
    const status = await h.call("status");
    expect(status.state.phase).toBe("error");
    expect(status.state.error).toContain("Sign in");
    expect(h.requests.filter((r) => r.url.includes("backend-api")).length).toBe(0);
    expect(JSON.stringify(status)).not.toContain("fake-secret");
  });

  it("fails closed on API errors while preserving native chat navigation", async () => {
    const h = setup({ apiFailure: true });
    await h.ready;
    const status = await h.call("status");
    expect(status.state.phase).toBe("error");
    expect(status.state.error).toContain("Unable to refresh");
    expect(h.getLinks().length).toBe(0);
    expect(h.nativeList.children[0].getAttribute("href")).toBe(`/c/${chatId(1)}`);
  });
});
