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

  function remove(entry) {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
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
    const entry = { scope, sticky, timer: null, element: null };
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
    item.append(label, close);
    entry.element = item;
    entries.push(entry);
    node.append(item);
    node.hidden = false;
    while (entries.length > MAX_VISIBLE) remove(entries[0]);
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

  window.TrayFeedback = Object.freeze({
    begin, run, notify, clearScope, setPhase, isPending: (key) => pending.has(key),
  });
})();
