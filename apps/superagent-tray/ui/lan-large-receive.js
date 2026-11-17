"use strict";
/** Device-selected large receive is streamed by Core to create-only disk staging. */
(() => {
  const $ = (id) => document.getElementById(id);
  const invoke = async (action, payload) => {
    const call = window.__TAURI__?.core?.invoke;
    if (typeof call !== "function") throw Error("Installed Tray runtime required.");
    return call("lan_support_action", { action, payload });
  };
  let busy = false;
  let jobId = null;
  const terminal = new Set(["completed", "cancelled", "failed"]);
  const state = (message) => {
    if ($("lan-large-receive-status")) $("lan-large-receive-status").textContent =
      String(message).slice(0, 400);
  };
  function controls() {
    const source = window.__superagentLanGetSelected?.();
    const unavailable = window.__superagentLanRelayBusy === true;
    if ($("lan-large-receive-start")) $("lan-large-receive-start").disabled =
      busy || unavailable || !source?.connected ||
      !["android", "windows"].includes(source.platform);
    if ($("lan-large-receive-cancel")) $("lan-large-receive-cancel").disabled =
      !busy || !jobId;
  }
  async function poll(id) {
    while (busy && jobId === id) {
      try {
        const result = await invoke("file_receive_v2_status", { jobId: id });
        if (!result?.success || !result.job || result.job.id !== id)
          throw Error("No authenticated receive status.");
        const job = result.job;
        if (!Number.isSafeInteger(job.received) || !Number.isSafeInteger(job.size) ||
            job.received < 0 || job.received > job.size)
          throw Error("Malformed receive progress.");
        const percent = job.size ? Math.floor(job.received * 100 / job.size) : 0;
        if ($("lan-large-receive-progress")) $("lan-large-receive-progress").value = percent;
        const rate = Number.isFinite(job.speedBytesPerSecond) ?
          Math.max(0, job.speedBytesPerSecond) : 0;
        const eta = rate && job.size > job.received ?
          " · ETA " + Math.ceil((job.size - job.received) / rate) + "s" : "";
        state((job.name || "Waiting for the source owner") + " · " + job.status +
          " · " + job.received + "/" + job.size + " bytes · " +
          (rate / 1024).toFixed(1) + " KiB/s" + eta +
          (job.error ? " · " + String(job.error).slice(0, 190) : ""));
        if (terminal.has(job.status)) {
          if (job.status === "completed" && job.saved) {
            window.TrayFeedback?.notify?.({ kind: "success", scope: "lan-devices",
              message: "Large file SHA-256 verified and saved in Downloads/SuperAgent LAN/Received." });
          } else {
            window.TrayFeedback?.notify?.({ kind: "warning", scope: "lan-devices",
              message: "Large receive not verified; check the source and destination before retry." });
          }
          break;
        }
      } catch (error) {
        state("Could not verify Core receive status: " + String(error).slice(0, 200) +
          ". Inspect destination before retrying; no automatic replay.");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    busy = false;
    jobId = null;
    window.__superagentLanLargeReceiveBusy = false;
    window.__superagentLanFilesRefresh?.();
    window.__superagentLanRelayRefresh?.();
    controls();
  }
  async function start() {
    if (busy) return;
    const source = window.__superagentLanGetSelected?.();
    if (!source?.connected || !["android", "windows"].includes(source.platform)) {
      state("Select a connected owner-approved Android or Windows source."); return;
    }
    if (!window.confirm("Receive the large document selected by the " + source.platform +
        " owner into Downloads/SuperAgent LAN/Received? " +
        "Size: over 4 MiB to 256 MiB. Fresh source-owner approval required. " +
        "No remote-controlled filesystem path or overwrite is allowed.")) return;
    busy = true;
    window.__superagentLanLargeReceiveBusy = true;
    window.__superagentLanFilesRefresh?.();
    window.__superagentLanRelayRefresh?.();
    controls();
    state("Waiting for source owner's large-file approval...");
    try {
      const result = await invoke("file_receive_v2_start", { deviceId: source.id });
      if (!result?.success || typeof result.job?.id !== "string")
        throw Error("Core did not start the approved large receive.");
      jobId = result.job.id;
      controls();
      await poll(jobId);
    } catch (error) {
      state("Large receive not started: " + String(error).slice(0, 220));
      busy = false; jobId = null;
      window.__superagentLanLargeReceiveBusy = false;
      window.__superagentLanFilesRefresh?.();
      window.__superagentLanRelayRefresh?.();
      controls();
    }
  }
  async function cancel() {
    if (!busy || !jobId) return;
    state("Cancellation requested. Check the destination if final commit was in flight.");
    try { await invoke("file_receive_v2_cancel", { jobId }); }
    catch (error) { state("Cancel unconfirmed: " + String(error).slice(0, 180)); }
  }
  function install() {
    $("lan-large-receive-start")?.addEventListener("click", () => { void start(); });
    $("lan-large-receive-cancel")?.addEventListener("click", () => { void cancel(); });
    window.__superagentLanLargeReceiveRefresh = controls;
    controls();
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
