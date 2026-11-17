"use strict";
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 */
/** A single read-only native-backed inbox, shared by the header and main page. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { items: [], unreadCount: 0, filter: "all", open: false, busy: false, error: "" };
  const severity = { info: "Information", warning: "Warning", critical: "Critical" };
  const destination = {
    core: "runtime", reminder: "jobs", security: "security", runtime: "runtime",
    delegate: "delegate", "desktop-live": "desktop-live", terminal: "terminal",
    "lan-devices": "lan-devices", "muse-files": "muse-files", jobs: "jobs",
    updates: "updates", settings: "settings", shutdown: "overview",
    overview: "overview", logs: "logs",
  };
  const invoke = (action, id) => {
    const call = window.__TAURI__?.core?.invoke;
    if (!call) return Promise.reject(new Error("Native Tray notification service unavailable"));
    return call("tray_notification_center_action", { action, id: id ?? null });
  };
  const node = (name, className, text) => {
    const el = document.createElement(name);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = String(text);
    return el;
  };
  const fmtTime = (ms) => {
    const value = Number(ms);
    if (!Number.isFinite(value) || value <= 0) return "Unknown time";
    try { return new Date(value).toLocaleString(); } catch { return "Unknown time"; }
  };
  const safeItems = (data) => {
    if (!data || !Array.isArray(data.items)) throw new Error("Invalid notification response");
    return data.items.slice(0, 300).filter((item) =>
      item && typeof item.id === "string" && typeof item.title === "string" &&
      typeof item.body === "string" && typeof item.source === "string" &&
      Object.hasOwn(severity, item.severity));
  };
  const apply = (data) => {
    state.items = safeItems(data);
    state.unreadCount = state.items.filter((n) => !n.readAt && !n.archivedAt).length;
    state.error = "";
    render();
  };
  const active = () => state.items.filter((n) => !n.archivedAt);
  const selected = () => {
    if (state.filter === "archived") return state.items.filter((n) => n.archivedAt);
    const items = active();
    if (state.filter === "unread") return items.filter((n) => !n.readAt);
    if (state.filter === "important") return items.filter((n) => n.severity !== "info");
    return items;
  };
  function noteCard(item, compact) {
    const wrapper = node("article", "notification-item severity-" + item.severity +
      (item.readAt ? " is-read" : " is-unread"));
    const icon = node("span", "notification-item-indicator");
    icon.setAttribute("aria-hidden", "true");
    const body = node("div", "notification-item-copy");
    const header = node("div", "notification-item-heading");
    const title = node("h3", "", item.title);
    header.append(title);
    if (!item.readAt && !item.archivedAt) header.append(node("span", "notification-item-new", "New"));
    const meta = node("p", "notification-item-meta",
      severity[item.severity] + " · " + item.source.replaceAll("-", " ") + " · " + fmtTime(item.createdAt));
    body.append(header, meta, node("p", "notification-item-text", item.body));
    const actions = node("div", "notification-item-actions");
    const linkPage = destination[item.source];
    if (linkPage) {
      const open = node("button", "notification-link", "View " + linkPage.replaceAll("-", " "));
      open.type = "button";
      open.addEventListener("click", () => {
        close();
        window.navigateToPage?.(linkPage);
      });
      actions.append(open);
    }
    const read = node("button", "notification-mini-button",
      item.readAt ? "Mark unread" : "Mark read");
    read.type = "button";
    read.setAttribute("aria-label", (item.readAt ? "Mark unread: " : "Mark read: ") + item.title);
    read.addEventListener("click", () => mutate(item.readAt ? "unread" : "read", item.id));
    actions.append(read);
    if (!compact || item.archivedAt) {
      const archive = node("button", "notification-mini-button",
        item.archivedAt ? "Restore" : "Archive");
      archive.type = "button";
      archive.addEventListener("click", () =>
        mutate(item.archivedAt ? "restore" : "archive", item.id));
      actions.append(archive);
    }
    body.append(actions);
    wrapper.append(icon, body);
    return wrapper;
  }
  function empty(message) { return node("div", "notification-empty", message); }
  function render() {
    const badge = $("tray-notification-count");
    const sidebarCount = $("nav-notifications-count");
    const count = state.unreadCount;
    for (const el of [badge, sidebarCount]) {
      if (!el) continue;
      el.hidden = count === 0;
      el.textContent = count > 99 ? "99+" : String(count);
    }
    const bell = $("tray-notification-bell");
    if (bell) {
      bell.setAttribute("aria-label", count
        ? "Notifications, " + count + " unread" : "Notifications, none unread");
      bell.setAttribute("aria-expanded", String(state.open));
    }
    const popup = $("tray-notification-popover");
    if (popup) popup.hidden = !state.open;
    const panel = $("tray-notification-recent");
    if (panel) {
      panel.replaceChildren();
      if (state.error) panel.append(empty(state.error));
      else if (!active().length) panel.append(empty("You're all caught up. No current notifications."));
      else active().slice(0, 5).forEach((item) => panel.append(noteCard(item, true)));
    }
    const inbox = $("notification-inbox-list");
    if (inbox) {
      inbox.replaceChildren();
      if (state.error) inbox.append(empty(state.error));
      else if (!selected().length) inbox.append(empty(
        state.filter === "archived" ? "No archived notifications." :
        state.filter === "unread" ? "All current notifications are read." :
        "No notifications match this filter."));
      else selected().forEach((item) => inbox.append(noteCard(item, false)));
    }
    const summary = $("notification-summary");
    if (summary) summary.textContent =
      count + " unread · " + active().length + " active · " +
      (state.items.length - active().length) + " archived";
    document.querySelectorAll("[data-notification-filter]").forEach((button) => {
      const selected = button.dataset.notificationFilter === state.filter;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    for (const id of ["notification-read-all", "tray-notification-read-all"]) {
      const button = $(id);
      if (button) button.disabled = state.busy || count === 0 || Boolean(state.error);
    }
    const archiveRead = $("notification-archive-read");
    if (archiveRead) archiveRead.disabled = state.busy || !active().some((n) => n.readAt);
  }
  async function refresh() {
    if (state.busy) return;
    state.busy = true;
    try { apply(await invoke("list")); }
    catch (_) {
      state.error = "Cannot load notifications. Open the installed Tray or retry.";
      render();
    } finally { state.busy = false; render(); }
  }
  async function mutate(action, id) {
    if (state.busy) return;
    state.busy = true;
    render();
    try { apply(await invoke(action, id)); }
    catch (_) {
      state.error = "Notification change could not be saved. Retry after checking Tray.";
    } finally { state.busy = false; render(); }
  }
  function close() {
    state.open = false;
    render();
  }
  function toggle() {
    state.open = !state.open;
    render();
    if (state.open) void refresh();
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
    document.querySelectorAll("[data-notification-filter]").forEach((button) =>
      button.addEventListener("click", () => {
        state.filter = button.dataset.notificationFilter;
        render();
      }));
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
    window.addEventListener("focus", refresh);
    window.setInterval(refresh, 15000);
    void refresh();
  }
  window.__superagentNotificationsRefresh = refresh;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
