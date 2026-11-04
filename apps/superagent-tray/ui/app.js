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

let toastTimer;
function toast(message, error = false) {
  clearTimeout(toastTimer);
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

function errors(error) {
  toast(error instanceof Error ? error.message : String(error), true);
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

  $("save-form").disabled = true;
  try {
    await api(state.editingId ? "update" : "create", payload);
    toast(state.editingId ? "Schedule updated successfully." : "Schedule created successfully.");
    closeEditor();
    await refresh();
  } catch (error) {
    errors(error);
  } finally {
    $("save-form").disabled = false;
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
  }
}

function navigateToPage(pageId) {
  const validPages = ["jobs", "runtime", "history", "settings"];
  const target = validPages.includes(pageId) ? pageId : "jobs";

  if (window.location.hash !== `#${target}`) {
    if (typeof history.replaceState === "function") {
      history.replaceState(null, "", `#${target}`);
    } else {
      window.location.hash = `#${target}`;
    }
  }

  document.querySelectorAll(".navigation .nav-link").forEach((link) => {
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

  // Every page first hides all other page-specific actions.
  if (actionsJobs) actionsJobs.hidden = true;
  if (actionsRuntime) actionsRuntime.hidden = true;
  if (actionsHistory) actionsHistory.hidden = true;

  if (target === "jobs") {
    if (topEyebrow) topEyebrow.textContent = "AUTOMATION CONSOLE";
    if (topTitle) topTitle.textContent = "Schedules & Reminders";
    if (topDesc) topDesc.textContent = "Manage background cron jobs, native reminders, and active schedules.";
    if (actionsJobs) actionsJobs.hidden = false;
    if (actionsRuntime) actionsRuntime.hidden = true;
    if (actionsHistory) actionsHistory.hidden = true;
  } else if (target === "runtime") {
    if (topEyebrow) topEyebrow.textContent = "SYSTEM INVENTORY";
    if (topTitle) topTitle.textContent = "Runtime Detection";
    if (topDesc) topDesc.textContent = "Inspect authenticated Core APIs, CLI sessions, MCP servers, and tunnel connections.";
    if (actionsJobs) actionsJobs.hidden = true;
    if (actionsRuntime) actionsRuntime.hidden = false;
    if (actionsHistory) actionsHistory.hidden = true;
    if (typeof window.__superagentRuntimeRefresh === "function") {
      window.__superagentRuntimeRefresh();
    }
    window.__superagentLifecycleRefresh?.();
  } else if (target === "history") {
    if (topEyebrow) topEyebrow.textContent = "AUDIT LEDGER";
    if (topTitle) topTitle.textContent = "Execution History";
    if (topDesc) topDesc.textContent = "Review recent execution outcomes from the SuperAgent daemon run ledger.";
    if (actionsJobs) actionsJobs.hidden = true;
    if (actionsRuntime) actionsRuntime.hidden = true;
    if (actionsHistory) actionsHistory.hidden = false;
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
  document.querySelectorAll(".navigation .nav-link").forEach((link) => {
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
  refresh();
  trayConfigureJobsRefresh(30);
}

install();
