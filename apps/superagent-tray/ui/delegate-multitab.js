"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state = { profiles: [], tasks: [], owners: [], counts: {},
    selected: null, fetching: false, submitting: false, blockedRequest: null,
    sessions: [], sessionsKnown: false, sessionsStale: false,
    statusError: false, statusKnown: false };
  const statuses = new Set(["queued", "sending", "monitoring"]);
  function elem(tag, cls = "", value = "") {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value) node.textContent = safeResult(value);
    return node;
  }
  function say(message, isError = false) {
    const label = $("multitab-feedback");
    if (!label) return;
    label.textContent = safeResult(message).slice(0, 400);
    label.className = isError ? "multitab-feedback error" : "delegate-hint text-secondary";
  }
  async function call(action, payload = {}) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") {
      return invoke("delegate_action", {
        action: action === "status" ? "orchestrator-status" : "orchestrator",
        payload: action === "status" ? null : { action, ...payload },
      });
    }
    const response = await fetch("/api/desktop/delegate/orchestrator", {
      method: action === "status" ? "GET" : "POST",
      headers: action === "status" ? {} : { "Content-Type": "application/json" },
      ...(action === "status" ? {} : { body: JSON.stringify({ action, ...payload }) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || "Multi-tab request rejected");
    return result;
  }
  async function command(action, payload) {
    const answer = await call(action, payload);
    if (answer?.success === false) throw new Error(answer.error || "Request rejected");
    return answer?.result ?? answer;
  }
  function selectedProfile() {
    return state.selected?.clientId || state.profiles[0]?.clientId || "";
  }
  function selectedTab() {
    const clientId = state.selected?.clientId;
    const tabId = state.selected?.tabId;
    return state.profiles.find(p => p.clientId === clientId)?.tabs
      ?.find(t => t.tabId === tabId) || null;
  }
  // A verified local Core status may include a sanitized CDP projection.
  // Older/stale backends remain UNKNOWN; never infer an unclaimed lease from
  // the absence of a usable response or render secret-bearing raw objects.
  const known = value => value !== undefined && value !== null && value !== "";
  const visible = (value, limit = 96) =>
    known(value) && (typeof value === "string" || typeof value === "number")
      ? String(value).slice(0, limit) : "unknown";
  function stamp(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "unknown";
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
  }
  function cdpSession(clientId, tabId) {
    return state.sessions.find(s => s && s.transport === "delegate" &&
      s.clientId === clientId && s.tabId === tabId) || null;
  }
  function line(parent, label, value, cls = "multitab-detail") {
    parent.append(elem("small", cls, label + ": " + value));
  }
  function taskState(clientId, tabId) {
    const tasks = state.tasks.filter(t =>
      t.clientId === clientId && t.tabId === tabId);
    return {
      queued: tasks.filter(t => t.state === "queued").length,
      active: tasks.filter(t => t.state === "sending" || t.state === "monitoring").length,
      review: tasks.filter(t =>
        ["uncertain", "interrupted", "needs_review"].includes(t.state)).length,
    };
  }
  function safeResult(value) {
    return String(value || "").slice(0, 500).replace(
      /\b(sessionToken|inviteToken|authorization)\b\s*[:=]\s*["']?[^\s"'};,]+/gi,
      (_, key) => key + "=[redacted]");
  }
  function workerId() {
    const raw = $("multitab-worker")?.value?.trim() || "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,63}$/.test(raw))
      throw new Error("Worker ID must be 1–64 letters/numbers and . _ : @ -");
    return raw;
  }
  function mustSelect() {
    const clientId = state.selected?.clientId, tabId = state.selected?.tabId;
    if (!clientId || !Number.isSafeInteger(tabId)) {
      throw new Error("Select an online ChatGPT tab first");
    }
    return { clientId, tabId };
  }
  function drawTabs() {
    const target = $("multitab-tabs");
    if (!target) return;
    target.replaceChildren();
    for (const profile of state.profiles) {
      const heading = elem("div", "multitab-profile-title", profile.label || profile.clientId);
      target.append(heading);
      if (profile.error) target.append(elem("p", "text-secondary", profile.error));
      for (const tab of profile.tabs || []) {
        const selected = state.selected?.clientId === profile.clientId &&
          state.selected?.tabId === tab.tabId;
        const row = elem("button", "multitab-tab" + (selected ? " selected" : ""));
        row.type = "button";
        row.append(elem("span", "multitab-name", "#" + tab.tabId + " · " +
          (tab.title || "ChatGPT")));
        const owner = state.owners.find(o => o.clientId === profile.clientId &&
          o.tabId === tab.tabId);
        row.append(elem("small", "multitab-status",
          visible(tab.status) +
          (tab.active === true ? " · active" : "")));
        line(row, "Orchestrator owner", owner ? visible(owner.workerId) : "unknown");
        const work = taskState(profile.clientId, tab.tabId);
        line(row, "Recent tasks: queued / active", work.queued + " queued · " + work.active + " active");
        if (work.review) line(row, "Recovery", work.review + " require review", "multitab-detail multitab-warning");
        const session = cdpSession(profile.clientId, tab.tabId);
        line(row, "CDP owner", session ? visible(session.agentId)
          : state.sessionsKnown ? "unclaimed" : "unknown");
        const members = Array.isArray(session?.participants)
          ? session.participants.slice(0, 16) : null;
        line(row, "Participants", members
          ? (members.length ? members.map(m => visible(m.agentId, 64) + " (" +
            (m.role === "observer" || m.role === "contributor" ? m.role : "unknown") + ")").join(", ") : "none reported")
          : state.sessionsKnown ? "none" : "unknown");
        line(row, "Lease expires", stamp(session?.expiresAt));
        line(row, "Heartbeat", "unknown");
        line(row, "Revision", session && Number.isSafeInteger(session.revision)
          ? String(session.revision) : "unknown");
        line(row, "CDP lock", typeof session?.lockBusy === "boolean"
          ? session.lockBusy ? "busy" : "idle" : "unknown");
        line(row, "CDP queue", Number.isSafeInteger(session?.queuedOperations) &&
          session.queuedOperations >= 0 ? String(session.queuedOperations) : "unknown");
        if (session && typeof session.sharing === "boolean")
          line(row, "Sharing", session.sharing ? "enabled" : "disabled");
        if (session?.recoveryRequired === true)
          line(row, "CDP recovery", "owner reauthorization required",
            "multitab-detail multitab-warning");
        if (state.sessionsStale)
          line(row, "CDP status", "stale — refresh required",
            "multitab-detail multitab-warning");
        row.addEventListener("click", () => {
          state.selected = { clientId: profile.clientId, tabId: tab.tabId };
          say("Selected " + profile.clientId + " / tab #" + tab.tabId);
          drawTabs();
        });
        target.append(row);
      }
    }
    if (!state.profiles.length) target.append(elem("p", "text-secondary",
      "No Chrome Delegate profile connected. Open the extension and reconnect."));
    else if (!state.profiles.some(p => p.tabs?.length))
      target.append(elem("p", "text-secondary", "No readable ChatGPT tabs."));
  }
  function drawTasks() {
    const target = $("multitab-tasks");
    if (!target) return;
    target.replaceChildren();
    const tasks = state.tasks.slice(0, 40);
    if (!tasks.length) target.append(elem("p", "text-secondary", "No tasks yet."));
    for (const task of tasks) {
      const card = elem("article", "multitab-task");
      card.append(elem("strong", "", String(task.title || task.workerId).slice(0, 100)));
      card.append(elem("small", "multitab-status",
        task.workerId + " · tab #" + task.tabId + " · " + task.state +
        " · priority " + task.priority));
      if (task.reason) card.append(elem("small", "multitab-status", String(task.reason).slice(0, 200)));
      if (["uncertain", "interrupted", "needs_review"].includes(task.state))
        line(card, "Recovery", "manual inspection required; never resend automatically",
          "multitab-detail multitab-warning");
      else if (task.state === "failed")
        line(card, "Recovery", "inspect failure before any new request",
          "multitab-detail multitab-warning");
      if (task.resultExcerpt) card.append(elem("p", "multitab-result",
        safeResult(task.resultExcerpt)));
      const actions = elem("div", "multitab-actions");
      if (task.state === "queued" || statuses.has(task.state)) {
        const cancel = elem("button", "button ghost sm", "Cancel monitoring");
        cancel.type = "button";
        cancel.addEventListener("click", () => void perform("cancel", { taskId: task.taskId },
          task.state === "queued"
            ? "Queued task cancelled before Send."
            : "Monitoring detached. ChatGPT generation has NOT been stopped."));
        actions.append(cancel);
      }
      if (task.state === "monitoring") {
        const stop = elem("button", "button ghost sm danger", "Stop generation");
        stop.type = "button";
        stop.addEventListener("click", async () => {
          if (!confirm("Explicitly stop ChatGPT generation in tab #" + task.tabId +
            "? This is separate from monitoring cancellation.")) return;
          await perform("stop-generation", { taskId: task.taskId },
            "Generation stopped explicitly in this tab.");
        });
        actions.append(stop);
      }
      if (["uncertain", "interrupted", "needs_review", "failed"].includes(task.state)) {
        const reconcile = elem("button", "button secondary sm", "Reconcile (read only)");
        reconcile.type = "button";
        reconcile.addEventListener("click", () => void perform("reconcile",
          { taskId: task.taskId }, "Reconciliation finished. No message was re-sent."));
        actions.append(reconcile);
      }
      if (task.state === "completed") {
        const forward = elem("button", "button secondary sm", "Forward to selected tab");
        forward.type = "button";
        forward.addEventListener("click", async () => {
          try {
            const dest = mustSelect();
            if (task.tabId === dest.tabId && task.clientId === dest.clientId)
              throw new Error("Choose another tab to review this result.");
            if (!confirm("Send the saved output excerpt from this worker to the selected tab for review?")) return;
            await perform("forward", { ...dest, workerId: workerId(),
              requestId: crypto.randomUUID(), sourceTaskId: task.taskId },
              "Review task queued for target tab.");
          } catch (error) { say(error.message || String(error), true); }
        });
        actions.append(forward);
      }
      card.append(actions);
      target.append(card);
    }
  }
  function draw() {
    const tabCount = state.profiles.reduce((n,p) =>
      n + (Array.isArray(p.tabs) ? p.tabs.length : 0), 0);
    $("multitab-count-tabs").textContent = state.statusKnown ? tabCount + " tabs" : "unknown tabs";
    const count = key => Number.isSafeInteger(state.counts[key]) && state.counts[key] >= 0
      ? state.counts[key] : null;
    const combined = (a, b) => count(a) === null || count(b) === null
      ? "unknown" : String(count(a) + count(b));
    $("multitab-count-active").textContent = combined("sending", "monitoring") + " running";
    $("multitab-count-queued").textContent =
      (count("queued") ?? "unknown") + " queued";
    $("multitab-count-unknown").textContent =
      combined("uncertain", "interrupted") + " uncertain";
    if (state.selected && !selectedTab()) state.selected = null;
    if (!state.selected) {
      const first = state.profiles.find(p => p.tabs?.length);
      if (first) state.selected = { clientId: first.clientId, tabId: first.tabs[0].tabId };
    }
    drawTabs();
    drawTasks();
  }
  async function refresh() {
    if (state.fetching) return;
    state.fetching = true;
    try {
      const snapshot = await call("status");
      if (!snapshot || snapshot.success === false) throw new Error(snapshot?.error || "Status unavailable");
      state.profiles = Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
      state.owners = Array.isArray(snapshot.owners) ? snapshot.owners : [];
      state.tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
      state.counts = snapshot.counts && typeof snapshot.counts === "object"
        ? snapshot.counts : {};
      // Old Core versions lack this inventory: missing != verified unclaimed.
      const receivedAt = snapshot.observedAt;
      const hasTimestamp = Number.isSafeInteger(receivedAt);
      const age = hasTimestamp ? Date.now() - receivedAt : 0;
      state.sessionsStale = hasTimestamp && (age > 30000 || age < -10000);
      const legacyShape = !hasTimestamp && snapshot.sessionsStatus === undefined;
      state.sessionsKnown = Array.isArray(snapshot.sessions) &&
        snapshot.sessionsStatus !== "unknown" && !state.sessionsStale &&
        (hasTimestamp || legacyShape);
      state.sessions = state.sessionsKnown ? snapshot.sessions : [];
      state.statusKnown = true;
      const wasError = state.statusError;
      state.statusError = false;
      if (Number.isSafeInteger(snapshot.maxConcurrent) &&
        snapshot.maxConcurrent >= 1 && snapshot.maxConcurrent <= 8 &&
        $("multitab-concurrency")) {
        $("multitab-concurrency").value = String(snapshot.maxConcurrent);
      }
      draw();
      if (wasError) say("Status restored. Polling is read-only.");
    } catch (error) {
      // Fail closed: do not keep stale owner/lease state visible as current.
      state.profiles = []; state.owners = []; state.tasks = [];
      state.sessions = []; state.sessionsKnown = false; state.sessionsStale = false;
      state.counts = {}; state.statusKnown = false;
      state.statusError = true;
      state.selected = null;
      draw();
      say("Cannot read multi-tab state: " + (error.message || error), true);
    }
    finally { state.fetching = false; }
  }
  async function perform(action, payload, success) {
    if (state.submitting) return;
    state.submitting = true;
    try {
      const result = await command(action, payload);
      say(success || (action + " accepted"));
      await refresh();
      return result;
    } catch (error) {
      say(action + ": " + (error.message || error) +
        ". Do not automatically retry an uncertain mutation.", true);
      return null;
    } finally {
      state.submitting = false;
    }
  }
  function wire() {
    $("multitab-refresh")?.addEventListener("click", () => void refresh());
    $("multitab-new-tab")?.addEventListener("click", async () => {
      const clientId = selectedProfile();
      if (!clientId) return say("No connected Chrome profile", true);
      const result = await perform("new-tab", { clientId }, "New tab created.");
      if (result?.tabId) state.selected = { clientId, tabId: result.tabId };
      await refresh();
    });
    $("multitab-claim")?.addEventListener("click", () => {
      try { void perform("claim", { ...mustSelect(), workerId: workerId() }, "Tab claimed"); }
      catch (error) { say(error.message || String(error), true); }
    });
    $("multitab-release")?.addEventListener("click", () => {
      try { void perform("release", { ...mustSelect(), workerId: workerId() }, "Tab released"); }
      catch (error) { say(error.message || String(error), true); }
    });
    $("multitab-concurrency")?.addEventListener("change", () =>
      void perform("set-concurrency", { maxConcurrent: Number($("multitab-concurrency").value) },
        "Concurrency updated (1–8)."));
    $("multitab-ack-send")?.addEventListener("click", () => {
      if (!state.blockedRequest) return say("No outstanding ambiguous submission.");
      if (!confirm("Have you inspected the task history and target chat to ensure you are not resending an uncertain request?"))
        return;
      state.blockedRequest = null;
      say("Acknowledged. This does not send or retry any task.");
    });
    $("multitab-enqueue")?.addEventListener("click", async () => {
      try {
        if (state.blockedRequest) {
          throw new Error("Last Send outcome was unknown. Refresh and inspect task history before any new submission.");
        }
        const message = $("multitab-message").value.trim();
        if (!message || message.length > 20000) throw new Error("Task must be 1–20,000 characters.");
        const tab = selectedTab();
        const chatId = /^https:\/\/chatgpt\.com\/c\/([A-Za-z0-9:_-]{8,180})(?:[/?#]|$)/
          .exec(String(tab?.url || ""))?.[1];
        const payload = { ...mustSelect(), workerId: workerId(), message,
          title: message.slice(0, 90), priority: Number($("multitab-priority").value),
          requestId: crypto.randomUUID(), ...(chatId ? { chatId } : {}) };
        state.blockedRequest = payload.requestId;
        const result = await perform("enqueue", payload,
          "Task queued. Selected tab will receive only one Send.");
        if (result?.taskId) {
          state.blockedRequest = null;
          $("multitab-message").value = "";
        }
      } catch (error) { say(error.message || String(error), true); }
    });
    $("multitab-parallel")?.addEventListener("click", async () => {
      try {
        if (state.blockedRequest)
          throw new Error("First inspect the uncertain Send outcome.");
        const clientId = selectedProfile();
        const tabs = state.profiles.find(p => p.clientId === clientId)?.tabs || [];
        const tabIds = tabs.filter(t => t.ready !== false).slice(0, 8).map(t => t.tabId);
        if (tabIds.length < 2) throw new Error("Need 2–8 ready ChatGPT tabs in one profile.");
        const goal = $("multitab-message").value.trim();
        if (!goal || goal.length > 5000)
          throw new Error("Parallel shared goal must contain 1–5,000 characters.");
        if (!confirm("Dispatch one task to each of " + tabIds.length +
          " tabs with independent Implementation/Testing/Security/Review roles?")) return;
        const requestId = crypto.randomUUID();
        state.blockedRequest = requestId;
        const result = await perform("parallel", { requestId, clientId, tabIds, goal },
          "Parallel tasks queued across " + tabIds.length + " tabs.");
        if (Array.isArray(result) && result.length === tabIds.length) {
          state.blockedRequest = null;
          $("multitab-message").value = "";
        }
      } catch (error) { say(error.message || String(error), true); }
    });
    $("multitab-aggregate")?.addEventListener("click", async () => {
      const completed = state.tasks.filter(t => t.state === "completed").slice(0, 16);
      if (!completed.length) return say("No completed results to aggregate.", true);
      const result = await perform("aggregate", { taskIds: completed.map(t => t.taskId) },
        "Results combined locally (not sent to ChatGPT).");
      if (result?.text !== undefined)
        $("multitab-aggregate-output").value = String(result.text);
    });
    setInterval(() => {
      const page = $("page-delegate");
      if (page && !page.hidden) void refresh();
    }, 10000);
  }
  window.__superagentMultiTabRefresh = refresh;
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", wire);
  else wire();
})();