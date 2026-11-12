/* Native Windows receiver UI. All privileged actions pass through fixed Rust commands. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const native = window.__TAURI__;
  const invoke = native?.core?.invoke;
  const listen = native?.event?.listen;
  const model = { running: false, tunnel: false, starting: false, waiting: null, selected: null, camera: null, scanning: false, busy: false, events: 0 };
  const set = (id, value) => { const target = $(id); if (target) target.textContent = String(value ?? "—"); };
  const btn = (id, enabled) => { if ($(id)) $(id).disabled = !enabled; };
  const label = (value) => typeof value === "string" ? value.slice(0, 230) : "Unknown";
  const when = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function note(message) {
    const list = $("activity-list");
    if (!list) return;
    if (!model.events) list.replaceChildren();
    model.events += 1;
    const li = document.createElement("li");
    const pip = document.createElement("span"); pip.className = "activity-pip";
    const body = document.createElement("span"); body.textContent = label(message);
    const time = document.createElement("time"); time.textContent = when();
    li.append(pip, body, time);
    list.prepend(li);
    while (list.children.length > 18) list.lastElementChild.remove();
  }
  function toast(message) {
    const node = $("toast");
    node.textContent = label(message); node.hidden = false;
    clearTimeout(toast.timeout);
    toast.timeout = setTimeout(() => { node.hidden = true; }, 4500);
  }
  function present() {
    btn("start", !model.running && !model.starting);
    btn("stop", model.running);
    btn("camera-btn", model.running && !model.scanning);
    btn("inspect", model.running);
    btn("disconnect", model.tunnel && model.running);
    btn("revoke", model.running);
    btn("rotate-code", model.running);
    btn("share-file", model.running);
    btn("share-folder", model.running);
    $("segment").disabled = model.running || model.starting;
    $("local-detail").hidden = !model.running;
    $("connection-chip").classList.toggle("online", model.running);
    set("connection-label", model.running ? "Receiver ready" : model.starting ? "Starting receiver" : "Receiver offline");
    set("receiver-state", model.running ? "Ready to approve" : model.starting ? "Starting…" : "Offline");
    set("tunnel-state", model.tunnel ? "Connected" : "Disconnected");
  }
  async function invokeAction(type, extra = {}) {
    if (!invoke) throw Error("Open this page in the installed SuperAgent LAN Client application.");
    return invoke("send_action", { request: { type, ...extra } });
  }
  async function protectedAction(task, labelText) {
    if (model.busy) return;
    model.busy = true;
    try { await task(); if (labelText) note(labelText); }
    catch (error) { toast(error.message || String(error)); note("Operation refused: " + (error.message || error)); }
    finally { model.busy = false; present(); }
  }
  function clearSelection() {
    model.selected = null;
    $("verify-panel").hidden = true;
    set("dest-host", "—");
  }
  function validateQr(text) {
    if (typeof text !== "string" || text.length > 2048) throw Error("Invalid QR payload length.");
    let value;
    try { value = JSON.parse(text.trim()); } catch { throw Error("Scan a Connect QR, not an APK download QR."); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid connection code.");
    const keys = Object.keys(value).sort().join(",");
    const compact = keys === "c,e,i,k,u,v" && value.k === "sat" && value.v === 1;
    const copied = keys === "code,inviteId,url";
    if (!compact && !copied) throw Error("Unsupported QR format. Create a fresh Connect QR.");
    const urlText = compact ? value.u : value.url;
    const invite = compact ? value.i : value.inviteId;
    const code = compact ? value.c : value.code;
    if (typeof urlText !== "string" || typeof invite !== "string" || typeof code !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(invite) || !/^\d{10}$/.test(code)) throw Error("Invalid connection invitation.");
    if (compact && (!Number.isSafeInteger(value.e) || value.e <= Date.now() ||
        value.e > Date.now() + 11 * 60_000)) throw Error("QR expired. Create a fresh Connect QR.");
    let target;
    try { target = new URL(urlText); } catch { throw Error("Invalid HTTPS address."); }
    if (target.protocol !== "https:" || target.pathname !== "/" || target.username ||
        target.password || target.search || target.hash || target.port) throw Error("Connect QR needs a clean HTTPS address.");
    return { raw: text.trim(), host: target.origin };
  }
  function selectQr(text) {
    try {
      const value = validateQr(text);
      model.selected = value.raw;
      $("verify-panel").hidden = false;
      set("dest-host", value.host);
      stopCamera();
      note("One-time QR scanned. Confirm the controller hostname before connecting.");
      $("connect-btn").focus();
    } catch (error) { clearSelection(); toast(error.message); }
  }
  function emitStatus(data) {
    if (!data || typeof data !== "object") return;
    const event = data.event;
    if (event === "ready") {
      model.starting = false; model.running = true;
      set("local-ip", String(data.host || "—") + ":" + String(data.port || "—"));
      set("local-adapter", data.adapter || "—");
      set("pairing-code", data.pairingCode || "—");
      note("Receiver ready on " + String(data.host) + ". Pairing requires your consent.");
    } else if (event === "connecting") {
      note("Connecting to " + label(data.origin)); set("tunnel-state", "Connecting…");
    } else if (event === "connected") {
      model.tunnel = true; note("HTTPS Device Tunnel enrolled.");
    } else if (event === "disconnected") {
      model.tunnel = false; note("Device Tunnel disconnected.");
    } else if (event === "approval_required") {
      model.waiting = data;
      set("consent-controller", data.controller || "Unknown controller");
      set("consent-kind", data.kind || "Access request");
      set("consent-ip", data.ip || "—");
      set("consent-detail", data.detail || "—");
      $("consent-overlay").hidden = false;
      $("deny").focus();
      note("Permission requested: " + label(data.kind) + " from " + label(data.controller));
    } else if (event === "approval_resolved" || event === "approval_expired") {
      if (model.waiting?.id === data.id) hideApproval();
      note(event === "approval_expired" ? "Access request expired and was denied." :
        data.allowed ? "You approved a request." : "You denied a request.");
    } else if (event === "pairing_code") {
      set("pairing-code", data.code); note("One-time pairing code rotated.");
    } else if (event === "revoked") note("All paired-device access revoked.");
    else if (event === "shared") note("Owner selected a " + label(data.kind) + " to share: " + label(data.name));
    else if (event === "notice") note(label(data.message));
    else if (event === "error") { toast(label(data.message)); note("Receiver error: " + label(data.message)); }
    else if (event === "stopped" || event === "process_closed") {
      model.running = false; model.starting = false; model.tunnel = false;
      hideApproval(); stopCamera(); clearSelection();
      note(event === "process_closed" ? "Receiver process closed." : "Sharing stopped.");
    }
    present();
  }
  function hideApproval() { model.waiting = null; $("consent-overlay").hidden = true; }
  const scanner = $("scan-canvas");
  const context = scanner.getContext("2d", { willReadFrequently: true });
  async function scanImage(source, requestedWidth, requestedHeight) {
    if (!invoke) throw Error("Native QR scanner unavailable outside the installed application.");
    const ratio = Math.min(1, 960 / requestedWidth, 720 / requestedHeight);
    const width = Math.max(64, Math.floor(requestedWidth * ratio));
    const height = Math.max(64, Math.floor(requestedHeight * ratio));
    scanner.width = width; scanner.height = height;
    context.drawImage(source, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    const gray = new Uint8Array(width * height);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
      gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    let binary = "";
    for (let i = 0; i < gray.length; i += 8192) {
      binary += String.fromCharCode(...gray.subarray(i, i + 8192));
    }
    return invoke("scan_qr_frame", { width, height, grayB64: btoa(binary) });
  }
  function stopCamera() {
    model.scanning = false;
    if (model.camera) {
      for (const track of model.camera.getTracks()) track.stop();
      model.camera = null;
    }
    const video = $("camera-preview");
    video.srcObject = null;
    video.hidden = true;
    $("scan-placeholder").hidden = false;
    $("camera-stop").hidden = true;
    present();
  }
  async function scanCamera() {
    if (model.scanning || !model.running) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Error("Camera unavailable. Check Windows camera privacy settings.");
      model.camera = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const video = $("camera-preview");
      video.srcObject = model.camera;
      video.hidden = false;
      $("scan-placeholder").hidden = true;
      $("camera-stop").hidden = false;
      await video.play();
      model.scanning = true;
      present();
      note("Camera started. Point at a Connect QR in SuperAgent Tray.");
      while (model.scanning && model.camera && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const result = await scanImage(video, video.videoWidth, video.videoHeight);
        if (!model.scanning) break;
        if (result) { selectQr(result); break; }
        await new Promise(resolve => setTimeout(resolve, 240));
      }
    } catch (error) { toast(error.message || "Camera access failed."); note("Camera unavailable or denied."); }
    finally { stopCamera(); }
  }
  async function imageFromFile(file) {
    if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024)
      throw Error("Select a PNG, JPEG, or WebP image under 5 MiB.");
    const bitmap = await createImageBitmap(file);
    try {
      const content = await scanImage(bitmap, bitmap.width, bitmap.height);
      if (!content) throw Error("No readable QR code in this image.");
      selectQr(content);
    } finally { bitmap.close(); }
  }
  async function answerPermission(allowed) {
    if (!model.waiting) return;
    const approval = model.waiting;
    btn("approve", false); btn("deny", false);
    try {
      await invokeAction(allowed ? "approve" : "deny", { id: approval.id });
      note(allowed ? "Permission approved by the device owner." : "Permission denied by the device owner.");
      hideApproval();
    } catch (error) { toast(error.message || "Approval could not be submitted."); }
    finally { btn("approve", true); btn("deny", true); }
  }
  $("start").addEventListener("click", () => {
    void protectedAction(async () => {
      const segment = $("segment").value.trim();
      if (!/^[A-Za-z0-9_-]{3,32}$/.test(segment)) throw Error("Segment must have 3–32 letters, digits, - or _.");
      model.starting = true; present();
      await invoke("start_client", { segment });
      note("Starting the native Windows receiver.");
    });
  });
  $("stop").addEventListener("click", () => {
    void protectedAction(async () => {
      stopCamera();
      await invoke("stop_client");
      model.running = false; model.tunnel = false; model.starting = false;
      hideApproval(); clearSelection();
      note("Receiver stopped and access ended.");
    });
  });
  $("camera-btn").addEventListener("click", () => { void scanCamera(); });
  $("camera-stop").addEventListener("click", stopCamera);
  $("qr-file").addEventListener("change", event => {
    const file = event.target.files?.[0];
    if (file) void imageFromFile(file).catch(error => toast(error.message || String(error)));
    event.target.value = "";
  });
  $("inspect").addEventListener("click", () => selectQr($("raw-code").value));
  $("connect-btn").addEventListener("click", () => {
    if (!model.selected) return;
    const payload = model.selected;
    void protectedAction(async () => {
      await invokeAction("connect", { payload });
      clearSelection();
      $("raw-code").value = "";
      set("tunnel-state", "Connecting…");
      note("Connection request submitted. Any incoming access still requires your approval.");
    });
  });
  $("disconnect").addEventListener("click", () => void protectedAction(async () => {
    await invokeAction("disconnect"); model.tunnel = false; note("Tunnel disconnected and pairing revoked.");
  }));
  $("revoke").addEventListener("click", () => void protectedAction(async () => {
    await invokeAction("revoke"); note("All local pairings revoked.");
  }));
  $("rotate-code").addEventListener("click", () => void protectedAction(
    () => invokeAction("rotate"), "Requested a fresh pairing code."
  ));
  $("share-file").addEventListener("click", () => void protectedAction(
    () => invoke("select_share", { folder: false }), "File picker opened for owner-only sharing."
  ));
  $("share-folder").addEventListener("click", () => void protectedAction(
    () => invoke("select_share", { folder: true }), "Folder picker opened for owner-only sharing."
  ));
  $("approve").addEventListener("click", () => { void answerPermission(true); });
  $("deny").addEventListener("click", () => { void answerPermission(false); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && model.waiting) { event.preventDefault(); void answerPermission(false); }
  });
  window.addEventListener("pagehide", stopCamera);
  set("top-time", when());
  setInterval(() => { set("top-time", when()); }, 15000);
  if (typeof invoke !== "function" || typeof listen !== "function") {
    toast("This interface requires the installed Tauri desktop application.");
    btn("start", false);
    return;
  }
  void listen("receiver-event", event => emitStatus(event.payload)).then(async () => {
    try {
      const alreadyRunning = await invoke("receiver_running");
      if (alreadyRunning) { model.running = true; await invokeAction("status"); }
      present();
    } catch (error) { toast(error.message || "Native receiver unavailable."); }
  });
  present();
})();
