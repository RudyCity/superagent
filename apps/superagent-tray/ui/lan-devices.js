"use strict";
/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
/** LAN Devices manager. Native Tauri -> selected authenticated Core only. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { discovered: [], paired: [], pairingRequests: [], tunnelDevices: [], selected: null, pairRequestId: null,
    busy: false, scanning: false, presetFor: null, presetPlatform: null, segmentRevision: 0,
    connectQrLease: null, apkQrLease: null, qrHeartbeatBusy: false,
    qrOutcomeUnknown: { connect: false, apk: false } };
  let qrRefreshHandler = null;
  const isTimeout = (error) => /timed out|timeout|aborted|connection lost/i.test(String(error));
  const qrToast = (kind, message, background = false) => {
    if (!background) window.TrayFeedback?.notify({
      kind, message, scope: "lan-devices",
    });
  };
  const invoke = (action, payload = {}) => {
    const native = window.__TAURI__?.core?.invoke;
    if (typeof native !== "function") throw Error("SuperAgent Tray native runtime is unavailable.");
    return native("lan_support_action", { action, payload });
  };
  const notice = (message, isError = false) => {
    const el = $("lan-banner");
    if (!el) return;
    el.textContent = String(message).slice(0, 350);
    el.classList.toggle("error", isError);
    el.hidden = false;
  };
  const pairStatus = (message, isError = false) => {
    const el = $("lan-pair-status");
    if (!el) return;
    el.textContent = String(message).slice(0, 350);
    el.classList.toggle("error", isError);
  };
  const button = (caption, onClick, danger = false, disabled = false) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "button " + (danger ? "ghost danger" : "ghost");
    el.textContent = caption;
    el.disabled = disabled;
    el.addEventListener("click", onClick);
    return el;
  };
  const item = (name, ip, extra, stateText, selected = false) => {
    const div = document.createElement("div");
    div.className = "lan-device";
    div.setAttribute("aria-selected", String(selected));
    const info = document.createElement("div");
    info.className = "lan-device-info";
    const label = document.createElement("strong");
    label.textContent = name;
    const addr = document.createElement("span");
    addr.className = "lan-device-meta";
    addr.textContent = ip;
    const detail = document.createElement("span");
    detail.className = "lan-device-state" + (stateText === "Session active" ? " connected" : "");
    detail.textContent = extra + " · " + stateText;
    info.append(label, addr, detail);
    const actions = document.createElement("div");
    actions.className = "lan-device-actions";
    div.append(info, actions);
    return { div, actions };
  };
  const empty = (message) => {
    const el = document.createElement("div");
    el.className = "lan-empty";
    el.textContent = message;
    return el;
  };
  const active = () => state.paired.find((device) => device.id === state.selected && device.connected);
  function drawQrMatrix(canvas, matrix) {
    if (!canvas || typeof canvas.getContext !== "function") throw Error("QR canvas is unavailable.");
    if (!matrix || !Number.isInteger(matrix.size) || matrix.size < 21 || matrix.size > 177
        || typeof matrix.cells !== "string" || matrix.cells.length !== matrix.size * matrix.size
        || /[^01]/.test(matrix.cells)) throw Error("Invalid QR matrix response.");
    const quiet = 4;
    const modules = matrix.size + quiet * 2;
    const modulePixels = matrix.size <= 65 ? 5 : matrix.size <= 85 ? 4 : 3;
    const pixels = modules * modulePixels;
    canvas.width = pixels;
    canvas.height = pixels;
    canvas.style.width = pixels + "px";
    canvas.style.height = pixels + "px";
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw Error("QR canvas context is unavailable.");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pixels, pixels);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.cells[y * matrix.size + x] !== "1") continue;
        ctx.fillRect((x + quiet) * modulePixels, (y + quiet) * modulePixels, modulePixels, modulePixels);
      }
    }
  }

  const QR_HEARTBEAT_MS = 5000;
  const QR_REFRESH_AHEAD_MS = 30000;
  const qrRemaining = (ms) => {
    const seconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  };
  function clearQrCanvas(id, cardId) {
    const qr = $(id);
    const card = $(cardId);
    if (card) card.hidden = true;
    if (qr?.getContext) { const c = qr.getContext("2d"); c?.clearRect(0, 0, qr.width, qr.height); }
  }
  function requestQrRefresh(kind, reason) {
    if (state.busy || state.qrOutcomeUnknown[kind] || !qrRefreshHandler) return false;
    const status = $(kind === "connect" ? "lan-tunnel-status" : "lan-apk-status");
    if (status) status.textContent = "Refreshing QR automatically · " + reason;
    qrRefreshHandler(kind); // Internal background action; never simulate a manual click/toast.
    return true;
  }
  async function heartbeatOneQr(kind, lease) {
    if (!lease?.id || !Number.isSafeInteger(lease.expiresAt)) return;
    const statusEl = $(kind === "connect" ? "lan-tunnel-status" : "lan-apk-status");
    let heartbeat;
    try {
      heartbeat = await invoke("qr_heartbeat", { kind, id: lease.id });
      if (lease !== (kind === "connect" ? state.connectQrLease : state.apkQrLease)) return;
    } catch {
      if (lease !== (kind === "connect" ? state.connectQrLease : state.apkQrLease)) return;
      const localRemaining = Math.max(0, lease.expiresAt - Date.now());
      if (localRemaining <= QR_REFRESH_AHEAD_MS) {
        requestQrRefresh(kind, "heartbeat unavailable near expiry");
      } else if (statusEl) {
        statusEl.textContent = "QR active · " + qrRemaining(localRemaining) + " remaining · heartbeat retrying";
      }
      return;
    }
    if (kind === "connect" && heartbeat?.state === "used") {
      state.qrOutcomeUnknown.connect = false;
      state.connectQrLease = null;
      clearQrCanvas("lan-tunnel-qr", "lan-tunnel-qr-card");
      if (statusEl) statusEl.textContent = "Connection QR used successfully. Device enrollment completed.";
      void refresh();
      return;
    }
    const remainingMs = Number.isFinite(heartbeat?.remainingMs)
      ? Math.max(0, Number(heartbeat.remainingMs))
      : Math.max(0, lease.expiresAt - Date.now());
    if (Number.isSafeInteger(heartbeat?.expiresAt)) lease.expiresAt = heartbeat.expiresAt;
    if (!heartbeat?.valid || heartbeat?.tunnelActive !== true || remainingMs <= QR_REFRESH_AHEAD_MS) {
      requestQrRefresh(kind, heartbeat?.tunnelActive === false ? "Core HTTPS tunnel changed" : "expiry approaching");
      return;
    }
    if (statusEl) statusEl.textContent = kind === "connect"
      ? "Connection QR active · " + qrRemaining(remainingMs) + " remaining · heartbeat OK"
      : "APK download QR active · " + qrRemaining(remainingMs) + " remaining · heartbeat OK";
  }
  async function runQrHeartbeat() {
    if (state.qrHeartbeatBusy || state.busy) return;
    if (!state.connectQrLease && !state.apkQrLease) return;
    state.qrHeartbeatBusy = true;
    try {
      if (state.connectQrLease) await heartbeatOneQr("connect", state.connectQrLease);
      if (!state.busy && state.apkQrLease) await heartbeatOneQr("apk", state.apkQrLease);
    } finally {
      state.qrHeartbeatBusy = false;
    }
  }

  function loadPairRequest(request) {
    state.pairRequestId = request.requestId;
    if ($("lan-pair-ip")) $("lan-pair-ip").value = request.transport === "tunnel" ? "Device Tunnel" : request.host;
    if ($("lan-pair-port")) $("lan-pair-port").value = request.transport === "tunnel" ? "17845" : String(request.port);
    if ($("lan-pair-fingerprint")) $("lan-pair-fingerprint").value = request.fingerprint;
    if ($("lan-pair-label")) $("lan-pair-label").value = request.controller || "SuperAgent MCP";
    if (request.segment && $("lan-segment-name")) $("lan-segment-name").value = request.segment;
    if ($("lan-pair-code")) $("lan-pair-code").value = "";
    if ($("lan-verified")) $("lan-verified").checked = false;
    pairStatus("Pairing request loaded. Compare the fingerprint on the target, enter its fresh 8-digit code locally, and confirm the fingerprint.");
    $("lan-pair-form")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    $("lan-pair-code")?.focus?.();
  }
  function paint() {
    const discovery = $("lan-discovered");
    if (discovery) {
      discovery.replaceChildren();
      if (!state.discovered.length) discovery.append(empty("No LAN Clients found. Check the target app and Windows Firewall, or enter its IPv4 manually."));
      for (const device of state.discovered) {
        const platform = device.platform === "android" ? "Android"
          : device.platform === "windows" ? "Windows" : "Unverified target";
        const direct = device.discoveryMode === "tls-unverified";
        const remoteBuild = device.appVersion && device.buildCode
          ? " · v" + device.appVersion + " · Build " + device.buildCode : "";
        const detail = direct
          ? "TLS certificate observed · network segment NOT verified · compare fingerprint on target"
          : platform + remoteBuild + " · Segment matched · compare TLS fingerprint";
        const { div, actions } = item(device.name || platform + " LAN Client",
          device.address + ":" + device.port, detail, "Unpaired");
        actions.append(button("Use for pairing", () => {
          state.pairRequestId = null;
          $("lan-pair-ip").value = device.address;
          $("lan-pair-port").value = String(device.port);
          $("lan-pair-fingerprint").value = device.fingerprint;
          $("lan-verified").checked = false;
          $("lan-pair-code").value = "";
          pairStatus("Device details loaded. Verify the fingerprint on the device, enter its current 8-digit code, and check the confirmation box.");
          $("lan-pair-form")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
          $("lan-pair-code").focus();
          notice(direct
            ? "Unverified TLS certificate only. Confirm the target's segment and compare the full fingerprint on the device before pairing."
            : "Fingerprint filled from discovery. Compare all 64 characters against the target's own screen before pairing.");
        }, false, state.busy));
        discovery.append(div);
      }
    }
    const tunnelList = $("lan-tunnel-devices");
    if (tunnelList) {
      tunnelList.replaceChildren();
      if (!state.tunnelDevices.length) tunnelList.append(empty("No enrolled tunnel devices."));
      for (const device of state.tunnelDevices) {
        const platform = device.platform === "android" ? "Android" : "Windows";
        const status = device.online ? "Online" : "Offline";
        const entry = item(device.name || platform + " Device", "Reverse HTTPS tunnel",
          platform + " · fingerprint " + String(device.fingerprint || "").slice(0, 16) + "…", status);
        entry.actions.append(button("Pair through tunnel", async () => {
          if (state.busy || !device.online) return;
          state.busy = true; paint();
          try {
            await invoke("tunnel_pair_request", {
              tunnelId: device.id, fingerprint: device.fingerprint, controller: "SuperAgent Tray",
            });
            notice("Tunnel pairing request created. Enter the current 8-digit code locally below and confirm the fingerprint.");
            state.busy = false;
            await refresh();
            const pending = state.pairingRequests.find((request) =>
              request.transport === "tunnel" && request.tunnelId === device.id && request.state === "pending");
            if (pending) loadPairRequest(pending);
          } catch (error) { notice("Cannot create tunnel pairing request: " + String(error), true); }
          finally { state.busy = false; paint(); }
        }, false, state.busy || !device.online));
        entry.actions.append(button("Revoke tunnel", async () => {
          if (!window.confirm("Revoke this Device Tunnel enrollment? The remote companion will need a new local invite.")) return;
          try {
            await invoke("tunnel_revoke", { tunnelId: device.id });
            await refresh();
            notice("Device Tunnel enrollment revoked.");
          } catch (error) { notice("Cannot revoke tunnel device: " + String(error), true); }
        }, true, state.busy));
        tunnelList.append(entry.div);
      }
    }
    const pairRequests = $("lan-pair-requests");
    if (pairRequests) {
      pairRequests.replaceChildren();
      if (!state.pairingRequests.length) {
        pairRequests.append(empty("No MCP pairing requests waiting for local completion."));
      }
      for (const request of state.pairingRequests) {
        const status = request.state === "pending" ? "Waiting for local code"
          : request.state === "completing" ? "Waiting for target approval"
          : request.state === "paired" ? "Paired"
          : request.state === "failed" ? "Failed"
          : request.state === "cancelled" ? "Cancelled" : "Expired";
        const extra = (request.controller || "MCP controller") + " · fingerprint " +
          String(request.fingerprint || "").slice(0, 16) + "…" +
          (request.error ? " · " + request.error : "");
        const entry = item("MCP pairing request", request.transport === "tunnel"
          ? "Device Tunnel · " + String(request.tunnelId || "").slice(0, 8)
          : request.host + ":" + request.port, extra, status);
        if (request.state === "pending") {
          entry.actions.append(button("Complete locally", () => loadPairRequest(request), false, state.busy));
          entry.actions.append(button("Cancel", async () => {
            try { await invoke("pair_cancel", { requestId: request.requestId }); }
            catch (error) { notice("Cannot cancel MCP pairing request: " + String(error), true); }
            if (state.pairRequestId === request.requestId) state.pairRequestId = null;
            await refresh();
          }, true, state.busy));
        }
        pairRequests.append(entry.div);
      }
    }
    const paired = $("lan-paired");
    if (paired) {
      paired.replaceChildren();
      if (!state.paired.length) paired.append(empty("No paired devices. Pair a Windows laptop or Android phone above while its LAN Client is open."));
      for (const device of state.paired) {
        const connected = Boolean(device.connected);
        const { div, actions } = item(
          device.label || "Device Client",
          device.transport === "tunnel" ? "Reverse HTTPS tunnel" : device.host + ":" + device.port,
          (device.platform === "android" ? "Android" : "Windows") + " · "
            + (device.transport === "tunnel" ? "Tunnel" : "LAN") + " · TLS fingerprint pinned",
          connected ? "Session active" : "Paired / approval required",
          device.id === state.selected
        );
        actions.append(button(device.id === state.selected ? "Selected" : "Select",
          () => { state.selected = device.id; paint(); }, false, state.busy || device.id === state.selected));
        actions.append(button("Request session", () => operation("open", { deviceId: device.id },
          "Approve the session request on the target device."), false, state.busy || connected));
        actions.append(button("Disconnect", () => void emergencyAccessStop("close", device.id),
          false, !connected));
        actions.append(button("Revoke", () => {
          if (window.confirm("Revoke this device's pairing and active session? This also cancels an action awaiting approval.")) {
            void emergencyAccessStop("revoke", device.id);
          }
        }, true, false));
        paired.append(div);
      }
    }
    const current = active();
    const chosen = state.paired.find((device) => device.id === state.selected);
    const platform = chosen?.platform === "android" ? "android" : "windows";
    const preset = $("lan-command-presets");
    if (preset) {
      if (state.presetFor !== state.selected || state.presetPlatform !== platform) {
        state.presetFor = state.selected;
        state.presetPlatform = platform;
        const options = platform === "android"
          ? ["android.info", "android.network", "android.network_details",
             "android.battery", "android.storage", "android.memory", "android.power",
             "android.display", "android.wifi", "android.audio", "android.sensors",
             "android.app", "android.uptime", "android.health", "android.support_status",
             "id", "uname -a", "getprop ro.product.model",
             "getprop ro.build.version.release", "getprop ro.build.version.sdk",
             "android.action.open_wifi_settings", "android.action.open_bluetooth_settings",
             "android.action.open_display_settings", "android.action.open_battery_settings",
             "android.action.open_storage_settings", "android.action.open_app_settings",
             "android.action.open_app_info", "android.action.open_date_settings",
             "android.action.volume_up", "android.action.volume_down"]
          : ["Get-ComputerInfo | Select-Object WindowsProductName", "Get-NetAdapter",
             "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version",
             "Get-PSDrive -PSProvider FileSystem"];
        const emptyOption = document.createElement("option");
        emptyOption.value = "";
        emptyOption.textContent = "Choose a recommended " + (platform === "android" ? "Android diagnostic" : "PowerShell command");
        const choices = options.map((value) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value.startsWith("android.action.")
            ? "REQUIRES PHONE APPROVAL  ·  " + value.replace("android.action.", "").replaceAll("_", " ")
            : value;
          return option;
        });
        preset.replaceChildren(emptyOption, ...choices);
        if ($("lan-command")) $("lan-command").value = "";
      }
      preset.disabled = !current || state.busy;
    }
    if ($("lan-command-mode")) $("lan-command-mode").textContent =
      platform === "android" ? "Android diagnostic or explicitly approved local action" : "PowerShell command on the selected Windows laptop";
    if ($("lan-command")) $("lan-command").placeholder =
      platform === "android" ? "android.info" : "Get-ComputerInfo | Select-Object WindowsProductName";
    if ($("lan-paired-count")) $("lan-paired-count").textContent = state.paired.length + " paired";
    if ($("lan-session-status")) $("lan-session-status").textContent =
      current ? "Connected · " + current.host : "No active session";
    if ($("lan-command")) $("lan-command").disabled = state.busy || !current;
    if ($("lan-command-run")) $("lan-command-run").disabled = state.busy || !current;
    if ($("lan-android-quick-actions")) $("lan-android-quick-actions").hidden = platform !== "android";
    for (const quickId of ["lan-health-quick", "lan-support-quick"]) {
      if ($(quickId)) $(quickId).disabled = !current || platform !== "android" || state.busy;
    }
    if ($("lan-pair-submit")) $("lan-pair-submit").disabled = state.busy;
    if ($("lan-discovery-scan")) $("lan-discovery-scan").disabled = state.busy || state.scanning;
    if ($("lan-tunnel-invite")) $("lan-tunnel-invite").disabled = state.busy;
    if ($("lan-apk-download-qr")) $("lan-apk-download-qr").disabled = state.busy;
    window.__superagentLanFilesRefresh?.();
  }
  async function refresh(manual = false) {
    if (state.busy) return;
    const ticket = manual === true ? window.TrayFeedback?.begin({
      key: "lan:refresh", button: $("lan-paired-refresh"), label: "Refreshing devices…",
    }) : null;
    try {
      const reply = await invoke("list");
      state.paired = Array.isArray(reply.devices) ? reply.devices : [];
      state.pairingRequests = Array.isArray(reply.pairingRequests) ? reply.pairingRequests : [];
      state.tunnelDevices = Array.isArray(reply.tunnelDevices) ? reply.tunnelDevices : [];
      if (!state.paired.some((device) => device.id === state.selected)) state.selected = state.paired[0]?.id || null;
      paint();
      if (manual === true) qrToast("success", "Device list refreshed.");
    } catch (error) {
      notice("Cannot read paired devices. Check Core connectivity.", true);
      if (manual === true) qrToast("error", "Device refresh unavailable.");
    } finally { ticket?.end(); }
  }
  async function scan() {
    if (state.busy || state.scanning) return;
    const segment = ($("lan-segment-name")?.value || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}$/.test(segment)) {
      state.discovered = [];
      paint();
      notice("Enter a matching network segment name (3–32 letters, numbers, spaces, _ . -) before scanning.", true);
      return;
    }
    const targetIp = ($("lan-direct-ip")?.value || "").trim();
    const parts = targetIp.split(".").map(Number);
    const privateTarget = parts.length === 4 && parts.every((n) => n <= 255) &&
      (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168));
    if (targetIp && (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(targetIp) || !privateTarget)) {
      state.discovered = [];
      paint();
      notice("Enter a valid numeric IPv4 target; no hostname or public URL is accepted.", true);
      return;
    }
    state.discovered = [];
    const ticket = window.TrayFeedback?.begin({
      key: "lan:scan", button: $("lan-discovery-scan"), label: "Scanning LAN…",
    });
    state.scanning = true;
    const scanRevision = state.segmentRevision;
    if ($("lan-discovery-status")) $("lan-discovery-status").textContent = "Scanning...";
    paint();
    try {
      const reply = await invoke("discover", targetIp ? { segment, targetIp } : { segment });
      // An older in-flight scan cannot repopulate results after segment change.
      if (scanRevision !== state.segmentRevision ||
          ($("lan-segment-name")?.value || "").trim() !== segment ||
          ($("lan-direct-ip")?.value || "").trim() !== targetIp) return;
      state.discovered = Array.isArray(reply.devices) ? reply.devices : [];
      if ($("lan-discovery-status")) $("lan-discovery-status").textContent = state.discovered.length + " found";
      paint();
      qrToast("success", "LAN scan finished · " + state.discovered.length + " device(s) found.");
    } catch (error) {
      if ($("lan-discovery-status")) $("lan-discovery-status").textContent = "Unavailable";
      notice("LAN scan failed. Check network segment and Core.", true);
      qrToast("error", "LAN scan unavailable.");
    } finally { state.scanning = false; paint(); ticket?.end(); }
  }
  async function emergencyAccessStop(action, deviceId) {
    // Emergency reduction of access is never blocked by a pending command.
    try {
      await invoke(action, { deviceId });
      notice(action === "revoke" ? "Device pairing revoked." : "Device session disconnected.");
    } catch (error) {
      notice("Emergency access stop failed: " + String(error), true);
    } finally {
      if (!state.busy) await refresh();
    }
  }
  function validatePairForm() {
    const host = ($("lan-pair-ip")?.value || "").trim();
    const port = Number($("lan-pair-port")?.value);
    const code = ($("lan-pair-code")?.value || "").trim();
    const fingerprint = ($("lan-pair-fingerprint")?.value || "").trim();
    const controller = ($("lan-pair-label")?.value || "").trim();
    const segment = ($("lan-segment-name")?.value || "").trim();
    const ipv4 = /^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(host);
    const octets = host.split(".").map(Number);
    const privateHost = ipv4 && octets.every((n) => n <= 255) &&
      (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
        || (octets[0] === 192 && octets[1] === 168));
    const checks = [
      ["lan-pair-ip", privateHost, "a valid private IPv4 address"],
      ["lan-pair-port", Number.isInteger(port) && port >= 1024 && port <= 65534, "a valid port (1024–65534)"],
      ["lan-pair-code", /^\d{8}$/.test(code), "the current 8-digit pairing code"],
      ["lan-pair-label", /^[A-Za-z0-9_ .-]{1,60}$/.test(controller), "a valid controller label"],
      ["lan-pair-fingerprint", /^[a-f0-9]{64}$/i.test(fingerprint), "the full 64-character SHA-256 fingerprint"],
      ["lan-verified", Boolean($("lan-verified")?.checked), "fingerprint confirmation"],
    ];
    const missing = checks.filter(([id, valid]) => {
      $(id)?.setAttribute("aria-invalid", String(!valid));
      return !valid;
    });
    if (segment && !/^[A-Za-z0-9][A-Za-z0-9 _.-]{2,31}$/.test(segment)) {
      missing.push(["lan-segment-name", false, "a valid network segment"]);
    }
    if (missing.length) {
      pairStatus("Before pairing, provide: " + missing.map(([, , label]) => label).join("; ") + ".", true);
      $(missing[0][0])?.focus?.();
      return null;
    }
    return { host, port, code, fingerprint, controller, ...(segment ? { segment } : {}) };
  }
  async function operation(action, payload, progress) {
    if (state.busy) return;
    const actionButton = (action === "pair" || action === "pair_complete")
      ? $("lan-pair-submit") : action === "exec" ? $("lan-command-run") : null;
    const ticket = window.TrayFeedback?.begin({
      key: "lan:action:" + action, button: actionButton,
      label: action === "exec" ? "Running command…" : "Awaiting device approval…",
    });
    state.busy = true;
    paint();
    notice(progress);
    if (action === "pair" || action === "pair_complete") {
      pairStatus("Pairing request sent. Approve the prompt on Android or type APPROVE in the Windows client. This may take up to 90 seconds.");
      if ($("lan-pair-submit")) $("lan-pair-submit").textContent = "Waiting for device approval...";
    }
    try {
      const reply = await invoke(action, payload);
      if (reply?.success === false) throw Error("Device did not confirm the operation.");
      if (action === "pair" || action === "pair_complete") {
        state.selected = reply.device?.id || null;
        state.pairRequestId = null;
        $("lan-pair-code").value = "";
        $("lan-verified").checked = false;
        pairStatus("Pairing approved. In Paired devices & sessions, select Request session to ask for separate access.");
      }
      if (action === "revoke" && state.selected === payload.deviceId) state.selected = null;
      if (action === "exec") {
        const result = reply.result || {};
        const text = [result.stdout || "", result.stderr ? "[stderr]\n" + result.stderr : ""].filter(Boolean).join("\n");
        $("lan-output").textContent = (result.ok ? "" : "Command failed: " + (result.error || "") + "\n") +
          (text || "(no output)") + "\nExit code: " + String(result.exitCode);
        const androidAction = payload.command.startsWith("android.action.");
        notice(result.ok && androidAction
          ? (payload.command.startsWith("android.action.open_")
            ? "Phone owner approved opening Settings. Sharing will end and a new pairing will be required."
            : "Phone owner approved a one-step media volume adjustment.")
          : result.ok ? "Remote command completed." : "Remote command returned an error.", !result.ok);
      } else notice(action === "open" ? "Session approved by the target laptop." :
        (action === "pair" || action === "pair_complete") ? "Pairing approved. Request a separate terminal session." :
        action === "revoke" ? "Pairing revoked on the target laptop." : "Session disconnected.");
      if (action === "pair" || action === "pair_complete") qrToast("success", "Pairing approved. Request session access separately.");
      else if (action === "open") qrToast("success", "Device session approved.");
      else if (action === "exec") qrToast(reply?.result?.ok === true ? "success" : "warning",
        reply?.result?.ok === true ? "Remote command completed." : "Remote command result requires inspection.");
    } catch (error) {
      notice("LAN action failed: " + String(error), true);
      qrToast(isTimeout(error) ? "warning" : "error",
        isTimeout(error) ? "LAN request outcome unverified. Inspect the device before retrying."
          : "LAN action rejected. Check inline pairing or device status.");
      if (action === "pair" || action === "pair_complete") {
        const detail = String(error);
        const help = /Full YOLO/i.test(detail)
          ? "Enable Full YOLO locally in SuperAgent before requesting remote pairing."
          : /timed out|timeout/i.test(detail)
            ? "The request timed out. Keep the target app open, approve on the device, and use a new 8-digit code."
            : detail;
        pairStatus("Pairing failed: " + help, true);
      }
    } finally {
      if (action === "pair" || action === "pair_complete") {
        $("lan-pair-code").value = "";
        if ($("lan-pair-submit")) $("lan-pair-submit").textContent = "Request pairing";
      }
      state.busy = false;
      await refresh();
      ticket?.end();
    }
  }
  function install() {
    $("lan-discovery-scan")?.addEventListener("click", scan);
    $("lan-direct-ip")?.addEventListener("input", () => {
      state.discovered = [];
      state.segmentRevision++;
      paint();
      if ($("lan-discovery-status")) $("lan-discovery-status").textContent = "Target changed — scan again";
    });
    $("lan-segment-name")?.addEventListener("input", () => {
      // Old discovery results can NEVER remain visible after changing segments.
      state.discovered = [];
      state.segmentRevision++;
      paint();
      if ($("lan-discovery-status")) $("lan-discovery-status").textContent = "Select segment and scan";
    });
    $("lan-paired-refresh")?.addEventListener("click", () => void refresh(true));
    const createConnectQr = async (background = false) => {
      if (state.busy || (background && state.qrOutcomeUnknown.connect)) return;
      const ticket = window.TrayFeedback?.begin({
        key: "lan:connect-qr", button: $("lan-tunnel-invite"),
        label: "Creating connect QR…", background,
      });
      if (window.TrayFeedback && !ticket) return;
      state.busy = true;
      paint();
      const status = $("lan-tunnel-status");
      if (status) status.textContent = background
        ? "Refreshing connection QR in background…"
        : "Preparing connection QR and HTTPS tunnel (up to 75 seconds)…";
      try {
        const reply = await invoke("tunnel_invite");
        if (reply?.success === false) throw Error("Core rejected QR creation.");
        const setup = reply?.invite?.setup;
        const qrMatrix = reply?.invite?.qrMatrix;
        const inviteId = reply?.invite?.inviteId;
        const expiresAt = reply?.invite?.expiresAt;
        if (typeof setup !== "string" || setup.length < 40 || setup.length > 1024
            || typeof inviteId !== "string" || !/^[a-f0-9-]{36}$/i.test(inviteId)
            || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())
          throw Error("Invalid tunnel invite response.");
        const qr = $("lan-tunnel-qr");
        const card = $("lan-tunnel-qr-card");
        if (!qr || !card) throw Error("QR display is unavailable in this Tray build.");
        drawQrMatrix(qr, qrMatrix);
        card.hidden = false;
        state.connectQrLease = { id: inviteId, expiresAt };
        state.qrOutcomeUnknown.connect = false;
        if (status) status.textContent = "Connection QR active · " + qrRemaining(expiresAt - Date.now()) + " remaining · heartbeat active";
        if (navigator?.clipboard?.writeText) {
          try { await navigator.clipboard.writeText(setup); } catch {}
        }
        notice("One-time Device Tunnel QR created. Heartbeat will refresh it automatically before expiry.");
        qrToast("success", "Connection QR ready. Scan before it expires.", background);
      } catch (error) {
        const unknown = isTimeout(error);
        state.qrOutcomeUnknown.connect = unknown;
        if (!state.connectQrLease || state.connectQrLease.expiresAt <= Date.now()) {
          state.connectQrLease = null;
          clearQrCanvas("lan-tunnel-qr", "lan-tunnel-qr-card");
        }
        const message = unknown
          ? "Connection QR request timed out. Outcome unverified; inspect existing QR before retrying."
          : "Cannot create Device Tunnel QR. Check Core, HTTPS tunnel, and try again.";
        if (status) status.textContent = message;
        notice(message, !unknown);
        qrToast(unknown ? "warning" : "error", message, background);
      } finally {
        state.busy = false;
        paint();
        ticket?.end();
      }
    };
    const createApkQr = async (background = false) => {
      if (state.busy || (background && state.qrOutcomeUnknown.apk)) return;
      const ticket = window.TrayFeedback?.begin({
        key: "lan:apk-qr", button: $("lan-apk-download-qr"),
        label: "Preparing APK QR…", background,
      });
      if (window.TrayFeedback && !ticket) return;
      state.busy = true;
      paint();
      const status = $("lan-apk-status");
      if (status) status.textContent = background
        ? "Refreshing APK download QR in background…"
        : "Preparing Android APK download QR (up to 75 seconds)…";
      try {
        const reply = await invoke("apk_download_qr");
        if (reply?.success === false) throw Error("Core rejected APK QR creation.");
        const apk = reply?.apk;
        const qrMatrix = apk?.qrMatrix;
        if (!apk || typeof apk.size !== "number" || !Number.isSafeInteger(apk.size) || apk.size < 1024
            || typeof apk.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(apk.sha256)
            || typeof apk.filename !== "string" || !/^[A-Za-z0-9._-]{1,100}\.apk$/.test(apk.filename)
            || typeof apk.heartbeatId !== "string" || !/^[a-f0-9]{64}$/.test(apk.heartbeatId)
            || !Number.isSafeInteger(apk.expiresAt) || apk.expiresAt <= Date.now())
          throw Error("Invalid APK download QR response.");
        const qr = $("lan-apk-qr");
        const card = $("lan-apk-qr-card");
        const meta = $("lan-apk-meta");
        if (!qr || !card || !meta) throw Error("APK QR display is unavailable in this Tray build.");
        drawQrMatrix(qr, qrMatrix);
        card.hidden = false;
        state.apkQrLease = { id: apk.heartbeatId, expiresAt: apk.expiresAt };
        state.qrOutcomeUnknown.apk = false;
        const mb = (apk.size / (1024 * 1024)).toFixed(1);
        meta.textContent = apk.filename + " · " + mb + " MiB · SHA-256 " + apk.sha256;
        if (status) status.textContent = "APK download QR active · " + qrRemaining(apk.expiresAt - Date.now()) + " remaining · heartbeat active";
        notice("Temporary Android APK download QR created. Heartbeat will refresh it automatically before expiry.");
        qrToast("success", "APK download QR ready. Scan to download.", background);
      } catch (error) {
        const unknown = isTimeout(error);
        state.qrOutcomeUnknown.apk = unknown;
        if (!state.apkQrLease || state.apkQrLease.expiresAt <= Date.now()) {
          state.apkQrLease = null;
          clearQrCanvas("lan-apk-qr", "lan-apk-qr-card");
        }
        const message = unknown
          ? "APK download QR request timed out. Outcome unverified; inspect existing ticket before retrying."
          : "Cannot create Android APK download QR. Check that the APK, Core, and tunnel are available.";
        if (status) status.textContent = message;
        notice(message, !unknown);
        qrToast(unknown ? "warning" : "error", message, background);
      } finally {
        state.busy = false;
        paint();
        ticket?.end();
      }
    };
    qrRefreshHandler = (kind) => {
      if (kind === "connect") void createConnectQr(true);
      else if (kind === "apk") void createApkQr(true);
    };
    $("lan-tunnel-invite")?.addEventListener("click", () => void createConnectQr());
    $("lan-apk-download-qr")?.addEventListener("click", () => void createApkQr());
    $("lan-output-clear")?.addEventListener("click", () => { $("lan-output").textContent = "Output cleared."; });
    for (const [id, command] of [["lan-health-quick", "android.health"], ["lan-support-quick", "android.support_status"]]) {
      $(id)?.addEventListener("click", () => {
        const selected = active();
        if (!selected || selected.platform !== "android" || state.busy) return;
        if ($("lan-command")) $("lan-command").value = command;
        void operation("exec", { deviceId: selected.id, command }, "Reading owner-approved Android session diagnostics...");
      });
    }
    $("lan-command-presets")?.addEventListener("change", () => {
      const value = $("lan-command-presets").value;
      if (value && $("lan-command")) $("lan-command").value = value;
    });
    $("lan-pair-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      if (state.busy) {
        pairStatus("A pairing request is already in progress. Check the target device for approval.");
        return;
      }
      if (state.pairRequestId) {
        const code = ($("lan-pair-code")?.value || "").trim();
        const verified = Boolean($("lan-verified")?.checked);
        $("lan-pair-code")?.setAttribute("aria-invalid", String(!/^\d{8}$/.test(code)));
        $("lan-verified")?.setAttribute("aria-invalid", String(!verified));
        if (!/^\d{8}$/.test(code) || !verified) {
          pairStatus("Enter the current 8-digit code and confirm the full fingerprint before completing this pairing request.", true);
          (!/^\d{8}$/.test(code) ? $("lan-pair-code") : $("lan-verified"))?.focus?.();
          return;
        }
        void operation("pair_complete", { requestId: state.pairRequestId, code, verified: true },
          "Completing pairing locally. Awaiting the target owner's approval.");
        return;
      }
      const payload = validatePairForm();
      if (!payload) return;
      void operation("pair", payload, "Pairing request sent. Awaiting the target owner's approval.");
    });
    $("lan-command-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const current = active();
      const command = $("lan-command").value.trim();
      if (!current || !command || state.busy) return;
      if (current.platform === "android" && command.startsWith("android.action.")) {
        const accepted = window.confirm("Request this action on the Android phone? The phone owner must approve it separately. Settings screens end LAN sharing automatically.");
        if (!accepted) return;
      }
      void operation("exec", { deviceId: current.id, command },
        current.platform === "android" && command.startsWith("android.action.")
          ? "Waiting for explicit approval on the Android phone..." : "Remote command running...");
    });
    const heartbeatTimer = window.setInterval(() => { void runQrHeartbeat(); }, QR_HEARTBEAT_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void runQrHeartbeat();
    });
    window.addEventListener("beforeunload", () => window.clearInterval(heartbeatTimer), { once: true });
    if ($("page-lan-devices")?.hidden === false) void refresh();
  }
  window.__superagentLanGetSelected = () => active();
  window.__superagentLanRefresh = refresh;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
