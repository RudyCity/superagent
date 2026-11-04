/* Read-only safety and failure-state probe. Never reloads a tab on its own. */
(() => {
  "use strict";
  if (globalThis.__chatgptOptimizerTargetReloadActive) return;
  globalThis.__chatgptOptimizerTargetReloadActive = true;
  const SCOPE = "chatgpt-optimizer-target-reload-v1";
  const fail = (reason) => ({ safe: false, reason });
  const visible = (node) => !!node && node.isConnected && node.getClientRects().length > 0;
  const nonEmpty = (value) => String(value || "").replace(/\s+/g, " ").trim().length > 0;

  // ChatGPT sometimes renders an error instead of any conversation turns or composer.
  // Only a real, visible error outside conversation turns can authorize recovery.
  // User messages that quote this error must NOT be mistaken for a failure screen.
  function failedConversationVisible() {
    const nodes = document.querySelectorAll(
      'main h1, main h2, main h3, main p, main div, main span, ' +
      'main [role="alert"], main [data-testid*="error"], [role="alert"]'
    );
    let scanned = 0;
    for (const node of nodes) {
      if (++scanned > 6000) break; // Bound the cost on very long conversations.
      if (!visible(node)) continue;
      if (node.closest?.(
        '[data-message-author-role], [data-testid^="conversation-turn-"], ' +
        '[contenteditable="true"], textarea'
      )) continue;
      const text = String(node.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length <= 100 && /^Could not load this ChatGPT conversation\.?$/i.test(text)) {
        return true;
      }
    }
    return false;
  }

  function inspectReload() {
    if (!/^\/c\/[a-z0-9-]{8,80}\/?$/i.test(location.pathname)) {
      return fail("Select a saved conversation tab.");
    }
    if (document.readyState !== "complete") {
      return fail("The conversation is still loading.");
    }

    // Safety checks MUST run before the recovery exception. Never discard
    // a visible draft, upload, active generation or open dialog.
    const controls = Array.from(document.querySelectorAll("button")).filter(visible);
    const generating = controls.some((button) => {
      const label = String(button.getAttribute("aria-label") || "").toLowerCase().trim();
      return button.matches?.('[data-testid="stop-button"]') ||
        /^(stop generating|stop generation|stop response)$/.test(label);
    });
    if (generating) return fail("ChatGPT is generating a response.");

    const editors = Array.from(document.querySelectorAll(
      '[data-composer-markdown][contenteditable="true"], ' +
      '#prompt-textarea[contenteditable="true"], ' +
      'textarea#prompt-textarea, textarea[data-testid="prompt-textarea"], ' +
      '[data-testid="composer"] [contenteditable="true"]'
    )).filter(visible);
    if (editors.some((editor) => nonEmpty(editor.value ?? editor.innerText ?? editor.textContent))) {
      return fail("An unsent message draft is present.");
    }
    if (Array.from(document.querySelectorAll(
      '[data-testid="attachment-preview"], ' +
      '[data-testid="composer-attachment"], ' +
      '[data-testid="attachment-uploading"]'
    )).some(visible)) {
      return fail("A file attachment or upload is pending.");
    }
    if (Array.from(document.querySelectorAll('dialog[open], [role="dialog"]')).some(visible)) {
      return fail("A dialog is open in the selected chat.");
    }

    // Explicit recovery path: allow ONE manual reload even when chat content
    // and composer are absent, but only on this exact recognizable error.
    if (failedConversationVisible()) {
      return {
        safe: true,
        recovery: true,
        reason: "ChatGPT reports a failed conversation load. A targeted reload may retry it.",
      };
    }

    if (!editors.length) return fail("The message composer is not ready.");
    if (!Array.from(document.querySelectorAll(
      '[data-message-author-role], [data-testid^="conversation-turn-"]'
    )).some(visible)) return fail("The chat has not finished rendering.");

    return { safe: true, reason: "The selected conversation is idle." };
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.scope !== SCOPE || sender?.id !== chrome.runtime.id) return false;
    if (message.action !== "inspect_reload") {
      respond({ ok: false, reason: "Unknown action" });
      return false;
    }
    respond({ ok: true, ...inspectReload() });
    return false;
  });
})();
