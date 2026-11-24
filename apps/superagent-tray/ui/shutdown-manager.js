"use strict";
(() => {
  const $ = id => document.getElementById(id);
  const state = {
    preview: null,
    selected: new Set(),
    progress: null,
    busy: false,
    loading: false,
    poller: null,
    lastTerminalRefresh: null,
  };
  const invoke = (action, fields = {}) => {
    const call = window.__TAURI__?.core?.invoke;
    if (!call) throw Error("Native SuperAgent Tray is required");
    return call("shutdown_manager_action", { action, ...fields });
  };
  const active = item =>
    item.kind !== "system" &&
    !["inactive", "stopped", "stale", "embedded"].includes(item.state) &&
    !(
      item.state === "unreachable" &&
      item.selectable !== true &&
      item.forceSelectable !== true &&
      item.manualKillSelectable !== true
    );
  const stoppable = item =>
    active(item) && (item.selectable === true || item.forceSelectable === true || item.manualKillSelectable === true);
  const eligible = () => (state.preview?.services ?? []).filter(stoppable);

  function node(parent, tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = String(value ?? "");
    parent.append(element);
    return element;
  }

  function safe(error) {
    const value = String(error?.message ?? error);
    const found = value.match(/SHUTDOWN_[A-Z0-9_]+/);
    return found ? found[0].replace(/_/g, " ") : "Operation failed or cancelled.";
  }

  function feedback(value, error = false) {
    const el = $("shutdown-feedback");
    if (el) {
      el.textContent = value;
      el.dataset.tone = error ? "error" : "neutral";
    }
  }

  function buttons() {
    const lock = state.busy || state.loading;
    const allEligible = eligible();
    const allChecked = allEligible.length > 0 && allEligible.every(item => state.selected.has(item.id));
    $("shutdown-close-selected").disabled = lock || !state.preview || state.selected.size === 0;
    $("shutdown-select-all").disabled = lock || allEligible.length === 0;
    $("shutdown-select-all").textContent = allChecked ? "Clear all" : "Select all";
    $("shutdown-refresh").disabled = lock;
    $("shutdown-close").disabled = state.loading;
    $("shutdown-cancel").disabled = state.loading;
    $("shutdown-selection-count").textContent =
      state.selected.size + " / " + allEligible.length + " daemon selected";
  }

  function drawServices() {
    const list = $("shutdown-services");
    list.replaceChildren();
    const activeItems = (state.preview?.services ?? []).filter(active);
    if (!activeItems.length) {
      node(list, "p", "shutdown-empty", "Tidak ada daemon aktif.");
      buttons();
      return;
    }
    for (const item of activeItems) {
      const canStop = stoppable(item);
      const row = document.createElement("label");
      row.className = "shutdown-service";
      row.dataset.state = canStop ? "ready" : "blocked";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = item.id;
      checkbox.checked = state.selected.has(item.id);
      checkbox.disabled = state.busy || !canStop;
      checkbox.setAttribute("aria-label", "Select " + item.label);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        buttons();
      });
      row.append(checkbox);

      const copy = document.createElement("span");
      copy.className = "shutdown-service-copy";
      node(copy, "strong", "", item.label);
      const meta = [
        item.port ? "Port " + item.port : null,
        item.pid ? "PID " + item.pid : null,
        item.processName || null,
      ].filter(Boolean).join(" · ");
      if (meta || item.detail) node(copy, "small", "", meta || item.detail);
      if (item.processPath) {
        const exe = node(copy, "small", "shutdown-executable", item.processPath);
        exe.setAttribute("title", item.processPath);
      }
      row.append(copy);

      if (!canStop) {
        node(row, "span", "shutdown-status", "Locked");
      }
      list.append(row);
    }
    buttons();
  }

  function drawProgress() {
    const list = $("shutdown-progress-steps");
    const wrap = $("shutdown-progress");
    wrap.hidden = !state.progress;
    list.replaceChildren();
    if (!state.progress) return;
    $("shutdown-progress-status").textContent =
      state.progress.stage === "running"
        ? "Closing selected daemons..."
        : state.progress.stage === "complete"
          ? "Selected daemons closed"
          : "Partial — some daemons still active";
    for (const step of state.progress.steps ?? []) {
      const row = document.createElement("li");
      row.className = "shutdown-step";
      row.dataset.status = step.status;
      node(row, "strong", "", step.label);
      node(row, "span", "shutdown-step-state", step.status);
      if (step.message) node(row, "small", "", step.message);
      list.append(row);
    }
    if (state.progress.error) feedback(state.progress.error, true);
  }

  function acceptProgress(progress) {
    if (!progress || !Array.isArray(progress.steps)) return;
    if (state.progress && state.progress.runId !== progress.runId && state.busy) return;
    state.progress = progress;
    state.busy = progress.stage === "running";
    if (!state.busy) {
      state.preview = null;
      state.selected.clear();
      drawServices();
    }
    drawProgress();
    buttons();
    if (!state.busy && state.poller !== null) {
      clearInterval(state.poller);
      state.poller = null;
    }
    if (!state.busy && state.lastTerminalRefresh !== progress.runId) {
      state.lastTerminalRefresh = progress.runId;
      void Promise.resolve().then(async () => {
        if ($("shutdown-manager-dialog").hidden || state.busy || state.loading) return;
        await refresh();
        drawProgress();
      });
    }
  }

  async function pollStatus() {
    try {
      const response = await invoke("status");
      if (response?.progress) acceptProgress(response.progress);
    } catch {
      if (state.busy) feedback("Status tidak tersedia.", true);
    }
  }

  function startPolling() {
    if (state.poller !== null) return;
    state.poller = setInterval(() => { void pollStatus(); }, 1000);
  }

  async function refresh() {
    if (state.busy || state.loading) return;
    state.loading = true;
    state.preview = null;
    state.selected.clear();
    buttons();
    feedback("Memuat daftar daemon...");
    try {
      const response = await invoke("preview");
      if (!response?.preview || !Array.isArray(response.preview.services)) {
        throw Error("Invalid owner inventory");
      }
      state.preview = response.preview;
      for (const item of eligible()) state.selected.add(item.id);
      drawServices();
      const count = eligible().length;
      feedback(
        count
          ? count + " daemon siap ditutup. Centang lalu klik Close Selected."
          : "Tidak ada daemon aktif yang dapat ditutup.",
      );
    } catch (error) {
      feedback(safe(error), true);
      drawServices();
    } finally {
      state.loading = false;
      buttons();
    }
  }

  function toggleSelectAll() {
    if (state.busy || state.loading || !state.preview) return;
    const allEligible = eligible();
    const allChecked = allEligible.length > 0 && allEligible.every(item => state.selected.has(item.id));
    state.selected.clear();
    if (!allChecked) {
      for (const item of allEligible) state.selected.add(item.id);
    }
    drawServices();
  }

  async function closeSelected() {
    if (state.busy || state.loading || !state.preview || !state.selected.size) return;
    state.loading = true;
    buttons();
    feedback("Menunggu konfirmasi...");
    try {
      const selected = Array.from(state.selected);
      const response = await invoke("close_selected", {
        previewId: state.preview.previewId,
        selected,
      });
      if (!response?.accepted || !response.runId) throw Error("Confirmation rejected");
      state.busy = true;
      state.progress = {
        runId: response.runId,
        stage: "running",
        exitAfter: false,
        steps: selected.map(id => {
          const item = state.preview.services.find(s => s.id === id);
          return {
            id,
            label: item?.pid ? item.label + " (PID " + item.pid + ")" : (item?.label || "Daemon"),
            status: "queued",
            message: "Queued",
          };
        }),
      };
      drawProgress();
      feedback("Menutup daemon yang dipilih...");
      startPolling();
      await pollStatus();
    } catch (error) {
      feedback(safe(error), true);
    } finally {
      state.loading = false;
      buttons();
    }
  }

  async function open() {
    $("shutdown-manager-dialog").hidden = false;
    $("shutdown-close").focus();
    try {
      const response = await invoke("status");
      if (response?.progress) acceptProgress(response.progress);
      if (response?.busy) {
        state.busy = true;
        startPolling();
        buttons();
        feedback("Penutupan daemon sedang berjalan...");
        return;
      }
    } catch {}
    await refresh();
  }

  function close() {
    $("shutdown-manager-dialog").hidden = true;
  }

  function install() {
    $("shutdown-close")?.addEventListener("click", close);
    $("shutdown-cancel")?.addEventListener("click", close);
    $("shutdown-refresh")?.addEventListener("click", () => { void refresh(); });
    $("shutdown-select-all")?.addEventListener("click", toggleSelectAll);
    $("shutdown-close-selected")?.addEventListener("click", () => { void closeSelected(); });
    $("shutdown-manager-dialog")?.addEventListener("keydown", event => {
      if (event.key === "Escape" && !state.busy) close();
    });
    $("shutdown-manager-dialog")?.addEventListener("click", event => {
      if (event.target === $("shutdown-manager-dialog") && !state.busy) close();
    });
    window.__TAURI__?.event?.listen?.("desktop-open-shutdown-manager", () => { void open(); });
    window.__TAURI__?.event?.listen?.("shutdown-manager-progress", event => acceptProgress(event?.payload));
    window.__superagentShutdownManagerOpen = open;
    buttons();
  }

  install();
})();
