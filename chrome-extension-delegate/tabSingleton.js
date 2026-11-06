/* Multi-tab ChatGPT policy: observe tabs but never close or navigate user tabs.
 * Keep the historical factory name for extension compatibility. */
(() => {
  "use strict";
  const isChatTab = tab => Number.isSafeInteger(tab?.id) &&
    /^https:\/\/chatgpt\.com(?:\/|$)/.test(tab?.url || "");

  globalThis.createDelegateTabSingleton = ({ chrome, enabled }) => {
    let timer = null;
    let running = null;
    let snapshot = {
      mode: "multi-tab",
      primaryTabId: null,
      activeTabId: null,
      tabIds: [],
      remainingTabs: 0,
      lastClosedTabIds: [],
      lastClosedAt: null,
      protectedTabs: [],
      lastCheckedAt: null,
    };

    function status() {
      return {
        ...snapshot,
        tabIds: [...snapshot.tabIds],
        lastClosedTabIds: [],
        protectedTabs: [],
      };
    }

    function schedule(delay = 300) {
      if (!enabled()) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void cleanup().catch(() => {});
      }, delay);
    }

    async function cleanup() {
      if (!enabled()) return status();
      if (running) return running;
      running = (async () => {
        const tabs = (await chrome.tabs.query({ url: "https://chatgpt.com/*" }))
          .filter(isChatTab)
          .sort((a, b) => Number(!!b.active) - Number(!!a.active) ||
            (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.id - b.id);
        const active = tabs.find(tab => tab.active) || tabs[0];
        snapshot = {
          mode: "multi-tab",
          primaryTabId: active?.id ?? null,
          activeTabId: active?.id ?? null,
          tabIds: tabs.slice(0, 100).map(tab => tab.id),
          remainingTabs: tabs.length,
          lastClosedTabIds: [],
          lastClosedAt: null,
          protectedTabs: [],
          lastCheckedAt: Date.now(),
        };
        return status();
      })();
      try {
        return await running;
      } finally {
        running = null;
      }
    }

    function register() {
      chrome.tabs.onCreated?.addListener(tab => {
        if (isChatTab(tab) || !tab?.url) schedule();
      });
      chrome.tabs.onUpdated?.addListener((_id, changes, tab) => {
        if (isChatTab(tab) || (changes.url && /^https:\/\/chatgpt\.com(?:\/|$)/.test(changes.url))) schedule();
      });
      chrome.tabs.onActivated?.addListener(() => schedule());
      chrome.tabs.onRemoved?.addListener(() => schedule());
    }
    return { status, schedule, cleanup, register };
  };
})();
