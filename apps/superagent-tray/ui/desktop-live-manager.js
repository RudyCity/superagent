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
    isLanDevice: false,
    deviceId: "",
  };

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
    const isLan = active && stream.isLanDevice;
    const view = el("desktop-live-view-permission");
    const controller = el("desktop-live-controller-permission");
    const request = el("desktop-live-stream-request-control");
    const toggle = el("desktop-live-stream-toggle-control");
    const takeover = el("desktop-live-stream-takeover");
    const inputBar = el("desktop-live-stream-input-bar");
    const viewport = el("desktop-live-stream-viewport");
    if (view) {
      view.textContent = !active ? "Not started" :
        isLan ? "Device-approved support session · View Only" :
        "Host-approved local window · View Only";
      view.dataset.status = active ? "active" : "blocked";
    }
    if (controller) {
      controller.textContent = !active ? "No controller grant" :
        !isLan ? "Native remote input unavailable · separate approval required" :
        !stream.controlRequested ? "Device input permission not requested" :
        stream.controlEnabled ? "Input UI open · device must authorize every action" :
        "Input UI paused · device consent remains mandatory";
      controller.dataset.status = "blocked";
    }
    if (request) {
      request.disabled = !active || stream.controlRequested;
      request.title = !active ? "Start a separately approved viewer first" :
        isLan ? "Request access to the on-device input controls, without automatic approval" :
        "Review required host-native controller approval; no input token is granted";
    }
    if (toggle) {
      toggle.disabled = !isLan || !stream.controlRequested;
      toggle.textContent = stream.controlEnabled ? "Hide Input UI" : "Show Input UI";
      toggle.classList.toggle("active", Boolean(isLan && stream.controlEnabled));
    }
    if (takeover) takeover.disabled = !active || isLan;
    if (inputBar) inputBar.hidden = !isLan || !stream.controlEnabled;
    if (viewport) viewport.classList.toggle("interactive", Boolean(isLan && stream.controlEnabled));
  }

  function scheduleNextFrame() {
    if (!stream.active || !stream.token) return;
    if (stream.timer) {
      clearTimeout(stream.timer);
      cancelAnimationFrame(stream.timer);
      stream.timer = null;
    }
    const cfg = streamPresets[stream.quality] || streamPresets.ultra;
    if (cfg.intervalMs <= 20) {
      stream.timer = requestAnimationFrame(() => void fetchFrame());
    } else {
      stream.timer = setTimeout(fetchFrame, cfg.intervalMs);
    }
  }

  async function fetchFrame() {
    if (!stream.active || !stream.token || stream.inFlight) return;
    if (!visible()) {
      await stopStream("Live stream paused: Tray window is hidden.");
      return;
    }
    stream.inFlight = true;
    const cfg = streamPresets[stream.quality] || streamPresets.balanced;
    try {
      let frameData;
      if (stream.isLanDevice) {
        const call = window.__TAURI__?.core?.invoke;
        const res = await call("lan_support_action", {
          action: "screen",
          payload: { deviceId: stream.deviceId },
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
          token: stream.token,
          codec: "jpeg",
          maxWidth: cfg.maxWidth,
          quality: cfg.quality,
          ...(stream.lastHash ? { knownHash: stream.lastHash } : {}),
        });
      }
      if (!stream.active) return;
      if (!frameData?.success && frameData?.error) throw Error(frameData.error);

      const img = el("desktop-live-stream-img");
      const placeholder = el("desktop-live-stream-placeholder");
      const fpsPill = el("desktop-live-stream-fps");

      if (frameData.jpeg) {
        if (img) {
          img.src = "data:image/jpeg;base64," + frameData.jpeg;
          img.hidden = false;
        }
        if (placeholder) placeholder.hidden = true;
        if (frameData.hash) stream.lastHash = frameData.hash;
      }

      stream.framesDelivered++;
      stream.fpsWindowCount++;
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
      await stopStream("Stream ended: " + (err?.message || "Window identity changed or closed."));
      return;
    } finally {
      stream.inFlight = false;
      if (stream.active) scheduleNextFrame();
    }
  }

  async function startStream(item, button) {
    if (stream.active) {
      await stopStream();
    }

    const isLan = item.kind === "lan-device" || item.id.startsWith("lan:");
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
        const opened = await call("lan_support_action", { action: "open", payload: { deviceId } });
        if (!opened?.success) throw Error(opened?.error || "Device support session was not approved");

        stream.active = true;
        stream.token = "lan-" + deviceId;
        stream.id = item.id;
        stream.title = item.title || "LAN Device";
        stream.application = item.application || "LAN Client";
        stream.isLanDevice = true;
        stream.controlRequested = false;
        stream.controlEnabled = false;
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
        if (!result?.token) throw Error("Stream consent was not granted.");

        stream.active = true;
        stream.token = result.token;
        stream.id = item.id;
        stream.title = item.title || item.application;
        stream.application = item.application;
        stream.pid = pid;
        stream.nativeId = nativeId;
        stream.isLanDevice = false;
        stream.controlRequested = false;
        stream.controlEnabled = false;
        stream.deviceId = "";
        stream.lastHash = null;
        stream.framesDelivered = 0;
        stream.fpsWindowCount = 0;
        stream.fpsLastTime = performance.now();

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

  async function stopStream(reason) {
    if (stream.timer) {
      clearTimeout(stream.timer);
      cancelAnimationFrame(stream.timer);
      stream.timer = null;
    }
    const token = stream.token;
    stream.active = false;
    stream.token = null;
    stream.id = null;
    stream.inFlight = false;
    stream.lastHash = null;
    const wasLanDevice = stream.isLanDevice;
    stream.isLanDevice = false;
    stream.deviceId = "";
    stream.controlRequested = false;
    stream.controlEnabled = false;
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

    if (token && !wasLanDevice) {
      try { await invoke("stop", { token }); } catch {}
    }
    renderStreamPermissions();
    if (reason) status(reason);
    draw();
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
        if (isCurrentStreaming) {
          watch.disabled = true;
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

    el("desktop-live-stream-toggle-control")?.addEventListener("click", () => {
      if (!stream.active) return;
      if (!stream.isLanDevice) {
        status("Native previews are view-only; input requires separately attended approval.", true);
        return;
      }
      stream.controlEnabled = !stream.controlEnabled;
      const btn = el("desktop-live-stream-toggle-control");
      const inputBar = el("desktop-live-stream-input-bar");
      const viewport = el("desktop-live-stream-viewport");
      if (btn) {
        btn.textContent = stream.controlEnabled ? "Control: ON" : "Control: OFF";
        btn.classList.toggle("active", stream.controlEnabled);
      }
      if (inputBar) inputBar.hidden = !stream.controlEnabled;
      if (viewport) viewport.classList.toggle("interactive", stream.controlEnabled);
      status(stream.controlEnabled ? "Mode Kontrol Aktif: Klik pada stream atau ketik teks untuk mengontrol jendela." : "Mode Kontrol Dimatikan.");
    });

    el("desktop-live-stream-img")?.addEventListener("click", async (e) => {
      if (!stream.controlEnabled || !stream.active) return;
      const img = el("desktop-live-stream-img");
      if (!img || img.clientWidth <= 0 || img.clientHeight <= 0) return;
      const relX = Math.max(0, Math.min(1, e.offsetX / img.clientWidth));
      const relY = Math.max(0, Math.min(1, e.offsetY / img.clientHeight));
      if (stream.isLanDevice) {
        const call = window.__TAURI__?.core?.invoke;
        try {
          await call("lan_support_action", {
            action: "input",
            payload: { deviceId: stream.deviceId, kind: "tap", x: relX, y: relY },
          });
        } catch (err) {
          status("Gagal tap ke perangkat LAN: " + (err?.message || "Koneksi terputus"), true);
        }
        return;
      }
      status("Remote native clicks require separately attended controller approval.", true);
    });

    async function sendTrayType() {
      const input = el("desktop-live-stream-type-input");
      if (!input || !stream.active) return;
      const text = input.value;
      if (!text) return;
      if (stream.isLanDevice) {
        const call = window.__TAURI__?.core?.invoke;
        try {
          await call("lan_support_action", {
            action: "input",
            payload: { deviceId: stream.deviceId, kind: "text", text },
          });
          input.value = "";
          status("Teks berhasil dikirim ke perangkat LAN.");
        } catch (err) {
          status("Gagal mengirim teks ke perangkat LAN: " + (err?.message || "Koneksi terputus"), true);
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
        if (!stream.active) return;
        const key = btn.dataset.key;
        if (!key) return;
        if (stream.isLanDevice) {
          const call = window.__TAURI__?.core?.invoke;
          const androidKind = key === "ESCAPE" ? "back" : key === "SPACE" ? "home" : key === "TAB" ? "recents" : null;
          if (androidKind) {
            try {
              await call("lan_support_action", {
                action: "input",
                payload: { deviceId: stream.deviceId, kind: androidKind },
              });
              status(`Aksi navigasi ${androidKind} terkirim ke perangkat LAN.`);
            } catch (err) {
              status("Gagal kirim navigasi: " + (err?.message || "Error"), true);
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
      if(stream.token)void invoke("stop",{token:stream.token});
    });
    if(state.poll)clearInterval(state.poll);
    state.poll=setInterval(()=>{if(visible())void refresh();},15000);
    document.addEventListener("visibilitychange",()=>{
      if(visible())void refresh();
      else if(stream.active)void stopStream("Stream auto-paused: Tray window is hidden.");
    });
    if(visible())void refresh();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install);
  else install();
})();