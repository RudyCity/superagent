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
    items: [], history: [], digest: null, prefs: null, sourceLevels: {},
    unreadCount: 0, filter: "all", source: "all", device: "all", period: "all",
    grouped: false, search: "", open: false, busy: false, error: "", securitySync: "unknown", prefsDirty: false, evictedCount: 0,
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
    n.expiredAt ? "Expired" : n.resolvedAt ? "Resolved"
      : n.actionStartedAt ? "In progress"
        : n.acknowledgedAt ? "Acknowledged" : "Pending";
  const snoozed = (n) => Number(n.snoozedUntil) > Date.now();
  const deviceOf = (n) => n.deviceId || "unknown";
  const managed = (n) => n.id.startsWith("mcp-pending:") || n.id.startsWith("health:");
  const active = () => state.items.filter((n) => !n.archivedAt);
  // Action required is an incident state, not a read receipt. An acknowledged
  // warning still needs follow-up; a resolved incident is information/history.
  // Classification uses native severity/lifecycle metadata, never titles/body.
  const kindOf = (n) => !n.resolvedAt && n.severity !== "info" ? "action" : "information";
  const prioritized = () => active().slice().sort((a, b) =>
    (Number(kindOf(b) === "action" && !snoozed(b)) -
     Number(kindOf(a) === "action" && !snoozed(a))) ||
    (Number(kindOf(b) === "action") - Number(kindOf(a) === "action")));
  const selected = () => {
    let items = state.filter === "archived"
      ? state.items.filter((n) => n.archivedAt) : active();
    items = items.filter((n) => {
      if (state.filter === "action" && kindOf(n) !== "action") return false;
      if (state.filter === "information" && kindOf(n) !== "information") return false;
      if (state.filter === "in-progress" && (!n.actionStartedAt || n.resolvedAt)) return false;
      if (state.filter === "snoozed" && !snoozed(n)) return false;
      if (state.filter === "expired" && !n.expiredAt) return false;
      if (state.filter === "unread" && n.readAt) return false;
      if (state.filter === "important" && n.severity === "info") return false;
      if (state.filter === "open" && (n.resolvedAt || n.acknowledgedAt)) return false;
      if (state.filter === "acknowledged" && (!n.acknowledgedAt || n.resolvedAt)) return false;
      if (state.filter === "resolved" && !n.resolvedAt) return false;
      if (state.source !== "all" && n.source !== state.source) return false;
      if (state.device !== "all" && deviceOf(n) !== state.device) return false;
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
    state.filter !== "all" || state.source !== "all" || state.device !== "all" ||
    state.period !== "all" || Boolean(state.search);
  const countsSnapshot = () => {
    const current = active();
    return {
      all: current.length,
      unread: current.filter((n) => !n.readAt).length,
      action: current.filter((n) => kindOf(n) === "action").length,
      information: current.filter((n) => kindOf(n) === "information").length,
      snoozed: current.filter((n) => snoozed(n)).length,
      inProgress: current.filter((n) => Boolean(n.actionStartedAt) && !n.resolvedAt).length,
      "in-progress": current.filter((n) => Boolean(n.actionStartedAt) && !n.resolvedAt).length,
      expired: current.filter((n) => Boolean(n.expiredAt)).length,
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
      Object.hasOwn(severity, item.severity) &&
      (item.deviceId == null || (typeof item.deviceId === "string" &&
        /^[a-zA-Z0-9._-]{1,64}$/.test(item.deviceId))));
  };
  const readPrefs = (data) => {
    const prefs = data?.preferences;
    if (!prefs || !Array.isArray(prefs.categories) ||
      !["info", "warning", "critical"].includes(prefs.minSeverity) ||
      ![7, 30, 90].includes(prefs.retentionDays)) return null;
    return prefs;
  };
  function displayPrefs(prefs) {
    if (!prefs) return;
    state.prefs = prefs;
    if (state.prefsDirty) return;
    state.sourceLevels = { ...(prefs.sourceLevels || {}) };
    const dnd = $("notification-dnd-mode");
    if (dnd) {
      dnd.value = prefs.dndEnabled
        ? (prefs.dndUntil ? "existing" : "indefinite") : "off";
      dnd.querySelector?.('option[value="existing"]')?.toggleAttribute?.("hidden", !prefs.dndEnabled || !prefs.dndUntil);
    }
    if ($("notification-dnd-critical-bypass")) $("notification-dnd-critical-bypass").checked = prefs.dndCriticalBypass !== false;
    if ($("notification-digest-enabled")) $("notification-digest-enabled").checked = prefs.digestEnabled === true;
    renderRuleList();
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
    state.history = Array.isArray(data.history) ? data.history.slice(0, 120).filter((event) =>
      event && typeof event.action === "string" && typeof event.source === "string" &&
      sources.includes(event.source) && Number.isFinite(Number(event.at))) : [];
    state.digest = data.digest || null;
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
        const focus = window.__superagentAccessManagerFocusRequest;
        if (typeof focus !== "function") return;
        const focused = await focus(pending.requestId, pending.tab);
        targetFound = focused?.targetFound === true;
      }
      if (!targetFound) return;
      const receipt = await call("tray_notification_center_ack_navigation", {
        incidentId: item.id, nonce: ticket.nonce, route, targetFound,
      });
      if (receipt?.status === "DELIVERED" && receipt.route === route) {
        void refresh();
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
    // Every card body click is an explicit read. Lifecycle buttons do not
    // accidentally navigate; their native actions mark read atomically.
    wrapper.addEventListener("click", (event) => {
      if (event.target?.closest?.("button, a, input, select, textarea")) return;
      if (page) openDestination(item);
      else scheduleRead(item);
    });
    const indicator = element("span", "notification-item-indicator");
    indicator.setAttribute("aria-hidden", "true");
    const copy = element("div", "notification-item-copy");
    const heading = element("div", "notification-item-heading");
    heading.append(element("h3", "", item.title));
    if (!item.readAt && !item.archivedAt) heading.append(element("span", "notification-item-new", "New"));
    heading.append(element("span", "notification-item-kind is-" + kindOf(item),
      kindOf(item) === "action" ? "Action required" : "Information"));
    heading.append(element("span", "notification-item-severity severity-" + item.severity, severityTag[item.severity]));
    heading.append(element("span", "notification-item-state", incidentState(item)));
    if (snoozed(item)) heading.append(element("span", "notification-item-snoozed",
      "Snoozed until " + formatTime(item.snoozedUntil)));
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
      if (!item.resolvedAt && kindOf(item) === "action") {
        if (!item.acknowledgedAt) {
          addAction(actions, "Acknowledge", "acknowledge", item.id, "Acknowledge: " + item.title);
        }
        addAction(actions, item.actionStartedAt ? "Pause work" : "Start working",
          item.actionStartedAt ? "pause-work" : "in-progress", item.id);
        if (snoozed(item)) {
          addAction(actions, "Unsnooze", "unsnooze", item.id);
        } else {
          const snooze = element("select", "notification-snooze-select");
          snooze.setAttribute("aria-label", "Snooze " + item.title);
          [["", "Snooze…"], ["snooze-15m", "15 minutes"],
            ["snooze-1h", "1 hour"], ["snooze-1d", "24 hours"]]
            .forEach(([value, label]) => {
              const option = element("option", "", label);
              option.value = value;
              snooze.append(option);
            });
          snooze.addEventListener("change", (event) => {
            const action = event.target?.value;
            if (["snooze-15m", "snooze-1h", "snooze-1d"].includes(action)) void mutate(action, item.id);
          });
          snooze.disabled = state.busy;
          actions.append(snooze);
        }
      }
      if (!managed(item)) {
        addAction(actions, item.resolvedAt ? "Reopen" : "Resolve",
          item.resolvedAt ? "reopen" : "resolve", item.id);
      } else {
        actions.append(element("span", "notification-managed-hint", "Verified status from Core"));
      }
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
  function renderGrouped(items, parent) {
    if (!state.grouped) {
      items.forEach((item) => parent.append(noteCard(item, false)));
      return;
    }
    const groups = new Map();
    for (const item of items) {
      const key = kindOf(item) + ":" + item.source;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [key, members] of groups) {
      if (members.length === 1) { parent.append(noteCard(members[0], false)); continue; }
      const group = element("details", "notification-group");
      group.open = key.startsWith("action:");
      group.append(element("summary", "notification-group-title",
        key.replace(":", " · ").replaceAll("-", " ") + " · " + members.length + " events"));
      const content = element("div", "notification-group-items");
      // Never combine separate permission cards into a single approval action.
      members.forEach((item) => content.append(noteCard(item, false)));
      group.append(content);
      parent.append(group);
    }
  }
  function renderRuleList() {
    const list = $("notification-source-rules");
    if (!list) return;
    list.replaceChildren();
    for (const [source, level] of Object.entries(state.sourceLevels)) {
      const line = element("div", "notification-rule-row");
      line.append(element("span", "", source.replaceAll("-", " ") + " · " + level));
      const remove = element("button", "notification-mini-button", "Remove");
      remove.type = "button";
      remove.addEventListener("click", () => {
        delete state.sourceLevels[source];
        state.prefsDirty = true;
        renderRuleList();
        render();
      });
      line.append(remove);
      list.append(line);
    }
    if (!Object.keys(state.sourceLevels).length) list.append(empty("Using the global severity rule for all sources."));
  }
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
    state.device = "all";
    if ($("notification-device")) $("notification-device").value = "all";
    render();
  }
  function render() {
    const count = state.unreadCount;
    const counts = countsSnapshot();
    const visibleItems = selected();
    const actionBadge = $("tray-notification-action-count");
    if (actionBadge) {
      actionBadge.hidden = counts.action === 0;
      actionBadge.textContent = String(counts.action > 99 ? "99+" : counts.action);
      actionBadge.setAttribute("aria-label", counts.action + " actions required");
    }
    for (const el of [$("tray-notification-count"), $("nav-notifications-count")]) {
      if (!el) continue;
      el.hidden = count === 0;
      el.textContent = count > 99 ? "99+" : String(count);
    }
    const bell = $("tray-notification-bell");
    if (bell) {
      bell.setAttribute("aria-label", "Notifications, " + count + " unread, " +
        counts.action + " require action");
      bell.setAttribute("aria-expanded", String(state.open));
    }
    const popup = $("tray-notification-popover");
    if (popup) popup.hidden = !state.open;
    const popoverSummary = $("tray-notification-category-summary");
    if (popoverSummary) popoverSummary.textContent =
      counts.action + " need action · " + counts.information + " information";
    const recent = $("tray-notification-recent");
    if (recent) {
      recent.replaceChildren();
      if (state.error) recent.append(empty(state.error));
      else if (!active().length) recent.append(empty("You're all caught up. No current notifications."));
      else prioritized().slice(0, 5).forEach((n) => recent.append(noteCard(n, true)));
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
        renderGrouped(visibleItems, inbox);
      }
    }
    const device = $("notification-device");
    if (device) {
      const old = device.value || state.device;
      const choices = Array.from(new Set(state.items.map(deviceOf))).sort();
      device.replaceChildren();
      for (const [id, label] of [["all", "All devices"], ...choices.map((id) =>
        [id, id === "local" ? "This computer" : id === "unknown" ? "Unspecified device" : id])]) {
        const option = element("option", "", label);
        option.value = id;
        device.append(option);
      }
      device.value = choices.includes(old) || old === "all" ? old : "all";
      if (state.device !== "all" && !choices.includes(state.device)) state.device = "all";
    }
    const history = $("notification-history-list");
    if (history) {
      history.replaceChildren();
      if (!state.history.length) history.append(empty("No recorded notification actions yet."));
      state.history.slice(0, 40).forEach((event) => {
        const line = element("div", "notification-history-line");
        line.append(element("span", "", formatTime(event.at)));
        line.append(element("strong", "", event.action.replaceAll("_", " ")));
        line.append(element("span", "", event.source.replaceAll("-", " ")));
        history.append(line);
      });
    }
    const digest = $("notification-digest-summary");
    if (digest) {
      const stats = state.digest;
      digest.textContent = stats
        ? (stats.last24hAction || 0) + " actions · " +
          (stats.last24hInformation || 0) + " information events in the last 24 hours" +
          (stats.lastSentAt ? " · Last delivered " + formatTime(stats.lastSentAt) : "")
        : "Daily summary not available.";
    }
    const grouping = $("notification-group-toggle");
    if (grouping) {
      grouping.textContent = state.grouped ? "Show individual events" : "Group by source";
      grouping.setAttribute("aria-pressed", String(state.grouped));
    }
    const summary = $("notification-summary");
    if (summary) summary.textContent = counts.action + " require action · " +
      counts.information + " informational · " + count + " unread · " +
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
    if ($("notification-kind-count-action")) $("notification-kind-count-action").textContent = String(counts.action);
    if ($("notification-kind-count-information")) $("notification-kind-count-information").textContent = String(counts.information);
    if ($("notification-kpi-unread")) $("notification-kpi-unread").textContent = String(counts.unread);
    if ($("notification-kpi-progress")) $("notification-kpi-progress").textContent = String(counts.inProgress);
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
    const mode = $("notification-dnd-mode")?.value || "off";
    const durations = { "15m": 900000, "1h": 3600000, "8h": 28800000, "24h": 86400000 };
    const dndEnabled = mode !== "off";
    const dndUntil = mode === "existing" ? (state.prefs?.dndUntil ?? null)
      : Object.hasOwn(durations, mode) ? Date.now() + durations[mode] : null;
    const digestEnabled = $("notification-digest-enabled")?.checked === true;
    const nextMorning = () => {
      const next = new Date();
      next.setHours(9, 0, 0, 0);
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      return next.getTime();
    };
    return {
      sourceLevels: { ...state.sourceLevels },
      dndEnabled, dndUntil,
      dndCriticalBypass: $("notification-dnd-critical-bypass")?.checked !== false,
      digestEnabled,
      digestNextAt: digestEnabled
        ? (state.prefs?.digestEnabled && state.prefs?.digestNextAt > Date.now()
          ? state.prefs.digestNextAt : nextMorning()) : null,
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
    $("notification-group-toggle")?.addEventListener("click", () => {
      state.grouped = !state.grouped;
      render();
    });
    $("notification-rule-add")?.addEventListener("click", () => {
      const source = $("notification-rule-source")?.value;
      const level = $("notification-rule-level")?.value;
      if (!sources.includes(source)) return;
      if (!["info", "warning", "critical", "off"].includes(level)) return;
      state.sourceLevels[source] = level;
      state.prefsDirty = true;
      renderRuleList();
      render();
    });
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
    $("notification-device")?.addEventListener("change", (event) => {
      state.device = event.target.value;
      render();
    });
    for (const id of ["notification-min-severity", "notification-os-critical",
      "notification-os-warnings", "notification-retention-days",
      "notification-dnd-mode", "notification-dnd-critical-bypass",
      "notification-digest-enabled"]) {
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
