"use strict";
/* Hallmark · component: management table · genre: modern-minimal · theme: inherited
 * states: default · hover · focus · active · disabled · loading · error · success
 */
(function () {
  const el = id => document.getElementById(id);
  const kinds = Object.freeze({ all:"All screens", native:"Applications",
    "managed-cdp":"Chrome CDP", "cdp-delegate":"CDP Delegate", "lan-device":"LAN Devices" });
  const state = {items:[],sources:{},filter:"all",loading:false,poll:null};
  const streamPresets = Object.freeze({
    ultra: { maxWidth: 1280, quality: 78, intervalMs: 16 },
    detail: { maxWidth: 1920, quality: 85, intervalMs: 25 },
    balanced: { maxWidth: 1280, quality: 72, intervalMs: 25 },
    save: { maxWidth: 768, quality: 55, intervalMs: 80 },
  });
  const stream = {
    active: false,
    token: null,
    id: null,
    title: "",
    application: "",
    pid: 0,
    nativeId: "",
    quality: "ultra",
    lastHash: null,
    timer: null,
    inFlight: false,
    framesDelivered: 0,
    fpsWindowCount: 0,
    fpsLastTime: 0,
    currentFps: "0.0",
    lanUrl: "",
    controlEnabled: false,
    controlRequested: false,
    controllerSeconds: 0,
    controllerScopes: {mouse:false,keyboard:false},
    controllerPending: false,
    remoteReadiness: null,
    recording: null,
    recordingPending: false,
    isLanDevice: false,
    devicePlatform: null,
    deviceId: "",
    generation: 0,
    startPending: false,
    pointer: null,
    inputPending: false,
    lastFrameAt: 0,
  };
  // A slow native recorder or controller revoke must finish before another start.
  let stopOperation = null;

  const invoke = async (action,payload) => {
    const call=window.__TAURI__?.core?.invoke;
    if(typeof call!=="function")throw Error("Native Tray is required.");
    return call("desktop_live_action",{action,payload:payload??null});
  };
  const node = (tag,cls,text) => {
    const result=document.createElement(tag);
    if(cls)result.className=cls;
    if(text!==undefined)result.textContent=String(text);
    return result;
  };
  function visible() {return !!el("page-desktop-live")&&!el("page-desktop-live").hidden&&!document.hidden;}
  function status(message,error=false) {
    const e=el("desktop-live-manager-status");
    if(e){e.textContent=message;e.dataset.error=error?"true":"false";}
  }

  // Permission indicators are informational, never a remote-control grant.
  // The only native input authority is a separately attended host approval.
  function renderStreamPermissions() {
    const active = stream.active && !!stream.token;
    const lan = active && stream.isLanDevice;
    const mouse = lan && stream.controllerScopes.mouse;
    const keyboard = lan && stream.controllerScopes.keyboard;
    const any = mouse || keyboard;
    if (!mouse) stream.pointer = null;
    stream.controlRequested = Boolean(any);
    const record = el("desktop-live-stream-record");
    const preset=el("desktop-live-record-preset");
    if(record){
      record.disabled=!active||lan||stream.recordingPending;
      record.textContent=stream.recording?"Stop recording":"Record window";
    }
    if(preset)preset.disabled=!active||lan||!!stream.recording||stream.recordingPending;
    const view=el("desktop-live-view-permission");
    const controller=el("desktop-live-controller-permission");
    const readiness=el("desktop-live-remote-readiness");
    const mouseStatus=el("desktop-live-mouse-status");
    const keyboardStatus=el("desktop-live-keyboard-status");
    const mouseButton=el("desktop-live-stream-request-control");
    const keyboardButton=el("desktop-live-stream-request-keyboard");
    const revokeMouse=el("desktop-live-stream-revoke-control");
    const revokeKeyboard=el("desktop-live-stream-revoke-keyboard");
    const toggle=el("desktop-live-stream-toggle-control");
    const takeover=el("desktop-live-stream-takeover");
    const inputBar=el("desktop-live-stream-input-bar");
    const viewport=el("desktop-live-stream-viewport");
    if(view){
      view.textContent=!active?"Not started":lan
        ?"Device-approved support session · View Only":"Host-approved local window · View Only";
      view.dataset.status=active?"active":"blocked";
    }
    if(controller){
      controller.textContent=!active?"No controller grant":!lan
        ?"Native PC remote input is not configured"
        :any?"Scoped host approval active · Android device consent also required"
          :"Separate mouse and keyboard approvals required";
      controller.dataset.status=any?"active":"blocked";
    }
    if(readiness){
      readiness.hidden=!active||lan;
      if(active&&!lan){
        const data=stream.remoteReadiness;
        const blockers=Array.isArray(data?.blockers)
          ?data.blockers.filter(x=>typeof x==="string").slice(0,4):[];
        readiness.textContent=data?.state==="NOT_CONFIGURED"
          ?"PC controller setup incomplete: "+blockers.join(" · ")
          :data?.inputAvailable===true
            ?"Private native controller backend reports input available; verify host approval before use."
            :"PC remote readiness has not been verified.";
      }
    }
    if(mouseStatus)mouseStatus.textContent=mouse?"Mouse: approved":"Mouse: not approved";
    if(keyboardStatus)keyboardStatus.textContent=keyboard?"Keyboard: approved":"Keyboard: not approved";
    if(mouseButton){
      mouseButton.disabled=!active||stream.controllerPending||mouse;
      mouseButton.textContent=lan?"Request Mouse":"Review Mouse Setup";
      mouseButton.title=lan?"Separate attended permission for taps, swipes, and element clicks"
        :"Native PC input requires trusted private viewer and attended input approval";
    }
    if(keyboardButton){
      keyboardButton.disabled=!active||stream.controllerPending||keyboard;
      keyboardButton.textContent=lan?"Request Keyboard":"Review Keyboard Setup";
      keyboardButton.title=lan?"Separate attended permission for text and navigation keys"
        :"Native PC input requires independently verified host controller";
    }
    if(revokeMouse)revokeMouse.disabled=!mouse||stream.controllerPending;
    if(revokeKeyboard)revokeKeyboard.disabled=!keyboard||stream.controllerPending;
    if(toggle){
      toggle.disabled=!lan||!any||stream.controllerPending;
      toggle.textContent=stream.controlEnabled?"Hide Input UI":"Show Input UI";
      toggle.classList.toggle("active",Boolean(lan&&stream.controlEnabled&&any));
    }
    if(takeover)takeover.disabled=!active||lan;
    if(inputBar)inputBar.hidden=!lan||!stream.controlEnabled||!any;
    const typeInput=el("desktop-live-stream-type-input");
    const typeSend=el("desktop-live-stream-type-send");
    if(typeInput)typeInput.disabled=!keyboard||stream.inputPending||stream.controllerPending;
    if(typeSend)typeSend.disabled=!keyboard||stream.inputPending||stream.controllerPending;
    document.querySelectorAll(".desktop-live-key-btn").forEach(btn=>{
      btn.disabled=!keyboard||stream.inputPending||stream.controllerPending;
    });
    if(viewport)viewport.classList.toggle("interactive",Boolean(lan&&stream.controlEnabled&&mouse));
  }

  async function refreshControlPermission() {
    if (!stream.active || !stream.isLanDevice || !stream.controlRequested) return;
    const id=stream.deviceId, generation=stream.generation;
    for(const kind of ["mouse","keyboard"]) {
      if(!stream.controllerScopes[kind])continue;
      try {
        const result=await window.__TAURI__?.core?.invoke?.("lan_support_action", {
          action:"control_status",payload:{deviceId:id,kind},
        });
        if(!stream.active||stream.deviceId!==id||stream.generation!==generation)return;
        if(result?.success!==true||result?.approved!==true||
           !Number.isSafeInteger(result.secondsRemaining)||
           result.secondsRemaining<1)throw Error("Scoped controller expired");
        stream.controllerSeconds=result.secondsRemaining;
      } catch {
        if(!stream.active||stream.deviceId!==id||stream.generation!==generation)return;
        stream.controllerScopes[kind]=false;
        if(kind==="mouse")stream.pointer=null;
        status(kind+" control expired or revoked; View Only remains active.",true);
      }
    }
    if(!stream.controllerScopes.mouse&&!stream.controllerScopes.keyboard)
      stream.controlEnabled=false;
    renderStreamPermissions();
  }

  function scheduleNextFrame() {
    if (!stream.active || !stream.token) return;
    if (stream.timer) {
      clearTimeout(stream.timer);
      cancelAnimationFrame(stream.timer);
      stream.timer = null;
    }
    const cfg = streamPresets[stream.quality] || streamPresets.ultra;
    const generation = stream.generation;
    const next = () => {if (stream.generation === generation) void fetchFrame();};
    if (cfg.intervalMs <= 20) {
      stream.timer = requestAnimationFrame(next);
    } else {
      stream.timer = setTimeout(next, cfg.intervalMs);
    }
  }

  async function fetchFrame() {
    if (!stream.active || !stream.token || stream.inFlight) return;
    if (!visible()) {
      await stopStream("Live stream paused: Tray window is hidden.");
      return;
    }
    stream.inFlight = true;
    const generation = stream.generation, token = stream.token;
    const deviceId = stream.deviceId, isLan = stream.isLanDevice;
    const cfg = streamPresets[stream.quality] || streamPresets.balanced;
    try {
      let frameData;
      if (isLan) {
        const call = window.__TAURI__?.core?.invoke;
        const res = await call("lan_support_action", {
          action: "screen",
          payload: { deviceId },
        });
        if (!res?.success) throw Error(res?.error || "Gagal mengambil frame screen dari LAN client");
        frameData = {
          success: true,
          jpeg: res.frame?.data || res.data,
          width: res.frame?.width || res.width,
          height: res.frame?.height || res.height,
        };
      } else {
        frameData = await invoke("frame", {
          token,
          codec: "jpeg",
          maxWidth: cfg.maxWidth,
          quality: cfg.quality,
          ...(stream.lastHash ? { knownHash: stream.lastHash } : {}),
        });
      }
      if (!stream.active || generation !== stream.generation || token !== stream.token ||
          deviceId !== stream.deviceId) return;
      if (frameData?.success!==true) throw Error(frameData?.error || "Frame capture denied.");

      const img = el("desktop-live-stream-img");
      const placeholder = el("desktop-live-stream-placeholder");
      const fpsPill = el("desktop-live-stream-fps");

      if (frameData.jpeg) {
        // Bounded payloads: the native Tray should never cache an unverified
        // unbounded image. The Android controller already caps its own frames.
        if (typeof frameData.jpeg!=="string" || frameData.jpeg.length<4 ||
            frameData.jpeg.length>(isLan?290_000:3_000_000) ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(frameData.jpeg) ||
            !Number.isSafeInteger(frameData.width) || frameData.width<1 ||
            frameData.width>(isLan?480:4096) ||
            !Number.isSafeInteger(frameData.height) || frameData.height<1 ||
            frameData.height>(isLan?1080:4096)) {
          throw Error("Frame payload or dimensions failed verification");
        }
        stream.lastFrameAt = Date.now();
        if (img) {
          img.src = "data:image/jpeg;base64," + frameData.jpeg;
          img.hidden = false;
        }
        if (placeholder) placeholder.hidden = true;
        if (frameData.hash) stream.lastHash = frameData.hash;
        stream.framesDelivered++;
        stream.fpsWindowCount++;
      }
      const now = performance.now();
      const elapsed = now - stream.fpsLastTime;
      if (elapsed >= 1000) {
        const fpsVal = ((stream.fpsWindowCount * 1000) / elapsed).toFixed(1);
        stream.currentFps = fpsVal;
        stream.fpsWindowCount = 0;
        stream.fpsLastTime = now;
        if (fpsPill) {
          const dims = (frameData.width && frameData.height) ? `${frameData.width}×${frameData.height}` : "";
          fpsPill.textContent = `${fpsVal} FPS` + (dims ? ` · ${dims}` : "");
        }
      }
    } catch (err) {
      if (generation === stream.generation)
        await stopStream("Stream ended: " + (err?.message || "Window identity changed or closed."));
      return;
    } finally {
      if (generation === stream.generation) {
        stream.inFlight = false;
        if (stream.active) scheduleNextFrame();
      }
    }
  }

  async function startStream(item, button) {
    if (stream.startPending) return;
    stream.startPending = true;
    try {
      if (stopOperation) await stopOperation;
      await startStreamOwned(item, button);
    } finally { stream.startPending = false; }
  }

  async function startStreamOwned(item, button) {
    if (stream.active) {
      await stopStream();
    }

    const isLan = item.kind === "lan-device" || item.id.startsWith("lan:");
    if (isLan && item.devicePlatform !== "android") {
      status("Windows LAN screen/input is not implemented in this transport. No controller permission is available.", true);
      return;
    }
    let pid = 0, nativeId = "", deviceId = "";
    if (isLan) {
      deviceId = item.id.slice(4);
      if (!deviceId) return;
    } else {
      const parts = (item.id || "").split(":");
      if (parts.length < 3 || parts[0] !== "native") return;
      pid = Number(parts[1]);
      nativeId = parts.slice(2).join(":");
      if (!Number.isSafeInteger(pid) || pid <= 0 || !nativeId) return;
    }

    stream.generation++;
    stream.pointer = null;
    stream.inputPending = false;
    stream.lastFrameAt = 0;
    const requestedGeneration = stream.generation;
    const panel = el("desktop-live-stream-panel");
    const titleEl = el("desktop-live-stream-title");
    const metaEl = el("desktop-live-stream-meta");
    const placeholder = el("desktop-live-stream-placeholder");
    const placeholderText = el("desktop-live-stream-placeholder-text");
    const img = el("desktop-live-stream-img");
    const fpsPill = el("desktop-live-stream-fps");
    const lanBanner = el("desktop-live-lan-banner");
    const lanUrlEl = el("desktop-live-lan-url");

    if (panel) panel.hidden = false;
    if (titleEl) titleEl.textContent = item.title || item.application || (isLan ? "LAN Screen" : "Native Window");
    if (metaEl) metaEl.textContent = isLan ? `LAN Device (${item.handle})` : `${item.application || "App"} (PID: ${pid})`;
    if (placeholder) placeholder.hidden = false;
    if (placeholderText) placeholderText.textContent = isLan ? "Connecting to LAN client screen projection…" : "Awaiting native OS confirmation dialog…";
    if (img) { img.src = ""; img.hidden = true; }
    if (fpsPill) fpsPill.textContent = "0.0 FPS";

    status(isLan ? ("Connecting to " + (item.title || "LAN device") + "…") : ("Prompting native OS confirmation for " + (item.title || item.application) + "…"));
    try {
      if (button) button.disabled = true;

      if (isLan) {
        const call = window.__TAURI__?.core?.invoke;
        // A previously connected support session already passed its device
        // approval. Do not open a duplicate session or bypass a new denial.
        const newlyOpened = item.status !== "controlled";
        if (newlyOpened) {
          const opened = await call("lan_support_action", { action: "open", payload: { deviceId } });
          if (!opened?.success) throw Error(opened?.error || "Device support session was not approved");
        }
        if (requestedGeneration !== stream.generation) {
          if (newlyOpened) {
            try { await call("lan_support_action", {action:"close",payload:{deviceId}}); } catch {}
          }
          return;
        }

        stream.active = true;
        stream.token = "lan-" + deviceId;
        stream.id = item.id;
        stream.title = item.title || "LAN Device";
        stream.application = item.application || "LAN Client";
        stream.isLanDevice = true;
        stream.devicePlatform = item.devicePlatform;
        stream.controlRequested = false;
        stream.controlEnabled = false;
        stream.controllerScopes = {mouse:false,keyboard:false};
        stream.controllerPending = false;
        stream.remoteReadiness = null;
        stream.deviceId = deviceId;
        stream.pid = 0;
        stream.nativeId = "";
        stream.lastHash = null;
        stream.framesDelivered = 0;
        stream.fpsWindowCount = 0;
        stream.fpsLastTime = performance.now();
        if (lanBanner) lanBanner.hidden = true;

        renderStreamPermissions();
        status("Approved LAN device viewer opened. Remote input still requires a separate request and device consent.");
        draw();
        scheduleNextFrame();
      } else {
        const result = await invoke("start", { pid, nativeId, consent: true });
        if (requestedGeneration !== stream.generation) {
          if (result?.token) {
            try { await invoke("stop", {token:result.token}); } catch {}
          }
          return;
        }
        if (!result?.token) throw Error("Stream consent was not granted.");

        stream.active = true;
        stream.token = result.token;
        stream.id = item.id;
        stream.title = item.title || item.application;
        stream.application = item.application;
        stream.pid = pid;
        stream.nativeId = nativeId;
        stream.isLanDevice = false;
        stream.devicePlatform = null;
        stream.controlRequested = false;
        stream.controlEnabled = false;
        stream.deviceId = "";
        stream.lastHash = null;
        stream.framesDelivered = 0;
        stream.fpsWindowCount = 0;
        stream.fpsLastTime = performance.now();

        // Query exact local Core operator readiness without exposing native
        // approval tokens or pretending a source file is an installed feature.
        try {
          const ready = await invoke("remote-status");
          stream.remoteReadiness = ready?.success===true ? ready : null;
        } catch { stream.remoteReadiness = null; }
        // Remote LAN HTTP viewing is disabled: screen frames require a
        // separately approved encrypted host/viewer transport.
        stream.lanUrl = "";
        if (lanUrlEl) lanUrlEl.textContent =
          "Remote viewing requires a separately approved private mTLS viewer.";
        if (lanBanner) lanBanner.hidden = true;

        renderStreamPermissions();
        status("Host-approved View Only preview active (5 min TTL). Remote controller remains separate.");
        draw();
        scheduleNextFrame();
      }
    } catch (err) {
      status("Live stream not started: " + (err?.message || "Denied or cancelled."), true);
      await stopStream();
    } finally {
      if (button) button.disabled = false;
    }
  }

  let recordingStatusPending=false;
  async function reconcileNativeRecording() {
    const current=stream.recording;
    if(!current||recordingStatusPending||stream.recordingPending||!visible())return;
    recordingStatusPending=true;
    try{
      const invokeNative=window.__TAURI__?.core?.invoke;
      if(typeof invokeNative!=="function")return;
      const result=await invokeNative("recordings_action",{
        action:"list",payload:{projectDirectory:current.projectDirectory},
      });
      if(!stream.recording||stream.recording.recordingId!==current.recordingId)return;
      const recording=Array.isArray(result?.recordings)
        ? result.recordings.find(item=>item.recordingId===current.recordingId) : null;
      if(recording && ["saved","failed","interrupted"].includes(recording.status)){
        stream.recording=null;
        renderStreamPermissions();
        status(recording.status==="saved"
          ? "Window recording finalized automatically; open Recordings to play or export."
          : "Recording ended unexpectedly. Review the project archive.",
          recording.status!=="saved");
      }
    }catch{
      // A temporary Core outage must not be interpreted as a successful stop.
    }finally{recordingStatusPending=false;}
  }
  async function toggleNativeRecording() {
    if(!stream.active||!stream.token||stream.isLanDevice||stream.recordingPending)return;
    const native=window.__TAURI__?.core?.invoke;
    if(typeof native!=="function"){status("Native Tray is required for recording.",true);return;}
    stream.recordingPending=true;renderStreamPermissions();
    try{
      if(stream.recording){
        const prior=stream.recording;
        const saved=await native("recordings_action",{
          action:"stop",payload:{projectDirectory:prior.projectDirectory,recordingId:prior.recordingId},
        });
        if(saved?.success===false||!["saved","failed"].includes(String(saved?.status)))
          throw Error("Recording finalization was not verified.");
        stream.recording=null;
        status(saved.status==="saved"?"Native window MP4 finalized inside the selected project.":
          "Recorder stopped with errors. Check Recording Manager.",saved.status!=="saved");
      }else{
        const token=stream.token;
        const selected=await native("recordings_action",{action:"pick-project",payload:null});
        if(!selected?.projectDirectory)return;
        if(!stream.active||stream.isLanDevice||stream.token!==token)
          throw Error("The previously approved preview is no longer active.");
        const videoPreset=el("desktop-live-record-preset")?.value||"standard";
        const begun=await native("recordings_action",{
          action:"start-native",payload:{
            previewToken:token,projectDirectory:selected.projectDirectory,videoPreset,
          },
        });
        if(begun?.status!=="recording"||!begun?.recordingId)
          throw Error("Recording start could not be verified.");
        stream.recording={
          recordingId:begun.recordingId,
          projectDirectory:begun.projectDirectory||selected.projectDirectory,
        };
        status("Recording authorized window · MP4 stored locally. Preview approval expires in five minutes.");
      }
    }catch(error){
      status("Recording: "+(error?.message||"Action denied."),true);
    }finally{stream.recordingPending=false;renderStreamPermissions();}
  }
  async function stopStream(reason) {
    if (stopOperation) return stopOperation;
    const operation = (async () => {
    if (stream.timer) {
      clearTimeout(stream.timer);
      cancelAnimationFrame(stream.timer);
      stream.timer = null;
    }
    const token = stream.token;
    const recording=stream.recording;
    // Fence stale network responses before any asynchronous recorder cleanup.
    stream.active = false;
    stream.generation++;
    stream.pointer = null;
    stream.inputPending = false;
    stream.lastFrameAt = 0;
    stream.inFlight = false;
    stream.recording=null;
    if(recording&&!stream.isLanDevice){
      try{
        await window.__TAURI__?.core?.invoke?.("recordings_action",{
          action:"stop",payload:{
            projectDirectory:recording.projectDirectory,recordingId:recording.recordingId,
          },
        });
      }catch{
        // Core will auto-finalize after the exact preview capability is revoked.
      }
    }
    stream.token = null;
    stream.id = null;
    stream.inFlight = false;
    stream.lastHash = null;
    const wasLanDevice = stream.isLanDevice;
    const previousDeviceId = stream.deviceId;
    stream.isLanDevice = false;
    stream.devicePlatform = null;
    stream.deviceId = "";
    const draft = el("desktop-live-stream-type-input");
    if (draft) draft.value = "";
    const previousScopes = {...stream.controllerScopes};
    stream.controlRequested = false;
    stream.controlEnabled = false;
    stream.controllerScopes = {mouse:false,keyboard:false};
    stream.controllerPending = false;
    stream.remoteReadiness = null;
    stream.controllerSeconds = 0;
    stream.lanUrl = "";

    const panel = el("desktop-live-stream-panel");
    if (panel) panel.hidden = true;
    const img = el("desktop-live-stream-img");
    if (img) { img.src = ""; img.hidden = true; }
    const lanBanner = el("desktop-live-lan-banner");
    if (lanBanner) lanBanner.hidden = true;

    const inputBar = el("desktop-live-stream-input-bar");
    if (inputBar) inputBar.hidden = true;
    const toggleBtn = el("desktop-live-stream-toggle-control");
    if (toggleBtn) {
      toggleBtn.textContent = "Show Input UI";
      toggleBtn.classList.remove("active");
      toggleBtn.disabled = true;
    }
    const viewport = el("desktop-live-stream-viewport");
    if (viewport) viewport.classList.remove("interactive");

    let controllerRevokeVerified = true;
    if(wasLanDevice&&previousDeviceId){
      for(const kind of ["mouse","keyboard"]){
        if(!previousScopes[kind])continue;
        try{
          const outcome=await window.__TAURI__?.core?.invoke?.("lan_support_action",{
            action:"control_revoke",payload:{deviceId:previousDeviceId,kind},
          });
          if(outcome?.success!==true||outcome?.approved!==false)
            throw Error("Scoped Core revoke unverified");
        }catch{controllerRevokeVerified=false;}
      }
    }
    if (token && !wasLanDevice) {
      try { await invoke("stop", { token }); } catch {}
    }
    renderStreamPermissions();
    if (!controllerRevokeVerified)
      status("Local control disabled. Core-wide revocation unverified; controller token expires automatically.",true);
    else if (reason) status(reason);
    draw();
    })();
    stopOperation = operation;
    try { return await operation; }
    finally { if (stopOperation === operation) stopOperation = null; }
  }

  function draw() {
    const outlet=el("desktop-live-list");
    if(!outlet)return;
    outlet.replaceChildren();
    const rows=state.items.filter(row=>state.filter==="all"||row.kind===state.filter);
    for(const [kind,text] of Object.entries(kinds)) {
      const button=el("desktop-live-filter-"+kind);
      if(button){
        const count=kind==="all"?state.items.length:state.items.filter(x=>x.kind===kind).length;
        button.replaceChildren(node("span","desktop-live-filter-label",text),
          node("span","desktop-live-filter-count",count));
        button.setAttribute("aria-pressed",String(state.filter===kind));
      }
    }
    if(!rows.length) {
      outlet.append(node("p","desktop-live-empty","No verified handles in this category. Refresh to rescan."));
      return;
    }
    for(const item of rows) {
      const card=node("article","desktop-live-item");
      card.dataset.kind=item.kind;
      const glyph=node("span","desktop-live-kind",
        item.kind==="native"?"APP":item.kind==="managed-cdp"?"CDP":item.kind==="lan-device"?"LAN":"DLG");
      glyph.setAttribute("aria-hidden","true");
      const info=node("div","desktop-live-information");
      const top=node("div","desktop-live-item-top");
      top.append(node("strong","desktop-live-item-title",item.title||"Untitled window"));
      const badge=node("span","desktop-live-item-state",item.status);
      badge.dataset.state=item.status;
      top.append(badge);
      const meta=node("p","desktop-live-item-meta",item.application+" · "+item.handle);
      info.append(top,meta);
      if(item.owner)info.append(node("p","desktop-live-owner","Agent: "+item.owner));
      // Separate read-only visibility from actual input authorization.
      if (item.access && typeof item.access === "object") {
        const meta=node("div","desktop-live-permission-meta");
        const viewLabel = {
          active:"Viewer: active", available:"Viewer: available",
          "device-approval-required":"Viewer: device approval",
          "not-supported":"Viewer: not supported",
        }[item.access.view] || "Viewer: unknown";
        const controlLabel = {
          "native-approval-required":"Controller: separate approval",
          "device-approval-required":"Controller: device consent",
          "agent-held":"Control: agent", "human-held":"Control: human",
          "not-supported":"Controller: not enabled",
        }[item.access.controller] || "Controller: unknown";
        meta.append(node("span","",viewLabel),node("span","",controlLabel));
        info.append(meta);
      }
      const actions=node("div","desktop-live-actions");

      if (item.kind === "native" || item.kind === "lan-device") {
        const isCurrentStreaming = stream.active && stream.id === item.id;
        const watch = node("button", "button " + (isCurrentStreaming ? "primary desktop-live-stream-active-btn" : "secondary") + " desktop-live-watch",
          isCurrentStreaming ? "Streaming…" : "Watch stream");
        watch.type = "button";
        watch.title = isCurrentStreaming ? "Live stream aktif" : item.kind === "lan-device" ? "Mulai live stream layar perangkat LAN" : "Mulai live stream pratinjau jendela native";
        if (isCurrentStreaming || (item.kind === "lan-device" && item.devicePlatform !== "android")) {
          watch.disabled = true;
          if (item.kind === "lan-device" && item.devicePlatform !== "android") {
            watch.textContent = "Viewer unavailable";
            watch.title = "Windows LAN Client has no verified screen capture/input implementation yet";
          }
        } else {
          watch.addEventListener("click", () => void startStream(item, watch));
        }
        actions.append(watch);
      }

      if(item.stopAction) {
        const stop=node("button","button secondary desktop-live-stop",
          item.stopAction==="takeover"?"Take Over":item.stopAction==="return-to-agent"?"Return to Agent":item.stopAction==="disconnect-profile"?"Disconnect profile":item.stopAction==="stop-delegate-tab"?"Stop tab session":"Stop session");
        stop.type="button";
        stop.title=item.impact||"Revoke session";
        stop.addEventListener("click",()=>void stopSession(item,stop));
        actions.append(stop);
      } else {
        const indicator=node("span","desktop-live-control-state",
          item.status==="available"?"Not controlled":"Unavailable");
        indicator.dataset.state=item.status==="available"?"idle":"unavailable";
        actions.append(indicator);
      }
      card.append(glyph,info,actions);
      outlet.append(card);
    }
  }
  async function refresh() {
    if(state.loading||!visible())return;
    state.loading=true;
    const btn=el("desktop-live-manager-refresh");if(btn)btn.disabled=true;
    status("Scanning host applications, managed CDP and Delegate tabs…");
    try {
      const data=await invoke("inventory");
      if(!data?.success||!Array.isArray(data.items))throw Error("Unavailable inventory");
      state.items=data.items;
      state.sources=data.sources||{};
      draw();
      const missing=Object.entries(state.sources).filter(([,v])=>v!=="ok").map(([k])=>k);
      status(state.items.length+" handles discovered"+(missing.length?". Unavailable: "+missing.join(", "):"."));
    } catch {
      state.items=[];
      draw();
      status("Cannot verify host inventory. No controls were enabled.",true);
    } finally {state.loading=false;if(btn)btn.disabled=false;}
  }
  async function stopSession(item,button) {
    if(button.disabled)return;
    if(item.stopAction==="disconnect-profile"&&
       !window.confirm("Disconnect the entire Chrome Delegate profile? Other tabs in this profile will lose agent access. Browser windows remain open."))return;
    if(item.stopAction==="return-to-agent"&&
       !window.confirm("Return this exact managed CDP target to the agent? Any active takeover reservation will keep it locked."))return;
    button.disabled=true;
    status("Revoking exact session authorization…");
    try{
      const data=await invoke("stop-handle",{
        id:item.id,
        ...(["takeover","return-to-agent","stop-delegate-tab"].includes(item.stopAction)?{expectedRevision:item.revision}:{}),
        ...(item.stopAction==="disconnect-profile"?{confirmProfile:true}:{}),
      });
      if(!data?.success||!data.stopped)throw Error("Session was already inactive");
      status(data.reason||"Session authorization revoked.");
      await refresh();
    }catch{status("Handoff was not verified. A human hold remains in place until explicitly released.",true);}
    finally{button.disabled=false;}
  }
  window.__superagentDesktopLiveRefresh=refresh;
  window.__superagentDesktopLiveStopStream=stopStream;
  function install() {
    for(const kind of Object.keys(kinds))el("desktop-live-filter-"+kind)?.addEventListener("click",()=>{
      state.filter=kind;draw();
    });
    el("desktop-live-manager-refresh")?.addEventListener("click",()=>void refresh());
    el("desktop-live-stream-stop")?.addEventListener("click",()=>void stopStream("Live stream stopped by operator."));
    el("desktop-live-stream-record")?.addEventListener("click",()=>void toggleNativeRecording());
    el("desktop-live-stream-quality")?.addEventListener("change",(e)=>{
      stream.quality=e.target?.value||"balanced";
      stream.lastHash=null;
    });

    el("desktop-live-stream-takeover")?.addEventListener("click", async () => {
      if (!stream.active || !stream.token) return;
      if (stream.isLanDevice) {
        status("Use the separately paired LAN Devices control workflow.", true);
        return;
      }
      const takeoverButton = el("desktop-live-stream-takeover");
      if (takeoverButton?.disabled) return;
      if (!window.confirm("Revoke agent control over this exact local window? The application stays open for physical human input.")) return;
      if (takeoverButton) takeoverButton.disabled = true;
      const id = "native:" + stream.pid + ":" + stream.nativeId;
      status("Requesting exact-session revocation through authenticated Tray…");
      try {
        const response = await invoke("stop-handle", { id });
        if (response?.success !== true || response?.stopped !== true) {
          throw Error("Session revocation was not verified");
        }
        await stopStream();
        await refresh();
        status("Human takeover verified: native agent session revoked. Use the host mouse and keyboard.");
      } catch (error) {
        status("Takeover unverified: " + (error?.message || "Unknown error"), true);
      } finally {
        if (takeoverButton && stream.active && !stream.isLanDevice) takeoverButton.disabled = false;
      }
    });

    async function requestScopedController(kind) {
      if(!["mouse","keyboard"].includes(kind)||!stream.active||!stream.token||
         stream.controllerScopes[kind]||stream.controllerPending)return;
      stream.controllerPending=true;
      const id=stream.deviceId,generation=stream.generation;
      renderStreamPermissions();
      try{
        if(stream.isLanDevice){
          const call=window.__TAURI__?.core?.invoke;
          if(typeof call!=="function")throw Error("Installed native Tray required");
          const result=await call("lan_support_action",{
            action:"control_request",payload:{deviceId:id,kind},
          });
          if(result?.success===true&&result?.approved===true&&
             (!stream.active||!stream.isLanDevice||stream.deviceId!==id||
              stream.generation!==generation)){
            try{await call("lan_support_action",{
              action:"control_revoke",payload:{deviceId:id,kind},
            });}catch{}
            throw Error("Stream ended during native approval");
          }
          if(!stream.active||!stream.isLanDevice||stream.deviceId!==id||
             stream.generation!==generation||result?.success!==true||result?.approved!==true||result?.kind!==kind||
             !Number.isSafeInteger(result.secondsRemaining)||result.secondsRemaining<1)
            throw Error("Independent "+kind+" controller not approved");
          stream.controllerScopes[kind]=true;
          // A host grant alone must not silently open the interactive input UI.
          // The operator separately uses "Show Input UI" to begin interaction.
          stream.controllerSeconds=result.secondsRemaining;
          status(kind+" approved by host; device must still accept each command.");
        }else{
          const result=await invoke("controller-review");
          if(result?.state!=="NOT_CONFIGURED"||result?.approved!==false||
             result?.inputEnabled!==false)throw Error("Native controller readiness unverified");
          status("PC native controller requires separately configured, attended mTLS transport.",true);
        }
      }catch(err){
        if(stream.active&&stream.deviceId===id&&stream.generation===generation){
          stream.controllerScopes[kind]=false;
          status(kind+" approval denied: "+(err?.message||"Host rejected"),true);
        }
      }finally{
        if(stream.generation===generation){
          stream.controllerPending=false;
          renderStreamPermissions();
        }
      }
    }

    async function revokeScopedController(kind) {
      if (!stream.active || !stream.isLanDevice || stream.controllerPending ||
          !["mouse","keyboard"].includes(kind) || !stream.controllerScopes[kind]) return;
      const id=stream.deviceId,generation=stream.generation;
      // Fail closed locally before the remote host has acknowledged revocation.
      stream.controllerPending=true;
      stream.controllerScopes[kind]=false;
      if (kind==="mouse") stream.pointer=null;
      renderStreamPermissions();
      try {
        const response=await window.__TAURI__?.core?.invoke?.("lan_support_action",{
          action:"control_revoke",payload:{deviceId:id,kind},
        });
        if (stream.generation!==generation || stream.deviceId!==id) return;
        if (response?.success!==true || response?.approved!==false)
          throw Error("Host did not confirm controller revocation");
        status(kind+" controller revoked; View Only remains active.");
      } catch(err) {
        if (stream.generation===generation)
          status(kind+" input disabled locally, Core revocation unverified: "+
            (err?.message||"Connection lost"),true);
      } finally {
        if(stream.generation===generation){
          stream.controllerPending=false;
          if(!stream.controllerScopes.mouse&&!stream.controllerScopes.keyboard)
            stream.controlEnabled=false;
          renderStreamPermissions();
        }
      }
    }
    el("desktop-live-stream-revoke-control")?.addEventListener("click",
      ()=>void revokeScopedController("mouse"));
    el("desktop-live-stream-revoke-keyboard")?.addEventListener("click",
      ()=>void revokeScopedController("keyboard"));
    el("desktop-live-stream-request-control")?.addEventListener("click",()=>void requestScopedController("mouse"));
    el("desktop-live-stream-request-keyboard")?.addEventListener("click",()=>void requestScopedController("keyboard"));

    el("desktop-live-stream-toggle-control")?.addEventListener("click", () => {
      if (!stream.active || !stream.isLanDevice || !stream.controlRequested) {
        status("Request device input tools separately from View Only first.", true);
        return;
      }
      stream.controlEnabled = !stream.controlEnabled;
      renderStreamPermissions();
      status(stream.controlEnabled
        ? "LAN input tools visible. Every command still requires on-device approval."
        : "LAN input tools hidden; no input will be dispatched.");
    });

    // Only approved Android LAN sessions accept touch, never native PC previews.
    function gesturePoint(event) {
      if (!stream.active || !stream.isLanDevice || !stream.controlEnabled ||
          !stream.controllerScopes.mouse || stream.inputPending || stream.controllerPending ||
          stream.lastFrameAt <= 0 || Date.now() - stream.lastFrameAt > 3000) return null;
      const img=el("desktop-live-stream-img");
      if(!img||img.hidden||!img.naturalWidth||!img.naturalHeight)return null;
      const rect=img.getBoundingClientRect();
      if(!rect.width||!rect.height)return null;
      const scale=Math.min(rect.width/img.naturalWidth,rect.height/img.naturalHeight);
      const w=img.naturalWidth*scale,h=img.naturalHeight*scale;
      const x=(event.clientX-rect.left-(rect.width-w)/2)/w;
      const y=(event.clientY-rect.top-(rect.height-h)/2)/h;
      if(![x,y].every(Number.isFinite)||x<0||x>1||y<0||y>1)return null;
      return {x:Number(x.toFixed(5)),y:Number(y.toFixed(5))};
    }
    const touchImage=el("desktop-live-stream-img");
    touchImage?.addEventListener("pointerdown",e=>{
      if(e.isPrimary===false||stream.pointer)return;
      const from=gesturePoint(e);
      if(!from)return;
      stream.pointer={from,pointerId:e.pointerId,startedAt:Date.now(),
        generation:stream.generation,deviceId:stream.deviceId};
      touchImage.setPointerCapture?.(e.pointerId);
    });
    touchImage?.addEventListener("pointercancel",()=>{stream.pointer=null;});
    touchImage?.addEventListener("lostpointercapture",()=>{stream.pointer=null;});
    touchImage?.addEventListener("pointerup",async e=>{
      const start=stream.pointer;
      stream.pointer=null;
      if(!start||start.pointerId!==e.pointerId||
         start.generation!==stream.generation||start.deviceId!==stream.deviceId)return;
      const end=gesturePoint(e);
      if(!end)return;
      const distance=Math.hypot(end.x-start.from.x,end.y-start.from.y);
      const command=distance>0.026
        ?{deviceId:start.deviceId,kind:"swipe",x:start.from.x,y:start.from.y,
          endX:end.x,endY:end.y,
          durationMs:Math.max(100,Math.min(1500,Date.now()-start.startedAt))}
        :{deviceId:start.deviceId,kind:"tap",x:end.x,y:end.y};
      stream.inputPending=true;
      renderStreamPermissions();
      try{
        const accepted=await window.__TAURI__?.core?.invoke?.("lan_support_action",{
          action:"input",payload:command,
        });
        if(start.generation!==stream.generation||start.deviceId!==stream.deviceId)return;
        if(accepted?.success !== true || accepted?.result?.ok !== true)
          throw Error("On-device touch permission denied");
        status("Device accepted one "+command.kind+" action.");
      }catch(err){
        if(start.generation===stream.generation)
          status("Android "+command.kind+" rejected: "+(err?.message||"Connection lost"),true);
      }finally{
        if(start.generation===stream.generation){
          stream.inputPending=false;
          renderStreamPermissions();
        }
      }
    });

    async function sendTrayType() {
      const input = el("desktop-live-stream-type-input");
      if (!input || !stream.active || !stream.controlEnabled || !stream.controllerScopes.keyboard ||
          stream.inputPending || stream.controllerPending) return;
      const text = input.value;
      if (!text || text.length > 160 || /[\u0000-\u001f\u007f]/.test(text)) {
        status("Text must be 1-160 characters without control characters.",true);
        return;
      }
      if (stream.isLanDevice) {
        const call = window.__TAURI__?.core?.invoke;
        const generation = stream.generation, deviceId = stream.deviceId;
        stream.inputPending = true;
        renderStreamPermissions();
        try {
          const accepted = await call("lan_support_action", {
            action: "input",
            payload: { deviceId, kind: "text", text },
          });
          if (generation !== stream.generation || deviceId !== stream.deviceId) return;
          if (accepted?.success !== true || accepted?.result?.ok !== true)
            throw Error("Device did not approve text input");
          input.value = "";
          status("Device accepted one text input.");
        } catch (err) {
          if (generation === stream.generation)
            status("Gagal mengirim teks ke perangkat LAN: " + (err?.message || "Koneksi terputus"), true);
        } finally {
          if (generation === stream.generation) {
            stream.inputPending = false;
            renderStreamPermissions();
          }
        }
        return;
      }
      status("Remote native typing requires separately attended controller approval.", true);
    }
    el("desktop-live-stream-type-send")?.addEventListener("click", () => void sendTrayType());
    el("desktop-live-stream-type-input")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void sendTrayType(); }
    });

    document.querySelectorAll(".desktop-live-key-btn").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!stream.active || !stream.controlEnabled || !stream.controllerScopes.keyboard ||
            stream.inputPending || stream.controllerPending) return;
        const key = btn.dataset.key;
        if (!key) return;
        if (stream.isLanDevice) {
          const call = window.__TAURI__?.core?.invoke;
          const androidKind = key === "BACK" ? "back" : key === "HOME" ? "home" : key === "RECENTS" ? "recents" : null;
          if (androidKind) {
            const generation = stream.generation, deviceId = stream.deviceId;
            stream.inputPending = true;
            renderStreamPermissions();
            try {
              const accepted = await call("lan_support_action", {
                action: "input",
                payload: { deviceId, kind: androidKind },
              });
              if (generation !== stream.generation || deviceId !== stream.deviceId) return;
              if (accepted?.success !== true || accepted?.result?.ok !== true)
                throw Error("Device did not approve navigation");
              status("Device accepted one navigation action: " + androidKind);
            } catch (err) {
              if (generation === stream.generation)
                status("Gagal kirim navigasi: " + (err?.message || "Error"), true);
            } finally {
              if (generation === stream.generation) {
                stream.inputPending = false;
                renderStreamPermissions();
              }
            }
          }
          return;
        }
        status("Remote native keys require separately attended controller approval.", true);
      });
    });
    el("desktop-live-lan-copy")?.addEventListener("click",async()=>{
      if(stream.lanUrl){
        try{
          await navigator.clipboard.writeText(stream.lanUrl);
          status("Link LAN stream disalin ke clipboard!");
        }catch{
          status("Gagal menyalin link LAN stream.",true);
        }
      }
    });
    window.addEventListener("beforeunload",()=>{
      if(stream.token && !stream.isLanDevice)void invoke("stop",{token:stream.token});
      if(stream.isLanDevice&&stream.deviceId){
        for(const kind of ["mouse","keyboard"]){
          if(stream.controllerScopes[kind])void window.__TAURI__?.core?.invoke?.(
            "lan_support_action",{action:"control_revoke",payload:{deviceId:stream.deviceId,kind}});
        }
      }
    });
    if(state.poll)clearInterval(state.poll);
    state.poll=setInterval(()=>{if(visible()){void refresh();void refreshControlPermission();}},15000);
    setInterval(()=>{if(visible())void reconcileNativeRecording();},3000);
    document.addEventListener("visibilitychange",()=>{
      if(visible())void refresh();
      else if(stream.active)void stopStream("Stream auto-paused: Tray window is hidden.");
    });
    renderStreamPermissions();
    if(visible())void refresh();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
})();