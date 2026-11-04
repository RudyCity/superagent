/* MV3 background wake-up: schedule read-only sidebar sync even for inactive tabs.
 * No chat titles, session tokens, or account data pass through this worker. */
(() => {
  "use strict";
  const KEY = "superagentChatGPTLiteSettings";
  const ALARM = "chatgpt-optimizer-sidebar-sync-v2";
  const SCOPE = "chatgpt-optimizer-sidebar-v1";
  const MINUTES = new Set([0.5, 1, 2, 5]);
  let revision = 0;

  async function schedule() {
    const currentRevision = ++revision;
    let values;
    try {
      values = await chrome.storage.local.get(KEY);
    } catch {
      return;
    }
    if (currentRevision !== revision) return;
    const settings = values?.[KEY] || {};
    const active = settings.enabled !== false && settings.sidebarSync !== false;
    const seconds = [30, 60, 120, 300].includes(settings.sidebarInterval)
      ? settings.sidebarInterval : 60;
    const minutes = MINUTES.has(seconds / 60) ? seconds / 60 : 1;
    await chrome.alarms.clear(ALARM);
    if (currentRevision !== revision || !active) return;
    await chrome.alarms.create(ALARM, {
      delayInMinutes: minutes,
      periodInMinutes: minutes,
    });
  }

  async function refreshOpenWindows() {
    let tabs;
    try {
      tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
    } catch {
      return;
    }
    const perWindow = new Map();
    for (const tab of tabs) {
      if (!Number.isSafeInteger(tab.id) || !Number.isSafeInteger(tab.windowId) || tab.discarded) continue;
      const current = perWindow.get(tab.windowId);
      // One tab per Chrome window, prefer its active tab if ChatGPT is active.
      if (!current || (tab.active && !current.active)) perWindow.set(tab.windowId, tab);
    }
    await Promise.allSettled([...perWindow.values()].map(async (tab) => {
      try {
        await chrome.tabs.sendMessage(tab.id, { scope: SCOPE, action: "background_refresh" });
      } catch {
        // A page still loading / lacking content scripts must not break
        // other windows. The next alarm/focus will try again.
      }
    }));
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void refreshOpenWindows();
  });
  chrome.runtime.onInstalled.addListener(() => { void schedule(); });
  chrome.runtime.onStartup.addListener(() => { void schedule(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) void schedule();
  });
  // Service workers may be restarted after idling. Ensure the alarm exists.
  void schedule();
})();

// Load separately to keep history scheduling and memory-saving isolated.
importScripts("memory-worker.js");
