"use strict";

// A dedicated read-only runtime panel. This script receives a sanitized native
// snapshot; it never sees Core bearer tokens or raw process command arguments.
const rt = (id) => document.getElementById(id);

const runtimeEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const runtimeInvoke = (action, args = {}) => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("Runtime Detection is available only in the Tauri desktop application.");
  return invoke(action, args);
};

let runtimeRefreshTimer = null;
function runtimeConfigureRefreshInterval(seconds) {
  const valid = [10, 20, 30, 60, 120].includes(seconds) ? seconds : 20;
  if (runtimeRefreshTimer !== null) clearInterval(runtimeRefreshTimer);
  runtimeRefreshTimer = setInterval(runtimeRefresh, valid * 1000);
}

let runtimeScanBusy = false;
let runtimeActionBusy = false;
let runtimeLastResult = null;

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

  const museLabel = muse?.watcherActive && !muse?.connected
    ? "Listener present, connection not ready"
    : muse?.transport ? `via ${muse.transport}` : "";

  const button = online
    ? server.selected
      ? '<span class="runtime-current">✓ Selected for Cron</span>'
      : `<button class="button ghost runtime-select" type="button" data-runtime-port="${server.port}">Use This Core</button>`
    : '<span class="subtle-badge">Server unreachable</span>';
  // A Core-local watcher is controllable only via the authenticated owner API.
  // Other CLI-hosted Muse watchers are never mapped to this Core by PID guess.
  const localMuse = online && server.pidVerified === true &&
    Number.isSafeInteger(server.pid) && server.pid > 0 && muse?.ownerPresent === true;
  const museControls = localMuse ? `<div class="runtime-lifecycle-group">
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="stop"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}"
        ${muse.watcherActive ? "" : "disabled"}>Stop Muse</button>
      <button type="button" class="button ghost runtime-lifecycle"
        data-runtime-kind="muse-core" data-runtime-action="restart"
        data-runtime-port="${server.port}" data-runtime-pid="${server.pid}">Restart Muse</button>
      ${muse?.watcherActive && muse.transport === "websocket" ? `<button
        type="button" class="button ghost runtime-regenerate-token"
        data-runtime-kind="muse-core" data-runtime-port="${server.port}"
        data-runtime-pid="${server.pid}">Regenerate Muse Token</button>` : ""}
    </div>` : "";

  return `<article class="runtime-instance">
    <div class="runtime-instance-head">
      <div>
        <strong>SuperAgent Core · :${server.port}</strong>
        <small>PID ${runtimeEscape(server.pid ?? "-")} · v${runtimeEscape(server.version ?? "-")}</small>
      </div>
      ${runtimeStatusPill(server.state)}
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

function runtimeRemoteCard(service) {
  const titles = {
    mcp: "MCP HTTP Server",
    cloudflare: "Cloudflare Tunnel",
    "muse-watch": "Muse Watch",
    "core-supervisor": "Core Supervisor"
  };
  const name = titles[service.kind] || "SuperAgent Remote Service";
  const port = service.port
    ? service.kind === "muse-watch" ? ` · control :${service.port}` : ` · :${service.port}`
    : "";
  const supported = service.canStop === true || service.canRestart === true;
  const controlHint = service.kind === "cloudflare"
    ? "Tunnel lifecycle belongs to its service owner; control MCP from the MCP card."
    : service.kind === "muse-watch"
      ? "Watcher belum punya endpoint privat terverifikasi atau tugas masih aktif. Versi lama perlu restart terkontrol."
      : service.kind === "core-supervisor"
        ? "Supervisor can restart safely; stopping the full Core owner requires a separate drain policy."
        : "Managed owner required; stop is unavailable when sessions or tool requests are in flight.";
  const rotateButton = service.kind === "mcp" || service.kind === "muse-watch"
    ? `<button type="button" class="button ghost runtime-regenerate-token"
       data-runtime-kind="${runtimeEscape(service.kind)}"
       data-runtime-port="${runtimeEscape(service.port)}"
       data-runtime-pid="${runtimeEscape(service.pid)}"
       ${service.canRegenerateToken === true ? "" : "disabled"}
       title="Regenerate supported owner credential; new token is copied to OS clipboard">Regenerate Token</button>`
    : "";
  const controls = `<div class="runtime-instance-footer">
        <button type="button" class="button ghost runtime-lifecycle"
          data-runtime-kind="${runtimeEscape(service.kind)}" data-runtime-action="stop"
          data-runtime-port="${runtimeEscape(service.port)}" data-runtime-pid="${runtimeEscape(service.pid)}"
          ${service.canStop ? "" : "disabled"} title="Graceful stop only; no forced process termination">Stop</button>
        <button type="button" class="button ghost runtime-lifecycle"
          data-runtime-kind="${runtimeEscape(service.kind)}" data-runtime-action="restart"
          data-runtime-port="${runtimeEscape(service.port)}" data-runtime-pid="${runtimeEscape(service.pid)}"
          ${service.canRestart ? "" : "disabled"} title="Owner-managed restart/reload with safety checks">Restart</button>
         ${rotateButton}
       </div>`;
  return `<article class="runtime-instance compact">
    <div class="runtime-instance-head">
      <div><strong>${runtimeEscape(name)}${runtimeEscape(port)}</strong>
        <small>PID ${runtimeEscape(service.pid ?? "-")} · ${runtimeEscape(service.transport || "unknown")}</small></div>
      ${runtimeStatusPill(service.state)}
    </div>
    <div class="runtime-evidence">${runtimeEscape(service.detail || "")}
      · ${runtimeEscape(service.evidence || "")}</div>
    ${controls}
    ${service.controlReason
      ? `<div class="runtime-evidence">${runtimeEscape(service.controlReason)}</div>`
      : !supported ? `<div class="runtime-evidence">${runtimeEscape(controlHint)}</div>` : ""}
    ${(service.kind === "mcp" || service.kind === "muse-watch") &&
       service.canRegenerateToken !== true
        ? `<div class="runtime-evidence">${runtimeEscape(service.kind === "mcp"
            ? "Regenerate Token memerlukan MCP OAuth owner versi reloadable; static Bearer/OpenAI/legacy belum didukung."
            : "Regenerate Token memerlukan Muse WebSocket owner aktif tanpa tugas berjalan.")}</div>`
        : ""}
  </article>`;
}
function runtimeRender(snapshot) {
  runtimeLastResult = snapshot;
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

  const remote = Array.isArray(snapshot.remoteServices) ? snapshot.remoteServices : [];
  rt("runtime-remote-count").textContent =
    `(${remote.filter(s => s.state === "online" || s.state === "observed").length} active/detected · ${remote.length} registered)`;
  rt("runtime-remote").innerHTML = remote.length
    ? remote.map(runtimeRemoteCard).join("")
    : '<p class="empty-state">No MCP/tunnel registry or Muse Watch heartbeat found. An already running old Muse Watch process may need a controlled restart to publish its new heartbeat.</p>';

  const hosts = Array.isArray(snapshot.independentHosts) ? snapshot.independentHosts : [];
  rt("runtime-independent-count").textContent = `(${hosts.length} detected)`;
  rt("runtime-independent").innerHTML = hosts.length
    ? hosts.map(runtimeHostCard).join("")
    : '<p class="empty-state">No independent T-Line transports or external channel hosts verified.</p>';

  rt("runtime-notes").textContent =
    "Online status requires an authentic loopback HTTP response with bearer authentication. Process discovery validates OS PID, creation time, and fresh heartbeats. " +
    "Local Core summaries do not establish global MCP/Muse status. The independent MCP, Cloudflare and Muse Watch cards use owner records, live PID and endpoint/heartbeat evidence. No credentials or tunnel URLs are displayed.";
  rt("runtime-notes").hidden = false;
}

async function runtimeServiceAction(event) {
  const button = event.target?.closest?.("button.runtime-lifecycle");
  if (!button || runtimeActionBusy || button.disabled) return;
  const { runtimeKind: kind, runtimeAction: action, runtimePort, runtimePid } = button.dataset;
  const port = Number(runtimePort), pid = Number(runtimePid);
  const service = kind === "muse-core"
    ? (() => {
        const core = runtimeLastResult?.cores?.find(item =>
          item.port === port && item.pid === pid && item.state === "online" &&
          item.pidVerified === true && item.services?.muse?.ownerPresent === true);
        return core ? {kind, port, pid, canStop:core.services.muse.watcherActive===true,
          canRestart:true} : null;
      })()
    : runtimeLastResult?.remoteServices?.find(item =>
        item.kind === kind && item.port === port && item.pid === pid);
  if (!service || !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(pid) || pid < 1 ||
      (action === "stop" ? service.canStop !== true : action === "restart" ? service.canRestart !== true : true)) {
    return;
  }
  const label = kind === "mcp" ? "MCP managed owner"
    : kind === "core-supervisor" ? "SuperAgent Core Supervisor"
    : kind === "muse-core" ? "Core-local Muse Watch" : kind;
  const warning = action === "stop"
    ? "Stop will close this owner's connections. Active sessions/tasks block safe stopping."
    : kind === "mcp"
      ? "Restart reloads the MCP backend and preserves its public tunnel URL when supported."
      : kind === "muse-core"
        ? "Restart preserves this Core-owned watcher's configuration and callbacks. Active/queued tasks and tunnel-owned watchers are rejected."
        : "Restart creates a new supervised Core generation while retaining existing session owners.";
  if (!window.confirm(`${action === "stop" ? "Stop" : "Restart"} ${label} :${port} (PID ${pid})?\n\n${warning}\n\nThis action cannot be undone from this dialog.`)) return;
  runtimeActionBusy = true;
  button.disabled = true;
  const message = rt("runtime-action-feedback");
  message.hidden = false;
  message.textContent = `Requesting ${action} for ${label} on port ${port}...`;
  try {
    const result = await runtimeInvoke("service_action", { kind, action, port, pid });
    if (result?.success !== true) throw new Error("The service owner did not confirm the operation");
    message.textContent = result.message || `${label} ${action} confirmed.`;
    await runtimeRefresh();
  } catch (error) {
    message.textContent = `Lifecycle action not performed or not verified: ${String(error)}`;
    button.disabled = false;
  } finally {
    runtimeActionBusy = false;
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
  const guidelines = {
    "mcp-client": "Saves an external MCP client over HTTPS or loopback HTTP. Does not disconnect existing MCP clients; connect/reload it in your active session.",
    "mcp-tunnel": "Creates a new SAFE/READ-ONLY MCP owner and public tunnel. OAuth is mandatory; tools are NOT available until approved. Existing ports are never replaced.",
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
      payload = {kind,port,provider};
      if (provider === "openai") {
        payload.tunnelId = String(rt("runtime-create-tunnelid")?.value || "").trim();
      }
    }
  } else return;
  const description = kind === "mcp-client"
    ? "Register this MCP endpoint in SuperAgent? It will not disconnect or replace existing clients."
    : kind === "mcp-tunnel"
      ? "Start a NEW public MCP tunnel exposing only safe tools, protected by OAuth? Any new authorization must be explicitly approved."
      : kind === "core-tunnel"
        ? "Create a PUBLIC HTTPS tunnel to the selected Core REST/SSE API? The API still requires its existing bearer token."
        : "Start a NEW public Muse WebSocket tunnel? It will accept only authenticated Muse connections and enforce tool permissions.";
  if (!window.confirm(description)) return;
  runtimeActionBusy = true;
  const submit = rt("runtime-create-submit");
  if (submit) submit.disabled = true;
  if (resultView) resultView.hidden = true;
  if (feedback) feedback.textContent = "Creating connection through authenticated Core...";
  try {
    const result = await runtimeInvoke("create_connection", {payload});
    if (result?.success !== true) throw new Error("Core did not confirm connection creation");
    if (feedback) feedback.textContent = result.state === "configured"
      ? "MCP configuration saved" : "Connection owner started successfully";
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
          endpointP.className = "runtime-result-line";
          endpointP.innerHTML = `<strong>Endpoint:</strong> <span class="runtime-result-endpoint">${runtimeEscape(result.endpoint)}</span>`;
          resultView.appendChild(endpointP);
        }

        if (result.name) {
          const nameP = document.createElement("div");
          nameP.className = "runtime-result-line";
          nameP.innerHTML = `<strong>Name:</strong> <span>${runtimeEscape(result.name)}</span>`;
          resultView.appendChild(nameP);
        }

        if (result.bootstrapCode) {
          const tokenBox = document.createElement("div");
          tokenBox.className = "runtime-token-box";

          const tokenHead = document.createElement("div");
          tokenHead.className = "runtime-token-box-head";
          const tokenLabel = document.createElement("span");
          tokenLabel.className = "runtime-token-badge";
          tokenLabel.textContent = "ONE-TIME OAUTH CODE";
          const copyCodeBtn = document.createElement("button");
          copyCodeBtn.type = "button";
          copyCodeBtn.className = "button ghost runtime-copy-inline";
          copyCodeBtn.textContent = "Copy Code";
          copyCodeBtn.addEventListener("click", async () => {
            try {
              if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(result.bootstrapCode);
              }
              copyCodeBtn.textContent = "Copied!";
              setTimeout(() => { copyCodeBtn.textContent = "Copy Code"; }, 2000);
            } catch {
              copyCodeBtn.textContent = "Copy failed";
            }
          });
          tokenHead.append(tokenLabel, copyCodeBtn);

          const tokenVal = document.createElement("pre");
          tokenVal.className = "runtime-token-val";
          tokenVal.textContent = result.bootstrapCode;

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
          snippetLabel.textContent = "EXTENSION SETUP";
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
              setTimeout(() => { copySnippetBtn.textContent = "Copy Setup"; }, 2000);
            } catch {
              copySnippetBtn.textContent = "Copy failed";
            }
          });
          snippetHead.append(snippetLabel, copySnippetBtn);

          const snippetVal = document.createElement("pre");
          snippetVal.className = "runtime-snippet-val";
          snippetVal.textContent = result.setupSnippet;

          snippetBox.append(snippetHead, snippetVal);
          resultView.appendChild(snippetBox);
        }

        const msgDiv = document.createElement("div");
        msgDiv.className = "runtime-result-note";
        msgDiv.textContent = result.message || "Connection created";
        resultView.appendChild(msgDiv);
      } else {
        resultView.textContent = text;
      }
    }
    await runtimeRefresh();
  } catch (error) {
    if (feedback) feedback.textContent = "Connection was not created or not verified: " + String(error);
    if (resultView) resultView.hidden = true;
  } finally {
    runtimeActionBusy = false;
    if (submit) submit.disabled = false;
  }
}

async function runtimeRefresh() {
  if (runtimeScanBusy) return;
  runtimeScanBusy = true;
  rt("runtime-refresh").disabled = true;

  try {
    const snapshot = await runtimeInvoke("detect_runtime");
    runtimeRender(snapshot);
  } catch (error) {
    rt("runtime-scanned").textContent = "Scan failed";
    rt("runtime-servers").replaceChildren();
    const detail = document.createElement("p");
    detail.className = "empty-state";
    detail.textContent = String(error);
    rt("runtime-servers").append(detail);
  } finally {
    runtimeScanBusy = false;
    rt("runtime-refresh").disabled = false;
  }
}

async function runtimeSelect(event) {
  const button = event.target.closest("button.runtime-select");
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
    alert("Could not select Core: " + String(error));
  }
}

window.__superagentRuntimeRefresh = runtimeRefresh;

function runtimeInstall() {
  rt("runtime-create-toggle")?.addEventListener("click", () => {
    const panel = rt("runtime-create-panel");
    if (panel) panel.hidden = !panel.hidden;
    runtimeCreateKindChanged();
  });
  rt("runtime-create-close")?.addEventListener("click", () => {
    if (rt("runtime-create-panel")) rt("runtime-create-panel").hidden = true;
  });
  rt("runtime-create-kind")?.addEventListener("change", runtimeCreateKindChanged);
  rt("runtime-create-provider")?.addEventListener("change", runtimeCreateKindChanged);
  rt("runtime-create-form")?.addEventListener("submit", runtimeCreateConnection);
  runtimeCreateKindChanged();
  rt("runtime-refresh")?.addEventListener("click", runtimeRefresh);
  rt("runtime-servers")?.addEventListener("click", runtimeSelect);
  rt("runtime-remote")?.addEventListener("click", runtimeServiceAction);
  rt("runtime-remote")?.addEventListener("click", runtimeRegenerateToken);
  rt("runtime-servers")?.addEventListener("click", runtimeServiceAction);
  rt("runtime-servers")?.addEventListener("click", runtimeRegenerateToken);

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
