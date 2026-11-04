/* Read-only idle guard for optional tab hibernation. Never discards tabs itself. */
(() => {
  "use strict";
  if (globalThis.__chatgptOptimizerSleepProbe) return;
  globalThis.__chatgptOptimizerSleepProbe = true;
  const SCOPE = "chatgpt-optimizer-tab-sleep-v1";
  const allowedPath = /^\/c\/[a-z0-9-]{8,80}\/?$/i;
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;
  const deny = (reason) => ({ ok: true, safe: false, reason });
  const text = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

  function inspect() {
    if (!allowedPath.test(location.pathname)) return deny("Not a saved ChatGPT conversation.");
    if (!document.hidden) return deny("Tab is visible; cannot safely hibernate.");
    if (document.readyState !== "complete") return deny("Tab is still loading.");

    const stopButtons = Array.from(document.querySelectorAll(
      '[data-testid="stop-button"],button[aria-label],button[title]'
    )).filter(visible);
    if (stopButtons.some((b) => b.matches?.('[data-testid="stop-button"]') ||
      /^(stop generating|stop generation|stop response|stop streaming|hentikan respons|hentikan)$/
        .test(text(b.getAttribute("aria-label") || b.getAttribute("title")).toLowerCase()))) {
      return deny("ChatGPT is generating a response.");
    }
    if (Array.from(document.querySelectorAll(
      '[role="dialog"],dialog[open],[aria-modal="true"]'
    )).some(visible)) return deny("A dialog is open.");
    if (Array.from(document.querySelectorAll(
      '[data-testid="attachment-preview"],[data-testid="composer-attachment"],' +
      '[data-testid="attachment-uploading"],[data-testid*="upload-progress"]'
    )).some(visible)) return deny("Attachment or upload is pending.");
    if (Array.from(document.querySelectorAll(
      'button[aria-label*="End call"],button[aria-label*="Stop recording"],' +
      '[data-testid*="recording-indicator"],[data-testid*="voice-call"]'
    )).some(visible)) return deny("A call or recording may be running.");

    const editors = Array.from(document.querySelectorAll(
      '[data-composer-markdown][contenteditable="true"],' +
      '#prompt-textarea[contenteditable="true"],textarea#prompt-textarea,' +
      'textarea[data-testid="prompt-textarea"],' +
      '[data-testid="composer"] [contenteditable="true"]'
    )).filter(visible);
    if (!editors.length) return deny("Composer is not ready; idle state unverified.");
    if (editors.some((el) => text(el.value ?? el.innerText ?? el.textContent))) {
      return deny("Unsent draft exists.");
    }
    // Edits anywhere else on the page can also be unsaved.
    if (Array.from(document.querySelectorAll('textarea,[contenteditable="true"]'))
      .filter(visible).some((el) => text(el.value ?? el.innerText ?? el.textContent))) {
      return deny("Editable content may be unsaved.");
    }
    const hasTurns = Array.from(document.querySelectorAll(
      '[data-testid^="conversation-turn-"],[data-message-author-role]'
    )).some(visible);
    if (!hasTurns) return deny("Conversation content has not loaded.");
    const errors = Array.from(document.querySelectorAll(
      '[role="alert"],main h1,main h2,main h3'
    )).filter(visible);
    if (errors.some((el) => /could not load this chatgpt conversation/i.test(text(el.textContent)))) {
      return deny("Conversation is in an error state.");
    }
    return { ok: true, safe: true, reason: "Background saved chat is idle." };
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.scope !== SCOPE || sender?.id !== chrome.runtime.id) return false;
    if (message.action !== "inspect_sleep") {
      reply({ ok: false, reason: "Unknown action." });
      return false;
    }
    reply(inspect());
    return false;
  });
})();
