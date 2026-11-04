(() => {
  "use strict";
  const KEY = "superagentChatGPTLiteSettings";
  const SCOPE = "superagent-chatgpt-lite-v1";
  const SIDEBAR_SCOPE = "chatgpt-optimizer-sidebar-v1";
  const policy = globalThis.ChatGPTLitePolicy;
  const fields = ["enabled", "mode", "keepLast", "showControls", "sidebarSync", "sidebarInterval"];
  const el = (id) => document.getElementById(id);
  let settings = policy.normalizeSettings();
  let tabId = null;
  let requestActive = false;

  function setStatus(text, kind = "") {
    el("status").textContent = text;
    el("status").className = `status ${kind}`.trim();
  }

  function paintSettings() {
    el("enabled").checked = settings.enabled;
    el("mode").value = settings.mode;
    el("keepLast").value = String(settings.keepLast);
    el("showControls").checked = settings.showControls;
    el("sidebarSync").checked = settings.sidebarSync;
    el("sidebarInterval").value = String(settings.sidebarInterval);
    el("mode-help").textContent = settings.mode === "compact"
      ? "Only recent messages are visible. Older messages can be restored at any time."
      : "Optimizes painting of older offscreen messages only. All messages stay in the DOM for Delegate; React memory is not reduced.";
    el("keepLast").disabled = !settings.enabled || settings.mode !== "compact";
    el("showControls").disabled = !settings.enabled || settings.mode !== "compact";
    el("sidebarSync").disabled = !settings.enabled;
    el("sidebarInterval").disabled = !settings.enabled || !settings.sidebarSync;
  }

  async function send(scope, action) {
    if (tabId === null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { scope, action });
    } catch {
      return null;
    }
  }

  function paintSidebar(state) {
    const field = el("sidebar-sync-status");
    if (!state) {
      field.textContent = "Open ChatGPT and reload its tab after updating.";
    } else if (!state.enabled) {
      field.textContent = "Sidebar synchronization is off";
    } else if (state.phase === "syncing") {
      field.textContent = "Checking recent chats…";
    } else if (state.phase === "error") {
      field.textContent = state.error || "Synchronization failed";
    } else if (state.phase === "ready") {
      field.textContent = `${state.serverCount} recent chats checked · ${state.missingCount} not yet in native Recents · ${new Date(state.lastSuccess).toLocaleTimeString()}`;
    } else {
      field.textContent = "Waiting for first sync…";
    }
    el("refresh-sidebar").disabled = !state?.enabled;
  }

  async function readStatus() {
    if (requestActive) return;
    requestActive = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const address = tab?.url;
      if (!address || !/^https:\/\/chatgpt\.com(?:\/|$)/i.test(address)) {
        tabId = null;
        setStatus("Open chatgpt.com to view statistics.", "error");
        paintCounters(null);
        paintSidebar(null);
        return;
      }
      tabId = tab.id;
      const result = await send(SCOPE, "status");
      if (!result?.ok) {
        paintCounters(null);
        paintSidebar(null);
        setStatus("Reload your ChatGPT tab after installing the extension.", "error");
        return;
      }
      paintCounters(result.state);
      const sidebarResult = await send(SIDEBAR_SCOPE, "status");
      paintSidebar(sidebarResult?.ok ? sidebarResult.state : null);
      const failed = settings.enabled && settings.mode === "render" &&
        ["css-inactive", "css-partial", "no-targets"].includes(result.state.renderState);
      setStatus(failed ? "Render ringan tidak efektif pada halaman ini"
        : settings.enabled ? "Optimizer aktif" : "Optimizer nonaktif",
        failed ? "error" : settings.enabled ? "success" : "");
    } catch {
      setStatus("Unable to query the current tab.", "error");
      paintSidebar(null);
    } finally {
      requestActive = false;
    }
  }

  function paintCounters(state) {
    el("total").textContent = state ? String(state.total) : "—";
    el("optimized").textContent = state ? String(state.optimized) : "—";
    el("hidden").textContent = state ? String(state.hidden) : "—";
    const diagnostic = el("render-diagnostic");
    diagnostic.className = "render-diagnostic";
    const mode = state?.settings?.mode ?? settings.mode;
    if (!state) {
      diagnostic.textContent = "Belum bisa membaca status optimasi di tab ini.";
    } else if (!state.settings?.enabled) {
      diagnostic.textContent = "Optimasi dinonaktifkan; semua atribut lama dilepas.";
    } else if (mode === "compact") {
      diagnostic.textContent = state.hidden > 0
        ? `${state.hidden} pesan lama diringkas (DOM tetap ada).`
        : "Mode ringkas aktif, tetapi tidak ada pesan yang perlu disembunyikan.";
    } else if (state.renderState === "verified") {
      diagnostic.textContent = state.skipCheckCount > 0
        ? `CSS aktif pada ${state.verifiedSamples}/${state.sampledCount} sampel; ${state.skippedSamples}/${state.skipCheckCount} sampel konten sedang dilewati browser. Ini bukan benchmark FPS/memori.`
        : "CSS content-visibility: auto terverifikasi. Hanya konten di luar layar yang berpotensi dilewati; FPS/memori belum diukur.";
      diagnostic.className = "render-diagnostic success";
    } else if (state.renderState === "css-partial") {
      diagnostic.textContent = `CSS aktif hanya pada ${state.verifiedSamples}/${state.sampledCount} elemen sampel. Ada elemen lama yang belum teroptimasi.`;
      diagnostic.className = "render-diagnostic error";
    } else if (state.renderState === "css-inactive") {
      diagnostic.textContent = "CSS optimasi tidak efektif pada elemen yang diperiksa. Periksa pemasangan ekstensi.";
      diagnostic.className = "render-diagnostic error";
    } else if (state.renderState === "no-targets") {
      diagnostic.textContent = "Pesan ditemukan tetapi tidak punya elemen layout yang aman untuk dioptimasi.";
      diagnostic.className = "render-diagnostic error";
    } else if (state.renderState === "no-messages") {
      diagnostic.textContent = "Belum menemukan pesan percakapan. Buka chat yang sudah termuat.";
    } else if (state.renderState === "short-chat") {
      diagnostic.textContent = "Chat masih pendek (≤4 pesan); CSS offscreen belum diperlukan.";
    } else {
      diagnostic.textContent = "Penanda optimasi terpasang; verifikasi CSS belum tersedia.";
    }
    const allow = !!state && settings.enabled && settings.mode === "compact";
    el("more").disabled = !allow || state.hidden === 0;
    el("all").disabled = !allow || state.hidden === 0;
    el("reset").disabled = !allow || (!state.showAll && state.revealedExtra === 0);
  }

  async function saveSettings() {
    const value = Object.fromEntries(fields.map((key) => [
      key, ["enabled", "showControls", "sidebarSync"].includes(key)
        ? el(key).checked
        : ["keepLast", "sidebarInterval"].includes(key) ? Number(el(key).value) : el(key).value,
    ]));
    settings = policy.normalizeSettings(value);
    paintSettings();
    try {
      await chrome.storage.local.set({ [KEY]: settings });
      await readStatus();
    } catch {
      setStatus("Could not save extension settings.", "error");
    }
  }

  async function onAction(action) {
    const result = await send(SCOPE, action);
    if (!result?.ok) {
      setStatus("ChatGPT tab is not ready. Reload the tab.", "error");
      return;
    }
    paintCounters(result.state);
    setStatus("Display updated.", "success");
  }

  async function refreshSidebar() {
    el("refresh-sidebar").disabled = true;
    el("sidebar-sync-status").textContent = "Refreshing recent chats…";
    const result = await send(SIDEBAR_SCOPE, "refresh");
    paintSidebar(result?.ok ? result.state : null);
  }

  async function initialize() {
    try {
      const result = await chrome.storage.local.get(KEY);
      settings = policy.normalizeSettings(result[KEY]);
    } catch {
      setStatus("Unable to read extension settings.", "error");
    }
    paintSettings();
    for (const key of fields) el(key).addEventListener("change", () => void saveSettings());
    el("more").addEventListener("click", () => void onAction("show_more"));
    el("all").addEventListener("click", () => void onAction("show_all"));
    el("reset").addEventListener("click", () => void onAction("reset_view"));
    el("refresh-sidebar").addEventListener("click", () => void refreshSidebar());
    await readStatus();
    setInterval(() => { void readStatus(); }, 3000);
  }
  void initialize();
})();
