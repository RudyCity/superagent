"use strict";
/* Hallmark · component: management table · genre: modern-minimal · theme: inherited
 * states: default · hover · focus · active · disabled · loading · error · success
 */
(function () {
  const el = id => document.getElementById(id);
  const kinds = Object.freeze({ all:"All screens", native:"Applications",
    "managed-cdp":"Chrome CDP", "cdp-delegate":"CDP Delegate" });
  const state = {items:[],sources:{},filter:"all",loading:false,poll:null};
  const streamPresets = Object.freeze({
    balanced: { maxWidth: 1280, quality: 65, intervalMs: 250 },
    detail: { maxWidth: 1920, quality: 80, intervalMs: 150 },
    save: { maxWidth: 768, quality: 50, intervalMs: 500 },
  });
  const stream = {
    active: false,
    token: null,
    id: null,
    title: "",
    application: "",
    pid: 0,
    nativeId: "",
    quality: "balanced",
    lastHash: null,
    timer: null,
    inFlight: false,
    framesDelivered: 0,
    fpsWindowCount: 0,
    fpsLastTime: 0,
    currentFps: "0.0",
    lanUrl: "",
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

  function scheduleNextFrame() {
    if (!stream.active || !stream.token) return;
    if (stream.timer) clearTimeout(stream.timer);
    const cfg = streamPresets[stream.quality] || streamPresets.balanced;
    stream.timer = setTimeout(fetchFrame, cfg.intervalMs);
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
      const frameData = await invoke("frame", {
        token: stream.token,
        codec: "jpeg",
        maxWidth: cfg.maxWidth,
        quality: cfg.quality,
        ...(stream.lastHash ? { knownHash: stream.lastHash } : {}),
      });
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
    const parts = (item.id || "").split(":");
    if (parts.length < 3 || parts[0] !== "native") return;
    const pid = Number(parts[1]);
    const nativeId = parts.slice(2).join(":");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !nativeId) return;

    if (stream.active) {
      await stopStream();
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
    if (titleEl) titleEl.textContent = item.title || item.application || "Native Window";
    if (metaEl) metaEl.textContent = (item.application || "App") + " (PID: " + pid + ")";
    if (placeholder) placeholder.hidden = false;
    if (placeholderText) placeholderText.textContent = "Awaiting native OS confirmation dialog…";
    if (img) { img.src = ""; img.hidden = true; }
    if (fpsPill) fpsPill.textContent = "0.0 FPS";

    status("Prompting native OS confirmation for " + (item.title || item.application) + "…");
    try {
      if (button) button.disabled = true;
      const result = await invoke("start", { pid, nativeId, consent: true });
      if (!result?.token) throw Error("Stream consent was not granted.");

      stream.active = true;
      stream.token = result.token;
      stream.id = item.id;
      stream.title = item.title || item.application;
      stream.application = item.application;
      stream.pid = pid;
      stream.nativeId = nativeId;
      stream.lastHash = null;
      stream.framesDelivered = 0;
      stream.fpsWindowCount = 0;
      stream.fpsLastTime = performance.now();

      // Configure LAN streaming info
      const corePort = window.__SUPERAGENT_CORE_PORT || 6789;
      const hostIp = window.__SUPERAGENT_LAN_IP || location.hostname || "127.0.0.1";
      stream.lanUrl = `http://${hostIp}:${corePort}/api/desktop/live/lan-preview?token=${result.token}`;
      if (lanUrlEl) lanUrlEl.textContent = stream.lanUrl;
      if (lanBanner) lanBanner.hidden = false;

      status("Live stream active for " + (item.title || item.application) + " (5 min TTL).");
      draw();
      scheduleNextFrame();
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
      stream.timer = null;
    }
    const token = stream.token;
    stream.active = false;
    stream.token = null;
    stream.id = null;
    stream.inFlight = false;
    stream.lastHash = null;

    const panel = el("desktop-live-stream-panel");
    if (panel) panel.hidden = true;
    const img = el("desktop-live-stream-img");
    if (img) { img.src = ""; img.hidden = true; }
    const lanBanner = el("desktop-live-lan-banner");
    if (lanBanner) lanBanner.hidden = true;

    if (token) {
      try { await invoke("stop", { token }); } catch {}
    }
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
        item.kind==="native"?"APP":item.kind==="managed-cdp"?"CDP":"DLG");
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
      const actions=node("div","desktop-live-actions");

      if (item.kind === "native") {
        const isCurrentStreaming = stream.active && stream.id === item.id;
        const watch = node("button", "button " + (isCurrentStreaming ? "primary desktop-live-stream-active-btn" : "secondary") + " desktop-live-watch",
          isCurrentStreaming ? "Streaming…" : "Watch stream");
        watch.type = "button";
        watch.title = isCurrentStreaming ? "Live stream aktif" : "Mulai live stream pratinjau jendela native";
        if (isCurrentStreaming) {
          watch.disabled = true;
        } else {
          watch.addEventListener("click", () => void startStream(item, watch));
        }
        actions.append(watch);
      }

      if(item.stopAction) {
        const stop=node("button","button secondary desktop-live-stop",
          item.stopAction==="takeover"?"Take over":item.stopAction==="disconnect-profile"?"Disconnect profile":item.stopAction==="stop-delegate-tab"?"Stop tab session":"Stop session");
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
    button.disabled=true;
    status("Revoking exact session authorization…");
    try{
      const data=await invoke("stop-handle",{
        id:item.id,
        ...(["takeover","stop-delegate-tab"].includes(item.stopAction)?{expectedRevision:item.revision}:{}),
        ...(item.stopAction==="disconnect-profile"?{confirmProfile:true}:{}),
      });
      if(!data?.success||!data.stopped)throw Error("Session was already inactive");
      status(data.reason||"Session authorization revoked.");
      await refresh();
    }catch{status("Stop was not confirmed. Refresh the exact handle and retry.",true);}
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