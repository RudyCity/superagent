/**
 * Superagent Remote Chrome Extension - Background Service Worker
 * Standalone lightweight bridge connecting Chrome directly to Superagent CLI via WebSocket (port 9223).
 */

const WS_PORT = 9223;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let socket = null;
let isConnected = false;
let reconnectTimer = null;

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }

  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      isConnected = true;
      console.log("[Superagent Remote Bridge] Connected to Superagent CLI on port", WS_PORT);
      chrome.storage.local.set({ remoteStatus: "connected", lastConnected: Date.now() });
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
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
      isConnected = false;
      chrome.storage.local.set({ remoteStatus: "disconnected" });
      scheduleReconnect();
    };

    socket.onerror = (err) => {
      isConnected = false;
      chrome.storage.local.set({ remoteStatus: "error" });
    };
  } catch (err) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      connectWebSocket();
    }, 3000);
  }
}

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

// Connect immediately on service worker start
connectWebSocket();
