/* Runs only on https://chatgpt.com/*. All operations use DOM, no page APIs. */
(() => {
  "use strict";
  const SCOPE = "superagent-delegate-v1";
  const completed = new Map();
  const inFlight = new Set();
  let sendActive = false;
  let newChatActive = false;

  const fail = (code, message) => { throw { code, message }; };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();

  const turns = () =>
    Array.from(document.querySelectorAll("[data-message-author-role]"))
      .filter(visible);

  const composer = () =>
    Array.from(document.querySelectorAll(
      '#prompt-textarea[contenteditable="true"], [data-testid="composer"] [contenteditable="true"], textarea#prompt-textarea, textarea[data-testid="prompt-textarea"]'
    )).find(visible);

  const label = (el) => [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-testid"),
    el.textContent,
  ].filter(Boolean).join(" ").toLowerCase();

  const buttons = () => Array.from(document.querySelectorAll("button")).filter(visible);
  const stopButton = () => buttons().find((b) =>
    b.matches('[data-testid="stop-button"], [aria-label="Stop generating"], [aria-label="Stop generation"]') ||
    /^(stop generating|stop generation|stop response)$/.test(norm(b.getAttribute("aria-label") || "").toLowerCase())
  );
  const sendButton = () => buttons().find((b) =>
    b.matches('[data-testid="send-button"], [aria-label="Send prompt"], [aria-label="Send message"]') ||
    /^send (prompt|message)$/.test(norm(b.getAttribute("aria-label") || "").toLowerCase())
  );

  function loginRequired() {
    if (/^\/(auth\/login|login|auth\/signin)(?:\/|$)/.test(location.pathname)) return true;
    if (composer()) return false;
    const authAction = Array.from(document.querySelectorAll("a, button")).filter(visible).some((el) =>
      /^(log in|login|sign in)$/i.test(norm(el.textContent || el.getAttribute("aria-label")))
    );
    return authAction;
  }

  function assertLogin() {
    if (loginRequired()) fail("CHATGPT_LOGIN_REQUIRED", "Sign in to chatgpt.com in this Chrome profile.");
  }

  function waitFor(predicate, ms, reason) {
    return new Promise((resolve, reject) => {
      let complete = false;
      let observer;
      let timer;
      const finish = (value, error) => {
        if (complete) return;
        complete = true;
        observer?.disconnect();
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const inspect = () => {
        try {
          assertLogin();
          const result = predicate();
          if (result) finish(result);
        } catch (err) {
          finish(undefined, err);
        }
      };
      observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(() => finish(undefined, { code: "DELEGATE_DOM_TIMEOUT", message: reason }), ms);
      inspect();
    });
  }

  function readChat() {
    assertLogin();
    const messages = turns().map((node, index) => {
      const role = node.getAttribute("data-message-author-role") || "unknown";
      const body = node.querySelector(".markdown, [data-message-content], [data-testid='conversation-turn-content']")
        || node;
      return { index, role, text: norm(body.innerText || body.textContent) };
    });
    const last = messages.at(-1);
    const running = !!stopButton();
    let status = running ? "working" :
      !last ? "waiting_for_input" : last.role === "user" ? "working" : "finished";
    const latest = [...messages].reverse().find((m) => m.role === "assistant");
    return {
      url: location.href,
      status,
      messages,
      latest_response_text: latest?.text || "",
    };
  }

  function writeComposer(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) fail("DELEGATE_COMPOSER_ERROR", "Textarea setter unavailable");
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.getAttribute("contenteditable") !== "true") {
      fail("DELEGATE_COMPOSER_ERROR", "ChatGPT composer is not editable");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    // execCommand insertText triggers the browser's native beforeinput/input
    // lifecycle used by controlled contenteditable composers.
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      // No submit after a failed editor update.
      fail("DELEGATE_COMPOSER_ERROR", "Cannot insert text into ChatGPT editor");
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  async function sendMessage(params) {
    const message = params?.message;
    if (typeof message !== "string" || !message.trim() || message.length > 100_000) {
      fail("DELEGATE_INVALID_MESSAGE", "message must be nonempty text (max 100000 characters)");
    }
    assertLogin();
    const input = await waitFor(composer, 5000, "ChatGPT composer did not appear; no message was sent");
    if (stopButton()) fail("CHATGPT_BUSY", "Generation in progress. Read chat; no message was sent.");
    if (norm(input.innerText || input.value || input.textContent)) {
      fail("CHATGPT_DRAFT_PRESENT", "An unsent draft is already in the composer; it was preserved. No message was sent.");
    }
    const previousUserTurns = turns().filter((node) => node.getAttribute("data-message-author-role") === "user").length;
    writeComposer(input, message);
    // Confirm text is present before attempting to click Send.
    const entered = norm(input.innerText || input.value || input.textContent);
    if (entered !== norm(message)) fail("DELEGATE_COMPOSER_MISMATCH", "Editor text verification failed; no message was sent");
    const submit = await waitFor(() => {
      const b = sendButton();
      return b && !b.disabled ? b : null;
    }, 4000, "ChatGPT Send button not available; no message was sent");
    submit.click(); // exactly one click, never Enter + click
    try {
      await waitFor(
        () => turns().filter((node) => node.getAttribute("data-message-author-role") === "user").length > previousUserTurns,
        14_000,
        "Send was clicked but chat acknowledgement did not appear. Outcome uncertain; inspect via delegate.read_chat. Do not automatically resend."
      );
      return { delivery: "sent", ...readChat() };
    } catch (error) {
      // Do not retry. The UI could still have accepted the send.
      if (error?.code === "DELEGATE_DOM_TIMEOUT") {
        return { delivery: "unknown_after_click", note: error.message, ...readChat() };
      }
      throw error;
    }
  }

  async function createChat() {
    assertLogin();
    const before = location.href;
    const candidates = Array.from(document.querySelectorAll("a, button")).filter(visible);
    const newChat = candidates.find((node) =>
      node.matches('[data-testid="create-new-chat-button"], [data-testid="new-chat-button"]') ||
      /^(new chat|new conversation)$/i.test(norm(node.getAttribute("aria-label") || node.textContent))
    );
    if (!newChat) fail("DELEGATE_NEW_CHAT_UNAVAILABLE", "ChatGPT New chat control not found. No navigation/reload fallback is attempted.");
    newChat.click();
    await waitFor(
      () => composer() && (location.href !== before || turns().length === 0),
      8000,
      "New chat state not confirmed after a single click; inspect chat before retrying"
    );
    return { created: true, ...readChat() };
  }

  async function stopGeneration() {
    assertLogin();
    const stop = stopButton();
    if (!stop) fail("CHATGPT_NOT_GENERATING", "No Stop generation control is visible; nothing was clicked.");
    stop.click();
    return { stop_requested: true, ...readChat() };
  }

  async function dispatch(method, params) {
    switch (method) {
      case "delegate.create_chat":
        if (sendActive || newChatActive) fail("CHATGPT_BUSY", "A ChatGPT mutation is already active; new chat was not started.");
        newChatActive = true;
        try { return await createChat(); } finally { newChatActive = false; }
      case "delegate.read_chat": return readChat();
      case "delegate.send_message":
        if (sendActive || newChatActive) fail("DELEGATE_SEND_IN_FLIGHT", "Another send or new-chat operation is in progress; this request was not submitted.");
        sendActive = true;
        try { return await sendMessage(params); } finally { sendActive = false; }
      case "delegate.stop_generation": return stopGeneration();
      default: fail("DELEGATE_UNKNOWN_METHOD", "Unsupported method");
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || request?.scope !== SCOPE) return false;
    if (request.action === "probe") {
      sendResponse({ ready: true });
      return false;
    }
    if (request.action !== "execute" || typeof request.id !== "string") return false;
    if (completed.has(request.id)) {
      sendResponse(completed.get(request.id));
      return false;
    }
    if (inFlight.has(request.id)) {
      sendResponse({ ok: false, error: { code: "DELEGATE_DUPLICATE_IN_FLIGHT", message: "Request already executing. No second action taken." } });
      return false;
    }
    inFlight.add(request.id);
    Promise.resolve().then(() => dispatch(request.method, request.params || {}))
      .then((result) => ({ ok: true, result }))
      .catch((reason) => ({ ok: false, error: {
        code: String(reason?.code || "DELEGATE_DOM_ERROR"),
        message: String(reason?.message || reason || "Unknown DOM error"),
      } }))
      .then((response) => {
        inFlight.delete(request.id);
        completed.set(request.id, response);
        if (completed.size > 128) completed.delete(completed.keys().next().value);
        sendResponse(response);
      });
    return true;
  });
})();


