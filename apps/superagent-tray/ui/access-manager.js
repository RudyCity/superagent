"use strict";
(() => {
  // Native Tray Access Manager: no WebView-side policy writes or localStorage.
  // All grants are performed by the native host after OS verification + dialog.
  const $ = (id) => document.getElementById(id);
  const state = { registry: null, windows: [], selected: "", busy: false, view: "desktop" };
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
      "access-pick-file","access-pick-folder"]) {
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
      const registered = (state.registry?.rules || []).some(r =>
        r.kind === "desktop" && r.effect === "allow" &&
        (r.scope.windowTitle === w.title || !r.scope.windowTitle));
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
  function renderRules() {
    const list = $("access-rule-list");
    const count = $("access-rule-count");
    const empty = $("access-onboarding");
    if (!list) return;
    list.replaceChildren();
    const rules = state.registry?.rules || [];
    if (count) count.textContent = rules.length + " aturan";
    if (empty) empty.hidden = rules.length > 0;
    if (!rules.length) {
      list.append(make("p", "access-empty",
        "Belum ada aplikasi tepercaya. Registrasikan aplikasi dan pilih operasi yang diperbolehkan."));
      return;
    }
    for (const rule of rules) {
      const row = make("div", "access-rule-row");
      const symbol = make("span", "access-rule-effect " + rule.effect,
        rule.effect === "deny" ? "Blokir" : "Izinkan");
      const detail = make("div", "access-rule-detail");
      const op = rule.operations.join(", ");
      detail.append(make("strong", "", appName(rule.app.executablePath) + " · " + op),
        make("small", "", rule.kind === "desktop"
          ? [rule.scope.windowTitle || "Semua jendela aplikasi terverifikasi",
              rule.scope.elementRole ? "Role: "+rule.scope.elementRole : "",
              rule.scope.elementLabel ? "Label: "+rule.scope.elementLabel : ""].filter(Boolean).join(" · ")
          : rule.scope.path + (rule.scope.recursive ? " (termasuk subfolder)" : "")),
        make("small", "access-rule-meta", "Permanen sampai dicabut · SHA-256: " + rule.app.sha256.slice(0,12) + "…"));
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
      status("Aturan dicabut. Sesi input berikutnya akan ditolak.", "success");
    } catch (error) {
      status("Gagal mencabut aturan: " + String(error), "error");
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
      if (typeof location !== "undefined") location.hash = "#settings";
      $("settings-tab-btn-security")?.click();
      reminder.remove();
    }), action("Nanti", "access-revoke", () => reminder.remove()));
    reminder.append(message, controls);
    document.body.appendChild(reminder);
  }
  function build() {
    const parent = $("settings-subpage-security");
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
    const rules = make("div","access-rule-list");
    rules.id = "access-rule-list";
    stored.append(h,summary,rules);
    const footer=make("p","access-status","Memuat kebijakan native...");
    footer.id="access-status";footer.setAttribute("role","status");footer.setAttribute("aria-live","polite");
    root.append(head,onboarding,split,stored,footer);
    parent.insertBefore(root,old);
    old.hidden = true;
    updateSelection();
  }
  async function install() {
    const old = $("desktop-trust-panel");
    if (!old || !$("settings-subpage-security")) return;
    try {
      // Hide legacy only after the native v2 command is verified.
      const registry = await invoke("get_permanent_access_registry");
      if (!registryValid(registry)) return;
      state.registry = registry;
      build();
      renderRegistry();
      showInitialSetupReminder();
      await refreshWindows();
      window.addEventListener("hashchange",()=>{
        if (location.hash === "#settings" || location.hash.startsWith("#settings:")) {
          void refreshRegistry().catch(()=>status("Registri native tidak tersedia.","error"));
        }
      });
    } catch {
      // Older installed Tray: preserve legacy panel, never fake active v2.
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",()=>void install());
  else void install();
})();
