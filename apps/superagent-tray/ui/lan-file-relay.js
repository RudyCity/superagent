"use strict";
/** Owner-initiated device relay; Core handles all file bytes and approvals. */
(() => {
  const $ = (id) => document.getElementById(id);
  const invoke = async (action, payload = {}) => {
    const native = window.__TAURI__?.core?.invoke;
    if (typeof native !== "function") throw Error("Native Tray is unavailable.");
    return native("lan_support_action", { action, payload });
  };
  let busy = false;
  let jobId = null;
  let generation = 0;
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const status = (text) => {
    const element = $("lan-relay-status");
    if (element) element.textContent = String(text).slice(0, 350);
  };
  function source() { return window.__superagentLanGetSelected?.(); }
  function destinations() {
    const src = source();
    const list = window.__superagentLanListTransferTargets?.() || [];
    return Array.isArray(list) ? list.filter((d) => d && d.connected &&
      typeof d.id === "string" && d.id !== src?.id &&
      ["android", "windows"].includes(d.platform)).slice(0, 8) : [];
  }
  function controls() {
    const select = $("lan-relay-destination");
    if (!select) return;
    const choices = destinations();
    const otherBusy = window.__superagentLanLargeReceiveBusy === true;
    const prior = select.value;
    const options = choices.map((device) => {
      const option = document.createElement("option");
      option.value = device.id;
      option.textContent = (device.label || device.platform) + " · " +
        (device.transport === "tunnel" ? "Tunnel" : "Direct LAN");
      return option;
    });
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = choices.length ? "Choose approved destination" :
      "Connect another device on this route";
    select.replaceChildren(empty, ...options);
    select.value = choices.some((device) => device.id === prior) ? prior : "";
    select.disabled = busy || !choices.length;
    const protocol = $("lan-relay-protocol")?.value || "v1";
    const selectedSource = source();
    if ($("lan-relay-start")) $("lan-relay-start").disabled =
      busy || otherBusy || !selectedSource || !select.value ||
      (protocol === "v2" && !["windows", "android"].includes(selectedSource.platform));
    if ($("lan-relay-cancel")) $("lan-relay-cancel").disabled = !busy || !jobId;
  }
  function report(job) {
    if (!job || typeof job.status !== "string" || !Number.isSafeInteger(job.size) ||
        !Number.isSafeInteger(job.transferred) || job.transferred < 0 ||
        job.transferred > job.size) throw Error("Invalid relay job status.");
    const percent = job.size > 0 ? Math.floor(job.transferred * 100 / job.size) : 0;
    if ($("lan-relay-progress")) $("lan-relay-progress").value = percent;
    const speed = Number.isFinite(job.speedBytesPerSecond) ?
      Math.max(0, job.speedBytesPerSecond) : 0;
    const eta = speed > 0 && job.size > job.transferred ?
      " · ETA " + Math.ceil((job.size - job.transferred) / speed) + "s" : "";
    status((job.name || "Waiting for owner approval") + " · " + job.status +
      " · " + job.transferred + "/" + job.size + " bytes · " +
      (speed / 1024).toFixed(1) + " KiB/s" + eta +
      (job.error ? " · " + String(job.error).slice(0, 160) : ""));
  }
  async function poll(id, nonce) {
    while (busy && jobId === id && nonce === generation) {
      let completed = false;
      try {
        const result = await invoke("file_relay_status", { jobId: id });
        if (!result?.success || !result.job || result.job.id !== id)
          throw Error("Relay status unavailable.");
        report(result.job);
        completed = terminal.has(result.job.status);
        if (completed) {
          if (result.job.status === "completed")
            window.TrayFeedback?.notify?.({ kind: "success",
              message: "Device-to-device file relay SHA-256 verified.", scope: "lan-devices" });
          else window.TrayFeedback?.notify?.({ kind: "warning",
            message: "Relay not verified. Inspect both devices before retrying.",
            scope: "lan-devices" });
        }
      } catch (error) {
        // Do not auto-replay an unknown relay. Core status may be recoverable
        // after a short timeout without starting another transfer.
        status("Relay status unavailable: " + String(error).slice(0, 220) +
          ". Reopen the session and inspect both devices before retrying.");
        completed = true;
      }
      if (completed) {
        busy = false;
        jobId = null;
        window.__superagentLanRelayBusy = false;
        window.__superagentLanFilesRefresh?.();
        controls();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  async function start() {
    if (busy || window.__superagentLanLargeReceiveBusy === true) return;
    const src = source();
    const dstId = $("lan-relay-destination")?.value;
    const protocol = $("lan-relay-protocol")?.value || "v1";
    const dst = destinations().find(d => d.id === dstId);
    if (!src?.connected || !dst?.connected ||
        !["v1", "v2"].includes(protocol) ||
        (protocol === "v2" && !["windows", "android"].includes(src.platform))) {
      status("Choose two connected devices on the same route."); return;
    }
    if (!window.confirm("Relay the file the " + src.platform +
        " owner ALREADY selected on " + src.label + " to " + dst.label +
        "? Both device owners must separately approve the exact file. " +
        (protocol === "v2" ?
          "V2: Source must be owner-selected large file (Android Select Large File or Windows share-large); max 256 MiB. " :
          "V1: max 4 MiB. ") +
        "No source paths or pairing credentials are shared.")) return;
    busy = true;
    window.__superagentLanRelayBusy = true;
    window.__superagentLanFilesRefresh?.();
    controls();
    status("Requesting source owner's file approval…");
    const nonce = ++generation;
    try {
      const result = await invoke("file_relay_start", {
        sourceId: src.id, destinationId: dst.id, protocol,
      });
      if (!result?.success || typeof result.job?.id !== "string")
        throw Error("Core rejected relay start.");
      jobId = result.job.id;
      controls();
      await poll(jobId, nonce);
    } catch (error) {
      status("Relay not started: " + String(error).slice(0, 210));
      busy = false;
      jobId = null;
      window.__superagentLanRelayBusy = false;
      window.__superagentLanFilesRefresh?.();
      controls();
    }
  }
  async function cancel() {
    if (!busy || !jobId) return;
    status("Cancellation requested. An in-flight final save may still complete.");
    try {
      await invoke("file_relay_cancel", { jobId });
    } catch (error) {
      status("Could not confirm relay cancellation: " + String(error).slice(0, 210));
    }
  }
  function install() {
    $("lan-relay-destination")?.addEventListener("change", controls);
    $("lan-relay-protocol")?.addEventListener("change", controls);
    $("lan-relay-start")?.addEventListener("click", () => { void start(); });
    $("lan-relay-cancel")?.addEventListener("click", () => { void cancel(); });
    window.__superagentLanRelayRefresh = controls;
    controls();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
