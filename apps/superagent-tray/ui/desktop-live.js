"use strict";
(() => {
  /* Local-only, consent-first native window preview. No automatic input. */
  const $ = id => document.getElementById(id);
  const PRESETS = Object.freeze({
    save: Object.freeze({ maxWidth: 768, quality: 50, minPollMs: 1000 }),
    balanced: Object.freeze({ maxWidth: 1280, quality: 65, minPollMs: 500 }),
    detail: Object.freeze({ maxWidth: 1920, quality: 75, minPollMs: 250 }),
  });
  const selectedPreset = () => PRESETS[$("desktop-live-quality")?.value] || PRESETS.balanced;
  const state = { windows: [], token: null, hash: null, generation: 0, starting: false, loading: false,
    transferredFrames: 0, unchangedFrames: 0, backend: "", lastPaintAt: 0, measuredFps: 0 };
  const pageVisible = () => Boolean($("page-desktop-live") && !$("page-desktop-live").hidden && !document.hidden);
  const invoke = async (action, payload = null) => {
    const native = window.__TAURI__?.core?.invoke;
    if (typeof native !== "function") throw Error("Native authenticated Tray required");
    return native("desktop_live_action", { action, payload });
  };
  const status = message => {
    const el = $("desktop-live-status");
    if (el) el.textContent = message;
  };
  const remoteMessage = (state, message) => {
    const badge = $("desktop-live-remote-state");
    if (badge) {
      badge.textContent = state;
      badge.dataset.state = state.toLowerCase().replace(/[^a-z_-]/g, "");
    }
    const detail = $("desktop-live-remote-detail");
    if (detail) detail.textContent = message;
  };
  async function remoteReadiness() {
    try {
      const result = await invoke("remote-status");
      if (!result || result.success !== true || result.state !== "NOT_CONFIGURED" ||
          result.viewAvailable !== false || result.inputAvailable !== false ||
          result.approvalAvailable !== false || result.viewerCertificateSha256 !== null) {
        throw Error("Remote provisioning not verified");
      }
      remoteMessage("NOT CONFIGURED",
        "No trusted mTLS 1.3 private host listener or pinned viewer identity. " +
        "Local preview remains local. Separate remote input approval is unavailable.");
    } catch {
      remoteMessage("UNAVAILABLE", "Remote readiness cannot be verified. All remote access stays off.");
    }
  }
  async function remoteReview() {
    if (!pageVisible()) return;
    const button = $("desktop-live-remote-review");
    if (button) button.disabled = true;
    try {
      // Rust owns the native dialog and refuses WebView-supplied viewer,
      // fingerprint, TLS keys, bind address, or consent boolean.
      const result = await invoke("remote-review");
      if (result?.state !== "NOT_CONFIGURED" || result?.approved !== false) {
        throw Error("Unexpected remote approval state");
      }
    } catch {
      remoteMessage("UNAVAILABLE", "Native private-viewer review failed. Remote access stays off.");
    } finally {
      if (button) button.disabled = false;
      await remoteReadiness();
    }
  }
  async function revokeRemote() {
    try {
      const result = await invoke("remote-stop");
      if (!result || result.success !== true || result.state !== "NOT_CONFIGURED") {
        throw Error("Private remote revocation could not be verified");
      }
      remoteMessage("NOT CONFIGURED", "Remote viewing and input are off. Host takeover requested.");
    } catch {
      remoteMessage("UNAVAILABLE", "Host revocation could not be confirmed. Remote access must remain disabled.");
    }
  }
  const resetImage = () => {
    const image = $("desktop-live-image");
    if (image) { image.removeAttribute("src"); image.hidden = true; }
    const placeholder = $("desktop-live-placeholder");
    if (placeholder) placeholder.hidden = false;
  };
  const buttons = () => {
    const selected = Number($("desktop-live-target")?.value);
    const choice = $("desktop-live-target")?.value !== "" && state.windows[selected];
    if ($("desktop-live-start")) $("desktop-live-start").disabled = state.starting || !!state.token || !choice;
    if ($("desktop-live-stop")) $("desktop-live-stop").disabled = !state.token;
    if ($("desktop-live-target")) $("desktop-live-target").disabled = !!state.token || state.starting;
  };
  async function stop(message = "Preview stopped. No frames are retained.") {
    const token = state.token;
    state.token = null;
    state.hash = null;
    state.backend = "";
    state.lastPaintAt = 0;
    state.measuredFps = 0;
    state.generation += 1;
    resetImage();
    buttons();
    status(message);
    // Revoke remote and local scopes immediately without serializing behind
    // either request. The preview token stays in local, native-only IPC.
    const remoteRevocation = revokeRemote();
    if (token) {
      try { await invoke("stop", { token }); }
      catch { status("Preview cleared locally. Core will expire the unused capability."); }
    }
    await remoteRevocation;
  }
  async function refresh() {
    if (state.loading || state.token || state.starting || !pageVisible()) return;
    state.loading = true;
    status("Checking native window identity and capture permission...");
    if ($("desktop-live-refresh")) $("desktop-live-refresh").disabled = true;
    try {
      const response = await invoke("windows");
      if (!response || response.success !== true || !Array.isArray(response.windows) ||
          response.windows.length > 100) throw Error("Native window discovery unavailable");
      state.windows = response.windows.filter(w =>
        Number.isSafeInteger(w?.pid) && w.pid > 0 &&
        typeof w?.nativeId === "string" && w.nativeId.length > 0 && w.nativeId.length <= 256 &&
        typeof w?.application === "string" && typeof w?.title === "string");
      const select = $("desktop-live-target");
      if (select) {
        select.replaceChildren();
        const first = document.createElement("option");
        first.value = "";
        first.textContent = "Choose an application window...";
        select.append(first);
        state.windows.forEach((window, index) => {
          const option = document.createElement("option");
          option.value = String(index);
          option.textContent = window.application.slice(0, 80) + " · " + window.title.slice(0, 128);
          select.append(option);
        });
      }
      status(state.windows.length ? "Select a window. Capture requires fresh explicit consent." :
        "No eligible native windows were discovered on this desktop.");
    } catch {
      state.windows = [];
      status("Window discovery unavailable. Check Core and operating-system screen permissions.");
    } finally {
      state.loading = false;
      if ($("desktop-live-refresh")) $("desktop-live-refresh").disabled = false;
      buttons();
      void remoteReadiness();
    }
  }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function previewLoop(token, generation) {
    while (state.token === token && state.generation === generation) {
      if (!pageVisible()) {
        await stop("Preview stopped when the viewer was hidden.");
        break;
      }
      let pollMs = 900;
      try {
        const preset = selectedPreset();
        const frame = await invoke("frame", {
          token, codec: "jpeg", maxWidth: preset.maxWidth, quality: preset.quality,
          ...(state.hash ? { knownHash: state.hash } : {}),
        });
        if (state.token !== token || state.generation !== generation) break;
        if (!frame || frame.success !== true || typeof frame.hash !== "string" ||
            !/^[a-f0-9]{64}$/.test(frame.hash) ||
            !Number.isInteger(frame.nextPollMs) ||
            frame.nextPollMs < 250 || frame.nextPollMs > 2000) {
          throw Error("Frame integrity not verified");
        }
        if (frame.unchanged === true) {
          if (!state.hash || frame.hash !== state.hash || !$("desktop-live-image")?.src)
            throw Error("Unchanged frame without a known, displayed baseline");
          state.unchangedFrames += 1;
        } else if (frame.unchanged === false && frame.format === "jpeg" &&
            typeof frame.jpeg === "string" && frame.jpeg.length > 0 && frame.jpeg.length <= 700000 &&
            frame.jpeg.startsWith("/9j/") && /^[A-Za-z0-9+/]+={0,2}$/.test(frame.jpeg) &&
            Number.isSafeInteger(frame.width) && Number.isSafeInteger(frame.height) &&
            frame.width > 0 && frame.height > 0 && frame.width <= 1920 && frame.height <= 8192) {
          const image = $("desktop-live-image");
          if (image) {
            image.src = "data:image/jpeg;base64," + frame.jpeg;
            image.hidden = false;
          }
          const now = performance.now();
          if (state.lastPaintAt > 0 && now > state.lastPaintAt) {
            const observed = 1000 / (now - state.lastPaintAt);
            state.measuredFps = state.measuredFps > 0
              ? state.measuredFps * 0.7 + observed * 0.3
              : observed;
          }
          state.lastPaintAt = now;
          state.hash = frame.hash;
          state.transferredFrames += 1;
          if ($("desktop-live-placeholder")) $("desktop-live-placeholder").hidden = true;
        } else {
          throw Error("Unverified image frame");
        }
        pollMs = Math.max(selectedPreset().minPollMs, frame.nextPollMs);
        status("Private JPEG · " + state.backend + " · read-only · " +
          state.transferredFrames + " frames, " + state.unchangedFrames + " unchanged skipped" +
          (state.measuredFps > 0 ? " · " + state.measuredFps.toFixed(1) + " delivered fps" : ""));
      } catch {
        await stop("Preview stopped: authorization, window identity, or capture could not be verified.");
        break;
      }
      await delay(pollMs);
    }
  }
  async function start() {
    if (state.token || state.starting || !pageVisible()) return;
    const indexString = $("desktop-live-target")?.value || "";
    const selected = indexString === "" ? null : state.windows[Number(indexString)];
    if (!selected) return;
    state.starting = true;
    buttons();
    status("Approve or deny the exact application window in the native system dialog...");
    try {
      const result = await invoke("start",
        { pid: selected.pid, nativeId: selected.nativeId, consent: true });
      if (!result || result.success !== true ||
          typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token) ||
          result.window?.pid !== selected.pid || result.window?.nativeId !== selected.nativeId) {
        throw Error("Preview identity could not be verified");
      }
      state.token = result.token;
      state.backend = typeof result.backend === "string" && /^[a-z0-9-]{1,60}$/.test(result.backend)
        ? result.backend : "native-window";
      state.hash = null;
      state.transferredFrames = 0;
      state.unchangedFrames = 0;
      state.lastPaintAt = 0;
      state.measuredFps = 0;
      state.generation += 1;
      if (!pageVisible()) { await stop("Preview stopped when viewer became hidden."); return; }
      void previewLoop(result.token, state.generation);
    } catch {
      status("Preview not started. Verify the target, Core connection and OS permissions.");
      resetImage();
    } finally {
      state.starting = false;
      buttons();
    }
  }
  function install() {
    $("desktop-live-refresh")?.addEventListener("click", () => void refresh());
    $("desktop-live-start")?.addEventListener("click", () => void start());
    $("desktop-live-stop")?.addEventListener("click", () => void stop());
    $("desktop-live-remote-review")?.addEventListener("click", () => void remoteReview());
    $("desktop-live-takeover")?.addEventListener("click",
      () => void stop("Host takeover requested. Local preview and private viewer revoked."));
    $("desktop-live-target")?.addEventListener("change", buttons);
    $("desktop-live-quality")?.addEventListener("change", () => {
      // A different codec profile requires a full frame; the Core also
      // checks its own last-rendered profile before accepting a known hash.
      state.hash = null;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) void stop("Preview stopped when Tray became hidden.");
    });
    window.addEventListener("pagehide", () => void stop("Preview stopped on viewer exit."));
    buttons();
    void remoteReadiness();
  }
  window.__superagentDesktopLiveRefresh = refresh;
  window.__superagentDesktopLiveStop = () => stop("Preview stopped on page navigation.");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install);
  else install();
})();
