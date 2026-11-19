"use strict";
/* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
/** Private native-backed incident inbox. Text-only event rendering and fixed navigation. */
(() => {
  const $ = (id) => document.getElementById(id);
  const severity = Object.freeze({ info: "Information", warning: "Warning", critical: "Critical" });
  const severityTag = Object.freeze({ info: "Info", warning: "Warning", critical: "Critical" });
  const sources = Object.freeze([
    "core", "security", "mcp", "tunnel", "delegate", "runtime", "desktop-live",
    "terminal", "lan-devices", "reminder", "jobs", "updates", "shutdown",
    "settings", "muse-files", "overview", "logs",
  ]);
  // Every supported notification category has one stable default destination.
  // Specific, trusted incident prefixes may select a deeper tab or run below.
  const destination = Object.freeze({
    core: "runtime:core", security: "security", mcp: "runtime:mcp",
    tunnel: "runtime:cloudflare", delegate: "delegate:connection",
    runtime: "runtime:core", "desktop-live": "desktop-live",
    terminal: "terminal", "lan-devices": "lan-devices:devices",
    reminder: "jobs", jobs: "jobs", updates: "updates",
    shutdown: "overview", settings: "settings:general",
    "muse-files": "muse-files", overview: "overview", logs: "logs",
  });
  const state = {
    items: [], unreadCount: 0, filter: "all", source: "all", period: "all",
    search: "", open: false, busy: false, error: "", securitySync: "unknown", prefsDirty: false, evictedCount: 0,
  };
  // A click must not lose its read receipt just because a refresh or native
  // action is currently running. Read receipts wait for the existing request.
  const pendingReadIds = new Set();
  let readWriteInProgress = false;
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
  const hasActiveFilters = () =>
    state.filter !== "all" || state.source !== "all" || state.period !== "all" || Boolean(state.search);
  const countsSnapshot = () => {
    const current = active();
    return {
      all: current.length,
      unread: current.filter((n) => !n.readAt).length,
      important: current.filter((n) => n.severity !== "info").length,
      open: current.filter((n) => !n.resolvedAt && !n.acknowledgedAt).length,
      acknowledged: current.filter((n) => Boolean(n.acknowledgedAt) && !n.resolvedAt).length,
      resolved: current.filter((n) => Boolean(n.resolvedAt)).length,
      archived: state.items.filter((n) => Boolean(n.archivedAt)).length,
    };
  };
  const safeItems = (data) => {
    if (!data || !Array.isArray(data.items)) throw new Error("Invalid notification response");
    return data.items.slice(0, 300).filter((item) =>
      item && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 180 &&
      typeof item.title === "string" && typeof item.body === "string" && sources.includes(item.source) &&
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
  function addAction(container, text, action, id, ariaText, extraClass) {
    const button = element("button", "notification-mini-button" + (extraClass ? " " + extraClass : ""), text);
    button.type = "button";
    if (ariaText) button.setAttribute("aria-label", ariaText);
    button.addEventListener("click", () => mutate(action, id));
    button.disabled = state.busy;
    container.append(button);
  }
  // Parse only fixed native prefixes; legacy untyped incidents still resolve
  // their destination via the authenticated Access Manager request inventory.
  function pendingAccessTarget(item) {
    if (item.source !== "security" || !item.id.startsWith("mcp-pending:")) return null;
    let requestId = item.id.slice("mcp-pending:".length);
    let tab = null;
    if (requestId.startsWith("connections:")) {
      requestId = requestId.slice("connections:".length);
      tab = "connections";
    } else if (requestId.startsWith("mcp:")) {
      requestId = requestId.slice("mcp:".length);
      tab = "mcp";
    }
    if (!requestId || requestId.length > 150 || /[\x00-\x1f]/.test(requestId)) return null;
    return { requestId, tab };
  }
  // Use bounded run IDs only to focus an existing history row. Never put
  // untrusted IDs into a hash, selector, query, or native approval action.
  function runTarget(item) {
    if (item.source === "reminder" && item.id.startsWith("reminder:")) {
      const id = item.id.slice("reminder:".length);
      return id && id.length <= 160 && !/[\x00-\x1f]/.test(id) ? id : null;
    }
    if (item.source === "jobs" && item.id.startsWith("daemon-run:")) {
      for (const suffix of [
        ":Scheduled run needs attention",
        ":Scheduled notification delivery failed",
      ]) {
        if (!item.id.endsWith(suffix)) continue;
        const id = item.id.slice("daemon-run:".length, -suffix.length);
        return id && id.length <= 160 && !/[\x00-\x1f]/.test(id) ? id : null;
      }
    }
    return null;
  }
  function incidentRoute(item) {
    const base = destination[item.source];
    if (!base) return null;
    const pending = pendingAccessTarget(item);
    if (pending?.tab) return "security:" + pending.tab;
    if (runTarget(item)) return "history";
    switch (item.id) {
      case "health:muse": return "runtime:muse";
      case "health:telegram": return "settings:muse";
      case "health:channel-hosts": return "runtime:hosts";
      case "health:delegate-listener": return "delegate:diagnostics";
      default: return base;
    }
  }
  // Opening an incident marks it read even when the destination is another
  // Tray page. Navigate immediately; the native read receipt is persisted
  // separately and is queued when a refresh is already in flight.
  function openDestination(item) {
    const route = incidentRoute(item);
    if (!route) return;
    const pending = pendingAccessTarget(item);
    if (pending) {
      window.__superagentPendingAccessNotificationId = pending.requestId;
      window.__superagentPendingAccessNotificationTab = pending.tab;
    }
    const runId = runTarget(item);
    if (runId) window.__superagentPendingRunNotificationId = runId;
    let delivered = false;
    try {
      if (typeof window.navigateToPage === "function") {
        window.navigateToPage(route);
        delivered = true;
      } else if (window.location) {
        window.location.hash = "#" + route;
        delivered = true;
      }
    } catch { delivered = false; }
    if (!delivered) return; // Failed navigation must not silently mark read.
    close();
    // Native-owned, single-use receipt: JavaScript cannot mark an opened
    // incident read by claiming navigation alone. Old Tray builds fail closed.
    const call = window.__TAURI__?.core?.invoke;
    if (typeof call !== "function") return;
    void Promise.resolve().then(async () => {
      const ticket = await call("tray_notification_center_begin_navigation",
        { incidentId: item.id });
      if (!ticket || ticket.status !== "ISSUED" || ticket.route !== route ||
          typeof ticket.nonce !== "string") return;
      let targetFound = true;
      if (pending) {
        if (typeof window.__superagentAccessManagerFocusRequest !== "function") {
          for (let attempt = 0; attempt < 3 && typeof window.__superagentAccessManagerFocusRequest !== "function"; attempt += 1) {
            await Promise.resolve();
            if (typeof window.setTimeout === "function") {
              await new Promise((resolve) => window.setTimeout(resolve, 25));
            }
          }
        }
        const focus = window.__superagentAccessManagerFocusRequest;
        if (typeof focus !== "function") {
          targetFound = false;
        } else {
          const focused = await focus(pending.requestId, pending.tab);
          targetFound = focused?.targetFound === true;
        }
      }
      const receipt = await call("tray_notification_center_ack_navigation", {
        incidentId: item.id, nonce: ticket.nonce, route, targetFound,
      });
      if (receipt?.status === "DELIVERED" && receipt.route === route) {
        void refresh();
      } else {
        state.error = receipt?.status === "TARGET_EXPIRED"
          ? "Notification target expired or already handled. Incident remains unread."
          : receipt?.status === "BACKEND_UNAVAILABLE"
            ? "Core backend unavailable to verify target. Incident remains unread."
            : "Target incident could not be focused. Incident remains unread.";
        render();
      }
    }).catch(() => {
      state.error = "Native notification receipt unavailable. Incident remains unread.";
      render();
    });
  }
  function noteCard(item, compact) {
    const wrapper = element("article",
      "notification-item severity-" + item.severity +
      (item.readAt ? " is-read" : " is-unread") +
      (item.resolvedAt ? " is-resolved" : "") +
      (item.archivedAt ? " is-archived" : ""));
    const page = incidentRoute(item);
    if (page) wrapper.className += " is-navigable";
    wrapper.tabIndex = 0;
    // Every card body click or keyboard activation is an explicit read. Lifecycle
    // buttons do not accidentally navigate; their native actions mark read atomically.
    wrapper.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, a, input, select, textarea")) return;
      if (page) openDestination(item);
      else scheduleRead(item);
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (event.target && event.target !== wrapper &&
          event.target.closest?.("button, a, input, select, textarea")) return;
      event.preventDefault?.();
      if (page) openDestination(item);
      else scheduleRead(item);
    });
    const indicator = element("span", "notification-item-indicator");
    indicator.setAttribute("aria-hidden", "true");
    const copy = element("div", "notification-item-copy");
    const heading = element("div", "notification-item-heading");
    heading.append(element("h3", "", item.title));
    if (!item.readAt && !item.archivedAt) heading.append(element("span", "notification-item-new", "New"));
    heading.append(element("span", "notification-item-severity severity-" + item.severity, severityTag[item.severity]));
    heading.append(element("span", "notification-item-state", incidentState(item)));
    const meta = element("div", "notification-item-meta");
    meta.append(element("span", "notification-item-source", item.source.replaceAll("-", " ")));
    meta.append(element("span", "notification-item-dot", "·"));
    meta.append(element("span", "notification-item-time", formatTime(item.createdAt)));
    if (Number(item.occurrences) > 1) {
      meta.append(element("span", "notification-item-dot", "·"));
      meta.append(element("span", "notification-item-occurrences", item.occurrences + " occurrences"));
    }
    copy.append(heading, meta, element("p", "notification-item-text", item.body));
    const actions = element("div", "notification-item-actions");
    if (page) {
      const pending = pendingAccessTarget(item);
      const label = pending?.tab === "connections" ? "Review MCP Connections"
        : pending?.tab === "mcp" ? "Review MCP Project Access"
          : pending ? "Review pending access"
            : item.source === "security" ? "Open Security Approval"
              : "View " + page.replace(":", " · ").replaceAll("-", " ");
      const open = element("button", "notification-link", label);
      open.type = "button";
      open.disabled = state.busy;
      open.addEventListener("click", () => openDestination(item));
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
  function inboxStateCard(kind, headingText, detailText, actionLabel, onAction) {
    const card = element("div", "notification-state-card" + (kind ? " is-" + kind : ""));
    card.append(element("strong", "notification-state-title", headingText));
    card.append(element("p", "notification-state-detail", detailText));
    if (actionLabel && typeof onAction === "function") {
      const btn = element("button", "button secondary sm", actionLabel);
      btn.type = "button";
      btn.addEventListener("click", onAction);
      card.append(btn);
    }
    return card;
  }
  function resetFilters() {
    state.filter = "all";
    state.source = "all";
    state.period = "all";
    state.search = "";
    if ($("notification-search")) $("notification-search").value = "";
    if ($("notification-period")) $("notification-period").value = "all";
    if ($("notification-source")) $("notification-source").value = "all";
    render();
  }
  function render() {
    const count = state.unreadCount;
    const counts = countsSnapshot();
    const visibleItems = selected();
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
      inbox.setAttribute("aria-busy", String(state.busy));
      inbox.replaceChildren();
      if (state.error) {
        inbox.append(inboxStateCard("error", "Unable to load notifications", state.error, "Retry sync", () => refresh(true)));
      } else if (state.busy && !state.items.length) {
        inbox.append(empty("Loading incident history…"));
      } else if (!visibleItems.length) {
        if (hasActiveFilters()) {
          inbox.append(inboxStateCard("empty", "No matching events",
            "No notifications match the active filter, source, or search query.",
            "Reset filters", resetFilters));
        } else {
          inbox.append(inboxStateCard("empty", "All caught up",
            counts.archived > 0
              ? "No active events right now. Switch to Archived to inspect " + counts.archived + " older item" + (counts.archived === 1 ? "." : "s.")
              : "No active incidents or system notifications right now."));
        }
      } else {
        visibleItems.forEach((n) => inbox.append(noteCard(n, false)));
      }
    }
    const summary = $("notification-summary");
    if (summary) summary.textContent = count + " unread · " +
      active().filter((n) => !n.resolvedAt).length + " open · " +
      active().filter((n) => n.resolvedAt).length + " resolved · " +
      counts.archived + " archived" +
      (state.evictedCount ? " · " + state.evictedCount + " older events pruned" : "") +
      (state.securitySync === "unavailable" ? " · Security requests could not sync with Core" : "");
    const syncPill = $("notification-sync-pill");
    if (syncPill) {
      syncPill.setAttribute("data-state", state.securitySync === "ok" ? "ok" : state.securitySync === "unavailable" ? "warn" : "unknown");
      syncPill.textContent = state.securitySync === "ok"
        ? "Core synced"
        : state.securitySync === "unavailable"
          ? "Core sync unavailable"
          : "Local inbox";
    }
    for (const [key, val] of Object.entries(counts)) {
      const badge = $("notification-filter-count-" + key);
      if (badge) badge.textContent = String(val);
    }
    if ($("notification-kpi-unread")) $("notification-kpi-unread").textContent = String(counts.unread);
    if ($("notification-kpi-open")) $("notification-kpi-open").textContent = String(counts.open);
    if ($("notification-kpi-important")) $("notification-kpi-important").textContent = String(counts.important);
    if ($("notification-kpi-resolved")) $("notification-kpi-resolved").textContent = String(counts.resolved);
    document.querySelectorAll("[data-notification-quick-filter]").forEach((card) => {
      const activeCard = card.dataset.notificationQuickFilter === state.filter;
      card.classList.toggle("is-active", activeCard);
      card.setAttribute("aria-pressed", String(activeCard));
    });
    const viewLabel = $("notification-view-label");
    if (viewLabel) {
      viewLabel.textContent = state.error
        ? "Feed unavailable"
        : "Showing " + visibleItems.length + " event" + (visibleItems.length === 1 ? "" : "s");
    }
    const loadingPill = $("notification-loading-pill");
    if (loadingPill) loadingPill.hidden = !state.busy;
    const resetBtn = $("notification-reset-filters");
    if (resetBtn) resetBtn.hidden = !hasActiveFilters();
    const clearSearch = $("notification-search-clear");
    if (clearSearch) clearSearch.hidden = !state.search;
    const dirtyBadge = $("notification-prefs-dirty-badge");
    if (dirtyBadge) dirtyBadge.hidden = !state.prefsDirty;
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
    render();
    try {
      // Opening Notifications makes a fresh authenticated Core inventory
      // request; passive badge refreshes use only the native persisted inbox.
      // Neither route has an approval or grant mutation operation.
      let result;
      if (syncSecurity === true) {
        try {
          const call = window.__TAURI__?.core?.invoke;
          if (!call) throw new Error("Native synchronization unavailable");
          result = await call("tray_notification_center_refresh_security");
        } catch {
          // Older running Tray builds may not yet expose the new command.
          // Preserve the existing inbox rather than hiding critical incidents.
          result = { ...(await invoke("list")), securitySync: "unavailable" };
        }
      } else {
        result = await invoke("list");
      }
      if (!result) throw new Error("Native notification service unavailable");
      if (syncSecurity === true) state.securitySync = result.securitySync === "ok" ? "ok" : "unavailable";
      apply(result);
    } catch {
      if (syncSecurity === true) state.securitySync = "unavailable";
      state.error = "Cannot load notifications. Open the installed Tray or retry.";
      render();
    } finally { state.busy = false; render(); flushPendingReads(); finishOsActivation(); }
  }
  // Keep the click synchronous for navigation and coalesce repeated read
  // receipts until the native write has completed.
  function scheduleRead(item) {
    if (item.readAt || pendingReadIds.has(item.id)) return;
    pendingReadIds.add(item.id);
    flushPendingReads();
  }
  function flushPendingReads() {
    if (state.busy || readWriteInProgress || pendingReadIds.size === 0) return;
    const id = pendingReadIds.values().next().value;
    readWriteInProgress = true;
    void mutate("read", id).finally(() => {
      pendingReadIds.delete(id);
      readWriteInProgress = false;
      flushPendingReads();
    });
  }
  async function mutate(action, id) {
    if (state.busy) return;
    state.busy = true;
    render();
    try { apply(await invoke(action, id)); }
    catch {
      state.error = "Notification change could not be saved. Retry after checking Tray.";
    } finally { state.busy = false; render(); flushPendingReads(); }
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
    } finally { state.busy = false; render(); flushPendingReads(); }
  }
  function close() { state.open = false; render(); }
  function toggle() {
    state.open = !state.open;
    render();
    if (state.open) void refresh(true);
  }
  // Only a native-delivered, single-use OS activation may open a specific
  // incident. The HTML page cannot forge a toast ID or replay a consumed click.
  let pendingOsIncidentId = null;
  function finishOsActivation() {
    if (state.busy || !pendingOsIncidentId) return;
    const id = pendingOsIncidentId;
    pendingOsIncidentId = null;
    const item = state.items.find((entry) => entry.id === id &&
      !entry.archivedAt && !entry.resolvedAt);
    if (item) openDestination(item);
    else window.navigateToPage?.("notifications"); // no read receipt
  }
  async function takeOsActivation() {
    try {
      const pull = window.__TAURI__?.core?.invoke;
      if (typeof pull !== "function") return;
      const result = await pull("tray_notification_center_take_os_activation");
      if (result?.status !== "READY" || typeof result.incidentId !== "string" ||
          result.incidentId.length > 180) return;
      pendingOsIncidentId = result.incidentId;
      if (!state.busy) await refresh(true);
      finishOsActivation();
    } catch {
      // Failure to read native activation must not mark an incident read.
    }
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
    $("notification-retry")?.addEventListener("click", () => refresh(true));
    $("notification-reset-filters")?.addEventListener("click", resetFilters);
    $("notification-search-clear")?.addEventListener("click", () => {
      state.search = "";
      if ($("notification-search")) {
        $("notification-search").value = "";
        $("notification-search").focus();
      }
      render();
    });
    $("notification-save-preferences")?.addEventListener("click", savePrefs);
    document.querySelectorAll("[data-notification-filter]").forEach((button) =>
      button.addEventListener("click", () => {
        state.filter = button.dataset.notificationFilter;
        render();
      }));
    document.querySelectorAll("[data-notification-quick-filter]").forEach((card) =>
      card.addEventListener("click", () => {
        const next = card.dataset.notificationQuickFilter;
        state.filter = state.filter === next ? "all" : next;
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
    window.__TAURI__?.event?.listen?.("tray-notification-os-activate", () => {
      void takeOsActivation();
    });
    // Catch an OS click delivered before the WebView attached its listener.
    void takeOsActivation();
    window.__TAURI__?.event?.listen?.("tray-notifications-changed", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-started", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-stopped", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-start-failed", refresh);
    window.__TAURI__?.event?.listen?.("desktop-server-stop-failed", refresh);
    window.addEventListener("focus", () => { void refresh(true); });
    window.setInterval(refresh, 15000);
    void refresh();
  }
  // Reuse the same fixed source-to-tab registry for ephemeral Tray feedback.
  // This has no incident ID, so it never guesses an exact request or process.
  window.__superagentNotificationDefaultRoute = (source) =>
    typeof source === "string" && Object.hasOwn(destination, source) ? destination[source] : null;
  window.__superagentNotificationOpenScope = (source) => {
    const route = window.__superagentNotificationDefaultRoute(source);
    if (!route || typeof window.navigateToPage !== "function") return false;
    window.navigateToPage(route);
    return true;
  };
  window.__superagentNotificationsRefresh = () => refresh(true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
