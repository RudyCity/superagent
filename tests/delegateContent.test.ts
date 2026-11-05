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
  closest?: (selector: string) => { getAttribute: (name: string) => string | null } | null;
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
  search?: string;
  hash?: string;
  composerStyle?: "legacy" | "prosemirror";
  composer?: FakeTextarea | null;
  turns?: FakeTurn[];
  modernTurns?: FakeTurn[];
  chatLinks?: any[];
  buttons?: any[];
  bodyText?: string;
} = {}) {
  const turns: FakeTurn[] = options.turns || [];
  const modernTurns: FakeTurn[] = options.modernTurns || [];
  const chatLinks = options.chatLinks || [];
  const buttons = options.buttons || [];
  const composer = options.composer === undefined ? new FakeTextarea() : options.composer;
  const body = { innerText: options.bodyText || "" };
  const documentElement = { innerText: options.bodyText || "" };
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
    body,
    documentElement,
    title: "History Test Chat",
    querySelectorAll(selector: string) {
      if ((options.composerStyle === "prosemirror" && selector.includes("data-composer-markdown")) ||
        (options.composerStyle !== "prosemirror" && selector.includes("#prompt-textarea"))) {
        return composer ? [composer] : [];
      }
      if (selector === "button" || selector === "a, button") return buttons;
      if (selector === "[data-message-author-role]") return turns;
      if (selector.includes("data-chatgpt-search-unit-key")) return modernTurns;
      if (selector.startsWith('a[href^="/c/"]')) return chatLinks;
      return [];
    },
    querySelector() { return null; },
  };
  const mutationObservers: FakeMutationObserver[] = [];
  class FakeMutationObserver {
    active = false;
    constructor(private readonly callback: () => void) { mutationObservers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
    trigger() { if (this.active) this.callback(); }
  }
  const ctx = {
    chrome,
    document,
    location: {
      pathname: options.path || "/c/example",
      search: options.search || "",
      hash: options.hash || "",
      origin: "https://chatgpt.com",
      href: "https://chatgpt.com" + (options.path || "/c/example") + (options.search || "") + (options.hash || ""),
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
  async function mutate(nextBodyText?: string): Promise<void> {
    if (nextBodyText !== undefined) {
      body.innerText = nextBodyText;
      documentElement.innerText = nextBodyText;
    }
    for (const observer of mutationObservers) observer.trigger();
    await new Promise(resolve => setTimeout(resolve, 280));
  }
  return { call, inspect, mutate, turns, buttons, composer, body, location: ctx.location };
}

function turn(role: "assistant" | "user", text: string): FakeTurn {
  return {
    isConnected: true,
    getClientRects: () => [1],
    getAttribute: (name: string) => name === "data-message-author-role" ? role : null,
    querySelector: () => null,
    innerText: text,
    textContent: text,
  };
}

function modernTurn(role: "assistant" | "user", text: string, state?: string, turnIndex = 0): FakeTurn {
  const slot = role === "assistant" ? 2 : 0;
  return {
    isConnected: true,
    getClientRects: () => [1],
    getAttribute: (name: string) =>
      name === "data-chatgpt-search-unit-key" ? `fallback-turn-${turnIndex}:${slot}:${role}` : null,
    querySelector: () => null,
    closest: state ? () => ({
      getAttribute: (name: string) => name === "data-talvt-turn-state" ? state : null,
    }) : undefined,
    innerText: role === "assistant" ? "ChatGPT said:\n\n" + text : text,
    textContent: role === "assistant" ? "ChatGPT said:\n\n" + text : text,
  };
}

function modernButton(label: "Send" | "Stop", onClick: () => void) {
  return {
    isConnected: true,
    disabled: false,
    getClientRects: () => [1],
    getAttribute: (name: string) => name === "aria-label" ? label : null,
    matches: () => false,
    textContent: "",
    click: onClick,
  };
}

function retryButton(onClick: () => void) {
  return {
    isConnected: true,
    disabled: false,
    getClientRects: () => [1],
    getAttribute: (name: string) => name === "aria-label" ? "Retry" : null,
    matches: () => false,
    textContent: "Retry",
    click: onClick,
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

function chatLink(chatId: string, title: string, onClick: () => void = () => {}) {
  return {
    parentElement: null,
    getAttribute: (name: string) => name === "href" ? `/c/${chatId}`
      : name === "aria-label" ? title : null,
    textContent: title,
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

  it("lists chat history with cursor pagination without navigating the active chat", async () => {
    const sim = setup({
      path: "/",
      chatLinks: [
        chatLink("chat-history-001", "History One"),
        chatLink("chat-history-002", "History Two"),
        chatLink("chat-history-003", "History Three"),
      ],
    });
    const first = await sim.call("delegate.list_chats", { cursor: 0, limit: 2 });
    expect(first.ok).toBe(true);
    expect(first.result.chats.map((chat: any) => chat.title)).toEqual(["History One", "History Two"]);
    expect(first.result.next_cursor).toBe(2);
    expect(first.result.complete).toBe(true);
    expect(sim.location.pathname).toBe("/");

    const second = await sim.call("delegate.list_chats", { cursor: 2, limit: 2 });
    expect(second.ok).toBe(true);
    expect(second.result.chats.map((chat: any) => chat.chat_id)).toEqual(["chat-history-003"]);
    expect(second.result.next_cursor).toBeNull();
  });

  it("reads a historical conversation fully and paginates messages", async () => {
    const sim = setup({
      path: "/c/chat-history-001",
      hash: "#delegate-history-worker",
      modernTurns: [
        modernTurn("user", "first question", undefined, 0),
        modernTurn("assistant", "first answer", undefined, 0),
      ],
    });
    const first = await sim.call("delegate.read_chat_full", { cursor: 0, limit: 1 });
    expect(first.ok).toBe(true);
    expect(first.result.chat_id).toBe("chat-history-001");
    expect(first.result.total_message_count).toBe(2);
    expect(first.result.loaded_complete).toBe(true);
    expect(first.result.messages).toEqual([
      { index: 0, role: "user", text: "first question", text_truncated: false },
    ]);
    expect(first.result.next_cursor).toBe(1);

    const second = await sim.call("delegate.read_chat_full", { cursor: 1, limit: 80 });
    expect(second.ok).toBe(true);
    expect(second.result.messages[0]).toMatchObject({ role: "assistant", text: "first answer" });
    expect(second.result.next_cursor).toBeNull();
  });

  it("opens a history chat through one sidebar SPA click instead of a page reload", async () => {
    const modernTurns = [
      modernTurn("user", "loaded through sidebar"),
      modernTurn("assistant", "sidebar loaded reply"),
    ];
    let sim: ReturnType<typeof setup>;
    sim = setup({
      path: "/",
      hash: "#delegate-history-worker",
      modernTurns,
      chatLinks: [chatLink("chat-history-004", "History Four", () => {
        sim.location.pathname = "/c/chat-history-004";
        sim.location.href = "https://chatgpt.com/c/chat-history-004";
      })],
    });
    const result = await sim.call("delegate.open_history_chat", { chatId: "chat-history-004" });
    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({ chat_id: "chat-history-004", already_open: false });
    expect(sim.location.pathname).toBe("/c/chat-history-004");
  });

  it("reports ChatGPT's own unavailable-history state explicitly", async () => {
    const sim = setup({
      path: "/c/chat-history-005",
      hash: "#delegate-history-worker",
      modernTurns: [],
      bodyText: "Could not load this ChatGPT conversation Try again",
    });
    const result = await sim.call("delegate.read_chat_full", { cursor: 0, limit: 20 });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CHATGPT_HISTORY_UNAVAILABLE");
  });

  it("finds matching message snippets inside a historical conversation", async () => {
    const sim = setup({
      path: "/c/chat-history-002",
      hash: "#delegate-history-worker",
      modernTurns: [
        modernTurn("user", "question about delegate history"),
        modernTurn("assistant", "The unique history needle appears here."),
      ],
    });
    const result = await sim.call("delegate.search_current_chat", {
      query: "unique history needle", maxMatches: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.result.matched).toBe(true);
    expect(result.result.snippets).toHaveLength(1);
    expect(result.result.snippets[0]).toMatchObject({ role: "assistant" });
    expect(result.result.snippets[0].snippet).toContain("unique history needle");
  });

  it("keeps history worker strictly read-only even when a delivery-timeout banner appears", async () => {
    let retries = 0;
    let sends = 0;
    const sim = setup({
      path: "/",
      hash: "#delegate-history-worker",
      composer: new FakeTextarea(),
      bodyText: "Message delivery timed out. Please try again.",
      buttons: [
        retryButton(() => retries++),
        modernButton("Send", () => sends++),
      ],
    });
    await sim.mutate("Message delivery timed out. Please try again.");
    expect(sends).toBe(0);
    expect(retries).toBe(0);
  });

  it("detects the visible ChatGPT delivery-timeout banner without clicking Retry", async () => {
    let retries = 0;
    const sim = setup({
      composer: null,
      bodyText: "Message delivery timed out. Please try again.",
      buttons: [retryButton(() => retries++)],
    });
    const result = await sim.call("delegate.read_chat");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("delivery_timeout");
    expect(result.result.delivery_error).toBe(true);
    expect(result.result.retry_available).toBe(true);
    expect(result.result.error_message).toBe("Message delivery timed out. Please try again.");
    expect(result.result.timeout_recovery_message).toBe("continue until done");
    expect(retries).toBe(0);
    expect(sim.inspect().reason).toBe("delivery_timeout");
  });

  it("auto-recovers a delivery timeout once with continue until done and never clicks Retry", async () => {
    let retries = 0;
    let sends = 0;
    const turns: FakeTurn[] = [turn("user", "original task")];
    const composer = new FakeTextarea();
    const sim = setup({
      turns,
      composer,
      buttons: [
        retryButton(() => retries++),
        modernButton("Send", () => {
          sends++;
          const sent = composer.value;
          composer.value = "";
          turns.push(turn("user", sent));
        }),
      ],
    });
    await sim.mutate("Message delivery timed out. Please try again.");
    expect(sends).toBe(1);
    expect(retries).toBe(0);
    expect(turns.at(-1)?.textContent).toBe("continue until done");

    // The same still-visible timeout episode must never cause a second continuation.
    await sim.mutate("Message delivery timed out. Please try again.");
    expect(sends).toBe(1);
    expect(retries).toBe(0);
  });

  it("preserves a user draft instead of auto-recovering a delivery timeout", async () => {
    let retries = 0;
    let sends = 0;
    const composer = new FakeTextarea("my unfinished draft");
    const sim = setup({
      composer,
      buttons: [
        retryButton(() => retries++),
        modernButton("Send", () => sends++),
      ],
    });
    await sim.mutate("Message delivery timed out. Please try again.");
    expect(composer.value).toBe("my unfinished draft");
    expect(sends).toBe(0);
    expect(retries).toBe(0);
  });

  it("reads current ChatGPT fallback turn markers and strips UI role prefixes", async () => {
    const sim = setup({
      modernTurns: [
        modernTurn("user", "hello modern"),
        modernTurn("assistant", "modern reply"),
      ],
    });
    const result = await sim.call("delegate.read_chat");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("finished");
    expect(result.result.messages.map((message: any) => [message.role, message.text])).toEqual([
      ["user", "hello modern"],
      ["assistant", "modern reply"],
    ]);
    expect(result.result.latest_response_text).toBe("modern reply");
  });

  it("reports a cancelled current turn as stopped instead of working forever", async () => {
    const sim = setup({
      modernTurns: [modernTurn("user", "cancel me", "cancelled")],
    });
    const result = await sim.call("delegate.read_chat");
    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("stopped");
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

  it("supports the current bare Send aria-label", async () => {
    let clicks = 0;
    const turns: FakeTurn[] = [];
    const sim = setup({
      turns,
      buttons: [modernButton("Send", () => {
        clicks++;
        turns.push(turn("user", "modern send"));
      })],
    });
    const result = await sim.call("delegate.send_message", { message: "modern send" });
    expect(result.ok).toBe(true);
    expect(result.result.delivery).toBe("sent");
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

  it("supports the current bare Stop aria-label", async () => {
    let stops = 0;
    const sim = setup({ buttons: [modernButton("Stop", () => stops++)] });
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
