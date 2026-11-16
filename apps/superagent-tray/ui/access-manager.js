"use strict";
(() => {
  // Native Tray Access Manager: no WebView-side policy writes or localStorage.
  // All grants are performed by the native host after OS verification + dialog.
  const $ = (id) => document.getElementById(id);
  const state = { registry: null, windows: [], selected: "", busy: false, view: "desktop", ruleFilter: "all", ruleSearch: "", auditLogs: [] };
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
      "access-pick-file","access-pick-folder","access-audit-clear","access-audit-refresh"]) {
      const el = $(id);
      if (el) el.disabled = value;
    }
    const submit = $("access-submit");
    if (submit && !value) submit.disabled = state.view === "file"
      ? !$("access-file-path")?.value.trim()
      : !state.selected;
  }
  function appName(path) {
    return String(path || "Unknown executable").split(/[\\/]/).pop() || "Unknown executable";
  }
  function selectedWindow() {
    return state.windows.find(w => String(w.pid) + ":" + w.nativeId === state.selected);
  }
  function renderCandidateList() {
    const list = $("access-app-list");
    if (!list) return;
    list.replaceChildren();
    const query = ($("access-search")?.value || "").trim().toLowerCase();
    const candidates = state.windows.filter(w =>
      (w.application + " " + w.title).toLowerCase().includes(query));
    if (!candidates.length) list.append(make("p", "access-empty", "Tidak ada jendela cocok. Buka aplikasinya, lalu klik Refresh."));
    for (const w of candidates) {
      const key = String(w.pid) + ":" + w.nativeId;
      const row = action("", "access-app-row" + (key === state.selected ? " selected" : ""), () => {
        state.selected = key;
        renderCandidateList();
        updateSelection();
      });
      const avatar = make("span", "access-app-avatar", (w.application[0] || "A").toUpperCase());
      const description = make("span", "access-app-description");
      description.append(make("strong", "", w.application), make("small", "", w.title));
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
  }
  function updateSelection() {
    const active = selectedWindow();
    const title = $("access-selected-title");
    if (title) title.textContent = active ? active.application : "Pilih aplikasi";
    const sub = $("access-selected-subtitle");
    if (sub) sub.textContent = active
      ? active.title + " · PID " + active.pid
      : "Pilih jendela aktif dari daftar untuk registrasi.";
    const submit = $("access-submit");
    if (submit) submit.disabled = state.busy || (state.view === "file"
      ? !$("access-file-path")?.value.trim()
      : !active);
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
      if (!selectedWindow()) state.selected = "";
      renderCandidateList();
      updateSelection();
      status(state.windows.length + " jendela ditemukan. Pilih aplikasi untuk membuat aturan.");
    } catch {
      state.windows = []; state.selected = "";
      renderCandidateList(); updateSelection();
      status("Jendela tidak bisa diverifikasi. Periksa Core dan fokuskan Tray.", "error");
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
    const window = selectedWindow();
    if (kind === "desktop" && !window) return;
    const operations = [];
    if (kind === "desktop") {
      if ($("access-view")?.checked) operations.push("view");
      if ($("access-input")?.checked) operations.push("input");
      if ($("access-element-label").value.trim() && !$("access-element-role").value.trim()) {
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
        pid: kind === "desktop" ? window.pid : 0,
        nativeId: kind === "desktop" ? window.nativeId : "",
        effect: $("access-effect").value,
        kind, operations,
        exactWindow: kind === "desktop" && $("access-exact").checked,
        elementRole: kind === "desktop" ? ($("access-element-role").value.trim() || null) : null,
        elementLabel: kind === "desktop" ? ($("access-element-label").value.trim() || null) : null,
        filePath: kind === "file" ? $("access-file-path").value.trim() : null,
        recursive: kind === "file" ? $("access-file-recursive").checked : null,
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
      make("p","","Default semua aplikasi diblokir. Pilih jendela aktif, kemampuan yang boleh digunakan, lalu konfirmasi di dialog native."));
    const topbar = make("div","access-toolbar");
    const search = make("input","access-search");
    search.id = "access-search"; search.placeholder = "Cari aplikasi / jendela..."; search.type = "search";
    search.addEventListener("input",renderCandidateList);
    topbar.append(search,action("Refresh","access-refresh",()=>void refreshWindows()));
    topbar.lastChild.id = "access-refresh";

    const split = make("div","access-layout");
    const aside = make("aside","access-sidebar");
    aside.append(make("div","access-section-label","Aplikasi aktif"),
      topbar);
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

    const footer=make("p","access-status","Memuat kebijakan native...");
    footer.id="access-status";footer.setAttribute("role","status");footer.setAttribute("aria-live","polite");
    root.append(head,onboarding,split,stored,auditPanel,footer);
    parent.insertBefore(root,old);
    old.hidden = true;
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
      window.addEventListener("hashchange",()=>{
        if (location.hash === "#security" || location.hash.startsWith("#security:") ||
            location.hash === "#settings" || location.hash.startsWith("#settings:")) {
          void refreshRegistry().catch(()=>status("Registri native tidak tersedia.","error"));
          void refreshAuditLog().catch(() => {});
        }
      });
      window.__superagentAccessManagerRefresh = () => {
        void refreshRegistry().catch(() => {});
        void refreshWindows().catch(() => {});
        void refreshAuditLog().catch(() => {});
      };
    } catch {
      // Older installed Tray: preserve legacy panel, never fake active v2.
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",()=>void install());
  else void install();
})();
