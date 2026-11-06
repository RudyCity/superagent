"use strict";
/* Hallmark · pre-emit critique: P4 H5 E4 S5 R5 V4 */
/** LAN Devices manager. Native Tauri -> selected authenticated Core only. */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { discovered: [], paired: [], pairingRequests: [], selected: null, pairRequestId: null,
    busy: false, scanning: false, presetFor: null, presetPlatform: null, segmentRevision: 0 };
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
        const entry = item("MCP pairing request", request.host + ":" + request.port, extra, status);
        if (request.state === "pending") {
          entry.actions.append(button("Complete locally", () => {
            state.pairRequestId = request.requestId;
            $("lan-pair-ip").value = request.host;
            $("lan-pair-port").value = String(request.port);
            $("lan-pair-fingerprint").value = request.fingerprint;
            $("lan-pair-label").value = request.controller || "SuperAgent MCP";
            if (request.segment && $("lan-segment-name")) $("lan-segment-name").value = request.segment;
            $("lan-pair-code").value = "";
            $("lan-verified").checked = false;
            pairStatus("MCP request loaded. Compare the full fingerprint on the target, enter the fresh 8-digit code locally, then request pairing.");
            $("lan-pair-form")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
            $("lan-pair-code")?.focus?.();
          }, false, state.busy));
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
          device.label || "LAN Client", device.host + ":" + device.port,
          (device.platform === "android" ? "Android" : "Windows") + " · TLS fingerprint pinned",
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
    window.__superagentLanFilesRefresh?.();
  }
  async function refresh() {
    if (state.busy) return;
    try {
      const reply = await invoke("list");
      state.paired = Array.isArray(reply.devices) ? reply.devices : [];
      state.pairingRequests = Array.isArray(reply.pairingRequests) ? reply.pairingRequests : [];
      if (!state.paired.some((device) => device.id === state.selected)) state.selected = state.paired[0]?.id || null;
      paint();
    } catch (error) { notice("Cannot read paired devices: " + String(error), true); }
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
    } catch (error) {
      if ($("lan-discovery-status")) $("lan-discovery-status").textContent = "Unavailable";
      notice("LAN scan failed: " + String(error), true);
    } finally { state.scanning = false; paint(); }
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
    state.busy = true;
    paint();
    notice(progress);
    if (action === "pair" || action === "pair_complete") {
      pairStatus("Pairing request sent. Approve the prompt on Android or type APPROVE in the Windows client. This may take up to 90 seconds.");
      if ($("lan-pair-submit")) $("lan-pair-submit").textContent = "Waiting for device approval...";
    }
    try {
      const reply = await invoke(action, payload);
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
    } catch (error) {
      notice("LAN action failed: " + String(error), true);
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
    $("lan-paired-refresh")?.addEventListener("click", refresh);
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
      const payload = validatePairForm();
      if (!payload) return;
      if (state.pairRequestId) {
        void operation("pair_complete", { requestId: state.pairRequestId, code: payload.code, verified: true },
          "Completing MCP pairing locally. Awaiting the target owner's approval.");
      } else {
        void operation("pair", payload, "Pairing request sent. Awaiting the target owner's approval.");
      }
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
    if ($("page-lan-devices")?.hidden === false) void refresh();
  }
  window.__superagentLanGetSelected = () => active();
  window.__superagentLanRefresh = refresh;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
