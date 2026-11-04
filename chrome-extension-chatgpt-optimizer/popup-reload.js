/* Retry a failed conversation in-place using ChatGPT's native control; never reload a tab. */
(() => {
  "use strict";
  const SCOPE = "chatgpt-optimizer-target-reload-v1";
  const el = (id) => document.getElementById(id);
  let openChatTabs = [];
  let reloadBusy = false;

  function isSavedChatUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.origin === "https://chatgpt.com" &&
        /^\/c\/[a-z0-9-]{8,80}\/?$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function message(text, error = false) {
    const node = el("reload-chat-status");
    node.textContent = text;
    node.style.color = error ? "var(--danger)" : "";
  }

  function updateButton() {
    el("reload-chat").disabled = reloadBusy ||
      !openChatTabs.some((tab) => String(tab.id) === el("reload-chat-select").value);
  }

  async function listOpenChats() {
    const select = el("reload-chat-select");
    const previouslySelected = select.value;
    try {
      const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
      openChatTabs = tabs.filter((tab) =>
        Number.isSafeInteger(tab.id) && isSavedChatUrl(tab.url)
      ).slice(0, 60);
      select.replaceChildren();

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = openChatTabs.length
        ? "Select a chat tab…" : "No open saved-chat tabs";
      select.appendChild(placeholder);

      for (const tab of openChatTabs) {
        const option = document.createElement("option");
        option.value = String(tab.id);
        const title = String(tab.title || "ChatGPT chat").slice(0, 75);
        const id = new URL(tab.url).pathname.split("/").pop();
        option.textContent = `${title} · ${id.slice(-8)} · window ${tab.windowId}`;
        select.appendChild(option);
      }
      let nextSelection = openChatTabs.some((tab) => String(tab.id) === previouslySelected)
        ? previouslySelected : "";
      if (!nextSelection) {
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const activeId = activeTabs[0]?.id;
        if (openChatTabs.some((tab) => tab.id === activeId)) nextSelection = String(activeId);
        else if (openChatTabs.length === 1) nextSelection = String(openChatTabs[0].id);
      }
      select.value = nextSelection;
      message(openChatTabs.length
        ? `${openChatTabs.length} open chat tab(s). Retry affects only the selected chat.`
        : "Open a saved ChatGPT conversation first.");
    } catch {
      openChatTabs = [];
      select.replaceChildren();
      message("Unable to list ChatGPT tabs.", true);
    }
    updateButton();
  }

  async function reloadSelectedChat() {
    if (reloadBusy) return;
    const tabId = Number(el("reload-chat-select").value);
    const selected = openChatTabs.find((tab) => tab.id === tabId);
    if (!selected) {
      message("Select a saved conversation first.", true);
      return;
    }
    reloadBusy = true;
    updateButton();
    try {
      // Two URL checks protect against accidentally reloading a tab that navigated.
      const initialTab = await chrome.tabs.get(tabId);
      if (!initialTab || initialTab.url !== selected.url || !isSavedChatUrl(initialTab.url)) {
        message("That chat tab changed. Update the tab list and try again.", true);
        return;
      }
      const expectedPath = new URL(selected.url).pathname;
      const inspected = await chrome.tabs.sendMessage(tabId, {
        scope: SCOPE, action: "inspect_retry", expectedPath,
      });
      if (!inspected?.ok || !inspected.safe) {
        message(inspected?.reason || "In-page chat retry is unavailable. The page was not reloaded.", true);
        return;
      }
      const verifiedTab = await chrome.tabs.get(tabId);
      if (!verifiedTab || verifiedTab.url !== selected.url) {
        message("The selected chat changed while checking. Reload blocked.", true);
        return;
      }
      const result = await chrome.tabs.sendMessage(tabId, {
        scope: SCOPE, action: "retry_conversation", expectedPath,
      });
      if (!result?.ok || !result.triggered) {
        message(result?.reason || "In-page retry could not be triggered. No page reload occurred.", true);
        return;
      }
      message("ChatGPT's Try again was triggered inside the selected chat. Page was not reloaded; recovery is not yet confirmed.");
    } catch {
      message("Could not reach the selected ChatGPT tab. No page reload was performed.", true);
    } finally {
      reloadBusy = false;
      updateButton();
    }
  }

  function initialize() {
    const select = el("reload-chat-select");
    if (!select) return;
    select.addEventListener("change", updateButton);
    el("refresh-chat-tabs").addEventListener("click", () => void listOpenChats());
    el("reload-chat").addEventListener("click", () => void reloadSelectedChat());
    void listOpenChats();
  }
  initialize();
})();
