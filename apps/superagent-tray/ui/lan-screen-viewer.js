"use strict";
/**
 * Schema-first Android LAN viewer:
 * - Polls a bounded, privacy-reduced Accessibility tree, NOT JPEG frames.
 * - When unchanged the device returns only {version, revision, changed:false}.
 * - Semantic buttons use element ID + revision; stale actions fail closed.
 * - A single screenshot is fetched only on explicit user fallback.
 * All data is transient in the WebView; no storage, HTTP URLs or OCR.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const notifyScreen = (kind, message) => window.TrayFeedback?.notify({
    kind, message, scope: "lan-devices",
  });
  const viewer = {
    running: false, generation: 0, id: null, hasFrame: false, hasSchema: false,
    schemaRevision: 0, nodes: [], origin: null, scopes:{mouse:false,keyboard:false},approvalPending:false,
  };
  const getTarget = () => {
    const d = window.__superagentLanGetSelected?.();
    return d && d.platform === "android" && d.connected ? d : null;
  };
  const invoke = (action, payload) => {
    const native = window.__TAURI__?.core?.invoke;
    if (typeof native !== "function") throw Error("SuperAgent Tray native runtime unavailable.");
    return native("lan_support_action", { action, payload });
  };
  function status(value) {
    if ($("lan-screen-status")) $("lan-screen-status").textContent = String(value).slice(0, 120);
  }
  function schemaStatus(value) {
    if ($("lan-schema-status")) $("lan-schema-status").textContent = String(value).slice(0, 160);
  }
  function controls() {
    const target=getTarget();
    const eligible=Boolean(target&&viewer.running&&target.id===viewer.id);
    const mouse=eligible&&viewer.scopes.mouse;
    const keyboard=eligible&&viewer.scopes.keyboard;
    const control={
      "lan-screen-request-control":!eligible||mouse||viewer.approvalPending,
      "lan-screen-revoke-control":!mouse,
      "lan-screen-request-keyboard":!eligible||keyboard||viewer.approvalPending,
      "lan-screen-revoke-keyboard":!keyboard,
    };
    for(const [id,disabled] of Object.entries(control))
      if($(id))$(id).disabled=disabled;
    if($("lan-screen-start"))$("lan-screen-start").disabled=viewer.running||!target;
    if($("lan-screen-stop"))$("lan-screen-stop").disabled=!viewer.running;
    if($("lan-screen-capture"))$("lan-screen-capture").disabled=!eligible;
    if($("lan-screen-controller-status"))
      $("lan-screen-controller-status").textContent =
        "Mouse: "+(mouse?"approved":"not approved")+
        " · Keyboard: "+(keyboard?"approved":"not approved")+
        " · Android must still accept every command";
    const list=$("lan-schema-list");
    if(list)[...list.children].forEach((button,i)=>{
      const node=viewer.nodes[i];
      button.disabled=!mouse||!node||!node.clickable||!node.enabled;
    });
    for(const id of ["lan-screen-back","lan-screen-home","lan-screen-recents",
       "lan-screen-send-text","lan-screen-text"])
      if($(id))$(id).disabled=!keyboard||(!viewer.hasSchema&&!viewer.hasFrame);
    if($("lan-screen-disconnect"))$("lan-screen-disconnect").disabled=!target;
  }
  function clearScreenshot() {
    viewer.hasFrame = false;
    const img = $("lan-screen-image");
    if (img) { img.src = ""; img.hidden = true; }
  }
  function stop(message = "Schema-first viewer stopped") {
    const oldId=viewer.id;
    for(const kind of ["mouse","keyboard"]){
      if(oldId&&viewer.scopes[kind]){
        void invoke("control_revoke",{deviceId:oldId,kind}).catch(()=>{
          status(kind+" local control disabled; Core revoke unverified (lease expires).");
        });
      }
    }
    viewer.scopes={mouse:false,keyboard:false};
    viewer.approvalPending=false;
    viewer.running=false;
    viewer.generation++;
    viewer.id=null;
    viewer.origin=null;
    viewer.hasSchema=false;
    viewer.schemaRevision=0;
    viewer.nodes=[];
    clearScreenshot();
    $("lan-schema-list")?.replaceChildren();
    if($("lan-screen-placeholder")){
      $("lan-screen-placeholder").hidden=false;
      $("lan-screen-placeholder").textContent=message;
    }
    schemaStatus("Schema stopped");
    status("Screen off");
    controls();
  }

  function validNode(node) {
    return node && typeof node.id === "string"
      && /^0(?:[.]\d{1,2}){0,12}$/.test(node.id)
      && typeof node.role === "string" && /^[a-z-]{1,24}$/.test(node.role)
      && typeof node.clickable === "boolean"
      && typeof node.enabled === "boolean"
      && node.bounds && ["x", "y", "w", "h"].every((key) =>
        typeof node.bounds[key] === "number" && Number.isFinite(node.bounds[key])
        && node.bounds[key] >= 0 && node.bounds[key] <= 1);
  }

  function renderSchema(schema) {
    const list = $("lan-schema-list");
    if (!list) return;
    const nodes = schema.nodes.filter(validNode).slice(0, 96);
    viewer.nodes = nodes;
    viewer.hasSchema = true;
    viewer.schemaRevision = schema.revision;
    const rows = nodes.map((node) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lan-schema-node";
      const role = document.createElement("span");
      role.textContent = (node.resource || node.role) + " · " + node.role;
      const meta = document.createElement("span");
      meta.className = "lan-schema-id";
      meta.textContent = node.id + (node.clickable ? " · tap" : " · view");
      button.appendChild(role);
      button.appendChild(meta);
      button.disabled = !viewer.scopes.mouse || !node.clickable || !node.enabled;
      const currentRevision = schema.revision;
      button.addEventListener("click", () => {
        if (!viewer.running || viewer.schemaRevision !== currentRevision
          || !node.clickable || !node.enabled) return;
        void clickElement(currentRevision, node.id);
      });
      return button;
    });
    list.replaceChildren(...rows);
    controls();
    schemaStatus("UI revision " + schema.revision + " · " + nodes.length
      + " elements" + (schema.truncated ? " · capped" : "") + " · text values hidden");
  }

  async function clickElement(revision, elementId) {
    const target = getTarget();
    if (!viewer.running || !viewer.scopes.mouse || !target || target.id !== viewer.id
      || viewer.schemaRevision !== revision) return;
    try {
      const result = await invoke("element", { deviceId: target.id, kind: "click", elementId, revision });
      if (!result?.success || !result?.result?.ok) throw Error("Element no longer actionable or controller denied");
      status("Semantic click accepted · no screenshot needed");
      viewer.schemaRevision = 0; // Refresh after interaction; reject stale clicks locally.
      viewer.hasSchema = false;
      controls();
    } catch {
      status("Element stale or remote input disabled · refresh schema");
      viewer.schemaRevision = 0;
      viewer.hasSchema = false;
      controls();
    }
  }

  async function pollSchema(generation, failures = 0) {
    if (!viewer.running || viewer.generation !== generation) return;
    const target = getTarget();
    if (!target || target.id !== viewer.id) {
      stop("Approved Android session ended or device selection changed.");
      return;
    }
    if ($("page-lan-devices")?.hidden || document.visibilityState === "hidden") {
      setTimeout(() => pollSchema(generation, failures), 1100);
      return;
    }
    let nextFailures = failures;
    try {
      const result = await invoke("schema", {
        deviceId: target.id, knownRevision: viewer.schemaRevision,
      });
      if (!viewer.running || viewer.generation !== generation) return;
      const schema = result?.schema;
      if (!result?.success || !schema || schema.version !== 1
        || !Number.isSafeInteger(schema.revision) || schema.revision < 1
        || typeof schema.changed !== "boolean") throw Error("Invalid UI schema");
      if (schema.changed) {
        if (!Array.isArray(schema.nodes) || schema.nodes.length > 96
          || schema.nodes.some((n) => !validNode(n))) throw Error("Malformed UI elements");
        const previous = viewer.schemaRevision;
        renderSchema(schema);
        if (previous && previous !== schema.revision) {
          // A screenshot is always an outdated fallback after a UI revision.
          clearScreenshot();
          if ($("lan-screen-placeholder")) $("lan-screen-placeholder").hidden = false;
        }
      } else if (schema.revision !== viewer.schemaRevision || !viewer.hasSchema) {
        throw Error("Unrecognized delta revision");
      }
      nextFailures = 0;
      status("Semantic mode · no screenshot processing");
      controls();
    } catch {
      if (!viewer.running || viewer.generation !== generation) return;
      nextFailures++;
      schemaStatus(nextFailures >= 3
        ? "Semantic tree unavailable. Use the manual screenshot fallback if the owner approved capture."
        : "Waiting for Android Accessibility schema...");
      if (nextFailures > 6) nextFailures = 3; // Never auto-trigger screenshots or hidden retries.
    }
    setTimeout(() => pollSchema(generation, nextFailures), nextFailures ? 1600 : 400);
  }

  function start() {
    const target = getTarget();
    if (!target || viewer.running) return;
    if (!window.confirm("Use Android Accessibility UI schema instead of repeated screenshots? The phone owner must approve the LAN session, system screen capture, and separate remote touch permission.")) return;
    viewer.running = true;
    viewer.scopes={mouse:false,keyboard:false};
    viewer.approvalPending=false;
    viewer.id = target.id;
    viewer.generation++;
    viewer.hasSchema = false;
    viewer.schemaRevision = 0;
    clearScreenshot();
    status("Requesting privacy-reduced UI schema");
    schemaStatus("Waiting for approved Android Accessibility...");
    controls();
    notifyScreen("info", "Waiting for approved Android UI schema. Sharing is not active yet.");
    void pollSchema(viewer.generation);
  }

  async function requestController(kind) {
    if(!["mouse","keyboard"].includes(kind)||viewer.approvalPending)return;
    const target=getTarget();
    if(!viewer.running||viewer.scopes[kind]||!target||target.id!==viewer.id)return;
    viewer.approvalPending=true;
    controls();
    schemaStatus("Requesting separate "+kind+" permission from native host...");
    try{
      const result=await invoke("control_request",{deviceId:target.id,kind});
      if(result?.success===true&&result?.approved===true&&
         (!viewer.running||viewer.id!==target.id)){
        try{await invoke("control_revoke",{deviceId:target.id,kind});}catch{}
        throw Error("Viewer ended during native approval");
      }
      if(!viewer.running||viewer.id!==target.id||result?.success!==true||
         result?.approved!==true||result?.kind!==kind||
         !Number.isSafeInteger(result.secondsRemaining)||result.secondsRemaining<1)
        throw Error("Native "+kind+" permission denied");
      viewer.scopes[kind]=true;
      status(kind+" approved by host; Android input consent still required.");
      notifyScreen("success",kind+" approved by native host for up to two minutes.");
    }catch{
      viewer.scopes[kind]=false;
      status(kind+" not approved. View Only remains available.");
      notifyScreen("warning",kind+" controller permission was not granted.");
    }finally{
      viewer.approvalPending=false;
      controls();
    }
  }

  async function revokeController(kind) {
    if(!["mouse","keyboard"].includes(kind))return;
    const id=viewer.id;
    viewer.scopes[kind]=false;
    controls();
    if(!id){status(kind+" local input disabled.");return;}
    try{
      const result=await invoke("control_revoke",{deviceId:id,kind});
      if(result?.success!==true||result?.approved!==false)
        throw Error("Core revoke unverified");
      status(kind+" revoked in native Tray and Core. View Only remains.");
    }catch{
      status(kind+" local input disabled; Core revoke unverified. Lease expires automatically.");
      notifyScreen("warning",kind+" Core revoke unverified; no more local commands.");
    }
  }

  async function refreshController() {
    if(!viewer.running||!viewer.id)return;
    const id=viewer.id;
    for(const kind of ["mouse","keyboard"]){
      if(!viewer.scopes[kind])continue;
      try{
        const result=await invoke("control_status",{deviceId:id,kind});
        if(!viewer.running||viewer.id!==id)return;
        if(result?.success!==true||result?.approved!==true||
           !Number.isSafeInteger(result.secondsRemaining)||result.secondsRemaining<1)
          throw Error("Scoped controller expired");
      }catch{
        if(!viewer.running||viewer.id!==id)return;
        viewer.scopes[kind]=false;
        status(kind+" expired or revoked; viewer remains read-only for this scope.");
      }
    }
    controls();
  }

  async function captureFallback() {
    const target = getTarget();
    if (!viewer.running || !target || target.id !== viewer.id) return;
    const generation = viewer.generation;
    const ticket = window.TrayFeedback?.begin({
      key:"lan:screen:capture",button:$("lan-screen-capture"),label:"Capturing screenshot…",
    });
    if (window.TrayFeedback && !ticket) return;
    status("Requesting one fallback screenshot...");
    try {
      const response = await invoke("screen", { deviceId: target.id });
      if (!viewer.running || viewer.generation !== generation) return;
      const frame = response?.frame;
      if (!response?.success || frame?.mime !== "image/jpeg"
        || typeof frame.data !== "string" || frame.data.length > 290_000
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(frame.data)
        || !Number.isInteger(frame.width) || frame.width < 1 || frame.width > 480
        || !Number.isInteger(frame.height) || frame.height < 1 || frame.height > 1080) {
        throw Error("Invalid or unavailable screenshot");
      }
      const img = $("lan-screen-image");
      if (img) { img.src = "data:image/jpeg;base64," + frame.data; img.hidden = false; }
      if ($("lan-screen-placeholder")) $("lan-screen-placeholder").hidden = true;
      viewer.hasFrame = true;
      status("Single screenshot captured · not auto-refreshing");
      notifyScreen("success", "One approved screenshot captured.");
      controls();
    } catch {
      status("Screenshot unavailable · check phone capture permission");
      notifyScreen("error", "Screenshot unavailable. Check phone capture permission.");
    } finally {
      ticket?.end();
      controls();
    }
  }

  async function input(command) {
    const target = getTarget();
    if (!viewer.running || !viewer.scopes[
       command.kind === "tap" || command.kind === "swipe" ? "mouse" : "keyboard"
     ] || !target || target.id !== viewer.id
      || (!viewer.hasSchema && !viewer.hasFrame)) return;
    const button = $("lan-screen-" + (command.kind === "text" ? "send-text" : command.kind));
    const ticket = window.TrayFeedback?.begin({
      key:"lan:screen:input:" + command.kind,button,
      label:"Sending input…",
    });
    if (window.TrayFeedback && !ticket) return;
    try {
      const response = await invoke("input", { deviceId: target.id, ...command });
      status(response?.success && response?.result?.ok
        ? "Input accepted · " + command.kind : "Phone rejected " + command.kind);
      notifyScreen(response?.success && response?.result?.ok ? "info" : "warning",
        response?.success && response?.result?.ok
          ? "Remote input accepted. Refresh schema before another action."
          : "Remote input not accepted. Check phone permission.");
      // Avoid retaining stale visual references across state-changing input.
      viewer.schemaRevision = 0;
      viewer.hasSchema = false;
      clearScreenshot();
      controls();
    } catch {
      status("Remote touch denied · check on-phone input consent");
      notifyScreen("error", "Remote input denied. Check on-phone consent.");
    } finally { ticket?.end(); }
  }

  function point(event) {
    const img = $("lan-screen-image");
    if (!img || img.hidden || !img.naturalWidth || !img.naturalHeight) return null;
    const rect = img.getBoundingClientRect();
    const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    const x = (event.clientX - (rect.left + (rect.width - w) / 2)) / w;
    const y = (event.clientY - (rect.top + (rect.height - h) / 2)) / h;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: Number(x.toFixed(5)), y: Number(y.toFixed(5)) };
  }

  function install() {
    $("lan-screen-start")?.addEventListener("click", start);
    $("lan-screen-request-control")?.addEventListener("click",()=>{void requestController("mouse");});
    $("lan-screen-revoke-control")?.addEventListener("click",()=>{void revokeController("mouse");});
    $("lan-screen-request-keyboard")?.addEventListener("click",()=>{void requestController("keyboard");});
    $("lan-screen-revoke-keyboard")?.addEventListener("click",()=>{void revokeController("keyboard");});
    $("lan-screen-capture")?.addEventListener("click", () => { void captureFallback(); });
    $("lan-screen-stop")?.addEventListener("click", () =>
      stop("Schema viewer stopped. Use End remote session or the phone's STOP SHARING notification to revoke access."));
    $("lan-screen-image")?.addEventListener("pointerdown", (e) => {
      if (!viewer.running || !viewer.scopes.mouse || !viewer.hasFrame) return;
      const from = point(e);
      if (!from) return;
      viewer.origin = { ...from, pointer: e.pointerId, when: Date.now() };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    });
    $("lan-screen-image")?.addEventListener("pointerup", (e) => {
      const from = viewer.origin;
      viewer.origin = null;
      if (!from || from.pointer !== e.pointerId) return;
      const to = point(e);
      if (!to) return;
      if (Math.hypot(to.x - from.x, to.y - from.y) > 0.026) {
        void input({ kind: "swipe", x: from.x, y: from.y, endX: to.x, endY: to.y,
          durationMs: Math.max(100, Math.min(1500, Date.now() - from.when)) });
      } else void input({ kind: "tap", x: to.x, y: to.y });
    });
    $("lan-screen-image")?.addEventListener("pointercancel", () => { viewer.origin = null; });
    for (const kind of ["back", "home", "recents"]) {
      $("lan-screen-" + kind)?.addEventListener("click", () => { void input({ kind }); });
    }
    $("lan-screen-send-text")?.addEventListener("click", () => {
      const value = $("lan-screen-text")?.value || "";
      if (!value || value.length > 160 || value.includes(String.fromCharCode(10))
        || value.includes(String.fromCharCode(13))) {
        status("Text must be 1-160 characters and contain no newline");
        return;
      }
      void input({ kind: "text", text: value });
      if ($("lan-screen-text")) $("lan-screen-text").value = "";
    });
    $("lan-screen-disconnect")?.addEventListener("click", async () => {
      const target = getTarget();
      if (!target || !window.confirm("End the entire Android support session? Capture and remote touch will stop.")) return;
      const ticket = window.TrayFeedback?.begin({
        key:"lan:screen:disconnect",button:$("lan-screen-disconnect"),
        label:"Ending remote session…",
      });
      if (window.TrayFeedback && !ticket) return;
      stop("Ending remote session...");
      try {
        const response = await invoke("close", { deviceId: target.id });
        if (response?.success === false) throw Error("Remote close not accepted");
        window.__superagentLanRefresh?.();
        notifyScreen("info", "Session close accepted. Verify device disconnected.");
      } catch {
        status("Remote stop unconfirmed; ask phone owner to tap STOP SHARING");
        notifyScreen("warning", "Remote stop unconfirmed. Ask phone owner to stop sharing.");
      } finally {
        ticket?.end(); controls();
      }
    });
    window.__superagentLanViewerStop = stop;
    if (typeof window.setInterval === "function") window.setInterval(() => { void refreshController(); }, 10_000);
    document.addEventListener?.("visibilitychange", () => {
      if(document.hidden){
        for(const kind of ["mouse","keyboard"])
          if(viewer.scopes[kind])void revokeController(kind);
      }
    });
    controls();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else install();
})();
