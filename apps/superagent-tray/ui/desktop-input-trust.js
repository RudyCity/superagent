"use strict";
(() => {
  // Tray UI only edits a fixed local policy through native Tauri commands.
  // The Core still requires fresh native human approval for EVERY input session.
  const $ = (id) => document.getElementById(id);
  const state = { policy: null, windows: [], busy: false, refreshing: false };
  const invoke = (name, args) => {
    const fn = window.__TAURI__?.core?.invoke;
    if (typeof fn !== "function") throw Error("Trusted input requires the installed native Tray");
    return fn(name, args);
  };
  const note = (message) => {
    const output = $("desktop-trust-feedback");
    if (output) output.textContent = message;
  };
  const validWindow = (item) =>
    item && Number.isSafeInteger(item.pid) && item.pid > 0 &&
    typeof item.nativeId === "string" && item.nativeId.length > 0 && item.nativeId.length <= 256 &&
    typeof item.application === "string" && item.application.length > 0 &&
    typeof item.title === "string" && item.title.length > 0;
  const buttons = () => {
    const mode = state.policy?.mode;
    const selected = Number($("desktop-trust-window")?.value);
    const eligible = $("desktop-trust-window")?.value !== "" && validWindow(state.windows[selected]);
    for (const id of ["desktop-trust-mode-save","desktop-trust-refresh","desktop-trust-add",
      "desktop-trust-revoke-all","desktop-trust-window","desktop-trust-duration"]) {
      const el = $(id);
      if (el) el.disabled = state.busy;
    }
    if ($("desktop-trust-add")) $("desktop-trust-add").disabled = state.busy || mode !== "trusted" || !eligible;
    if ($("desktop-trust-revoke-all")) $("desktop-trust-revoke-all").disabled =
      state.busy || !state.policy?.targets?.length;
  };
  const renderTargets = () => {
    const list = $("desktop-trust-targets");
    if (!list) return;
    list.replaceChildren();
    const targets = state.policy?.targets || [];
    if (!targets.length) {
      const empty = document.createElement("li");
      empty.className = "desktop-trust-empty";
      empty.textContent = "No active trusted windows. Input stays blocked until a host approves a target.";
      list.append(empty);
      return;
    }
    for (const entry of targets) {
      const item = document.createElement("li");
      item.className = "desktop-trust-target";
      const identity = document.createElement("div");
      identity.className = "desktop-trust-target-detail";
      const title = document.createElement("strong");
      title.textContent = entry.application + " — " + entry.title;
      const meta = document.createElement("small");
      const minutes = Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 60000));
      meta.textContent = "PID " + entry.pid + " · Window " + entry.nativeId +
        " · Expires in " + minutes + " min";
      identity.append(title, meta);
      const revoke = document.createElement("button");
      revoke.className = "button ghost danger";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.setAttribute("aria-label", "Revoke " + entry.application + " window");
      revoke.disabled = state.busy;
      revoke.addEventListener("click", () => void run("revoke_desktop_input_window",
        { pid: entry.pid, nativeId: entry.nativeId }, "Trusted window revoked."));
      item.append(identity, revoke);
      list.append(item);
    }
  };
  const renderPolicy = (policy) => {
    if (!policy || policy.version !== 1 ||
      !["trusted", "off"].includes(policy.mode) || !Array.isArray(policy.targets) ||
      policy.targets.length > 16) throw Error("Invalid trusted input policy response");
    state.policy = policy;
    if ($("desktop-trust-mode")) $("desktop-trust-mode").value = policy.mode;
    const label = $("desktop-trust-status");
    if (label) label.textContent = policy.mode === "trusted" ? "Trusted · host approval required" : "Off · input denied";
    renderTargets();
    buttons();
  };
  async function loadPolicy() {
    try {
      renderPolicy(await invoke("get_desktop_input_policy"));
      note("Trusted preferences loaded. Every input session still requires host consent.");
    } catch {
      state.policy = null;
      note("Cannot inspect native trusted-input policy. All trust actions are disabled.");
      buttons();
    }
  }
  async function refreshWindows() {
    if (state.busy || state.refreshing) return;
    state.refreshing = true;
    const select = $("desktop-trust-window");
    if (select) select.disabled = true;
    try {
      const result = await invoke("list_desktop_input_windows");
      if (!result || result.success !== true || !Array.isArray(result.windows) || result.windows.length > 100)
        throw Error("Native window inventory unavailable");
      state.windows = result.windows.filter(validWindow);
      if (select) {
        select.replaceChildren();
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select exact active window...";
        select.append(placeholder);
        state.windows.forEach((item, idx) => {
          const option = document.createElement("option");
          option.value = String(idx);
          option.textContent = item.application.slice(0, 80) + " — " + item.title.slice(0, 100) +
            " (PID " + item.pid + ")";
          select.append(option);
        });
        select.value = "";
      }
      note(state.windows.length
        ? "Select a window to request native host confirmation."
        : "No verified windows were returned by Core.");
    } catch {
      state.windows = [];
      note("Native window discovery unavailable. Check Core status and foreground Tray window.");
    } finally {
      state.refreshing = false;
      if (select) select.disabled = false;
      buttons();
    }
  }
  async function run(command, args, success) {
    if (state.busy) return;
    state.busy = true;
    buttons();
    note("Waiting for verified native operation...");
    try {
      const policy = await invoke(command, args);
      renderPolicy(policy);
      note(success);
      window.TrayFeedback?.notify({kind:"success",message:success,scope:"settings"});
    } catch (err) {
      note("No changes applied: " + String(err));
      window.TrayFeedback?.notify({kind:"warning",
        message:"Trusted input operation was denied or unavailable.",scope:"settings"});
    } finally {
      state.busy = false;
      buttons();
    }
  }
  function install() {
    $("desktop-trust-mode-save")?.addEventListener("click", () => {
      const mode = $("desktop-trust-mode")?.value;
      if (mode !== "trusted" && mode !== "off") return;
      void run("set_desktop_input_mode", {mode}, mode === "off"
        ? "Desktop input Trusted mode disabled. Active trusted targets revoked."
        : "Trusted mode enabled. No window gets input without two host approvals.");
    });
    $("desktop-trust-refresh")?.addEventListener("click", () => void refreshWindows());
    $("desktop-trust-window")?.addEventListener("change", buttons);
    $("desktop-trust-add")?.addEventListener("click", () => {
      const index = Number($("desktop-trust-window")?.value);
      const target = state.windows[index];
      const durationMinutes = Number($("desktop-trust-duration")?.value);
      if (state.policy?.mode !== "trusted" || !validWindow(target) ||
        ![5,10,15,30].includes(durationMinutes)) return;
      void run("trust_desktop_input_window",
        { pid:target.pid, nativeId:target.nativeId, durationMinutes },
        "Exact window trusted temporarily. Input still requires a second native approval.");
    });
    $("desktop-trust-revoke-all")?.addEventListener("click", () =>
      void run("revoke_all_desktop_input_windows", {}, "All trusted windows revoked."));
    window.addEventListener("hashchange", () => {
      if (location.hash === "#settings") {
        void loadPolicy();
      }
    });
    void loadPolicy();
  }
  install();
})();
