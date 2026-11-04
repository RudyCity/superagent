/* Chat-only retry: NEVER reloads a Chrome tab, navigates, or rewrites ChatGPT DOM. */
(() => {
  "use strict";
  if (globalThis.__chatgptOptimizerTargetReloadActive) return;
  globalThis.__chatgptOptimizerTargetReloadActive = true;
  const SCOPE = "chatgpt-optimizer-target-reload-v1";
  const ERROR_TEXT = /^Could not load this ChatGPT conversation\.?$/i;
  const RETRY_TEXT = /^Try again\.?$/i;
  const VALID_CHAT_PATH = /^\/c\/[a-z0-9-]{8,80}\/?$/i;
  const RETRY_COOLDOWN_MS = 10_000;
  let lastAttempt = 0;
  const blocked = (reason) => ({ safe: false, reason });
  const visible = (node) => !!node && node.isConnected && node.getClientRects().length > 0;
  const normalizedText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const inChatTurn = (node) => !!node.closest?.(
    '[data-message-author-role], [data-testid^="conversation-turn-"], ' +
    '[contenteditable="true"], textarea'
  );

  function errorHeading() {
    // Only the app's visible load-error UI, not a user/assistant message quoting it.
    const nodes = document.querySelectorAll(
      'main h1, main h2, main h3, main p, main div, main span, ' +
      'main [role="alert"], main [data-testid*="error"], [role="alert"]'
    );
    let scanned = 0;
    for (const node of nodes) {
      if (++scanned > 6000) break;
      if (visible(node) && !inChatTurn(node) &&
          ERROR_TEXT.test(normalizedText(node.textContent))) return node;
    }
    return null;
  }

  function findNativeRetry(heading) {
    if (!heading) return null;
    // Only seek controls in the same error card. Searching the entire page
    // could accidentally click a different "Try again" (e.g. message retry).
    let ancestor = heading.parentElement;
    for (let level = 0; ancestor && level < 6; ancestor = ancestor.parentElement, level++) {
      if (ancestor.matches?.("main, nav, aside, body, html")) break;
      const candidates = ancestor.querySelectorAll?.('button, [role="button"]') || [];
      for (const control of candidates) {
        if (inChatTurn(control) || !visible(control)) continue;
        const label = normalizedText(control.getAttribute?.("aria-label") ||
          control.innerText || control.textContent);
        if (!RETRY_TEXT.test(label)) continue;
        if (control.disabled || control.getAttribute?.("aria-disabled") === "true") {
          return { control, disabled: true };
        }
        return { control, disabled: false };
      }
    }
    return null;
  }

  function inspect(expectedPath) {
    if (!VALID_CHAT_PATH.test(location.pathname)) {
      return blocked("Select a saved ChatGPT conversation.");
    }
    if (typeof expectedPath === "string" && expectedPath !== location.pathname) {
      return blocked("The selected conversation changed. Update tab list.");
    }
    if (document.readyState !== "complete") {
      return blocked("The conversation is still loading.");
    }
    // Never click a native retry if there is any activity or unsent work.
    if (Array.from(document.querySelectorAll("button")).some((button) => {
      if (!visible(button)) return false;
      const label = normalizedText(button.getAttribute?.("aria-label")).toLowerCase();
      return button.matches?.('[data-testid="stop-button"]') ||
        /^(stop generating|stop generation|stop response)$/.test(label);
    })) return blocked("ChatGPT is generating a response.");

    const editors = Array.from(document.querySelectorAll(
      '[data-composer-markdown][contenteditable="true"], ' +
      '#prompt-textarea[contenteditable="true"], ' +
      'textarea#prompt-textarea, textarea[data-testid="prompt-textarea"], ' +
      '[data-testid="composer"] [contenteditable="true"]'
    )).filter(visible);
    if (editors.some((editor) =>
      normalizedText(editor.value ?? editor.innerText ?? editor.textContent).length > 0
    )) return blocked("An unsent message draft is present.");
    if (Array.from(document.querySelectorAll(
      '[data-testid="attachment-preview"], ' +
      '[data-testid="composer-attachment"], ' +
      '[data-testid="attachment-uploading"]'
    )).some(visible)) return blocked("A file attachment or upload is pending.");
    if (Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).some(visible)) {
      return blocked("A dialog is open in the selected chat.");
    }

    const heading = errorHeading();
    if (!heading) return blocked(
      "No ChatGPT conversation-load error is shown. In-page refresh is unavailable for a loaded chat."
    );
    const retry = findNativeRetry(heading);
    if (!retry) return blocked(
      "ChatGPT's in-page Try again control was not found. No page reload was performed."
    );
    if (retry.disabled) return blocked(
      "ChatGPT's Try again control is disabled. No page reload was performed."
    );
    if (Date.now() - lastAttempt < RETRY_COOLDOWN_MS) return blocked(
      "Retry was triggered recently. Allow ChatGPT to finish before trying again."
    );
    return {
      safe: true, recovery: true, method: "native_try_again",
      reason: "ChatGPT's in-page Try again control is available.",
      control: retry.control,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.scope !== SCOPE || sender?.id !== chrome.runtime.id) return false;
    if (message.action !== "inspect_retry" && message.action !== "retry_conversation") {
      respond({ ok: false, reason: "Unknown action" });
      return false;
    }
    const check = inspect(message.expectedPath);
    if (!check.safe || message.action === "inspect_retry") {
      // DOM nodes are never serialized back into extension message responses.
      const { control: _control, ...details } = check;
      respond({ ok: true, ...details });
      return false;
    }
    // A single user-requested native action, in the selected tab only.
    // ChatGPT owns the fetch/state transition. We neither force navigation
    // nor make private API requests or inject message content.
    try {
      lastAttempt = Date.now();
      check.control.click();
      respond({
        ok: true, triggered: true, method: "native_try_again",
        reason: "ChatGPT's Try again was clicked. Recovery is not yet confirmed.",
      });
    } catch {
      respond({
        ok: true, triggered: false,
        reason: "Could not activate ChatGPT's Try again control. Page was not reloaded.",
      });
    }
    return false;
  });
})();
