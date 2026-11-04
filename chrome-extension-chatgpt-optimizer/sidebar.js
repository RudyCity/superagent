/* Refreshes an extension-owned sidebar section; does not mutate ChatGPT's conversation state. */
(() => {
  "use strict";
  if (globalThis.__chatgptOptimizerSidebarActive) return;
  globalThis.__chatgptOptimizerSidebarActive = true;

  const SETTINGS_KEY = "superagentChatGPTLiteSettings";
  const SCOPE = "chatgpt-optimizer-sidebar-v1";
  const policy = globalThis.ChatGPTLitePolicy;
  // The primary ChatGPT list excludes TPP-specialized conversations whose
  // destination may not use the regular /c/:id route.
  const RECENTS_URL = "/backend-api/conversations?exclude_conversation_origin=tpp&expand=false&hide_snorlax=false&is_archived=false&is_starred=false&limit=20&order=updated&offset=0";
  const MIN_REFRESH_GAP_MS = 10_000;
  let settings = policy.normalizeSettings();
  let timer = null;
  let observer = null;
  let attachTimer = null;
  let container = null;
  let newest = [];
  let renderedLinksKey = null;
  let running = null;
  let generation = 0;
  const status = {
    phase: "idle", lastSuccess: 0, lastAttempt: 0,
    serverCount: 0, missingCount: 0, error: "",
  };

  const enabled = () => settings.enabled && settings.sidebarSync;
  const state = () => ({ ...status, enabled: enabled(), interval: settings.sidebarInterval });

  function chatHistoryNav() {
    return document.querySelector('nav[aria-label="Chat history"]');
  }

  function recentSection(nav) {
    const toggles = nav?.querySelectorAll('button[data-app-action-sidebar-section-toggle]') || [];
    for (const toggle of toggles) {
      if (toggle.textContent?.trim() !== "Recents") continue;
      let item = toggle.parentElement;
      while (item && item !== nav) {
        if (item.classList?.contains("group/nav-section")) return item;
        item = item.parentElement;
      }
    }
    return null;
  }

  function presentChatIds(nav) {
    const ids = new Set();
    for (const a of nav?.querySelectorAll('a[href^="/c/"]') || []) {
      if (a.closest?.(".sg-opt-sidebar")) continue;
      const m = /^\/c\/([a-z0-9-]{8,80})\/?$/i.exec(a.getAttribute("href") || "");
      if (m) ids.add(m[1]);
    }
    return ids;
  }

  function makeElement(tag, cls, label) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (label) node.textContent = label;
    return node;
  }

  function buildContainer() {
    const root = makeElement("section", "sg-opt-sidebar");
    root.setAttribute("aria-label", "ChatGPT Optimizer live recent chats");
    root.setAttribute("data-sg-opt-sidebar", "1");

    const top = makeElement("div", "sg-opt-sidebar-top");
    const heading = makeElement("span", "sg-opt-sidebar-title", "Live updates");
    const refresh = makeElement("button", "sg-opt-sidebar-refresh", "↻");
    refresh.type = "button";
    refresh.title = "Refresh recent chats";
    refresh.setAttribute("aria-label", "Refresh recent chats");
    refresh.addEventListener("click", () => void refresh(true));
    top.append(heading, refresh);
    const info = makeElement("p", "sg-opt-sidebar-info", "Checking for recent chats…");
    info.setAttribute("aria-live", "polite");
    const links = makeElement("ul", "sg-opt-sidebar-links");
    root.append(top, info, links);
    return root;
  }

  function ensurePlaced() {
    if (!enabled()) return false;
    const nav = chatHistoryNav();
    if (!nav) return false;
    const section = recentSection(nav);
    if (!section) return false;
    if (!container) container = buildContainer();
    // NEVER inject into a React-owned sidebar list. React may reconcile its
    // children at any time and can tear down the active conversation on mismatch.
    // A body-level portal, outside ChatGPT's application root, remains isolated.
    if (container.parentElement !== document.body) document.body.appendChild(container);
    const toggle = section.querySelector('button[data-app-action-sidebar-section-toggle]');
    container.hidden = toggle?.getAttribute("aria-expanded") === "false";
    return true;
  }

  function render() {
    if (!enabled()) {
      container?.remove();
      return;
    }
    if (!ensurePlaced()) return;
    const nav = chatHistoryNav();
    const present = presentChatIds(nav);
    const missing = status.phase === "error" ? [] :
      newest.filter((item) => !present.has(item.id)).slice(0, 8);
    status.missingCount = missing.length;

    const info = container.querySelector(".sg-opt-sidebar-info");
    const links = container.querySelector(".sg-opt-sidebar-links");
    const refreshButton = container.querySelector(".sg-opt-sidebar-refresh");
    if (refreshButton) refreshButton.disabled = status.phase === "syncing";

    const summary = status.phase === "syncing" ? "Checking for updates…" :
      status.phase === "error" ? status.error :
      status.phase === "ready" && missing.length > 0 ? `${missing.length} recent chat(s) not in the built-in list` :
      status.phase === "ready" ? "Recent chats are up to date" : "Waiting for first sync";
    if (info && info.textContent !== summary) info.textContent = summary;
    const linksKey = JSON.stringify(missing.map((item) => [item.id, item.title]));
    if (links && renderedLinksKey !== linksKey) {
      renderedLinksKey = linksKey;
      // Only touch extension-owned nodes, and only when the list changes.
      links.replaceChildren();
      for (const item of missing) {
        const row = makeElement("li", "sg-opt-sidebar-item");
        const link = makeElement("a", "sg-opt-sidebar-link", item.title);
        link.setAttribute("href", `/c/${item.id}`);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        link.setAttribute("title", `${item.title} — open in a separate tab`);
        // Native browser navigation opens a *new* tab; never replace the active
        // working conversation or route through undocumented ChatGPT internals.
        link.addEventListener("click", (event) => event.stopPropagation());
        row.appendChild(link);
        links.appendChild(row);
      }
    }
  }

  function normalizeResponse(payload) {
    if (!payload || !Array.isArray(payload.items)) throw new Error("Invalid conversation response");
    return payload.items;
  }

  async function loadConversations() {
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(12_000) : undefined;
    const opts = {
      credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json" }, signal,
    };
    // Read the first-party session only in this isolated content-script context.
    // The access token is never persisted, returned to the popup or logged.
    const sessionResponse = await fetch("/api/auth/session", opts);
    if (!sessionResponse.ok) throw new Error("Session unavailable");
    const session = await sessionResponse.json();
    const accessToken = typeof session?.accessToken === "string" ? session.accessToken : "";
    if (!accessToken) throw new Error("Sign in to ChatGPT to sync recent chats");
    const headers = { Accept: "application/json", Authorization: `Bearer ${accessToken}` };
    const response = await fetch(RECENTS_URL, { ...opts, headers });
    if (!response.ok) throw new Error("History request failed");
    const items = normalizeResponse(await response.json());
    // Retain only sanitized titles and IDs in tab memory, never full messages,
    // session data, mapping/snippets or hidden token-bearing metadata.
    return policy.normalizeSidebarChats(items);
  }

  async function refresh(manual = false) {
    if (!enabled()) {
      status.phase = "disabled";
      status.error = "";
      render();
      return state();
    }
    if (running) return running;
    const now = Date.now();
    if (now - status.lastAttempt < MIN_REFRESH_GAP_MS && !manual) return state();
    if (now - status.lastAttempt < 1500) return state();
    const started = generation;
    status.lastAttempt = now;
    status.phase = "syncing";
    status.error = "";
    render();
    running = (async () => {
      try {
        const list = await loadConversations();
        if (started !== generation || !enabled()) return state();
        newest = list;
        status.phase = "ready";
        status.lastSuccess = Date.now();
        status.serverCount = list.length;
      } catch (error) {
        if (started !== generation || !enabled()) return state();
        status.phase = "error";
        // Do not put server response/error details containing user data in the UI.
        status.error = /Sign in/.test(String(error?.message)) ?
          "Sign in to ChatGPT to sync" : "Unable to refresh. ChatGPT may have changed its API.";
      } finally {
        running = null;
        render();
      }
      return state();
    })();
    return running;
  }

  function disconnectObserver() {
    observer?.disconnect();
    observer = null;
    if (attachTimer) clearTimeout(attachTimer);
    attachTimer = null;
  }

  function armObserver() {
    disconnectObserver();
    if (!enabled()) return;
    observer = new MutationObserver((records) => {
      // A React sidebar render can replace our container. Avoid reacting to
      // our own injected list/labels so no observer-driven feedback loops occur.
      const externalChange = records.some((record) => {
        const target = record.target;
        return !(target?.closest?.("[data-sg-opt-sidebar]") ||
          target?.getAttribute?.("data-sg-opt-sidebar") === "1");
      });
      if (!externalChange || attachTimer) return;
      attachTimer = setTimeout(() => {
        attachTimer = null;
        render();
      }, 250);
    });
    observer.observe(document.body, { subtree: true, childList: true });
  }

  function configure() {
    generation++;
    if (timer) clearInterval(timer);
    timer = null;
    if (!enabled()) {
      status.phase = "disabled";
      newest = [];
      renderedLinksKey = null;
      container?.remove();
      disconnectObserver();
      return;
    }
    armObserver();
    render();
    timer = setInterval(() => {
      if (!document.hidden) void refresh(false);
    }, settings.sidebarInterval * 1000);
    if (!document.hidden) void refresh(false);
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.scope !== SCOPE || sender?.id !== chrome.runtime.id) return false;
    if (message.action === "status") {
      render();
      reply({ ok: true, state: state() });
      return false;
    }
    if (message.action === "refresh") {
      void refresh(true).then((result) => reply({ ok: true, state: result }));
      return true;
    }
    reply({ ok: false, error: "UNKNOWN_ACTION" });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    settings = policy.normalizeSettings(changes[SETTINGS_KEY].newValue);
    configure();
  });

  window.addEventListener("focus", () => {
    if (enabled() && Date.now() - status.lastAttempt >= MIN_REFRESH_GAP_MS) void refresh(false);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && enabled()) void refresh(false);
  });

  void (async () => {
    try {
      const saved = await chrome.storage.local.get(SETTINGS_KEY);
      settings = policy.normalizeSettings(saved[SETTINGS_KEY]);
    } catch {
      // Safe defaults are used if extension storage is temporarily unavailable.
    }
    configure();
  })();
})();
