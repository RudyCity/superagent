"use strict";
(() => {
  // Native Tray Access Manager: no WebView-side policy writes or localStorage.
  // All grants are performed by the native host after OS verification + dialog.
  const $ = (id) => document.getElementById(id);
  const state = { registry: null, windows: [], installedApps: [], appSource: "active", selected: "", busy: false, view: "desktop", ruleFilter: "all", ruleSearch: "", auditLogs: [], activeTab: "register" };
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
      "access-src-active","access-src-installed","access-pick-exe"]) {
      const el = $(id);
      if (el) el.disabled = value;
    }
    const submit = $("access-submit");
    if (submit && !value) submit.disabled = state.view === "file"
      ? !$("access-file-path")?.value.trim()
      : !selectedTarget();
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

    const query = (state.ruleSearch || "").trim().toLowerCase();
    const filtered = allRules.filter(r => {
      if (state.ruleFilter !== "all" && r.kind !== state.ruleFilter) return false;
      if (!query) return true;
      const app = appName(r.app?.executablePath).toLowerCase();
      const path = (r.kind === "desktop" ? (r.scope?.windowTitle || "") : (r.scope?.path || "")).toLowerCase();
      const ops = (r.operations || []).join(" ").toLowerCase();
      return app.includes(query) || path.includes(query) || ops.includes(query);
    });

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
      const row = make("div", "access-rule-row");
      const symbol = make("span", "access-rule-effect " + rule.effect,
        rule.effect === "deny" ? "Blokir" : "Izinkan");
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
      renderRegistry();
      void refreshAuditLog();
      status("Aturan dicabut. Sesi input berikutnya akan ditolak.", "success");
    } catch (error) {
      status("Gagal mencabut aturan: " + String(error), "error");
    } finally {
      setBusy(false);
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
    if (auditBadge) auditBadge.textContent = String(state.auditLogs.length);
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
  function setActiveTab(tabName) {
    state.activeTab = tabName;
    const tabRegister = $("access-nav-tab-register");
    const tabRules = $("access-nav-tab-rules");
    const tabAudit = $("access-nav-tab-audit");
    const tabMcp = $("access-nav-tab-mcp");
    const paneRegister = $("access-pane-register");
    const paneRules = $("access-pane-rules");
    const paneAudit = $("access-pane-audit");
    const paneMcp = $("access-pane-mcp");

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
    if (hash.includes(":audit")) {
      setActiveTab("audit");
    } else if (hash.includes(":rules")) {
      setActiveTab("rules");
    } else if (hash.includes(":mcp") || hash.includes(":requests")) {
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
    reminder.setAttribute("role", "region");
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

  function buildMcpPane() {
    const pane = make("div", "access-pane");
    pane.id = "access-pane-mcp";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", "access-nav-tab-mcp");
    pane.hidden = true;

    const banner = make("div", "access-editor");
    banner.style.background = "linear-gradient(135deg, rgba(88,28,135,0.18), rgba(17,24,39,0.85))";
    banner.style.borderColor = "rgba(167,139,250,0.3)";
    const bannerTitle = make("h3", "", "🛡️ MCP Project Access & Security Approval Broker");
    const bannerDesc = make("p", "access-hint", "Agen MCP eksternal (Gemini, Claude, Cursor) tidak dapat menyetujui atau memperluas izin secara mandiri. Permintaan izin proyek diproses di sini dan memerlukan persetujuan eksplisit dari operator manusia.");
    bannerDesc.style.fontSize = "12px";
    bannerDesc.style.marginTop = "4px";
    banner.append(bannerTitle, bannerDesc);

    // Section 1: Pending Access Requests
    const reqSection = make("div", "access-stored");
    const reqHead = make("div", "access-audit-head");
    const reqTitleWrap = make("div", "access-audit-title-wrap");
    const reqTitle = make("h3", "", "Permintaan Akses Masuk (Pending Requests)");
    const reqBadge = make("span", "access-count", "0 permintaan");
    reqBadge.id = "access-mcp-pending-count";
    reqTitleWrap.append(reqTitle, reqBadge);

    const reqRefreshBtn = action("Refresh Permintaan", "access-audit-refresh", () => void refreshMcpRequests());
    reqHead.append(reqTitleWrap, reqRefreshBtn);

    const reqList = make("div", "access-audit-list");
    reqList.id = "access-mcp-pending-list";
    reqSection.append(reqHead, reqList);

    // Section 2: Direct Grant Form
    const grantSection = make("div", "access-editor");
    const grantTitle = make("h3", "", "Pemberian Izin Proyek Langsung (Direct Human Grant)");
    const grantDesc = make("p", "access-hint", "Izin file proyek dan izin MCP Connection Controls terpisah. Chat YOLO tidak memengaruhi MCP. Gunakan opsi MCP Connection Controls hanya untuk operasi non-proyek yang memerlukan execute.");
    grantDesc.style.fontSize = "11px";

    const grantForm = make("form");
    grantForm.id = "access-mcp-direct-grant-form";
    grantForm.style.display = "grid";
    grantForm.style.gap = "12px";
    grantForm.style.marginTop = "10px";

    const identField = field("Pilih Agen MCP Terhubung", select("access-mcp-ident-select", [["", "Memuat agen terhubung..."]]), "Identitas yang terdeteksi via transport MCP.");
    const projField = field("Pilih Proyek Target", select("access-mcp-proj-select", [["", "Memuat daftar proyek..."]]), "Direktori proyek lokal yang terdaftar.");

    const capsWrap = make("div");
    const capsLabel = make("span", "access-field-title", "Hak Akses (Capabilities):");
    const capsGrid = make("div");
    capsGrid.style.display = "flex";
    capsGrid.style.gap = "12px";
    capsGrid.style.marginTop = "6px";
    capsGrid.append(
      checkbox("access-cap-read", "Read (Baca)", true),
      checkbox("access-cap-write", "Write (Tulis/Edit)", false),
      checkbox("access-cap-execute", "Execute (Terminal)", false),
      checkbox("access-cap-git", "Git", false)
    );
    capsWrap.append(capsLabel, capsGrid);

    const grantBtn = action("Beri Izin Proyek", "access-submit", async () => {
      const identHandle = $("access-mcp-ident-select")?.value;
      const projId = $("access-mcp-proj-select")?.value;
      if (!identHandle || !projId) {
        status("Pilih agen dan proyek target terlebih dahulu.", "warn");
        return;
      }
      const caps = [];
      if ($("access-cap-read")?.querySelector("input")?.checked) caps.push("read");
      if ($("access-cap-write")?.querySelector("input")?.checked) caps.push("write");
      if ($("access-cap-execute")?.querySelector("input")?.checked) caps.push("execute");
      if ($("access-cap-git")?.querySelector("input")?.checked) caps.push("git");
      if (caps.length === 0) {
        status("Pilih minimal satu capability.", "warn");
        return;
      }
      if (!window.confirm("Berikan hak akses " + caps.join(", ") + " untuk proyek '" + projId + "' ke identitas MCP terpilih?\nAkses berlaku sampai dicabut.")) return;
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

    grantForm.append(identField, projField, capsWrap, grantBtn);
    grantSection.append(grantTitle, grantDesc, grantForm);

    // Section 3: History & Active Grants
    const histSection = make("div", "access-stored");
    const histHead = make("div", "access-audit-head");
    histHead.append(make("h3", "", "Riwayat Izin & Hak Akses Aktif"));
    const histList = make("div", "access-audit-list");
    histList.id = "access-mcp-history-list";
    histSection.append(histHead, histList);

    pane.append(banner, reqSection, grantSection, histSection);
    return pane;
  }

  async function refreshMcpRequests() {
    try {
      const [reqRes, identRes, projRes] = await Promise.all([
        invoke("mcp_project_access_action", { action: "requests" }).catch(() => ({ success: false })),
        invoke("mcp_project_access_action", { action: "identities" }).catch(() => ({ success: false })),
        invoke("mcp_project_access_action", { action: "projects" }).catch(() => ({ success: false })),
      ]);

      const requests = reqRes?.success && Array.isArray(reqRes.requests) ? reqRes.requests : [];
      const identities = identRes?.success && Array.isArray(identRes.identities) ? identRes.identities : [];
      const projects = projRes?.success && Array.isArray(projRes.projects) ? projRes.projects : [];

      const pending = requests.filter(r => r.status === "pending");
      const history = requests.filter(r => r.status !== "pending");

      const badgeCount = $("access-tab-badge-mcp");
      if (badgeCount) {
        badgeCount.textContent = String(pending.length);
        badgeCount.className = "access-nav-tab-badge" + (pending.length > 0 ? " pending" : "");
      }
      const countEl = $("access-mcp-pending-count");
      if (countEl) countEl.textContent = pending.length + " permintaan tertunda";

      // Render pending
      const listEl = $("access-mcp-pending-list");
      if (listEl) {
        listEl.replaceChildren();
        if (pending.length === 0) {
          listEl.append(make("p", "access-empty", "Tidak ada permintaan akses MCP yang tertunda saat ini."));
        } else {
          for (const req of pending) {
            const card = make("div", "access-audit-row");
            card.style.display = "grid";
            card.style.gap = "8px";
            card.style.padding = "12px";
            card.style.borderRadius = "10px";
            card.style.background = "rgba(139, 92, 246, 0.08)";
            card.style.border = "1px solid rgba(139, 92, 246, 0.25)";

            const top = make("div");
            top.style.display = "flex";
            top.style.justifyContent = "space-between";
            top.style.alignItems = "center";
            const agentTitle = make("strong", "", "🤖 " + req.subject + " (" + req.mode + ")");
            const timeSpan = make("small", "access-hint", new Date(req.createdAt).toLocaleTimeString());
            top.append(agentTitle, timeSpan);

            const projInfo = make("div");
            projInfo.append(
              make("div", "", "📁 Proyek: " + (req.projectName || req.projectId) + " (" + req.projectPath + ")"),
              make("div", "access-hint", "Alasan: \"" + req.reason + "\"")
            );

            const capsRow = make("div");
            capsRow.style.display = "flex";
            capsRow.style.gap = "6px";
            capsRow.style.alignItems = "center";
            capsRow.append(make("small", "", "Izin yang diminta:"));
            for (const cap of req.capabilities) {
              const capBadge = make("span", "access-permanent-pill", cap);
              capBadge.style.padding = "2px 8px";
              capsRow.append(capBadge);
            }

            const btnRow = make("div");
            btnRow.style.display = "flex";
            btnRow.style.gap = "8px";
            btnRow.style.marginTop = "6px";

            const approveBtn = action("Setujui Akses", "access-submit", async () => {
              try {
                status("Menyetujui permintaan akses...", "info");
                const data = await invoke("mcp_project_access_action", {
                  action: "approve",
                  payload: { requestId: req.requestId },
                });
                if (data.success) {
                  status("Izin untuk '" + req.projectName + "' disetujui.", "success");
                  void refreshMcpRequests();
                } else {
                  status("Gagal: " + (data.error || "Gagal menyetujui"), "error");
                }
              } catch (e) {
                status("Error: " + e.message, "error");
              }
            });

            const denyBtn = action("Tolak", "access-revoke", async () => {
              try {
                status("Menolak permintaan akses...", "info");
                const data = await invoke("mcp_project_access_action", {
                  action: "deny",
                  payload: { requestId: req.requestId },
                });
                if (data.success) {
                  status("Permintaan untuk '" + req.projectName + "' ditolak.", "warn");
                  void refreshMcpRequests();
                } else {
                  status("Gagal: " + (data.error || "Gagal menolak"), "error");
                }
              } catch (e) {
                status("Error: " + e.message, "error");
              }
            });

            btnRow.append(approveBtn, denyBtn);
            card.append(top, projInfo, capsRow, btnRow);
            listEl.append(card);
          }
        }
      }

      // Render history
      const histEl = $("access-mcp-history-list");
      if (histEl) {
        histEl.replaceChildren();
        if (history.length === 0) {
          histEl.append(make("p", "access-empty", "Belum ada riwayat izin proyek."));
        } else {
          for (const req of history.slice(0, 15)) {
            const row = make("div", "access-audit-row");
            row.style.display = "flex";
            row.style.justifyContent = "space-between";
            row.style.alignItems = "center";
            row.style.padding = "8px 12px";

            const left = make("div");
            const statusLabel = req.status === "approved" ? "✅ DISETUJUI" : req.status === "revoked" ? "⛔ DICABUT" : "❌ DITOLAK";
            left.append(
              make("strong", "", statusLabel + " · " + (req.projectName || req.projectId) + " (" + req.subject + ")"),
              make("small", "access-hint", " [" + req.capabilities.join(", ") + "] · " + new Date(req.decidedAt || req.createdAt).toLocaleString())
            );

            const right = make("div");
            if (req.status === "approved") {
              const revBtn = action("Cabut Izin", "access-revoke", async () => {
                try {
                  status("Mencabut izin...", "info");
                  const data = await invoke("mcp_project_access_action", {
                    action: "revoke",
                    payload: { requestId: req.requestId },
                  });
                  if (data.success) {
                    status("Izin proyek '" + req.projectName + "' dicabut.", "warn");
                    void refreshMcpRequests();
                  } else {
                    status("Gagal: " + (data.error || "Gagal mencabut"), "error");
                  }
                } catch (e) {
                  status("Error: " + e.message, "error");
                }
              });
              right.append(revBtn);
            }
            row.append(left, right);
            histEl.append(row);
          }
        }
      }

      // Populate dropdowns
      const identSelect = $("access-mcp-ident-select");
      if (identSelect) {
        identSelect.replaceChildren();
        if (identities.length === 0) {
          identSelect.append(option("", "Tidak ada agen aktif terhubung"));
        } else {
          for (const id of identities) {
            identSelect.append(option(id.identityHandle, id.subject + " (" + id.mode + ") - " + id.identityHandle));
          }
        }
      }

      const projSelect = $("access-mcp-proj-select");
      if (projSelect) {
        projSelect.replaceChildren();
        if (projects.length === 0) {
          projSelect.append(option("", "Tidak ada proyek terdaftar"));
        } else {
          for (const p of projects) {
            const target = p.target || p.root || p.canonicalTarget || "";
            projSelect.append(option(p.registeredProjectId || p.projectId || p.id, (p.name || p.id) + " (" + target + ")"));
          }
        }
        // Non-project actions require an independent, explicitly human-approved
        // MCP connection capability. This does not authorize any project files.
        projSelect.append(option("mcp-connection", "MCP Connection Controls (execute; no file access)"));
        projSelect.onchange = () => {
          if (projSelect.value !== "mcp-connection") return;
          for (const name of ["read", "write", "git"]) {
            const check = $("access-cap-" + name)?.querySelector("input");
            if (check) check.checked = false;
          }
          const execute = $("access-cap-execute")?.querySelector("input");
          if (execute) execute.checked = true;
        };
      }
    } catch (err) {
      console.warn("[AccessManager] refreshMcpRequests error:", err);
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
      make("p", "", "Registrasikan aplikasi sekali. Izin tetap berlaku sampai dicabut."));
    const pill = make("span", "access-permanent-pill", "● Registrasi permanen");
    head.append(intro,pill);

    const onboarding = make("div","access-onboarding");
    onboarding.id = "access-onboarding";
    onboarding.append(make("strong","","Mulai dengan aplikasi yang dipercaya"),
      make("p","","Default semua aplikasi diblokir. Pilih jendela aktif atau aplikasi terinstall, kemampuan yang boleh digunakan, lalu konfirmasi di dialog native."));
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

    const rules = make("div","access-rule-list");
    rules.id = "access-rule-list";
    stored.append(h, summary, filterBar, rules);

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

    const tabRegister = make("button", "access-nav-tab active");
    tabRegister.id = "access-nav-tab-register";
    tabRegister.type = "button";
    tabRegister.setAttribute("role", "tab");
    tabRegister.setAttribute("aria-selected", "true");
    tabRegister.setAttribute("aria-controls", "access-pane-register");
    tabRegister.tabIndex = 0;
    tabRegister.append(
      make("span", "access-nav-tab-icon", "➕"),
      make("span", "access-nav-tab-label", "Daftarkan Izin")
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
      make("span", "access-nav-tab-icon", "📋"),
      make("span", "access-nav-tab-label", "Aturan Terdaftar"),
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
    tabAudit.append(
      make("span", "access-nav-tab-icon", "📜"),
      make("span", "access-nav-tab-label", "Log Audit"),
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
    const mcpBadge = make("span", "access-nav-tab-badge", "0");
    mcpBadge.id = "access-tab-badge-mcp";
    tabMcp.append(
      make("span", "access-nav-tab-icon", "🛡️"),
      make("span", "access-nav-tab-label", "Izin Proyek MCP"),
      mcpBadge
    );
    tabMcp.addEventListener("click", () => setActiveTab("mcp"));

    navTabs.append(tabRegister, tabRules, tabAudit, tabMcp);

    const paneRegister = make("div", "access-pane");
    paneRegister.id = "access-pane-register";
    paneRegister.setAttribute("role", "tabpanel");
    paneRegister.setAttribute("aria-labelledby", "access-nav-tab-register");
    paneRegister.append(onboarding, split);

    const paneRules = make("div", "access-pane");
    paneRules.id = "access-pane-rules";
    paneRules.setAttribute("role", "tabpanel");
    paneRules.setAttribute("aria-labelledby", "access-nav-tab-rules");
    paneRules.hidden = true;
    paneRules.append(stored);

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

    const paneMcp = buildMcpPane();
    root.append(head, navTabs, paneRegister, paneRules, paneAudit, paneMcp, footer);
    void refreshMcpRequests();
    parent.insertBefore(root, old);
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
      window.__superagentAccessManagerRefresh = () => {
        void refreshRegistry().catch(() => {});
        void refreshWindows().catch(() => {});
        void refreshInstalledApps().catch(() => {});
        void refreshAuditLog().catch(() => {});
        updateTabFromHash();
      };
    } catch {
      // Older installed Tray: preserve legacy panel, never fake active v2.
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",()=>void install());
  else void install();
})();
