// Open sidepanel when clicking extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[BACKGROUND]", error));

// Optional: listen to install event
chrome.runtime.onInstalled.addListener(() => {
  console.log("Superagent AI Coding SidePanel installed successfully.");
});

// Notify sidepanel when page navigation is complete
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  chrome.runtime.sendMessage({
    type: "PAGE_NAVIGATION_COMPLETE",
    tabId: details.tabId,
    url: details.url
  }).catch(() => {}); // sidepanel might not be open, ignore
}, { url: [{ schemes: ["http", "https"] }] });

