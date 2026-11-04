"use strict";

// A dedicated read-only runtime panel. This script receives a sanitized native
// snapshot; it never sees Core bearer tokens or raw process command arguments.
const rt = (id) => document.getElementById(id);
const runtimeEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));
const runtimeInvoke = (action, args = {}) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("Runtime Detection tersedia hanya di aplikasi Tauri.");
  return invoke(action, args);
};
let runtimeScanBusy = false;
let runtimeLastResult = null;

function runtimeLabel(state) {
  const labels = {
    online: "API terverifikasi", unreachable: "Tidak merespons",
    unauthorized: "Autentikasi ditolak", unverified: "Bukan Core terverifikasi",
    active: "Proses aktif", stale: "Data lama"
  };
  return labels[state] || "Belum terverifikasi";
}
function runtimeStatusPill(state) {
  const tone = state === "online" || state === "active" ? "ok" :
    state === "unreachable" || state === "stale" ? "dim" : "warn";
  return `<span class="runtime-state ${tone}">${runtimeEscape(runtimeLabel(state))}</span>`;
}
function runtimeService(name, state, details = "") {
  const tone = state === true ? "ok" : state === false ? "dim" : "unknown";
  const label = state === true ? "Aktif" : state === false ? "Tidak aktif" : "Belum diverifikasi";
  return `<span class="runtime-service"><b>${runtimeEscape(name)}</b><span class="runtime-service-badge ${tone}">${label}</span>${details ? `<small>${runtimeEscape(details)}</small>` : ""}</span>`;
}
function runtimeServerCard(server) {
  const online = server.state === "online";
  const daemon = server.daemon || null;
  const gateway = server.gateway || null;
  const services = server.services || null;
  const muse = services?.muse;
  const mcp = services?.mcp;
  const tunnel = services?.tunnel;
  const telegram = services?.telegram;
  const channelHosts = services?.channelHosts;
  const museLabel = muse?.watcherActive && !muse?.connected
    ? "Listener ada, koneksi belum siap" : muse?.transport ? `via ${muse.transport}` : "";
  const button = online
    ? server.selected
      ? '<span class="runtime-current">✓ Dipilih untuk cronjob</span>'
      : `<button class="button ghost runtime-select" type="button" data-runtime-port="${server.port}">Gunakan Core ini</button>`
    : '<span class="subtle">Server tidak dapat dipilih</span>';
  return `<article class="runtime-instance">
    <div class="runtime-instance-head"><div><strong>SuperAgent Core · :${server.port}</strong>
      <small>PID ${runtimeEscape(server.pid ?? "—")} · v${runtimeEscape(server.version ?? "—")}</small></div>
      ${runtimeStatusPill(server.state)}</div>
    <div class="runtime-evidence">${runtimeEscape(server.evidence)}
      ${server.pidVerified ? " · PID lokal cocok" : " · PID belum diverifikasi"}</div>
    <div class="runtime-services">
      ${runtimeService("Scheduler", daemon ? daemon.running : null,
        daemon ? `${daemon.totalJobs} job · ${daemon.activeJobs} berjalan` : "")}
      ${runtimeService("Gateway", gateway ? gateway.enabled : null)}
      ${runtimeService("Muse Watch", muse ? (muse.watcherActive && muse.connected) : null, museLabel)}
      ${runtimeService("Telegram", telegram ? telegram.active : null)}
      ${runtimeService("MCP", mcp ? mcp.active : null,
        mcp ? `${mcp.serverCount || 0} host · ${mcp.connectedClientCount || 0} klien` : "")}
      ${runtimeService("Tunnel", tunnel ? tunnel.active : null,
        tunnel ? `${tunnel.count || 0} Muse WS` : "")}
      ${runtimeService("Channel Host", channelHosts ? channelHosts.verifiedCount > 0 : null,
        channelHosts ? `${channelHosts.verifiedCount || 0} tercatat running` : "")}
    </div>
    <div class="runtime-instance-footer">${button}</div>
  </article>`;
}
function runtimeProcessCard(entry) {
  return `<article class="runtime-instance compact">
    <div class="runtime-instance-head"><div>
      <strong>${runtimeEscape(entry.role)}</strong>
      <small>PID ${runtimeEscape(entry.pid)} · ${runtimeEscape(entry.workspace || "Workspace tidak diketahui")}</small>
    </div>${runtimeStatusPill(entry.state)}</div>
    <div class="runtime-evidence">${runtimeEscape(entry.evidence)}
      · heartbeat ${Math.max(0, Number(entry.heartbeatAgeSeconds) || 0)}d
      ${entry.agentRunning ? " · AI sedang bekerja" : ""}</div>
  </article>`;
}
function runtimeRender(snapshot) {
  runtimeLastResult = snapshot;
  rt("runtime-core-count").textContent = String(snapshot.healthyCoreCount || 0);
  rt("runtime-process-count").textContent = String(snapshot.activeProcessCount || 0);
  rt("runtime-selected-port").textContent = snapshot.selectedCorePort ? `:${snapshot.selectedCorePort}` : "Default";
  window.__SUPERAGENT_CORE_PORT = snapshot.selectedCorePort || null;
  const scanned = snapshot.scannedAt ? new Date(snapshot.scannedAt) : new Date();
  rt("runtime-scanned").textContent = `Diperiksa ${scanned.toLocaleTimeString("id-ID")}`;
  const servers = Array.isArray(snapshot.cores) ? snapshot.cores : [];
  rt("runtime-servers").innerHTML = servers.length
    ? servers.map(runtimeServerCard).join("")
    : '<p class="runtime-empty">Tidak ada server-info SuperAgent yang terdaftar. Jalankan Core, lalu tekan Periksa.</p>';
  const processes = Array.isArray(snapshot.processes) ? snapshot.processes : [];
  rt("runtime-processes").innerHTML = processes.length
    ? processes.map(runtimeProcessCard).join("")
    : '<p class="runtime-empty">Tidak ada sesi CLI/MCP dengan heartbeat di process journal saat ini.</p>';
  rt("runtime-notes").textContent =
    "Status online memerlukan respons HTTP terautentikasi. CLI/MCP memerlukan PID, waktu pembuatan proses, dan heartbeat segar. " +
    "Status Muse/Telegram/MCP di setiap kartu hanya mencerminkan proses Core tersebut; layanan di proses independen mungkin tidak tercakup.";
  rt("runtime-notes").hidden = false;
}
async function runtimeRefresh() {
  if (runtimeScanBusy) return;
  runtimeScanBusy = true;
  rt("runtime-refresh").disabled = true;
  try {
    const snapshot = await runtimeInvoke("detect_runtime");
    runtimeRender(snapshot);
  } catch (error) {
    rt("runtime-scanned").textContent = "Pemeriksaan gagal";
    rt("runtime-servers").replaceChildren();
    const detail = document.createElement("p");
    detail.className = "runtime-empty";
    detail.textContent = String(error);
    rt("runtime-servers").append(detail);
  } finally {
    runtimeScanBusy = false;
    rt("runtime-refresh").disabled = false;
  }
}
async function runtimeSelect(event) {
  const button = event.target.closest("button[data-runtime-port]");
  if (!button) return;
  const port = Number(button.dataset.runtimePort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return;
  if (!runtimeLastResult?.cores?.some((core) => core.port === port && core.state === "online")) return;
  button.disabled = true;
  try {
    await runtimeInvoke("select_runtime_core", { port });
    window.__SUPERAGENT_CORE_PORT = port;
    window.dispatchEvent(new Event("superagent-core-selected"));
    await runtimeRefresh();
  } catch (error) {
    button.disabled = false;
    alert("Tidak bisa menggunakan server: " + String(error));
  }
}
function runtimeInstall() {
  rt("runtime-refresh")?.addEventListener("click", runtimeRefresh);
  rt("runtime-servers")?.addEventListener("click", runtimeSelect);
  window.__TAURI__?.event?.listen?.("desktop-open-runtime", () => {
    rt("runtime")?.scrollIntoView({ behavior: "smooth", block: "start" });
    void runtimeRefresh();
  });
  document.querySelectorAll(".navigation .nav-link").forEach((nav) => {
    nav.addEventListener("click", () => {
      document.querySelectorAll(".navigation .nav-link").forEach((link) => link.classList.remove("active"));
      nav.classList.add("active");
    });
  });
  void runtimeRefresh();
  setInterval(runtimeRefresh, 20_000);
}
runtimeInstall();
