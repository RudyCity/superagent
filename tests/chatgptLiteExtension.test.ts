import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const base = new URL("../ChatGPT Optimizer/", import.meta.url);
const policyCode = fs.readFileSync(new URL("policy.js", base), "utf8");
const contentCode = fs.readFileSync(new URL("content.js", base), "utf8");
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", base), "utf8"));

class NodeMock {
  tagName: string;
  parentElement: NodeMock | null = null;
  children: NodeMock[] = [];
  attrs = new Map<string, string>();
  textContent = "";
  isConnected = true;
  constructor(tagName = "div") { this.tagName = tagName; }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  removeAttribute(key: string) { this.attrs.delete(key); }
  contains(node: NodeMock | null): boolean {
    for (let current = node; current; current = current.parentElement) if (current === this) return true;
    return false;
  }
  closest(selector: string): NodeMock | null {
    for (let current: NodeMock | null = this; current; current = current.parentElement) {
      if (selector === "article" && current.tagName === "article") return current;
      if (selector.includes("conversation-turn-") && current.attrs.has("data-testid")) return current;
      if (selector.includes("data-sg-lite-ui") && current.attrs.has("data-sg-lite-ui")) return current;
    }
    return null;
  }
  append(...nodes: NodeMock[]) { for (const node of nodes) this.appendChild(node); }
  appendChild(node: NodeMock) { node.parentElement = this; this.children.push(node); }
  addEventListener(_type: string, _handler: () => void) {}
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((n) => n !== this);
    this.parentElement = null;
    this.isConnected = false;
  }
}

type Harness = ReturnType<typeof makeHarness>;
function makeHarness(initial: Record<string, unknown> = { mode: "compact", keepLast: 8 }) {
  const turns = Array.from({ length: 30 }, (_, idx) => {
    const node = new NodeMock("article");
    node.setAttribute("data-testid", `conversation-turn-${idx}`);
    const message = new NodeMock("p");
    message.textContent = `message ${idx}`;
    node.appendChild(message);
    return node;
  });
  const body = new NodeMock("body");
  const location = { pathname: "/c/one" };
  const document = {
    body,
    documentElement: new NodeMock("html"),
    activeElement: body,
    hidden: false,
    createElement: (tag: string) => new NodeMock(tag),
    querySelectorAll: (selector: string) => {
      if (selector.includes("conversation-turn-")) return turns;
      if (selector.includes("data-message-author-role")) return [];
      return [];
    },
    addEventListener() {},
  };
  let listener: (message: any, sender: any, reply: (value: any) => void) => boolean;
  let changeListener: (changes: any, area: string) => void;
  const chrome = {
    runtime: { id: "test-id", onMessage: { addListener(fn: typeof listener) { listener = fn; } } },
    storage: {
      local: { async get() { return { superagentChatGPTLiteSettings: initial }; } },
      onChanged: { addListener(fn: typeof changeListener) { changeListener = fn; } },
    },
  };
  const context: any = {
    chrome, document, location, window: { getSelection: () => ({ isCollapsed: true }), addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout, setInterval: () => 1, console,
  };
  vm.runInNewContext(policyCode, context, { filename: "policy.js" });
  vm.runInNewContext(contentCode, context, { filename: "content.js" });
  const ready = new Promise<void>((resolve) => setImmediate(resolve));
  function call(action: string) {
    let result: any;
    listener({ scope: "superagent-chatgpt-lite-v1", action }, { id: "test-id" }, (value) => { result = value; });
    return result;
  }
  function updateSettings(newValue: Record<string, unknown>) {
    changeListener({ superagentChatGPTLiteSettings: { newValue } }, "local");
  }
  return { ready, turns, body, document, location, call, updateSettings, context };
}

describe("ChatGPT Optimizer extension: policy", () => {
  const context: any = {};
  vm.runInNewContext(policyCode, context);
  const policy = context.ChatGPTLitePolicy;

  it("has safe defaults and validates tampered storage values", () => {
    expect(policy.normalizeSettings({ mode: "__delete__", keepLast: -100, enabled: 1 })).toEqual({
      enabled: true, mode: "render", keepLast: 24, showControls: true,
      sidebarSync: true, sidebarInterval: 60,
    });
    expect(policy.ALLOWED_KEEPS.join(",")).toBe("8,16,24,40,80");
  });

  it("renders all by default, compacts only when selected, and restores on disable", () => {
    expect(policy.plan(100, { mode: "render", keepLast: 8 }).hiddenCount).toBe(0);
    expect(policy.plan(100, { mode: "compact", keepLast: 8 }).hiddenCount).toBe(92);
    expect(policy.plan(100, { mode: "compact", keepLast: 8 }, 20).hiddenCount).toBe(72);
    expect(policy.plan(100, { mode: "compact", keepLast: 8 }, 0, true).hiddenCount).toBe(0);
    expect(policy.plan(100, { enabled: false, mode: "compact", keepLast: 8 }).optimizeBefore).toBe(0);
  });

  it("shows the new name and provides valid PNG icons at all required sizes", () => {
    expect(manifest.name).toBe("ChatGPT Optimizer");
    expect(manifest.action.default_title).toContain("ChatGPT Optimizer");
    const popup = fs.readFileSync(new URL("popup.html", base), "utf8");
    expect(popup).toContain("<h1>ChatGPT Optimizer</h1>");
    expect(popup).toContain('src="icons/icon-48.png"');
    for (const size of [16, 32, 48, 128]) {
      const iconPath = `icons/icon-${size}.png`;
      expect(manifest.icons[String(size)]).toBe(iconPath);
      const png = fs.readFileSync(new URL(iconPath, base));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
    }
    expect(manifest.action.default_icon["16"]).toBe("icons/icon-16.png");
    expect(manifest.action.default_icon["32"]).toBe("icons/icon-32.png");
  });

  it("limits the site origin and permissions (no network/socket/clipboard APIs)", () => {
    expect(manifest.host_permissions).toEqual(["https://chatgpt.com/*"]);
    expect(manifest.permissions).toEqual(["storage", "tabs"]);
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.background).toBeUndefined();
    expect(contentCode).not.toMatch(/fetch\(|WebSocket\(|XMLHttpRequest\(|\.innerHTML\s*=|\.removeChild\(/);
  });
});

describe("ChatGPT Optimizer extension: DOM integration", () => {
  it("compacts only old turns without removing their child nodes", async () => {
    const h = makeHarness();
    await h.ready;
    const response = h.call("status");
    expect(response.ok).toBe(true);
    expect(response.state.total).toBe(30);
    expect(response.state.hidden).toBe(22);
    expect(h.turns.slice(0, 22).every((node) => node.getAttribute("data-sg-lite-hidden") === "1")).toBe(true);
    expect(h.turns.slice(22).every((node) => !node.getAttribute("data-sg-lite-hidden"))).toBe(true);
    expect(h.turns.every((node, i) => node.children[0]?.textContent === `message ${i}`)).toBe(true);
  });

  it("supports progressive reveal and restores all messages", async () => {
    const h = makeHarness();
    await h.ready;
    expect(h.call("show_more").state.hidden).toBe(2);
    expect(h.call("show_all").state.hidden).toBe(0);
    expect(h.turns.every((node) => node.getAttribute("data-sg-lite-hidden") === null)).toBe(true);
    expect(h.call("reset_view").state.hidden).toBe(22);
  });

  it("does not hide a turn containing focus; disables and fully restores attributes", async () => {
    const h = makeHarness();
    await h.ready;
    h.document.activeElement = h.turns[0].children[0];
    expect(h.call("status").state.hidden).toBe(21);
    expect(h.turns[0].getAttribute("data-sg-lite-hidden")).toBe(null);
    h.updateSettings({ enabled: false, mode: "compact", keepLast: 8 });
    expect(h.turns.every((node) =>
      node.getAttribute("data-sg-lite-hidden") === null &&
      node.getAttribute("data-sg-lite-render") === null)).toBe(true);
  });

  it("cleans up previous chat when SPA navigation changes the URL", async () => {
    const h = makeHarness();
    await h.ready;
    expect(h.call("show_more").state.revealedExtra).toBe(20);
    h.location.pathname = "/c/two";
    const response = h.call("status");
    expect(response.state.revealedExtra).toBe(0);
    expect(response.state.pathname).toBe("/c/two");
    expect(response.state.hidden).toBe(22);
  });

  it("keeps full DOM visible in render mode and ignores external messages", async () => {
    const h = makeHarness({ mode: "render" });
    await h.ready;
    const state = h.call("status").state;
    expect(state.hidden).toBe(0);
    expect(state.optimized).toBe(26);
    expect(h.turns.every((node) => node.getAttribute("data-sg-lite-hidden") === null)).toBe(true);
    expect(h.call("unknown_action")).toEqual({ ok: false, error: "UNKNOWN_ACTION" });
  });
});
