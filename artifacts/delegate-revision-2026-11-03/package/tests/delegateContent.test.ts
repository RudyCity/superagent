import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";

const script = fs.readFileSync(
  new URL("../chrome-extension-delegate/content.js", import.meta.url),
  "utf8",
);

type FakeTurn = {
  isConnected: boolean;
  getClientRects: () => number[];
  getAttribute: (name: string) => string | null;
  querySelector: () => null;
  innerText: string;
  textContent: string;
};

class FakeTextarea {
  isConnected = true;
  private current: string;
  constructor(value = "") { this.current = value; }
  get value(): string { return this.current; }
  set value(value: string) { this.current = value; }
  getClientRects(): number[] { return [1]; }
  focus(): void {}
  dispatchEvent(): boolean { return true; }
  getAttribute(): null { return null; }
  get innerText(): string { return ""; }
  get textContent(): string { return this.current; }
}

type Response = { ok: boolean; result?: any; error?: {code: string; message: string} };

function setup(options: {
  path?: string;
  composer?: FakeTextarea | null;
  turns?: FakeTurn[];
  buttons?: any[];
} = {}) {
  const turns: FakeTurn[] = options.turns || [];
  const buttons = options.buttons || [];
  const composer = options.composer === undefined ? new FakeTextarea() : options.composer;
  let listener: (
    request: any,
    sender: any,
    sendResponse: (response: any) => void
  ) => boolean;
  const chrome = {
    runtime: {
      id: "delegate-test-extension",
      onMessage: {
        addListener(callback: typeof listener) { listener = callback; },
      },
    },
  };
  const document = {
    documentElement: {},
    querySelectorAll(selector: string) {
      if (selector.includes("#prompt-textarea") || selector.includes("[data-testid=\\\"composer\\\"]")) {
        return composer ? [composer] : [];
      }
      if (selector === "button" || selector === "a, button") return buttons;
      if (selector === "[data-message-author-role]") return turns;
      return [];
    },
  };
  class FakeMutationObserver {
    observe() {}
    disconnect() {}
  }
  const ctx = {
    chrome,
    document,
    location: {
      pathname: options.path || "/c/example",
      href: "https://chatgpt.com/c/example",
    },
    MutationObserver: FakeMutationObserver,
    HTMLTextAreaElement: FakeTextarea,
    Event: class { constructor(_type: string, _options: unknown) {} },
    InputEvent: class { constructor(_type: string, _options: unknown) {} },
    setTimeout,
    clearTimeout,
    window: {},
    console,
  };
  vm.runInNewContext(script, ctx, { filename: "content.js" });
  let requestId = 0;
  async function call(method: string, params: object = {}, id?: string): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const accepts = listener(
        {
          scope: "superagent-delegate-v1",
          action: "execute",
          id: id || `test-${++requestId}`,
          method,
          params,
        },
        { id: chrome.runtime.id },
        resolve,
      );
      if (!accepts) reject(new Error("Unexpected listener rejection"));
    });
  }
  return { call, turns, buttons, composer };
}

function turn(role: "assistant" | "user", text: string): FakeTurn {
  return {
    isConnected: true,
    getClientRects: () => [1],
    getAttribute: () => role,
    querySelector: () => null,
    innerText: text,
    textContent: text,
  };
}

function button(kind: "send" | "stop" | "new", onClick: () => void) {
  return {
    isConnected: true,
    disabled: false,
    getClientRects: () => [1],
    getAttribute: (name: string) => name === "aria-label"
      ? kind === "send" ? "Send prompt" : kind === "stop" ? "Stop generating" : "New chat"
      : null,
    matches: (selector: string) => selector.includes(
      kind === "send" ? "send-button" : kind === "stop" ? "stop-button" : "create-new-chat-button"
    ),
    textContent: kind === "new" ? "New chat" : "",
    click: onClick,
  };
}

describe("delegate content script (simulated DOM)", () => {
  it("rejects logged-out chat without clicking anything", async () => {
    let clicks = 0;
    const sim = setup({ path: "/auth/login", buttons: [button("send", () => clicks++)] });
    const result = await sim.call("delegate.send_message", { message: "hello" });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CHATGPT_LOGIN_REQUIRED");
    expect(clicks).toBe(0);
  });

  it("preserves an unsent draft and never clicks Send", async () => {
    let clicks = 0;
    const composer = new FakeTextarea("Important unsent draft");
    const sim = setup({ composer, buttons: [button("send", () => clicks++)] });
    const result = await sim.call("delegate.send_message", { message: "new message" });
    expect(result.error?.code).toBe("CHATGPT_DRAFT_PRESENT");
    expect(composer.value).toBe("Important unsent draft");
    expect(clicks).toBe(0);
  });

  it("returns waiting_for_input for an empty chat", async () => {
    const sim = setup();
    const result = await sim.call("delegate.read_chat");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("waiting_for_input");
    expect(result.result.messages).toEqual([]);
  });

  it("submits one Send click and deduplicates identical request IDs", async () => {
    let clicks = 0;
    const turns: FakeTurn[] = [];
    const sim = setup({
      turns,
      buttons: [button("send", () => {
        clicks++;
        turns.push(turn("user", "hello ChatGPT"));
      })],
    });
    const requestId = "same-request";
    const first = await sim.call("delegate.send_message", { message: "hello ChatGPT" }, requestId);
    const second = await sim.call("delegate.send_message", { message: "hello ChatGPT" }, requestId);
    expect(first.ok).toBe(true);
    expect(first.result.delivery).toBe("sent");
    expect(second.ok).toBe(true);
    expect(clicks).toBe(1);
  });

  it("never clicks Stop from read_chat and stops once only on explicit call", async () => {
    let stops = 0;
    const sim = setup({ buttons: [button("stop", () => stops++)] });
    const read = await sim.call("delegate.read_chat");
    expect(read.result.status).toBe("working");
    expect(stops).toBe(0);
    const stopped = await sim.call("delegate.stop_generation");
    expect(stopped.ok).toBe(true);
    expect(stopped.result.stop_requested).toBe(true);
    expect(stops).toBe(1);
  });

  it("creates a fresh chat with one click, without reloading", async () => {
    let clicks = 0;
    const turns = [turn("user", "previous chat")];
    const sim = setup({
      turns,
      buttons: [button("new", () => {
        clicks++;
        turns.length = 0;
      })],
    });
    const out = await sim.call("delegate.create_chat");
    expect(out.ok).toBe(true);
    expect(out.result.created).toBe(true);
    expect(clicks).toBe(1);
  });
});
