"use strict";
/* Hallmark · pre-emit critique: P4 H5 E5 S5 R5 V4 */
/** Shared owner-agnostic visual feedback. No network calls or lifecycle actions. */
(() => {
  const pending = new Map();
  const entries = [];
  const recent = new Map();
  const MAX_VISIBLE = 3;
  const KINDS = new Set(["success", "error", "warning", "info"]);
  const host = () => document.getElementById("toast");
  const COPY_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  const CHECK_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  function remove(entry) {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.copyTimer) clearTimeout(entry.copyTimer);
    entry.element.remove?.();
    const node = host();
    if (node && entries.length === 0) node.hidden = true;
  }

  function notify({ kind = "info", message, scope = "", dedupeKey = "", sticky = false } = {}) {
    const node = host();
    if (!node || typeof message !== "string" || !message.trim()) return false;
    const type = KINDS.has(kind) ? kind : "info";
    const key = dedupeKey && scope + ":" + dedupeKey;
    const now = Date.now();
    if (key && (recent.get(key) || 0) > now - 4000) return false;
    if (key) {
      recent.set(key, now);
      if (recent.size > 80) recent.clear();
    }
    const entry = { scope, sticky, timer: null, element: null, copyTimer: null };
    const item = document.createElement("div");
    item.className = "tray-toast-item tray-toast-" + type;
    item.setAttribute("role", type === "error" || type === "warning" ? "alert" : "status");
    const label = document.createElement("span");
    label.className = "tray-toast-message";
    label.textContent = message.slice(0, 240);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tray-toast-dismiss";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss notification");
    close.addEventListener("click", () => remove(entry));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "tray-toast-copy";
    copy.setAttribute("aria-label", "Copy notification message");
    copy.setAttribute("title", "Copy message");
    copy.innerHTML = COPY_ICON;
    copy.addEventListener("click", async (e) => {
      e?.stopPropagation?.();
      const textToCopy = label.textContent || message;
      const nav = typeof navigator !== "undefined" ? navigator : (typeof window !== "undefined" ? window.navigator : undefined);
      let ok = false;
      if (nav?.clipboard?.writeText) {
        try {
          await nav.clipboard.writeText(textToCopy);
          ok = true;
        } catch {}
      }
      if (!ok && typeof document !== "undefined" && typeof document.createElement === "function") {
        try {
          const ta = document.createElement("textarea");
          ta.value = textToCopy;
          if (ta.style) {
            ta.style.position = "fixed";
            ta.style.opacity = "0";
          }
          if (document.body && typeof document.body.appendChild === "function") {
            document.body.appendChild(ta);
          }
          ta.select?.();
          if (document.execCommand) document.execCommand("copy");
          ta.remove?.();
        } catch {}
      }
      copy.classList?.add?.("copied");
      copy.setAttribute("aria-label", "Message copied to clipboard");
      copy.setAttribute("title", "Copied!");
      copy.innerHTML = CHECK_ICON;
      if (entry.copyTimer) clearTimeout(entry.copyTimer);
      entry.copyTimer = setTimeout(() => {
        copy.classList?.remove?.("copied");
        copy.setAttribute("aria-label", "Copy notification message");
        copy.setAttribute("title", "Copy message");
        copy.innerHTML = COPY_ICON;
      }, 2000);
    });
    item.append(label, close, copy);
    // A toast has no authenticated incident ID. Only offer its fixed local
    // source destination; never infer URLs, request IDs, or retry actions from
    // the toast message.
    if ((type === "error" || type === "warning") &&
      window.__superagentNotificationDefaultRoute?.(scope)) {
      const review = document.createElement("button");
      review.type = "button";
      review.className = "tray-toast-review";
      review.textContent = "Review";
      review.setAttribute("aria-label", "Review " + String(scope).replaceAll("-", " ") + " status");
      review.addEventListener("click", () => {
        if (window.__superagentNotificationOpenScope?.(scope) === true) remove(entry);
      });
      item.append(review);
    }
    entry.element = item;
    entries.push(entry);
    node.append(item);
    node.hidden = false;
    while (entries.length > MAX_VISIBLE) remove(entries[0]);
    // The native inbox stores generic, redacted issue metadata only.
    // No arbitrary toast body is copied into the durable notification ledger.
    if ((type === "error" || type === "warning") && typeof CustomEvent !== "undefined") {
      window.dispatchEvent?.(new CustomEvent("superagent-tray-attention", {
        detail: { scope: String(scope), kind: type },
      }));
    }
    if (!sticky) entry.timer = setTimeout(() => remove(entry),
      type === "error" || type === "warning" ? 7000 : 4300);
    return true;
  }

  function begin({ key, button, label, background = false } = {}) {
    if (!key || pending.has(key)) return null;
    const previous = button ? {
      disabled: button.disabled,
      label: button.textContent,
      busy: button.getAttribute?.("aria-busy") ?? null,
    } : null;
    if (button && !background) {
      button.disabled = true;
      if (label) button.textContent = label;
      button.classList?.add?.("tray-action-loading");
      button.setAttribute?.("aria-busy", "true");
    }
    let ended = false;
    const token = {
      end() {
        if (ended) return;
        ended = true;
        if (pending.get(key) === token) pending.delete(key);
        if (button && previous && !background) {
          button.textContent = previous.label;
          button.disabled = previous.disabled;
          button.classList?.remove?.("tray-action-loading");
          if (previous.busy === null) button.removeAttribute?.("aria-busy");
          else button.setAttribute?.("aria-busy", previous.busy);
        }
      },
    };
    pending.set(key, token);
    return token;
  }

  async function run(options) {
    const ticket = begin(options);
    if (!ticket) return { status: "duplicate" };
    try {
      const value = await options.operation();
      if (options.verify && await options.verify(value) !== true)
        throw new Error("RESULT_NOT_VERIFIED");
      if (!options.background && options.success)
        notify({ kind: "success", message: options.success, scope: options.scope, dedupeKey: options.key });
      return { status: "success", value };
    } catch (error) {
      const unknown = options.uncertain?.(error) === true;
      if (!options.background)
        notify({ kind: unknown ? "warning" : "error",
          message: unknown ? (options.warning || "Outcome not confirmed; inspect status before retrying.")
            : (options.failure || "Action could not be completed. Check the inline status."),
          scope: options.scope, dedupeKey: options.key + ":" + (unknown ? "unknown" : "failed") });
      return { status: unknown ? "uncertain" : "error", error };
    } finally {
      ticket.end();
    }
  }

  function clearScope(scope) {
    for (const entry of [...entries]) if (entry.scope === scope && !entry.sticky) remove(entry);
  }
  function setPhase({ element, phase, detail = "" } = {}) {
    if (element) element.textContent = [phase, detail].filter(Boolean).join(" · ").slice(0, 300);
  }

  async function copyText(text, btn) {
    if (!text) return false;
    const nav = typeof navigator !== "undefined" ? navigator : (typeof window !== "undefined" ? window.navigator : undefined);
    let ok = false;
    if (nav?.clipboard?.writeText) {
      try {
        await nav.clipboard.writeText(text);
        ok = true;
      } catch {}
    }
    if (!ok && typeof document !== "undefined" && typeof document.createElement === "function") {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select?.();
        if (document.execCommand) document.execCommand("copy");
        ta.remove?.();
        ok = true;
      } catch {}
    }
    if (btn && ok) {
      const prevHTML = btn.innerHTML;
      btn.classList?.add?.("copied");
      btn.setAttribute?.("aria-label", "Copied to clipboard");
      btn.setAttribute?.("title", "Copied!");
      btn.innerHTML = CHECK_ICON;
      setTimeout(() => {
        btn.classList?.remove?.("copied");
        btn.setAttribute?.("aria-label", "Copy to clipboard");
        btn.setAttribute?.("title", "Copy");
        btn.innerHTML = prevHTML;
      }, 2000);
    }
    return ok;
  }

  function showBanner(target, { kind = "info", message = "", copyText: customCopy = "", dismissible = true, aboveForm = true } = {}) {
    const el = typeof target === "string" ? document.getElementById(target) : target;
    if (!el || !message) return false;
    el.hidden = false;
    el.className = "banner" + (aboveForm ? " banner--above-form" : "") + " banner--" + (KINDS.has(kind) ? kind : "info");
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    el.innerHTML = "";

    const content = document.createElement("div");
    content.className = "banner-content";
    content.textContent = message;

    const actions = document.createElement("div");
    actions.className = "banner-actions";

    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "banner-copy-btn";
    copyBtn.setAttribute("aria-label", "Copy alert payload");
    copyBtn.setAttribute("title", "Copy text");
    copyBtn.innerHTML = COPY_ICON;
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void copyText(customCopy || message, copyBtn);
    });
    actions.append(copyBtn);

    if (dismissible) {
      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "tray-toast-dismiss";
      dismissBtn.textContent = "×";
      dismissBtn.setAttribute("aria-label", "Dismiss alert");
      dismissBtn.addEventListener("click", () => {
        el.hidden = true;
      });
      actions.append(dismissBtn);
    }

    el.append(content, actions);
    return true;
  }

  window.TrayFeedback = Object.freeze({
    begin, run, notify, clearScope, setPhase, isPending: (key) => pending.has(key),
    copyText, showBanner,
  });
  window.__superagentToast = notify;
  window.__superagentBanner = showBanner;
  window.__superagentCopy = copyText;
})();
