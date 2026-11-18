"use strict";
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/** Private native-backed incident inbox. Text-only event rendering and fixed navigation. */
(() => {
  const $ = (id) => document.getElementById(id);
  const severity = Object.freeze({ info: "Information", warning: "Warning", critical: "Critical" });
  const sources = Object.freeze([
    "core", "security", "mcp", "tunnel", "delegate", "runtime", "desktop-live",
    "terminal", "lan-devices", "reminder", "jobs", "updates", "shutdown",
    "settings", "muse-files", "overview", "logs",
  ]);
  const destination = Object.freeze({
    core: "runtime", security: "security", mcp: "runtime", tunnel: "runtime",
    delegate: "delegate", runtime: "runtime", "desktop-live": "desktop-live",
    terminal: "terminal", "lan-devices": "lan-devices", reminder: "jobs",
    jobs: "jobs", updates: "updates", shutdown: "overview", settings: "settings",
    "muse-files": "muse-files", overview: "overview", logs: "logs",
  });
  const state = {
    items: [], unreadCount: 0, filter: "all", source: "all", period: "all",
    search: "", open: false, busy: false, error: "", securitySync: "unknown", prefsDirty: false, evictedCount: 0,
  };
  const invoke = (action, id) => {
    const call = window.__TAURI__?.core?.invoke;
    if (!call) return Promise.reject(new Error("Native Tray notification service unavailable"));
    return call("tray_notification_center_action", { action, id: id ?? null });
  };
  const element = (tag, klass, text) => {
    const el = document.createElement(tag);
    if (klass) el.className = klass;
    if (text !== undefined) el.textContent = String(text);
    return el;
  };
  const formatTime = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "Unknown time";
    try { return new Date(n).toLocaleString(); } catch { return "Unknown time"; }
  };
  const incidentState = (n) =>
    n.resolvedAt ? "Resolved" : n.acknowledgedAt ? "Acknowledged" : "Open";
  const active = () => state.items.filter((n) => !n.archivedAt);
  const selected = () => {
    let items = state.filter === "archived"
      ? state.items.filter((n) => n.archivedAt) : active();
    items = items.filter((n) => {
      if (state.filter === "unread" && n.readAt) return false;
      if (state.filter === "important" && n.severity === "info") return false;
      if (state.filter === "open" && (n.resolvedAt || n.acknowledgedAt)) return false;
      if (state.filter === "acknowledged" && (!n.acknowledgedAt || n.resolvedAt)) return false;
      if (state.filter === "resolved" && !n.resolvedAt) return false;
      if (state.source !== "all" && n.source !== state.source) return false;
      if (state.search && ![n.title, n.body, n.source]
        .some((part) => String(part).toLowerCase().includes(state.search))) return false;
      if (state.period !== "all") {
        const limits = { "24h": 1, "7d": 7, "30d": 30, "90d": 90 };
        const days = limits[state.period];
        if (days && Number(n.createdAt) < Date.now() - days * 86400000) return false;
      }
      return true;
    });
    return items;
  };
  const safeItems = (data) => {
    if (!data || !Array.isArray(data.items)) throw new Error("Invalid notification response");
    return data.items.slice(0, 300).filter((item) =>
      item && typeof item.id === "string" && typeof item.title === "string" &&
      typeof item.body === "string" && sources.includes(item.source) &&
      Object.hasOwn(severity, item.severity));
  };
  const readPrefs = (data) => {
    const prefs = data?.preferences;
    if (!prefs || !Array.isArray(prefs.categories) ||
      !["info", "warning", "critical"].includes(prefs.minSeverity) ||
      ![7, 30, 90].includes(prefs.retentionDays)) return null;
    return prefs;
  };
  function displayPrefs(prefs) {
    if (!prefs || state.prefsDirty) return;
    if ($("notification-min-severity")) $("notification-min-severity").value = prefs.minSeverity;
    if ($("notification-retention-days")) $("notification-retention-days").value = String(prefs.retentionDays);
    if ($("notification-os-critical")) $("notification-os-critical").checked = prefs.osCritical;
    if ($("notification-os-warnings")) $("notification-os-warnings").checked = prefs.osWarnings;
    document.querySelectorAll("[data-notification-category]").forEach((check) => {
      check.checked = prefs.categories.includes(check.dataset.notificationCategory);
    });
  }
  function apply(data) {
    state.items = safeItems(data);
    state.unreadCount = state.items.filter((n) => !n.readAt && !n.archivedAt).length;
    state.evictedCount = Number.isSafeInteger(data.evictedCount) && data.evictedCount >= 0
      ? data.evictedCount : 0;
    state.error = "";
    displayPrefs(readPrefs(data));
    render();
  }
  function addAction(container, text, action, id, ariaText) {
    const button = element("button", "notification-mini-button", text);
    button.type = "button";
    if (ariaText) button.setAttribute("aria-label", ariaText);
    button.addEventListener("click", () => mutate(action, id));
    button.disabled = state.busy;
    container.append(button);
  }
  function noteCard(item, compact) {
    const wrapper = element("article",
      "notification-item severity-" + item.severity +
      (item.readAt ? " is-read" : " is-unread") +
      (item.resolvedAt ? " is-resolved" : ""));
    const indicator = element("span", "notification-item-indicator");
    indicator.setAttribute("aria-hidden", "true");
    const copy = element("div", "notification-item-copy");
    const heading = element("div", "notification-item-heading");
    heading.append(element("h3", "", item.title));
    if (!item.readAt && !item.archivedAt) heading.append(element("span", "notification-item-new", "New"));
    const tag = element("span", "notification-item-state", incidentState(item));
    heading.append(tag);
    const repeated = Number(item.occurrences) > 1 ? " · " + item.occurrences + " occurrences" : "";
    const meta = element("p", "notification-item-meta",
      severity[item.severity] + " · " + item.source.replaceAll("-", " ") +
      " · " + formatTime(item.createdAt) + repeated);
    copy.append(heading, meta, element("p", "notification-item-text", item.body));
    const actions = element("div", "notification-item-actions");
    const page = destination[item.source];
    if (page) {
      const open = element("button", "notification-link", "View " + page.replaceAll("-", " "));
      open.type = "button";
      open.addEventListener("click", () => {
        close();
        window.navigateToPage?.(page);
        // The opaque request ID already belongs to the authenticated native
        // inbox. Focus only; approval remains a separate human action.
        if (item.source === "security" && item.id.startsWith("mcp-pending:")) {
          void Promise.resolve(window.__superagentAccessManagerFocusRequest?.(
            item.id.slice("mcp-pending:".length))).catch(() => {});
        }
      });
      actions.append(open);
    }
    addAction(actions, item.readAt ? "Mark unread" : "Mark read",
      item.readAt ? "unread" : "read", item.id,
      (item.readAt ? "Mark unread: " : "Mark read: ") + item.title);
    if (!compact) {
      if (!item.resolvedAt && !item.acknowledgedAt) {
        addAction(actions, "Acknowledge", "acknowledge", item.id, "Acknowledge: " + item.title);
      }
      addAction(actions, item.resolvedAt ? "Reopen" : "Resolve",
        item.resolvedAt ? "reopen" : "resolve", item.id);
    }
    if (!compact || item.archivedAt) {
      addAction(actions, item.archivedAt ? "Restore" : "Archive",
        item.archivedAt ? "restore" : "archive", item.id);
    }
    copy.append(actions);
    wrapper.append(indicator, copy);
    return wrapper;
  }
  const empty = (message) => element("div", "notification-empty", message);
  function render() {
    const count = state.unreadCount;
    for (const el of [$("tray-notification-count"), $("nav-notifications-count")]) {
      if (!el) continue;
      el.hidden = count === 0;
      el.textContent = count > 99 ? "99+" : String(count);
    }
    const bell = $("tray-notification-bell");
    if (bell) {
      bell.setAttribute("aria-label", count ? "Notifications, " + count + " unread" : "Notifications, none unread");
      bell.setAttribute("aria-expanded", String(state.open));
    }
    const popup = $("tray-notification-popover");
    if (popup) popup.hidden = !state.open;
    const recent = $("tray-notification-recent");
    if (recent) {
      recent.replaceChildren();
      if (state.error) recent.append(empty(state.error));
      else if (!active().length) recent.append(empty("You're all caught up. No current notifications."));
      else active().slice(0, 5).forEach((n) => recent.append(noteCard(n, true)));
    }
    const inbox = $("notification-inbox-list");
    if (inbox) {
      inbox.replaceChildren();
      if (state.error) inbox.append(empty(state.error));
      else if (!selected().length) inbox.append(empty("No notifications match these filters."));
      else selected().forEach((n) => inbox.append(noteCard(n, false)));
    }
    const summary = $("notification-summary");
    if (summary) summary.textContent = count + " unread · " +
      active().filter((n) => !n.resolvedAt).length + " open · " +
      active().filter((n) => n.resolvedAt).length + " resolved · " +
      (state.items.length - active().length) + " archived" +
      (state.evictedCount ? " · " + state.evictedCount + " older events pruned" : "") +
      (state.securitySync === "unavailable" ? " · Security requests could not sync with Core" : "");
    document.querySelectorAll("[data-notification-filter]").forEach((button) => {
      const yes = button.dataset.notificationFilter === state.filter;
      button.classList.toggle("active", yes);
      button.setAttribute("aria-pressed", String(yes));
    });
    for (const id of ["notification-read-all", "tray-notification-read-all"]) {
      const button = $(id);
      if (button) button.disabled = state.busy || count === 0 || Boolean(state.error);
    }
    const archiveRead = $("notification-archive-read");
    if (archiveRead) archiveRead.disabled = state.busy || !active().some((n) => n.readAt);
    const save = $("notification-save-preferences");
    if (save) save.disabled = state.busy || !state.prefsDirty;
  }
  async function refresh(syncSecurity = false) {
    if (state.busy) return;
    state.busy = true;
    try {
      // Opening Notifications makes a fresh authenticated Core inventory
      // request; passive badge refreshes use only the native persisted inbox.
      // Neither route has an approval or grant mutation operation.
      const result = syncSecurity === true
        ? await window.__TAURI__?.core?.invoke?.("tray_notification_center_refresh_security")
        : await invoke("list");
      if (!result) throw new Error("Native notification service unavailable");
      if (syncSecurity === true) state.securitySync = result.securitySync === "ok" ? "ok" : "unavailable";
      apply(result);
    } catch {
      if (syncSecurity === true) state.securitySync = "unavailable";
      state.error = "Cannot load notifications. Open the installed Tray or retry.";
      render();
    } finally { state.busy = false; render(); }
  }
  async function mutate(action, id) {
    if (state.busy) return;
    state.busy = true;
    render();
    try { apply(await invoke(action, id)); }
    catch {
      state.error = "Notification change could not be saved. Retry after checking Tray.";
    } finally { state.busy = false; render(); }
  }
  function collectPrefs() {
    return {
      minSeverity: $("notification-min-severity").value,
      osCritical: $("notification-os-critical").checked === true,
      osWarnings: $("notification-os-warnings").checked === true,
      categories: Array.from(document.querySelectorAll("[data-notification-category]"))
        .filter((node) => node.checked).map((node) => node.dataset.notificationCategory)
        .filter((category) => sources.includes(category)),
      retentionDays: Number($("notification-retention-days").value),
    };
  }
  async function savePrefs() {
    if (state.busy) return;
    state.busy = true;
    render();
    const feedback = $("notification-preferences-feedback");
    try {
      const result = await window.__TAURI__?.core?.invoke?.(
        "tray_notification_center_preferences", { preferences: collectPrefs() });
      if (!result) throw new Error("Native settings unavailable");
      state.prefsDirty = false;
      apply(result);
      if (feedback) feedback.textContent = "Notification preferences saved.";
    } catch {
      if (feedback) feedback.textContent = "Couldn't save preferences. Bring the native Tray to the foreground and retry.";
    } finally { state.busy = false; render(); }
  }
  function close() { state.open = false; render(); }
  function toggle() {
    state.open = !state.open;
    render();
    if (state.open) void refresh(true);
  }
  function init() {
    $("tray-notification-bell")?.addEventListener("click", toggle);
    $("tray-notification-popover")?.addEventListener("click", (event) => {
      if (event.target?.closest?.("[data-notification-close]")) close();
    });
    $("tray-notification-view-all")?.addEventListener("click", () => {
      close(); window.navigateToPage?.("notifications");
    });
    $("tray-notification-read-all")?.addEventListener("click", () => mutate("read-all"));
    $("notification-read-all")?.addEventListener("click", () => mutate("read-all"));
    $("notification-archive-read")?.addEventListener("click", () => mutate("archive-read"));
    $("notification-retry")?.addEventListener("click", refresh);
    $("notification-save-preferences")?.addEventListener("click", savePrefs);
    document.querySelectorAll("[data-notification-filter]").forEach((button) =>
      button.addEventListener("click", () => {
        state.filter = button.dataset.notificationFilter;
        render();
      }));
    $("notification-search")?.addEventListener("input", (event) => {
      state.search = String(event.target.value || "").toLowerCase().slice(0, 80);
      render();
    });
    $("notification-period")?.addEventListener("change", (event) => {
      state.period = event.target.value;
      render();
    });
    $("notification-source")?.addEventListener("change", (event) => {
      state.source = event.target.value;
      render();
    });
    for (const id of ["notification-min-severity", "notification-os-critical",
      "notification-os-warnings", "notification-retention-days"]) {
      $(id)?.addEventListener("change", () => { state.prefsDirty = true; render(); });
    }
    document.querySelectorAll("[data-notification-category]").forEach((check) =>
      check.addEventListener("change", () => { state.prefsDirty = true; render(); }));
    document.addEventListener("pointerdown", (event) => {
      if (state.open && !$("tray-notification-popover")?.contains(event.target) &&
          !$("tray-notification-bell")?.contains(event.target)) close();
    });
    document.addEventListener("keydown", (event) => {
      if (state.open && event.key === "Escape") { close(); $("tray-notification-bell")?.focus(); }
    });
    window.addEventListener("superagent-tray-attention", (event) => {
      const scope = event?.detail?.scope;
      const kind = event?.detail?.kind;
      const call = window.__TAURI__?.core?.invoke;
      if (!call || !scope || !kind) return;
      Promise.resolve(call("tray_notification_center_ui_alert", { scope, kind }))
        .then(refresh).catch(() => {});
    });
    window.__TAURI__?.event?.listen?.("tray-notifications-changed", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-started", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-stopped", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-start-failed", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-stop-failed", refresh);
    window.addEventListener("focus", () => { void refresh(true); });
    window.setInterval(refresh, 15000);
    void refresh();
  }
  window.__superagentNotificationsRefresh = () => refresh(true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
