/* Single ChatGPT tab per Chrome profile. Never close an unverified or busy tab. */
(() => {
  "use strict";
  const SCOPE = "superagent-delegate-v1";
  const isChatTab = (tab) => Number.isSafeInteger(tab?.id) &&
    /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab?.url || "");

  globalThis.createDelegateTabSingleton = ({ chrome, enabled, busy, ensureContent }) => {
    let timer = null;
    let running = null;
    let repeat = false;
    let snapshot = {
      mode: "single-safe-tab",
      primaryTabId: null,
      remainingTabs: 0,
      lastClosedTabIds: [],
      protectedTabs: [],
      lastCheckedAt: null,
    };

    function status() {
      return { ...snapshot, lastClosedTabIds: [...snapshot.lastClosedTabIds],
        protectedTabs: snapshot.protectedTabs.map(entry => ({ ...entry })) };
    }
    function schedule(delay = 700) {
      if (!enabled()) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void cleanup().catch(() => {}); }, delay);
    }
    async function inspect(tab) {
      if (!isChatTab(tab)) return { safe: false, reason: "not_chatgpt" };
      if (tab.pinned) return { safe: false, reason: "pinned" };
      if (tab.audible) return { safe: false, reason: "audio_active" };
      if (tab.discarded || tab.status !== "complete") return { safe: false, reason: "not_loaded" };
      try {
        await ensureContent(tab.id);
        const inspection = await chrome.tabs.sendMessage(tab.id, {
          scope: SCOPE, action: "inspect_tab",
        });
        if (!inspection || inspection.ready !== true || inspection.safeToClose !== true) {
          return { safe: false, reason: String(inspection?.reason || "unverified").slice(0, 80) };
        }
        return { safe: true, reason: inspection.reason || "verified_idle" };
      } catch {
        return { safe: false, reason: "content_unavailable" };
      }
    }
    function priority(tab, check) {
      const reason = check?.reason || "";
      return (reason === "generating" ? 160 :
        reason === "draft_present" ? 150 :
        reason === "delegate_busy" ? 140 : 0) +
        (tab.pinned ? 80 : 0) + (tab.active ? 40 : 0) +
        (tab.url && /\/c\/[^/]+/.test(tab.url) ? 10 : 0);
    }
    async function perform() {
      if (!enabled()) return status();
      if (busy()) { schedule(1200); return status(); }
      const all = (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))
        .filter(isChatTab);
      const groups = new Map();
      for (const tab of all) {
        const key = tab.incognito ? "incognito" : "normal";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(tab);
      }
      const closed = [];
      const protectedTabs = [];
      let primaryTabId = null;
      for (const group of groups.values()) {
        if (!group.length) continue;
        if (group.length === 1) {
          primaryTabId ??= group[0].id;
          continue;
        }
        const checks = await Promise.all(group.map(tab => inspect(tab)));
        // A tab that is loading or cannot be verified may hold unsaved work.
        // Never close OTHER tabs while that unresolved state could cause an
        // incorrect primary-tab choice. Later onUpdated will retry.
        const unverified = new Set([
          "not_loaded", "page_not_ready", "chat_not_loaded",
          "content_unavailable", "unverified",
        ]);
        if (checks.some(check => unverified.has(check.reason))) {
          for (let i = 0; i < group.length; i++) {
            if (unverified.has(checks[i].reason)) {
              protectedTabs.push({ tabId: group[i].id, reason: checks[i].reason });
            }
          }
          continue;
        }
        // If the user switched tabs during inspection, defer rather than
        // close any page based on stale active-tab ordering.
        const currentTabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        const changed = group.some(tab => {
          const current = currentTabs.find(entry => entry.id === tab.id);
          return !current || !isChatTab(current) ||
            current.url !== tab.url || !!current.active !== !!tab.active;
        });
        if (changed) {
          for (const tab of group) protectedTabs.push({
            tabId: tab.id, reason: "tab_activation_changed",
          });
          schedule(1200);
          continue;
        }
        const ranked = group.map((tab, i) => ({ tab, check: checks[i] }))
          .sort((a, b) => priority(b.tab, b.check) - priority(a.tab, a.check) ||
            (b.tab.lastAccessed || 0) - (a.tab.lastAccessed || 0) ||
            a.tab.id - b.tab.id);
        const keeper = ranked[0].tab;
        primaryTabId ??= keeper.id;
        for (const entry of ranked.slice(1)) {
          const { tab, check } = entry;
          if (!check.safe) {
            protectedTabs.push({ tabId: tab.id, reason: check.reason });
            continue;
          }
          if (!enabled() || busy()) { schedule(1200); break; }
          try {
            // Re-check tab identity and DOM immediately before removal.
            // A tab that was activated or navigated during inspection wins.
            const [current, stillKeeper] = await Promise.all([
              chrome.tabs.get(tab.id), chrome.tabs.get(keeper.id),
            ]);
            if (!isChatTab(current) || !stillKeeper || !isChatTab(stillKeeper) ||
                current.url !== tab.url || current.active && !tab.active ||
                current.pinned || current.audible || current.discarded) {
              protectedTabs.push({ tabId: tab.id, reason: "tab_changed" });
              continue;
            }
            const finalCheck = await inspect(current);
            if (!finalCheck.safe || busy() || !enabled()) {
              protectedTabs.push({ tabId: tab.id, reason: finalCheck.reason || "became_busy" });
              continue;
            }
            // Only close our own verified duplicate ChatGPT tab in this profile.
            await chrome.tabs.remove(tab.id);
            closed.push(tab.id);
          } catch {
            protectedTabs.push({ tabId: tab.id, reason: "close_failed" });
          }
        }
      }
      snapshot = {
        mode: "single-safe-tab", primaryTabId,
        remainingTabs: all.length - closed.length,
        lastClosedTabIds: closed,
        protectedTabs,
        lastCheckedAt: Date.now(),
      };
      return status();
    }
    async function cleanup() {
      if (running) { repeat = true; return running; }
      running = perform();
      try { return await running; }
      finally {
        running = null;
        if (repeat) { repeat = false; schedule(400); }
      }
    }
    function register() {
      chrome.tabs.onCreated?.addListener(tab => {
        if (isChatTab(tab) || !tab.url) schedule(1200);
      });
      chrome.tabs.onUpdated?.addListener((_id, changes, tab) => {
        if (isChatTab(tab) && (changes.status === "complete" || changes.url)) schedule();
      });
      chrome.tabs.onActivated?.addListener(() => schedule());
      chrome.tabs.onRemoved?.addListener(() => schedule());
    }
    return { status, schedule, cleanup, register };
  };
})();
