/* A read-only safety probe. It never reloads pages or sends messages by itself. */
(() => {
  "use strict";
  if (globalThis.__chatgptOptimizerTargetReloadActive) return;
  globalThis.__chatgptOptimizerTargetReloadActive = true;
  const SCOPE = "chatgpt-optimizer-target-reload-v1";
  const fail = (reason) => ({ safe: false, reason });
  const visible = (node) => !!node && node.isConnected && node.getClientRects().length > 0;
  const nonEmpty = (value) => String(value || "").replace(/\s+/g, " ").trim().length > 0;

  function inspectReload() {
    if (!/^\/c\/[a-z0-9-]{8,80}\/?$/i.test(location.pathname)) {
      return fail("Select a saved conversation tab.");
    }
    if (document.readyState !== "complete") {
      return fail("The conversation is still loading.");
    }
    // A missing editor is not proof the conversation is idle.
    const editor = Array.from(document.querySelectorAll(
      '[data-composer-markdown][contenteditable="true"], ' +
      '#prompt-textarea[contenteditable="true"], ' +
      'textarea#prompt-textarea, textarea[data-testid="prompt-textarea"], ' +
      '[data-testid="composer"] [contenteditable="true"]'
    )).find(visible);
    if (!editor) return fail("The message composer is not ready.");
    const controls = Array.from(document.querySelectorAll("button")).filter(visible);
    const generating = controls.some((button) => {
      const label = String(button.getAttribute("aria-label") || "").toLowerCase().trim();
      return button.matches?.('[data-testid="stop-button"]') ||
        /^(stop generating|stop generation|stop response)$/.test(label);
    });
    if (generating) return fail("ChatGPT is generating a response.");

    if (nonEmpty(editor.value ?? editor.innerText ?? editor.textContent)) {
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
    // A saved conversation with no visible turns may not have loaded yet.
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
