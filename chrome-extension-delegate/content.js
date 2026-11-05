/* Runs only on https://chatgpt.com/*. All operations use DOM, no page APIs. */
(() => {
  "use strict";
  const SCOPE = "superagent-delegate-v1";
  // The manually repaired tab and automatic content-script registration must
  // never install duplicate listeners in the same isolated JS world.
  if (globalThis.__superagentDelegateContentActive) return;
  globalThis.__superagentDelegateContentActive = true;
  const completed = new Map();
  const inFlight = new Set();
  let sendActive = false;
  let newChatActive = false;

  const fail = (code, message) => { throw { code, message }; };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const norm = (text) => String(text || "").replace(/\s+/g, " ").trim();

  const roleOfTurn = (node) => {
    const legacy = node.getAttribute("data-message-author-role");
    if (legacy) return legacy;
    const key = node.getAttribute("data-chatgpt-search-unit-key") || "";
    if (key.endsWith(":user")) return "user";
    if (key.endsWith(":assistant")) return "assistant";
    return "unknown";
  };

  const turns = () => {
    const legacy = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const modern = Array.from(document.querySelectorAll(
      '[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]'
    ));
    return [...new Set([...legacy, ...modern])].filter(visible);
  };

  const composer = () =>
    Array.from(document.querySelectorAll(
      '[data-composer-markdown][contenteditable="true"], [role="textbox"][contenteditable="true"][aria-label="Ask ChatGPT"], #prompt-textarea[contenteditable="true"], [data-testid="composer"] [contenteditable="true"], textarea#prompt-textarea, textarea[data-testid="prompt-textarea"]'
    )).find(visible);

  const label = (el) => [
    el.getAttribute("aria-label"),
    el.getAttribute("title"),
    el.getAttribute("data-testid"),
    el.textContent,
  ].filter(Boolean).join(" ").toLowerCase();

  const buttons = () => Array.from(document.querySelectorAll("button")).filter(visible);
  const stopButton = () => buttons().find((b) =>
    b.matches('[data-testid="stop-button"], [aria-label="Stop"], [aria-label="Stop generating"], [aria-label="Stop generation"]') ||
    /^(stop|stop generating|stop generation|stop response)$/.test(norm(b.getAttribute("aria-label") || "").toLowerCase())
  );
  const sendButton = () => buttons().find((b) =>
    b.matches('[data-testid="send-button"], [aria-label="Send"], [aria-label="Send prompt"], [aria-label="Send message"]') ||
    /^send(?: prompt| message)?$/.test(norm(b.getAttribute("aria-label") || "").toLowerCase())
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
    const allTurns = turns();
    const totalCount = allTurns.length;
    const limitedTurns = allTurns.slice(-80);
    const messages = limitedTurns.map((node, index) => {
      const role = roleOfTurn(node);
      const body = node.querySelector(".markdown, [data-message-content], [data-testid='conversation-turn-content']")
        || node;
      let fullText = norm(body.innerText || body.textContent);
      const modernKey = node.getAttribute("data-chatgpt-search-unit-key") || "";
      if (modernKey.endsWith(":assistant")) {
        fullText = fullText.replace(/^chatgpt said:\s*/i, "");
      } else if (modernKey.endsWith(":user")) {
        fullText = fullText.replace(/^you said:\s*/i, "");
      }
      return {
        index: totalCount - limitedTurns.length + index,
        role,
        text: fullText.slice(0, 6000),
        text_truncated: fullText.length > 6000,
      };
    });
    const last = messages.at(-1);
    const lastNode = limitedTurns.at(-1);
    const lastState = typeof lastNode?.closest === "function"
      ? lastNode.closest("[data-talvt-turn-state]")?.getAttribute("data-talvt-turn-state") || ""
      : "";
    const running = !!stopButton();
    const ready = !!composer();
    let status = running ? "working" :
      !ready ? "unavailable" :
      lastState === "cancelled" ? "stopped" :
      !last && location.pathname.startsWith("/c/") ? "unverified" :
      !last ? "waiting_for_input" : last.role === "user" ? "working" : "finished";
    const latest = [...messages].reverse().find((m) => m.role === "assistant");
    return {
      url: location.href,
      status,
      ready,
      total_message_count: totalCount,
      truncated: totalCount > limitedTurns.length || messages.some((m) => m.text_truncated),
      messages,
      latest_response_text: latest?.text || "",
    };
  }

  // Read-only safety verdict for automatic single-tab consolidation.
  // Do not return actual draft text, message content, or page cookies.
  function inspectTabSafety() {
    if (sendActive || newChatActive || inFlight.size) {
      return { ready: true, safeToClose: false, reason: "delegate_busy" };
    }
    if (stopButton()) {
      return { ready: true, safeToClose: false, reason: "generating" };
    }
    const input = composer();
    if (!input || loginRequired()) {
      return { ready: false, safeToClose: false, reason: "page_not_ready" };
    }
    if (norm(input.innerText || input.value || input.textContent)) {
      return { ready: true, safeToClose: false, reason: "draft_present" };
    }
    if (Array.from(document.querySelectorAll(
      '[data-testid="attachment-preview"], [data-testid="composer-attachment"], [data-testid="attachment-uploading"]'
    )).some(visible)) {
      return { ready: true, safeToClose: false, reason: "attachment_pending" };
    }
    if (Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).some(visible)) {
      return { ready: true, safeToClose: false, reason: "dialog_open" };
    }
    if (location.pathname.startsWith("/c/") && !turns().length) {
      return { ready: false, safeToClose: false, reason: "chat_not_loaded" };
    }
    return { ready: true, safeToClose: true, reason: "verified_idle" };
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
    const previousUserTurns = turns().filter((node) => roleOfTurn(node) === "user").length;
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
        () => turns().filter((node) => roleOfTurn(node) === "user").length > previousUserTurns,
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
    // Do not click "New chat" while the previous chat has not yet loaded:
    // missing composer could conceal an existing draft or busy generation.
    const input = await waitFor(composer, 6000,
      "ChatGPT composer is not ready. No new-chat action was attempted.");
    const draft = norm(input.innerText || input.value || input.textContent);
    // Navigating to a blank chat must not discard a user's unsent draft.
    if (draft) fail("CHATGPT_DRAFT_PRESENT",
      "ChatGPT has an unsent draft; new chat was not clicked.");
    // The ChatGPT homepage IS an unsent, fresh conversation. Clicking
    // New chat here does not necessarily change the URL or DOM; treating
    // that as a timeout used to report false failures.
    if (location.pathname === "/" && turns().length === 0 && !stopButton()) {
      return { created: false, already_new_chat: true, ready: true, ...readChat() };
    }
    if (stopButton()) fail("CHATGPT_BUSY", "ChatGPT is generating; new chat was not clicked.");
    const candidates = Array.from(document.querySelectorAll("a, button")).filter(visible);
    const newChat = candidates.find((node) =>
      node.matches('[data-testid="create-new-chat-button"], [data-testid="new-chat-button"]') ||
      /^(new chat|new conversation)$/i.test(norm(node.getAttribute("aria-label") || node.textContent))
    );
    if (!newChat) fail("DELEGATE_NEW_CHAT_UNAVAILABLE", "ChatGPT New chat control not found. No navigation/reload fallback is attempted.");
    newChat.click();
    await waitFor(
      () => composer() && location.pathname === "/" &&
        turns().length === 0 && !stopButton(),
      8000,
      "New chat state not confirmed after a single click; inspect chat before retrying"
    );
    return { created: true, already_new_chat: false, ready: true, ...readChat() };
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
    if (request.action === "inspect_tab") {
      sendResponse(inspectTabSafety());
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
