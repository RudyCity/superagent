/* Owner-reviewed Chrome CDP launcher; fixed native IPC, no direct network or shell. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let busy = false;
  let generation = 0;
  let current = null;

  function selectedPort() {
    const field = $("managed-chrome-port");
    const value = Number(field?.value);
    if (!Number.isSafeInteger(value) || value < 1024 || value > 65535)
      throw Error("Enter a debugging port between 1024 and 65535.");
    return value;
  }
  function selectedUrl() {
    const value = ($("managed-chrome-url")?.value || "").trim();
    if (!value) return "about:blank";
    if (value.length > 2048) throw Error("Startup URL is too long.");
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      throw Error("Use an HTTP(S) startup URL without credentials.");
    return parsed.toString();
  }
  function feedback(message, error = false) {
    const el = $("managed-chrome-feedback");
    if (el) {
      el.textContent = message;
      el.dataset.error = error ? "true" : "false";
    }
  }
  function updateButtons() {
    const launch = $("managed-chrome-launch");
    const stop = $("managed-chrome-stop");
    const refresh = $("managed-chrome-refresh");
    const running = current?.port === Number($("managed-chrome-port")?.value) &&
      current?.owned === true;
    if (launch) {
      launch.disabled = busy || running;
      launch.textContent = busy ? "Working…" : running ? "Owned Chrome running" : "Launch Chrome CDP";
    }
    if (stop) stop.disabled = busy || !running || current?.canStop !== true ||
      !Number.isSafeInteger(current?.pid) || !current?.recordId;
    if (refresh) refresh.disabled = busy;
  }
  function render(data) {
    current = data?.success === true ? data : null;
    const status = $("managed-chrome-status");
    const running = current?.owned === true && current?.status === "healthy";
    const occupied = current?.occupied === true;
    const ownedOffline = current?.owned === true && !running;
    if (status) {
      status.textContent = running ? "Owned · Healthy" : ownedOffline ? "Owned · CDP offline" :
        occupied ? "Port occupied" : current?.status === "stopped" ? "Port available" : "Unavailable";
      status.dataset.state = running ? "healthy" : ownedOffline || occupied ? "occupied" : "stopped";
    }
    const endpoint = $("managed-chrome-endpoint");
    if (endpoint) endpoint.textContent = "127.0.0.1:" + (current?.port || $("managed-chrome-port")?.value || "9222");
    const pid = $("managed-chrome-pid");
    if (pid) pid.textContent = current?.owned ? String(current.pid) : "—";
    const tabs = $("managed-chrome-tabs");
    if (tabs) tabs.textContent = current?.reachable ? String(current.targetCount ?? 0) : "—";
    const browser = $("managed-chrome-browser");
    if (browser) browser.textContent = current?.browserVersion || "Browser not verified";
    const tabCount = $("runtime-tab-chrome-count");
    if (tabCount) {
      const ownedCount = current?.owned === true ? "1" : "0";
      tabCount.dataset.ownedCount = ownedCount;
      tabCount.textContent = ownedCount;
    }
    updateButtons();
    if (occupied && !running)
      feedback("The port belongs to an unverified process. Choose a free port; SuperAgent will not adopt or stop it.", true);
    else if (running)
      feedback("Ready. This Chrome is owned by SuperAgent. Stop will request native approval.");
    else if (ownedOffline)
      feedback("Owned Chrome PID is verified, but its CDP endpoint is offline. Stop can close only this verified PID after native approval.", true);
    else if (!busy)
      feedback("Port is available. Launch opens a separate Chrome profile; your personal Chrome stays open.");
  }
  function errorMessage(error) {
    const text = String(error?.message || error || "Operation failed");
    const code = text.match(/MANAGED_CDP_[A-Z_]+/);
    return code ? code[0].replaceAll("_", " ") : text.slice(0, 250);
  }
  async function invoke(action, payload) {
    const call = window.__TAURI__?.core?.invoke;
    if (typeof call !== "function") throw Error("Native SuperAgent Tray is required.");
    return call("managed_chrome_action", { action, payload });
  }
  async function status() {
    if (busy || !$("managed-chrome-form")) return;
    let port;
    try { port = selectedPort(); } catch (e) { feedback(errorMessage(e), true); return; }
    const token = ++generation;
    current = null;
    updateButtons();
    feedback("Checking local debugging port…");
    try {
      const result = await invoke("status", { port });
      if (token !== generation || selectedPort() !== port) return;
      render(result);
    } catch (e) {
      if (token !== generation) return;
      render(null);
      feedback(errorMessage(e), true);
    }
  }
  async function run(action) {
    if (busy) return;
    // Invalidate an in-flight read-only port probe before a mutation.
    generation++;
    let port, payload;
    try {
      port = selectedPort();
      if (action === "launch") {
        payload = {
          port, mode: $("managed-chrome-mode")?.value || "headed",
          url: selectedUrl(),
        };
        if (current?.port === port && current?.occupied && !current?.owned)
          throw Error("Port is occupied. Select a different port.");
      } else {
        if (!current?.owned || !current?.canStop || current?.port !== port ||
            !Number.isSafeInteger(current.pid) || !current.recordId)
          throw Error("Verified SuperAgent-owned Chrome identity required before Stop.");
        payload = {port, expectedPid: current.pid, recordId: current.recordId};
      }
    } catch (e) {feedback(errorMessage(e), true);return;}
    busy = true;
    updateButtons();
    feedback(action === "launch" ? "Review the native Launch Chrome approval dialog…" :
      "Review the native Stop Chrome approval dialog…");
    try {
      const result = await invoke(action, payload);
      feedback(result?.success === true ? (action === "launch" ?
        (result.reused ? "Verified existing Chrome reused." : "Chrome launched and verified.") :
        "Owned Chrome stopped and port verified.") : "Owner did not verify the action.",
        result?.success !== true);
    } catch (e) {
      feedback(errorMessage(e) + " — check status before retrying.", true);
    } finally {
      busy = false;
      current = null;
      updateButtons();
      // Status is authoritative after a timeout; never replay an ambiguous mutation.
      await status();
    }
  }
  function init() {
    const form = $("managed-chrome-form");
    if (!form) return;
    form.addEventListener("submit", ev => {ev.preventDefault();void run("launch");});
    $("managed-chrome-refresh")?.addEventListener("click", () => void status());
    $("managed-chrome-stop")?.addEventListener("click", () => void run("stop"));
    $("managed-chrome-port")?.addEventListener("input", () => {
      generation++;
      current = null;
      render(null);
      const endpoint = $("managed-chrome-endpoint");
      if (endpoint) endpoint.textContent = "127.0.0.1:" + ($("managed-chrome-port")?.value || "—");
    });
    window.addEventListener("superagent-core-selected", () => void status());
    if (window.location.hash === "#runtime") void status();
  }
  window.__superagentManagedChromeRefresh = status;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
