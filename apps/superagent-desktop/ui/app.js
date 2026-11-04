"use strict";

const $ = (id) => document.getElementById(id);
const state = { jobs: [], runs: [], editingId: null, loading: false, online: false };
const api = (action, payload) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("Aplikasi ini perlu dijalankan menggunakan Tauri, bukan browser biasa.");
  return invoke("daemon_action", { action, payload: payload ?? null });
};
const escapeHtml = (str) => String(str ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const timeFormat = new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" });
const dateTime = (ms) => ms ? timeFormat.format(new Date(ms)) : "—";
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
  toastTimer = setTimeout(() => { el.hidden = true; }, 4300);
}
function errors(error) { toast(error instanceof Error ? error.message : String(error), true); }
function jobType(job) {
  if (job.kind === "reminder") return "🔔 Pengingat";
  if (job.kind === "system-memory-retention-sweep") return "🔒 Sistem";
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
  $("stat-next").textContent = next ? dateTime(next.nextRun) : "Belum terjadwal";
  if (!jobs.length) {
    $("job-table").innerHTML = '<tr><td colspan="5" class="empty">Belum ada jadwal pada filter ini. Klik “Buat jadwal” untuk menambahkan.</td></tr>';
    return;
  }
  $("job-table").innerHTML = jobs.map((job) => `<tr>
    <td><div class="job-name">${escapeHtml(job.name)}</div>
      <div class="job-desc">${escapeHtml(jobType(job))} · ${escapeHtml(job.prompt || "")}</div></td>
    <td><div>${escapeHtml(job.maxRuns && job.maxRuns - (job.runCount || 0) === 1 ? "1 kali tersisa" : job.cronExpression)}</div>
      <div class="job-cron">${escapeHtml(job.cronExpression)}</div></td>
    <td>${job.enabled ? escapeHtml(dateTime(job.nextRun)) : "—"}</td>
    <td><span class="pill ${job.enabled ? "" : "paused"}">${job.enabled ? "Aktif" : "Dijeda"}</span></td>
    <td><div class="row-actions">
      <button type="button" data-action="edit" data-id="${escapeHtml(job.id)}" aria-label="Ubah ${escapeHtml(job.name)}">Ubah</button>
      <button type="button" data-action="toggle" data-id="${escapeHtml(job.id)}">${job.enabled ? "Jeda" : "Aktifkan"}</button>
      <button type="button" data-action="run" data-id="${escapeHtml(job.id)}" title="Jalankan sekali sekarang">▶</button>
      <button type="button" data-action="delete" data-id="${escapeHtml(job.id)}" class="danger" title="Hapus jadwal">✕</button>
    </div></td>
  </tr>`).join("");
}

function drawRuns() {
  const names = new Map(state.jobs.map((job) => [job.id, job.name]));
  const runs = [...state.runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10);
  $("runs").innerHTML = runs.length ? runs.map((run) => `<li>
    <span><span class="run-name">${escapeHtml(names.get(run.jobId) || run.jobId)}</span>
      <small> · ${escapeHtml(dateTime(run.completedAt || run.startedAt))}</small></span>
    <span class="status-${["success", "error", "running"].includes(run.status) ? run.status : "running"}">${escapeHtml(run.status)}</span>
  </li>`).join("") : '<li class="empty">Belum ada riwayat eksekusi.</li>';
}

function connection(isOnline, message) {
  state.online = isOnline;
  $("connection-dot").classList.toggle("offline", !isOnline);
  $("connection-text").textContent = isOnline ? "Core terhubung" : "Core tidak terhubung";
  $("connection-detail").textContent = isOnline
    ? `127.0.0.1:${window.__SUPERAGENT_CORE_PORT || "terpilih"} · Autentikasi aman di Rust`
    : String(message).slice(0, 180);
}
function setBanner(message, buttonText, action) {
  const banner = $("banner");
  banner.replaceChildren();
  banner.append(document.createTextNode(message));
  if (buttonText && action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = buttonText;
    button.addEventListener("click", action);
    banner.append(button);
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
      setBanner("Scheduler sedang berhenti. Pengingat tidak akan dipicu sampai scheduler diaktifkan.", "Mulai scheduler", async () => {
        try { await api("start"); toast("Scheduler telah diaktifkan."); await refresh(); } catch (e) { errors(e); }
      });
    } else {
      setBanner("");
    }
  } catch (error) {
    connection(false, error);
    setBanner("SuperAgent Core tidak tersedia. Jalankan: bun dist/cli.js --server 7888. Periksa status dan file server-info sebelum mencoba lagi.");
    $("job-table").innerHTML = '<tr><td colspan="5" class="empty">Tidak dapat memuat jadwal tanpa Core.</td></tr>';
    $("stat-total").textContent = $("stat-active").textContent = $("stat-next").textContent = "—";
    state.jobs = []; state.runs = [];
    drawRuns();
  } finally {
    state.loading = false;
    $("refresh-btn").disabled = false;
  }
}

function updateKinds() {
  const isAgent = $("kind").value === "agent";
  $("workspace-label").hidden = !isAgent;
  $("prompt-label").firstChild.textContent = isAgent ? "Instruksi Agent " : "Isi pengingat ";
  $("prompt").placeholder = isAgent ? "Contoh: Ringkas status repository, tanpa mengubah file" : "Contoh: Waktunya rapat!";
}
function updateFrequency() {
  const freq = $("frequency").value;
  $("once-field").hidden = freq !== "once";
  $("time-field").hidden = freq === "once" || freq === "custom";
  $("weekday-field").hidden = freq !== "weekly";
  $("custom-field").hidden = freq !== "custom";
  $("repeat-info").textContent = freq === "once" ? "Sekali jalan, lalu otomatis dijeda." :
    freq === "daily" ? "Berulang setiap hari pada waktu lokal Core." :
    freq === "weekly" ? "Berulang pada hari yang dipilih." :
    "Gunakan lima bidang cron. Jadwal mengikuti zona waktu sistem Core.";
}

function openEditor(job = null, preferredKind = "reminder") {
  state.editingId = job?.id || null;
  $("job-form").reset();
  $("form-title").textContent = job ? "Ubah jadwal" : "Buat jadwal baru";
  $("save-form").textContent = job ? "Simpan perubahan" : "Simpan jadwal";
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
  updateKinds(); updateFrequency();
  $("dialog").hidden = false;
  $("name").focus();
}
function closeEditor() { $("dialog").hidden = true; state.editingId = null; }
function buildCron() {
  const freq = $("frequency").value;
  if (freq === "custom") {
    const expression = $("cron").value.trim().replace(/\s+/g, " ");
    if (expression.split(" ").length !== 5) throw new Error("Ekspresi cron harus memiliki lima bagian.");
    return { cronExpression: expression, maxRuns: null };
  }
  if (freq === "once") {
    const date = new Date($("once-at").value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now() + 30_000) {
      throw new Error("Waktu pengingat sekali jalan harus berada di masa depan (minimal 30 detik).");
    }
    return { cronExpression: `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`, maxRuns: 1 };
  }
  const match = /^(\d{2}):(\d{2})$/.exec($("at-time").value);
  if (!match) throw new Error("Pilih waktu yang valid.");
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("Jam tidak valid.");
  if (freq === "daily") return { cronExpression: `${minute} ${hour} * * *`, maxRuns: null };
  return { cronExpression: `${minute} ${hour} * * ${$("weekday").value}`, maxRuns: null };
}
async function saveForm(event) {
  event.preventDefault();
  const name = $("name").value.trim();
  const prompt = $("prompt").value.trim();
  if (!name || !prompt) return errors("Nama dan isi tugas harus diisi.");
  if ($("kind").value === "agent" && !$("workspace").value.trim()) return errors("Tugas Agent memerlukan path workspace.");
  let schedule;
  try { schedule = buildCron(); } catch (error) { return errors(error); }
  const payload = {
    name, prompt, cronExpression: schedule.cronExpression,
    enabled: $("job-enabled").checked,
    ...($("kind").value === "agent" ? { workspace: $("workspace").value.trim() } : {}),
  };
  if (state.editingId) {
    payload.id = state.editingId;
    // null clears one-shot maxRuns when converting to recurring; supported by Core.
    const previous = state.jobs.find((job) => job.id === state.editingId);
    // Core maxRuns counts all historical runs, not additional runs.
    // One future occurrence therefore needs a lifetime limit of runCount + 1.
    payload.maxRuns = schedule.maxRuns === 1
      ? (previous?.runCount || 0) + 1 : null;
  } else {
    payload.kind = $("kind").value;
    if (schedule.maxRuns !== null) payload.maxRuns = schedule.maxRuns;
  }
  $("save-form").disabled = true;
  try {
    await api(state.editingId ? "update" : "create", payload);
    toast(state.editingId ? "Jadwal berhasil diperbarui." : "Jadwal berhasil dibuat.");
    closeEditor(); await refresh();
  } catch (error) { errors(error); }
  finally { $("save-form").disabled = false; }
}
async function onRowClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const job = state.jobs.find((j) => j.id === button.dataset.id);
  if (!job) return;
  const action = button.dataset.action;
  if (action === "edit") {
    if (job.kind === "system-memory-retention-sweep") return errors("Job internal sistem tidak diedit melalui desktop.");
    return openEditor(job);
  }
  if (action === "delete" && !window.confirm(`Hapus “${job.name}” secara permanen? Tindakan ini tidak dapat dibatalkan.`)) return;
  if (action === "run" && !window.confirm(`Jalankan “${job.name}” sekarang? Tugas agent dapat menjalankan tools sesuai kebijakan SuperAgent.`)) return;
  button.disabled = true;
  try {
    if (action === "toggle") await api("update", { id: job.id, enabled: !job.enabled });
    if (action === "delete") await api("delete", { id: job.id });
    if (action === "run") await api("run", { id: job.id });
    toast(action === "delete" ? "Jadwal dihapus." : action === "run" ? "Eksekusi selesai; cek riwayat." : "Status jadwal diperbarui.");
    await refresh();
  } catch (error) { errors(error); }
  finally { button.disabled = false; }
}
function install() {
  $("timezone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $("new-btn").addEventListener("click", () => openEditor());
  $("refresh-btn").addEventListener("click", refresh);
  $("filter").addEventListener("change", drawJobs);
  $("job-table").addEventListener("click", onRowClick);
  $("close-form").addEventListener("click", closeEditor);
  $("cancel-form").addEventListener("click", closeEditor);
  $("dialog").addEventListener("click", (e) => { if (e.target === $("dialog")) closeEditor(); });
  $("frequency").addEventListener("change", updateFrequency);
  $("kind").addEventListener("change", updateKinds);
  $("job-form").addEventListener("submit", saveForm);
  window.addEventListener("superagent-core-selected", refresh);
  window.__TAURI__?.event?.listen?.("desktop-create-reminder", () => openEditor(null, "reminder"));
  refresh();
  setInterval(refresh, 30_000);
}
install();
