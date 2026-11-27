"use strict";

// A dedicated read-only runtime panel. This script receives a sanitized native
// snapshot; it never sees Core bearer tokens or raw process command arguments.
const rt = (id) => document.getElementById(id);

const runtimeEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

function runtimeSafePublicUrl(value, endpoint = "origin") {
  if (typeof value !== "string" || value.length > 254 || !value.startsWith("https://")) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    if (!/^[a-z0-9.-]+$/.test(host) || host.length > 253 || !host.includes(".") ||
        host.startsWith(".") || host.endsWith(".") ||
        host.split(".").some(part => !part || part.length > 63 ||
          !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part)) ||
        /^(?:[0-9]+[.]){3}[0-9]+$/.test(host) ||
        [".local", ".localhost", ".internal", ".example", ".test", ".invalid", ".cfargotunnel.com"].some(suffix => host.endsWith(suffix)) ||
        parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) return null;
    const expected = parsed.origin + (endpoint === "mcp" ? "/mcp" : "");
    return value === expected ? value : null;
  } catch { return null; }
}
let runtimeCopyAllowedUrls = new Set();
function runtimeCopyButton(url) {
  runtimeCopyAllowedUrls.add(url);
  return `<button type="button" class="button ghost runtime-copy-public-url"
    data-runtime-copy-url="${runtimeEscape(url)}">Copy URL</button>`;
}
function runtimeEndpointMarkup(url, evidence) {
  return `<div class="runtime-evidence runtime-endpoint">
    <span class="runtime-public-url">${runtimeEscape(url)}</span>
    ${runtimeCopyButton(url)}
    <a class="button ghost" href="${runtimeEscape(url)}"
      target="_blank" rel="noopener noreferrer">Open URL</a>
    <small>${runtimeEscape(evidence)}</small>
  </div>`;
}
function runtimeTrayGatewayCard(status) {
  if (!status || status.active !== true || status.configured !== true)
    return '<article class="runtime-instance compact"><strong>SuperAgent Tray management</strong><div class="runtime-evidence">Gateway inactive · no public Tray URL. Configure a password-protected gateway under Settings → Security.</div></article>';
  const kind = status.mode === "quick" ? "Quick" : status.mode === "named" ? "Named" : "Unknown";
  const url = !["quick", "named"].includes(status.mode) ||
    (status.mode === "quick" && status.connectorReady !== true)
    ? null : runtimeSafePublicUrl(status.publicUrl, "origin");
  return `<article class="runtime-instance compact">
    <div class="runtime-instance-head"><strong>SuperAgent Tray · ${runtimeEscape(kind)} Tunnel</strong>
    ${runtimeStatusPill("observed")}</div>
    <div class="runtime-evidence">Password-protected management only · origin port ${runtimeEscape(status.originPort ?? "-")} · no desktop frames exposed</div>
    ${url ? runtimeEndpointMarkup(url, status.routeVerified === true
      ? "Management route verified by gateway" : "Owner-reported URL · public HTTPS reachability not independently verified")
      : '<div class="runtime-evidence">No safe public Tray URL confirmed.</div>'}
  </article>`;
}
function runtimeNamedMcpCard(health) {
  if (!health || typeof health.hostname !== "string" || !health.hostname)
    return '<article class="runtime-instance compact"><strong>MCP Named Tunnel</strong><div class="runtime-evidence">No configured, verified Named MCP endpoint available.</div></article>';
  const url = runtimeSafePublicUrl("https://" + health.hostname + "/mcp", "mcp");
  if (!url) return "";
  const verified = health.connectorStatus === "verified_local_only" &&
    health.ownerStatus === "verified_local" &&
    health.anchorStatus === "verified_local" &&
    health.mcpAuthChallengeObserved === true && health.edgeObserved === true;
  return `<article class="runtime-instance compact">
    <strong>MCP Named Tunnel · configured hostname</strong>
    <div class="runtime-evidence">${runtimeEscape(health.hostname)} · ${verified
      ? "Connector, owner and OAuth challenge verified" : "Not verified end-to-end; URL cannot be copied"}</div>
    ${verified ? runtimeEndpointMarkup(url, "Dedicated MCP endpoint · verified edge challenge; client authorization separate") : ""}
  </article>`;
}
async function runtimeCopyPublicUrl(event) {
  const button = event.target?.closest?.("button.runtime-copy-public-url");
  if (!button || button.disabled) return;
  const url = button.dataset?.runtimeCopyUrl;
  if (!runtimeCopyAllowedUrls.has(url) ||
      !runtimeSafePublicUrl(url, url.endsWith("/mcp") ? "mcp" : "origin")) return;
  try {
    if (!window.navigator?.clipboard?.writeText) throw Error("Clipboard unavailable");
    await window.navigator.clipboard.writeText(url);
    window.TrayFeedback?.notify?.({ kind: "success", scope: "runtime", message: "Public URL copied." });
  } catch {
    window.TrayFeedback?.notify?.({ kind: "error", scope: "runtime", message: "Could not copy URL. Use the displayed address." });
  }
}

const runtimeInvoke = (action, args = {}) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("Runtime Detection is available only in the Tauri desktop application.");
  return invoke(action, args);
};

let runtimeRefreshTimer = null;
function runtimeConfigureRefreshInterval(seconds) {
  const valid = [10, 20, 30, 60, 120].includes(seconds) ? seconds : 20;
  if (runtimeRefreshTimer !== null) clearInterval(runtimeRefreshTimer);
  runtimeRefreshTimer = setInterval(() => runtimeRefresh(true), valid * 1000);
}

let runtimeScanBusy = false;
let runtimeScanSerial = 0;
let runtimeRefreshQueued = false;
let runtimeActionBusy = false;
let runtimeLastResult = null;

// The native owner-stop receipt already verifies process exit. Keep a short,
// exact-identity UI transition; never hide a live/unverified owner on scan.
const runtimeStopTransitions = new Map();
const runtimeStopKey = (service) => [service.kind, service.port, service.pid].join(":");
function runtimeVisibleRemote(snapshot = runtimeLastResult) {
  const remote = Array.isArray(snapshot?.remoteServices) ? snapshot.remoteServices : [];
  const visible = remote.filter(service =>
    runtimeStopTransitions.get(runtimeStopKey(service))?.phase !== "removed");
  for (const [key, transition] of runtimeStopTransitions) {
    // Keep the short exit animation even if native scanning already removed
    // the owner from inventory. This is display-only, never a live owner.
    if (transition.phase === "stopped" && transition.service &&
        !remote.some(service => runtimeStopKey(service) === key)) {
      visible.push(transition.service);
    }
  }
  return visible;
}
function runtimeReconcileStoppedOwners(snapshot, scanSerial) {
  const services = Array.isArray(snapshot?.remoteServices) ? snapshot.remoteServices : [];
  for (const [key, transition] of runtimeStopTransitions) {
    // A completed scan must be ordered after the verified stop receipt.
    // Date.now() has millisecond resolution, so a same-tick read cannot be
    // distinguished from a pre-stop in-flight read by timestamps alone.
    if (transition.phase === "stopping" ||
        (transition.confirmedScanSerial !== undefined &&
         scanSerial <= transition.confirmedScanSerial)) continue;
    const owner = services.find(service => runtimeStopKey(service) === key);
    if (!owner && transition.phase === "removed") {
      runtimeStopTransitions.delete(key);
    } else if (owner && !["stale", "inactive", "stopped"].includes(owner.state)) {
      // A fresh scan still observes the exact owner. Do not let a UI
      // transition obscure it or claim it disappeared.
      runtimeStopTransitions.delete(key);
      window.TrayFeedback?.notify?.({
        kind: "warning", scope: "runtime",
        message: "An owner is still observed after stop; inspect its live status.",
      });
    }
  }
}
function runtimeRenderRemoteList() {
  const root = rt("runtime-remote");
  if (!root) return;
  root.innerHTML = runtimeVisibleRemote().map(runtimeRemoteCard).join("");
  runtimeApplyTab();
}
function runtimeAnimateVerifiedStop(service) {
  const key = runtimeStopKey(service);
  const previous = runtimeStopTransitions.get(key);
  if (previous?.phase === "stopped" || previous?.phase === "removed") return;
  runtimeStopTransitions.set(key, {
    phase: "stopped", service, confirmedScanSerial: runtimeScanSerial,
  });
  runtimeRenderRemoteList();
  setTimeout(() => {
    const current = runtimeStopTransitions.get(key);
    if (current?.phase !== "stopped") return;
    runtimeStopTransitions.set(key, { ...current, phase: "removed" });
    runtimeRenderRemoteList();
  }, 420);
}
function runtimeNativeShutdownProgress(event) {
  const progress = event?.payload;
  for (const step of Array.isArray(progress?.steps) ? progress.steps : []) {
    const match = typeof step?.id === "string" && step.status === "stopped"
      ? /^mcp:(\d{4,5}):(\d+)$/.exec(step.id) : null;
    if (!match) continue;
    const owner = runtimeLastResult?.remoteServices?.find(service =>
      service.kind === "mcp" && service.port === Number(match[1]) &&
      service.pid === Number(match[2]));
    if (owner) runtimeAnimateVerifiedStop(owner);
  }
  if (["complete", "partial"].includes(progress?.stage)) {
    if (runtimeScanBusy) runtimeRefreshQueued = true;
    else void runtimeRefresh(true);
  }
}

function runtimeLabel(state) {
  const labels = {
    online: "Verified API",
    unreachable: "Unreachable",
    unauthorized: "Auth Rejected",
    unverified: "Unverified Core",
    active: "Active Process",
    observed: "Process / endpoint observed",
    stale: "Stale Entry",
    degraded: "Connected · Backend Degraded",
    starting: "Starting",
    idle: "Idle",
    error: "Service Issue",
  };
  return labels[state] || "Unverified";
}

function runtimeStatusPill(state) {
  const tone = state === "online" || state === "active" || state === "observed" ? "ok" :
    state === "unreachable" || state === "stale" ? "dim" : "warn";
  return `<span class="runtime-state ${tone}">${runtimeEscape(runtimeLabel(state))}</span>`;
}

function runtimeService(name, state, details = "") {
  const tone = state === true ? "ok" : state === false ? "dim" : "unknown";
  const label = state === true ? "Active" : state === false ? "Inactive" : "Unverified";
  return `<div class="runtime-service">
    <div class="runtime-service-top">
      <b>${runtimeEscape(name)}</b>
      <span class="runtime-service-badge ${tone}">${label}</span>
    </div>
    ${details ? `<small>${runtimeEscape(details)}</small>` : ""}
  </div>`;
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

  const museDetail = [];
  if (muse?.transport) museDetail.push("via "+muse.transport);
  if (Number.isFinite(muse?.uptimeSeconds)) museDetail.push(Math.floor(muse.uptimeSeconds)+"s uptime");
  if (Number.isFinite(muse?.workspaceCount)) museDetail.push(String(muse.workspaceCount)+" workspaces");
  if (Number.isFinite(muse?.queuedBatches) && muse.queuedBatches>0) museDetail.push(String(muse.queuedBatches)+" queued");
  if (muse?.activeTask) museDetail.push("task active");
  if (muse?.configStale) museDetail.push("settings stale");
  if (muse?.lastTransportError) museDetail.push("error: "+String(muse.lastTransportError).slice(0,80));
  if (muse?.watcherActive && !muse?.connected) museDetail.push("connection not ready");
  const museLabel = museDetail.join(" · ");

  const button = online
    ? server.selected
      ? '<span class="runtime-current">✓ Selected for Cron</span>'
      : `<button class="button ghost runtime-select" type="button" data-runtime-port="${server.port}">Use This Core</button>`
    : '<span class="subtle-badge">Server unreachable</span>';
  // Core-local Muse Watch can be started only through this authenticated Core.
  // Other CLI-hosted Muse watchers are never mapped to this Core by PID guess.
  const coreMuseTarget = online && server.port === runtimeLastResult?.selectedCorePort &&
    server.pidVerified === true && Number.isSafeInteger(server.pid) && server.pid > 0 &&
    typeof muse?.watcherActive === "boolean";
  const localMuse = coreMuseTarget && muse?.ownerPresent === true;
  const museControls = !coreMuseTarget ? "" : muse?.watcherActive
    ? `<div class="runtime-lifecycle-group">
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="stop"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Stop Muse</button>
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="restart"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Restart Muse</button>
      ${muse.configStale ? `<button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="apply-restart"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Apply &amp; Restart</button>` : ""}
      ${muse.transport === "websocket" ? `<button
        type="button" class="button ghost runtime-regenerate-token"
        data-runtime-kind="muse-core" data-runtime-port="${server.port}"
        data-runtime-pid="${server.pid}">Regenerate Muse Token</button>` : ""}
    </div>`
    : `<div class="runtime-lifecycle-group">
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="start-telegram"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Start Muse · Telegram</button>
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="start-websocket"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Start Muse · WebSocket</button>
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="start-tunnel"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Start Muse · Tunnel</button>
    </div>`;

  return `<article class="runtime-instance">
    <div class="runtime-instance-head">
      <div>
        <strong>SuperAgent Core · :${server.port}</strong>
        <small>PID ${runtimeEscape(server.pid ?? "-")} · v${runtimeEscape(server.version ?? "-")}</small>
      </div>
      <div style="display:inline-flex;align-items:center;gap:8px;">
        ${online ? `<button type="button" class="button ghost runtime-restart-core" data-runtime-port="${server.port}" style="padding:3px 8px;font-size:11px;" title="Restart SuperAgent Core (:${server.port})">Restart</button>` : ""}
        ${runtimeStatusPill(server.state)}
      </div>
    </div>
    <div class="runtime-evidence">
      ${runtimeEscape(server.evidence)}
      ${server.pidVerified ? " · Verified local PID" : " · PID unverified"}
    </div>
    <div class="runtime-services">
      ${runtimeService("Scheduler", daemon ? daemon.running : null,
        daemon ? `${daemon.totalJobs} jobs · ${daemon.activeJobs} active` : "")}
      ${runtimeService("Gateway", gateway ? gateway.enabled : null)}
      ${runtimeService("Core-local Muse Watch", muse ? (muse.watcherActive && muse.connected) : null, museLabel)}
      ${runtimeService("Telegram", telegram ? telegram.active : null)}
      ${runtimeService("Core-local MCP", mcp ? mcp.active : null,
        mcp ? `${mcp.serverCount || 0} hosts · ${mcp.connectedClientCount || 0} clients` : "")}
      ${runtimeService("Core-local Tunnel", tunnel ? tunnel.active : null,
        tunnel ? `${tunnel.count || 0} Muse WS` : "")}
      ${runtimeService("Channel Hosts", channelHosts ? channelHosts.verifiedCount > 0 : null,
        channelHosts ? `${channelHosts.verifiedCount || 0} running` : "")}
    </div>
    ${runtimeYoloMarkup(runtimeCurrentYoloMode)}
    <div class="runtime-instance-footer">${museControls}${button}</div>
  </article>`;
}

function runtimeProcessCard(entry) {
  return `<article class="runtime-instance compact">
    <div class="runtime-instance-head">
      <div>
        <strong>${runtimeEscape(entry.role)}</strong>
        <small>PID ${runtimeEscape(entry.pid)} · ${runtimeEscape(entry.workspace || "Workspace unknown")}</small>
      </div>
      ${runtimeStatusPill(entry.state)}
    </div>
    <div class="runtime-evidence">
      ${runtimeEscape(entry.evidence)} · heartbeat ${Math.max(0, Number(entry.heartbeatAgeSeconds) || 0)}s
      ${entry.agentRunning ? " · AI active" : ""}
    </div>
  </article>`;
}

function runtimeHostCard(host) {
  const label = host.kind === "tline-transport" ? "T-Line Transport" : "Muse / Telegram Channel Host";
  return `<article class="runtime-instance compact">
    <div class="runtime-instance-head">
      <div>
        <strong>${runtimeEscape(label)} · :${host.port}</strong>
        <small>PID ${runtimeEscape(host.pid || "-")}</small>
      </div>
      ${runtimeStatusPill(host.state)}
    </div>
    <div class="runtime-evidence">
      ${runtimeEscape(host.detail || "")}
      ${host.backendReady === false ? " · Core backend not ready" : ""}
      · ${runtimeEscape(host.evidence)}
    </div>
  </article>`;
}

let runtimeCurrentYoloMode = "off";

function runtimeMcpSecurityControlMarkup() {
  // MCP authorization is read-only here; native Security Approval owns every grant.
  return [
    '<section class="runtime-mcp-access-overview" aria-labelledby="runtime-mcp-access-title">',
    '<div class="runtime-mcp-access-head"><div>',
    '<span class="runtime-mcp-eyebrow">INDEPENDENT MCP SECURITY</span>',
    '<h4 id="runtime-mcp-access-title">MCP Access &amp; Approval</h4>',
    '<p>Koneksi MCP memakai OAuth dan izin terpisah. YOLO Chat Agent tidak berpengaruh.</p>',
    '</div><span class="runtime-mcp-separation">Terpisah dari YOLO</span></div>',
    '<div class="runtime-mcp-access-grid">',
    '<article class="runtime-mcp-access-card">',
    '<div class="runtime-mcp-access-card-title"><strong>Koneksi MCP</strong></div>',
    '<p>Autentikasi OAuth dan sesi MCP; tidak memberikan izin operasi tools.</p>',
    '<div class="runtime-mcp-count-row"><span class="runtime-mcp-count" id="runtime-mcp-connection-pending">—</span><span>sesi terhubung</span></div>',
    '<small id="runtime-mcp-identity-summary">Identitas: belum diperiksa</small>',
    '<button type="button" class="button ghost runtime-mcp-security-link" data-runtime-security-tab="connections">Kelola Koneksi MCP</button>',
    '</article>',
    '<article class="runtime-mcp-access-card">',
    '<div class="runtime-mcp-access-card-title"><strong>Akses Proyek</strong></div>',
    '<p>Izin read, write, execute dan Git per identitas dan per proyek.</p>',
    '<div class="runtime-mcp-count-row"><span class="runtime-mcp-count" id="runtime-mcp-project-pending">—</span><span>permintaan menunggu</span></div>',
    '<small id="runtime-mcp-approved-summary">Riwayat: belum diperiksa</small>',
    '<button type="button" class="button ghost runtime-mcp-security-link" data-runtime-security-tab="mcp">Kelola Akses Proyek</button>',
    '</article></div>',
    '<p id="runtime-mcp-access-status" class="runtime-mcp-access-status" role="status" aria-live="polite">Memeriksa status izin MCP.</p>',
    '</section>',
  ].join("");
}

let runtimeMcpSecurityBusy = false;
async function runtimeRefreshMcpSecurity() {
  if (runtimeMcpSecurityBusy || runtimeActiveTab !== "mcp") return;
  runtimeMcpSecurityBusy = true;
  const status = rt("runtime-mcp-access-status");
  if (status) {
    status.textContent = "Memeriksa permintaan dan identitas MCP…";
    status.dataset.state = "loading";
  }
  try {
    const results = await Promise.allSettled([
      runtimeInvoke("mcp_project_access_action", {action:"requests"}),
      runtimeInvoke("mcp_project_access_action", {action:"identities"}),
      runtimeInvoke("mcp_project_access_action", {action:"connected_clients",payload:{}}),
    ]);
    const connected=results[2].status==="fulfilled"?results[2].value:null;
    window.__superagentRenderMcpClientList?.(
      connected?.success===true && connected.state==="verified" &&
      Array.isArray(connected.clients)
        ? {connectedAgentsState:"verified",connectedAgents:connected.clients,
           connectedAgentsObservedAt:connected.observedAt} : null);
    const reqResult = results[0], idResult = results[1];
    const reqOk = reqResult.status === "fulfilled" && reqResult.value?.success === true &&
      Array.isArray(reqResult.value.requests);
    const idOk = idResult.status === "fulfilled" && idResult.value?.success === true &&
      Array.isArray(idResult.value.identities);
    const records = reqOk ? reqResult.value.requests : null;
    const identities = idOk ? idResult.value.identities : null;
    const count = (state) => records.filter(record =>
      record.projectId !== "mcp-connection" && record.status === state).length;
    if (rt("runtime-mcp-connection-pending")) {
      rt("runtime-mcp-connection-pending").textContent = connected?.success === true && connected.state === "verified" && Array.isArray(connected.clients)
        ? String(connected.clients.length) : "—";
    }
    if (rt("runtime-mcp-project-pending")) {
      rt("runtime-mcp-project-pending").textContent = reqOk ? String(count("pending")) : "—";
    }
    if (rt("runtime-mcp-approved-summary")) {
      rt("runtime-mcp-approved-summary").textContent = reqOk
        ? count("approved") + " riwayat keputusan disetujui (bukan verifikasi grant aktif)"
        : "Riwayat: tidak tersedia";
    }
    if (rt("runtime-mcp-identity-summary")) {
      rt("runtime-mcp-identity-summary").textContent = idOk
        ? identities.length + " identitas dikenal (termasuk permintaan terakhir; bukan jumlah online)"
        : "Identitas: tidak tersedia";
    }
    if (status) {
      const missing = [];
      if (!reqOk) missing.push("permintaan izin");
      if (!idOk) missing.push("identitas");
      status.dataset.state = missing.length ? "error" : "ready";
      status.textContent = missing.length
        ? "Data " + missing.join(" dan ") + " tidak tersedia. Tanda — bukan berarti nol. Periksa Core atau Security Approval Manager."
        : "Data read-only; setiap persetujuan atau pencabutan dilakukan melalui dialog native Security Approval Manager.";
    }
  } catch {
    window.__superagentRenderMcpClientList?.(null);
    if (status) {
      status.dataset.state = "error";
      status.textContent = "Status MCP tidak tersedia. Tidak ada izin yang diubah.";
    }
  } finally {
    runtimeMcpSecurityBusy = false;
  }
}

function runtimeOpenMcpSecurity(event) {
  const button = event.target?.closest?.("button[data-runtime-security-tab]");
  if (!button || button.disabled) return;
  const tab = button.dataset.runtimeSecurityTab;
  if (tab !== "connections" && tab !== "mcp") return;
  if (typeof window.navigateToPage !== "function") {
    window.TrayFeedback?.notify?.({kind:"error",scope:"runtime",
      message:"Buka Security Approval Manager dari navigasi utama."});
    return;
  }
  window.navigateToPage("security");
  if (typeof window.__superagentAccessManagerOpenTab === "function") {
    window.__superagentAccessManagerOpenTab(tab);
  } else {
    rt(tab === "mcp" ? "access-nav-tab-mcp" : "access-nav-tab-connections")?.click?.();
  }
}

function runtimeYoloMarkup(currentMode = runtimeCurrentYoloMode) {
  const mode = ["off", "scoped", "full"].includes(currentMode) ? currentMode : "off";
  const captions = {
    off: "Chat Agent: YOLO nonaktif. Pengaturan ini tidak memengaruhi izin koneksi MCP.",
    scoped: "Chat Agent: eksekusi terbatas dalam workspace. MCP tetap memakai Security Approval.",
    full: "Chat Agent: mode Full. MCP tetap memerlukan grant dan OAuth yang terpisah."
  };
  const badgeClasses = {
    off: "yolo-badge-safe",
    scoped: "yolo-badge-warn",
    full: "yolo-badge-danger"
  };
  const badgeLabels = {
    off: "OFF",
    scoped: "STANDAR",
    full: "FULL"
  };
  return `<div class="runtime-yolo-control" data-current-yolo="${runtimeEscape(mode)}">
    <div class="runtime-yolo-header">
      <div class="runtime-yolo-title">
        <span class="yolo-badge ${badgeClasses[mode]}">${badgeLabels[mode]}</span>
        <strong>Chat Agent YOLO Policy</strong>
      </div>
      <small class="runtime-yolo-caption">${runtimeEscape(captions[mode])}</small>
    </div>
    <div class="runtime-yolo-chips" role="radiogroup" aria-label="YOLO Execution Mode">
      <button type="button" class="button ghost yolo-chip ${mode === 'off' ? 'active' : ''}"
        data-runtime-yolo="off" title="Tanpa YOLO: Fail-closed, hanya tool aman/read-only">Tanpa YOLO</button>
      <button type="button" class="button ghost yolo-chip ${mode === 'scoped' ? 'active' : ''}"
        data-runtime-yolo="scoped" title="YOLO Standar: Tool diizinkan di workspace project">YOLO Standar</button>
      <button type="button" class="button ghost yolo-chip ${mode === 'full' ? 'active' : ''}"
        data-runtime-yolo="full" title="YOLO Full: Akses penuh tanpa batasan workspace, path, atau grant">YOLO Full</button>
    </div>
  </div>`;
}

async function runtimeGetYoloMode() {
  // Chat Agent policy is read only through the installed native Tray.
  // A browser or MCP connection must not control this setting via a web fallback.
  try {
    const mode = await runtimeInvoke("get_yolo_mode");
    if (["off", "scoped", "full"].includes(mode)) runtimeCurrentYoloMode = mode;
  } catch {
    // Do not claim a successful mode read if the native host is unavailable.
  }
  return runtimeCurrentYoloMode;
}

async function runtimeSetYoloMode(mode) {
  if (!["off", "scoped", "full"].includes(mode)) return;
  const labels = {
    off: "Tanpa YOLO (Safe / Read-only)",
    scoped: "YOLO Standar (Scoped)",
    full: "YOLO Full (Unrestricted)"
  };
  try {
    // The local native Tray is the only UI channel for Chat Agent YOLO.
    // No MCP/HTTP fallback when the native permission boundary denies a change.
    await runtimeInvoke("set_yolo_mode", { mode });
    runtimeCurrentYoloMode = mode;
    document.querySelectorAll(".runtime-yolo-control[data-current-yolo]").forEach(ctrl => {
      ctrl.dataset.currentYolo = mode;
      ctrl.querySelectorAll(".yolo-chip").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.runtimeYolo === mode);
      });
      const badge = ctrl.querySelector(".yolo-badge");
      if (badge) {
        badge.className = "yolo-badge " + (mode === "full" ? "yolo-badge-danger" : mode === "scoped" ? "yolo-badge-warn" : "yolo-badge-safe");
        badge.textContent = mode === "full" ? "FULL" : mode === "scoped" ? "STANDAR" : "OFF";
      }
      const caption = ctrl.querySelector(".runtime-yolo-caption");
      if (caption) {
        const captions = {
          off: "Chat Agent: YOLO nonaktif. Pengaturan ini tidak memengaruhi izin koneksi MCP.",
          scoped: "Chat Agent: tool terbatas pada workspace & parent; izin MCP terpisah.",
          full: "Chat Agent: mode Full. MCP tetap memerlukan grant dan OAuth yang terpisah."
        };
        caption.textContent = captions[mode];
      }
    });
    window.TrayFeedback?.notify?.({
      kind: "success",
      scope: "runtime",
      message: `YOLO policy diubah ke ${labels[mode]}.`
    });
  } catch (err) {
    window.TrayFeedback?.notify?.({
      kind: "error",
      scope: "runtime",
      message: "Gagal mengubah mode YOLO: " + (err?.message || String(err))
    });
  }
}

async function runtimeYoloChipClick(event) {
  const chip = event.target?.closest?.("button.yolo-chip");
  if (!chip || !chip.dataset.runtimeYolo) return;
  const targetMode = chip.dataset.runtimeYolo;
  if (targetMode === runtimeCurrentYoloMode) return;
  await runtimeSetYoloMode(targetMode);
}

function runtimeRemoteCard(service) {
  const titles = {
    mcp: "MCP HTTP Server",
    cloudflare: "Cloudflare Tunnel",
    "muse-watch": "Muse Watch",
    "core-supervisor": "Core Supervisor"
  };
  const isExternalTunnel = service.kind === "cloudflare" && service.source === "os";
  const name = isExternalTunnel ? "External Cloudflare Tunnel" :
    (titles[service.kind] || "SuperAgent Remote Service");
  const transition = runtimeStopTransitions.get(runtimeStopKey(service));
  if (transition && transition.phase !== "removed") {
    const stopping = transition.phase === "stopping";
    return `<article class="runtime-instance compact runtime-instance--${stopping ? "stopping" : "stopped"}"
        data-runtime-service-kind="${runtimeEscape(service.kind)}"
        aria-busy="${stopping}">
      <div class="runtime-instance-head">
        <div><strong>${runtimeEscape(name)} · :${runtimeEscape(service.port ?? "-")}</strong>
          <small>PID ${runtimeEscape(service.pid ?? "-")} · verified owner</small></div>
        <span class="runtime-state ${stopping ? "warn" : "dim"}" role="status">
          ${stopping ? "Stopping…" : "Stopped"}</span>
      </div>
      <div class="runtime-evidence">${stopping
        ? "Waiting for authenticated owner shutdown and exit verification…"
        : "Owner exit verified. Removing this entry from the active list…"}</div>
    </article>`;
  }
  const port = service.port
    ? service.kind === "muse-watch" ? ` · control :${service.port}` : ` · :${service.port}`
    : "";
  const supported = service.canStop === true || service.canRestart === true;
  const endpointKind = service.kind === "mcp" ? "mcp" : "origin";
  const url = service.source === "registry" &&
    ["online", "observed"].includes(service.state) &&
    ["mcp", "cloudflare"].includes(service.kind)
    ? runtimeSafePublicUrl(service.publicUrl, endpointKind) : null;
  const isMcpTunnel = service.kind === "cloudflare" && service.transport === "mcp-http";
  const mcpService = isMcpTunnel
    ? runtimeLastResult?.remoteServices?.find(s => s.kind === "mcp" && s.port === service.port)
    : null;
  const rotateKind = isMcpTunnel && mcpService ? "mcp" : service.kind;
  const rotatePort = service.port;
  const rotatePid = isMcpTunnel && mcpService ? mcpService.pid : service.pid;
  const canRotate = (service.kind === "mcp" || service.kind === "muse-watch")
    ? service.canRegenerateToken === true
    : (isMcpTunnel && mcpService?.canRegenerateToken === true);

  const controlHint = service.kind === "cloudflare"
    ? (isMcpTunnel
        ? `Tunnel ingress is managed by its MCP owner (port ${service.port}); use Regenerate Token to rotate OAuth credentials.`
        : "Tunnel lifecycle belongs to its service owner; control MCP from the MCP card.")
    : service.kind === "muse-watch"
      ? "Watcher belum punya endpoint privat terverifikasi atau tugas masih aktif. Versi lama perlu restart terkontrol."
      : service.kind === "core-supervisor"
        ? "Supervisor can restart safely; stopping the full Core owner requires a separate drain policy."
        : "Managed owner required; stop is unavailable when sessions or tool requests are in flight.";
  const rotateButton = service.kind === "mcp" || service.kind === "muse-watch" || (isMcpTunnel && mcpService)
    ? `<button type="button" class="button ghost runtime-regenerate-token"
       data-runtime-kind="${runtimeEscape(rotateKind)}"
       data-runtime-port="${runtimeEscape(rotatePort)}"
       data-runtime-pid="${runtimeEscape(rotatePid)}"
       ${canRotate ? "" : "disabled"}
       title="Regenerate supported owner credential; new token is copied to OS clipboard">Regenerate Token</button>`
    : "";
  const configureButton = service.kind === "mcp"
    ? `<button type="button" class="button ghost runtime-configure-mcp"
       data-runtime-port="${runtimeEscape(service.port)}"
       data-runtime-pid="${runtimeEscape(service.pid)}"
       ${service.canConfigureMcp === true ? "" : "disabled"}
       title="${service.canConfigureMcp === true
         ? "Edit this MCP owner's tool discovery and security policy"
         : "Requires a verified reloadable Cloudflare owner with no active requests"}">Edit Configuration</button>`
    : "";
  const controls = isExternalTunnel
    ? '<div class="runtime-instance-footer"><span class="subtle-badge">Read-only · External process</span></div>'
    : `<div class="runtime-instance-footer">
        <button type="button" class="button ghost runtime-lifecycle"
          data-runtime-kind="${runtimeEscape(service.kind)}" data-runtime-action="stop"
          data-runtime-port="${runtimeEscape(service.port)}" data-runtime-pid="${runtimeEscape(service.pid)}"
          ${service.canStop ? "" : "disabled"} title="Graceful stop only; no forced process termination">Stop</button>
        <button type="button" class="button ghost runtime-lifecycle"
          data-runtime-kind="${runtimeEscape(service.kind)}" data-runtime-action="restart"
          data-runtime-port="${runtimeEscape(service.port)}" data-runtime-pid="${runtimeEscape(service.pid)}"
          ${service.canRestart ? "" : "disabled"} title="Owner-managed restart/reload with safety checks">Restart</button>
         ${rotateButton}
         ${configureButton}
      </div>`;
  return `<article class="runtime-instance compact" data-runtime-service-kind="${runtimeEscape(service.kind)}">
    <div class="runtime-instance-head">
      <div><strong>${runtimeEscape(name)}${runtimeEscape(port)}</strong>
        <small>PID ${runtimeEscape(service.pid ?? "-")} · ${runtimeEscape(service.transport || "unknown")}</small></div>
      ${runtimeStatusPill(service.state)}
    </div>
    <div class="runtime-evidence">${runtimeEscape(service.detail || "")}
      · ${runtimeEscape(service.evidence || "")}</div>
    ${url ? runtimeEndpointMarkup(url, service.urlEvidence || "Owner-reported endpoint · edge status unverified")
      : service.kind === "cloudflare" && !service.publicUrl
        ? `<div class="runtime-evidence">${isExternalTunnel
          ? "External cloudflared detected; public URL unknown and controls disabled."
          : "Public URL unavailable from verified owner metadata."}</div>` : ""}
    ${service.kind === "mcp" ? `<div class="runtime-mcp-owner-scope">OAuth + Security Approval · Chat YOLO tidak berlaku untuk MCP</div><div class="runtime-evidence">Tool catalog: ${runtimeEscape(service.toolExposure || "not recorded")} · Tool mode: ${runtimeEscape(service.toolMode || "not recorded")}</div>` : ""}
    ${controls}
    ${service.controlReason
      ? `<div class="runtime-evidence">${runtimeEscape(service.controlReason)}</div>`
      : !supported ? `<div class="runtime-evidence">${runtimeEscape(controlHint)}</div>` : ""}
    ${(service.kind === "mcp" || service.kind === "muse-watch" || (isMcpTunnel && mcpService)) &&
       !canRotate
        ? `<div class="runtime-evidence">${runtimeEscape(service.kind === "muse-watch"
            ? "Regenerate Token memerlukan Muse WebSocket owner aktif tanpa tugas berjalan."
            : "Regenerate Token memerlukan MCP OAuth owner versi reloadable; static Bearer/OpenAI/legacy belum didukung.")}</div>`
        : ""}
  </article>`;
}
function runtimeSelectedMuseCore(snapshot = runtimeLastResult) {
  return snapshot?.cores?.find(core =>
    core.port === snapshot.selectedCorePort && core.state === "online" &&
    core.pidVerified === true && Number.isSafeInteger(core.pid) && core.pid > 0) || null;
}

function runtimeMuseControlState(snapshot = runtimeLastResult) {
  const core = runtimeSelectedMuseCore(snapshot);
  const muse = core?.services?.muse;
  return {
    available: Boolean(core) && typeof muse?.watcherActive === "boolean",
    coreAvailable: Boolean(core), running: muse?.watcherActive === true,
    ownerPresent: muse?.ownerPresent === true, configStale: muse?.configStale === true,
    port: core?.port, pid: core?.pid,
  };
}

window.__superagentMuseControlState = runtimeMuseControlState;
window.__superagentMuseQuickAction = async (action) => {
  const state = runtimeMuseControlState();
  const starts = ["start-telegram", "start-websocket", "start-tunnel"];
  if (!state.available || (starts.includes(action) && state.running) ||
      (["stop", "restart", "apply-restart"].includes(action) &&
       (!state.running || !state.ownerPresent)) ||
      (action === "apply-restart" && !state.configStale)) return;
  await runtimeServiceAction({ target: { closest: () => ({
    disabled: false,
    dataset: { runtimeKind: "muse-core", runtimeAction: action,
      runtimePort: String(state.port), runtimePid: String(state.pid) },
  }) } });
};

const runtimeTabNames = ["core", "mcp", "cloudflare", "muse", "chrome", "processes", "hosts"];
const runtimeRemoteTabs = {
  core: { kind: "core-supervisor", title: "Independent Core Supervisors", tag: "Owner-verified",
    empty: "No independent Core supervisor registered outside the Core list." },
  mcp: { kind: "mcp", title: "Independent MCP Owners", tag: "MCP HTTP / OAuth",
    empty: "No independent MCP owner detected. Create a tunnel using New Connection." },
  cloudflare: { kind: "cloudflare", title: "Cloudflare Tunnels", tag: "Public ingress",
    empty: "No Cloudflare tunnel registered. Tunnel status depends on the verified service owner." },
  muse: { kind: "muse-watch", title: "Independent Muse Watch", tag: "Cross-process",
    empty: "No independent Muse watcher detected. Core-local Muse is shown separately above." },
};
let runtimeActiveTab = "core";

function runtimeMuseLocalCard(snapshot) {
  const core = runtimeSelectedMuseCore(snapshot);
  const muse = core?.services?.muse;
  if (!core || typeof muse?.watcherActive !== "boolean") {
    return '<p class="empty-state">No selected, verified Core with Muse Watch status. Select an authenticated Core first.</p>';
  }
  const data = `data-runtime-kind="muse-core" data-runtime-port="${core.port}" data-runtime-pid="${core.pid}"`;
  const controls = muse.watcherActive
    ? `<button type="button" class="button ghost runtime-lifecycle" data-runtime-action="stop" ${data}>Stop Muse</button>
       <button type="button" class="button ghost runtime-lifecycle" data-runtime-action="restart" ${data} ${muse.ownerPresent ? "" : "disabled"}>Restart Muse</button>
       ${muse.configStale ? `<button type="button" class="button ghost runtime-lifecycle" data-runtime-action="apply-restart" ${data} ${muse.ownerPresent ? "" : "disabled"}>Apply &amp; Restart</button>` : ""}
       ${muse.transport === "websocket" ? `<button type="button" class="button ghost runtime-regenerate-token" ${data} ${muse.ownerPresent ? "" : "disabled"}>Regenerate Muse Token</button>` : ""}`
    : `<button type="button" class="button ghost runtime-lifecycle" data-runtime-action="start-telegram" ${data}>Start Muse · Telegram</button>
       <button type="button" class="button ghost runtime-lifecycle" data-runtime-action="start-websocket" ${data}>Start Muse · WebSocket</button>
       <button type="button" class="button ghost runtime-lifecycle" data-runtime-action="start-tunnel" ${data}>Start Muse · Tunnel</button>`;
  const details = [
    muse.transport ? `Transport: ${String(muse.transport)}` : null,
    Number.isFinite(muse.queuedBatches) && muse.queuedBatches > 0 ? `${muse.queuedBatches} queued` : null,
    muse.configStale ? "Saved configuration changed" : null,
    muse.watcherActive && !muse.connected ? "Connection not ready" : null,
  ].filter(Boolean).join(" · ");
  return `<article class="runtime-instance compact">
    <div class="runtime-instance-head">
      <div><strong>Core-local Muse Watch · :${core.port}</strong>
        <small>Verified Core PID ${core.pid} · ${runtimeEscape(details || "Uses selected authenticated Core")}</small></div>
      ${runtimeStatusPill(muse.watcherActive ? "active" : "idle")}
    </div>
    <div class="runtime-instance-footer">${controls}</div>
  </article>`;
}

function runtimeApplyTab() {
  const tab = runtimeTabNames.includes(runtimeActiveTab) ? runtimeActiveTab : "core";
  const config = runtimeRemoteTabs[tab];
  const snapshot = runtimeLastResult || {};
  const remote = runtimeVisibleRemote(snapshot);
  const matched = config ? remote.filter(service => service.kind === config.kind) : [];
  const counts = {
    core: (snapshot.cores?.length || 0) + remote.filter(s => s.kind === "core-supervisor").length,
    mcp: remote.filter(s => s.kind === "mcp").length,
    cloudflare: remote.filter(s => s.kind === "cloudflare").length,
    muse: remote.filter(s => s.kind === "muse-watch").length +
      (typeof runtimeSelectedMuseCore(snapshot)?.services?.muse?.watcherActive === "boolean" ? 1 : 0),
    chrome: Number(rt("runtime-tab-chrome-count")?.dataset?.ownedCount || 0) || 0,
    processes: snapshot.processes?.length || 0,
    hosts: snapshot.independentHosts?.length || 0,
  };
  for (const name of runtimeTabNames) {
    const button = rt("runtime-tab-" + name);
    if (button) {
      button.setAttribute?.("aria-selected", String(name === tab));
      button.tabIndex = name === tab ? 0 : -1;
    }
    const count = rt("runtime-tab-" + name + "-count");
    if (count) count.textContent = String(counts[name]);
  }
  const visible = {
    "runtime-servers-panel": tab === "core",
    "runtime-processes-panel": tab === "processes",
    "runtime-muse-panel": tab === "muse",
    "runtime-chrome-panel": tab === "chrome",
    "runtime-remote-panel": Boolean(config) && (tab !== "core" || matched.length > 0),
    "runtime-hosts-panel": tab === "hosts",
  };
  for (const [id, show] of Object.entries(visible)) {
    const panel = rt(id);
    if (panel) panel.hidden = !show;
  }
  const remoteNode = rt("runtime-remote");
  if (remoteNode?.dataset) remoteNode.dataset.runtimeView = tab;
  const namedEntry=rt("runtime-named-tunnel-entry");
  if (namedEntry) namedEntry.hidden = tab !== "cloudflare";
  const cfEndpoints = rt("runtime-cloudflare-endpoints");
  if (cfEndpoints) cfEndpoints.hidden = tab !== "cloudflare";
  const trayCard = rt("runtime-tray-gateway");
  const namedCard = rt("runtime-named-mcp-status");
  if (trayCard) trayCard.hidden = tab !== "cloudflare";
  if (namedCard) namedCard.hidden = tab !== "cloudflare";
  const mcpAccess = rt("runtime-mcp-security");
  if (mcpAccess) mcpAccess.hidden = tab !== "mcp";
  const mcpConnected=rt("runtime-mcp-connected-panel");
  if (mcpConnected) mcpConnected.hidden = tab !== "mcp";
  const remotePanel = rt("runtime-remote-panel");
  remotePanel?.setAttribute?.("aria-labelledby", "runtime-tab-" + tab);
  if (config) {
    rt("runtime-remote-heading").textContent = config.title;
    rt("runtime-remote-tag").textContent = config.tag;
    const active = matched.filter(s => s.state === "online" || s.state === "observed").length;
    rt("runtime-remote-count").textContent = `(${active} active/detected · ${matched.length} ${tab === "cloudflare" ? "found" : "registered"})`;
    const empty = rt("runtime-remote-empty");
    if (empty) {
      empty.hidden = matched.length > 0;
      empty.textContent = config.empty;
    }
  }
}

function runtimeSelectTab(tab, focus = false) {
  if (!runtimeTabNames.includes(tab)) return;
  runtimeActiveTab = tab;
  runtimeApplyTab();
  if (tab === "mcp") {
    void runtimeRefreshMcpSecurity();
    void runtimeLoadMcpAgentPrompt();
  }
  if (tab === "chrome") window.__superagentManagedChromeRefresh?.();
  if (focus) rt("runtime-tab-" + tab)?.focus?.();
}

// Notification deep links select a known Runtime category without changing
// service ownership, grants, or the user's configured process state.
window.__superagentRuntimeOpenTab = (tab) => {
  if (runtimeTabNames.includes(tab)) runtimeSelectTab(tab);
};

function runtimeTabKeydown(event) {
  const current = runtimeTabNames.indexOf(event.currentTarget?.dataset?.runtimeTab);
  if (current < 0) return;
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % runtimeTabNames.length;
  else if (event.key === "ArrowLeft") next = (current + runtimeTabNames.length - 1) % runtimeTabNames.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = runtimeTabNames.length - 1;
  else return;
  event.preventDefault();
  runtimeSelectTab(runtimeTabNames[next], true);
}

function runtimeRender(snapshot, scanSerial = runtimeScanSerial) {
  runtimeReconcileStoppedOwners(snapshot, scanSerial);
  runtimeLastResult = snapshot;
  runtimeCopyAllowedUrls = new Set();
  rt("runtime-core-count").textContent = String(snapshot.healthyCoreCount || 0);
  rt("runtime-process-count").textContent = String(snapshot.activeProcessCount || 0);
  rt("runtime-selected-port").textContent = snapshot.selectedCorePort ? `:${snapshot.selectedCorePort}` : "Default";
  window.__SUPERAGENT_CORE_PORT = snapshot.selectedCorePort || null;

  const scanned = snapshot.scannedAt ? new Date(snapshot.scannedAt) : new Date();
  rt("runtime-scanned").textContent = `Scanned ${scanned.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;

  const servers = Array.isArray(snapshot.cores) ? snapshot.cores : [];
  rt("runtime-servers").innerHTML = servers.length
    ? servers.map(runtimeServerCard).join("")
    : '<p class="empty-state">No registered SuperAgent server-info records found. Start Core, then click Scan Now.</p>';

  const processes = Array.isArray(snapshot.processes) ? snapshot.processes : [];
  rt("runtime-processes").innerHTML = processes.length
    ? processes.map(runtimeProcessCard).join("")
    : '<p class="empty-state">No CLI or MCP sessions with active heartbeats in the process journal.</p>';

  const remote = runtimeVisibleRemote(snapshot);
  rt("runtime-remote-count").textContent =
    `(${remote.filter(s => s.state === "online" || s.state === "observed").length} active/detected · ${remote.length} registered)`;
  rt("runtime-remote").innerHTML = remote.map(runtimeRemoteCard).join("");
  if (rt("runtime-mcp-security")) rt("runtime-mcp-security").innerHTML = runtimeMcpSecurityControlMarkup();
  rt("runtime-muse-local").innerHTML = runtimeMuseLocalCard(snapshot);

  const hosts = Array.isArray(snapshot.independentHosts) ? snapshot.independentHosts : [];
  rt("runtime-independent-count").textContent = `(${hosts.length} detected)`;
  rt("runtime-independent").innerHTML = hosts.length
    ? hosts.map(runtimeHostCard).join("")
    : '<p class="empty-state">No independent T-Line transports or external channel hosts verified.</p>';

  rt("runtime-notes").textContent =
    "Online status requires an authentic loopback HTTP response with bearer authentication. Process discovery validates OS PID, creation time, and fresh heartbeats. " +
    "Registered service status uses owner records and endpoint/heartbeat evidence. The Cloudflare tab also observes OS cloudflared processes, but external tunnels remain read-only. Only validated HTTPS URLs from authenticated owner records are copyable. Public reachability is separate from process discovery. No credentials, command lines or token-bearing URLs are displayed.";
  rt("runtime-notes").hidden = false;
  runtimeApplyTab();
  window.__superagentLifecycleUpdateMuseControls?.();
}

async function runtimeServiceAction(event) {
  const button = event.target?.closest?.("button.runtime-lifecycle");
  if (!button || runtimeActionBusy || button.disabled) return;
  const { runtimeKind: kind, runtimeAction: action, runtimePort, runtimePid } = button.dataset;
  const port = Number(runtimePort), pid = Number(runtimePid);
  const startAction = ["start-telegram","start-websocket","start-tunnel"].includes(action);
  const applyAction = action === "apply-restart";
  const service = kind === "muse-core"
    ? (() => {
        const core = runtimeLastResult?.cores?.find(item =>
          item.port === port && item.port === runtimeLastResult?.selectedCorePort &&
          item.pid === pid && item.state === "online" && item.pidVerified === true);
        if (!core) return null;
        const museState=core.services?.muse;
        return {kind,port,pid,
          canStart:museState?.watcherActive===false,
          canStop:museState?.watcherActive===true,
          canRestart:museState?.ownerPresent===true,
          canApply:museState?.watcherActive===true && museState?.configStale===true};
      })()
    : runtimeLastResult?.remoteServices?.find(item =>
        item.kind === kind && item.port === port && item.pid === pid);
  if (!service || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(pid) || pid < 1 ||
      (action === "stop" ? service.canStop !== true :
       action === "restart" ? service.canRestart !== true :
       applyAction ? service.canApply !== true :
       startAction ? service.canStart !== true : true)) {
    return;
  }
  const label = kind === "mcp" ? "MCP managed owner"
    : kind === "core-supervisor" ? "SuperAgent Core Supervisor"
    : kind === "muse-core" ? "Core-local Muse Watch" : kind;
  const warning = action === "stop"
    ? "Stop will close this owner's connections. Active sessions/tasks block safe stopping."
    : applyAction
      ? "Apply the latest saved Muse settings by rebuilding the idle watcher. Active/queued tasks and public tunnel owners are rejected."
    : startAction
      ? action === "start-telegram"
        ? "Start Muse Watch with the saved Telegram bot/group configuration. Existing remote tasks are never interrupted."
        : action === "start-websocket"
          ? "Start Muse WebSocket using the saved mode, port, path and credentials. Server mode copies its private connection string to your clipboard."
          : "Start Muse WebSocket plus a Cloudflare tunnel. This creates a public WSS endpoint and copies its private connection prompt to your clipboard."
      : kind === "mcp"
        ? "Restart reloads the MCP backend and preserves its public tunnel URL when supported."
        : kind === "muse-core"
          ? "Restart preserves this Core-owned watcher's current in-memory configuration. Active/queued tasks and tunnel-owned watchers are rejected."
          : "Restart creates a new supervised Core generation while retaining existing session owners.";
  const verb=startAction ? "Start" : applyAction ? "Apply & Restart" : action === "stop" ? "Stop" : "Restart";
  if (!window.confirm(`${verb} ${label} :${port} (PID ${pid})?\n\n${warning}\n\nThis action cannot be undone from this dialog.`)) return;
  runtimeActionBusy = true;
  // Muse Watch's Stop intentionally leaves an idle owner available for restart.
  // Only MCP Stop is an owner-exit operation and should remove its card.
  const stopKey = kind === "mcp" && action === "stop" ? runtimeStopKey(service) : null;
  if (stopKey) {
    runtimeStopTransitions.set(stopKey, { phase: "stopping", service });
    runtimeRenderRemoteList();
  }
  const ticket = window.TrayFeedback?.begin({
    key: "runtime:service:" + kind + ":" + port + ":" + action,
    button, label: verb + "…",
  });
  button.disabled = true;
  const message = rt("runtime-action-feedback");
  message.hidden = false;
  message.textContent = `Requesting ${action} for ${label} on port ${port}...`;
  try {
    const result = await runtimeInvoke("service_action", { kind, action, port, pid });
    if (result?.success !== true) throw new Error("The service owner did not confirm the operation");
    message.textContent = result.message || `${label} ${startAction ? "start" : action} confirmed.`;
    if (stopKey) {
      // Native stop success means process exit has already been verified.
      runtimeAnimateVerifiedStop(service);
    }
    window.TrayFeedback?.notify({ kind: "success", scope: "runtime",
      message: stopKey ? "Owner stopped and verified; listing is updating." :
        verb + " accepted by verified service owner." });
    await runtimeRefresh(true);
  } catch (error) {
    if (stopKey) {
      runtimeStopTransitions.delete(stopKey);
      runtimeRenderRemoteList();
    }
    const unknown = /timed out|timeout|connection lost/i.test(String(error));
    message.textContent = unknown
      ? "Outcome uncertain. Recheck the exact owner and operation journal before further action."
      : "Lifecycle action not performed or not verified. Inspect the service status.";
    window.TrayFeedback?.notify({ kind: unknown ? "warning" : "error", scope: "runtime",
      message: unknown ? "Service result uncertain; inspect owner before retry."
        : "Service action was not verified." });
    button.disabled = false;
  } finally {
    runtimeActionBusy = false;
    ticket?.end();
  }
}

function runtimeCreateKindChanged() {
  const kind = rt("runtime-create-kind")?.value || "mcp-client";
  const provider = rt("runtime-create-provider")?.value || "cloudflare";
  const show = (id, visible) => { const node = rt(id); if (node) node.hidden = !visible; };
  show("runtime-create-name-field", kind === "mcp-client");
  show("runtime-create-url-field", kind === "mcp-client");
  show("runtime-create-oauth-field", kind === "mcp-client");
  show("runtime-create-port-field", kind !== "mcp-client" && kind !== "core-tunnel");
  show("runtime-create-provider-field", kind === "mcp-tunnel");
  show("runtime-create-tunnelid-field", kind === "mcp-tunnel" && provider === "openai");
  show("runtime-create-mcp-modes-field", kind === "mcp-tunnel");
  const guidelines = {
    "mcp-client": "Saves an external MCP client over HTTPS or loopback HTTP. Does not disconnect existing MCP clients; connect/reload it in your active session.",
    "mcp-tunnel": "Creates a new MCP owner with the selected Gateway/Full catalog exposure and Safe/Dangerous tool mode. OAuth is mandatory; discovery does not grant permission to execute tools. Existing ports are never replaced.",
    "core-tunnel": "Creates a public HTTPS address for the selected Core API. Bearer authentication remains enabled. Anyone with a valid Core token may access it; do not expose tokens.",
    "muse-tunnel": "Creates an inbound Muse WebSocket owner with an isolated bearer token and Cloudflare WSS tunnel. Uses configured watched workspaces; task execution is permission-gated. No Telegram settings overwritten.",
  };
  const guidance = rt("runtime-create-guidance");
  if (guidance) guidance.textContent = guidelines[kind] || "";
  const portInput = rt("runtime-create-port");
  if (portInput && kind === "muse-tunnel" && (!portInput.value || portInput.value === "9227")) {
    portInput.value = "9225";
  } else if (portInput && kind === "mcp-tunnel" && (!portInput.value || portInput.value === "9225")) {
    portInput.value = "9227";
  }
}

async function runtimeRegenerateToken(event) {
  const button = event.target?.closest?.("button.runtime-regenerate-token");
  if (!button || button.disabled || runtimeActionBusy) return;
  const {runtimeKind:kind,runtimePort,runtimePid}=button.dataset;
  const port=Number(runtimePort), pid=Number(runtimePid);
  if (!Number.isSafeInteger(port)||port<1024||port>65535||
      !Number.isSafeInteger(pid)||pid<=0) return;
  const snapshot=runtimeLastResult;
  const eligible=kind==="muse-core"
    ? snapshot?.cores?.some(core=>
        core.port===port && core.pid===pid && core.state==="online" &&
        core.pidVerified===true && core.port===snapshot.selectedCorePort &&
        core.services?.muse?.ownerPresent===true &&
        core.services?.muse?.watcherActive===true &&
        core.services?.muse?.transport==="websocket")
    : snapshot?.remoteServices?.some(service=>
        service.kind===kind && service.port===port && service.pid===pid &&
        service.canRegenerateToken===true);
  if (!eligible || !["mcp","muse-watch","muse-core"].includes(kind)) return;
  const warning=kind==="mcp"
    ? "Regenerate the ONE-TIME MCP OAuth bootstrap approval code? Existing OAuth sessions and the public tunnel URL will remain unchanged. This does NOT rotate Cloudflare credentials or OpenAI tunnel IDs."
    : "Rotate Muse WebSocket bearer token? The existing token remains valid for a 5-minute grace period. The new private connection details will be copied to your OS clipboard and sent to the active Muse WebSocket client.";
  if (!window.confirm(warning + "\n\nThe previous approval code/token cannot be recovered after the grace period. Continue?")) return;
  const feedback=rt("runtime-action-feedback");
  runtimeActionBusy=true;
  button.disabled=true;
  if (feedback) {
    feedback.hidden=false;
    feedback.textContent=`Regenerating owner token on :${port}...`;
  }
  try {
    const result=await runtimeInvoke("regenerate_token",{kind,port,pid});
    if (result?.success!==true) throw new Error("Owner did not verify token rotation");
    if (feedback) {
      if (result.code) {
        feedback.innerHTML = `Token rotated! Code: <code class="runtime-inline-code">${runtimeEscape(result.code)}</code> (copied to clipboard)`;
      } else {
        feedback.textContent=String(result.message||
          (result.copied ? "Token rotated and copied to OS clipboard" :
            "Token rotated; clipboard copy unavailable"));
      }
    }
    await runtimeRefresh();
  } catch(error) {
    if (feedback) feedback.textContent="Token regeneration rejected or not verified: "+String(error);
    button.disabled=false;
  } finally {
    runtimeActionBusy=false;
  }
}

let runtimeMcpConfigTarget = null;
let runtimeMcpConfigReturnFocus = null;

function runtimeCloseMcpConfig() {
  const dialog = rt("runtime-mcp-config-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  runtimeMcpConfigTarget = null;
  runtimeMcpConfigReturnFocus?.focus?.();
  runtimeMcpConfigReturnFocus = null;
}

function runtimeOpenMcpConfig(event) {
  const button = event.target?.closest?.("button.runtime-configure-mcp");
  if (!button || button.disabled || runtimeActionBusy) return;
  const port = Number(button.dataset.runtimePort);
  const pid = Number(button.dataset.runtimePid);
  if (!Number.isSafeInteger(port) || port < 1024 || !Number.isSafeInteger(pid) || pid <= 0) return;
  const service = runtimeLastResult?.remoteServices?.find(item =>
    item.kind === "mcp" && item.port === port && item.pid === pid);
  if (!service || service.canConfigureMcp !== true) return;
  runtimeMcpConfigTarget = {port, pid};
  runtimeMcpConfigReturnFocus = button;
  rt("runtime-mcp-config-owner").textContent =
    `MCP HTTP Server :${port} · PID ${pid} · ${service.toolExposure || "mode not recorded"} / ${service.toolMode || "mode not recorded"}`;
  rt("runtime-mcp-config-exposure").value = service.toolExposure || "gateway";
  rt("runtime-mcp-config-mode").value = service.toolMode || "safe";
  rt("runtime-mcp-config-feedback").textContent = "";
  rt("runtime-mcp-config-dialog").hidden = false;
  rt("runtime-mcp-config-close")?.focus?.();
}

async function runtimeSaveMcpConfig(event) {
  event?.preventDefault?.();
  if (runtimeActionBusy || !runtimeMcpConfigTarget) return;
  const {port, pid} = runtimeMcpConfigTarget;
  const service = runtimeLastResult?.remoteServices?.find(item =>
    item.kind === "mcp" && item.port === port && item.pid === pid);
  const toolExposure = rt("runtime-mcp-config-exposure")?.value;
  const toolMode = rt("runtime-mcp-config-mode")?.value;
  const feedback = rt("runtime-mcp-config-feedback");
  const submit = rt("runtime-mcp-config-apply");
  if (!service || service.canConfigureMcp !== true) {
    if (feedback) feedback.textContent = "This MCP owner is no longer verified or has active requests. Refresh status and retry.";
    return;
  }
  if (!["gateway", "full"].includes(toolExposure) || !["safe", "dangerous"].includes(toolMode)) {
    if (feedback) feedback.textContent = "Select a valid tool exposure and security mode.";
    return;
  }
  if (toolExposure === service.toolExposure && toolMode === service.toolMode) {
    runtimeCloseMcpConfig();
    return;
  }
  const summary = `Apply ${toolExposure.toUpperCase()} exposure and ${toolMode.toUpperCase()} security mode to MCP :${port} (PID ${pid})?\n\nThe public MCP URL and OAuth issuer stay the same. Existing MCP sessions will be closed and connected clients must reconnect. The change is blocked while requests/tool calls are running.`;
  if (!window.confirm(summary)) return;
  runtimeActionBusy = true;
  if (submit) submit.disabled = true;
  if (feedback) feedback.textContent = "Starting a verified MCP backend generation with the new configuration…";
  try {
    const result = await runtimeInvoke("configure_mcp", {port, pid, toolMode, toolExposure});
    if (result?.success !== true || result.publicUrl !== service.publicUrl && service.publicUrl) {
      throw new Error(result?.error || "MCP owner did not confirm the new configuration and stable endpoint");
    }
    const actionFeedback = rt("runtime-action-feedback");
    if (actionFeedback) {
      actionFeedback.hidden = false;
      actionFeedback.textContent =
        `MCP :${port} updated to ${toolExposure}/${toolMode}. Public URL preserved. ${Number(result.sessionsClosed || 0)} old session(s) closed; reconnect MCP clients.`;
    }
    window.TrayFeedback?.notify({
      kind: "success", scope: "runtime",
      message: `MCP :${port} configuration applied. Reconnect clients to use the new policy.`,
    });
    runtimeCloseMcpConfig();
    await runtimeRefresh(true);
  } catch (error) {
    if (feedback) feedback.textContent = "Configuration was not applied or could not be verified: " + String(error);
  } finally {
    runtimeActionBusy = false;
    if (submit) submit.disabled = false;
  }
}

const RUNTIME_MCP_PROMPT_TEMPLATE = [
  "## Tools to inspect first",
  "- Workspace and project status before any file or shell action.",
  "- Diagnostics when a service reports unhealthy.",
  "",
  "## Project context",
  "- Workspace, stack, and where the relevant code lives.",
  "",
  "## Access limits",
  "- Read inside the registered project only.",
  "- Ask for an explicit grant before write, execute, or path-escaping actions.",
].join("\n");

function runtimeMcpPromptCounter() {
  const input = rt("runtime-mcp-prompt-input");
  const count = rt("runtime-mcp-prompt-count");
  if (!input || !count) return;
  count.textContent = `${input.value.length} / ${input.maxLength} characters`;
}

function runtimeMcpPromptState(text, state) {
  const node = rt("runtime-mcp-prompt-state");
  if (!node) return;
  node.textContent = text;
  if (state) node.dataset.state = state;
  else delete node.dataset.state;
}

function runtimeMcpPromptFeedback(text, tone) {
  const node = rt("runtime-mcp-prompt-feedback");
  if (!node) return;
  node.textContent = text || "";
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

async function runtimeLoadMcpAgentPrompt() {
  const input = rt("runtime-mcp-prompt-input");
  if (!input) return;
  runtimeMcpPromptState("Loading…");
  try {
    const result = await runtimeInvoke("get_mcp_agent_prompt");
    input.value = typeof result?.prompt === "string" ? result.prompt : "";
    if (Number.isSafeInteger(result?.maxChars) && result.maxChars > 0) {
      input.maxLength = Math.min(result.maxChars, 20000);
    }
    runtimeMcpPromptCounter();
    runtimeMcpPromptState(result?.updatedAt ? "Saved prompt" : "Not set", "saved");
  } catch (error) {
    runtimeMcpPromptState("Unavailable", "error");
    runtimeMcpPromptFeedback("Could not read the saved prompt: " + String(error), "error");
  }
}

async function runtimeSaveMcpAgentPrompt() {
  const input = rt("runtime-mcp-prompt-input");
  const save = rt("runtime-mcp-prompt-save");
  if (!input || runtimeActionBusy) return;
  const instructions = input.value;
  if (instructions.length > input.maxLength) {
    runtimeMcpPromptFeedback("Prompt is longer than the allowed limit.", "error");
    return;
  }
  if (!window.confirm("Save this prompt and apply it to every running MCP owner?\n\nExisting MCP sessions will be closed and clients must reconnect. The prompt only guides the agent; it never grants permissions.")) return;
  runtimeActionBusy = true;
  if (save) save.disabled = true;
  runtimeMcpPromptFeedback("Saving and applying to running MCP owners…");
  try {
    const result = await runtimeInvoke("set_mcp_agent_prompt", {instructions});
    if (result?.success !== true) throw new Error(result?.error || "Prompt was not saved");
    input.value = typeof result.prompt === "string" ? result.prompt : instructions;
    runtimeMcpPromptCounter();
    runtimeMcpPromptState("Saved prompt", "saved");
    const applied = Array.isArray(result.applied) ? result.applied : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const closed = applied.reduce((total, item) => total + Number(item?.sessionsClosed || 0), 0);
    const detail = [
      applied.length
        ? `Applied to ${applied.length} running owner(s); ${closed} session(s) closed — reconnect MCP clients.`
        : "No running reloadable owner to reload; new MCP sessions receive it at initialize.",
      skipped.length
        ? `Skipped ${skipped.length} owner(s): ${skipped.map(item => `:${item.port} ${item.code}`).join(", ")}.`
        : "",
    ].filter(Boolean).join(" ");
    runtimeMcpPromptFeedback(detail, skipped.length ? "error" : "success");
    window.TrayFeedback?.notify?.({
      kind: skipped.length ? "warning" : "success", scope: "runtime",
      message: skipped.length
        ? "MCP prompt saved, but some owners were not reloaded."
        : "MCP prompt saved and applied at session start.",
    });
    if (applied.length) await runtimeRefresh(true);
  } catch (error) {
    runtimeMcpPromptState("Save failed", "error");
    runtimeMcpPromptFeedback("Prompt was not saved: " + String(error), "error");
  } finally {
    runtimeActionBusy = false;
    if (save) save.disabled = false;
  }
}

function runtimeMcpPromptInsertTemplate() {
  const input = rt("runtime-mcp-prompt-input");
  if (!input) return;
  const existing = input.value.trim();
  input.value = (existing ? `${existing}\n\n${RUNTIME_MCP_PROMPT_TEMPLATE}` : RUNTIME_MCP_PROMPT_TEMPLATE)
    .slice(0, input.maxLength);
  runtimeMcpPromptCounter();
  input.focus?.();
}

function runtimeMcpPromptClear() {
  const input = rt("runtime-mcp-prompt-input");
  if (!input) return;
  input.value = "";
  runtimeMcpPromptCounter();
  input.focus?.();
}

let runtimeResultReturnFocus = null;

function runtimeCloseConnectionResult() {
  const dialog = rt("runtime-create-result-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  const resultView = rt("runtime-create-result");
  if (resultView) {
    resultView.hidden = true;
    // Do not retain bootstrap codes or bearer tokens in the hidden page.
    resultView.replaceChildren?.();
    resultView.textContent = "";
  }
  runtimeResultReturnFocus?.focus?.();
  runtimeResultReturnFocus = null;
}

function runtimeOpenConnectionResult() {
  const dialog = rt("runtime-create-result-dialog");
  if (!dialog) return;
  runtimeResultReturnFocus = rt("runtime-create-toggle") || document.activeElement;
  const createPanel = rt("runtime-create-panel");
  if (createPanel) createPanel.hidden = true;
  rt("runtime-create-toggle")?.setAttribute?.("aria-expanded", "false");
  dialog.hidden = false;
  rt("runtime-result-close")?.focus?.();
}

async function runtimeCreateConnection(event) {
  event?.preventDefault?.();
  if (runtimeActionBusy) return;
  const snapshot = runtimeLastResult;
  // The request will target the selected Core, NOT another available Core.
  // Never silently apply a connection to the wrong process.
  const core = snapshot?.cores?.find(s =>
    s.port === snapshot.selectedCorePort && s.state === "online");
  const feedback = rt("runtime-create-feedback");
  const resultView = rt("runtime-create-result");
  if (!core || !Number.isSafeInteger(core.port)) {
    if (feedback) feedback.textContent = "An authenticated Core is required. Start Core or select one first.";
    return;
  }
  const kind = rt("runtime-create-kind")?.value;
  let payload;
  if (kind === "mcp-client") {
    payload = {
      kind, name: String(rt("runtime-create-name")?.value || "").trim(),
      url: String(rt("runtime-create-url")?.value || "").trim(),
      oauth: rt("runtime-create-oauth")?.checked === true,
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(payload.name) ||
        !/^https?:\/\//i.test(payload.url)) {
      feedback.textContent = "Provide a valid name and an absolute MCP URL.";
      return;
    }
  } else if (kind === "core-tunnel") {
    payload = {kind, port:core.port};
  } else if (kind === "mcp-tunnel" || kind === "muse-tunnel") {
    const port = Number(rt("runtime-create-port")?.value);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
      feedback.textContent = "Use a local port from 1024 to 65535.";
      return;
    }
    if (kind === "muse-tunnel") payload = {kind, port};
    else {
      const provider = rt("runtime-create-provider")?.value || "cloudflare";
      const toolExposure = rt("runtime-create-tool-exposure")?.value || "gateway";
      const toolMode = rt("runtime-create-tool-mode")?.value || "safe";
      if (!["gateway", "full"].includes(toolExposure) || !["safe", "dangerous"].includes(toolMode)) {
        feedback.textContent = "Choose a valid MCP tool exposure and security mode.";
        return;
      }
      payload = {kind,port,provider,toolExposure,toolMode};
      if (provider === "openai") {
        payload.tunnelId = String(rt("runtime-create-tunnelid")?.value || "").trim();
      }
    }
  } else return;
  const description = kind === "mcp-client"
    ? "Register this MCP endpoint in SuperAgent? It will not disconnect or replace existing clients."
    : kind === "mcp-tunnel"
      ? `Start a NEW public MCP tunnel with ${payload.toolExposure.toUpperCase()} tool discovery and ${payload.toolMode.toUpperCase()} tool mode, protected by OAuth? ${payload.toolMode === "dangerous" ? "Write/execute tools may be discoverable, but every call still requires the configured OAuth scope, Security Approval, project grants and host file rules. " : ""}Existing owners are not changed.`
      : kind === "core-tunnel"
        ? "Create a PUBLIC HTTPS tunnel to the selected Core REST/SSE API? The API still requires its existing bearer token."
        : "Start a NEW public Muse WebSocket tunnel? It will accept only authenticated Muse connections and enforce tool permissions.";
  if (!window.confirm(description)) return;
  runtimeActionBusy = true;
  const submit = rt("runtime-create-submit");
  const ticket = window.TrayFeedback?.begin({
    key: "runtime:create-connection", button: submit, label: "Creating connection…",
  });
  if (submit) submit.disabled = true;
  if (resultView) resultView.hidden = true;
  if (feedback) feedback.textContent = "Creating connection through authenticated Core...";
  try {
    const result = await runtimeInvoke("create_connection", {payload});
    if (result?.success !== true) throw new Error("Core did not confirm connection creation");
    if (feedback) feedback.textContent = result.state === "configured"
      ? "MCP configuration saved" : "Connection owner started successfully";
    window.TrayFeedback?.notify({ kind: "success", scope: "runtime",
      message: result.state === "configured" ? "MCP connection configuration saved."
        : "Connection owner created and confirmed." });
    if (resultView) {
      resultView.hidden = false;
      let text = (result.endpoint ? `Endpoint: ${result.endpoint}\n` : "") +
        (result.name ? `Name: ${result.name}\n` : "");
      if (result.bootstrapCode) {
        text += `One-Time OAuth Approval Code: ${result.bootstrapCode}\n\n`;
      }
      if (result.setupSnippet) {
        text += `Setup Details:\n${result.setupSnippet}\n\n`;
      }
      text += (result.message || "Connection created");

      if (typeof document.createElement === "function" && typeof resultView.replaceChildren === "function") {
        resultView.replaceChildren();

        if (result.endpoint) {
          const endpointP = document.createElement("div");
          endpointP.className = "runtime-result-line runtime-result-endpoint-row";

          const endpointValWrap = document.createElement("div");
          endpointValWrap.className = "runtime-result-endpoint-val-wrap";
          endpointValWrap.innerHTML = `<strong>Endpoint:</strong> <span class="runtime-result-endpoint">${runtimeEscape(result.endpoint)}</span>`;

          const copyEndpointBtn = document.createElement("button");
          copyEndpointBtn.type = "button";
          copyEndpointBtn.className = "button ghost runtime-copy-inline runtime-copy-endpoint-btn";
          copyEndpointBtn.textContent = "Copy Endpoint";
          copyEndpointBtn.title = "Copy endpoint URL to clipboard";
          copyEndpointBtn.setAttribute("aria-label", "Copy endpoint URL to clipboard");
          copyEndpointBtn.addEventListener("click", async () => {
            try {
              if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(result.endpoint);
              } else if (typeof document.execCommand === "function" && document.body) {
                const ta = document.createElement("textarea");
                ta.value = result.endpoint;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
              }
              copyEndpointBtn.textContent = "Copied!";
              copyEndpointBtn.classList?.add?.("copied");
              window.TrayFeedback?.notify?.({
                kind: "success", scope: "runtime",
                message: "Endpoint URL copied to clipboard."
              });
              setTimeout(() => {
                copyEndpointBtn.textContent = "Copy Endpoint";
                copyEndpointBtn.classList?.remove?.("copied");
              }, 2000);
            } catch {
              copyEndpointBtn.textContent = "Copy failed";
              setTimeout(() => { copyEndpointBtn.textContent = "Copy Endpoint"; }, 2000);
            }
          });

          endpointP.appendChild(endpointValWrap);
          endpointP.appendChild(copyEndpointBtn);
          resultView.appendChild(endpointP);
        }

        let snippetVal = null;
        let msgDiv = null;

        if (result.name) {
          const nameP = document.createElement("div");
          nameP.className = "runtime-result-line";
          nameP.innerHTML = `<strong>Name:</strong> <span>${runtimeEscape(result.name)}</span>`;
          resultView.appendChild(nameP);
        }

        const tokenValue = result.bootstrapCode || (result.token && (result.kind === "core-tunnel" || result.kind === "muse-tunnel") ? result.token : null);
        if (tokenValue) {
          const tokenBox = document.createElement("div");
          tokenBox.className = "runtime-token-box";

          const tokenHead = document.createElement("div");
          tokenHead.className = "runtime-token-box-head";
          const tokenLabel = document.createElement("span");
          tokenLabel.className = "runtime-token-badge";
          tokenLabel.textContent = result.bootstrapCode
            ? "ONE-TIME OAUTH CODE"
            : (result.kind === "core-tunnel" ? "CORE BEARER TOKEN" : "MUSE WS TOKEN");

          const tokenActions = document.createElement("div");
          tokenActions.className = "runtime-token-box-actions";

          const copyCodeBtn = document.createElement("button");
          copyCodeBtn.type = "button";
          copyCodeBtn.className = "button ghost runtime-copy-inline";
          copyCodeBtn.textContent = result.bootstrapCode ? "Copy Code" : "Copy Token";
          copyCodeBtn.addEventListener("click", async () => {
            try {
              const currentToken = result.bootstrapCode || result.token || tokenValue;
              if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(currentToken);
              }
              copyCodeBtn.textContent = "Copied!";
              copyCodeBtn.classList?.add?.("copied");
              setTimeout(() => {
                copyCodeBtn.textContent = result.bootstrapCode ? "Copy Code" : "Copy Token";
                copyCodeBtn.classList?.remove?.("copied");
              }, 2000);
            } catch {
              copyCodeBtn.textContent = "Copy failed";
            }
          });

          if (result.bootstrapCode) {
            const regenCodeBtn = document.createElement("button");
            regenCodeBtn.type = "button";
            regenCodeBtn.className = "button ghost runtime-copy-inline runtime-regen-inline";
            regenCodeBtn.textContent = "Regenerate Token";
            regenCodeBtn.title = "Generate a new one-time OAuth approval code. The previous code will be invalidated.";

          regenCodeBtn.addEventListener("click", async () => {
            let targetPort = result.port;
            let targetPid = result.pid;
            if (!targetPort || !targetPid) {
              const match = runtimeLastResult?.remoteServices?.find(s =>
                (result.endpoint && s.url === result.endpoint) || (result.port && s.port === result.port)
              );
              if (match) {
                targetPort = targetPort || match.port;
                targetPid = targetPid || match.pid;
              }
            }

            if (!targetPort || !targetPid) {
              window.TrayFeedback?.notify?.({
                kind: "error", scope: "runtime",
                message: "Owner port or PID is unknown; cannot regenerate token."
              });
              return;
            }

            if (!window.confirm("Regenerate the ONE-TIME MCP OAuth bootstrap approval code?\n\nThe previous code will be invalidated immediately. Existing active OAuth sessions and the public tunnel URL will remain unchanged.")) {
              return;
            }

            regenCodeBtn.disabled = true;
            regenCodeBtn.textContent = "Regenerating…";
            try {
              const targetKind = (result.kind === "mcp-tunnel" || result.kind === "mcp") ? "mcp"
                : (result.kind === "muse-tunnel" || result.kind === "muse-watch") ? "muse-watch"
                : result.kind || "mcp";
              const rotation = await runtimeInvoke("regenerate_token", {
                kind: targetKind,
                port: Number(targetPort),
                pid: Number(targetPid),
              });
              if (rotation?.success !== true) throw new Error("Token regeneration was not confirmed");

              const newCode = rotation.code || rotation.bootstrapCode;
              if (newCode) {
                result.bootstrapCode = newCode;
                tokenVal.textContent = newCode;
              }

              if (result.endpoint) {
                result.setupSnippet = [
                  `MCP URL   : ${result.endpoint}`,
                  "Auth      : OAuth",
                  `Bootstrap : ${result.bootstrapCode}`,
                ].join("\n");
              } else if (rotation.setupSnippet) {
                result.setupSnippet = rotation.setupSnippet;
              }
              if (snippetVal && result.setupSnippet) {
                snippetVal.textContent = result.setupSnippet;
              }

              if (msgDiv) {
                msgDiv.textContent = rotation.message || "New MCP OAuth bootstrap approval code generated and copied to clipboard.";
              }

              regenCodeBtn.textContent = "Regenerated!";
              window.TrayFeedback?.notify?.({
                kind: "success", scope: "runtime",
                message: "New MCP OAuth bootstrap code generated and copied to OS clipboard."
              });
              setTimeout(() => {
                regenCodeBtn.textContent = "Regenerate Token";
                regenCodeBtn.disabled = false;
              }, 2000);
              await runtimeRefresh(true);
            } catch (err) {
              regenCodeBtn.textContent = "Failed";
              window.TrayFeedback?.notify?.({
                kind: "error", scope: "runtime",
                message: "Token regeneration failed: " + (err?.message || err)
              });
              setTimeout(() => {
                regenCodeBtn.textContent = "Regenerate Token";
                regenCodeBtn.disabled = false;
              }, 3000);
            }
          });
          tokenActions.append(regenCodeBtn);
        }

        tokenActions.append(copyCodeBtn);
        tokenHead.append(tokenLabel, tokenActions);

        const tokenVal = document.createElement("pre");
        tokenVal.className = "runtime-token-val";
        tokenVal.textContent = tokenValue;

        tokenBox.append(tokenHead, tokenVal);
        resultView.appendChild(tokenBox);
      }

      if (result.setupSnippet) {
        const snippetBox = document.createElement("div");
        snippetBox.className = "runtime-snippet-box";
        const snippetHead = document.createElement("div");
        snippetHead.className = "runtime-token-box-head";
        const snippetLabel = document.createElement("span");
        snippetLabel.className = "runtime-token-badge secondary";
        snippetLabel.textContent = result.kind === "core-tunnel"
          ? "CORE API / CURL SETUP"
          : (result.kind === "muse-tunnel" ? "MUSE CONNECTION SETUP" : "EXTENSION SETUP");
        const copySnippetBtn = document.createElement("button");
        copySnippetBtn.type = "button";
        copySnippetBtn.className = "button ghost runtime-copy-inline";
        copySnippetBtn.textContent = "Copy Setup";
        copySnippetBtn.addEventListener("click", async () => {
          try {
            if (navigator?.clipboard?.writeText) {
              await navigator.clipboard.writeText(result.setupSnippet);
            }
            copySnippetBtn.textContent = "Copied!";
            copySnippetBtn.classList?.add?.("copied");
            setTimeout(() => {
              copySnippetBtn.textContent = "Copy Setup";
              copySnippetBtn.classList?.remove?.("copied");
            }, 2000);
          } catch {
            copySnippetBtn.textContent = "Copy failed";
          }
        });
        snippetHead.append(snippetLabel, copySnippetBtn);

        snippetVal = document.createElement("pre");
        snippetVal.className = "runtime-snippet-val";
        snippetVal.textContent = result.setupSnippet;

        snippetBox.append(snippetHead, snippetVal);
        resultView.appendChild(snippetBox);
      }

        msgDiv = document.createElement("div");
        msgDiv.className = "runtime-result-note";
        msgDiv.textContent = result.message || "Connection created";
        resultView.appendChild(msgDiv);
      } else {
        resultView.textContent = text;
      }
    }
    if (resultView) runtimeOpenConnectionResult();
    await runtimeRefresh();
  } catch (error) {
    const unknown = /timed out|timeout|connection lost/i.test(String(error));
    const errText = typeof error === "string" ? error : (error?.message || String(error || ""));
    const cleanErr = errText ? errText.replace(/^Core HTTP \d+:\s*/i, "") : "";
    const displayMsg = cleanErr || "Connection was not created or not verified. Check Core and the connection details.";
    if (feedback) feedback.textContent = unknown
      ? "Connection creation result is uncertain. Inspect registered owners before another attempt; do not retry automatically."
      : displayMsg;
    window.TrayFeedback?.notify({ kind: unknown ? "warning" : "error", scope: "runtime",
      message: unknown ? "Create Connection result unknown. Inspect owners before retrying."
        : (cleanErr || "Connection was not created. Check the inline details.") });
    if (resultView) resultView.hidden = true;
  } finally {
    runtimeActionBusy = false;
    if (submit) submit.disabled = false;
    ticket?.end();
  }
}

async function runtimeRefresh(background = false) {
  if (runtimeScanBusy) {
    // A lifecycle receipt needs a fresh read even if background polling is
    // already active; queue only the read, never repeat a mutation.
    if (runtimeActionBusy || background !== true) runtimeRefreshQueued = true;
    return;
  }
  runtimeScanBusy = true;
  const scanSerial = ++runtimeScanSerial;
  const ticket = window.TrayFeedback?.begin({
    key: "runtime:refresh", button: rt("runtime-refresh"),
    label: "Scanning runtime…", background: background === true,
  });
  rt("runtime-refresh").disabled = true;

  try {
    const [snapshot] = await Promise.all([
      runtimeInvoke("detect_runtime"),
      runtimeGetYoloMode(),
    ]);
    runtimeRender(snapshot, scanSerial);
    const [gateway, named] = await Promise.allSettled([
      runtimeInvoke("desktop_live_action", { action: "gateway-status", payload: null }),
      runtimeInvoke("get_named_tunnel_health"),
    ]);
    const trayNode = rt("runtime-tray-gateway");
    if (trayNode) trayNode.innerHTML = runtimeTrayGatewayCard(gateway.status === "fulfilled" ? gateway.value : null);
    const namedNode = rt("runtime-named-mcp-status");
    if (namedNode) namedNode.innerHTML = runtimeNamedMcpCard(named.status === "fulfilled" ? named.value : null);
    if (runtimeActiveTab === "mcp") await runtimeRefreshMcpSecurity();
  } catch (error) {
    rt("runtime-scanned").textContent = "Scan failed";
    rt("runtime-servers").replaceChildren();
    const detail = document.createElement("p");
    detail.className = "empty-state";
    detail.textContent = "Runtime scan unavailable. Check the local Core connection.";
    rt("runtime-servers").append(detail);
    if (!background) window.TrayFeedback?.notify({kind:"error",scope:"runtime",
      message:"Runtime scan unavailable. Check Core connectivity."});
  } finally {
    runtimeScanBusy = false;
    rt("runtime-refresh").disabled = false;
    ticket?.end();
    if (runtimeRefreshQueued) {
      runtimeRefreshQueued = false;
      void runtimeRefresh(true);
    }
  }
}

async function runtimeSelect(event) {
  const button = event.target.closest("button.runtime-select");
  if (button) {
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
      alert("Could not select Core: " + String(error));
    }
    return;
  }

  const restartBtn = event.target.closest("button.runtime-restart-core");
  if (restartBtn) {
    const port = Number(restartBtn.dataset.runtimePort) || 7888;
    restartBtn.disabled = true;
    restartBtn.textContent = "Restarting...";
    try {
      await runtimeInvoke("restart_core_server", { port });
      if (typeof window.TrayFeedback?.notify === "function") {
        window.TrayFeedback.notify({
          kind: "success",
          message: `SuperAgent Core (:${port}) restarted successfully`,
          scope: "runtime",
        });
      }
      await runtimeRefresh();
      if (typeof refresh === "function") await refresh();
    } catch (e) {
      alert("Failed to restart Core: " + String(e));
      restartBtn.disabled = false;
      restartBtn.textContent = "Restart";
    }
    return;
  }
}

window.__superagentRuntimeRefresh = runtimeRefresh;

function runtimeInstall() {
  rt("runtime-create-toggle")?.addEventListener("click", () => {
    const panel = rt("runtime-create-panel");
    if (panel) {
      panel.hidden = !panel.hidden;
      rt("runtime-create-toggle")?.setAttribute?.("aria-expanded", String(!panel.hidden));
    }
    runtimeCreateKindChanged();
  });
  rt("runtime-create-close")?.addEventListener("click", () => {
    if (rt("runtime-create-panel")) rt("runtime-create-panel").hidden = true;
    rt("runtime-create-toggle")?.setAttribute?.("aria-expanded", "false");
  });
  rt("runtime-result-close")?.addEventListener("click", runtimeCloseConnectionResult);
  rt("runtime-result-done")?.addEventListener("click", runtimeCloseConnectionResult);
  rt("runtime-create-result-dialog")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) runtimeCloseConnectionResult();
  });
  document.addEventListener("keydown", (event) => {
    const dialog = rt("runtime-create-result-dialog");
    if (!dialog || dialog.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      runtimeCloseConnectionResult();
    } else if (event.key === "Tab") {
      const controls = Array.from(dialog.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])"))
        .filter(element => !element.hidden && element.getClientRects().length > 0);
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  for (const name of runtimeTabNames) {
    const tab = rt("runtime-tab-" + name);
    tab?.addEventListener("click", () => runtimeSelectTab(name));
    tab?.addEventListener("keydown", runtimeTabKeydown);
  }
  rt("runtime-named-tunnel-settings")?.addEventListener("click", () => {
    if (typeof window.navigateToPage === "function") window.navigateToPage("settings");
    rt("named-tunnel-settings-title")?.scrollIntoView?.({behavior:"smooth",block:"start"});
  });
  rt("runtime-create-kind")?.addEventListener("change", runtimeCreateKindChanged);
  rt("runtime-create-provider")?.addEventListener("change", runtimeCreateKindChanged);
  rt("runtime-create-form")?.addEventListener("submit", runtimeCreateConnection);
  runtimeCreateKindChanged();
  rt("runtime-refresh")?.addEventListener("click", runtimeRefresh);
  rt("runtime-servers")?.addEventListener("click", runtimeSelect);
  rt("runtime-remote")?.addEventListener("click", runtimeServiceAction);
  rt("runtime-remote")?.addEventListener("click", runtimeRegenerateToken);
  rt("runtime-remote")?.addEventListener("click", runtimeOpenMcpConfig);
  rt("runtime-mcp-config-form")?.addEventListener("submit", runtimeSaveMcpConfig);
  rt("runtime-mcp-config-close")?.addEventListener("click", runtimeCloseMcpConfig);
  rt("runtime-mcp-config-cancel")?.addEventListener("click", runtimeCloseMcpConfig);
  rt("runtime-mcp-config-dialog")?.addEventListener("click", event => {
    if (event.target === rt("runtime-mcp-config-dialog")) runtimeCloseMcpConfig();
  });
  rt("runtime-mcp-config-dialog")?.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); runtimeCloseMcpConfig(); }
  });
  rt("runtime-mcp-prompt-input")?.addEventListener("input", runtimeMcpPromptCounter);
  rt("runtime-mcp-prompt-template")?.addEventListener("click", runtimeMcpPromptInsertTemplate);
  rt("runtime-mcp-prompt-clear")?.addEventListener("click", runtimeMcpPromptClear);
  rt("runtime-mcp-prompt-save")?.addEventListener("click", runtimeSaveMcpAgentPrompt);
  void runtimeLoadMcpAgentPrompt();
  rt("runtime-remote-panel")?.addEventListener("click", event => {
    void runtimeCopyPublicUrl(event);
    runtimeOpenMcpSecurity(event);
  });
  rt("runtime-muse-local")?.addEventListener("click", runtimeServiceAction);
  rt("runtime-muse-local")?.addEventListener("click", runtimeRegenerateToken);
  rt("runtime-servers")?.addEventListener("click", runtimeServiceAction);
  rt("runtime-servers")?.addEventListener("click", runtimeRegenerateToken);
  rt("runtime-servers")?.addEventListener("click", runtimeYoloChipClick);

  window.__TAURI__?.event?.listen?.("shutdown-manager-progress", runtimeNativeShutdownProgress);
  window.__TAURI__?.event?.listen?.("desktop-open-runtime", () => {
    if (typeof window.navigateToPage === "function") {
      window.navigateToPage("runtime");
    } else {
      rt("runtime")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    void runtimeRefresh();
  });

  window.addEventListener("tray-settings-changed", (event) => {
    runtimeConfigureRefreshInterval(event.detail?.runtimeScanSeconds);
  });
  void runtimeRefresh();
  runtimeConfigureRefreshInterval(20);
}

runtimeInstall();
