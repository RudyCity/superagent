/* ChatGPT Optimizer content script (isolated world). No deletion of React-owned nodes. */
(() => {
  "use strict";
  if (globalThis.__superagentChatGPTLiteActive) return;
  globalThis.__superagentChatGPTLiteActive = true;

  const SCOPE = "superagent-chatgpt-lite-v1";
  const KEY = "superagentChatGPTLiteSettings";
  const policy = globalThis.ChatGPTLitePolicy;
  if (!policy) return;

  let settings = policy.normalizeSettings();
  let lastPath = location.pathname;
  let revealExtra = 0;
  let showAll = false;
  let previousTurns = new Set();
  let hud = null;
  let pending = null;
  let lastStatus = { total: 0, hidden: 0, optimized: 0 };
  let observer = null;

  function clearAttributes(element) {
    element.removeAttribute("data-sg-lite-hidden");
    element.removeAttribute("data-sg-lite-render");
  }

  // Prefer whole message/turn wrappers; never select the React conversation root.
  function findTurns() {
    const marked = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
    const outer = marked.filter((el) =>
      !el.parentElement?.closest?.('[data-testid^="conversation-turn-"]'));
    if (outer.length) return outer;

    const roleElements = Array.from(document.querySelectorAll("[data-message-author-role]"));
    const seen = new Set();
    const turns = [];
    for (const roleElement of roleElements) {
      const article = roleElement.closest?.("article");
      // Guard against a broad article wrapping the entire conversation.
      const node = article?.querySelectorAll?.("[data-message-author-role]").length === 1
        ? article : roleElement;
      if (!seen.has(node)) {
        seen.add(node);
        turns.push(node);
      }
    }
    return turns;
  }

  function isProtectedTurn(node) {
    const focused = document.activeElement;
    if (focused && node.contains?.(focused)) return true;
    const selection = window.getSelection?.();
    if (!selection || selection.isCollapsed) return false;
    return !!(selection.anchorNode && node.contains?.(selection.anchorNode)) ||
      !!(selection.focusNode && node.contains?.(selection.focusNode));
  }

  function resetRoute() {
    for (const node of previousTurns) clearAttributes(node);
    previousTurns.clear();
    lastPath = location.pathname;
    revealExtra = 0;
    showAll = false;
    lastStatus = { total: 0, hidden: 0, optimized: 0 };
    hud?.box.remove();
    hud = null;
  }

  function createHud() {
    const box = document.createElement("section");
    box.className = "sg-chatgpt-lite-ui";
    box.setAttribute("data-sg-lite-ui", "1");
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "ChatGPT Optimizer: pesan lama diringkas");

    const title = document.createElement("strong");
    title.textContent = "ChatGPT Optimizer";
    const summary = document.createElement("p");
    summary.setAttribute("aria-live", "polite");
    const buttons = document.createElement("div");
    buttons.className = "sg-lite-buttons";

    const showMore = document.createElement("button");
    showMore.type = "button";
    showMore.textContent = "+20 pesan";
    showMore.addEventListener("click", () => {
      revealExtra += 20;
      showAll = false;
      scan();
    });
    const showEverything = document.createElement("button");
    showEverything.type = "button";
    showEverything.textContent = "Lihat semua";
    showEverything.addEventListener("click", () => {
      showAll = true;
      scan();
    });
    buttons.append(showMore, showEverything);
    box.append(title, summary, buttons);
    document.body.appendChild(box);
    return { box, summary };
  }

  function updateHud(hidden) {
    if (!settings.enabled || settings.mode !== "compact" ||
        !settings.showControls || hidden <= 0) {
      hud?.box.remove();
      hud = null;
      return;
    }
    if (!hud) hud = createHud();
    hud.summary.textContent = `${hidden} pesan lama disembunyikan; riwayat tetap ada.`;
  }

  function scan() {
    if (pending) { clearTimeout(pending); pending = null; }
    if (location.pathname !== lastPath) resetRoute();

    const turns = settings.enabled ? findTurns() : [];
    const plan = policy.plan(turns.length, settings, revealExtra, showAll);
    const current = new Set(turns);
    for (const oldTurn of previousTurns) {
      if (!current.has(oldTurn) || !settings.enabled) clearAttributes(oldTurn);
    }

    let hidden = 0;
    let optimized = 0;
    for (let i = 0; i < turns.length; i++) {
      const el = turns[i];
      const protectedTurn = isProtectedTurn(el);
      const hide = i < plan.hiddenCount && !protectedTurn;
      const optimize = i < plan.optimizeBefore && !hide && !protectedTurn;
      // Only idempotent attributes change, never child nodes, innerHTML,
      // native event handlers, editor values or ChatGPT data stores.
      if (hide) {
        if (el.getAttribute("data-sg-lite-hidden") !== "1") el.setAttribute("data-sg-lite-hidden", "1");
      } else {
        el.removeAttribute("data-sg-lite-hidden");
      }
      if (optimize) {
        if (el.getAttribute("data-sg-lite-render") !== "1") el.setAttribute("data-sg-lite-render", "1");
      } else {
        el.removeAttribute("data-sg-lite-render");
      }
      if (hide) hidden++;
      if (optimize) optimized++;
    }

    previousTurns = current;
    lastStatus = { total: turns.length, hidden, optimized };
    updateHud(hidden);
  }

  function scheduleScan(delay = 350) {
    if (pending !== null) return;
    pending = setTimeout(() => { pending = null; scan(); }, delay);
  }

  function status() {
    return {
      active: true,
      pathname: location.pathname,
      settings,
      ...lastStatus,
      revealedExtra: revealExtra,
      showAll,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.scope !== SCOPE || sender?.id !== chrome.runtime.id) return false;
    if (message.action === "status") {
      scan();
      reply({ ok: true, state: status() });
    } else if (message.action === "show_more") {
      revealExtra += 20;
      showAll = false;
      scan();
      reply({ ok: true, state: status() });
    } else if (message.action === "show_all") {
      showAll = true;
      scan();
      reply({ ok: true, state: status() });
    } else if (message.action === "reset_view") {
      revealExtra = 0;
      showAll = false;
      scan();
      reply({ ok: true, state: status() });
    } else {
      reply({ ok: false, error: "UNKNOWN_ACTION" });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    settings = policy.normalizeSettings(changes[KEY].newValue);
    revealExtra = 0;
    showAll = false;
    scan();
  });

  async function initialize() {
    try {
      const data = await chrome.storage.local.get(KEY);
      settings = policy.normalizeSettings(data[KEY]);
    } catch (error) {
      console.warn("[ChatGPT Optimizer] Storage unavailable; applying safe defaults", error);
    }
    scan();
    observer = new MutationObserver((mutations) => {
      const changedChatDOM = mutations.some((mutation) =>
        !mutation.target?.closest?.("[data-sg-lite-ui]") &&
        Array.from(mutation.addedNodes || []).some((node) =>
          !node.closest?.("[data-sg-lite-ui]")));
      if (changedChatDOM) scheduleScan();
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    window.addEventListener("popstate", () => scheduleScan(0));
    window.addEventListener("pageshow", () => scheduleScan(0));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) scheduleScan(0);
    });
    // Next.js history.pushState may change the path without popstate;
    // this is a path-only check, not a costly full-DOM polling loop.
    setInterval(() => {
      if (location.pathname !== lastPath) scheduleScan(0);
    }, 1800);
  }
  void initialize();
})();
