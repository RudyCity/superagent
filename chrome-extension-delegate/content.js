/* Runs only on https://chatgpt.com/*. All operations use DOM, no page APIs. */
(() => {
  "use strict";
  const SCOPE = "superagent-delegate-v1";
  const DELIVERY_TIMEOUT_MESSAGE = "Message delivery timed out. Please try again.";
  const DELIVERY_TIMEOUT_RECOVERY_MESSAGE = "continue until done";
  const HISTORY_WORKER = /(?:^|[?&])delegate-history-worker=1(?:&|$)/.test(location.search || "") ||
    (location.hash || "") === "#delegate-history-worker";
  // The manually repaired tab and automatic content-script registration must
  // never install duplicate listeners in the same isolated JS world.
  if (globalThis.__superagentDelegateContentActive) return;
  globalThis.__superagentDelegateContentActive = true;
  const completed = new Map();
  const inFlight = new Set();
  let sendActive = false;
  let newChatActive = false;
  let timeoutRecoveryLocked = false;
  let timeoutRecoveryRunning = false;
  let timeoutRecoveryTimer;

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
  const retryButton = () => buttons().find((b) =>
    /^retry$/.test(norm(b.getAttribute("aria-label") || b.textContent).toLowerCase())
  );

  function deliveryTimeoutState() {
    const pageText = norm(document.body?.innerText || document.documentElement?.innerText || "");
    if (!/message delivery timed out\.?\s*please try again\.?/i.test(pageText)) return null;
    const retry = retryButton();
    if (!retry) return null;
    return {
      error_message: DELIVERY_TIMEOUT_MESSAGE,
      retry_available: true,
    };
  }

  function historyUnavailable() {
    const pageText = norm(document.body?.innerText || document.documentElement?.innerText || "");
    return /could not load this chatgpt conversation/i.test(pageText);
  }

  function assertHistoryAvailable() {
    if (historyUnavailable()) {
      fail("CHATGPT_HISTORY_UNAVAILABLE",
        "ChatGPT reported 'Could not load this ChatGPT conversation'. The history entry was not readable in this browser profile.");
    }
  }

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

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function messageFromNode(node, index = 0, textLimit = 12_000) {
    const role = roleOfTurn(node);
    const body = node.querySelector?.(".markdown, [data-message-content], [data-testid='conversation-turn-content']")
      || node;
    let fullText = norm(body.innerText || body.textContent);
    const modernKey = node.getAttribute("data-chatgpt-search-unit-key") || "";
    if (modernKey.endsWith(":assistant")) {
      fullText = fullText.replace(/^chatgpt said:\s*/i, "");
    } else if (modernKey.endsWith(":user")) {
      fullText = fullText.replace(/^you said:\s*/i, "");
    }
    return {
      index,
      role,
      text: fullText.slice(0, textLimit),
      text_truncated: fullText.length > textLimit,
      key: modernKey || undefined,
    };
  }

  function stableTurnKey(node, fallbackIndex) {
    const modernKey = node.getAttribute("data-chatgpt-search-unit-key");
    if (modernKey) return "modern:" + modernKey;
    const messageId = node.getAttribute("data-message-id");
    if (messageId) return "message:" + messageId;
    const turnKey = typeof node.closest === "function"
      ? node.closest("[data-turn-key]")?.getAttribute("data-turn-key") : "";
    if (turnKey) return "turn:" + turnKey + ":" + roleOfTurn(node);
    return "fallback:" + fallbackIndex + ":" + roleOfTurn(node) + ":" +
      norm(node.innerText || node.textContent).slice(0, 160);
  }

  function modernTurnOrder(node) {
    const key = node.getAttribute("data-chatgpt-search-unit-key") || "";
    const match = key.match(/turn-(\d+):(\d+):(user|assistant)$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2])];
  }

  function scrollableAncestor(node) {
    let current = node?.parentElement;
    while (current && current !== document.body) {
      const style = getComputedStyle(current);
      if (/(auto|scroll)/.test(style.overflowY || "") &&
          current.scrollHeight > current.clientHeight + 4) return current;
      current = current.parentElement;
    }
    return null;
  }

  function conversationScroller() {
    const first = turns()[0];
    const fromTurn = scrollableAncestor(first);
    if (fromTurn) return fromTurn;
    const candidates = Array.from(document.querySelectorAll("main, [role='main'], div"))
      .filter((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY || "") &&
          node.scrollHeight > node.clientHeight + 4 &&
          (!first || node.contains(first));
      });
    return candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
  }

  async function collectConversationMessages(maxMessages = 5000) {
    assertLogin();
    if (location.pathname.startsWith("/c/")) {
      await waitFor(() => {
        assertHistoryAvailable();
        return turns().length > 0 ? true : null;
      }, 15_000, "Chat history conversation did not load.");
    }

    const seen = new Map();
    let discovery = 0;
    const collect = (scrollTop = 0) => {
      const currentTurns = turns();
      currentTurns.forEach((node, domIndex) => {
        const key = stableTurnKey(node, discovery);
        const order = modernTurnOrder(node);
        const candidate = {
          ...messageFromNode(node, 0),
          _scrollTop: scrollTop,
          _domIndex: domIndex,
          _discovery: discovery++,
          _order: order,
        };
        const existing = seen.get(key);
        if (!existing || candidate.text.length > existing.text.length) seen.set(key, candidate);
      });
    };

    const scroller = conversationScroller();
    let complete = true;
    let steps = 0;
    if (!scroller) {
      collect(0);
    } else {
      const originalTop = scroller.scrollTop;
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      await sleep(100);
      let stableTopRounds = 0;
      let previousCount = -1;
      let previousHeight = -1;

      while (steps++ < 240 && seen.size < maxMessages) {
        collect(scroller.scrollTop);
        const atTop = scroller.scrollTop <= 2;
        if (atTop) {
          await sleep(120);
          collect(scroller.scrollTop);
          const same = previousCount === seen.size && previousHeight === scroller.scrollHeight;
          stableTopRounds = same ? stableTopRounds + 1 : 0;
          previousCount = seen.size;
          previousHeight = scroller.scrollHeight;
          if (stableTopRounds >= 3) break;
        }

        const step = Math.max(240, Math.floor(scroller.clientHeight * 0.75));
        const next = Math.max(0, scroller.scrollTop - step);
        scroller.scrollTop = next === scroller.scrollTop && !atTop ? 0 : next;
        await sleep(85);
      }
      complete = steps < 240 && seen.size < maxMessages;
      scroller.scrollTop = originalTop;
    }

    const messages = [...seen.values()];
    messages.sort((a, b) => {
      if (a._order && b._order) {
        return (a._order[0] - b._order[0]) || (a._order[1] - b._order[1]);
      }
      if (a._order && !b._order) return -1;
      if (!a._order && b._order) return 1;
      return (a._scrollTop - b._scrollTop) ||
        (a._domIndex - b._domIndex) || (a._discovery - b._discovery);
    });
    return {
      complete,
      scan_steps: steps,
      messages: messages.slice(0, maxMessages).map((message, index) => ({
        index,
        role: message.role,
        text: message.text,
        text_truncated: message.text_truncated,
      })),
    };
  }

  async function readChatFull(params) {
    const cursor = Number(params?.cursor ?? 0);
    const limit = Number(params?.limit ?? 40);
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      fail("DELEGATE_INVALID_CURSOR", "cursor must be a non-negative integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80) {
      fail("DELEGATE_INVALID_LIMIT", "limit must be an integer from 1 to 80");
    }
    const collected = await collectConversationMessages(5000);
    const page = collected.messages.slice(cursor, cursor + limit);
    const next = cursor + page.length;
    const hasMore = next < collected.messages.length || !collected.complete;
    return {
      url: location.href,
      chat_id: decodeURIComponent(location.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || ""),
      title: norm(document.title || ""),
      cursor,
      limit,
      total_message_count: collected.messages.length,
      loaded_complete: collected.complete,
      scan_steps: collected.scan_steps,
      messages: page,
      next_cursor: hasMore ? next : null,
    };
  }

  function chatAnchors() {
    return Array.from(document.querySelectorAll('a[href^="/c/"], a[href^="https://chatgpt.com/c/"]'));
  }

  function chatRecord(anchor) {
    const raw = anchor.getAttribute("href") || "";
    const path = raw.replace(/^https:\/\/chatgpt\.com/i, "");
    const match = path.match(/^\/c\/([^/?#]+)/);
    if (!match) return null;
    let chatId;
    try { chatId = decodeURIComponent(match[1]); } catch { return null; }
    if (!chatId || chatId.length > 180 || !/^[a-zA-Z0-9:_-]+$/.test(chatId)) return null;
    const title = norm(anchor.getAttribute("aria-label") || anchor.textContent || "Untitled chat");
    return {
      chat_id: chatId,
      title: title || "Untitled chat",
      url: "https://chatgpt.com/c/" + encodeURIComponent(chatId),
    };
  }

  function historyScroller() {
    const first = chatAnchors()[0];
    const fromAnchor = scrollableAncestor(first);
    if (fromAnchor) return fromAnchor;
    const nav = document.querySelector?.('nav[aria-label="Chat history"]');
    if (!nav) return null;
    return Array.from(nav.querySelectorAll("*"))
      .filter((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/.test(style.overflowY || "") &&
          node.scrollHeight > node.clientHeight + 4;
      })
      .sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
  }

  async function findHistoryAnchor(chatId) {
    const find = () => chatAnchors().find((anchor) => chatRecord(anchor)?.chat_id === chatId) || null;
    let anchor = find();
    if (anchor) return anchor;

    const scroller = historyScroller();
    if (!scroller) return null;
    const originalTop = scroller.scrollTop;
    scroller.scrollTop = 0;
    await sleep(80);
    let stableBottomRounds = 0;
    let previousHeight = -1;

    for (let stepIndex = 0; stepIndex < 500; stepIndex++) {
      anchor = find();
      if (anchor) return anchor;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      if (atBottom) {
        await sleep(130);
        anchor = find();
        if (anchor) return anchor;
        stableBottomRounds = previousHeight === scroller.scrollHeight ? stableBottomRounds + 1 : 0;
        previousHeight = scroller.scrollHeight;
        if (stableBottomRounds >= 3) break;
      }
      const step = Math.max(260, Math.floor(scroller.clientHeight * 0.8));
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + step);
      await sleep(85);
    }
    scroller.scrollTop = originalTop;
    return null;
  }

  async function openHistoryChat(params) {
    assertLogin();
    const chatId = typeof params?.chatId === "string" ? params.chatId : "";
    if (!/^[a-zA-Z0-9:_-]{8,180}$/.test(chatId)) {
      fail("DELEGATE_INVALID_CHAT_ID", "chatId must be a valid ChatGPT conversation ID");
    }
    const currentId = (() => {
      try { return decodeURIComponent(location.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || ""); }
      catch { return ""; }
    })();
    if (currentId === chatId && turns().length > 0) {
      return { chat_id: chatId, title: norm(document.title || ""), url: location.href, already_open: true };
    }

    const anchor = await findHistoryAnchor(chatId);
    if (!anchor) {
      fail("CHATGPT_HISTORY_CHAT_NOT_FOUND",
        "The requested chatId was not found in the loaded ChatGPT history sidebar.");
    }
    anchor.click();
    // Give ChatGPT SPA navigation a brief chance to clear the previous route's
    // error/placeholder DOM before judging the newly selected conversation.
    await sleep(250);
    await waitFor(() => {
      let loadedId = "";
      try { loadedId = decodeURIComponent(location.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || ""); } catch {}
      if (loadedId === chatId && turns().length > 0) return true;
      if (loadedId === chatId) assertHistoryAvailable();
      return null;
    }, 20_000, "ChatGPT did not load the selected historical conversation after one sidebar click.");
    return { chat_id: chatId, title: norm(document.title || ""), url: location.href, already_open: false };
  }

  async function listChats(params) {
    assertLogin();
    const cursor = Number(params?.cursor ?? 0);
    const limit = Number(params?.limit ?? 50);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 5000) {
      fail("DELEGATE_INVALID_CURSOR", "cursor must be an integer from 0 to 5000");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      fail("DELEGATE_INVALID_LIMIT", "limit must be an integer from 1 to 200");
    }

    const targetCount = Math.min(5001, cursor + limit + 1);
    const seen = new Map();
    const collect = () => {
      for (const anchor of chatAnchors()) {
        const record = chatRecord(anchor);
        if (record && !seen.has(record.chat_id)) seen.set(record.chat_id, record);
      }
    };

    const scroller = historyScroller();
    let complete = true;
    let scanSteps = 0;
    if (!scroller) {
      collect();
    } else {
      const originalTop = scroller.scrollTop;
      scroller.scrollTop = 0;
      await sleep(80);
      let stableBottomRounds = 0;
      let previousCount = -1;
      let previousHeight = -1;

      while (scanSteps++ < 500 && seen.size < targetCount) {
        collect();
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
        if (atBottom) {
          await sleep(130);
          collect();
          const same = previousCount === seen.size && previousHeight === scroller.scrollHeight;
          stableBottomRounds = same ? stableBottomRounds + 1 : 0;
          previousCount = seen.size;
          previousHeight = scroller.scrollHeight;
          if (stableBottomRounds >= 3) break;
        }
        const step = Math.max(260, Math.floor(scroller.clientHeight * 0.8));
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const next = Math.min(maxTop, scroller.scrollTop + step);
        scroller.scrollTop = next === scroller.scrollTop && !atBottom ? maxTop : next;
        await sleep(85);
      }
      complete = scanSteps < 500 && seen.size < targetCount;
      scroller.scrollTop = originalTop;
    }

    const all = [...seen.values()];
    const chats = all.slice(cursor, cursor + limit).map((chat, index) => ({
      index: cursor + index,
      ...chat,
    }));
    const nextOffset = cursor + chats.length;
    const hasMore = nextOffset < all.length || !complete;
    return {
      cursor,
      limit,
      chats,
      returned: chats.length,
      scanned_unique: all.length,
      scan_steps: scanSteps,
      complete,
      next_cursor: hasMore ? nextOffset : null,
    };
  }

  async function searchCurrentChat(params) {
    const query = norm(params?.query);
    const maxMatches = Number(params?.maxMatches ?? 3);
    if (!query || query.length > 500) {
      fail("DELEGATE_INVALID_QUERY", "query must be 1 to 500 characters");
    }
    if (!Number.isSafeInteger(maxMatches) || maxMatches < 1 || maxMatches > 10) {
      fail("DELEGATE_INVALID_LIMIT", "maxMatches must be an integer from 1 to 10");
    }
    const collected = await collectConversationMessages(5000);
    const needle = query.toLowerCase();
    const snippets = [];
    for (const message of collected.messages) {
      const lower = message.text.toLowerCase();
      const position = lower.indexOf(needle);
      if (position < 0) continue;
      const start = Math.max(0, position - 180);
      const end = Math.min(message.text.length, position + query.length + 220);
      snippets.push({
        message_index: message.index,
        role: message.role,
        snippet: message.text.slice(start, end),
      });
      if (snippets.length >= maxMatches) break;
    }
    const title = norm(document.title || "");
    return {
      title,
      matched: title.toLowerCase().includes(needle) || snippets.length > 0,
      title_match: title.toLowerCase().includes(needle),
      snippets,
      loaded_complete: collected.complete,
      total_message_count: collected.messages.length,
    };
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
    const deliveryTimeout = deliveryTimeoutState();
    const running = !!stopButton();
    const ready = !!composer();
    let status = running ? "working" :
      deliveryTimeout ? "delivery_timeout" :
      !ready ? "unavailable" :
      lastState === "cancelled" ? "stopped" :
      !last && location.pathname.startsWith("/c/") ? "unverified" :
      !last ? "waiting_for_input" : last.role === "user" ? "working" : "finished";
    const latest = [...messages].reverse().find((m) => m.role === "assistant");
    return {
      url: location.href,
      status,
      ready,
      delivery_error: !!deliveryTimeout,
      retry_available: deliveryTimeout?.retry_available || false,
      error_message: deliveryTimeout?.error_message || "",
      timeout_recovery_message: deliveryTimeout ? DELIVERY_TIMEOUT_RECOVERY_MESSAGE : "",
      timeout_recovery_active: !!deliveryTimeout && (timeoutRecoveryLocked || timeoutRecoveryRunning),
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
    if (deliveryTimeoutState()) {
      return { ready: true, safeToClose: false, reason: "delivery_timeout" };
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

  function turnText(node) {
    if (!node) return "";
    let text = norm(node.innerText || node.textContent);
    const modernKey = node.getAttribute("data-chatgpt-search-unit-key") || "";
    if (modernKey.endsWith(":user")) text = text.replace(/^you said:\s*/i, "");
    return text;
  }

  function scheduleDeliveryTimeoutRecovery() {
    clearTimeout(timeoutRecoveryTimer);
    if (!deliveryTimeoutState()) {
      timeoutRecoveryLocked = false;
      return;
    }
    timeoutRecoveryTimer = setTimeout(() => {
      void recoverDeliveryTimeout();
    }, 200);
  }

  async function recoverDeliveryTimeout() {
    const timeout = deliveryTimeoutState();
    if (!timeout) {
      timeoutRecoveryLocked = false;
      return;
    }
    if (timeoutRecoveryLocked || timeoutRecoveryRunning || sendActive || newChatActive || stopButton()) return;

    const input = composer();
    if (!input || norm(input.innerText || input.value || input.textContent)) return;

    const lastUser = [...turns()].reverse().find((node) => roleOfTurn(node) === "user");
    if (turnText(lastUser).toLowerCase() === DELIVERY_TIMEOUT_RECOVERY_MESSAGE) {
      timeoutRecoveryLocked = true;
      return;
    }

    // Do not click ChatGPT's Retry button: it may replay an uncertain request.
    // Send a distinct continuation exactly once for this visible timeout episode.
    timeoutRecoveryLocked = true;
    timeoutRecoveryRunning = true;
    sendActive = true;
    try {
      await sendMessage({ message: DELIVERY_TIMEOUT_RECOVERY_MESSAGE });
    } catch (error) {
      console.warn("[Delegate] delivery-timeout continuation failed", String(error?.code || "DELEGATE_TIMEOUT_RECOVERY_FAILED"));
    } finally {
      sendActive = false;
      timeoutRecoveryRunning = false;
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
      case "delegate.list_chats": return await listChats(params);
      case "delegate.open_history_chat": return await openHistoryChat(params);
      case "delegate.read_chat_full": return await readChatFull(params);
      case "delegate.search_current_chat": return await searchCurrentChat(params);
      case "delegate.send_message":
        if (sendActive || newChatActive) fail("DELEGATE_SEND_IN_FLIGHT", "Another send or new-chat operation is in progress; this request was not submitted.");
        sendActive = true;
        try { return await sendMessage(params); } finally {
          sendActive = false;
          scheduleDeliveryTimeoutRecovery();
        }
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

  if (!HISTORY_WORKER) {
    const deliveryTimeoutObserver = new MutationObserver(scheduleDeliveryTimeoutRecovery);
    deliveryTimeoutObserver.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    if (deliveryTimeoutState()) scheduleDeliveryTimeoutRecovery();
  }
})();
