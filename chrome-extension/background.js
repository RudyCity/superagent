// Open sidepanel when clicking extension icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("[BACKGROUND]", error));

// Optional: listen to install event
chrome.runtime.onInstalled.addListener(() => {
  console.log("Superagent AI Coding SidePanel installed successfully.");
});
