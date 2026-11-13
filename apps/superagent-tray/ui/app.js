"use strict";

const $ = (id) => document.getElementById(id);
const state = { jobs: [], runs: [], editingId: null, loading: false, online: false };
let trayJobsRefreshTimer = null;

function trayConfigureJobsRefresh(seconds) {
  const interval = [15, 30, 60, 120].includes(seconds) ? seconds : 30;
  if (trayJobsRefreshTimer !== null) clearInterval(trayJobsRefreshTimer);
  trayJobsRefreshTimer = setInterval(refresh, interval * 1000);
}

const api = (action, payload) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("This application requires the Tauri desktop runtime.");
  return invoke("daemon_action", { action, payload: payload ?? null });
};

const escapeHtml = (str) => String(str ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const timeFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const dateTime = (ms) => ms ? timeFormat.format(new Date(ms)) : "-";

const fmtLocalInput = (date) => {
  const z = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${z(date.getMonth() + 1)}-${z(date.getDate())}T${z(date.getHours())}:${z(date.getMinutes())}`;
};

function toast(message, error = false) {
  window.TrayFeedback?.notify({
    kind: error ? "error" : "success",
    message: String(message).slice(0, 240),
    scope: "jobs",
  });
}

function errors(error) {
  const message = error instanceof Error ? error.message : String(error);
  // Only trusted local validation messages belong in toasts; never reveal
  // arbitrary daemon errors that might include credentials or private paths.
  const safe = /^(Both name|Autonomous Agent|Cron expression|One-time reminder|Please select|Invalid hour)/.test(message);
  toast(safe ? message : "Schedule action not verified. Check Core and form details.", true);
}

function jobType(job) {
  if (job.kind === "reminder") return "🔔 Reminder";
  if (job.kind === "system-memory-retention-sweep") return "🔒 System";
  return "✦ Agent";
}

function drawJobs() {
  const filter = $("filter").value;
  const jobs = [...state.jobs].filter((job) => filter === "all" ||
    (filter === "enabled" ? job.enabled : (job.kind || "agent") === filter))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) ||
      (a.nextRun || Infinity) - (b.nextRun || Infinity));

  $("stat-total").textContent = String(state.jobs.length);
  $("stat-active").textContent = String(state.jobs.filter((j) => j.enabled).length);

  const next = state.jobs.filter((j) => j.enabled && j.kind === "reminder" && j.nextRun > Date.now())
    .sort((a, b) => a.nextRun - b.nextRun)[0];
  $("stat-next").textContent = next ? dateTime(next.nextRun) : "None scheduled";

  if (!jobs.length) {
    $("job-table").innerHTML = '<tr><td colspan="5" class="empty-state">No schedules found for this filter. Click "New Schedule" to create one.</td></tr>';
    return;
  }

  $("job-table").innerHTML = jobs.map((job) => `<tr>
    <td>
      <div class="job-name-cell">
        <span class="job-name">${escapeHtml(job.name)}</span>
        <span class="job-desc">${escapeHtml(jobType(job))} · ${escapeHtml(job.prompt || "")}</span>
      </div>
    </td>
    <td>
      <div>${escapeHtml(job.maxRuns && job.maxRuns - (job.runCount || 0) === 1 ? "1 run remaining" : job.cronExpression)}</div>
      <div class="job-cron-badge">${escapeHtml(job.cronExpression)}</div>
    </td>
    <td>
      <span class="job-next-date">${job.enabled ? escapeHtml(dateTime(job.nextRun)) : "-"}</span>
    </td>
    <td>
      <span class="pill ${job.enabled ? "" : "paused"}">
        <span class="pill-dot"></span>
        ${job.enabled ? "Active" : "Paused"}
      </span>
    </td>
    <td>
      <div class="row-actions">
        <button type="button" data-action="edit" data-id="${escapeHtml(job.id)}" aria-label="Edit ${escapeHtml(job.name)}">Edit</button>
        <button type="button" data-action="toggle" data-id="${escapeHtml(job.id)}">${job.enabled ? "Pause" : "Resume"}</button>
        <button type="button" data-action="run" data-id="${escapeHtml(job.id)}" title="Run once now">▶ Run</button>
        <button type="button" data-action="delete" data-id="${escapeHtml(job.id)}" class="danger" title="Delete schedule">✕</button>
      </div>
    </td>
  </tr>`).join("");
}

function drawRuns() {
  const names = new Map(state.jobs.map((job) => [job.id, job.name]));
  const runs = [...state.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);

  $("runs").innerHTML = runs.length ? runs.map((run) => `<li>
    <div>
      <span class="run-name">${escapeHtml(names.get(run.jobId) || run.jobId)}</span>
      <span class="run-meta"> · ${escapeHtml(dateTime(run.completedAt || run.startedAt))}</span>
    </div>
    <span class="status-badge status-${["success", "error", "running"].includes(run.status) ? run.status : "running"}">
      ${escapeHtml(run.status)}
    </span>
  </li>`).join("") : '<li class="empty-state">No execution activity recorded yet.</li>';
}

function connection(isOnline, message) {
  state.online = isOnline;
  $("connection-dot").classList.toggle("offline", !isOnline);
  $("connection-text").textContent = isOnline ? "Core Connected" : "Core Disconnected";
  $("connection-detail").textContent = isOnline
    ? `127.0.0.1:${window.__SUPERAGENT_CORE_PORT || "selected"} · Secured via Rust IPC`
    : String(message || "Core is offline").slice(0, 180);
  const startBtn = $("btn-start-core");
  if (startBtn) {
    startBtn.hidden = isOnline;
  }
}

function setBanner(message, buttonText, action) {
  const banner = $("banner");
  banner.replaceChildren();
  if (message) {
    const textNode = document.createElement("span");
    textNode.textContent = message;
    banner.append(textNode);
    if (buttonText && action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = buttonText;
      button.addEventListener("click", action);
      banner.append(button);
    }
  }
  banner.hidden = !message;
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  $("refresh-btn").disabled = true;

  try {
    const [status, jobs, runs] = await Promise.all([
      api("status"), api("list"), api("runs"),
    ]);
    connection(true);
    state.jobs = jobs.jobs || [];
    state.runs = runs.runs || [];
    drawJobs();
    drawRuns();

    if (!status.running) {
      setBanner("Scheduler is currently stopped. Scheduled reminders will not fire until started.", "Start Scheduler", async () => {
        try {
          await api("start");
          toast("Daemon scheduler has been started.");
          await refresh();
        } catch (e) {
          errors(e);
        }
      });
    } else {
      setBanner("");
    }
  } catch (error) {
    connection(false, error);
    setBanner("SuperAgent Core is unreachable. Ensure Core is running via: bun dist/cli.js --server 7888");
    $("job-table").innerHTML = '<tr><td colspan="5" class="empty-state">Cannot load schedules while Core is offline.</td></tr>';
    $("stat-total").textContent = $("stat-active").textContent = $("stat-next").textContent = "-";
    state.jobs = [];
    state.runs = [];
    drawRuns();
  } finally {
    state.loading = false;
    $("refresh-btn").disabled = false;
  }
}

function updateKinds() {
  const isAgent = $("kind").value === "agent";
  $("workspace-label").hidden = !isAgent;
  $("prompt-label").textContent = isAgent ? "Agent Instructions" : "Reminder Message";
  $("prompt").placeholder = isAgent
    ? "e.g. Summarize repository git status without mutating files"
    : "e.g. Weekly team sync in 5 minutes";
}

function updateFrequency() {
  const freq = $("frequency").value;
  $("once-field").hidden = freq !== "once";
  $("time-field").hidden = freq === "once" || freq === "custom";
  $("weekday-field").hidden = freq !== "weekly";
  $("custom-field").hidden = freq !== "custom";

  $("repeat-info").textContent = freq === "once"
    ? "Runs once at the target time, then automatically pauses."
    : freq === "daily"
    ? "Repeats every day at the selected time in local Core timezone."
    : freq === "weekly"
    ? "Repeats every week on the selected day."
    : "Uses standard five-field cron syntax. Evaluated in local Core timezone.";
}

function openEditor(job = null, preferredKind = "reminder") {
  state.editingId = job?.id || null;
  $("job-form").reset();
  $("form-title").textContent = job ? "Edit Schedule" : "Create New Schedule";
  $("save-form").textContent = job ? "Save Changes" : "Save Schedule";
  $("kind").disabled = Boolean(job);
  $("kind").value = job ? job.kind || "agent" : preferredKind;
  $("name").value = job?.name || "";
  $("prompt").value = job?.prompt || "";
  $("workspace").value = job?.workspace || "";
  $("job-enabled").checked = job ? job.enabled : true;
  $("frequency").value = job ? "custom" : "once";
  $("cron").value = job?.cronExpression || "";
  $("once-at").value = fmtLocalInput(new Date(Date.now() + 60 * 60 * 1000));
  $("at-time").value = "09:00";

  if (job?.maxRuns && job.maxRuns - (job.runCount || 0) === 1 && job.nextRun && job.nextRun > Date.now()) {
    $("frequency").value = "once";
    $("once-at").value = fmtLocalInput(new Date(job.nextRun));
  }

  updateKinds();
  updateFrequency();
  $("dialog").hidden = false;
  $("name").focus();
}

function closeEditor() {
  $("dialog").hidden = true;
  state.editingId = null;
}

function buildCron() {
  const freq = $("frequency").value;
  if (freq === "custom") {
    const expression = $("cron").value.trim().replace(/\s+/g, " ");
    if (expression.split(" ").length !== 5) {
      throw new Error("Cron expression must contain exactly five fields.");
    }
    return { cronExpression: expression, maxRuns: null };
  }
  if (freq === "once") {
    const date = new Date($("once-at").value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + 30_000) {
      throw new Error("One-time reminder must be scheduled at least 30 seconds into the future.");
    }
    return {
      cronExpression: `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`,
      maxRuns: 1,
    };
  }

  const match = /^(\d{2}):(\d{2})$/.exec($("at-time").value);
  if (!match) throw new Error("Please select a valid execution time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Invalid hour or minute specified.");

  if (freq === "daily") {
    return { cronExpression: `${minute} ${hour} * * *`, maxRuns: null };
  }
  return { cronExpression: `${minute} ${hour} * * ${$("weekday").value}`, maxRuns: null };
}

async function saveForm(event) {
  event.preventDefault();
  if (window.TrayFeedback?.isPending("jobs:save")) return;
  const name = $("name").value.trim();
  const prompt = $("prompt").value.trim();
  if (!name || !prompt) return errors("Both name and message/instructions are required.");
  if ($("kind").value === "agent" && !$("workspace").value.trim()) {
    return errors("Autonomous Agent tasks require a valid workspace directory.");
  }

  let schedule;
  try {
    schedule = buildCron();
  } catch (error) {
    return errors(error);
  }

  const payload = {
    name,
    prompt,
    cronExpression: schedule.cronExpression,
    enabled: $("job-enabled").checked,
    ...($("kind").value === "agent" ? { workspace: $("workspace").value.trim() } : {}),
  };

  if (state.editingId) {
    payload.id = state.editingId;
    const previous = state.jobs.find((job) => job.id === state.editingId);
    payload.maxRuns = schedule.maxRuns === 1 ? (previous?.runCount || 0) + 1 : null;
  } else {
    payload.kind = $("kind").value;
    if (schedule.maxRuns !== null) payload.maxRuns = schedule.maxRuns;
  }

  const ticket = window.TrayFeedback?.begin({
    key: "jobs:save", button: $("save-form"), label: "Saving schedule…",
  });
  $("save-form").disabled = true;
  try {
    const reply = await api(state.editingId ? "update" : "create", payload);
    if (reply?.success === false) throw Error("Schedule mutation not verified");
    toast(state.editingId ? "Schedule updated successfully." : "Schedule created successfully.");
    closeEditor();
    await refresh();
  } catch (error) {
    errors(error);
  } finally {
    $("save-form").disabled = false;
    ticket?.end();
  }
}

async function onRowClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const job = state.jobs.find((j) => j.id === button.dataset.id);
  if (!job) return;

  const action = button.dataset.action;
  if (action === "edit") {
    if (job.kind === "system-memory-retention-sweep") {
      return errors("Internal system maintenance jobs cannot be edited from desktop.");
    }
    return openEditor(job);
  }

  if (action === "delete" && !window.confirm(`Permanently delete "${job.name}"? This action cannot be undone.`)) {
    return;
  }
  if (action === "run" && !window.confirm(`Execute "${job.name}" now? Agent tasks will execute tools according to SuperAgent safety policies.`)) {
    return;
  }

  const ticket = window.TrayFeedback?.begin({
    key: "jobs:action:" + job.id, button, label: action === "run"
      ? "Starting run…" : action === "delete" ? "Deleting…" : "Updating…",
  });
  if (window.TrayFeedback && !ticket) return;
  button.disabled = true;
  try {
    if (action === "toggle") await api("update", { id: job.id, enabled: !job.enabled });
    if (action === "delete") await api("delete", { id: job.id });
    if (action === "run") await api("run", { id: job.id });
    toast(action === "delete" ? "Schedule deleted." : action === "run" ? "Execution started; check history." : "Schedule status updated.");
    await refresh();
  } catch (error) {
    errors(error);
  } finally {
    button.disabled = false;
    ticket?.end();
  }
}

function navigateToPage(pageId) {
  const validPages = ["jobs", "runtime", "history", "logs", "delegate", "terminal", "muse-files", "lan-devices", "updates", "settings"];
  const target = validPages.includes(pageId) ? pageId : "jobs";

  if (window.location.hash !== `#${target}`) {
    if (typeof history.replaceState === "function") {
      history.replaceState(null, "", `#${target}`);
    } else {
      window.location.hash = `#${target}`;
    }
  }

  document.querySelectorAll(".sidebar .nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.page === target);
  });

  document.querySelectorAll(".page-view").forEach((view) => {
    const isCurrent = view.id === `page-${target}`;
    view.hidden = !isCurrent;
    view.classList.toggle("active", isCurrent);
  });

  const topEyebrow = $("top-eyebrow");
  const topTitle = $("top-title");
  const topDesc = $("top-desc");
  const actionsJobs = $("actions-jobs");
  const actionsRuntime = $("actions-runtime");
  const actionsHistory = $("actions-history");
  const actionsLogs = $("actions-logs");
  const actionsDelegate = $("actions-delegate");
  const actionsTerminal = $("actions-terminal");
  const actionsMuseFiles = $("actions-muse-files");
  const actionsLanDevices = $("actions-lan-devices");
  const actionsUpdates = $("actions-updates");

  // Every page first hides all other page-specific actions.
  if (actionsJobs) actionsJobs.hidden = true;
  if (actionsRuntime) actionsRuntime.hidden = true;
  if (actionsHistory) actionsHistory.hidden = true;
  if (actionsLogs) actionsLogs.hidden = true;
  if (actionsDelegate) actionsDelegate.hidden = true;
  if (actionsTerminal) actionsTerminal.hidden = true;
  if (actionsMuseFiles) actionsMuseFiles.hidden = true;
  if (actionsLanDevices) actionsLanDevices.hidden = true;
  if (actionsUpdates) actionsUpdates.hidden = true;

  if (target === "jobs") {
    if (topEyebrow) topEyebrow.textContent = "AUTOMATION CONSOLE";
    if (topTitle) topTitle.textContent = "Schedules & Reminders";
    if (topDesc) topDesc.textContent = "Manage background cron jobs, native reminders, and active schedules.";
    if (actionsJobs) actionsJobs.hidden = false;
  } else if (target === "runtime") {
    if (topEyebrow) topEyebrow.textContent = "SYSTEM INVENTORY";
    if (topTitle) topTitle.textContent = "Runtime Detection";
    if (topDesc) topDesc.textContent = "Inspect authenticated Core APIs, CLI sessions, MCP servers, and tunnel connections.";
    if (actionsRuntime) actionsRuntime.hidden = false;
    if (typeof window.__superagentRuntimeRefresh === "function") {
      window.__superagentRuntimeRefresh();
    }
    window.__superagentLifecycleRefresh?.();
  } else if (target === "history") {
    if (topEyebrow) topEyebrow.textContent = "AUDIT LEDGER";
    if (topTitle) topTitle.textContent = "Execution History";
    if (topDesc) topDesc.textContent = "Review recent execution outcomes from the SuperAgent daemon run ledger.";
    if (actionsHistory) actionsHistory.hidden = false;
  } else if (target === "logs") {
    if (topEyebrow) topEyebrow.textContent = "REAL-TIME TELEMETRY";
    if (topTitle) topTitle.textContent = "Connection Logs";
    if (topDesc) topDesc.textContent =
      "Inspect inbound and outbound connections, WebSocket sessions, MCP tool calls, and tunnel events.";
    if (actionsLogs) actionsLogs.hidden = false;
    if (typeof window.__superagentLogsRefresh === "function") {
      window.__superagentLogsRefresh();
    }
  } else if (target === "delegate") {
    if (topEyebrow) topEyebrow.textContent = "BROWSER ORCHESTRATION";
    if (topTitle) topTitle.textContent = "Chrome Delegate Management";
    if (topDesc) topDesc.textContent =
      "Manage connected Chrome extensions, pairing codes, active browser profiles, and WebSocket bridge sessions.";
    if (actionsDelegate) actionsDelegate.hidden = false;
    if (typeof window.__superagentDelegateRefresh === "function") {
      window.__superagentDelegateRefresh();
    }
  } else if (target === "terminal") {
    if (topEyebrow) topEyebrow.textContent = "PROCESS SUPERVISOR";
    if (topTitle) topTitle.textContent = "Terminal Processes";
    if (topDesc) topDesc.textContent =
      "Inspect, monitor stdout logs, and manage running terminal commands and background subprocesses.";
    if (actionsTerminal) actionsTerminal.hidden = false;
    if (typeof window.__superagentTerminalRefresh === "function") {
      window.__superagentTerminalRefresh();
    }
  } else if (target === "muse-files") {
    if (topEyebrow) topEyebrow.textContent = "SECURE FILE DELIVERY";
    if (topTitle) topTitle.textContent = "Muse File Transfer";
    if (topDesc) topDesc.textContent =
      "Send documents to Muse, monitor checksum-verified delivery, resume interrupted uploads, and review history.";
    if (actionsMuseFiles) actionsMuseFiles.hidden = false;
    window.__superagentMuseFilesRefresh?.();
  } else if (target === "lan-devices") {
    if (topEyebrow) topEyebrow.textContent = "PRIVATE NETWORK SUPPORT";
    if (topTitle) topTitle.textContent = "LAN Devices";
    if (topDesc) topDesc.textContent = "Discover, pair and support Windows laptops on the same physical local network.";
    if (actionsLanDevices) actionsLanDevices.hidden = false;
    window.__superagentLanRefresh?.();
  } else if (target === "updates") {
    if (topEyebrow) topEyebrow.textContent = "VERIFIED DISTRIBUTION";
    if (topTitle) topTitle.textContent = "Updates & Releases";
    if (topDesc) topDesc.textContent = "Compare versions, verify checksum, and download the official package on your own terms.";
    if (actionsUpdates) actionsUpdates.hidden = false;
    window.__superagentUpdatesRefresh?.();
  } else if (target === "settings") {
    if (topEyebrow) topEyebrow.textContent = "TRAY PREFERENCES";
    if (topTitle) topTitle.textContent = "Tray Settings";
    if (topDesc) topDesc.textContent =
      "Configure local startup, notifications, window behavior and polling intervals.";
  }
}
window.navigateToPage = navigateToPage;

function install() {
  $("timezone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("new-btn")?.addEventListener("click", () => openEditor());
  $("refresh-btn")?.addEventListener("click", refresh);
  $("history-refresh-btn")?.addEventListener("click", refresh);
  $("filter")?.addEventListener("change", drawJobs);
  $("job-table")?.addEventListener("click", onRowClick);
  $("close-form")?.addEventListener("click", closeEditor);
  $("cancel-form")?.addEventListener("click", closeEditor);

  $("dialog")?.addEventListener("click", (e) => {
    if (e.target === $("dialog")) closeEditor();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("dialog").hidden) {
      closeEditor();
    }
  });

  $("frequency")?.addEventListener("change", updateFrequency);
  $("kind")?.addEventListener("change", updateKinds);
  $("job-form")?.addEventListener("submit", saveForm);

  const startBtn = $("btn-start-core");
  if (startBtn) {
    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      const originalHtml = startBtn.innerHTML;
      startBtn.innerHTML = `<span>Starting Core (:7888)...</span>`;
      try {
        const invoke = window.__TAURI__?.core?.invoke;
        if (!invoke) throw new Error("Tauri IPC is not available");
        const res = await invoke("start_core_server", { port: 7888 });
        toast(res?.message || "Core server started");
        await refresh();
        if (typeof runtimeRefresh === "function") await runtimeRefresh();
      } catch (err) {
        errors(err);
      } finally {
        startBtn.disabled = false;
        startBtn.innerHTML = originalHtml;
      }
    });
  }

  window.__TAURI__?.event?.listen?.("desktop-server-started", async () => {
    await refresh();
    if (typeof runtimeRefresh === "function") await runtimeRefresh();
  });

  window.addEventListener("superagent-core-selected", refresh);

  // Sidebar navigation links
  document.querySelectorAll(".sidebar .nav-link").forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const page = link.dataset.page;
      if (page) navigateToPage(page);
    });
  });

  window.addEventListener("hashchange", () => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) navigateToPage(hash);
  });

  window.__TAURI__?.event?.listen?.("desktop-open-runtime", () => {
    navigateToPage("runtime");
  });

  window.__TAURI__?.event?.listen?.("desktop-open-logs", () => {
    navigateToPage("logs");
  });

  window.__TAURI__?.event?.listen?.("desktop-open-delegate", () => {
    navigateToPage("delegate");
  });

  window.__TAURI__?.event?.listen?.("desktop-open-terminal", () => {
    navigateToPage("terminal");
  });

  window.__TAURI__?.event?.listen?.("desktop-open-muse-files", () => {
    navigateToPage("muse-files");
  });
  window.__TAURI__?.event?.listen?.("desktop-open-lan-devices", () => {
    navigateToPage("lan-devices");
  });
  window.__TAURI__?.event?.listen?.("desktop-open-updates", () => {
    navigateToPage("updates");
  });
  window.__TAURI__?.event?.listen?.("desktop-open-settings", () => {
    navigateToPage("settings");
  });

  window.__TAURI__?.event?.listen?.("desktop-create-reminder", () => {
    navigateToPage("jobs");
    openEditor(null, "reminder");
  });

  const initialHash = window.location.hash.replace(/^#/, "");
  window.__superagentTrayHadInitialHash = Boolean(initialHash);
  navigateToPage(initialHash || "jobs");

  window.addEventListener("tray-settings-changed", (event) => {
    trayConfigureJobsRefresh(event.detail?.jobsRefreshSeconds);
  });
  window.__TAURI__?.core?.invoke?.("get_tray_version")
    .then((version) => {
      const el = $("tray-version");
      if (el && typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
        el.textContent = `Version ${version}`;
      }
    })
    .catch(() => {});
  window.__TAURI__?.core?.invoke?.("get_tray_build_number")
    .then((build) => {
      const el = $("tray-build-number");
      if (el && typeof build === "string" && /^\d{10,12}$/.test(build)) {
        el.textContent = `Build ${build}`;
      }
    })
    .catch(() => {});
  refresh();
  trayConfigureJobsRefresh(30);
}

install();
