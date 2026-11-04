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
  let previousRenderTargets = new Map();
  const renderTargets = new WeakMap();
  let hud = null;
  let pending = null;
  let dirty = true;
  let lastFocus = null;
  let scanCount = 0;
  let lastStatus = {
    total: 0, hidden: 0, optimized: 0, verified: false,
    renderState: "waiting", renderedTargetCount: 0, scanCount: 0,
  };
  let observer = null;

  function clearAttributes(element) {
    if (element.getAttribute("data-sg-lite-hidden") !== null) {
      element.removeAttribute("data-sg-lite-hidden");
    }
    if (element.getAttribute("data-sg-lite-render") !== null) {
      element.removeAttribute("data-sg-lite-render");
    }
  }

  // Use CSS containment only on layout boxes. A wrapper with
  // display:contents has no layout box and content-visibility cannot work.
  // Cache targets per turn, so streaming does not recompute styles.
  function renderTargetFor(turn) {
    if (renderTargets.has(turn)) {
      const cached = renderTargets.get(turn);
      if (!cached || cached === turn || turn.contains?.(cached)) return cached;
      renderTargets.delete(turn);
    }
    let target = turn;
    for (let depth = 0; depth < 4; depth++) {
      const style = typeof getComputedStyle === "function" ? getComputedStyle(target) : null;
      if (style?.display !== "contents") break;
      const children = Array.from(target.children || []);
      // If multiple children exist, containment of only one would be misleading.
      if (children.length !== 1) { target = null; break; }
      target = children[0];
    }
    if (target && typeof getComputedStyle === "function" &&
        getComputedStyle(target).display === "contents") target = null;
    renderTargets.set(turn, target);
    return target;
  }

  function diagnoseRender(targets, total, count) {
    if (!settings.enabled) return { verified: false, renderState: "disabled" };
    if (total === 0) return { verified: false, renderState: "no-messages" };
    if (count === 0) return {
      verified: false, renderState: total <= 4 ? "short-chat" : "no-targets",
    };
    if (typeof getComputedStyle !== "function") return {
      verified: false, renderState: "unverified",
    };
    // Check only representative nodes, not the full chat. Counting every
    // computed style on popup polling would defeat the optimization.
    const samples = [targets[0], targets[Math.floor(targets.length / 2)], targets[targets.length - 1]]
      .filter(Boolean);
    let verifiedSamples = 0;
    let skippedSamples = 0;
    let skipCheckCount = 0;
    for (const node of samples) {
      const style = getComputedStyle(node);
      if (style?.contentVisibility !== "auto" ||
          style?.display === "contents" || style?.display === "none") continue;
      verifiedSamples++;
      // The outer box remains present; check one real child for browser
      // offscreen rendering skips. This is a sample, not an FPS benchmark.
      const child = node.firstElementChild;
      if (child && typeof child.checkVisibility === "function") {
        skipCheckCount++;
        if (!child.checkVisibility({ contentVisibilityAuto: true })) skippedSamples++;
      }
    }
    const verified = verifiedSamples === samples.length;
    return {
      verified, verifiedSamples, sampledCount: samples.length,
      skippedSamples, skipCheckCount,
      renderState: verified ? "verified" :
        verifiedSamples ? "css-partial" : "css-inactive",
    };
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

  function isProtectedTurn(node, focused, selection) {
    if (focused && node.contains?.(focused)) return true;
    if (!selection || selection.isCollapsed) return false;
    return !!(selection.anchorNode && node.contains?.(selection.anchorNode)) ||
      !!(selection.focusNode && node.contains?.(selection.focusNode));
  }

  function resetRoute() {
    for (const node of previousTurns) clearAttributes(node);
    for (const target of previousRenderTargets.values()) target?.removeAttribute("data-sg-lite-render");
    previousTurns.clear();
    previousRenderTargets.clear();
    lastPath = location.pathname;
    revealExtra = 0;
    showAll = false;
    dirty = true;
    lastStatus = {
      total: 0, hidden: 0, optimized: 0, verified: false,
      renderState: "waiting", renderedTargetCount: 0, scanCount,
    };
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
    for (const [oldTurn, oldTarget] of previousRenderTargets) {
      if (!current.has(oldTurn) || !settings.enabled) {
        oldTarget?.removeAttribute("data-sg-lite-render");
      }
    }

    const focused = document.activeElement;
    const selection = window.getSelection?.();
    const currentTargets = new Map();
    const verifiedCandidates = [];
    let hidden = 0;
    let optimized = 0;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const protectedTurn = isProtectedTurn(turn, focused, selection);
      const hide = i < plan.hiddenCount && !protectedTurn;
      const candidate = i < plan.optimizeBefore && !hide && !protectedTurn;
      const target = candidate ? renderTargetFor(turn) : null;
      const previousTarget = previousRenderTargets.get(turn);
      if (previousTarget && previousTarget !== target) {
        previousTarget.removeAttribute("data-sg-lite-render");
      }
      // Never modify children, innerHTML, editor values, React-owned listeners,
      // or ChatGPT state. Only touch attributes when a value truly changes.
      if (hide) {
        if (turn.getAttribute("data-sg-lite-hidden") !== "1") {
          turn.setAttribute("data-sg-lite-hidden", "1");
        }
      } else if (turn.getAttribute("data-sg-lite-hidden") !== null) {
        turn.removeAttribute("data-sg-lite-hidden");
      }
      // Clear stale attributes left by older extension versions.
      if (target !== turn && turn.getAttribute("data-sg-lite-render") !== null) {
        turn.removeAttribute("data-sg-lite-render");
      }
      if (target) {
        if (target.getAttribute("data-sg-lite-render") !== "1") {
          target.setAttribute("data-sg-lite-render", "1");
        }
        currentTargets.set(turn, target);
        verifiedCandidates.push(target);
        optimized++;
      }
      if (hide) hidden++;
    }

    previousTurns = current;
    previousRenderTargets = currentTargets;
    scanCount++;
    lastFocus = focused;
    dirty = false;
    const diagnosis = settings.mode === "compact"
      ? { verified: false, renderState: "compact" }
      : diagnoseRender(verifiedCandidates, turns.length, optimized);
    lastStatus = {
      total: turns.length, hidden, optimized,
      renderedTargetCount: currentTargets.size,
      scanCount, ...diagnosis,
    };
    updateHud(hidden);
  }

  function scheduleScan(delay = 700) {
    dirty = true;
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
      // Popup polls every 3 seconds. Do not rescan thousands of turns when
      // no structural DOM or mode changes occurred.
      if (dirty || location.pathname !== lastPath ||
          (settings.mode === "compact" && document.activeElement !== lastFocus)) scan();
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
      // Ignore token-streaming changes inside existing turns and changes to
      // navigation/extension UI. Rescan only when turns are added or removed.
      const selector = '[data-testid^="conversation-turn-"],[data-message-author-role]';
      const structural = mutations.some((mutation) => {
        if (mutation.target?.closest?.('[data-sg-lite-ui],[data-sg-opt-sidebar]')) return false;
        if (mutation.type === "attributes") {
          return !!mutation.target?.matches?.(selector);
        }
        return [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])].some((node) =>
          node.matches?.(selector) || node.querySelector?.(selector));
      });
      if (structural) scheduleScan();
    });
    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["data-testid", "data-message-author-role"],
    });
    window.addEventListener("popstate", () => scheduleScan(0));
    window.addEventListener("pageshow", () => scheduleScan(0));
    document.addEventListener("focusin", () => {
      if (settings.mode === "compact") scheduleScan(0);
    });
    document.addEventListener("selectionchange", () => {
      if (settings.mode === "compact") scheduleScan(250);
    });
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
