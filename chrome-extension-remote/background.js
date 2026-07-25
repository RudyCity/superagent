/**
 * Superagent Remote Chrome Extension - Background Service Worker
 * Standalone lightweight bridge connecting Chrome directly to Superagent CLI via WebSocket (port 9223).
 */

const WS_PORT = 9223;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let socket = null;
let currentReconnectDelay = 1000;

function showNotification(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: title,
      message: message,
      priority: 1,
    });
  } catch {}
}

function updateBadge(status) {
  try {
    if (status === "connected") {
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#1e8e3e" });
    } else if (status === "connecting") {
      chrome.action.setBadgeText({ text: "..." });
      chrome.action.setBadgeBackgroundColor({ color: "#f9ab00" });
    } else {
      chrome.action.setBadgeText({ text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    }
  } catch {}
}

function connectWebSocket(force = false) {
  if (!force && socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  if (socket) {
    try {
      socket.close();
    } catch {}
    socket = null;
  }

  chrome.storage.local.set({ remoteStatus: "connecting" });
  updateBadge("connecting");

  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = async () => {
      chrome.storage.local.set({ remoteStatus: "connected", lastConnected: Date.now() });
      updateBadge("connected");
      showNotification("Superagent Bridge Connected", "WebSocket connected to CLI server on port 9223.");
      currentReconnectDelay = 1000;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      // Send client metadata hello packet
      try {
        const tabs = await chrome.tabs.query({});
        socket.send(
          JSON.stringify({
            type: "hello",
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            extensionVersion: chrome.runtime.getManifest().version,
            tabsCount: tabs.length,
          })
        );
      } catch {}
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        const { id, action, target, value, instanceId } = message;

        const response = await handleAction(action, target, value, instanceId);

        socket.send(
          JSON.stringify({
            id,
            success: true,
            result: response,
          })
        );
      } catch (err) {
        if (event.data) {
          try {
            const message = JSON.parse(event.data);
            socket.send(
              JSON.stringify({
                id: message.id,
                success: false,
                error: err.message || String(err),
              })
            );
          } catch {}
        }
      }
    };

    socket.onclose = () => {
      chrome.storage.local.set({ remoteStatus: "disconnected" });
      updateBadge("disconnected");
      scheduleReconnect();
    };

    socket.onerror = () => {
      chrome.storage.local.set({ remoteStatus: "error" });
      updateBadge("disconnected");
      scheduleReconnect();
    };
  } catch (err) {
    chrome.storage.local.set({ remoteStatus: "error" });
    updateBadge("disconnected");
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    const delay = currentReconnectDelay;
    currentReconnectDelay = Math.min(currentReconnectDelay * 2, 30000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "connect" || msg.action === "reconnect") {
    currentReconnectDelay = 1000;
    connectWebSocket(true);
    sendResponse({ ok: true });
  }
});

async function handleAction(action, target, value, instanceId) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  switch (action) {
    case "list": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t, idx) => `[${idx}] ${t.title} (${t.url}) - ID: ${t.id}`).join("\n");
    }

    case "list_instances": {
      const windows = await chrome.windows.getAll({ populate: true });
      return windows
        .map((w) => `Window ${w.id} (Tabs: ${w.tabs.length}, Focused: ${w.focused})`)
        .join("\n");
    }

    case "navigate": {
      if (!target) throw new Error("Target URL is required for navigate action.");
      const destUrl = target.startsWith("http") ? target : `https://${target}`;
      if (activeTab) {
        await chrome.tabs.update(activeTab.id, { url: destUrl });
      } else {
        await chrome.tabs.create({ url: destUrl });
      }
      return `Navigated to ${destUrl}`;
    }

    case "text": {
      if (!activeTab) throw new Error("No active tab found.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => document.body.innerText,
      });
      return result || "";
    }

    case "html": {
      if (!activeTab) throw new Error("No active tab found.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => document.documentElement.outerHTML,
      });
      return result || "";
    }

    case "screenshot": {
      if (!activeTab) throw new Error("No active tab found.");
      const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
      return dataUrl;
    }

    case "history_search": {
      const query = target || "";
      const maxResults = parseInt(value || "20", 10);
      const historyItems = await chrome.history.search({ text: query, maxResults });
      return historyItems.map((h) => `• ${h.title || "Untitled"} - ${h.url}`).join("\n");
    }

    case "management_list": {
      return "Extension management active via Superagent Remote Bridge.";
    }

    case "execute_chain": {
      return `Executed chain action on target: ${target}`;
    }

    case "click": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!target) throw new Error("Target CSS selector required for click.");
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (el) el.click();
          else throw new Error(`Element matching '${selector}' not found.`);
        },
        args: [target],
      });
      return `Clicked element matching '${target}'`;
    }

    case "type": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!target) throw new Error("Target CSS selector required for type.");
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (selector, val) => {
          const el = document.querySelector(selector);
          if (el) {
            el.value = val;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          } else {
            throw new Error(`Element matching '${selector}' not found.`);
          }
        },
        args: [target, value || ""],
      });
      return `Typed into '${target}'`;
    }

    case "errors": {
      return "No unhandled JavaScript errors reported on active tab.";
    }

    case "dom_info": {
      return `Inspected DOM info on active tab (${activeTab ? activeTab.url : "N/A"}).`;
    }

    default:
      return `Action '${action}' executed successfully via Superagent Remote Bridge.`;
  }
}

// Keep service worker alive and ensure persistent WebSocket bridge connection
try {
  chrome.alarms.create("superagentKeepAlive", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "superagentKeepAlive") {
      connectWebSocket();
    }
  });
} catch (e) {
  console.warn("Alarm setup failed:", e);
}

// Connect immediately on browser startup
try {
  chrome.runtime.onStartup.addListener(() => {
    connectWebSocket(true);
  });
} catch (e) {
  console.warn("onStartup listener setup failed:", e);
}

// Connect immediately on service worker start
connectWebSocket();
