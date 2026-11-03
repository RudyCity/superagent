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
  composerStyle?: "legacy" | "prosemirror";
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
      if ((options.composerStyle === "prosemirror" && selector.includes("data-composer-markdown")) ||
        (options.composerStyle !== "prosemirror" && selector.includes("#prompt-textarea"))) {
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
      href: "https://chatgpt.com" + (options.path || "/c/example"),
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
  function inspect(): any {
    let reply: any;
    listener(
      { scope: "superagent-delegate-v1", action: "inspect_tab" },
      { id: chrome.runtime.id },
      response => { reply = response; },
    );
    return reply;
  }
  return { call, inspect, turns, buttons, composer, location: ctx.location };
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
  it("marks an empty ChatGPT homepage safe for duplicate cleanup", () => {
    const sim = setup({ path: "/" });
    expect(sim.inspect()).toEqual({
      ready: true, safeToClose: true, reason: "verified_idle",
    });
  });

  it("never exposes or closes an unsent draft", () => {
    const draft = "Private unfinished user draft";
    const sim = setup({ path: "/", composer: new FakeTextarea(draft) });
    const verdict = sim.inspect();
    expect(verdict).toEqual({
      ready: true, safeToClose: false, reason: "draft_present",
    });
    expect(JSON.stringify(verdict)).not.toContain(draft);
  });

  it("protects generating and unverified conversation tabs", () => {
    const active = setup({ buttons: [button("stop", () => {})] });
    expect(active.inspect().reason).toBe("generating");
    expect(active.inspect().safeToClose).toBe(false);
    const loading = setup({ path: "/c/existing", turns: [] });
    expect(loading.inspect().reason).toBe("chat_not_loaded");
    expect(loading.inspect().safeToClose).toBe(false);
  });

  it("permits completed idle chats but not pages with a missing composer", () => {
    expect(setup({ path: "/c/existing", turns: [turn("assistant", "Done")] })
      .inspect().safeToClose).toBe(true);
    expect(setup({ path: "/", composer: null }).inspect().safeToClose).toBe(false);
  });

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
    const sim = setup({ path: "/" });
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
    let sim: ReturnType<typeof setup>;
    sim = setup({
      turns,
      buttons: [button("new", () => {
        clicks++;
        turns.length = 0;
        sim.location.pathname = "/";
        sim.location.href = "https://chatgpt.com/";
      })],
    });
    const out = await sim.call("delegate.create_chat");
    expect(out.ok).toBe(true);
    expect(out.result.created).toBe(true);
    expect(clicks).toBe(1);
  });

  it("recognizes the current ChatGPT ProseMirror composer without a new-chat click on an empty homepage", async () => {
    let clicks = 0;
    const sim = setup({
      path: "/",
      composerStyle: "prosemirror",
      buttons: [button("new", () => clicks++)],
    });
    const output = await sim.call("delegate.create_chat");
    expect(output.ok).toBe(true);
    expect(output.result.ready).toBe(true);
    expect(output.result.already_new_chat).toBe(true);
    expect(output.result.created).toBe(false);
    expect(output.result.status).toBe("waiting_for_input");
    expect(output.result.url).toBe("https://chatgpt.com/");
    expect(clicks).toBe(0);
  });

  it("does not discard an unsent homepage draft when asked to create a chat", async () => {
    let clicks = 0;
    const sim = setup({
      path: "/",
      composerStyle: "prosemirror",
      composer: new FakeTextarea("Don't delete this draft"),
      buttons: [button("new", () => clicks++)],
    });
    const output = await sim.call("delegate.create_chat");
    expect(output.ok).toBe(false);
    expect(output.error?.code).toBe("CHATGPT_DRAFT_PRESENT");
    expect(clicks).toBe(0);
  });

  it("reports an unverified conversation instead of claiming a blank /c chat is ready", async () => {
    const sim = setup({ path: "/c/existing" });
    const result = await sim.call("delegate.read_chat");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("unverified");
    expect(result.result.ready).toBe(true);
    expect(result.result.total_message_count).toBe(0);
  });

  it("blocks navigating away from a busy ChatGPT generation", async () => {
    let clicks = 0;
    const sim = setup({
      path: "/c/existing",
      buttons: [button("new", () => clicks++), button("stop", () => {})],
    });
    const result = await sim.call("delegate.create_chat");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CHATGPT_BUSY");
    expect(clicks).toBe(0);
  });

  it("will not claim a new chat if the click does not change location", async () => {
    let clicks = 0;
    const sim = setup({
      path: "/c/existing",
      turns: [turn("user", "history")],
      buttons: [button("new", () => clicks++)],
    });
    const response = await sim.call("delegate.create_chat");
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("DELEGATE_DOM_TIMEOUT");
    expect(clicks).toBe(1);
  });
});
