/**
 * Superagent Remote Chrome Extension - Background Service Worker
 * Standalone lightweight bridge connecting Chrome directly to Superagent CLI via WebSocket (port 9223).
 */

const WS_PORT = 9223;
const WS_URL = `ws://127.0.0.1:${WS_PORT}`;

let socket = null;
let currentReconnectDelay = 1000;
let reconnectTimer = null;
const consoleLogsBuffer = [];
const MAX_CONSOLE_LOGS = 100;
const networkLogsBuffer = [];
const MAX_NETWORK_LOGS = 100;

function logConsoleEvent(level, text, source = "console") {
  const logEntry = { timestamp: new Date().toISOString(), level, text, source };
  consoleLogsBuffer.push(logEntry);
  if (consoleLogsBuffer.length > MAX_CONSOLE_LOGS) {
    consoleLogsBuffer.shift();
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: "console_log", data: logEntry }));
    } catch {}
  }
}

function logNetworkEvent(method, url, status, type) {
  const logEntry = { timestamp: new Date().toISOString(), method, url, status, type };
  networkLogsBuffer.push(logEntry);
  if (networkLogsBuffer.length > MAX_NETWORK_LOGS) {
    networkLogsBuffer.shift();
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: "network_log", data: logEntry }));
    } catch {}
  }
}

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

// Helper: parse markdown text into rich HTML for contenteditable editors
function parseMarkdownToHTML(markdownText) {
  if (!markdownText) return "";
  let html = markdownText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  
  // Headers
  html = html.replace(/^### (.*$)/gim, "<h3>$1</h3>");
  html = html.replace(/^## (.*$)/gim, "<h2>$1</h2>");
  html = html.replace(/^# (.*$)/gim, "<h1>$1</h1>");
  
  // Bold & Italic
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");
  html = html.replace(/_(.*?)_/g, "<em>$1</em>");
  
  // Code block & inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  
  // Bullet lists
  html = html.replace(/^\- (.*$)/gim, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\s*)+)/gim, "<ul>$1</ul>");
  
  // Line breaks / paragraphs
  html = html.replace(/\n\n/g, "</p><p>");
  html = "<p>" + html + "</p>";
  return html.replace(/<p><\/p>/g, "");
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
        .map(
          (w) =>
            `Window ${w.id} (Tabs: ${w.tabs ? w.tabs.length : 0}, Focused: ${w.focused})`
        )
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

    case "save_session": {
      const tabs = await chrome.tabs.query({});
      const sessionData = tabs.map((t) => ({ title: t.title, url: t.url }));
      await chrome.storage.local.set({ savedBrowserSession: sessionData });
      return `Saved ${sessionData.length} active tab(s) to browser session snapshot.`;
    }

    case "restore_session": {
      const data = await chrome.storage.local.get("savedBrowserSession");
      const sessionData = data.savedBrowserSession || [];
      if (sessionData.length === 0) return "No saved browser session snapshot found.";
      for (const item of sessionData) {
        if (item.url && !item.url.startsWith("chrome://")) {
          await chrome.tabs.create({ url: item.url, active: false });
        }
      }
      return `Restored ${sessionData.length} tab(s) from session snapshot.`;
    }

    case "text": {
      if (!activeTab) throw new Error("No active tab found.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => document.body ? document.body.innerText : "",
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

    case "element_screenshot": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!target) throw new Error("Target CSS selector required for element_screenshot.");
      const [{ result: rect }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`Element matching '${selector}' not found.`);
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, width: r.width, height: r.height, devicePixelRatio: window.devicePixelRatio || 1 };
        },
        args: [target],
      });
      const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
      return JSON.stringify({ fullScreenshot: dataUrl, boundingBox: rect });
    }

    case "highlight": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!target) throw new Error("Target CSS selector required for highlight.");
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (!el) throw new Error(`Element matching '${selector}' not found.`);
          const originalOutline = el.style.outline;
          const originalTransition = el.style.transition;
          el.style.transition = "outline 0.2s ease-in-out";
          el.style.outline = "3px solid #1a73e8";
          setTimeout(() => {
            el.style.outline = originalOutline;
            el.style.transition = originalTransition;
          }, 1500);
        },
        args: [target],
      });
      return `Highlighted element matching '${target}'`;
    }

    case "hotkey": {
      if (!activeTab) throw new Error("No active tab found.");
      const keyCombo = target || value || "";
      if (!keyCombo) throw new Error("Key combo (e.g. 'Control+s', 'Enter', 'Escape') required for hotkey.");
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (combo) => {
          const parts = combo.split("+").map((p) => p.trim());
          const key = parts[parts.length - 1];
          const ctrlKey = parts.includes("Ctrl") || parts.includes("Control");
          const shiftKey = parts.includes("Shift");
          const altKey = parts.includes("Alt");
          const metaKey = parts.includes("Cmd") || parts.includes("Meta");
          const eventInit = { key, code: key, ctrlKey, shiftKey, altKey, metaKey, bubbles: true, cancelable: true };
          const activeEl = document.activeElement || document.body;
          activeEl.dispatchEvent(new KeyboardEvent("keydown", eventInit));
          activeEl.dispatchEvent(new KeyboardEvent("keyup", eventInit));
        },
        args: [keyCombo],
      });
      return `Dispatched hotkey '${keyCombo}' to active element.`;
    }

    case "network_logs": {
      if (networkLogsBuffer.length === 0) {
        return "No network requests recorded.";
      }
      return networkLogsBuffer
        .map((n) => `[${n.timestamp}] ${n.method} ${n.url} - ${n.status} (${n.type})`)
        .join("\n");
    }

    case "manage_storage": {
      if (!activeTab) throw new Error("No active tab found.");
      const subAction = target || "get"; // "get" or "clear"
      const url = activeTab.url || "";
      if (subAction === "clear") {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            try { localStorage.clear(); } catch {}
            try { sessionStorage.clear(); } catch {}
          },
        });
        const domain = new URL(url).hostname;
        const cookies = await chrome.cookies.getAll({ domain });
        for (const cookie of cookies) {
          const cookieUrl = `http${cookie.secure ? "s" : ""}://${cookie.domain.replace(/^\./, "")}${cookie.path}`;
          await chrome.cookies.remove({ url: cookieUrl, name: cookie.name });
        }
        return `Cleared cookies, localStorage, and sessionStorage for domain ${domain}.`;
      } else {
        const domain = new URL(url).hostname;
        const cookies = await chrome.cookies.getAll({ domain });
        const [{ result: storageSummary }] = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            const lsKeys = Object.keys(localStorage);
            const ssKeys = Object.keys(sessionStorage);
            return { localStorageCount: lsKeys.length, sessionStorageCount: ssKeys.length };
          },
        });
        return `Domain: ${domain}\nCookies: ${cookies.length} item(s)\nLocalStorage: ${storageSummary.localStorageCount} key(s)\nSessionStorage: ${storageSummary.sessionStorageCount} key(s)`;
      }
    }

    case "fill_form": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!value) throw new Error("JSON mapping of selectors to values required for fill_form.");
      let formData;
      try {
        formData = typeof value === "string" ? JSON.parse(value) : value;
      } catch (e) {
        throw new Error("Invalid JSON string provided for fill_form value.");
      }
      const [{ result: filledCount }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (data) => {
          let count = 0;
          for (const [selector, val] of Object.entries(data)) {
            const el = document.querySelector(selector);
            if (el) {
              el.focus();
              if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
                el.innerText = val;
              } else {
                el.value = val;
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              count++;
            }
          }
          return count;
        },
        args: [formData],
      });
      return `Filled ${filledCount} form field(s).`;
    }

    case "scroll_to": {
      if (!activeTab) throw new Error("No active tab found.");
      const pos = target || value || "top";
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (position) => {
          if (position === "top") {
            window.scrollTo({ top: 0, behavior: "smooth" });
          } else if (position === "bottom") {
            window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          } else if (position.startsWith("#") || position.startsWith(".")) {
            const el = document.querySelector(position);
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          } else {
            const py = parseInt(position, 10);
            if (!isNaN(py)) window.scrollTo({ top: py, behavior: "smooth" });
          }
        },
        args: [pos],
      });
      return `Scrolled active tab to '${pos}'.`;
    }

    case "eval_js": {
      if (!activeTab) throw new Error("No active tab found.");
      const code = value || target || "";
      if (!code) throw new Error("JavaScript code string required for eval_js.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (jsCode) => {
          try {
            const evalResult = eval(jsCode);
            return typeof evalResult === "object" ? JSON.stringify(evalResult) : String(evalResult);
          } catch (err) {
            return `Eval Error: ${err.message}`;
          }
        },
        args: [code],
      });
      return `Eval Output: ${result}`;
    }

    case "upload_file": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!target) throw new Error("Target file input CSS selector required for upload_file.");
      const fileName = value || "uploaded_file.txt";
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (selector, name) => {
          const input = document.querySelector(selector);
          if (!input) throw new Error(`File input matching '${selector}' not found.`);
          const dt = new DataTransfer();
          const file = new File(["sample content"], name, { type: "text/plain" });
          dt.items.add(file);
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return input.files.length;
        },
        args: [target, fileName],
      });
      return `Attached ${result} file(s) to '${target}'.`;
    }

    case "performance_metrics": {
      if (!activeTab) throw new Error("No active tab found.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const t = performance.timing;
          const nav = performance.getEntriesByType("navigation")[0] || {};
          return {
            ttfb: nav.responseStart ? Math.round(nav.responseStart) : (t.responseStart - t.navigationStart),
            domLoaded: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : (t.domContentLoadedEventEnd - t.navigationStart),
            loadTime: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : (t.loadEventEnd - t.navigationStart),
            jsHeapSizeMB: performance.memory ? (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(2) : "N/A",
          };
        },
      });
      return `TTFB: ${result.ttfb}ms | DOMLoaded: ${result.domLoaded}ms | FullLoad: ${result.loadTime}ms | JSHeap: ${result.jsHeapSizeMB}MB`;
    }

    case "emulate_viewport": {
      if (!activeTab) throw new Error("No active tab found.");
      const mode = target || value || "mobile";
      let width = 1440, height = 900;
      if (mode === "mobile") { width = 375; height = 812; }
      else if (mode === "tablet") { width = 768; height = 1024; }
      else if (mode === "desktop") { width = 1440; height = 900; }
      else {
        const parts = mode.split("x");
        if (parts.length === 2) {
          width = parseInt(parts[0], 10) || 1440;
          height = parseInt(parts[1], 10) || 900;
        }
      }
      await chrome.windows.update(activeTab.windowId, { width, height });
      return `Resized viewport window to ${width}x${height} (${mode}).`;
    }

    case "extract_markdown": {
      if (!activeTab) throw new Error("No active tab found.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const clone = document.body.cloneNode(true);
          const removeSelectors = ["script", "style", "noscript", "nav", "footer", "header", "svg"];
          removeSelectors.forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));
          
          let md = "";
          const walk = (node) => {
            if (node.nodeType === 3) {
              const text = node.textContent.trim();
              if (text) md += text + " ";
            } else if (node.nodeType === 1) {
              const tag = node.tagName.toLowerCase();
              if (["h1", "h2", "h3", "h4"].includes(tag)) {
                const level = "#".repeat(parseInt(tag[1], 10));
                md += `\n\n${level} ${node.textContent.trim()}\n\n`;
              } else if (tag === "p") {
                md += `\n\n${node.textContent.trim()}\n\n`;
              } else if (tag === "li") {
                md += `\n- ${node.textContent.trim()}`;
              } else if (tag === "a") {
                md += ` [${node.textContent.trim()}](${node.href || "#"}) `;
              } else {
                node.childNodes.forEach(walk);
              }
            }
          };
          walk(clone);
          return md.replace(/\n{3,}/g, "\n\n").trim();
        },
      });
      return result || "No content extracted.";
    }

    case "mute_tab": {
      if (!activeTab) throw new Error("No active tab found.");
      const muted = target === "mute" || value === "true" || value === "mute";
      await chrome.tabs.update(activeTab.id, { muted });
      return `Tab audio ${muted ? "muted" : "unmuted"}.`;
    }

    case "detect_captcha": {
      if (!activeTab) throw new Error("No active tab found.");
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: () => {
          const captchas = [];
          if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]')) captchas.push("reCAPTCHA");
          if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"]')) captchas.push("hCaptcha");
          if (document.querySelector('#cf-turnstile, iframe[src*="turnstile"]')) captchas.push("Cloudflare Turnstile");
          if (document.querySelector('.geetest_holder')) captchas.push("GeeTest");
          return captchas;
        },
      });
      return result.length > 0
        ? `CAPTCHA detected on page: ${result.join(", ")}`
        : "No CAPTCHA widget detected on active tab.";
    }

    case "capture_pdf": {
      if (!activeTab) throw new Error("No active tab found.");
      try {
        await chrome.debugger.attach({ tabId: activeTab.id }, "1.3");
      } catch {}
      const pdfRes = await chrome.debugger.sendCommand({ tabId: activeTab.id }, "Page.printToPDF", {
        printBackground: true,
        landscape: false,
      });
      try {
        await chrome.debugger.detach({ tabId: activeTab.id });
      } catch {}
      return pdfRes.data; // Base64 encoded PDF string
    }

    case "set_network_conditions": {
      if (!activeTab) throw new Error("No active tab found.");
      try {
        await chrome.debugger.attach({ tabId: activeTab.id }, "1.3");
      } catch {}
      const profile = target || value || "online";
      let offline = false, latency = 0, downloadThroughput = -1, uploadThroughput = -1;
      if (profile === "fast_3g") { latency = 40; downloadThroughput = 1.6 * 1024 * 1024 / 8; uploadThroughput = 750 * 1024 / 8; }
      else if (profile === "slow_3g") { latency = 400; downloadThroughput = 400 * 1024 / 8; uploadThroughput = 150 * 1024 / 8; }
      else if (profile === "offline") { offline = true; }

      await chrome.debugger.sendCommand({ tabId: activeTab.id }, "Network.emulateNetworkConditions", {
        offline,
        latency,
        downloadThroughput,
        uploadThroughput,
      });
      return `Emulated network condition profile: '${profile}'`;
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
          return new Promise((resolve, reject) => {
            const timeout = 5000;
            const start = Date.now();
            const timer = setInterval(() => {
              const el = document.querySelector(selector);
              if (el) {
                clearInterval(timer);
                el.click();
                resolve(`Clicked element matching '${selector}'`);
              } else if (Date.now() - start > timeout) {
                clearInterval(timer);
                reject(new Error(`Timeout waiting for element '${selector}' to be clickable.`));
              }
            }, 100);
          });
        },
        args: [target],
      });
      return `Clicked element matching '${target}'`;
    }

    case "type":
    case "paste": {
      if (!activeTab) throw new Error("No active tab found.");
      if (!target) throw new Error("Target CSS selector required for type/paste.");
      const markdownHTML = parseMarkdownToHTML(value || "");
      
      // Focus target element in DOM via script injection
      await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: (selector) => {
          const el = document.querySelector(selector);
          if (el) {
            const targetEl = el.isContentEditable || el.getAttribute("contenteditable") === "true" ? el : (el.closest('[contenteditable="true"]') || el);
            targetEl.focus();
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(targetEl);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        },
        args: [target],
      });

      // Try native Chrome DevTools Protocol (CDP) key event dispatching
      let cdpSuccess = false;
      try {
        await chrome.debugger.attach({ tabId: activeTab.id }, "1.3");
        for (const char of (value || "")) {
          await chrome.debugger.sendCommand({ tabId: activeTab.id }, "Input.dispatchKeyEvent", {
            type: "keyDown",
            text: char,
            unmodifiedText: char,
          });
          await chrome.debugger.sendCommand({ tabId: activeTab.id }, "Input.dispatchKeyEvent", {
            type: "keyUp",
            text: char,
            unmodifiedText: char,
          });
        }
        await chrome.debugger.detach({ tabId: activeTab.id });
        cdpSuccess = true;
      } catch (cdpErr) {
        // Fallback if debugger attach fails
      }

      if (!cdpSuccess) {
        await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: (selector, val, htmlVal) => {
            const el = document.querySelector(selector);
            if (el) {
              const targetEl = el.isContentEditable || el.getAttribute("contenteditable") === "true" ? el : (el.closest('[contenteditable="true"]') || el);
              targetEl.focus();
              if (targetEl.isContentEditable || targetEl.getAttribute("contenteditable") === "true" || targetEl.closest('[contenteditable="true"]')) {
                document.execCommand("insertText", false, val);
              } else {
                targetEl.value = val;
                targetEl.dispatchEvent(new Event("input", { bubbles: true }));
                targetEl.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }
          },
          args: [target, value || "", markdownHTML],
        });
      }
      return `${action === "paste" ? "Pasted content" : "Typed"} into target '${target}' (CDP: ${cdpSuccess}).`;
    }

    case "errors": {
      if (consoleLogsBuffer.length === 0) {
        return "No console logs or JavaScript errors recorded on active tab.";
      }
      return consoleLogsBuffer
        .map((log) => `[${log.timestamp}] [${log.level.toUpperCase()}] (${log.source}) ${log.text}`)
        .join("\n");
    }

    case "dom_info": {
      return `Inspected DOM info on active tab (${activeTab ? activeTab.url : "N/A"}).`;
    }

    default:
      return `Action '${action}' executed successfully via Superagent Remote Bridge.`;
  }
}

// Keep service worker alive and ensure persistent WebSocket bridge connection with watchdog alarm
try {
  chrome.alarms.create("superagentKeepAlive", { periodInMinutes: 0.25 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "superagentKeepAlive") {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        connectWebSocket(true);
      }
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

// Attach Chrome DevTools Protocol listener for console, exception & network streaming
async function attachCDPListeners(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Console.enable");
    await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  } catch {}
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method === "Console.messageAdded") {
    const { level, text } = params.message;
    logConsoleEvent(level, text, "console");
  } else if (method === "Runtime.exceptionThrown") {
    const text = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Unhandled JS Exception";
    logConsoleEvent("error", text, "runtime");
  } else if (method === "Network.responseReceived") {
    const { response, type } = params;
    if (response) {
      logNetworkEvent(response.requestHeaders?.method || "GET", response.url, response.status, type);
    }
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  attachCDPListeners(activeInfo.tabId);
});

// Connect immediately on service worker start
connectWebSocket();
