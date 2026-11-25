"use strict";
(() => {
  // Native Tray Access Manager: no WebView-side policy writes or localStorage.
  // All grants are performed by the native host after OS verification + dialog.
  const $ = (id) => document.getElementById(id);
  const state = { registry: null, windows: [], installedApps: [], appSource: "active", selected: "", busy: false, view: "desktop", ruleFilter: "all", ruleSearch: "", auditLogs: [], activeTab: "requests", selectedRuleIds: new Set(), pendingRuleRequests: [], pendingDesktopUiRequests: null, requestSubTab: "all" };
  const invoke = (name, args) => {
    const native = window.__TAURI__?.core?.invoke;
    if (typeof native !== "function") throw Error("Installed native Tray required");
    return native(name, args);
  };
  const make = (tag, className = "", text = "") => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const action = (label, cls, onClick) => {
    const button = make("button", cls, label);
    button.type = "button";
    button.addEventListener("click", onClick);
    return button;
  };
  const field = (label, control, hint) => {
    const wrap = make("label", "access-field");
    wrap.append(make("span", "access-field-title", label), control);
    if (hint) wrap.append(make("span", "access-hint", hint));
    return wrap;
  };
  const option = (value, label) => {
    const node = make("option", "", label);
    node.value = value;
    return node;
  };
  const select = (id, values) => {
    const node = make("select", "access-select");
    node.id = id;
    for (const [value, label] of values) node.append(option(value, label));
    return node;
  };
  const checkbox = (id, label, checked) => {
    const control = make("label", "access-check");
    const input = make("input");
    input.id = id;
    input.type = "checkbox";
    input.checked = checked;
    control.append(input, make("span", "", label));
    return control;
  };
  const status = (message, level = "info") => {
    const el = $("access-status");
    if (el) { el.textContent = message; el.dataset.level = level; }
  };
  const validWindow = (w) =>
    w && Number.isSafeInteger(w.pid) && w.pid > 0 && typeof w.nativeId === "string" &&
    w.nativeId.length > 0 && w.nativeId.length <= 256 &&
    typeof w.title === "string" && w.title.length > 0 && typeof w.application === "string";

  function setBusy(value) {
    state.busy = value;
    for (const id of ["access-submit","access-refresh","access-select-window",
      "access-effect","access-kind","access-exact","access-view","access-input","access-element-role","access-element-label",
      "access-file-path","access-file-recursive","access-file-read","access-file-write","access-file-delete",
      "access-pick-file","access-pick-folder","access-audit-clear","access-audit-refresh",
      "access-src-active","access-src-installed","access-pick-exe",
      "access-rule-bulk-revoke","access-rule-bulk-clear","access-rule-select-all"]) {
      const el = $(id);
      if (el) el.disabled = value;
    }
    const submit = $("access-submit");
    if (submit && !value) submit.disabled = state.view === "file"
      ? !$("access-file-path")?.value.trim()
      : !selectedTarget();
    if (!value) {
      const allRules = state.registry?.rules || [];
      const query = (state.ruleSearch || "").trim().toLowerCase();
      const filtered = allRules.filter(r => {
        if (state.ruleFilter !== "all" && r.kind !== state.ruleFilter) return false;
        if (!query) return true;
        const app = appName(r.app?.executablePath).toLowerCase();
        const path = (r.kind === "desktop" ? (r.scope?.windowTitle || "") : (r.scope?.path || "")).toLowerCase();
        const ops = (r.operations || []).join(" ").toLowerCase();
        return app.includes(query) || path.includes(query) || ops.includes(query);
      });
      updateBulkBar(filtered);
    }
  }
  function appName(path) {
    return String(path || "Unknown executable").split(/[\\/]/).pop() || "Unknown executable";
  }
  function selectedWindow() {
    return state.windows.find(w => String(w.pid) + ":" + w.nativeId === state.selected);
  }
  function selectedInstalledApp() {
    return state.installedApps.find(a => "installed:" + a.executablePath === state.selected);
  }
  function selectedTarget() {
    if (state.appSource === "active") {
      const w = selectedWindow();
      if (!w) return null;
      return {
        type: "active",
        name: w.application,
        title: w.title,
        pid: w.pid,
        nativeId: w.nativeId,
        path: null,
        desc: w.title + " · PID " + w.pid,
      };
    } else {
      const a = selectedInstalledApp();
      if (!a) return null;
      return {
        type: "installed",
        name: a.name,
        title: "Semua jendela aplikasi ini",
        pid: 0,
        nativeId: "",
        path: a.executablePath,
        desc: a.executablePath + " · Aplikasi Terinstall",
      };
    }
  }
  function updateSourceTabs() {
    const tabActive = $("access-src-active");
    const tabInstalled = $("access-src-installed");
    if (tabActive) {
      tabActive.textContent = "Jendela Aktif (" + state.windows.length + ")";
      tabActive.className = "access-source-btn" + (state.appSource === "active" ? " active" : "");
    }
    if (tabInstalled) {
      tabInstalled.textContent = "Terinstall (" + state.installedApps.length + ")";
      tabInstalled.className = "access-source-btn" + (state.appSource === "installed" ? " active" : "");
    }
  }
  function setAppSource(source) {
    state.appSource = source;
    updateSourceTabs();
    state.selected = "";
    renderCandidateList();
    updateSelection();
    if (source === "installed" && !state.installedApps.length) {
      void refreshInstalledApps();
    }
  }
  function renderCandidateList() {
    const list = $("access-app-list");
    if (!list) return;
    list.replaceChildren();
    const query = ($("access-search")?.value || "").trim().toLowerCase();

    if (state.appSource === "active") {
      const candidates = state.windows.filter(w =>
        (w.application + " " + w.title).toLowerCase().includes(query));
      if (!candidates.length) {
        list.append(make("p", "access-empty", "Tidak ada jendela aktif cocok. Buka aplikasinya, klik Refresh, atau pilih tab Terinstall."));
      }
      for (const w of candidates) {
        const key = String(w.pid) + ":" + w.nativeId;
        const row = action("", "access-app-row" + (key === state.selected ? " selected" : ""), () => {
          state.selected = key;
          renderCandidateList();
          updateSelection();
        });
        const avatar = make("span", "access-app-avatar", (w.application[0] || "A").toUpperCase());
        const description = make("span", "access-app-description");
        description.append(make("strong", "", w.application), make("small", "", w.title + " (PID " + w.pid + ")"));
        const registered = (state.registry?.rules || []).some(r => {
          if (r.kind !== "desktop" || r.effect !== "allow") return false;
          const appMatches = appName(r.app?.executablePath).toLowerCase().replace(/\.exe$/, "") ===
            w.application.toLowerCase().replace(/\.exe$/, "");
          if (!appMatches) return false;
          return r.scope?.windowTitle === w.title || !r.scope?.windowTitle;
        });
        const badge = make("span", "access-app-badge" + (registered ? " registered" : ""),
          registered ? "Aturan ada" : "Belum");
        row.append(avatar, description, badge);
        list.append(row);
      }
    } else {
      const candidates = state.installedApps.filter(a =>
        (a.name + " " + (a.executablePath || "")).toLowerCase().includes(query));
      if (!candidates.length) {
        list.append(make("p", "access-empty", "Tidak ada aplikasi terinstall cocok. Gunakan tombol '📁 .exe' untuk memilih executable langsung."));
      }
      for (const a of candidates) {
        const key = "installed:" + a.executablePath;
        const row = action("", "access-app-row" + (key === state.selected ? " selected" : ""), () => {
          state.selected = key;
          renderCandidateList();
          updateSelection();
        });
        const avatar = make("span", "access-app-avatar installed", (a.name[0] || "A").toUpperCase());
        const description = make("span", "access-app-description");
        description.append(make("strong", "", a.name), make("small", "", a.executablePath));
        const registered = (state.registry?.rules || []).some(r => {
          if (r.kind !== "desktop" || r.effect !== "allow") return false;
          return (r.app?.executablePath || "").toLowerCase() === a.executablePath.toLowerCase() ||
            appName(r.app?.executablePath).toLowerCase().replace(/\.exe$/, "") === a.name.toLowerCase().replace(/\.exe$/, "");
        });
        const badge = make("span", "access-app-badge" + (registered ? " registered" : ""),
          registered ? "Aturan ada" : "Belum");
        row.append(avatar, description, badge);
        list.append(row);
      }
    }
  }
  function updateSelection() {
    const target = selectedTarget();
    const title = $("access-selected-title");
    if (title) title.textContent = target ? target.name : "Pilih aplikasi";
    const sub = $("access-selected-subtitle");
    if (sub) sub.textContent = target
      ? target.desc
      : (state.appSource === "active"
          ? "Pilih jendela aktif dari daftar untuk registrasi."
          : "Pilih aplikasi terinstall dari daftar untuk registrasi.");
    const exactWrap = $("access-exact")?.parentNode;
    if ($("access-exact")) {
      if (target?.type === "installed") {
        $("access-exact").checked = false;
        $("access-exact").disabled = true;
        if (exactWrap?.style) {
          exactWrap.style.opacity = "0.5";
        }
        if (exactWrap) exactWrap.title = "Aturan aplikasi terinstall berlaku untuk seluruh jendela executable ini";
      } else {
        $("access-exact").disabled = state.busy;
        if (exactWrap?.style) {
          exactWrap.style.opacity = "1";
        }
        if (exactWrap) exactWrap.title = "";
      }
    }
    const submit = $("access-submit");
    if (submit) submit.disabled = state.busy || (state.view === "file"
      ? !$("access-file-path")?.value.trim()
      : !target);
  }
  function setRuleFilter(filter) {
    state.ruleFilter = filter;
    for (const [id, val] of [["access-tab-all", "all"], ["access-tab-desktop", "desktop"], ["access-tab-file", "file"]]) {
      const el = $(id);
      if (el) {
        if (val === filter) el.className = "access-filter-btn active";
        else el.className = "access-filter-btn";
      }
    }
    renderRules();
  }
  function updateBulkBar(filteredRules) {
    const bulkBar = $("access-rule-bulk-bar");
    if (!bulkBar) return;
    const allRules = state.registry?.rules || [];
    if (!allRules.length) {
      bulkBar.hidden = true;
      return;
    }
    bulkBar.hidden = false;

    const filtered = Array.isArray(filteredRules) ? filteredRules : [];
    const selectAllCheck = $("access-rule-select-all");
    const selectAllLabel = $("access-rule-select-all-label");
    const selectedCount = $("access-rule-selected-count");
    const bulkRevokeBtn = $("access-rule-bulk-revoke");
    const bulkClearBtn = $("access-rule-bulk-clear");

    let countInFiltered = 0;
    for (const r of filtered) {
      if (state.selectedRuleIds.has(r.id)) countInFiltered++;
    }

    if (selectAllCheck) {
      selectAllCheck.disabled = state.busy || filtered.length === 0;
      selectAllCheck.checked = filtered.length > 0 && countInFiltered === filtered.length;
      selectAllCheck.indeterminate = countInFiltered > 0 && countInFiltered < filtered.length;
    }
    if (selectAllLabel) {
      selectAllLabel.textContent = filtered.length ? "Pilih semua (" + filtered.length + ")" : "Pilih semua";
    }
    const totalSelected = state.selectedRuleIds.size;
    if (selectedCount) {
      selectedCount.textContent = totalSelected === 0 ? "0 dipilih" : totalSelected + " dipilih";
    }
    if (bulkRevokeBtn) {
      bulkRevokeBtn.disabled = state.busy || totalSelected === 0;
      bulkRevokeBtn.textContent = totalSelected > 0 ? "Cabut (" + totalSelected + ") Terpilih" : "Cabut Terpilih";
    }
    if (bulkClearBtn) {
      bulkClearBtn.hidden = totalSelected === 0;
      bulkClearBtn.disabled = state.busy;
    }
  }
  function renderRules() {
    const list = $("access-rule-list");
    const count = $("access-rule-count");
    const empty = $("access-onboarding");
    if (!list) return;
    list.replaceChildren();
    const allRules = state.registry?.rules || [];
    if (count) count.textContent = allRules.length + " aturan";
    if (empty) empty.hidden = allRules.length > 0;
    const ruleBadge = $("access-tab-badge-rules");
    if (ruleBadge) ruleBadge.textContent = String(allRules.length);

    const desktopCount = allRules.filter(r => r.kind === "desktop").length;
    const fileCount = allRules.filter(r => r.kind === "file").length;
    const tabAll = $("access-tab-all");
    const tabDesktop = $("access-tab-desktop");
    const tabFile = $("access-tab-file");
    if (tabAll) tabAll.textContent = "Semua (" + allRules.length + ")";
    if (tabDesktop) tabDesktop.textContent = "Desktop (" + desktopCount + ")";
    if (tabFile) tabFile.textContent = "File & Folder (" + fileCount + ")";
    // Akses proyek mengizinkan seluruh operasi dalam ruang lingkup proyek sesuai capability;
    // aturan aktif berfungsi sebagai lapisan kontrol kedua untuk aplikasi dan path file/folder.
    for (const id of ["access-host-file-rule-count", "access-project-host-file-rule-count"]) {
      const summary = $(id);
      if (summary) summary.textContent = fileCount + " aturan aktif file/folder tercatat (lapisan kontrol kedua).";
    }

    const query = (state.ruleSearch || "").trim().toLowerCase();
    const filtered = allRules.filter(r => {
      if (state.ruleFilter !== "all" && r.kind !== state.ruleFilter) return false;
      if (!query) return true;
      const app = appName(r.app?.executablePath).toLowerCase();
      const path = (r.kind === "desktop" ? (r.scope?.windowTitle || "") : (r.scope?.path || "")).toLowerCase();
      const ops = (r.operations || []).join(" ").toLowerCase();
      return app.includes(query) || path.includes(query) || ops.includes(query);
    });

    // Prune stale selected rule IDs
    const validRuleIdSet = new Set(allRules.map(r => r.id));
    for (const id of state.selectedRuleIds) {
      if (!validRuleIdSet.has(id)) state.selectedRuleIds.delete(id);
    }
    updateBulkBar(filtered);

    if (!allRules.length) {
      list.append(make("p", "access-empty",
        "Belum ada aplikasi tepercaya. Registrasikan aplikasi dan pilih operasi yang diperbolehkan."));
      return;
    }
    if (!filtered.length) {
      list.append(make("p", "access-empty", "Tidak ada aturan yang cocok dengan filter atau pencarian."));
      return;
    }
    for (const rule of filtered) {
      const isSelected = state.selectedRuleIds.has(rule.id);
      const row = make("div", "access-rule-row" + (isSelected ? " is-selected" : ""));
      row.dataset.ruleId = rule.id;

      const symbol = make("label", "access-rule-effect " + rule.effect + " access-rule-select-cell");
      const check = make("input", "access-rule-checkbox");
      check.type = "checkbox";
      check.checked = isSelected;
      check.setAttribute("aria-label", "Pilih aturan " + rule.id);
      const onToggle = () => {
        if (check.checked) {
          state.selectedRuleIds.add(rule.id);
          row.classList.add("is-selected");
        } else {
          state.selectedRuleIds.delete(rule.id);
          row.classList.remove("is-selected");
        }
        updateBulkBar(filtered);
      };
      check.addEventListener("change", onToggle);
      check.addEventListener("click", onToggle);
      symbol.append(check, make("span", "", rule.effect === "deny" ? "Blokir" : "Izinkan"));

      const detail = make("div", "access-rule-detail");

      const headerLine = make("div", "access-rule-header");
      const title = make("strong", "access-rule-title", appName(rule.app?.executablePath));
      const kindBadge = make("span", "access-scope-badge " + rule.kind,
        rule.kind === "desktop" ? "Desktop" : "File");
      const chips = make("span", "access-op-chips");
      for (const op of (rule.operations || [])) {
        const chip = make("span", "access-op-chip op-" + op, op);
        chips.append(chip);
      }
      headerLine.append(title, kindBadge, chips);

      const scopeDesc = rule.kind === "desktop"
        ? [rule.scope.windowTitle || "Semua jendela aplikasi terverifikasi",
            rule.scope.elementRole ? "Role: " + rule.scope.elementRole : "",
            rule.scope.elementLabel ? "Label: " + rule.scope.elementLabel : ""].filter(Boolean).join(" · ")
        : rule.scope.path + (rule.scope.recursive ? " (termasuk subfolder)" : "");
      const pathMeta = make("small", "access-rule-path", rule.app.executablePath);
      pathMeta.title = rule.app.executablePath;
      const infoMeta = make("small", "access-rule-meta",
        "Permanen sampai dicabut · SHA-256: " + rule.app.sha256.slice(0, 12) + "…");
      detail.append(
        headerLine,
        make("small", "access-rule-scope", scopeDesc),
        pathMeta,
        infoMeta
      );
      const revoke = action("Cabut", "access-revoke", () => void revokeRule(rule.id));
      revoke.setAttribute("aria-label", "Cabut aturan " + rule.id);
      revoke.disabled = state.busy;
      row.append(symbol, detail, revoke);
      list.append(row);
    }
  }
  async function refreshWindows() {
    if (state.busy) return;
    status("Memeriksa jendela native yang sedang berjalan...");
    try {
      const result = await invoke("list_desktop_input_windows");
      if (!result || result.success !== true || !Array.isArray(result.windows) || result.windows.length > 100)
        throw Error("Inventaris jendela tidak valid");
      state.windows = result.windows.filter(validWindow);
      if (state.appSource === "active" && !selectedWindow()) state.selected = "";
      updateSourceTabs();
      renderCandidateList();
      updateSelection();
      status(state.windows.length + " jendela aktif ditemukan. Pilih aplikasi untuk membuat aturan.");
    } catch {
      state.windows = [];
      if (state.appSource === "active") state.selected = "";
      updateSourceTabs();
      renderCandidateList();
      updateSelection();
      status("Jendela tidak bisa diverifikasi. Periksa Core dan fokuskan Tray.", "error");
    }
  }
  async function refreshInstalledApps() {
    if (state.busy) return;
    status("Memeriksa aplikasi terinstall pada sistem...");
    try {
      const list = await invoke("list_installed_desktop_apps");
      if (!Array.isArray(list)) throw Error("Inventaris aplikasi terinstall tidak valid");
      state.installedApps = list.filter(a => a && typeof a.name === "string" && typeof a.executablePath === "string");
      if (state.appSource === "installed" && !selectedInstalledApp()) state.selected = "";
      updateSourceTabs();
      renderCandidateList();
      updateSelection();
      status(state.installedApps.length + " aplikasi terinstall ditemukan. Pilih aplikasi untuk membuat aturan.");
    } catch (error) {
      state.installedApps = [];
      if (state.appSource === "installed") state.selected = "";
      updateSourceTabs();
      renderCandidateList();
      updateSelection();
      status("Gagal mendeteksi aplikasi terinstall: " + String(error), "warning");
    }
  }
  async function pickExecutable() {
    if (state.busy) return;
    try {
      const chosen = await invoke("pick_permanent_access_executable");
      if (!chosen) return;
      const name = appName(chosen).replace(/\.exe$/i, "");
      const existing = state.installedApps.find(a => a.executablePath.toLowerCase() === chosen.toLowerCase());
      if (!existing) {
        state.installedApps.unshift({ name, executablePath: chosen });
      }
      setAppSource("installed");
      state.selected = "installed:" + chosen;
      renderCandidateList();
      updateSelection();
      updateSourceTabs();
      status("Executable terpilih: " + name + ". Siap diregistrasikan.", "info");
    } catch (error) {
      status("Pemilihan executable gagal: " + String(error), "error");
    }
  }
  function registryValid(value) {
    return value && value.version === 2 && value.defaultEffect === "deny" &&
      Array.isArray(value.rules) && value.rules.length <= 128;
  }
  function renderRegistry() {
    const summary = $("access-policy-summary");
    if (summary) summary.textContent =
      "Default: Blokir · " + state.registry.rules.length + " aturan · Tanpa kedaluwarsa";
    renderCandidateList();
    renderRules();
  }
  async function refreshRegistry() {
    const next = await invoke("get_permanent_access_registry");
    if (!registryValid(next)) throw Error("Native registry v2 tidak valid");
    state.registry = next;
    renderRegistry();
  }
  async function registerRule() {
    if (state.busy) return;
    const kind = state.view;
    const target = selectedTarget();
    if (kind === "desktop" && !target) return;
    const operations = [];
    if (kind === "desktop") {
      if ($("access-view")?.checked) operations.push("view");
      if ($("access-input")?.checked) operations.push("input");
      if ($("access-element-label")?.value.trim() && !$("access-element-role")?.value.trim()) {
        status("Isi role elemen terlebih dahulu jika membatasi label.", "error");
        return;
      }
    } else {
      if ($("access-file-read")?.checked) operations.push("read");
      if ($("access-file-write")?.checked) operations.push("write");
      if ($("access-file-delete")?.checked) operations.push("delete");
      if (!$("access-file-path")?.value.trim()) {
        status("Pilih file atau folder melalui dialog native terlebih dahulu.", "error");
        return;
      }
    }
    if (!operations.length) {
      status("Pilih setidaknya satu operasi yang diizinkan/diblokir.", "error");
      return;
    }
    setBusy(true);
    status("Konfirmasi aturan permanen lewat dialog native...");
    try {
      const registry = await invoke("register_permanent_access_rule", {
        pid: kind === "desktop" ? target.pid : 0,
        nativeId: kind === "desktop" ? target.nativeId : "",
        effect: $("access-effect").value,
        kind, operations,
        exactWindow: kind === "desktop" && target.type === "active" && $("access-exact").checked,
        elementRole: kind === "desktop" ? ($("access-element-role").value.trim() || null) : null,
        elementLabel: kind === "desktop" ? ($("access-element-label").value.trim() || null) : null,
        filePath: kind === "file" ? $("access-file-path").value.trim() : null,
        recursive: kind === "file" ? $("access-file-recursive").checked : null,
        executablePath: kind === "desktop" && target.type === "installed" ? target.path : null,
      });
      if (!registryValid(registry)) throw Error("Respons registrasi tidak valid");
      state.registry = registry;
      renderRegistry();
      void refreshAuditLog();
      status("Aturan permanen tersimpan. Berlaku sampai kamu mencabutnya.", "success");
    } catch (error) {
      status("Registrasi tidak diterapkan: " + String(error), "error");
    } finally {
      setBusy(false);
    }
  }
  async function revokeRule(id) {
    if (state.busy || typeof id !== "string") return;
    setBusy(true);
    try {
      const registry = await invoke("revoke_permanent_access_rule", {id});
      if (!registryValid(registry)) throw Error("Respons pencabutan tidak valid");
      state.registry = registry;
      state.selectedRuleIds.delete(id);
      renderRegistry();
      void refreshAuditLog();
      status("Aturan dicabut. Sesi input berikutnya akan ditolak.", "success");
    } catch (error) {
      status("Gagal mencabut aturan: " + String(error), "error");
    } finally {
      setBusy(false);
    }
  }
  async function revokeRulesBulk(ids) {
    if (state.busy || !Array.isArray(ids) || !ids.length) return;
    const validIds = ids.filter(id => typeof id === "string" && id.length > 0);
    if (!validIds.length) return;
    if (typeof window.confirm === "function" && !window.confirm(
      "Cabut " + validIds.length + " aturan permanen terpilih? Tindakan ini tidak dapat dibatalkan.")) return;
    setBusy(true);
    status("Mencabut " + validIds.length + " aturan terpilih...", "info");
    let successCount = 0;
    let lastError = null;
    for (const id of validIds) {
      try {
        const registry = await invoke("revoke_permanent_access_rule", { id });
        if (registryValid(registry)) {
          state.registry = registry;
          state.selectedRuleIds.delete(id);
          successCount++;
        }
      } catch (err) {
        lastError = err;
      }
    }
    renderRegistry();
    void refreshAuditLog();
    setBusy(false);
    if (lastError && successCount === 0) {
      status("Gagal mencabut aturan terpilih: " + String(lastError?.message || lastError), "error");
    } else if (lastError) {
      status("Dicabut " + successCount + " dari " + validIds.length + " aturan. Beberapa gagal: " + String(lastError?.message || lastError), "warning");
    } else {
      status("Berhasil mencabut " + successCount + " aturan permanen.", "success");
    }
  }
  function formatTime(ts) {
    if (!ts) return "";
    try {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return "";
    }
  }
  function renderAuditLog() {
    const list = $("access-audit-list");
    const count = $("access-audit-count");
    if (!list) return;
    list.replaceChildren();
    if (count) count.textContent = state.auditLogs.length + " rekaman";
    const auditBadge = $("access-tab-badge-audit");
    if (auditBadge) {
      auditBadge.textContent = String(state.auditLogs.length);
      auditBadge.title = state.auditLogs.length + " rekaman audit akses host";
      auditBadge.setAttribute("aria-label", auditBadge.title);
    }
    if (!state.auditLogs.length) {
      list.append(make("p", "access-empty", "Belum ada rekaman audit aktivitas akses."));
      return;
    }
    for (const entry of state.auditLogs) {
      const row = make("div", "access-audit-row");
      const isAllow = entry.effect === "allow";
      const verdict = make("span", "access-audit-verdict " + (isAllow ? "allow" : "deny"),
        isAllow ? "IZIN" : "BLOKIR");
      const info = make("div", "access-audit-info");
      const top = make("div", "access-audit-top");
      top.append(
        make("strong", "access-audit-app", entry.application || "Unknown"),
        make("span", "access-audit-op", entry.operation || ""),
        make("span", "access-audit-time", formatTime(entry.timestamp))
      );
      const target = make("small", "access-audit-target", entry.target || entry.executablePath || "");
      target.title = entry.target || entry.executablePath || "";
      info.append(top, target);
      row.append(verdict, info);
      list.append(row);
    }
  }
  async function refreshAuditLog() {
    try {
      const logs = await invoke("get_permanent_access_audit_log", { limit: 50 });
      if (Array.isArray(logs)) {
        state.auditLogs = logs;
        renderAuditLog();
      }
    } catch {
      // Gracefully ignore on legacy Tray or mock without audit log command
    }
  }
  async function clearAuditLog() {
    if (state.busy) return;
    if (typeof window.confirm !== "function" || !window.confirm(
      "Bersihkan seluruh log audit akses native? Tindakan ini tidak dapat dibatalkan.")) return;
    setBusy(true);
    try {
      await invoke("clear_permanent_access_audit_log");
      state.auditLogs = [];
      renderAuditLog();
      status("Log audit akses berhasil dibersihkan.", "success");
    } catch (e) {
      status("Gagal membersihkan log audit: " + String(e), "error");
    } finally {
      setBusy(false);
    }
  }
  async function pickFile(directory) {
    if (state.busy) return;
    setBusy(true);
    try {
      const selected = await invoke("pick_permanent_access_path",{directory});
      if (typeof selected === "string" && selected.length > 0 && selected.length <= 2048) {
        $("access-file-path").value = selected;
        $("access-file-recursive").checked = directory;
        status("Path dipilih dan dikonfirmasi native: " + selected);
      }
    } catch (error) {
      status("Pemilih file gagal: " + String(error), "error");
    } finally {
      setBusy(false);
    }
  }
  function viewChanged() {
    state.view = $("access-kind")?.value === "file" ? "file" : "desktop";
    $("access-desktop-controls").hidden = state.view !== "desktop";
    $("access-file-controls").hidden = state.view !== "file";
    if (state.view === "file") {
      status("Aturan file hanya berlaku untuk operasi file yang dikelola Core SuperAgent. Aplikasi lain tidak disandbox.", "warning");
    } else {
      status("Atur akses native desktop tanpa batas waktu. Pencabutan tersedia setiap saat.");
    }
    updateSelection();
  }
  function setRequestSubTab(subTab) {
    state.requestSubTab = ["all", "incoming", "rules", "desktop"].includes(subTab) ? subTab : "all";
    for (const [id, val] of [
      ["access-req-subtab-all", "all"],
      ["access-req-subtab-incoming", "incoming"],
      ["access-req-subtab-rules", "rules"],
      ["access-req-subtab-desktop", "desktop"],
    ]) {
      const btn = $(id);
      if (btn) btn.className = "access-filter-btn" + (state.requestSubTab === val ? " active" : "");
    }
    const grid = $("access-req-center-grid");
    const incomingCard = $("access-req-center-incoming-card");
    const rulesCard = $("access-req-center-rules-card");
    const desktopCard = $("access-req-center-desktop-card");
    const projectHistoryCard = $("access-req-center-project-history-card");
    const ruleHistoryCard = $("access-req-center-rules-history-card");
    const desktopHistoryCard = $("access-req-center-desktop-history-card");
    if (incomingCard) incomingCard.hidden = state.requestSubTab === "rules" || state.requestSubTab === "desktop";
    if (rulesCard) rulesCard.hidden = state.requestSubTab === "incoming" || state.requestSubTab === "desktop";
    if (desktopCard) desktopCard.hidden = state.requestSubTab === "incoming" || state.requestSubTab === "rules";
    if (projectHistoryCard) projectHistoryCard.hidden = state.requestSubTab !== "incoming";
    if (ruleHistoryCard) ruleHistoryCard.hidden = state.requestSubTab !== "rules";
    if (desktopHistoryCard) desktopHistoryCard.hidden = state.requestSubTab !== "desktop";
    if (grid) {
      grid.className = "access-req-center-grid" + (state.requestSubTab !== "all" ? " is-single" : "");
    }
  }
  function setActiveTab(tabName) {
    state.activeTab = tabName;
    const tabRequests = $("access-nav-tab-requests");
    const tabRegister = $("access-nav-tab-register");
    const tabRules = $("access-nav-tab-rules");
    const tabAudit = $("access-nav-tab-audit");
    const tabMcp = $("access-nav-tab-mcp");
    const tabConnections = $("access-nav-tab-connections");
    const paneRequests = $("access-pane-requests");
    const paneRegister = $("access-pane-register");
    const paneRules = $("access-pane-rules");
    const paneAudit = $("access-pane-audit");
    const paneMcp = $("access-pane-mcp");
    const paneConnections = $("access-pane-connections");

    if (tabRequests) {
      const active = tabName === "requests";
      tabRequests.className = "access-nav-tab" + (active ? " active" : "");
      tabRequests.setAttribute("aria-selected", active ? "true" : "false");
      tabRequests.tabIndex = active ? 0 : -1;
    }
    if (tabRegister) {
      const active = tabName === "register";
      tabRegister.className = "access-nav-tab" + (active ? " active" : "");
      tabRegister.setAttribute("aria-selected", active ? "true" : "false");
      tabRegister.tabIndex = active ? 0 : -1;
    }
    if (tabRules) {
      const active = tabName === "rules";
      tabRules.className = "access-nav-tab" + (active ? " active" : "");
      tabRules.setAttribute("aria-selected", active ? "true" : "false");
      tabRules.tabIndex = active ? 0 : -1;
    }
    if (tabAudit) {
      const active = tabName === "audit";
      tabAudit.className = "access-nav-tab" + (active ? " active" : "");
      tabAudit.setAttribute("aria-selected", active ? "true" : "false");
      tabAudit.tabIndex = active ? 0 : -1;
    }

    if (tabMcp) {
      const active = (tabName === "mcp");
      tabMcp.className = "access-nav-tab" + (active ? " active" : "");
      tabMcp.setAttribute("aria-selected", active ? "true" : "false");
      tabMcp.tabIndex = active ? 0 : -1;
    }

    if (tabConnections) {
      const active = tabName === "connections";
      tabConnections.className = "access-nav-tab" + (active ? " active" : "");
      tabConnections.setAttribute("aria-selected", active ? "true" : "false");
      tabConnections.tabIndex = active ? 0 : -1;
    }
    if (paneRequests) {
      paneRequests.hidden = tabName !== "requests";
      if (tabName === "requests") {
        void refreshMcpRequests();
        void refreshPendingRuleRequests();
      }
    }
    if (paneConnections) {
      paneConnections.hidden = tabName !== "connections";
      if (tabName === "connections") void refreshMcpRequests();
    }
    if (paneRegister) paneRegister.hidden = (tabName !== "register");
    if (paneRules) paneRules.hidden = (tabName !== "rules");
    if (paneAudit) paneAudit.hidden = (tabName !== "audit");
    if (paneMcp) {
      paneMcp.hidden = (tabName !== "mcp");
      if (tabName === "mcp") void refreshMcpRequests();
    }
  }
  function updateTabFromHash() {
    const hash = typeof location !== "undefined" ? location.hash || "" : "";
    if (hash.includes(":requests")) {
      setActiveTab("requests");
    } else if (hash.includes(":audit")) {
      setActiveTab("audit");
    } else if (hash.includes(":rules")) {
      setActiveTab("rules");
    } else if (hash.includes(":connections") || hash.includes(":connection")) {
      setActiveTab("connections");
    } else if (hash.includes(":mcp") || hash.includes(":projects")) {
      setActiveTab("mcp");
    } else if (hash.includes(":register")) {
      setActiveTab("register");
    }
  }
  function showInitialSetupReminder() {
    if (!document.body?.appendChild || (state.registry?.rules || []).length > 0 ||
        $("access-initial-setup-reminder")) return;
    const reminder = make("section", "access-setup-reminder");
    reminder.id = "access-initial-setup-reminder";
    reminder.setAttribute("aria-label", "SuperAgent first-run access registration");
    const message = make("div");
    message.append(make("strong", "", "Atur izin aplikasi SuperAgent"),
      make("p", "", "Belum ada aplikasi yang diizinkan. Daftarkan aplikasi tepercaya sekali tanpa batas waktu."));
    const controls = make("div", "access-reminder-controls");
    controls.append(action("Buka Access Manager", "access-submit", () => {
      if (typeof location !== "undefined") location.hash = "#security";
      reminder.remove();
    }), action("Nanti", "access-revoke", () => reminder.remove()));
    reminder.append(message, controls);
    document.body.appendChild(reminder);
  }

  function buildMcpConnectionsPane() {
    const pane = make("section", "access-pane access-mcp-section");
    pane.id = "access-pane-connections";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", "access-nav-tab-connections");
    pane.hidden = true;

    const introduction = make("div", "access-editor access-mcp-intro");
    const introHead = make("div", "access-mcp-intro-head");
    const introCopy = make("div", "access-mcp-intro-copy");
    introCopy.append(
      make("h3", "", "Koneksi MCP"),
      make("p", "access-mcp-description",
        "Koneksi MCP hanya untuk otorisasi dan pemantauan koneksi OAuth. Hak operasi Read, Write, Execute, Git, dan lainnya dikelola di Akses Proyek. Mode YOLO tidak menambah izin.")
    );
    const introRefresh = action("Muat ulang", "access-audit-refresh",
      () => void refreshMcpRequests({ queueIfBusy: true }));
    introRefresh.id = "access-mcp-connections-refresh";
    introHead.append(introCopy, introRefresh);
    introduction.append(introHead);

    const notice = make("div", "access-mcp-load-error");
    notice.id = "access-mcp-connection-load-error";
    notice.setAttribute("role", "alert");
    notice.hidden = true;

    const oauthCard = make("section", "access-stored access-mcp-card");
    oauthCard.append(
      make("h3", "", "Permintaan Koneksi MCP"),
      make("p", "access-hint",
        "Persetujuan koneksi baru dilakukan melalui alur OAuth MCP owner. Otorisasi koneksi tidak memberikan hak menjalankan tools. Untuk mengatur operasi, buka Akses Proyek, pilih identitas, proyek, dan capability."),
    );
    const connectionLoad = action("Load", "access-audit-refresh",
      () => void refreshMcpRequests({ queueIfBusy: true }));
    connectionLoad.id = "access-mcp-connection-pending-load";
    connectionLoad.title = "Muat ulang sesi koneksi MCP";
    oauthCard.append(connectionLoad);
    const workspaceGrid = make("div", "access-mcp-grid access-mcp-grid-workspace");
    workspaceGrid.append(oauthCard);

    const connectedCard = make("section", "access-stored access-mcp-card");
    const connectedHead = make("div", "access-stored-head");
    connectedHead.append(
      make("h3", "", "Sesi MCP Terhubung"),
      make("span", "access-count", "Memeriksa…"),
    );
    connectedHead.lastChild.id = "access-mcp-live-summary";
    connectedCard.append(connectedHead,
      make("p", "access-hint",
        "Sesi berasal dari MCP owner terverifikasi. Nama klien adalah klaim klien, bukan identitas yang otomatis berhak mendapat izin."));
    const connectedList = make("div", "access-mcp-identities access-mcp-scroll-list");
    connectedList.id = "access-mcp-live-list";
    connectedCard.append(connectedList);

    const registeredCard = make("section", "access-stored access-mcp-card");
    const registeredHead = make("div", "access-stored-head");
    registeredHead.append(
      make("h3", "", "Koneksi MCP Tercatat"),
      make("span", "access-count", "Memeriksa…"),
    );
    registeredHead.lastChild.id = "access-mcp-registered-summary";
    const registeredList = make("div", "access-mcp-identities access-mcp-scroll-list");
    registeredList.id = "access-mcp-registered-list";
    registeredCard.append(registeredHead,
      make("p", "access-hint",
        "Dikelompokkan berdasarkan identitas kredensial terautentikasi, bukan URL MCP. Terdaftar adalah identitas kredensial yang pernah diamati, bukan izin operasi. Hak operasi hanya melalui Akses Proyek."),
      registeredList);

    const telemetryGrid = make("div", "access-mcp-grid access-mcp-grid-equal");
    telemetryGrid.append(connectedCard, registeredCard);

    const identityCard = make("section", "access-stored access-mcp-card");
    const identityHead = make("div", "access-stored-head");
    const identityRefresh = action("Muat ulang", "access-audit-refresh",
      () => void refreshMcpRequests({ queueIfBusy: true }));
    identityRefresh.id = "access-mcp-identity-refresh";
    identityHead.append(make("h3", "", "Identitas MCP Terverifikasi"), identityRefresh);
    identityCard.append(identityHead);
    identityCard.append(make("p", "access-hint",
      "Menampilkan identitas yang terdeteksi oleh Core atau dari permintaan akses terbaru; tidak semuanya sedang online."));
    const identities = make("div", "access-mcp-identities access-mcp-scroll-list");
    identities.id = "access-mcp-identity-list";
    identityCard.append(identities);

    const secondaryGrid = make("div", "access-mcp-grid access-mcp-grid-secondary");
    secondaryGrid.append(identityCard);

    pane.append(introduction, notice, workspaceGrid, telemetryGrid, secondaryGrid);
    return pane;
  }

  function buildMcpPane() {
    const pane = make("div", "access-pane");
    pane.id = "access-pane-mcp";
    pane.className += " access-mcp-section";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", "access-nav-tab-mcp");
    pane.hidden = true;

    const banner = make("div", "access-editor access-mcp-intro");
    const bannerHead = make("div", "access-mcp-intro-head");
    const bannerCopy = make("div", "access-mcp-intro-copy");
    const bannerTitle = make("h3", "", "Akses Proyek");
    const bannerDesc = make("p", "access-mcp-description", "Atur kemampuan per identitas MCP dan proyek terdaftar: Read, Write, Execute, Git, Worktree, Planning, dan Workspace Chain. Otorisasi koneksi OAuth saja tidak memberi izin operasi; aturan aplikasi dan file di host tetap berlaku.");
    bannerCopy.append(bannerTitle, bannerDesc);
    const bannerRefresh = action("Muat ulang", "access-audit-refresh",
      () => void refreshMcpRequests({ queueIfBusy: true }));
    bannerRefresh.id = "access-mcp-projects-refresh";
    bannerHead.append(bannerCopy, bannerRefresh);
    banner.append(bannerHead);
    const hostBoundary = make("div", "access-mcp-grant-form");
    hostBoundary.id = "access-project-host-boundary";
    hostBoundary.append(
      make("strong", "", "Lapisan kedua: Aturan Aktif (Aplikasi & File)"),
      make("p", "access-hint",
        "Akses Proyek mengizinkan operasi di dalam ruang lingkup proyek sesuai capability yang diberikan. Aturan Aktif bertindak sebagai lapisan perlindungan kedua untuk menentukan aplikasi serta file/folder (termasuk di luar proyek) yang diizinkan atau diblokir."),
    );
    const projectHostCount = make("p", "access-hint", "Memeriksa aturan host file/folder…");
    projectHostCount.id = "access-project-host-file-rule-count";
    const projectHostActions = make("div", "access-mcp-pending-controls");
    const configureHostFiles = action("Atur Batas File Host", "access-audit-refresh", () => {
      const kind = $("access-kind");
      if (kind) kind.value = "file";
      setActiveTab("register");
      viewChanged();
    });
    configureHostFiles.id = "access-project-open-file-editor";
    const inspectHostFiles = action("Lihat Aturan File Aktif", "access-audit-refresh", () => {
      setRuleFilter("file");
      setActiveTab("rules");
    });
    inspectHostFiles.id = "access-project-open-file-rules";
    projectHostActions.append(configureHostFiles, inspectHostFiles);
    hostBoundary.append(projectHostCount, projectHostActions);
    banner.append(hostBoundary);

    const loadError = make("div", "access-mcp-load-error");
    loadError.id = "access-mcp-project-load-error";
    loadError.setAttribute("role", "alert");
    loadError.hidden = true;

    // Registration adds project metadata only; each MCP identity still needs
    // a separate, attended Security Approval decision for capabilities.
    const projectSection = make("section", "access-stored access-project-registry access-mcp-card");
    const projectHead = make("div", "access-project-head");
    const projectTitle = make("div");
    projectTitle.append(make("h3", "", "Proyek Terdaftar"),
      make("p", "access-hint", "Daftarkan folder lokal, SSH, atau Workspace Chain. Izin setiap agent tetap terpisah."));
    const projectForm = make("div", "access-project-form");
    projectForm.id = "access-project-form";
    projectForm.hidden = true;
    let editingProject = null;
    const toggleProject = action("+ Tambah Proyek", "access-submit access-project-add", () => {
      if (editingProject) resetProjectEditor();
      projectForm.hidden = !projectForm.hidden;
      toggleProject.textContent = projectForm.hidden ? "+ Tambah Proyek" : "Tutup Form";
      toggleProject.setAttribute("aria-expanded", String(!projectForm.hidden));
    });
    toggleProject.id = "access-project-add";
    toggleProject.setAttribute("aria-expanded", "false");
    toggleProject.setAttribute("aria-controls", "access-project-form");
    projectHead.append(projectTitle, toggleProject);

    const projectName = make("input", "access-search");
    projectName.id = "access-project-name"; projectName.maxLength = 120;
    projectName.placeholder = "Contoh: Tryout Online";
    const projectId = make("input", "access-search");
    projectId.id = "access-project-id"; projectId.maxLength = 63;
    projectId.placeholder = "Opsional, otomatis dari nama";
    const projectType = select("access-project-type", [["local", "Folder lokal"], ["ssh", "SSH"], ["chain", "Workspace Chain"]]);
    const projectLocal = make("div", "access-project-target");
    projectLocal.id = "access-project-local";
    const projectPath = make("input", "access-search");
    projectPath.id = "access-project-root"; projectPath.readOnly = true;
    projectPath.placeholder = "Pilih folder proyek...";
    const chooseFolder = action("Pilih Folder", "access-revoke access-project-folder", async () => {
      chooseFolder.disabled = true;
      try {
        const chosen = await invoke("pick_permanent_access_path", { directory: true });
        if (typeof chosen === "string" && chosen.trim()) projectPath.value = chosen;
      } catch (error) { status("Tidak dapat memilih folder: " + String(error?.message || error), "error"); }
      finally { chooseFolder.disabled = false; }
    });
    chooseFolder.id = "access-project-browse";
    projectLocal.append(projectPath, chooseFolder);
    const projectRemote = make("div");
    projectRemote.id = "access-project-remote"; projectRemote.hidden = true;
    const projectTarget = make("input", "access-search");
    projectTarget.id = "access-project-target"; projectTarget.maxLength = 2048;
    projectTarget.placeholder = "ssh://user@host/absolute/path";
    projectRemote.append(field("SSH / Workspace Chain", projectTarget,
      "SSH: ssh://user@host/path (tanpa password) · Chain: chain:existing-chain-id."));
    projectType.addEventListener("change", () => {
      projectLocal.hidden = projectType.value !== "local";
      projectRemote.hidden = projectType.value === "local";
      projectTarget.placeholder = projectType.value === "chain"
        ? "chain:existing-chain-id" : "ssh://user@host/absolute/path";
    });
    const projectDesc = make("input", "access-search");
    projectDesc.id = "access-project-description"; projectDesc.maxLength = 500;
    projectDesc.placeholder = "Opsional";
    const resetProjectEditor = () => {
      editingProject = null;
      projectName.value = ""; projectId.value = ""; projectDesc.value = "";
      projectPath.value = ""; projectTarget.value = "";
      projectId.readOnly = false; projectType.disabled = false; projectType.value = "local";
      projectLocal.hidden = false; projectRemote.hidden = true;
      projectSubmit.textContent = "Daftarkan Proyek";
      toggleProject.textContent = "+ Tambah Proyek";
      toggleProject.setAttribute("aria-expanded", "false");
    };
    const projectSubmit = action("Daftarkan Proyek", "access-submit access-project-save", async () => {
      const name = projectName.value.trim();
      const id = projectId.value.trim();
      const description = projectDesc.value.trim();
      const type = projectType.value;
      const target = type === "local" ? projectPath.value.trim() : projectTarget.value.trim();
      if (!name || name.length > 120 || !target || !["local", "ssh", "chain"].includes(type) ||
          (id && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) ||
          (type === "chain" && !/^chain:[a-z0-9][a-z0-9-]{0,62}$/.test(target))) {
        status("Lengkapi nama dan target; Project ID hanya huruf kecil, angka, atau tanda hubung.", "warning");
        return;
      }
      projectSubmit.disabled = true;
      try {
        const actionName = editingProject ? "update_project" : "register_project";
        const payload = editingProject
          ? { projectId: editingProject.projectId, expectedUpdatedAt: editingProject.updatedAt,
              name, description, ...(type === "local" ? { root: target } : { target }) }
          : { name, type, ...(id ? { id } : {}),
              ...(description ? { description } : {}),
              ...(type === "local" ? { root: target } : { target }) };
        const response = await invoke("mcp_project_access_action",
          { action: actionName, payload });
        if (!response?.success || response.capabilitiesGranted !== false ||
            !response.project?.projectId) {
          throw Error(response?.error || "Core belum mengonfirmasi registrasi tanpa izin MCP.");
        }
        const message = editingProject ? " diperbarui." : " terdaftar.";
        resetProjectEditor();
        projectForm.hidden = true;
        status("Proyek " + response.project.projectId + message +
          " Izin MCP tetap dikelola terpisah.", "success");
        await refreshMcpRequests({ queueIfBusy: true });
        const selectProject = $("access-mcp-proj-select");
        if (selectProject?.children && Array.from(selectProject.children)
            .some(item => item.value === response.project.projectId)) {
          selectProject.value = response.project.projectId;
        }
      } catch (error) {
        const message = String(error?.message || error);
        const friendly = {
          PROJECT_DUPLICATE_ID: "Project ID sudah digunakan. Pilih ID berbeda.",
          PROJECT_DUPLICATE_ROOT: "Folder sudah terdaftar sebagai proyek lain.",
          PROJECT_CHAIN_NOT_FOUND: "Workspace Chain belum terdaftar.",
          PROJECT_STALE_REVISION: "Proyek telah berubah. Muat ulang sebelum menyimpan.",
          PROJECT_NOT_FOUND: "Proyek tidak ditemukan. Muat ulang.",
          PROJECT_INVALID_ROOT: "Folder proyek tidak valid atau sudah berpindah.",
        };
        const code = Object.keys(friendly).find(key => message.includes(key));
        status("Gagal menyimpan proyek: " + (code ? friendly[code] : message), "error");
      } finally {
        projectSubmit.disabled = false;
      }
    });
    projectSubmit.id = "access-project-save";
    projectForm.append(
      field("Nama proyek", projectName),
      field("Project ID", projectId, "ID tetap untuk pemilihan project oleh agent MCP."),
      field("Jenis proyek", projectType),
      projectLocal, projectRemote,
      field("Deskripsi", projectDesc),
      make("p", "access-hint", "Registrasi tidak memberi izin kepada agent. Setelah berhasil, pilih identitas dan capability di bagian bawah."),
      projectSubmit
    );
    const projectSearch = make("input", "access-search access-project-search");
    projectSearch.id = "access-project-search"; projectSearch.type = "search";
    projectSearch.placeholder = "Cari nama, ID, atau lokasi proyek...";
    projectSearch.addEventListener("input", () => renderProjectInventory());
    const projectList = make("div", "access-project-list access-mcp-scroll-list");
    projectList.id = "access-project-list";
    projectSection.append(projectHead, projectForm, projectSearch, projectList);
    // Only native Core mutations are permitted; this callback alters editor
    // state but never writes a project or grants a capability.
    window.__superagentEditProject = project => { editingProject = project; };

    // Section 2: Direct Grant Form
    const grantSection = make("section", "access-editor access-mcp-card");
    const grantTitle = make("h3", "", "Berikan Akses Proyek ke Agent MCP");
    const grantDesc = make("p", "access-hint", "Default tidak ada akses di luar izin yang diberikan. Akses Proyek mengizinkan akses keseluruhan di dalam ruang lingkup proyek sesuai capability yang dipilih; Aturan Aktif bertindak sebagai perlindungan kedua untuk menentukan aplikasi serta file/folder (termasuk di luar proyek) yang dapat diakses.");

    const grantForm = make("div", "access-mcp-grant-form");
    grantForm.id = "access-mcp-direct-grant-form";

    const identField = field("Identitas MCP", select("access-mcp-ident-select", [["", "Memuat identitas terverifikasi..."]]), "Identitas terverifikasi atau dari permintaan terbaru; tidak semua sedang online.");
    const projField = field("Proyek Terdaftar & Aktif", select("access-mcp-proj-select", [["", "Memuat daftar proyek..."]]), "Tidak termasuk proyek yang belum terdaftar atau dinonaktifkan.");

    const capsWrap = make("div", "access-field");
    const capsLabel = make("span", "access-field-title", "Hak Akses (Capabilities)");
    const capsGrid = make("div", "access-mcp-capabilities");

    capsGrid.append(
      checkbox("access-cap-read", "Read (Baca)", true),
      checkbox("access-cap-write", "Write (Tulis/Edit)", false),
      checkbox("access-cap-execute", "Execute (Terminal)", false),
      checkbox("access-cap-git", "Git", false),
      checkbox("access-cap-worktree", "Worktree", false),
      checkbox("access-cap-planning", "Planning", false),
      checkbox("access-cap-chain", "Workspace Chain", false)
    );
    capsWrap.append(capsLabel, capsGrid);

    const grantBtn = action("Tinjau Izin Proyek", "access-submit access-mcp-primary", async () => {
      const identHandle = $("access-mcp-ident-select")?.value;
      const projId = $("access-mcp-proj-select")?.value;
      if (!identHandle || !projId) {
        status("Pilih agen dan proyek target terlebih dahulu.", "warn");
        return;
      }
      const caps = [];
      if ($("access-cap-read")?.checked) caps.push("read");
      if ($("access-cap-write")?.checked) caps.push("write");
      if ($("access-cap-execute")?.checked) caps.push("execute");
      if ($("access-cap-git")?.checked) caps.push("git");
      if ($("access-cap-worktree")?.checked) caps.push("worktree");
      if ($("access-cap-planning")?.checked) caps.push("planning");
      if ($("access-cap-chain")?.checked) caps.push("chain");
      if (caps.length === 0) {
        status("Pilih minimal satu capability.", "warn");
        return;
      }
      // Native Tauri review is mandatory; no WebView self-approval.
      try {
        status("Memberikan hak akses proyek...", "info");
        const data = await invoke("mcp_project_access_action", {
          action: "direct_grant",
          payload: { identityHandle: identHandle, projectId: projId, capabilities: caps },
        });
        if (data.success) {
          status("Izin proyek '" + projId + "' berhasil diberikan.", "success");
          void refreshMcpRequests();
        } else {
          status("Gagal: " + (data.error || "Gagal memberikan izin"), "error");
        }
      } catch (err) {
        status("Error: " + err.message, "error");
      }
    });

    grantBtn.id = "access-mcp-project-grant";
    const toolChoiceNote = make("p", "access-hint", "Pilih tool di Inventaris Tools MCP untuk menyiapkan capability yang dibutuhkan, lalu tinjau keputusan dalam dialog native. Tidak ada izin yang diberikan otomatis.");
    toolChoiceNote.id = "access-mcp-tool-selection-note";
    grantForm.append(identField, projField, capsWrap, toolChoiceNote, grantBtn);
    $("access-mcp-ident-select")?.addEventListener("change", () => void refreshMcpToolCatalog());
    $("access-mcp-proj-select")?.addEventListener("change", () => void refreshMcpToolCatalog());
    grantSection.append(grantTitle, grantDesc, grantForm);

    const workspaceGrid = make("div", "access-mcp-grid access-mcp-grid-workspace");
    workspaceGrid.append(projectSection, grantSection);
    const toolsSection = make("section", "access-stored access-mcp-card access-mcp-tools-card");
    toolsSection.id = "access-mcp-tool-catalog";
    const toolsHead = make("div", "access-stored-head");
    const toolsTitle = make("div");
    toolsTitle.append(make("h3", "", "Inventaris Tools MCP"),
      make("p", "access-hint", "Semua tool aktif, klasifikasi, kebutuhan OAuth/proyek, dan sertifikasi file host. Status hanya diagnosis, bukan bukti tool dapat dieksekusi."));
    const toolCount = make("span", "access-count", "Belum dimuat");
    toolCount.id = "access-mcp-tool-count";
    const toolRefresh = action("Muat ulang", "access-audit-refresh", () => void refreshMcpToolCatalog());
    toolRefresh.id = "access-mcp-tool-refresh";
    toolsHead.append(toolsTitle, toolCount, toolRefresh);
    const toolFilters = make("div", "access-mcp-tool-filters");
    const toolSearch = make("input", "access-search");
    toolSearch.type = "search";
    toolSearch.id = "access-mcp-tool-search";
    toolSearch.placeholder = "Cari tool, deskripsi, capability…";
    toolSearch.setAttribute("aria-label", "Cari tools MCP");
    toolSearch.addEventListener("input", () => {
      toolState.query = toolSearch.value.trim().toLowerCase();
      toolState.shown = 25; renderMcpToolCatalog();
    });
    const toolFilter = select("access-mcp-tool-filter", [
      ["all", "Semua tools"], ["host_uncertified", "Terblokir host policy"],
      ["missing", "Grant proyek belum ada"], ["granted", "Grant proyek tercatat"],
      ["action_dependent", "Butuh parameter operasi"], ["file_rules_required", "Butuh aturan file"],
      ["dangerous", "Operasi berisiko"], ["read_only", "Read-only"],
    ]);
    toolFilter.setAttribute("aria-label", "Filter status tool MCP");
    toolFilter.addEventListener("change", () => {
      toolState.filter = toolFilter.value;
      toolState.shown = 25; renderMcpToolCatalog();
    });
    toolFilters.append(toolSearch, toolFilter);
    const toolSummary = make("p", "access-summary", "Memuat inventaris dari Core…");
    toolSummary.id = "access-mcp-tool-summary";
    toolSummary.setAttribute("role", "status");
    const matrixInspector = make("div", "access-mcp-matrix-inspector");
    matrixInspector.id = "access-mcp-matrix-inspector";
    matrixInspector.hidden = true;
    const toolList = make("div", "access-mcp-tool-list");
    toolList.id = "access-mcp-tool-list";
    const toolMore = action("Tampilkan 25 lagi", "access-audit-refresh", () => {
      toolState.shown += 25; renderMcpToolCatalog();
    });
    toolMore.id = "access-mcp-tool-more";
    toolMore.hidden = true;
    toolsSection.append(toolsHead, toolFilters, toolSummary, matrixInspector, toolList, toolMore);

    const legacySection = make("section", "access-stored access-mcp-card");
    legacySection.id = "access-mcp-legacy-requests";
    legacySection.hidden = true;
    legacySection.append(make("h3", "", "Permintaan izin koneksi lama"),
      make("p", "access-hint", "Permintaan Execute proyek virtual mcp-connection sudah tidak valid. Permintaan lama boleh ditolak melalui tinjauan native, tetapi tidak boleh disetujui atau dipindahkan otomatis."));
    const legacyList = make("div", "access-mcp-list");
    legacyList.id = "access-mcp-legacy-list";
    legacySection.append(legacyList);

    pane.append(banner, loadError, workspaceGrid, projectSection, toolsSection, legacySection);
    return pane;
  }

  const mcpCache = { requests: null, identities: null, projects: null, inventory: null, live: null, tools: null, refreshing: null, refreshQueued: false };
  const toolState = { query: "", filter: "all", shown: 25, requestSeq: 0 };
  const mcpNotificationFocus = { id: null, didFocus: false };

  function toolGrantMessage(tool) {
    if (tool.approvalKind === "operator_admin")
      return "Aksi operator: memerlukan OAuth admin dan persetujuan native; tidak melalui grant project biasa.";
    if (tool.approvalKind === "target_dependent")
      return "Gateway: capability dan batas host mengikuti tool/parameter target, bukan izin gateway umum.";
    if (tool.approvalKind === "request_only")
      return "Mengajukan permintaan saja; pemberian izin tetap melalui keputusan operator.";
    if (tool.approvalKind === "read_only")
      return "Tidak memerlukan grant proyek untuk metadata ini; OAuth dan pembatas host tetap berlaku.";
    const messages = {
      granted: "Akses proyek aktif untuk scope proyek sesuai capability; tetap tunduk pada Aturan Aktif bila menyasar aplikasi/file di luar proyek.",
      missing: "Akses proyek belum diberikan kepada identitas yang dipilih (default ditolak).",
      choose_identity_project: "Pilih identitas MCP dan proyek untuk memeriksa Akses Proyek.",
      identity_unavailable: "Identitas tidak ditemukan/terverifikasi; sambungkan kembali MCP.",
      project_unavailable: "Proyek tidak tersedia, dinonaktifkan, atau bukan target lokal yang sesuai.",
      policy_unavailable: "Registry izin proyek tidak dapat diperiksa; gagal tertutup.",
      action_dependent: "Capability bervariasi menurut tindakan; pilih tindakan sebelum meninjau Akses Proyek.",
    };
    return messages[tool.grantState] || "Izin proyek dan Aturan Aktif diperiksa saat eksekusi.";
  }

  function inspectToolMatrix(tool) {
    const inspector = $("access-mcp-matrix-inspector");
    if (!inspector) return;
    inspector.replaceChildren();
    inspector.hidden = false;

    const head = make("div", "access-mcp-matrix-head");
    head.append(
      make("strong", "", "Matrix & Preflight: " + tool.name),
      make("span", "access-mcp-tool-badge " + (tool.risk === "dangerous" ? "is-risky" : ""), tool.risk === "dangerous" ? "Berisiko" : "Read-only")
    );

    const closeBtn = action("Tutup", "access-audit-refresh", () => {
      inspector.hidden = true;
      inspector.replaceChildren();
    });
    closeBtn.id = "access-mcp-matrix-close";
    head.append(closeBtn);

    const grid = make("div", "access-mcp-matrix-grid");
    const addField = (label, val, isFlag, isWarn) => {
      const field = make("div", "access-mcp-matrix-field");
      field.append(make("span", "access-mcp-matrix-label", label));
      field.append(make("span", "access-mcp-matrix-val" + (isWarn ? " is-blocked" : isFlag ? " is-ready" : ""), String(val)));
      grid.append(field);
    };

    addField("OAuth Scopes", Array.isArray(tool.oauthScopesRequired) ? tool.oauthScopesRequired.join(", ") : "mcp:tools");
    addField("Project Capability", tool.capability || (tool.capabilitiesByAction ? "action-dependent" : "none"));
    addField("Host Requirement", tool.hostRequirement || "none");
    addField("Host Readiness", tool.hostReadiness || "unknown", false, tool.hostBlocked);
    addField("Staging Ingress", tool.name.includes("chrome") || tool.name.includes("upload") ? "Certified Ingress (0o700)" : "Standard Execution");
    addField("Preflight Baseline", tool.hostBlocked ? "host_policy_blocked" : tool.grantState === "missing" ? "project_grant_missing" : "ready", tool.grantState === "granted" && !tool.hostBlocked, tool.hostBlocked);

    inspector.append(head, grid);
    inspector.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    status("Inspeksi Matrix & Preflight dibuka untuk " + tool.name, "info");
  }

  function reviewToolCapability(tool, capability) {
    const identity = $("access-mcp-ident-select")?.value;
    const project = $("access-mcp-proj-select")?.value;
    if (!identity || !project) {
      status("Pilih Identitas MCP dan Proyek Terdaftar & Aktif terlebih dahulu sebelum meninjau izin tool.", "warning");
      (!identity ? $("access-mcp-ident-select") : $("access-mcp-proj-select"))?.focus?.();
      return;
    }
    const known = ["read","write","execute","git","worktree","planning","chain"];
    if (!known.includes(capability)) {
      status("Tool belum memiliki capability tetap. Pilih operasi yang tepat untuk diperiksa.", "warning");
      return;
    }
    for (const cap of known) {
      const control = $("access-cap-" + cap);
      if (control) control.checked = cap === capability;
    }
    const note = $("access-mcp-tool-selection-note");
    if (note) note.textContent = "Pratinjau saja: " + tool.name + " memerlukan " + capability +
      " pada proyek " + project + ". Periksa risiko dan batas host sebelum menekan Tinjau Izin Proyek. Tidak ada grant otomatis.";
    $("access-mcp-direct-grant-form")?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    status("Capability " + capability + " dipilih untuk " + tool.name + ". Belum ada izin yang diberikan.", "info");
  }

  function renderMcpToolCatalog() {
    const list = $("access-mcp-tool-list");
    if (!list) return;
    list.replaceChildren();
    const data = mcpCache.tools;
    const count = $("access-mcp-tool-count");
    const summary = $("access-mcp-tool-summary");
    const more = $("access-mcp-tool-more");
    if (!data || !Array.isArray(data.tools)) {
      if (count) count.textContent = "Tidak tersedia";
      if (summary) summary.textContent = "Inventaris Core belum tersedia. Periksa koneksi lalu pilih Muat ulang.";
      if (more) more.hidden = true;
      list.append(make("p", "access-empty", "Data belum terverifikasi; status tool tidak ditampilkan dari cache lama."));
      return;
    }
    const query = toolState.query;
    const filtered = data.tools.filter(tool => {
      if (query && ![tool.name,tool.description,tool.capability,tool.hostReadiness]
          .some(value => String(value || "").toLowerCase().includes(query))) return false;
      switch (toolState.filter) {
        case "host_uncertified": return tool.hostBlocked;
        case "missing": return tool.grantState === "missing" || Object.values(tool.actionGrantStates || {}).includes("missing");
        case "granted": return tool.grantState === "granted" || Object.values(tool.actionGrantStates || {}).includes("granted");
        case "action_dependent": return tool.operationStatus === "check_action_arguments" || Boolean(tool.capabilitiesByAction);
        case "file_rules_required": return tool.operationStatus === "file_rules_required";
        case "dangerous": return tool.risk === "dangerous";
        case "read_only": return tool.risk === "safe";
        default: return true;
      }
    });
    if (count) count.textContent = data.active + " aktif · " + data.disabled + " nonaktif";
    if (summary) summary.textContent = filtered.length + " dari " + data.active +
      " tools · " + data.counts.hostBlocked + " diblokir host policy · " +
      data.counts.missingProjectGrant + " memerlukan grant terpilih. Pemeriksaan bersifat informatif, bukan izin eksekusi.";
    if (more) {
      more.hidden = filtered.length <= toolState.shown;
      more.textContent = "Tampilkan " + Math.min(25, Math.max(0, filtered.length-toolState.shown)) + " berikutnya";
    }
    if (!filtered.length) {
      list.append(make("p", "access-empty", "Tidak ada tools yang cocok dengan pencarian dan filter."));
      return;
    }
    for (const tool of filtered.slice(0, toolState.shown)) {
      const row = make("article", "access-mcp-tool-row");
      row.dataset.toolName = tool.name;
      const header = make("div", "access-mcp-tool-head");
      header.append(make("strong", "access-mcp-tool-name", tool.name));
      const flags = make("div", "access-mcp-tool-badges");
      const riskBadge = make("span", "access-mcp-tool-badge " +
        (tool.risk === "dangerous" ? "is-risky" : ""), tool.risk === "dangerous" ? "Berisiko" : "Read-only");
      const hostBadge = make("span", "access-mcp-tool-badge " +
        (tool.hostBlocked ? "is-blocked" : ""), String(tool.hostReadiness).replace(/_/g," "));
      flags.append(riskBadge,hostBadge);
      if (tool.capability) flags.append(make("span", "access-mcp-tool-badge", "Proyek: " + tool.capability));
      header.append(flags);
      const description = make("p", "access-mcp-tool-description", String(tool.description || ""));
      const grant = make("p", "access-mcp-tool-grant", toolGrantMessage(tool));
      const oauth = make("p", "access-hint", "OAuth: " +
        (Array.isArray(tool.oauthScopesRequired) ? tool.oauthScopesRequired.join(" + ") : "perlu verifikasi"));
      const host = make("p", "access-hint", tool.hostBlocked
        ? "Tunduk pada Aturan Aktif / policy: " + tool.hostRequirement +
          " Pastikan grant proyek dan aturan aktif sesuai untuk scope target."
        : "Aturan aktif: " + tool.hostRequirement);
      const buttons = make("div", "access-mcp-tool-actions");
      if (tool.approvalKind === "project") {
        let actionSelect = null;
        const actionEntries = tool.capabilitiesByAction && typeof tool.capabilitiesByAction === "object"
          ? Object.entries(tool.capabilitiesByAction).filter(([, cap]) => typeof cap === "string" && cap)
          : [];
        if (actionEntries.length) {
          const isGitTool = tool.name.includes("git");
          actionSelect = select(
            "access-mcp-tool-git-action-" + tool.name,
            actionEntries.map(([act, cap]) => [
              act,
              (isGitTool ? "Git " : "") + act + " (" + cap.charAt(0).toUpperCase() + cap.slice(1) + ")",
            ])
          );
          actionSelect.setAttribute("aria-label", "Pilih operasi untuk " + tool.name);
          const showAction = () => {
            const act = actionSelect.value;
            const cap = tool.capabilitiesByAction[act];
            const st = tool.actionGrantStates?.[act] || tool.grantState;
            grant.textContent = (isGitTool ? "Git " : "Aksi ") + act + " memerlukan " + cap + ". " +
              (st === "granted" ? "Akses proyek aktif dalam scope proyek; Aturan Aktif berlaku sebagai perlindungan kedua." :
                st === "missing" ? "Akses proyek untuk tindakan ini belum diberikan (default ditolak)." :
                  toolGrantMessage(tool));
          };
          actionSelect.addEventListener("change", showAction);
          buttons.append(actionSelect);
          showAction();
        }
        const review = action("Tinjau Izin Proyek", "access-audit-refresh", () => {
          const capability = tool.capabilitiesByAction
            ? tool.capabilitiesByAction[actionSelect?.value] : tool.capability;
          reviewToolCapability(tool, capability);
        });
        review.id = "access-mcp-tool-review-" + tool.name;
        buttons.append(review);
      }
      if (tool.hostBlocked || tool.operationStatus === "file_rules_required") {
        const isDesktopTool = tool.name === "superagent_desktop_ui" ||
          String(tool.hostRequirement || "").toLowerCase().includes("desktop");
        const inspect = action("Periksa Kebijakan Host", "access-audit-refresh", () => {
          setRuleFilter(isDesktopTool ? "desktop" : "file");
          setActiveTab("rules");
          status("Aturan host terpisah dari grant proyek. Tool uncertified memerlukan implementasi sertifikasi; membuat aturan Allow tidak otomatis memperbaikinya.", "warning");
        });
        inspect.id = "access-mcp-tool-host-" + tool.name;
        buttons.append(inspect);
      }
      const inspectMatrix = action("Matrix & Preflight", "access-audit-refresh", () => {
        inspectToolMatrix(tool);
      });
      inspectMatrix.id = "access-mcp-tool-matrix-" + tool.name;
      inspectMatrix.title = "Inspeksi Unified Capability Matrix dan status Preflight";
      buttons.append(inspectMatrix);
      row.append(header, description, grant, oauth, host, buttons);
      list.append(row);
    }
  }

  async function refreshMcpToolCatalog() {
    const seq = ++toolState.requestSeq;
    const button = $("access-mcp-tool-refresh");
    if (button) button.disabled = true;
    mcpCache.tools = null; // stale grants must never survive selection changes
    renderMcpToolCatalog();
    const identity = $("access-mcp-ident-select")?.value || "";
    const project = $("access-mcp-proj-select")?.value || "";
    try {
      const payload = {
        ...(identity ? {identityHandle:identity} : {}),
        ...(project ? {projectId:project} : {}),
      };
      const data = await invoke("mcp_project_access_action", {action:"tools",payload});
      if (seq !== toolState.requestSeq) return;
      if (!data?.success || !Array.isArray(data.tools) ||
          !Number.isSafeInteger(data.active) || data.active !== data.tools.length ||
          data.tools.length > 512 || new Set(data.tools.map(t => t.name)).size !== data.tools.length)
        throw Error("Core mengirim katalog tools yang tidak lengkap/valid.");
      mcpCache.tools = data;
      renderMcpToolCatalog();
    } catch (error) {
      if (seq !== toolState.requestSeq) return;
      mcpCache.tools = null;
      renderMcpToolCatalog();
      const summary = $("access-mcp-tool-summary");
      if (summary) summary.textContent =
        "Inventaris tools gagal dimuat: " + String(error?.message || error) +
        ". Tidak ada izin yang otomatis diberikan.";
    } finally {
      if (seq === toolState.requestSeq && button) button.disabled = false;
    }
  }

  function renderLegacyMcpRequests(allRequests) {
    const root = $("access-mcp-legacy-requests");
    const list = $("access-mcp-legacy-list");
    if (!root || !list) return;
    list.replaceChildren();
    const legacy = Array.isArray(allRequests)
      ? allRequests.filter(req => req.projectId === "mcp-connection" && req.status === "pending") : [];
    root.hidden = legacy.length === 0;
    for (const req of legacy) {
      const row = make("article", "access-mcp-request-card");
      row.dataset.requestId = String(req.requestId || "");
      row.append(make("strong", "", "Permintaan lama · " + String(req.subject || "MCP client")),
        make("p", "access-hint", "Izin koneksi Execute global sudah tidak berlaku. Jangan dipindahkan ke grant proyek otomatis."));
      const deny = action("Tolak permintaan lama", "access-revoke", async () => {
        deny.disabled = true;
        try { await executeMcpDecision("deny", req.requestId, "Penolakan permintaan lama"); }
        finally { deny.disabled = false; }
      });
      row.append(deny);
      list.append(row);
    }
  }

  function highlightMcpNotificationRequest() {
    const id = mcpNotificationFocus.id;
    if (!id) return false;
    const mcpTarget = Array.isArray(mcpCache.requests)
      ? mcpCache.requests.find((request) => request.requestId === id)
      : null;
    const ruleTarget = Array.isArray(state.pendingRuleRequests)
      ? state.pendingRuleRequests.find((request) => request.id === id)
      : null;
    const desktopTarget = Array.isArray(state.pendingDesktopUiRequests)
      ? state.pendingDesktopUiRequests.find((request) => request.requestId === id)
      : null;
    if (!mcpTarget && !ruleTarget && !desktopTarget) return false;
    if (desktopTarget) {
      if (state.activeTab !== "requests") setActiveTab("requests");
      if (state.requestSubTab !== "desktop") setRequestSubTab("desktop");
    } else if (ruleTarget) {
      if (state.activeTab !== "requests") setActiveTab("requests");
      if (state.requestSubTab === "incoming" || state.requestSubTab === "desktop") setRequestSubTab("all");
    } else if (mcpTarget) {
      const legacyConnectionRequest = mcpTarget.projectId === "mcp-connection";
      if (legacyConnectionRequest) {
        if (state.activeTab !== "mcp") setActiveTab("mcp");
        status("Permintaan izin koneksi lama tidak berlaku. Buka penolakan permintaan lama di Akses Proyek; buat grant baru pada proyek terdaftar jika diperlukan.", "warning");
      } else if (state.activeTab !== "requests" && state.activeTab !== "mcp") {
        setActiveTab("requests");
      }
    }
    for (const listId of [
      "access-req-center-incoming-list",
      "access-req-center-rules-list",
      "access-req-center-rules-history",
      "access-req-center-desktop-list",
      "access-req-center-desktop-history",
      "access-mcp-pending-list",
      "access-mcp-legacy-list",
      "access-mcp-history-list",
    ]) {
      const root = $(listId);
      if (!root) continue;
      for (const entry of root.children) {
        if (entry.dataset.requestId !== id) continue;
        entry.classList.add("access-mcp-request-highlight");
        if (!mcpNotificationFocus.didFocus) {
          entry.tabIndex = -1;
          entry.focus({ preventScroll: true });
          entry.scrollIntoView?.({ behavior: "smooth", block: "center" });
          mcpNotificationFocus.didFocus = true;
        }
      }
    }
    return mcpNotificationFocus.didFocus === true;
  }
  function setMcpLoadError(id, problems) {
    const node = $(id);
    if (!node) return;
    node.hidden = problems.length === 0;
    node.textContent = problems.length ? "Data belum lengkap: " + problems.join(" · ") +
      ". Periksa koneksi Core lalu klik Muat ulang. Data lama (jika ada) belum diverifikasi ulang." : "";
  }

  function humanMcpTarget(req) {
    return req.projectId === "mcp-connection" ? "Permintaan lama (tidak berlaku)" :
      String(req.projectName || req.projectId || "Proyek");
  }

  function notifyMcpDecision(kind, label, requestId) {
    window.TrayFeedback?.notify?.({
      kind,
      message: kind === "success"
        ? label + " berhasil."
        : label + " gagal. Lihat detail pada Access Manager.",
      scope: "security",
      dedupeKey: "mcp-project-access:" + requestId + ":" + kind,
    });
  }

  async function executeMcpDecision(actionName, requestId, label, capabilities) {
    try {
      const result = await invoke("mcp_project_access_action", {
        action: actionName, payload: { requestId, ...(capabilities ? { capabilities } : {}) },
      });
      if (!result?.success) throw Error(result?.error || "Core menolak tindakan ini.");
    } catch (error) {
      status(label + " gagal: " + String(error?.message || error), "error");
      notifyMcpDecision("error", label, requestId);
      return;
    }

    status(label + " berhasil.", "success");
    notifyMcpDecision("success", label, requestId);
    try {
      await refreshMcpRequests({ queueIfBusy: true });
    } catch (error) {
      status(label + " berhasil, tetapi daftar permintaan gagal dimuat: " +
        String(error?.message || error), "warning");
    }
  }

  function renderMcpPending(id, requests, isConnection, idPrefix = "approval") {
    const root = $(id);
    if (!root) return;
    root.replaceChildren();
    if (!Array.isArray(requests)) {
      root.append(make("p", "access-empty", "Permintaan belum dapat dimuat. Gunakan Muat ulang."));
      return;
    }
    if (!requests.length) {
      root.append(make("p", "access-empty", "Tidak ada permintaan izin " +
        (isConnection ? "koneksi" : "proyek") + " yang menunggu persetujuan."));
      return;
    }
    for (const req of requests) {
      const card = make("article", "access-mcp-request-card");
      card.dataset.requestId = String(req.requestId || "");
      const title = make("div", "access-mcp-request-head");
      const ownerName = typeof req.ownerConnectionName === "string" &&
        req.ownerConnectionName.trim() ? req.ownerConnectionName : null;
      title.append(
        make("strong", "", ownerName || String(req.subject || "Identitas MCP tidak dikenal")),
        make("span", "access-mcp-meta", String(req.mode || "") +
          " · " + (req.createdAt ? new Date(req.createdAt).toLocaleString() : "Waktu tidak tersedia"))
      );
      const ownerSubtitle = ownerName
        ? make("div", "access-mcp-meta", "Nama dari persetujuan OAuth · identitas: " + String(req.subject || "(tidak diketahui)"))
        : null;
      const scope = make("div", "access-mcp-target", humanMcpTarget(req));
      const pathAndReason = [String(req.projectPath || ""), String(req.reason || "")].filter(Boolean).join(" · ");
      const description = pathAndReason ? make("p", "access-mcp-description", pathAndReason) : null;
      const chips = make("div", "access-mcp-capabilities");
      const selections = [];
      for (const cap of Array.isArray(req.capabilities) ? req.capabilities : []) {
        const checkLabel = checkbox(idPrefix + "-" + req.requestId + "-" + cap, String(cap), true);
        const input = checkLabel.firstChild;
        selections.push({ capability: cap, input });
        chips.append(checkLabel);
      }
      const actions = make("div", "access-mcp-actions");
      const approve = action("Tinjau & Setujui", "access-submit", async () => {
        const target = humanMcpTarget(req);
        const selected = selections.filter(item => item.input?.checked).map(item => item.capability);
        if (!selected.length) {
          status("Pilih setidaknya satu capability yang akan disetujui.", "warning");
          return;
        }
        // Final review and human confirmation happen in the native Tray dialog.
        approve.disabled = true;
        try { await executeMcpDecision("approve", req.requestId, "Persetujuan " + target, selected); }
        finally { approve.disabled = false; }
      });
      const deny = action("Tolak", "access-revoke", async () => {
        deny.disabled = true;
        try { await executeMcpDecision("deny", req.requestId, "Penolakan " + humanMcpTarget(req)); }
        finally { deny.disabled = false; }
      });
      actions.append(approve, deny);
      card.append(title, ...(ownerSubtitle ? [ownerSubtitle] : []), scope, ...(description ? [description] : []), chips, actions);
      root.append(card);
    }
  }

  function updateRequestCenterBadges() {
    const projectKnown = Array.isArray(mcpCache.requests);
    const rulesKnown = Array.isArray(state.pendingRuleRequests);
    const desktopKnown = Array.isArray(state.pendingDesktopUiRequests);
    const projectPending = projectKnown
      ? mcpCache.requests.filter(req => req.projectId !== "mcp-connection" && req.status === "pending")
      : [];
    const rulePending = rulesKnown
      ? state.pendingRuleRequests.filter(req => req.status === "pending")
      : [];
    const desktopPending = desktopKnown
      ? state.pendingDesktopUiRequests.filter(req => req.status === "pending")
      : [];
    const total = projectPending.length + rulePending.length + desktopPending.length;
    const allKnown = projectKnown && rulesKnown && desktopKnown;

    const badgeTotal = $("access-tab-badge-requests");
    if (badgeTotal) {
      badgeTotal.textContent = allKnown ? String(total) : "!";
      badgeTotal.className = "access-nav-tab-badge" + (!allKnown ? " pending" : total > 0 ? " pending" : " zero");
      badgeTotal.title = allKnown ? "" : "Some Request Center queues are unavailable; counts are incomplete.";
    }
    const subAll = $("access-req-subtab-all");
    const subIncoming = $("access-req-subtab-incoming");
    const subRules = $("access-req-subtab-rules");
    const subDesktop = $("access-req-subtab-desktop");
    if (subAll) subAll.textContent = "Semua (" + (allKnown ? total : "!") + ")";
    if (subIncoming) subIncoming.textContent = "Permintaan Akses Masuk (" + (projectKnown ? projectPending.length : "!") + ")";
    if (subRules) subRules.textContent = "Permintaan Aturan Aktif (" + (rulesKnown ? rulePending.length : "!") + ")";
    if (subDesktop) subDesktop.textContent = "Desktop Live (" + (desktopKnown ? desktopPending.length : "!") + ")";
    if ($("access-req-center-incoming-count")) {
      $("access-req-center-incoming-count").textContent = projectKnown ? projectPending.length + " permintaan" : "Data tidak tersedia";
    }
    if ($("access-req-center-rules-count")) {
      $("access-req-center-rules-count").textContent = rulesKnown ? rulePending.length + " permintaan" : "Data tidak tersedia";
    }
    if ($("access-req-center-desktop-count")) {
      $("access-req-center-desktop-count").textContent = desktopKnown ? desktopPending.length + " menunggu" : "Data tidak tersedia";
    }
    const permitBadge = $("access-rules-pending-permit-badge");
    if (permitBadge) {
      permitBadge.textContent = rulePending.length + " permintaan";
      permitBadge.className = "access-nav-tab-badge" + (rulePending.length > 0 ? " pending" : " zero");
    }
  }

  function renderPendingRuleRequests() {
    const list = $("access-req-center-rules-list");
    const histList = $("access-req-center-rules-history");
    const items = Array.isArray(state.pendingRuleRequests) ? state.pendingRuleRequests : null;
    if (!items) {
      if (list) {
        list.replaceChildren();
        list.append(make("p", "access-empty", "Requests could not be loaded. Select Reload to try again."));
      }
      if (histList) {
        histList.replaceChildren();
        histList.append(make("p", "access-empty", "Request history could not be loaded."));
      }
      updateRequestCenterBadges();
      return;
    }
    const pending = items.filter(req => req.status === "pending");
    const decided = items.filter(req => req.status !== "pending");
    updateRequestCenterBadges();

    if (list) {
      list.replaceChildren();
      if (!pending.length) {
        list.append(make("p", "access-empty", "Tidak ada permintaan aturan aktif yang menunggu persetujuan."));
      } else {
        for (const req of pending) {
          const card = make("article", "access-mcp-request-card");
          card.dataset.requestId = String(req.id || "");
          const headLine = make("div", "access-mcp-request-head");
          const kindBadge = make("span", "access-scope-badge " + (req.kind === "file" ? "file" : "desktop"),
            req.kind === "file" ? "File & Folder" : "Aplikasi Desktop");
          const effectBadge = make("span", "access-rule-effect " + (req.effect === "deny" ? "deny" : "allow"),
            req.effect === "deny" ? "Blokir" : "Izinkan");
          const leftHead = make("div", "access-rule-header");
          leftHead.append(make("strong", "", String(req.sourceName || "MCP / Host Client")), kindBadge, effectBadge);
          headLine.append(
            leftHead,
            make("span", "access-mcp-meta", req.createdAt ? new Date(req.createdAt).toLocaleString() : "")
          );

          const scopeText = String(req.targetPath || "") + (req.kind === "file" && req.recursive ? " (termasuk subfolder)" : "");
          const scopeEl = make("div", "access-mcp-target access-mcp-mono", scopeText);
          const reasonEl = req.reason ? make("p", "access-mcp-description", String(req.reason)) : null;

          const chips = make("div", "access-mcp-capabilities");
          const opSelections = [];
          for (const op of Array.isArray(req.operations) ? req.operations : []) {
            const checkLabel = checkbox("rule-req-" + req.id + "-" + op, String(op), true);
            opSelections.push({ op, input: checkLabel.firstChild });
            chips.append(checkLabel);
          }

          const actions = make("div", "access-mcp-actions");
          const approveBtn = action("Tinjau & Simpan ke Aturan Aktif", "access-submit", async () => {
            const selectedOps = opSelections.filter(item => item.input?.checked).map(item => item.op);
            if (!selectedOps.length) {
              status("Pilih minimal satu operasi untuk aturan aktif.", "warning");
              return;
            }
            approveBtn.disabled = true;
            try {
              const res = await invoke("approve_pending_active_rule_request", {
                requestId: req.id,
                operations: selectedOps,
              });
              if (res?.registry && registryValid(res.registry)) {
                state.registry = res.registry;
                renderRegistry();
              }
              if (Array.isArray(res?.requests)) {
                state.pendingRuleRequests = res.requests;
              } else {
                await refreshPendingRuleRequests();
              }
              renderPendingRuleRequests();
              void refreshAuditLog();
              status("Permintaan aturan aktif disetujui dan disimpan permanen.", "success");
            } catch (error) {
              status("Persetujuan aturan aktif gagal: " + String(error?.message || error), "error");
            } finally {
              approveBtn.disabled = false;
            }
          });
          const denyBtn = action("Tolak", "access-revoke", async () => {
            denyBtn.disabled = true;
            try {
              const next = await invoke("deny_pending_active_rule_request", { requestId: req.id });
              if (Array.isArray(next)) {
                state.pendingRuleRequests = next;
              } else {
                await refreshPendingRuleRequests();
              }
              renderPendingRuleRequests();
              void refreshAuditLog();
              status("Permintaan aturan aktif ditolak.", "success");
            } catch (error) {
              status("Penolakan aturan aktif gagal: " + String(error?.message || error), "error");
            } finally {
              denyBtn.disabled = false;
            }
          });
          actions.append(approveBtn, denyBtn);
          card.append(headLine, scopeEl, ...(reasonEl ? [reasonEl] : []), chips, actions);
          list.append(card);
        }
      }
    }

    if (histList) {
      histList.replaceChildren();
      if (!decided.length) {
        histList.append(make("p", "access-empty", "Belum ada riwayat keputusan aturan aktif."));
      } else {
        for (const req of decided.slice(0, 20)) {
          const row = make("div", "access-mcp-history-row");
          row.dataset.requestId = String(req.id || "");
          const details = make("div", "access-mcp-history-detail");
          const h = make("div", "access-mcp-history-head");
          h.append(
            make("strong", "", String(req.targetPath || "")),
            make("span", "access-mcp-state access-mcp-state-" + String(req.status || "unknown"),
              req.status === "approved" ? "Disetujui" : "Ditolak")
          );
          const meta = make("span", "access-mcp-meta",
            String(req.sourceName || "Client") + " · " +
            (Array.isArray(req.operations) ? req.operations.join(", ") : "") +
            " · " + new Date(req.decidedAt || req.createdAt || Date.now()).toLocaleString());
          details.append(h, meta);
          row.append(details);
          histList.append(row);
        }
      }
    }
  }

  async function refreshPendingRuleRequests() {
    try {
      const list = await invoke("get_pending_active_rule_requests");
      if (!Array.isArray(list)) throw Error("Core returned an invalid active-rule request list.");
      state.pendingRuleRequests = list;
      renderPendingRuleRequests();
      highlightMcpNotificationRequest();
      return { success: true };
    } catch (error) {
      state.pendingRuleRequests = null;
      renderPendingRuleRequests();
      updateRequestCenterBadges();
      return { success: false, error: String(error?.message || error) };
    }
  }

  function validDesktopUiSessionRequest(req) {
    return Boolean(req &&
      typeof req.requestId === "string" && /^desktop_req_[a-f0-9]{32}$/.test(req.requestId) &&
      typeof req.principalId === "string" && req.principalId.length > 0 && req.principalId.length <= 256 &&
      Number.isSafeInteger(req.pid) && req.pid > 0 &&
      typeof req.nativeId === "string" && req.nativeId.length > 0 && req.nativeId.length <= 256 &&
      typeof req.title === "string" && req.title.length > 0 && req.title.length <= 512 &&
      typeof req.application === "string" && req.application.length > 0 && req.application.length <= 256 &&
      ["view", "input"].includes(req.accessMode) &&
      Number.isSafeInteger(req.ttlMs) && req.ttlMs >= 60_000 && req.ttlMs <= 30 * 60_000 &&
      typeof req.reason === "string" && req.reason.length <= 240 &&
      Number.isSafeInteger(req.createdAt) && Number.isSafeInteger(req.expiresAt) &&
      ["pending", "approved", "denied", "consumed", "expired"].includes(req.status));
  }

  async function executeDesktopUiSessionRequestDecision(decision, requestId, button) {
    if (!["approve", "deny"].includes(decision) || typeof requestId !== "string") return;
    if (button) button.disabled = true;
    try {
      const result = await invoke("desktop_ui_session_requests_action", { action: decision, requestId });
      if (result?.success !== true || result?.request?.status !== (decision === "approve" ? "approved" : "denied")) {
        throw Error(result?.error || "Native Tray did not confirm the Desktop UI decision.");
      }
      status(decision === "approve"
        ? "Permintaan Desktop UI disetujui melalui dialog native. Agent harus menggunakan ID permintaan untuk membuka sesi."
        : "Permintaan Desktop UI ditolak melalui dialog native.", "success");
      window.TrayFeedback?.notify?.({
        kind: "success",
        message: decision === "approve" ? "Desktop UI session approved once." : "Desktop UI session request denied.",
        scope: "security",
        dedupeKey: "desktop-ui-session:" + requestId + ":" + decision,
      });
    } catch (error) {
      status("Keputusan Desktop UI gagal atau dibatalkan: " + String(error?.message || error), "error");
    } finally {
      await refreshDesktopUiSessionRequests();
      if (button) button.disabled = false;
    }
  }

  function renderDesktopUiSessionRequests() {
    const list = $("access-req-center-desktop-list");
    const histList = $("access-req-center-desktop-history");
    const items = Array.isArray(state.pendingDesktopUiRequests) &&
      state.pendingDesktopUiRequests.every(validDesktopUiSessionRequest)
      ? state.pendingDesktopUiRequests : null;
    updateRequestCenterBadges();
    if (!items) {
      if (list) {
        list.replaceChildren();
        list.append(make("p", "access-empty", "Desktop UI requests could not be loaded. Select Reload to try again."));
      }
      if (histList) {
        histList.replaceChildren();
        histList.append(make("p", "access-empty", "Desktop UI request history is unavailable."));
      }
      return;
    }
    const pending = items.filter(req => req.status === "pending");
    const decided = items.filter(req => req.status !== "pending");
    if (list) {
      list.replaceChildren();
      if (!pending.length) {
        list.append(make("p", "access-empty", "Tidak ada permintaan Desktop Live yang menunggu persetujuan."));
      } else {
        for (const req of pending) {
          const card = make("article", "access-mcp-request-card");
          card.dataset.requestId = req.requestId;
          const head = make("div", "access-mcp-request-head");
          const title = make("strong", "", req.application + " · " + req.title);
          const scope = make("span", "access-scope-badge desktop",
            req.accessMode === "input" ? "Viewer + Input" : "Viewer only");
          head.append(title, scope);
          const target = make("div", "access-mcp-target access-mcp-mono",
            "PID " + req.pid + " · " + req.nativeId);
          const meta = make("p", "access-mcp-meta",
            req.principalId + " · " + new Date(req.createdAt).toLocaleString() +
            " · " + Math.round(req.ttlMs / 60_000) + " menit sesi");
          const reason = make("p", "access-mcp-description", req.reason);
          const expiry = make("p", "access-hint",
            "Permintaan berakhir " + new Date(req.expiresAt).toLocaleString() +
            ". Persetujuan ini hanya sekali untuk sesi tepat ini.");
          const actions = make("div", "access-mcp-actions");
          const approve = action("Tinjau & Setujui", "access-submit", async () => {
            await executeDesktopUiSessionRequestDecision("approve", req.requestId, approve);
          });
          const deny = action("Tolak", "access-revoke", async () => {
            await executeDesktopUiSessionRequestDecision("deny", req.requestId, deny);
          });
          actions.append(approve, deny);
          card.append(head, target, meta, reason, expiry, actions);
          list.append(card);
        }
      }
    }
    if (histList) {
      histList.replaceChildren();
      if (!decided.length) {
        histList.append(make("p", "access-empty", "Belum ada riwayat keputusan Desktop UI."));
      } else {
        for (const req of decided.slice(0, 30)) {
          const row = make("div", "access-mcp-history-row");
          row.dataset.requestId = req.requestId;
          const details = make("div", "access-mcp-history-detail");
          const head = make("div", "access-mcp-history-head");
          const label = req.application + " · " + req.title;
          const statusLabel = ({
            approved: "Disetujui · menunggu dipakai",
            denied: "Ditolak",
            consumed: "Dipakai",
            expired: "Kedaluwarsa",
          })[req.status] || req.status;
          head.append(
            make("strong", "", label),
            make("span", "access-mcp-state access-mcp-state-" + req.status, statusLabel)
          );
          details.append(head, make("span", "access-mcp-meta",
            (req.accessMode === "input" ? "Viewer + Input" : "Viewer only") +
            " · " + req.principalId + " · " +
            new Date(req.decidedAt || req.createdAt).toLocaleString()));
          row.append(details);
          histList.append(row);
        }
      }
    }
  }

  async function refreshDesktopUiSessionRequests() {
    try {
      const result = await invoke("desktop_ui_session_requests_action", { action: "list" });
      if (result?.success !== true || !Array.isArray(result.requests) ||
          result.requests.length > 96 || !result.requests.every(validDesktopUiSessionRequest)) {
        throw Error("Core returned an incomplete or invalid Desktop UI request inventory.");
      }
      state.pendingDesktopUiRequests = result.requests;
      renderDesktopUiSessionRequests();
      return { success: true };
    } catch (error) {
      state.pendingDesktopUiRequests = null;
      renderDesktopUiSessionRequests();
      updateRequestCenterBadges();
      return { success: false, error: String(error?.message || error) };
    }
  }

  function buildRequestCenterPane() {
    const pane = make("div", "access-pane access-mcp-section");
    pane.id = "access-pane-requests";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", "access-nav-tab-requests");
    pane.hidden = false;

    const intro = make("div", "access-editor access-mcp-intro");
    const introHead = make("div", "access-mcp-intro-head");
    const introCopy = make("div", "access-mcp-intro-copy");
    introCopy.append(
      make("h3", "", "Pusat Permintaan"),
      make("p", "access-mcp-description",
        "Kelola permintaan akses proyek, aturan host, dan sesi Desktop Live, sekaligus meninjau riwayat keputusan akses proyek dalam satu tempat.")
    );
    const introActions = make("div", "access-mcp-pending-controls");
    const toggleNewRuleReq = action("+ Ajukan Permintaan Aturan Aktif", "access-submit", () => {
      ruleReqForm.hidden = !ruleReqForm.hidden;
      toggleNewRuleReq.textContent = ruleReqForm.hidden ? "+ Ajukan Permintaan Aturan Aktif" : "Tutup Form";
    });
    toggleNewRuleReq.id = "access-req-new-rule-toggle";
    const requestLoadError = make("div", "access-mcp-load-error");
    requestLoadError.id = "access-req-center-load-error";
    requestLoadError.setAttribute("role", "alert");
    requestLoadError.setAttribute("aria-live", "assertive");
    requestLoadError.hidden = true;
    const refreshAllBtn = action("Muat ulang", "access-audit-refresh", async () => {
      if (refreshAllBtn.disabled) return;
      refreshAllBtn.disabled = true;
      refreshAllBtn.textContent = "Loading…";
      refreshAllBtn.setAttribute("aria-busy", "true");
      requestLoadError.hidden = true;
      requestLoadError.textContent = "";
      try {
        const [mcpResult, ruleResult, desktopResult] = await Promise.all([
          refreshMcpRequests({ queueIfBusy: true }),
          refreshPendingRuleRequests(),
          refreshDesktopUiSessionRequests(),
        ]);
        const requestFailures = Object.entries(mcpResult?.failures || {})
          .filter(([key]) => key !== "live");
        const problems = [];
        if (requestFailures.length) {
          const detail = requestFailures
            .map(([key, value]) => key + ": " + value).join("; ");
          problems.push("MCP data: " + detail);
        }
        if (ruleResult?.success !== true)
          problems.push("Active-rule requests: " + (ruleResult?.error || "refresh failed"));
        if (desktopResult?.success !== true)
          problems.push("Desktop UI requests: " + (desktopResult?.error || "refresh failed"));
        if (problems.length) {
          requestLoadError.textContent = "Some Request Center data could not be loaded: " +
            problems.join(" · ") + ". Retry with Reload.";
          requestLoadError.hidden = false;
          status("Request Center refresh incomplete. Check the alert above.", "error");
        } else {
          status("Request Center refreshed.", "success");
        }
      } catch (error) {
        requestLoadError.textContent = "Request Center refresh failed: " +
          String(error?.message || error) + ". Retry with Reload.";
        requestLoadError.hidden = false;
        status("Request Center refresh failed: " + String(error?.message || error), "error");
      } finally {
        refreshAllBtn.disabled = false;
        refreshAllBtn.textContent = "Muat ulang";
        refreshAllBtn.setAttribute("aria-busy", "false");
      }
    });
    refreshAllBtn.id = "access-req-center-refresh";
    introActions.append(toggleNewRuleReq, refreshAllBtn);
    introHead.append(introCopy, introActions);

    const subBar = make("div", "access-req-center-subtabs");
    const subTabs = make("div", "access-filter-tabs");
    const subAll = action("Semua (0)", "access-filter-btn active", () => setRequestSubTab("all"));
    subAll.id = "access-req-subtab-all";
    const subIncoming = action("Permintaan Akses Masuk (0)", "access-filter-btn", () => setRequestSubTab("incoming"));
    subIncoming.id = "access-req-subtab-incoming";
    const subRules = action("Permintaan Aturan Aktif (0)", "access-filter-btn", () => setRequestSubTab("rules"));
    subRules.id = "access-req-subtab-rules";
    const subDesktop = action("Desktop Live (0)", "access-filter-btn", () => setRequestSubTab("desktop"));
    subDesktop.id = "access-req-subtab-desktop";
    subTabs.append(subAll, subIncoming, subRules, subDesktop);
    subBar.append(subTabs);

    const ruleReqForm = make("div", "access-req-rule-form");
    ruleReqForm.id = "access-req-rule-form";
    ruleReqForm.hidden = true;
    const reqSourceInput = make("input", "access-search");
    reqSourceInput.id = "access-req-rule-source";
    reqSourceInput.placeholder = "Contoh: Gemini MCP / T-Line";
    reqSourceInput.value = "MCP Client";
    const reqKindSelect = select("access-req-rule-kind", [
      ["file", "File & Folder Host"],
      ["desktop", "Aplikasi Desktop"],
    ]);
    const reqPathInput = make("input", "access-search");
    reqPathInput.id = "access-req-rule-path";
    reqPathInput.placeholder = "Pilih folder atau file...";
    const pickDirBtn = action("Pilih Folder", "access-revoke", async () => {
      const chosen = await invoke("pick_permanent_access_path", { directory: true }).catch(() => null);
      if (typeof chosen === "string" && chosen) {
        reqPathInput.value = chosen;
        reqRecCheck.firstChild.checked = true;
      }
    });
    pickDirBtn.id = "access-req-pick-dir";
    const pickFileBtn = action("Pilih File", "access-revoke", async () => {
      const chosen = await invoke("pick_permanent_access_path", { directory: false }).catch(() => null);
      if (typeof chosen === "string" && chosen) {
        reqPathInput.value = chosen;
        reqRecCheck.firstChild.checked = false;
      }
    });
    pickFileBtn.id = "access-req-pick-file";
    const pickExeBtn = action("Pilih .exe", "access-revoke", async () => {
      const chosen = await invoke("pick_permanent_access_executable").catch(() => null);
      if (typeof chosen === "string" && chosen) {
        reqPathInput.value = chosen;
      }
    });
    pickExeBtn.id = "access-req-pick-exe";
    pickExeBtn.hidden = true;
    const pathRow = make("div", "access-project-target access-req-span-all");
    pathRow.append(reqPathInput, pickDirBtn, pickFileBtn, pickExeBtn);

    const reqRecCheck = checkbox("access-req-rule-recursive", "Berlaku rekursif untuk subfolder", true);
    const reqReasonInput = make("input", "access-search");
    reqReasonInput.id = "access-req-rule-reason";
    reqReasonInput.placeholder = "Alasan permintaan aturan aktif...";

    const opsRow = make("div", "access-req-rule-ops access-req-span-all");
    const fileOpsWrap = make("div", "access-req-rule-ops");
    fileOpsWrap.id = "access-req-ops-file";
    const opRead = checkbox("access-req-op-read", "read", true);
    const opWrite = checkbox("access-req-op-write", "write", true);
    const opDelete = checkbox("access-req-op-delete", "delete", false);
    fileOpsWrap.append(opRead, opWrite, opDelete);

    const desktopOpsWrap = make("div", "access-req-rule-ops");
    desktopOpsWrap.id = "access-req-ops-desktop";
    desktopOpsWrap.hidden = true;
    const opView = checkbox("access-req-op-view", "view", true);
    const opInput = checkbox("access-req-op-input", "input", false);
    desktopOpsWrap.append(opView, opInput);
    opsRow.append(fileOpsWrap, desktopOpsWrap);

    const syncReqFormKind = () => {
      const isDesktop = reqKindSelect.value === "desktop";
      pickDirBtn.hidden = isDesktop;
      pickFileBtn.hidden = isDesktop;
      pickExeBtn.hidden = !isDesktop;
      reqRecCheck.hidden = isDesktop;
      if (isDesktop) {
        reqRecCheck.firstChild.checked = false;
      }
      fileOpsWrap.hidden = isDesktop;
      desktopOpsWrap.hidden = !isDesktop;
      reqPathInput.placeholder = isDesktop
        ? "Pilih file .exe aplikasi desktop..."
        : "Pilih folder atau file...";
    };
    reqKindSelect.addEventListener("change", () => {
      reqPathInput.value = "";
      syncReqFormKind();
    });
    syncReqFormKind();

    const submitRuleReqBtn = action("Kirim ke Pusat Permintaan & Notifikasi OS", "access-submit access-req-span-all", async () => {
      const isDesktop = reqKindSelect.value === "desktop";
      const targetPath = reqPathInput.value.trim();
      if (!targetPath) {
        status(isDesktop
          ? "Pilih file .exe aplikasi terlebih dahulu."
          : "Pilih path folder/file terlebih dahulu.", "warning");
        return;
      }
      const ops = [];
      if (isDesktop) {
        if (opView.firstChild.checked) ops.push("view");
        if (opInput.firstChild.checked) ops.push("input");
      } else {
        if (opRead.firstChild.checked) ops.push("read");
        if (opWrite.firstChild.checked) ops.push("write");
        if (opDelete.firstChild.checked) ops.push("delete");
      }
      if (!ops.length) {
        status("Pilih minimal satu operasi.", "warning");
        return;
      }
      submitRuleReqBtn.disabled = true;
      try {
        await invoke("submit_active_rule_request", {
          sourceName: reqSourceInput.value.trim() || "MCP Client",
          kind: reqKindSelect.value,
          effect: "allow",
          targetPath,
          recursive: isDesktop ? false : Boolean(reqRecCheck.firstChild.checked),
          operations: ops,
          reason: reqReasonInput.value.trim() || "Permintaan aturan aktif baru",
        });
        reqPathInput.value = "";
        reqReasonInput.value = "";
        reqKindSelect.value = "file";
        syncReqFormKind();
        ruleReqForm.hidden = true;
        toggleNewRuleReq.textContent = "+ Ajukan Permintaan Aturan Aktif";
        await refreshPendingRuleRequests();
        status("Permintaan aturan aktif dikirim dan notifikasi OS dipicu.", "success");
      } catch (error) {
        status("Gagal mengirim permintaan aturan aktif: " + String(error?.message || error), "error");
      } finally {
        submitRuleReqBtn.disabled = false;
      }
    });

    ruleReqForm.append(
      field("Sumber / Koneksi Pemohon", reqSourceInput),
      field("Jenis Aturan", reqKindSelect),
      pathRow,
      reqRecCheck,
      field("Catatan / Alasan", reqReasonInput),
      opsRow,
      submitRuleReqBtn
    );

    intro.append(introHead, subBar, ruleReqForm);

    const grid = make("div", "access-req-center-grid");
    grid.id = "access-req-center-grid";

    const incomingCard = make("section", "access-stored access-mcp-card");
    incomingCard.id = "access-req-center-incoming-card";
    const incomingHead = make("div", "access-stored-head");
    const incomingTitle = make("h3", "", "Permintaan Akses Masuk");
    const incomingBadge = make("span", "access-count", "0 permintaan");
    incomingBadge.id = "access-req-center-incoming-count";
    incomingHead.append(incomingTitle, incomingBadge);
    const incomingList = make("div", "access-mcp-list");
    incomingList.id = "access-req-center-incoming-list";
    incomingCard.append(
      incomingHead,
      make("p", "access-hint", "Permintaan akses proyek dan hak capability agen MCP yang menunggu persetujuan."),
      incomingList
    );

    const rulesCard = make("section", "access-stored access-mcp-card");
    rulesCard.id = "access-req-center-rules-card";
    const rulesHead = make("div", "access-stored-head");
    const rulesTitle = make("h3", "", "Permintaan Aturan Aktif");
    const rulesBadge = make("span", "access-count", "0 permintaan");
    rulesBadge.id = "access-req-center-rules-count";
    rulesHead.append(rulesTitle, rulesBadge);
    const rulesList = make("div", "access-mcp-list");
    rulesList.id = "access-req-center-rules-list";
    rulesList.append(make("p", "access-empty", "Tidak ada permintaan aturan aktif yang menunggu persetujuan."));
    rulesCard.append(
      rulesHead,
      make("p", "access-hint", "Permintaan izin permanen pada file/folder atau aplikasi desktop di host."),
      rulesList
    );

    const desktopCard = make("section", "access-stored access-mcp-card");
    desktopCard.id = "access-req-center-desktop-card";
    const desktopHead = make("div", "access-stored-head");
    const desktopTitle = make("h3", "", "Permintaan Sesi Desktop Live");
    const desktopBadge = make("span", "access-count", "0 menunggu");
    desktopBadge.id = "access-req-center-desktop-count";
    desktopHead.append(desktopTitle, desktopBadge);
    const desktopList = make("div", "access-mcp-list");
    desktopList.id = "access-req-center-desktop-list";
    desktopList.append(make("p", "access-empty", "Tidak ada permintaan Desktop UI yang menunggu persetujuan."));
    desktopCard.append(
      desktopHead,
      make("p", "access-hint",
        "Persetujuan satu kali untuk sesi lokal desktop_ui. Izin Viewer dan Input tetap terikat pada jendela tepat, masa sesi, serta Aturan Host Permanen. Ini tidak membuka controller PC jarak jauh atau melewati Host File Policy."),
      desktopList
    );

    grid.append(incomingCard, rulesCard, desktopCard);

    const ruleHistCard = make("section", "access-stored access-mcp-card");
    ruleHistCard.id = "access-req-center-rules-history-card";
    ruleHistCard.hidden = state.requestSubTab !== "rules";
    const ruleHistHead = make("div", "access-stored-head");
    ruleHistHead.append(make("h3", "", "Riwayat Keputusan Aturan Aktif"));
    const ruleHistList = make("div", "access-mcp-list access-mcp-scroll-list");
    ruleHistList.id = "access-req-center-rules-history";
    ruleHistList.append(make("p", "access-empty", "Belum ada riwayat keputusan aturan aktif."));
    ruleHistCard.append(ruleHistHead, ruleHistList);
    rulesCard.append(ruleHistCard);

    const projectHistCard = make("section", "access-stored access-mcp-card access-req-center-project-history");
    projectHistCard.id = "access-req-center-project-history-card";
    projectHistCard.hidden = state.requestSubTab !== "incoming";
    const projectHistHead = make("div", "access-stored-head");
    projectHistHead.append(make("h3", "", "Riwayat Akses Proyek"));
    const projectHistList = make("div", "access-mcp-list access-mcp-scroll-list");
    projectHistList.id = "access-mcp-history-list";
    projectHistList.append(make("p", "access-empty", "Belum ada izin atau keputusan yang tercatat."));
    projectHistCard.append(
      projectHistHead,
      make("p", "access-hint", "Keputusan permintaan grant dan pencabutan akses proyek agen MCP."),
      projectHistList
    );
    incomingCard.append(projectHistCard);

    const desktopHistCard = make("section", "access-stored access-mcp-card");
    desktopHistCard.id = "access-req-center-desktop-history-card";
    desktopHistCard.hidden = state.requestSubTab !== "desktop";
    const desktopHistHead = make("div", "access-stored-head");
    desktopHistHead.append(make("h3", "", "Riwayat Keputusan Desktop Live"));
    const desktopHistList = make("div", "access-mcp-list access-mcp-scroll-list");
    desktopHistList.id = "access-req-center-desktop-history";
    desktopHistList.append(make("p", "access-empty", "Belum ada riwayat keputusan Desktop UI."));
    desktopHistCard.append(desktopHistHead, desktopHistList);
    desktopCard.append(desktopHistCard);

    pane.append(intro, requestLoadError, grid);
    return pane;
  }

  function renderMcpHistory(id, requests) {
    const root = $(id);
    if (!root) return;
    root.replaceChildren();
    if (!Array.isArray(requests)) {
      root.append(make("p", "access-empty", "Riwayat belum dapat dimuat."));
      return;
    }
    if (!requests.length) {
      root.append(make("p", "access-empty", "Belum ada izin atau keputusan yang tercatat."));
      return;
    }
    const ordered = [...requests].sort((a, b) =>
      Number(b.decidedAt || b.createdAt || 0) - Number(a.decidedAt || a.createdAt || 0));
    for (const req of ordered.slice(0, 30)) {
      const row = make("div", "access-mcp-history-row");
      row.dataset.requestId = String(req.requestId || "");
      const details = make("div", "access-mcp-history-detail");
      const head = make("div", "access-mcp-history-head");
      const title = make("strong", "", humanMcpTarget(req));
      const state = make("span", "access-mcp-state access-mcp-state-" + String(req.status || "unknown"),
        ({ approved: "Disetujui", denied: "Ditolak", revoked: "Dicabut" })[req.status] || String(req.status || "Tidak diketahui"));
      head.append(title, state);
      const meta = make("span", "access-mcp-meta",
        String(req.subject || "Identitas MCP") + " · " +
        (Array.isArray(req.capabilities) ? req.capabilities.join(", ") : "") +
        " · " + new Date(req.decidedAt || req.createdAt || Date.now()).toLocaleString());
      details.append(head, meta);
      row.append(details);
      if (req.status === "approved") {
        const revoke = action("Cabut Izin", "access-revoke", async () => {
          // Native dialog confirms the exact grant before it is revoked.
          revoke.disabled = true;
          try { await executeMcpDecision("revoke", req.requestId, "Pencabutan izin"); }
          finally { revoke.disabled = false; }
        });
        row.append(revoke);
      }
      root.append(row);
    }
  }

  function populateMcpIdentitySelect(id, identities) {
    const node = $(id);
    if (!node) return;
    const current = node.value;
    node.replaceChildren(option("", identities?.length ?
      "Pilih identitas yang terverifikasi..." : "Belum ada identitas yang terverifikasi"));
    for (const identity of identities || []) {
      if (!identity?.identityHandle || !identity?.subject) continue;
      const recent = Array.isArray(identity.scopes) && identity.scopes.length === 0;
      node.append(option(identity.identityHandle,
        identity.subject + " · " + identity.mode + (recent ? " (permintaan terbaru)" : "") +
        " · " + identity.identityHandle));
    }
    if ((identities || []).some(identity => identity.identityHandle === current)) node.value = current;
  }

  function renderMcpConnectedClients(result) {
    const root = $("access-mcp-live-list");
    const summary = $("access-mcp-live-summary");
    if (!root || !summary) return;
    root.replaceChildren();
    if (result?.state !== "verified" || !Array.isArray(result?.clients)) {
      summary.textContent = "Tidak tersedia";
      root.append(make("p", "access-empty",
        "Core belum menerima daftar sesi dari MCP owner yang terverifikasi. Ini bukan bukti bahwa MCP terputus; periksa target Core dan Runtime Detection."));
      return;
    }
    const clients = result.clients;
    const valid = clients.length <= 64 && clients.every(client =>
      client && /^ses_[a-f0-9]{12}$/.test(client.sessionHandle) &&
      /^idh_[a-f0-9]{16}$/.test(client.principalHandle) &&
      ["oauth", "static-bearer"].includes(client.authMode) &&
      ["active", "idle", "retiring"].includes(client.state) &&
      Number.isSafeInteger(client.inFlight) && client.inFlight >= 0 &&
      Number.isSafeInteger(client.lastSeenAt));
    if (!valid) {
      summary.textContent = "Data tidak valid";
      root.append(make("p", "access-empty",
        "Inventaris sesi MCP tidak lolos validasi. Data ditolak, bukan ditampilkan sebagai koneksi terverifikasi."));
      return;
    }
    const principals = new Set(clients.map(client => client.principalHandle)).size;
    summary.textContent = clients.length + " sesi · " + principals + " identitas";
    if (!clients.length) {
      root.append(make("p", "access-empty", "Tidak ada sesi MCP aktif yang terdeteksi pada MCP owner ini."));
      return;
    }
    for (const client of clients) {
      const row = make("div", "access-mcp-identity-row");
      const reportedName = typeof client.claimedClientName === "string" &&
        client.claimedClientName.trim() ? client.claimedClientName : "Klien MCP tanpa nama";
      const assignedName = typeof client.ownerConnectionName === "string" &&
        client.ownerConnectionName.trim() ? client.ownerConnectionName : null;
      const head = make("div", "access-mcp-row-head");
      const badge = make("span", "access-mcp-inline-pill access-mcp-pill-" + client.state,
        (client.authMode === "oauth" ? "OAuth" : "Bearer") + " · " + client.state);
      head.append(
        make("strong", "", assignedName
          ? assignedName + " (nama dari persetujuan OAuth)"
          : reportedName + " (nama dari klien)"),
        badge
      );
      row.append(
        head,
        ...(assignedName ? [make("span", "access-mcp-meta",
          "Aplikasi melaporkan: " + reportedName)] : []),
        make("span", "access-mcp-meta access-mcp-mono",
          client.inFlight + " permintaan aktif · " +
          client.principalHandle + " · " + client.sessionHandle +
          " · terakhir " + new Date(client.lastSeenAt).toLocaleString()),
      );
      root.append(row);
    }
  }

  function renderMcpRegisteredConnections(result) {
    const root = $("access-mcp-registered-list");
    const summary = $("access-mcp-registered-summary");
    if (!root || !summary) return;
    root.replaceChildren();
    const verified = result?.state === "verified" &&
      result.registrationState === "verified";
    let registrations = Array.isArray(result?.registeredConnections)
      ? result.registeredConnections : [];

    // A live, owner-verified session remains useful when native metadata
    // persistence is unavailable or an older Core lacks the new registry.
    // These fallback entries are explicitly NOT called persisted registrations.
    const fallback = result?.state === "verified" &&
      result.registrationState !== "verified" &&
      Array.isArray(result.clients);
    if (fallback) {
      const groups = new Map();
      for (const client of result.clients) {
        if (!client || !/^idh_[a-f0-9]{16}$/.test(client.principalHandle)) continue;
        const previous = groups.get(client.principalHandle);
        if (previous) {
          previous.sessionCount++;
          if (client.lastSeenAt > previous.lastObservedAt) {
            previous.reportedClientName = client.claimedClientName;
            previous.ownerConnectionName = client.ownerConnectionName;
            previous.lastObservedAt = client.lastSeenAt;
          }
        } else {
          groups.set(client.principalHandle, {
            connectionHandle: client.principalHandle, authMode: client.authMode,
            reportedClientName: client.claimedClientName,
            ownerConnectionName: client.ownerConnectionName,
            lastObservedAt: client.lastSeenAt,
            sessionCount: 1, status: "connected",
          });
        }
      }
      registrations = [...groups.values()];
    }
    const valid = registrations.length <= 128 && registrations.every(record =>
      record && /^idh_[a-f0-9]{16}$/.test(record.connectionHandle) &&
      ["oauth", "static-bearer"].includes(record.authMode) &&
      Number.isSafeInteger(record.lastObservedAt) &&
      Number.isSafeInteger(record.sessionCount) &&
      record.sessionCount >= 0 && record.sessionCount <= 64 &&
      ["connected", "disconnected"].includes(record.status) &&
      (record.reportedClientName == null ||
        (typeof record.reportedClientName === "string" && record.reportedClientName.length <= 64)) &&
      (record.ownerConnectionName == null ||
        (typeof record.ownerConnectionName === "string" && record.ownerConnectionName.length <= 64)));
    if (!valid) {
      summary.textContent = "Data tidak valid";
      root.append(make("p", "access-empty", "Catatan koneksi tidak lolos validasi."));
      return;
    }
    const live = verified || fallback;
    const online = live ? registrations.filter(row => row.status === "connected").length : 0;
    summary.textContent = registrations.length + " koneksi · " + online +
      (live ? " terhubung" : " status tidak terverifikasi");
    if (!registrations.length) {
      root.append(make("p", "access-empty",
        result?.state === "verified"
          ? "Belum ada identitas koneksi yang terdeteksi pada sesi MCP saat ini."
          : "Data koneksi belum tersedia. Tidak ada koneksi yang dinyatakan offline tanpa verifikasi owner."));
      return;
    }
    for (const record of registrations) {
      const row = make("div", "access-mcp-identity-row");
      const name = record.ownerConnectionName || record.reportedClientName || "Klien MCP tanpa nama";
      const head = make("div", "access-mcp-row-head");
      const statusText = live
        ? (record.status === "connected" ? "Terhubung" : "Terputus")
        : "Status belum terverifikasi";
      const statusTone = live
        ? (record.status === "connected" ? "active" : "idle")
        : "unverified";
      head.append(
        make("strong", "", name + (record.ownerConnectionName
          ? " (nama dari persetujuan OAuth)" : " (nama diklaim klien)")),
        make("span", "access-mcp-inline-pill access-mcp-pill-" + statusTone,
          (record.authMode === "oauth" ? "OAuth" : "Bearer") + " · " + statusText)
      );
      row.append(head);
      if (record.ownerConnectionName && record.reportedClientName)
        row.append(make("span", "access-mcp-meta",
          "Nama dari aplikasi: " + record.reportedClientName));
      row.append(make("span", "access-mcp-meta access-mcp-mono",
        (live ? record.sessionCount + " sesi · " : "") +
        record.connectionHandle + " · terakhir " +
        new Date(record.lastObservedAt).toLocaleString()));
      root.append(row);
    }
    if (fallback) {
      root.append(make("p", "access-hint",
        "Koneksi live terdeteksi, tetapi pencatatan metadata persisten belum tersedia di Core ini."));
    }
  }

  function renderMcpIdentities(identities) {
    const root = $("access-mcp-identity-list");
    if (!root) return;
    root.replaceChildren();
    if (!Array.isArray(identities)) {
      root.append(make("p", "access-empty", "Identitas belum dapat dimuat."));
      return;
    }
    if (!identities.length) {
      root.append(make("p", "access-empty",
        "Belum ada identitas yang dapat diberi izin oleh Core. Sesi online di atas belum otomatis berhak mendapat izin. Kirim superagent_request_project_access dari klien MCP, lalu muat ulang."));
      return;
    }
    for (const id of identities) {
      const row = make("div", "access-mcp-identity-row");
      const head = make("div", "access-mcp-row-head");
      head.append(
        make("strong", "", String(id.subject || "Identitas tidak dikenal")),
        make("span", "access-mcp-inline-pill access-mcp-pill-neutral", String(id.mode || "oauth"))
      );
      row.append(head);
      row.append(make("span", "access-mcp-meta access-mcp-mono",
        String(id.identityHandle || "") +
        (Array.isArray(id.scopes) && id.scopes.length === 0 ? " · permintaan terbaru, belum tentu online" : "")));
      root.append(row);
    }
  }

  async function changeProject(actionName, project, updates = {}) {
    if (!project?.projectId || !Number.isSafeInteger(project.updatedAt)) {
      status("Revisi proyek tidak tersedia. Muat ulang terlebih dahulu.", "warning"); return;
    }
    try {
      const result = await invoke("mcp_project_access_action", {
        action: actionName,
        payload: { projectId: project.projectId, expectedUpdatedAt: project.updatedAt, ...updates },
      });
      if (!result?.success) throw Error(result?.code || result?.error || "Core tidak mengonfirmasi perubahan.");
      status("Proyek " + project.projectId + " berhasil " +
        (actionName === "remove_project" ? "dihapus" : updates.enabled === false ? "dinonaktifkan" :
          updates.enabled === true ? "diaktifkan" : "diperbarui") +
        ". Izin MCP yang relevan dicabut oleh Core.", "success");
      await refreshMcpRequests();
    } catch (error) {
      status("Perubahan proyek ditolak: " + String(error?.message || error), "error");
      await refreshMcpRequests();
    }
  }

  function renderProjectInventory(available = Array.isArray(mcpCache.inventory)) {
    const root = $("access-project-list");
    if (!root) return;
    root.replaceChildren();
    if (!available || !Array.isArray(mcpCache.inventory)) {
      root.append(make("p", "access-empty", "Daftar proyek tidak tersedia. Muat ulang."));
      return;
    }
    const query = String($("access-project-search")?.value || "").trim().toLowerCase();
    const items = mcpCache.inventory.filter(project => project && project.projectId &&
      String(project.name + " " + project.projectId + " " + project.target)
        .toLowerCase().includes(query));
    if (!items.length) {
      root.append(make("p", "access-empty",
        query ? "Tidak ada proyek sesuai pencarian." : "Belum ada proyek. Klik + Tambah Proyek."));
      return;
    }
    for (const project of items) {
      const row = make("div", "access-project-row");
      const detail = make("div", "access-project-detail");
      const detailHead = make("div", "access-mcp-row-head");
      detailHead.append(
        make("strong", "", String(project.name || project.projectId)),
        make("span", "access-project-no-grant " + (project.enabled === false ? "is-inactive" : "is-active"),
          project.enabled === false ? "Nonaktif · tidak dapat diberi izin MCP" : "Aktif · izin MCP terpisah")
      );
      detail.append(
        detailHead,
        make("span", "access-mcp-meta access-mcp-mono", String(project.projectId) + " · " +
          String(project.type || "local") + " · " + String(project.target || "")));
      const controls = make("div", "access-project-actions");
      const edit = action("Edit", "access-audit-refresh", () => {
        const form = $("access-project-form");
        const name = $("access-project-name");
        const id = $("access-project-id");
        const type = $("access-project-type");
        const desc = $("access-project-description");
        const rootPath = $("access-project-root");
        const remote = $("access-project-target");
        const submit = $("access-project-save");
        if (!form || !name || !id || !type || !desc || !rootPath || !remote || !submit) return;
        name.value = project.name || ""; id.value = project.projectId; id.readOnly = true;
        type.value = project.type; type.disabled = true;
        desc.value = project.description || "";
        rootPath.value = project.type === "local" ? project.target : "";
        remote.value = project.type !== "local" ? project.target : "";
        $("access-project-local").hidden = project.type !== "local";
        $("access-project-remote").hidden = project.type === "local";
        // The editor state is owned by buildMcpPane via its closure.
        window.__superagentEditProject?.(project);
        form.hidden = false; submit.textContent = "Simpan Perubahan";
        $("access-project-add").textContent = "Batal";
        $("access-project-add").setAttribute("aria-expanded", "true");
      });
      const toggle = action(project.enabled === false ? "Aktifkan" : "Nonaktifkan",
        "access-audit-refresh", async () => {
          toggle.disabled = true;
          try { await changeProject("update_project", project, { enabled: project.enabled === false }); }
          finally { toggle.disabled = false; }
        });
      const remove = action("Hapus", "access-revoke", async () => {
        remove.disabled = true;
        try { await changeProject("remove_project", project); }
        finally { remove.disabled = false; }
      });
      controls.append(edit, toggle, remove);
      row.append(detail, controls);
      root.append(row);
    }
  }

  function setMcpPendingLoadBusy(busy) {
    const buttons = [
      ["access-mcp-connections-refresh", "Muat ulang"],
      ["access-mcp-connection-pending-load", "Load"],
      ["access-mcp-identity-refresh", "Muat ulang"],
      ["access-mcp-projects-refresh", "Muat ulang"],
    ];
    for (const [id, idleLabel] of buttons) {
      const button = $(id);
      if (!button) continue;
      button.disabled = busy;
      button.textContent = busy ? "Loading…" : idleLabel;
      button.setAttribute("aria-busy", String(busy));
    }
  }

  async function refreshMcpRequests({ queueIfBusy = false } = {}) {
    if (mcpCache.refreshing) {
      if (queueIfBusy) mcpCache.refreshQueued = true;
      return mcpCache.refreshing;
    }
    setMcpPendingLoadBusy(true);
    const refreshOnce = async () => {
      const sources = [
        ["requests", "requests"], ["identities", "identities"], ["projects", "projects"],
        ["inventory", "project_inventory"], ["live", "connected_clients"],
      ];
      const responses = await Promise.allSettled(sources.map(([, action]) =>
        invoke("mcp_project_access_action", action === "connected_clients"
          ? { action, payload: {} } : { action })));
      const failures = {};
      for (let i = 0; i < sources.length; i++) {
        const [key] = sources[i];
        const res = responses[i];
        if (key === "live") {
          mcpCache.live = res.status === "fulfilled" && res.value?.success === true
            ? res.value : null;
          if (!mcpCache.live) failures.live = res.status === "rejected"
            ? String(res.reason?.message || res.reason)
            : String(res.value?.error || "inventaris sesi tidak tersedia");
        } else if (res.status === "fulfilled" && res.value?.success &&
                   Array.isArray(res.value[key === "inventory" ? "projects" : key])) {
          mcpCache[key] = res.value[key === "inventory" ? "projects" : key];
        } else {
          failures[key] = res.status === "rejected"
            ? String(res.reason?.message || res.reason)
            : String(res.value?.error || "respons tidak valid");
        }
      }
      const problems = (keys) => keys.filter(key => failures[key])
        .map(key => key + ": " + failures[key]);
      setMcpLoadError("access-mcp-project-load-error", problems(["requests", "identities", "projects", "inventory"]));
      setMcpLoadError("access-mcp-connection-load-error", problems(["live"]));

      const allRequests = mcpCache.requests;
      const projectRequests = allRequests?.filter(req => req.projectId !== "mcp-connection");
      const projectPending = projectRequests?.filter(req => req.status === "pending");
      const projectHistory = projectRequests?.filter(req => req.status !== "pending");
      const badgeProject = $("access-tab-badge-mcp");
      const badgeConnection = $("access-tab-badge-connections");
      const connectionSessions = Array.isArray(mcpCache.live?.clients) ? mcpCache.live.clients.length : 0;
      for (const [badge, count] of [[badgeProject, projectPending?.length], [badgeConnection, connectionSessions]]) {
        if (badge) {
          badge.textContent = typeof count === "number" ? String(count) : "!";
          badge.className = "access-nav-tab-badge" + (badge === badgeProject && count > 0 ? " pending" : count === 0 ? " zero" : "");
        }
      }
      if ($("access-mcp-pending-count")) {
        $("access-mcp-pending-count").textContent =
          projectPending ? projectPending.length + " permintaan" : "Belum dimuat";
      }
      // Failed refreshes never leave stale, actionable approval buttons on screen.
      renderMcpPending("access-mcp-pending-list", failures.requests ? null : projectPending, false, "approval");
      renderMcpPending("access-req-center-incoming-list", failures.requests ? null : projectPending, false, "req-center");
      renderMcpHistory("access-mcp-history-list", failures.requests ? null : projectHistory);
      renderLegacyMcpRequests(failures.requests ? null : allRequests);
      updateRequestCenterBadges();
      renderMcpConnectedClients(mcpCache.live);
      renderMcpRegisteredConnections(mcpCache.live);
      renderMcpIdentities(failures.identities ? null : mcpCache.identities);
      populateMcpIdentitySelect("access-mcp-ident-select", mcpCache.identities);

      const validProjects = Array.isArray(mcpCache.projects) ?
        mcpCache.projects.filter(project => project.projectId &&
          project.enabled !== false && project.projectId !== "mcp-connection") : [];
      const projectSelect = $("access-mcp-proj-select");
      if (projectSelect) {
        const previousProject = projectSelect.value;
        projectSelect.replaceChildren(option("",
          validProjects.length ? "Pilih proyek terdaftar..." : "Belum ada proyek aktif terdaftar"));
        for (const project of validProjects) {
          projectSelect.append(option(project.projectId,
            String(project.name || project.projectId) + " · " +
            String(project.type || "local") + " · " + String(project.target || "")));
        }
        if (validProjects.some(project => project.projectId === previousProject)) {
          projectSelect.value = previousProject;
        }
      }
      renderProjectInventory(failures.inventory === undefined);
      const identitiesAvailable = Boolean(mcpCache.identities?.length);
      if ($("access-mcp-project-grant")) {
        $("access-mcp-project-grant").disabled =
          Boolean(failures.identities || failures.projects) || !identitiesAvailable || !validProjects.length;
      }
      if (Object.keys(failures).length) {
        status("Ada data izin MCP yang gagal dimuat. Lihat pesan pada tab MCP.", "warning");
      }
      if ($("access-mcp-tool-catalog")) void refreshMcpToolCatalog();
      return { success: Object.keys(failures).length === 0, failures };
    };
    const task = (async () => {
      let result;
      do {
        mcpCache.refreshQueued = false;
        try {
          result = await refreshOnce();
        } catch (error) {
          const message = String(error?.message || error);
          setMcpLoadError("access-mcp-project-load-error", [message]);
          status("MCP data could not be refreshed: " + message, "error");
          result = { success: false, failures: { refresh: message } };
        }
      } while (mcpCache.refreshQueued);
      return result;
    })();
    mcpCache.refreshing = task;
    try { return await task; }
    finally {
      if (mcpCache.refreshing === task) {
        mcpCache.refreshing = null;
        mcpCache.refreshQueued = false;
        setMcpPendingLoadBusy(false);
      }
    }
  }

  function build() {
    const parent = $("page-security-container") || $("settings-subpage-security");
    const old = $("desktop-trust-panel");
    if (!parent || !old) return;
    const root = make("section", "access-manager");
    root.id = "access-manager";
    const head = make("div", "access-header");
    const intro = make("div");
    intro.append(make("span", "access-eyebrow", "SUPERAGENT · HOST ACCESS CONTROL"),
      make("h2", "", "Access Manager"),
      make("p", "", "Atur izin native, koneksi MCP, dan proyek secara terpisah. Izin berlaku hingga dicabut."));
    const pill = make("span", "access-permanent-pill", "● Registrasi permanen");
    head.append(intro,pill);

    const onboarding = make("div","access-onboarding");
    onboarding.id = "access-onboarding";
    onboarding.append(make("strong","","Mulai dengan aplikasi yang dipercaya"),
      make("p","","Default semua aplikasi diblokir. Pilih jendela aktif atau aplikasi terinstall, kemampuan yang boleh digunakan, lalu konfirmasi di dialog native."));
    const hostOverview = make("section", "access-editor access-mcp-intro");
    hostOverview.id = "access-host-boundary";
    hostOverview.append(
      make("h3", "", "Aplikasi & File — aturan host"),
      make("p", "access-hint",
        "Atur aplikasi/jendela dan file atau folder yang boleh digunakan lewat operasi Core SuperAgent. Ini bukan izin agent atas proyek. Untuk agent MCP, pilih proyek dan capability di Akses Proyek terlebih dahulu; akses file host dan sertifikasi tool tetap diperiksa secara terpisah."),
    );
    const hostRuleCount = make("p", "access-hint", "Memeriksa aturan file/folder host…");
    hostRuleCount.id = "access-host-file-rule-count";
    const hostOverviewActions = make("div", "access-mcp-pending-controls");
    const openProjectPermissions = action("Kelola Akses Proyek", "access-audit-refresh", () => setActiveTab("mcp"));
    openProjectPermissions.id = "access-host-open-project";
    const openFileRules = action("Lihat Aturan File Aktif", "access-audit-refresh", () => {
      setRuleFilter("file");
      setActiveTab("rules");
    });
    openFileRules.id = "access-host-open-file-rules";
    hostOverviewActions.append(openProjectPermissions, openFileRules);
    hostOverview.append(hostRuleCount, hostOverviewActions);
    const topbar = make("div","access-toolbar");
    const search = make("input","access-search");
    search.id = "access-search"; search.placeholder = "Cari aplikasi / jendela..."; search.type = "search";
    search.addEventListener("input",renderCandidateList);
    const refreshBtn = action("Refresh","access-refresh", () => {
      if (state.appSource === "installed") void refreshInstalledApps();
      else void refreshWindows();
    });
    refreshBtn.id = "access-refresh";
    topbar.append(search, refreshBtn);

    const split = make("div","access-layout");
    const aside = make("aside","access-sidebar");

    const sourceBar = make("div", "access-source-bar");
    const sourceTabs = make("div", "access-source-tabs");
    const tabActive = action("Jendela Aktif (" + state.windows.length + ")", "access-source-btn active", () => setAppSource("active"));
    tabActive.id = "access-src-active";
    const tabInstalled = action("Terinstall (" + state.installedApps.length + ")", "access-source-btn", () => setAppSource("installed"));
    tabInstalled.id = "access-src-installed";
    sourceTabs.append(tabActive, tabInstalled);
    const browseExeBtn = action("📁 .exe", "access-browse-btn", () => void pickExecutable());
    browseExeBtn.id = "access-pick-exe";
    browseExeBtn.title = "Pilih file .exe langsung dari disk";
    sourceBar.append(sourceTabs, browseExeBtn);

    aside.append(sourceBar, topbar);
    const candidates = make("div","access-app-list");
    candidates.id = "access-app-list";
    aside.append(candidates);
    const editor = make("div","access-editor");
    const selected = make("div","access-selected");
    selected.append(make("strong","","Pilih aplikasi"),make("small","","Memuat daftar aplikasi..."));
    selected.firstChild.id = "access-selected-title";
    selected.lastChild.id = "access-selected-subtitle";
    editor.append(selected);

    const grid = make("div","access-form-grid");
    const kind = select("access-kind",[["desktop","Akses jendela aplikasi"],["file","Akses File & Folder Core"]]);
    kind.addEventListener("change",viewChanged);
    const effect = select("access-effect",[["allow","Izinkan operasi"],["deny","Blokir operasi"]]);
    grid.append(field("Jenis izin",kind),field("Keputusan",effect));
    editor.append(grid);
    const desktop = make("div","access-desktop-controls");
    desktop.id = "access-desktop-controls";
    desktop.append(make("h3","","Kemampuan native desktop"));
    const switches = make("div","access-switches");
    switches.append(checkbox("access-view","Lihat jendela dan konten",true),
      checkbox("access-input","Ketik, klik, dan navigasi",true));
    desktop.append(switches,checkbox("access-exact","Berlaku hanya pada judul jendela ini",false));
    const elementGrid = make("div","access-form-grid");
    const role = select("access-element-role",[["","Semua elemen"],["edit","Edit / input"],["button","Button"],["text","Text"],["textbox","Textbox"],["document","Document"],["menuitem","Menu item"],["list","List"],["tree","Tree"]]);
    const label = make("input","access-search");
    label.id = "access-element-label"; label.type="text"; label.maxLength=512;
    label.placeholder="Kosong = semua label untuk role ini";
    elementGrid.append(field("Role elemen (opsional)",role),
      field("Label elemen persis (opsional)",label));
    desktop.append(elementGrid,
      make("p","access-limit-note","Pilih role dan label spesifik untuk membatasi klik/ketik pada kontrol tersebut. Aksi tombol keyboard tanpa elemen hanya diizinkan oleh aturan aplikasi menyeluruh."),
      make("p","access-limit-note","Izin input tetap menghormati UAC, fokus jendela, dan verifikasi native OS."));
    editor.append(desktop);
    const files = make("div","access-file-controls");
    files.id = "access-file-controls"; files.hidden = true;
    files.append(make("h3","","Aturan File & Folder"),
      make("p","access-limit-note","Aturan ini melindungi operasi file yang dijalankan melalui tool Core dan MCP SuperAgent. Bukan sandbox OS untuk Antigravity, Chrome, atau aplikasi lain."));
    const pathInput = make("input","access-search");
    pathInput.id="access-file-path"; pathInput.placeholder="Gunakan pemilih native →"; pathInput.readOnly = true;
    files.append(field("File / folder terverifikasi",pathInput));
    const browse = make("div","access-file-browser");
    const file = action("Pilih file","access-revoke",()=>void pickFile(false));
    file.id="access-pick-file";
    const folder = action("Pilih folder","access-revoke",()=>void pickFile(true));
    folder.id="access-pick-folder";
    browse.append(file,folder);
    files.append(browse,checkbox("access-file-recursive","Termasuk seluruh subfolder",false));
    const ops = make("div","access-switches");
    ops.append(checkbox("access-file-read","Baca",true),checkbox("access-file-write","Tulis",false),
      checkbox("access-file-delete","Hapus",false));
    files.append(ops);
    editor.append(files);
    const submit = action("Review & Register","access-submit",()=>void registerRule());
    submit.id = "access-submit";
    editor.append(submit);
    split.append(aside,editor);
    const stored = make("div","access-stored");
    const h = make("div","access-stored-head");
    h.append(make("h3","","Aturan terdaftar"),make("span","access-count","0 aturan"));
    h.lastChild.id = "access-rule-count";
    const summary = make("p","access-summary","");
    summary.id = "access-policy-summary";

    const filterBar = make("div", "access-filter-bar");
    const tabs = make("div", "access-filter-tabs");
    const tabAll = action("Semua (0)", "access-filter-btn active", () => setRuleFilter("all"));
    tabAll.id = "access-tab-all";
    const tabDesktop = action("Desktop (0)", "access-filter-btn", () => setRuleFilter("desktop"));
    tabDesktop.id = "access-tab-desktop";
    const tabFile = action("File & Folder (0)", "access-filter-btn", () => setRuleFilter("file"));
    tabFile.id = "access-tab-file";
    tabs.append(tabAll, tabDesktop, tabFile);

    const ruleSearch = make("input", "access-rule-search");
    ruleSearch.id = "access-rule-search";
    ruleSearch.type = "search";
    ruleSearch.placeholder = "Cari aturan berdasarkan nama, path, atau izin...";
    ruleSearch.addEventListener("input", (e) => {
      state.ruleSearch = e?.target?.value || ruleSearch.value || "";
      renderRules();
    });
    filterBar.append(tabs, ruleSearch);

    const bulkBar = make("div", "access-bulk-bar");
    bulkBar.id = "access-rule-bulk-bar";
    bulkBar.hidden = true;

    const bulkSelectWrap = make("label", "access-bulk-select-wrap");
    const selectAllCheck = make("input", "access-bulk-check");
    selectAllCheck.id = "access-rule-select-all";
    selectAllCheck.type = "checkbox";
    selectAllCheck.setAttribute("aria-label", "Pilih semua aturan yang sedang ditampilkan");
    const selectAllLabel = make("span", "", "Pilih semua");
    selectAllLabel.id = "access-rule-select-all-label";
    bulkSelectWrap.append(selectAllCheck, selectAllLabel);

    const onSelectAllToggle = () => {
      const allRules = state.registry?.rules || [];
      const query = (state.ruleSearch || "").trim().toLowerCase();
      const filtered = allRules.filter(r => {
        if (state.ruleFilter !== "all" && r.kind !== state.ruleFilter) return false;
        if (!query) return true;
        const app = appName(r.app?.executablePath).toLowerCase();
        const path = (r.kind === "desktop" ? (r.scope?.windowTitle || "") : (r.scope?.path || "")).toLowerCase();
        const ops = (r.operations || []).join(" ").toLowerCase();
        return app.includes(query) || path.includes(query) || ops.includes(query);
      });
      if (selectAllCheck.checked) {
        for (const r of filtered) state.selectedRuleIds.add(r.id);
      } else {
        for (const r of filtered) state.selectedRuleIds.delete(r.id);
      }
      renderRules();
    };
    selectAllCheck.addEventListener("change", onSelectAllToggle);
    selectAllCheck.addEventListener("click", onSelectAllToggle);

    const bulkRight = make("div", "access-bulk-actions");
    const selectedCount = make("span", "access-bulk-count", "0 dipilih");
    selectedCount.id = "access-rule-selected-count";

    const bulkRevokeBtn = action("Cabut Terpilih", "access-bulk-revoke", () => {
      void revokeRulesBulk(Array.from(state.selectedRuleIds));
    });
    bulkRevokeBtn.id = "access-rule-bulk-revoke";
    bulkRevokeBtn.disabled = true;

    const bulkClearBtn = action("Batal", "access-bulk-clear", () => {
      state.selectedRuleIds.clear();
      renderRules();
    });
    bulkClearBtn.id = "access-rule-bulk-clear";
    bulkClearBtn.hidden = true;

    bulkRight.append(selectedCount, bulkRevokeBtn, bulkClearBtn);
    bulkBar.append(bulkSelectWrap, bulkRight);

    const rules = make("div","access-rule-list");
    rules.id = "access-rule-list";
    stored.append(h, summary, filterBar, bulkBar, rules);

    const auditPanel = make("div", "access-audit-panel");
    auditPanel.id = "access-audit-panel";
    const auditHead = make("div", "access-audit-head");
    const auditTitleWrap = make("div", "access-audit-title-wrap");
    const auditPulse = make("span", "access-live-pulse", "●");
    auditTitleWrap.append(make("h3", "", "Audit Trail Akses Native"), auditPulse, make("span", "access-count", "0 rekaman"));
    auditTitleWrap.lastChild.id = "access-audit-count";

    const auditActions = make("div", "access-audit-actions");
    const clearBtn = action("Bersihkan Log", "access-audit-clear", () => void clearAuditLog());
    clearBtn.id = "access-audit-clear";
    const auditRefreshBtn = action("Refresh Log", "access-audit-refresh", () => void refreshAuditLog());
    auditRefreshBtn.id = "access-audit-refresh";
    auditActions.append(clearBtn, auditRefreshBtn);
    auditHead.append(auditTitleWrap, auditActions);

    const auditList = make("div", "access-audit-list");
    auditList.id = "access-audit-list";
    auditPanel.append(auditHead, auditList);

    const navTabs = make("nav", "access-nav-tabs");
    navTabs.setAttribute("role", "tablist");
    navTabs.setAttribute("aria-label", "Kelompok Bagian Security Approval Manager");

    const tabRequests = make("button", "access-nav-tab active");
    tabRequests.id = "access-nav-tab-requests";
    tabRequests.type = "button";
    tabRequests.setAttribute("role", "tab");
    tabRequests.setAttribute("aria-selected", "true");
    tabRequests.setAttribute("aria-controls", "access-pane-requests");
    tabRequests.tabIndex = 0;
    const requestsBadge = make("span", "access-nav-tab-badge zero", "0");
    requestsBadge.id = "access-tab-badge-requests";
    tabRequests.append(
      make("span", "access-nav-tab-label", "Pusat Permintaan"),
      requestsBadge
    );
    tabRequests.addEventListener("click", () => setActiveTab("requests"));

    const tabRegister = make("button", "access-nav-tab");
    tabRegister.id = "access-nav-tab-register";
    tabRegister.type = "button";
    tabRegister.setAttribute("role", "tab");
    tabRegister.setAttribute("aria-selected", "false");
    tabRegister.setAttribute("aria-controls", "access-pane-register");
    tabRegister.tabIndex = -1;
    tabRegister.append(
      make("span", "access-nav-tab-label", "Aplikasi & File")
    );
    tabRegister.addEventListener("click", () => setActiveTab("register"));

    const tabRules = make("button", "access-nav-tab");
    tabRules.id = "access-nav-tab-rules";
    tabRules.type = "button";
    tabRules.setAttribute("role", "tab");
    tabRules.setAttribute("aria-selected", "false");
    tabRules.setAttribute("aria-controls", "access-pane-rules");
    tabRules.tabIndex = -1;
    const ruleBadge = make("span", "access-nav-tab-badge", "0");
    ruleBadge.id = "access-tab-badge-rules";
    tabRules.append(
      make("span", "access-nav-tab-label", "Aturan Aktif"),
      ruleBadge
    );
    tabRules.addEventListener("click", () => setActiveTab("rules"));

    const tabAudit = make("button", "access-nav-tab");
    tabAudit.id = "access-nav-tab-audit";
    tabAudit.type = "button";
    tabAudit.setAttribute("role", "tab");
    tabAudit.setAttribute("aria-selected", "false");
    tabAudit.setAttribute("aria-controls", "access-pane-audit");
    tabAudit.tabIndex = -1;
    const auditPulseDot = make("span", "access-live-pulse-dot", "●");
    const auditBadge = make("span", "access-nav-tab-badge", "0");
    auditBadge.id = "access-tab-badge-audit";
    tabAudit.setAttribute("aria-label", "Host access audit log");
    tabAudit.title = "Audit rekaman akses aplikasi dan file host";
    tabAudit.append(
      make("span", "access-nav-tab-label", "Audit Host"),
      auditPulseDot,
      auditBadge
    );
    tabAudit.addEventListener("click", () => setActiveTab("audit"));

    const tabMcp = make("button", "access-nav-tab");
    tabMcp.id = "access-nav-tab-mcp";
    tabMcp.type = "button";
    tabMcp.setAttribute("role", "tab");
    tabMcp.setAttribute("aria-selected", "false");
    tabMcp.setAttribute("aria-controls", "access-pane-mcp");
    tabMcp.tabIndex = -1;
    tabMcp.append(
      make("span", "access-nav-tab-label", "Akses Proyek")
    );
    tabMcp.addEventListener("click", () => setActiveTab("mcp"));

    const tabConnections = make("button", "access-nav-tab");
    tabConnections.id = "access-nav-tab-connections";
    tabConnections.type = "button";
    tabConnections.setAttribute("role", "tab");
    tabConnections.setAttribute("aria-selected", "false");
    tabConnections.setAttribute("aria-controls", "access-pane-connections");
    tabConnections.tabIndex = -1;
    const connectionBadge = make("span", "access-nav-tab-badge zero", "0");
    connectionBadge.id = "access-tab-badge-connections";
    tabConnections.append(make("span", "access-nav-tab-label", "Koneksi MCP"), connectionBadge);
    tabConnections.addEventListener("click", () => setActiveTab("connections"));

    navTabs.append(tabRequests, tabRegister, tabRules, tabConnections, tabMcp, tabAudit);
    const tabOrder = [tabRequests, tabRegister, tabRules, tabConnections, tabMcp, tabAudit];
    navTabs.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const selected = tabOrder.findIndex(tab => tab.getAttribute("aria-selected") === "true");
      if (selected < 0) return;
      const next = event.key === "Home" ? 0 : event.key === "End"
        ? tabOrder.length - 1 : (selected + (event.key === "ArrowRight" ? 1 : -1) + tabOrder.length) % tabOrder.length;
      event.preventDefault();
      tabOrder[next].click();
      tabOrder[next].focus?.();
    });

    const paneRegister = make("div", "access-pane");
    paneRegister.id = "access-pane-register";
    paneRegister.setAttribute("role", "tabpanel");
    paneRegister.setAttribute("aria-labelledby", "access-nav-tab-register");
    paneRegister.hidden = true;
    paneRegister.append(hostOverview, onboarding, split);

    const rulePermitBar = make("section", "access-editor access-mcp-intro access-rule-permit-banner");
    rulePermitBar.id = "access-rule-permit-banner";
    const permitHead = make("div", "access-mcp-intro-head");
    const permitCopy = make("div", "access-mcp-intro-copy");
    permitCopy.append(
      make("h3", "", "Request Permit Aturan Aktif"),
      make("p", "access-hint",
        "Semua permohonan izin (request permit) untuk file/folder host atau aplikasi desktop masuk dan dikelola di Pusat Permintaan bersama permohonan proyek.")
    );
    const permitControls = make("div", "access-mcp-pending-controls");
    const openPermitBtn = action("+ Ajukan Request Permit", "access-submit", () => {
      setActiveTab("requests");
      setRequestSubTab("rules");
      const form = $("access-req-rule-form");
      if (form) form.hidden = false;
      const toggle = $("access-req-new-rule-toggle");
      if (toggle) toggle.textContent = "Tutup Form";
    });
    openPermitBtn.id = "access-rules-open-permit-form";

    const viewPendingPermitsBtn = action("Buka Pusat Permintaan", "access-audit-refresh", () => {
      setActiveTab("requests");
      setRequestSubTab("rules");
    });
    viewPendingPermitsBtn.id = "access-rules-view-pending-permits";
    const pendingPermitBadge = make("span", "access-nav-tab-badge zero", "0 permintaan");
    pendingPermitBadge.id = "access-rules-pending-permit-badge";
    viewPendingPermitsBtn.append(pendingPermitBadge);
    permitControls.append(openPermitBtn, viewPendingPermitsBtn);
    permitHead.append(permitCopy, permitControls);
    rulePermitBar.append(permitHead);

    const paneRules = make("div", "access-pane");
    paneRules.id = "access-pane-rules";
    paneRules.setAttribute("role", "tabpanel");
    paneRules.setAttribute("aria-labelledby", "access-nav-tab-rules");
    paneRules.hidden = true;
    paneRules.append(
      make("p", "access-hint",
        "Aturan Aktif adalah kebijakan host untuk aplikasi, jendela, dan file/folder Core. Bukan daftar grant MCP per proyek. Untuk mengubah kemampuan agent, gunakan Akses Proyek."),
      rulePermitBar,
      stored);

    const paneAudit = make("div", "access-pane");
    paneAudit.id = "access-pane-audit";
    paneAudit.setAttribute("role", "tabpanel");
    paneAudit.setAttribute("aria-labelledby", "access-nav-tab-audit");
    paneAudit.hidden = true;
    paneAudit.append(auditPanel);

    const footer = make("p", "access-status", "Memuat kebijakan native...");
    footer.id = "access-status";
    footer.setAttribute("role", "status");
    footer.setAttribute("aria-live", "polite");

    const paneRequests = buildRequestCenterPane();
    const paneConnections = buildMcpConnectionsPane();
    const paneMcp = buildMcpPane();

    root.append(head, navTabs, paneRequests, paneRegister, paneRules, paneConnections, paneMcp, paneAudit, footer);
    parent.insertBefore(root, old);
    void refreshMcpRequests();
    void refreshPendingRuleRequests();
    void refreshDesktopUiSessionRequests();
    // Permanent host ACL and attended desktop input sessions are different
    // approvals. Retain the full trusted-session controls on demand.
    const trustPanel = make("section", "access-editor access-trusted-session");
    trustPanel.append(make("h3", "", "Sesi Desktop Input Sementara"),
      make("p", "access-hint", "Persetujuan input native per jendela tetap terpisah dari izin permanen dan izin MCP."));
    const toggleTrust = action("Buka pengaturan sesi Desktop Input", "access-audit-refresh", () => {
      old.hidden = !old.hidden;
      toggleTrust.textContent = old.hidden
        ? "Buka pengaturan sesi Desktop Input" : "Tutup pengaturan sesi Desktop Input";
      toggleTrust.setAttribute("aria-expanded", old.hidden ? "false" : "true");
    });
    toggleTrust.id = "access-trusted-session-toggle";
    toggleTrust.setAttribute("aria-controls", "desktop-trust-panel");
    toggleTrust.setAttribute("aria-expanded", "false");
    trustPanel.append(toggleTrust);
    paneRegister.append(trustPanel);
    paneRegister.append(old);
    old.hidden = true;
    updateTabFromHash();
    updateSelection();
  }
  async function install() {
    const old = $("desktop-trust-panel");
    if (!old || (!$("page-security-container") && !$("settings-subpage-security"))) return;
    try {
      // Hide legacy only after the native v2 command is verified.
      const registry = await invoke("get_permanent_access_registry");
      if (!registryValid(registry)) return;
      state.registry = registry;
      build();
      renderRegistry();
      // Register navigation before any optional/slow OS app discovery. Without
      // this, notification clicks during Tray startup silently lose their target.
      // Navigation only. Runtime Detection cannot issue or modify grants.
      window.__superagentAccessManagerOpenTab = (tabName) => {
        if (tabName !== "requests" && tabName !== "connections" && tabName !== "mcp") return;
        setActiveTab(tabName);
        void refreshMcpRequests();
        void refreshPendingRuleRequests();
        if (tabName === "requests") void refreshDesktopUiSessionRequests();
      };
      // Navigation-only notification affordance. The actual approval/deny
      // buttons remain protected by their existing native human review.
      window.__superagentAccessManagerFocusRequest = async (requestId, tabHint = null) => {
        if (typeof requestId !== "string" || !requestId || requestId.length > 150 ||
          /[\x00-\x1f]/.test(requestId)) return {targetFound:false};
        const tab = tabHint === "requests" || tabHint === "connections" || tabHint === "mcp" ? tabHint : null;
        if (window.__superagentPendingAccessNotificationId === requestId) {
          window.__superagentPendingAccessNotificationId = null;
          window.__superagentPendingAccessNotificationTab = null;
        }
        mcpNotificationFocus.id = requestId;
        mcpNotificationFocus.didFocus = false;
        setActiveTab(tab || "requests");
        if (tabHint === "desktop") setRequestSubTab("desktop");
        const wasRefreshing = Boolean(mcpCache.refreshing);
        await Promise.all([refreshMcpRequests(), refreshPendingRuleRequests(), refreshDesktopUiSessionRequests()]);
        let found = highlightMcpNotificationRequest() === true;
        if (!found && wasRefreshing) {
          await Promise.all([refreshMcpRequests(), refreshPendingRuleRequests(), refreshDesktopUiSessionRequests()]);
          found = highlightMcpNotificationRequest() === true;
        }
        return {targetFound:found,
          tab:state.activeTab};
      };
      window.__superagentAccessManagerRefresh = () => {
        void refreshMcpRequests({ queueIfBusy: true });
        void refreshPendingRuleRequests();
        void refreshDesktopUiSessionRequests();
        void refreshRegistry().catch(() => {});
        void refreshWindows().catch(() => {});
        void refreshInstalledApps().catch(() => {});
        void refreshAuditLog().catch(() => {});
        updateTabFromHash();
      };
      window.__TAURI__?.event?.listen?.("access-manager://requests-updated", () => {
        void refreshMcpRequests({ queueIfBusy: true });
        void refreshPendingRuleRequests();
        void refreshDesktopUiSessionRequests();
      });
      window.__TAURI__?.event?.listen?.("access-manager://focus-request-center", () => {
        setActiveTab("requests");
        void refreshMcpRequests();
        void refreshPendingRuleRequests();
        void refreshDesktopUiSessionRequests();
      });
      const refreshRequestsIfVisible = () => {
        if (document.visibilityState === "hidden") return;
        const pane = $("access-pane-requests");
        if (state.activeTab !== "requests" || !pane || pane.hidden) return;
        void refreshMcpRequests({ queueIfBusy: true });
        void refreshPendingRuleRequests();
        void refreshDesktopUiSessionRequests();
      };
      window.addEventListener("focus", refreshRequestsIfVisible);
      if (typeof setInterval === "function") {
        setInterval(refreshRequestsIfVisible, 4000);
      }
      const pendingNotificationId = window.__superagentPendingAccessNotificationId;
      const pendingNotificationTab = window.__superagentPendingAccessNotificationTab;
      if (typeof pendingNotificationId === "string")
        void window.__superagentAccessManagerFocusRequest(pendingNotificationId, pendingNotificationTab);
      void refreshAuditLog();
      showInitialSetupReminder();
      await refreshWindows();
      void refreshInstalledApps();
      window.addEventListener("hashchange", () => {
        if (location.hash === "#security" || location.hash.startsWith("#security:") ||
            location.hash === "#settings" || location.hash.startsWith("#settings:")) {
          updateTabFromHash();
          void refreshRegistry().catch(() => status("Registri native tidak tersedia.", "error"));
          void refreshAuditLog().catch(() => {});
        }
      });

    } catch {
      // Older installed Tray: preserve legacy panel, never fake active v2.
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void install());
  else void install();
})();