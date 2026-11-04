/* User-triggered real-memory hibernation of idle BACKGROUND ChatGPT tabs.
 * It deliberately never acts automatically, and never on active tabs. */
(() => {
  "use strict";
  const SCOPE = "chatgpt-optimizer-memory-v1";
  const PROBE = "chatgpt-optimizer-tab-sleep-v1";
  let running = false;
  const isChat = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.origin === "https://chatgpt.com" &&
        /^\/c\/[a-z0-9-]{8,80}\/?$/i.test(parsed.pathname);
    } catch { return false; }
  };
  function eligible(tab) {
    return Number.isSafeInteger(tab?.id) && isChat(tab.url) &&
      tab.active !== true && tab.highlighted !== true &&
      tab.pinned !== true && tab.audible !== true &&
      tab.discarded !== true && tab.autoDiscardable !== false &&
      tab.status === "complete";
  }
  async function sleepOthers() {
    const results = { examined: 0, sleeping: 0, skipped: 0, failed: 0,
      reasons: {}, noMemoryMeasurement: true };
    const count = (reason) => {
      const safe = String(reason || "Unable to verify idle state.").slice(0, 110);
      results.reasons[safe] = (results.reasons[safe] || 0) + 1;
    };
    const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
    for (const tab of tabs) {
      // Leave all active tabs in all windows alone. No automatic fallback.
      if (!eligible(tab)) continue;
      results.examined++;
      let inspection;
      try {
        inspection = await chrome.tabs.sendMessage(tab.id, {
          scope: PROBE, action: "inspect_sleep",
        });
        if (inspection?.ok !== true) throw Error("Content script not ready");
      } catch {
        // A tab opened before this version of the extension may not have its
        // read-only guard yet. Inject only that guard without reloading the tab.
        try {
          const current = await chrome.tabs.get(tab.id);
          if (!eligible(current) || current.url !== tab.url) {
            results.skipped++;
            count("Tab changed before safety inspection.");
            continue;
          }
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["tab-sleep.js"],
          });
          inspection = await chrome.tabs.sendMessage(tab.id, {
            scope: PROBE, action: "inspect_sleep",
          });
        } catch {
          results.skipped++;
          count("Idle safety probe unavailable, tab was not touched.");
          continue;
        }
      }
      if (inspection?.ok !== true || inspection.safe !== true) {
        results.skipped++;
        count(inspection?.reason || "Not safe to sleep.");
        continue;
      }
      try {
        // Recheck after async probe. The user may have activated/navigated.
        const now = await chrome.tabs.get(tab.id);
        if (!eligible(now) || now.url !== tab.url) {
          results.skipped++;
          count("Tab changed or became active.");
          continue;
        }
        const outcome = await chrome.tabs.discard(tab.id);
        if (outcome?.id === tab.id && outcome.discarded === true) {
          results.sleeping++;
        } else {
          results.failed++;
          count("Chrome declined to discard tab.");
        }
      } catch {
        results.failed++;
        count("Chrome could not discard tab.");
      }
    }
    return results;
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.scope !== SCOPE || sender?.id !== chrome.runtime.id) return false;
    if (message.action === "status") {
      chrome.tabs.query({ url: ["https://chatgpt.com/*"] })
        .then((tabs) => respond({
          ok: true, backgroundCount: tabs.filter(eligible).length,
          sleepingCount: tabs.filter((tab) => tab.discarded).length,
        }))
        .catch(() => respond({ ok: false, reason: "Cannot inspect tabs." }));
      return true;
    }
    if (message.action !== "sleep_others") {
      respond({ ok: false, reason: "Unknown action." });
      return false;
    }
    if (running) {
      respond({ ok: false, reason: "Memory saver is already running." });
      return false;
    }
    running = true;
    void sleepOthers()
      .then((result) => respond({ ok: true, ...result }))
      .catch(() => respond({ ok: false, reason: "Unable to enumerate tabs." }))
      .finally(() => { running = false; });
    return true;
  });
})();
