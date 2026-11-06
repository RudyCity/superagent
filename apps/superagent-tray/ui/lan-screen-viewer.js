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
  const viewer = {
    running: false, generation: 0, id: null, hasFrame: false, hasSchema: false,
    schemaRevision: 0, nodes: [], origin: null,
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
    const target = getTarget();
    const eligible = Boolean(target && viewer.running && target.id === viewer.id);
    if ($("lan-screen-start")) $("lan-screen-start").disabled = viewer.running || !target;
    if ($("lan-screen-stop")) $("lan-screen-stop").disabled = !viewer.running;
    if ($("lan-screen-capture")) $("lan-screen-capture").disabled = !eligible;
    for (const id of ["lan-screen-back", "lan-screen-home", "lan-screen-recents",
      "lan-screen-send-text", "lan-screen-text"]) {
      if ($(id)) $(id).disabled = !eligible || (!viewer.hasSchema && !viewer.hasFrame);
    }
    if ($("lan-screen-disconnect")) $("lan-screen-disconnect").disabled = !target;
  }
  function clearScreenshot() {
    viewer.hasFrame = false;
    const img = $("lan-screen-image");
    if (img) { img.src = ""; img.hidden = true; }
  }
  function stop(message = "Schema-first viewer stopped") {
    viewer.running = false;
    viewer.generation++;
    viewer.id = null;
    viewer.origin = null;
    viewer.hasSchema = false;
    viewer.schemaRevision = 0;
    viewer.nodes = [];
    clearScreenshot();
    $("lan-schema-list")?.replaceChildren();
    if ($("lan-screen-placeholder")) {
      $("lan-screen-placeholder").hidden = false;
      $("lan-screen-placeholder").textContent = message;
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
      button.disabled = !node.clickable || !node.enabled;
      const currentRevision = schema.revision;
      button.addEventListener("click", () => {
        if (!viewer.running || viewer.schemaRevision !== currentRevision
          || !node.clickable || !node.enabled) return;
        void clickElement(currentRevision, node.id);
      });
      return button;
    });
    list.replaceChildren(...rows);
    schemaStatus("UI revision " + schema.revision + " · " + nodes.length
      + " elements" + (schema.truncated ? " · capped" : "") + " · text values hidden");
  }

  async function clickElement(revision, elementId) {
    const target = getTarget();
    if (!viewer.running || !target || target.id !== viewer.id
      || viewer.schemaRevision !== revision) return;
    try {
      const result = await invoke("element", { deviceId: target.id, kind: "click", elementId, revision });
      if (!result?.success || !result?.result?.ok) throw Error("Element no longer actionable");
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
    setTimeout(() => pollSchema(generation, nextFailures), nextFailures ? 1600 : 1100);
  }

  function start() {
    const target = getTarget();
    if (!target || viewer.running) return;
    if (!window.confirm("Use Android Accessibility UI schema instead of repeated screenshots? The phone owner must approve the LAN session, system screen capture, and separate remote touch permission.")) return;
    viewer.running = true;
    viewer.id = target.id;
    viewer.generation++;
    viewer.hasSchema = false;
    viewer.schemaRevision = 0;
    clearScreenshot();
    status("Requesting privacy-reduced UI schema");
    schemaStatus("Waiting for approved Android Accessibility...");
    controls();
    void pollSchema(viewer.generation);
  }

  async function captureFallback() {
    const target = getTarget();
    if (!viewer.running || !target || target.id !== viewer.id) return;
    const generation = viewer.generation;
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
      controls();
    } catch {
      status("Screenshot unavailable · check phone capture permission");
    }
  }

  async function input(command) {
    const target = getTarget();
    if (!viewer.running || !target || target.id !== viewer.id
      || (!viewer.hasSchema && !viewer.hasFrame)) return;
    try {
      const response = await invoke("input", { deviceId: target.id, ...command });
      status(response?.success && response?.result?.ok
        ? "Input accepted · " + command.kind : "Phone rejected " + command.kind);
      // Avoid retaining stale visual references across state-changing input.
      viewer.schemaRevision = 0;
      viewer.hasSchema = false;
      clearScreenshot();
      controls();
    } catch { status("Remote touch denied · check on-phone input consent"); }
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
    $("lan-screen-capture")?.addEventListener("click", () => { void captureFallback(); });
    $("lan-screen-stop")?.addEventListener("click", () =>
      stop("Schema viewer stopped. Use End remote session or the phone's STOP SHARING notification to revoke access."));
    $("lan-screen-image")?.addEventListener("pointerdown", (e) => {
      if (!viewer.running || !viewer.hasFrame) return;
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
      stop("Ending remote session...");
      try {
        await invoke("close", { deviceId: target.id });
        window.__superagentLanRefresh?.();
      } catch { status("Remote stop unconfirmed; ask phone owner to tap STOP SHARING"); }
    });
    window.__superagentLanViewerStop = stop;
    controls();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else install();
})();
