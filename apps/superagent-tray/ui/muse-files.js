"use strict";

/**
 * Muse File Transfer Manager: all operations use fixed native Tauri commands.
 * No file contents, absolute paths, bearer tokens or arbitrary URLs reach JS.
 */
const museFileById = (id) => document.getElementById(id);
const museFileToast = (kind, message) => window.TrayFeedback?.notify({
  kind, message, scope: "muse-files",
});
const museFileEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const museFileBytes = (value) =>
  (Math.max(0, Number(value) || 0) / 1048576).toFixed(2) + " MiB";
const museFileDate = (ms) => {
  const num = Number(ms);
  return Number.isFinite(num) && num > 0 ? new Date(num).toLocaleString() : "-";
};

const museFileState = {
  selected: null, snapshot: null, busy: false, refreshing: false,
  currentId: null, lastBytes: 0, lastAt: 0, rate: 0,
  settingsLoaded: false, refreshTimer: null,
  noticeCategory: null,
};

function museFileInvoke(action, options = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") throw new Error("SuperAgent Tray native runtime unavailable");
  return invoke(action, options);
}

function museFileNotice(message, error = false, category = "action") {
  museFileState.noticeCategory = category;
  const el = museFileById("muse-files-banner");
  if (!el) return;
  el.textContent = String(message).slice(0, 500);
  el.classList.toggle("error", error);
  el.hidden = false;
}
function museFileNoticeClear() {
  const el = museFileById("muse-files-banner");
  if (el) el.hidden = true;
  museFileState.noticeCategory = null;
}

function museFileCurrent(snapshot) {
  return snapshot.active || snapshot.history?.[0] || null;
}

function museFileRenderStatus(snapshot) {
  museFileState.snapshot = snapshot;
  const connected = snapshot.watcherConnected === true;
  const ws = museFileById("muse-files-ws-state");
  const chip = museFileById("muse-files-ws-chip");
  if (ws) ws.textContent = connected ? "Connected" : snapshot.watcherActive ? "Waiting" : "Offline";
  if (chip) {
    chip.textContent = connected ? "Ready" : "Not ready";
    chip.classList.toggle("success", connected);
  }
  const detail = museFileById("muse-files-ws-detail");
  if (detail) detail.textContent = connected
    ? "Authenticated watcher on port " + Number(snapshot.port)
    : "No authenticated Muse watcher in this Core (" + Number(snapshot.port) + ")";
  const telegram = museFileById("muse-files-telegram-state");
  if (telegram) telegram.textContent = snapshot.telegramConfigured ? "Configured" : "Unavailable";
  const count = museFileById("muse-files-history-count");
  if (count) count.textContent = String(snapshot.history?.length || 0);
  const channel = museFileById("muse-files-transport")?.value;
  const limit = (snapshot.settings?.maxFileMiB || 8) * 1048576;
  const canSend = Boolean(museFileState.selected) && !museFileState.busy &&
    museFileState.selected.size <= limit &&
    !snapshot.active && (channel === "muse-websocket" ? connected : snapshot.telegramConfigured);
  const send = museFileById("muse-files-send");
  if (send) send.disabled = !canSend;

  museFileRenderProgress(museFileCurrent(snapshot));
  museFileRenderHistory(snapshot);
  if (!museFileState.settingsLoaded && snapshot.settings) {
    museFileShowSettings(snapshot.settings);
  }
}

function museFileRenderProgress(job) {
  const current = museFileById("muse-files-current-status");
  const area = museFileById("muse-files-progress-area");
  const empty = museFileById("muse-files-empty");
  if (!job) {
    if (current) current.textContent = "Idle";
    if (area) area.hidden = true;
    if (empty) empty.hidden = false;
    museFileState.currentId = null;
    return;
  }
  if (empty) empty.hidden = true;
  if (area) area.hidden = false;
  const state = String(job.state || "idle");
  if (current) current.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  if (museFileState.currentId !== job.id) {
    museFileState.currentId = job.id;
    museFileState.lastAt = 0;
    museFileState.lastBytes = Number(job.bytes) || 0;
    museFileState.rate = 0;
  }
  const bytes = Math.min(Number(job.bytes) || 0, Number(job.size) || 0);
  const total = Math.max(0, Number(job.size) || 0);
  const now = Date.now();
  if (state === "transferring" && museFileState.lastAt && now > museFileState.lastAt) {
    const delta = Math.max(0, bytes - museFileState.lastBytes);
    const measured = delta / Math.max(0.001, (now - museFileState.lastAt) / 1000);
    museFileState.rate = delta > 0 ? measured : 0;
  }
  museFileState.lastAt = now;
  museFileState.lastBytes = bytes;
  if (state !== "transferring") museFileState.rate = 0;
  const progress = Math.max(0, Math.min(100, Number(job.percent) || 0));
  const set = (id, text) => { const el = museFileById(id); if (el) el.textContent = text; };
  set("muse-files-progress-name", job.name);
  set("muse-files-progress-percent", progress + "%");
  set("muse-files-progress-bytes", museFileBytes(bytes) + " / " + museFileBytes(total));
  set("muse-files-progress-rate",
    museFileState.rate > 0 && state === "transferring"
      ? (museFileState.rate / 1048576).toFixed(2) + " MiB/s" : "- MiB/s");
  set("muse-files-progress-eta",
    state === "transferring" && museFileState.rate > 0 && total > bytes
      ? "ETA ~" + Math.ceil((total - bytes) / museFileState.rate) + "s" : "ETA -");
  set("muse-files-progress-detail",
    job.kind === "telegram"
      ? (state === "completed" ? "Accepted by Telegram · Muse ingestion not confirmed" : "Telegram Bot API · no chunk progress available")
      : (job.verification === "sha256-acknowledged" ? "SHA-256 verified by Muse receiver" :
        job.resumed ? "Resumed from saved checkpoint" : "WebSocket · waiting for authenticated ACKs"));
  const bar = museFileById("muse-files-progress-fill");
  if (bar) bar.style.width = progress + "%";
  const track = museFileById("muse-files-progress-track");
  if (track) track.setAttribute("aria-valuenow", String(progress));
  const webSocket = job.kind === "muse-websocket";
  const working = state === "transferring";
  const pause = museFileById("muse-files-pause");
  const resume = museFileById("muse-files-resume");
  const cancel = museFileById("muse-files-cancel");
  if (pause) pause.disabled = !webSocket || !working || museFileState.busy;
  if (resume) resume.disabled = !webSocket ||
    !["paused", "failed", "cancelled"].includes(state) ||
    !museFileState.snapshot?.watcherConnected || museFileState.busy;
  if (cancel) cancel.disabled = !webSocket ||
    !["transferring", "paused", "failed"].includes(state) || museFileState.busy;
  const error = museFileById("muse-files-progress-error");
  if (error) {
    error.textContent = String(job.error || "").slice(0, 300);
    error.hidden = !job.error;
  }
}

function museFileRenderHistory(snapshot) {
  const holder = museFileById("muse-files-history-table");
  if (!holder) return;
  const filter = museFileById("muse-files-filter")?.value || "all";
  const jobs = (Array.isArray(snapshot.history) ? snapshot.history : [])
    .filter(job => filter === "all" || job.state === filter).slice(0, 60);
  if (!jobs.length) {
    holder.innerHTML = '<tr><td colspan="5" class="empty-state">No matching transfers.</td></tr>';
    return;
  }
  holder.innerHTML = jobs.map(job => {
    const resumable = job.kind === "muse-websocket" &&
      ["paused", "failed", "cancelled"].includes(job.state) &&
      snapshot.watcherConnected && !snapshot.active;
    const action = resumable
      ? '<button class="button ghost muse-file-retry" type="button" data-transfer-id="' +
        museFileEscape(job.id) + '">Resume / Retry</button>' : "";
    const state = museFileEscape(job.state);
    return '<tr><td><strong>' + museFileEscape(job.name) + '</strong><div class="stat-sub">' +
      museFileBytes(job.size) + '</div></td><td>' +
      (job.kind === "telegram" ? "Telegram" : "Muse WebSocket") +
      '</td><td><span class="muse-file-status muse-file-status-' + state + '">' +
      state + '</span>' + (job.verification === "telegram-accepted"
        ? '<small class="muse-file-unverified">Not verified by Muse</small>' : "") +
      '</td><td>' + museFileEscape(museFileDate(job.startedAt)) +
      '</td><td class="text-right">' + action + '</td></tr>';
  }).join("");
}

function museFileShowSettings(settings) {
  museFileState.settingsLoaded = true;
  const pairs = {
    "muse-files-limit": settings.maxFileMiB,
    "muse-files-retention": settings.historyDays,
    "muse-files-poll": settings.refreshSeconds,
    "muse-files-default": settings.defaultTransport,
  };
  for (const [id, value] of Object.entries(pairs)) {
    const element = museFileById(id);
    if (element) element.value = String(value);
  }
  if (museFileById("muse-files-transport")) {
    museFileById("muse-files-transport").value = settings.defaultTransport;
  }
  museFileScheduleRefresh(Number(settings.refreshSeconds) || 2);
}

async function museFileRefresh() {
  if (museFileState.refreshing) return;
  museFileState.refreshing = true;
  try {
    const snapshot = await museFileInvoke("muse_file_control", {
      action: "status", id: null, settings: null,
    });
    if (!snapshot || snapshot.success !== true) throw new Error("Invalid Core transfer status");
    museFileRenderStatus(snapshot);
    if (museFileState.noticeCategory === "connection") museFileNoticeClear();
  } catch (error) {
    const send = museFileById("muse-files-send");
    if (send) send.disabled = true;
    museFileNotice("Core file transfer service unavailable: " + String(error), true, "connection");
  } finally {
    museFileState.refreshing = false;
  }
}

function museFileScheduleRefresh(seconds) {
  if (museFileState.refreshTimer) clearInterval(museFileState.refreshTimer);
  const interval = [1, 2, 5, 10].includes(Number(seconds)) ? Number(seconds) : 2;
  museFileState.refreshTimer = setInterval(() => {
    if (museFileById("page-muse-files")?.hidden === false) void museFileRefresh();
  }, interval * 1000);
}

async function museFileBrowse(event) {
  if (museFileState.busy) return;
  const ticket = window.TrayFeedback?.begin({
    key:"muse-files:browse",button:event?.currentTarget,
    label:"Choosing file…",
  });
  museFileState.busy = true;
  try {
    const selected = await museFileInvoke("muse_file_pick");
    if (!selected) return;
    if (!selected.ticket || !selected.name || !Number.isSafeInteger(selected.size)) {
      throw new Error("Native file picker returned invalid selection");
    }
    museFileState.selected = selected;
    const name = museFileById("muse-files-selected-name");
    const meta = museFileById("muse-files-selected-meta");
    if (name) name.textContent = selected.name;
    if (meta) meta.textContent = museFileBytes(selected.size) + " · Selected locally";
    museFileToast("info", "File selected. Choose transport and select Send.");
  } catch (error) {
    museFileNotice("Cannot select file: " + String(error), true);
    museFileToast("error", "Could not select a file.");
  } finally {
    museFileState.busy = false;
    ticket?.end();
    const snapshot = museFileState.snapshot;
    if (snapshot) museFileRenderStatus(snapshot);
  }
}

async function museFileSend() {
  if (!museFileState.selected || museFileState.busy) return;
  const ticket=window.TrayFeedback?.begin({
    key:"muse-files:send",button:museFileById("muse-files-send"),label:"Starting transfer…",
  });
  museFileState.busy = true;
  const picked = museFileState.selected;
  const kind = museFileById("muse-files-transport")?.value;
  try {
    const result = await museFileInvoke("muse_file_start", { ticket: picked.ticket, kind });
    if (!result?.success) throw new Error("Core declined transfer");
    museFileState.selected = null;
    if (museFileById("muse-files-selected-name"))
      museFileById("muse-files-selected-name").textContent = "No file selected";
    if (museFileById("muse-files-selected-meta"))
      museFileById("muse-files-selected-meta").textContent = "Choose another file to send";
    await museFileRefresh();
    museFileToast("info", "Muse transfer accepted. Follow progress for delivery.");
  } catch (error) {
    // Ticket is consumed natively even if Core rejects a request.
    museFileState.selected = null;
    const name = museFileById("muse-files-selected-name");
    const meta = museFileById("muse-files-selected-meta");
    if (name) name.textContent = "No file selected";
    if (meta) meta.textContent = "Select a new file and try again";
    museFileNotice("Upload not started: " + String(error), true);
    museFileToast(/timed out|timeout/i.test(String(error)) ? "warning" : "error",
      "Muse transfer start not verified. Inspect history before retrying.");
  } finally {
    museFileState.busy = false;
    ticket?.end();
    await museFileRefresh();
  }
}

async function museFileChange(action, id) {
  if (museFileState.busy || typeof id !== "string") return;
  if (action === "cancel" && !window.confirm("Cancel this transfer? A WebSocket checkpoint is retained for manual resume.")) {
    return;
  }
  const ticket=window.TrayFeedback?.begin({
    key:"muse-files:control:"+id,
    button:museFileById("muse-files-"+action),label:"Updating transfer…",
  });
  museFileState.busy = true;
  try {
    const reply=await museFileInvoke("muse_file_control", { action, id, settings: null });
    if(reply?.success===false)throw Error("Transfer action not verified");
    await museFileRefresh();
    museFileToast("info", "Transfer "+action+" accepted. Check current state.");
  } catch (error) {
    museFileNotice("Transfer " + action + " failed: " + String(error), true);
    museFileToast(/timed out|timeout/i.test(String(error))?"warning":"error",
      "Transfer "+action+" result not verified. Inspect progress before retrying.");
  } finally {
    museFileState.busy = false;
    ticket?.end();
    await museFileRefresh();
  }
}

async function museFileSaveSettings(event) {
  event.preventDefault();
  if (museFileState.busy) return;
  museFileState.busy = true;
  const btn = museFileById("muse-files-save-settings");
  const ticket=window.TrayFeedback?.begin({
    key:"muse-files:save-settings",button:btn,label:"Saving transfer settings…",
  });
  if (btn) btn.disabled = true;
  try {
    const settings = {
      version: 1,
      maxFileMiB: Number(museFileById("muse-files-limit").value),
      historyDays: Number(museFileById("muse-files-retention").value),
      refreshSeconds: Number(museFileById("muse-files-poll").value),
      defaultTransport: museFileById("muse-files-default").value,
    };
    const result = await museFileInvoke("muse_file_control", {
      action: "settings", id: null, settings,
    });
    if (!result?.success) throw new Error("Core did not save transfer preferences");
    museFileShowSettings(result.settings);
    museFileById("muse-files-settings-feedback").textContent = "Saved";
    museFileToast("success", "Muse transfer settings saved.");
  } catch (error) {
    museFileById("muse-files-settings-feedback").textContent = "Save failed: " + String(error);
    museFileToast("error", "Muse transfer settings were not saved.");
  } finally {
    museFileState.busy = false;
    if (btn) btn.disabled = false;
    ticket?.end();
    await museFileRefresh();
  }
}

function museFileInstall() {
  const click = (id, callback) => museFileById(id)?.addEventListener("click", callback);
  click("muse-files-refresh", museFileRefresh);
  click("muse-files-choose", museFileBrowse);
  click("muse-files-top-select", museFileBrowse);
  click("muse-files-send", museFileSend);
  click("muse-files-pause", () => {
    if (museFileState.currentId) void museFileChange("pause", museFileState.currentId);
  });
  click("muse-files-resume", () => {
    if (museFileState.currentId) void museFileChange("resume", museFileState.currentId);
  });
  click("muse-files-cancel", () => {
    if (museFileState.currentId) void museFileChange("cancel", museFileState.currentId);
  });
  museFileById("muse-files-history-table")?.addEventListener("click", (event) => {
    const button = event.target.closest?.(".muse-file-retry");
    if (button?.dataset?.transferId) void museFileChange("resume", button.dataset.transferId);
  });
  museFileById("muse-files-filter")?.addEventListener("change", () => {
    if (museFileState.snapshot) museFileRenderHistory(museFileState.snapshot);
  });
  museFileById("muse-files-transport")?.addEventListener("change", () => {
    if (museFileState.snapshot) museFileRenderStatus(museFileState.snapshot);
  });
  museFileById("muse-files-settings")?.addEventListener("submit", museFileSaveSettings);
  window.addEventListener("superagent-core-selected", () => { museFileState.settingsLoaded = false; void museFileRefresh(); });
  window.__superagentMuseFilesRefresh = museFileRefresh;
  museFileScheduleRefresh(2);
  if (museFileById("page-muse-files")?.hidden === false) void museFileRefresh();
}
museFileInstall();
