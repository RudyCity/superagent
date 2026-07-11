// Grab Browser Context (Active Tab)
async function grabTabContext() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0) return;
    const activeTab = tabs[0];
    
    // Inject content script to grab page context
    chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: () => {
        const selection = window.getSelection().toString().trim();
        const bodyText = document.body.innerText.trim();
        const errors = window.__capturedErrors || [];
        return { selection, bodyText, errors };
      }
    }, (results) => {
      if (!results || results.length === 0) return;
      const { selection, bodyText, errors } = results[0].result;
      
      let contextText = `[Context from tab: "${activeTab.title}" (${activeTab.url})]\n`;
      contextText += `=========================================\n`;
      
      if (selection) {
        contextText += `[Selected text]:\n${selection}\n`;
      } else {
        contextText += `[Page Content Summary (First 1500 chars)]:\n${bodyText.slice(0, 1500)}...\n`;
      }

      if (errors && errors.length > 0) {
        contextText += `=========================================\n`;
        contextText += `[Captured Console Errors & Exceptions]:\n`;
        errors.slice(-10).forEach(err => {
          contextText += `- [${err.type}] ${err.message} (${new Date(err.timestamp).toLocaleTimeString()})\n`;
          if (err.stack) {
            contextText += `  Stack: ${err.stack.split("\n").slice(0, 3).join("\n  ")}\n`;
          }
        });
      }
      
      contextText += `=========================================\n\n[Instruction]: `;

      chatInput.value = contextText + chatInput.value;
      chatInput.focus();
      contextBadge.classList.remove("hidden");
      setTimeout(() => chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length), 50);
    });
  });
}

// Execute browser automation control
async function executeBrowserControl(controlId, action, target, value) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0) {
      sendBrowserResult(controlId, "Error: No active tab found in current window.", true);
      return;
    }
    const activeTab = tabs[0];

    if (action === "screenshot") {
      chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: Failed to capture tab: ${chrome.runtime.lastError.message}`, true);
          return;
        }
        sendBrowserResult(controlId, dataUrl, false);
      });
      return;
    }

    if (action === "navigate") {
      chrome.tabs.update(activeTab.id, { url: target }, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Navigated to ${target}`, false);
        }
      });
      return;
    }

    if (action === "reload" || action === "refresh") {
      chrome.tabs.reload(activeTab.id, {}, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, "Page reloaded", false);
        }
      });
      return;
    }

    if (action === "back") {
      chrome.tabs.goBack(activeTab.id, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, "Navigated back", false);
        }
      });
      return;
    }

    if (action === "forward") {
      chrome.tabs.goForward(activeTab.id, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, "Navigated forward", false);
        }
      });
      return;
    }

    if (action === "errors") {
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            return window.__capturedErrors || [];
          }
        }, (results) => {
          if (chrome.runtime.lastError) {
            sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
            return;
          }
          if (!results || results.length === 0) {
            sendBrowserResult(controlId, "[]", false);
            return;
          }
          sendBrowserResult(controlId, JSON.stringify(results[0].result), false);
        });
      } catch (err) {
        sendBrowserResult(controlId, `Error: Script injection failed: ${err.message || String(err)}`, true);
      }
      return;
    }

    try {
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: async (act, tgt, val) => {
          try {
            const waitForSelector = (selector, timeoutMs = 5000) => {
              return new Promise((resolve, reject) => {
                if (document.querySelector(selector)) {
                  return resolve(true);
                }
                const startTime = Date.now();
                const interval = setInterval(() => {
                  if (document.querySelector(selector)) {
                    clearInterval(interval);
                    resolve(true);
                  } else if (Date.now() - startTime > timeoutMs) {
                    clearInterval(interval);
                    reject(new Error(`Timeout waiting for selector: ${selector}`));
                  }
                }, 100);
              });
            };

            const showCursor = (element, actionType = "move") => {
              try {
                let cursor = document.getElementById("__superagent_cursor__");
                if (!cursor) {
                  cursor = document.createElement("div");
                  cursor.id = "__superagent_cursor__";
                  cursor.style.position = "absolute";
                  cursor.style.width = "14px";
                  cursor.style.height = "14px";
                  cursor.style.background = "rgba(220, 38, 38, 0.75)";
                  cursor.style.border = "2.5px solid #ffffff";
                  cursor.style.borderRadius = "50%";
                  cursor.style.pointerEvents = "none";
                  cursor.style.zIndex = "999999999";
                  cursor.style.transition = "left 0.2s cubic-bezier(0.25, 1, 0.5, 1), top 0.2s cubic-bezier(0.25, 1, 0.5, 1), transform 0.15s ease-out, background-color 0.15s ease-out, opacity 0.3s ease-out";
                  cursor.style.boxShadow = "0 2px 4px rgba(0,0,0,0.4)";
                  document.body.appendChild(cursor);
                }
                
                if (window.__superagent_cursor_timeout__) {
                  clearTimeout(window.__superagent_cursor_timeout__);
                }
                cursor.style.opacity = "1";

                const rect = element.getBoundingClientRect();
                const x = rect.left + rect.width / 2 + window.scrollX;
                const y = rect.top + rect.height / 2 + window.scrollY;
                
                cursor.style.left = `${x - 7}px`;
                cursor.style.top = `${y - 7}px`;
                cursor.style.transform = "scale(1)";
                cursor.style.backgroundColor = "rgba(220, 38, 38, 0.75)";

                if (actionType === "click") {
                  cursor.style.transform = "scale(0.7)";
                  cursor.style.backgroundColor = "rgba(239, 68, 68, 1)";
                  setTimeout(() => {
                    cursor.style.transform = "scale(1.2)";
                    setTimeout(() => {
                      cursor.style.transform = "scale(1)";
                    }, 150);
                  }, 100);
                } else if (actionType === "type") {
                  cursor.style.transform = "scale(1.1)";
                  cursor.style.backgroundColor = "rgba(14, 99, 156, 0.85)";
                  setTimeout(() => {
                    cursor.style.transform = "scale(1)";
                  }, 150);
                }

                window.__superagent_cursor_timeout__ = setTimeout(() => {
                  cursor.style.opacity = "0";
                }, 3000);
              } catch (e) {
                // Ignore cursor errors
              }
            };

            const showBanner = (text) => {
              try {
                let banner = document.getElementById("__superagent_banner__");
                if (!banner) {
                  banner = document.createElement("div");
                  banner.id = "__superagent_banner__";
                  banner.style.position = "fixed";
                  banner.style.top = "10px";
                  banner.style.left = "50%";
                  banner.style.transform = "translateX(-50%)";
                  banner.style.padding = "6px 12px";
                  banner.style.background = "rgba(30, 30, 30, 0.92)";
                  banner.style.border = "1px solid #0e639c";
                  banner.style.borderRadius = "4px";
                  banner.style.color = "#cccccc";
                  banner.style.fontFamily = "'Segoe UI', system-ui, -apple-system, sans-serif";
                  banner.style.fontSize = "12px";
                  banner.style.fontWeight = "500";
                  banner.style.zIndex = "999999999";
                  banner.style.display = "flex";
                  banner.style.alignItems = "center";
                  banner.style.gap = "8px";
                  banner.style.pointerEvents = "none";
                  banner.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
                  banner.style.transition = "opacity 0.3s ease-out";
                  
                  const dot = document.createElement("span");
                  dot.style.width = "8px";
                  dot.style.height = "8px";
                  dot.style.background = "#ff3b30";
                  dot.style.borderRadius = "50%";
                  dot.style.display = "inline-block";
                  dot.animate([
                    { opacity: 0.4 },
                    { opacity: 1 },
                    { opacity: 0.4 }
                  ], {
                    duration: 1500,
                    iterations: Infinity
                  });
                  
                  const label = document.createElement("span");
                  label.id = "__superagent_banner_text__";
                  label.textContent = text;
                  
                  banner.appendChild(dot);
                  banner.appendChild(label);
                  document.body.appendChild(banner);
                } else {
                  const label = document.getElementById("__superagent_banner_text__");
                  if (label) label.textContent = text;
                }
                
                if (window.__superagent_banner_timeout__) {
                  clearTimeout(window.__superagent_banner_timeout__);
                }
                banner.style.opacity = "1";
                
                window.__superagent_banner_timeout__ = setTimeout(() => {
                  banner.style.opacity = "0";
                }, 3000);
              } catch (e) {
                // Ignore banner errors
              }
            };

            if (act === "wait") {
              showBanner(`Waiting for ${tgt}...`);
              const timeout = parseInt(val || "5000", 10);
              if (!isNaN(Number(tgt))) {
                const ms = parseInt(tgt, 10);
                await new Promise(r => setTimeout(r, ms));
                return `Waited for ${ms}ms`;
              }
              await waitForSelector(tgt, timeout);
              return `Element ${tgt} is now present`;
            }

            if (act === "html") {
              showBanner(`Reading HTML from ${tgt || "page"}...`);
              if (!tgt) {
                return document.documentElement ? document.documentElement.outerHTML : "";
              }
              const el = document.querySelector(tgt);
              if (!el) {
                return `Error: Element not found for selector: ${tgt}`;
              }
              return el.outerHTML || "";
            }

            if (act === "scroll") {
              showBanner(`Scrolling ${tgt}...`);
              if (tgt === "up") {
                window.scrollBy(0, -window.innerHeight / 2);
                return "Scrolled page up";
              } else if (tgt === "down") {
                window.scrollBy(0, window.innerHeight / 2);
                return "Scrolled page down";
              } else {
                const el = document.querySelector(tgt);
                if (el) {
                  el.scrollIntoView({ behavior: "smooth" });
                  return `Scrolled to element ${tgt}`;
                }
                return `Element not found: ${tgt}`;
              }
            }

            if (act === "text") {
              showBanner(`Reading text from ${tgt || "page"}...`);
              if (!tgt) {
                return document.body ? document.body.innerText : "";
              }
              const el = document.querySelector(tgt);
              if (!el) {
                return `Error: Element not found for selector: ${tgt}`;
              }
              return el.innerText || "";
            }

            const el = document.querySelector(tgt);
            if (!el) {
              return `Error: Element not found for selector: ${tgt}`;
            }

            if (act === "click") {
              showBanner(`Clicking element ${tgt}...`);
              showCursor(el, "click");
              el.click();
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return `Clicked element ${tgt}`;
            }

            if (act === "hover") {
              showBanner(`Hovering over element ${tgt}...`);
              showCursor(el, "move");
              const rect = el.getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 }));
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2 }));
              return `Hovered over element ${tgt}`;
            }

            if (act === "keypress") {
              showBanner(`Pressing key ${val || "Enter"} on element ${tgt}...`);
              showCursor(el, "click");
              const key = val || "Enter";
              const keyCode = key === "Enter" ? 13 : 0;
              const eventInit = { key, keyCode, bubbles: true, cancelable: true };
              el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
              el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
              el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
              
              if (key === "Enter") {
                if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
                  const form = el.closest("form");
                  if (form) {
                    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
                  }
                }
              }
              return `Pressed key "${key}" on element ${tgt}`;
            }

            if (act === "type") {
              showBanner(`Typing into element ${tgt}...`);
              showCursor(el, "type");
              if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                const proto = el instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(el, val);
                } else {
                  el.value = val;
                }
              } else if (el.isContentEditable) {
                el.innerText = val;
              } else {
                try {
                  el.value = val;
                } catch (e) {
                  el.innerText = val;
                }
              }
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return `Typed "${val}" into element ${tgt}`;
            }

            return `Error: Unknown action ${act}`;
          } catch (err) {
            return `Error: ${err.message || String(err)}`;
          }
        },
        args: [action || "", target || "", value || ""]
      }, (results) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
          return;
        }
        if (!results || results.length === 0) {
          sendBrowserResult(controlId, "Error: Script execution failed to return results.", true);
          return;
        }
        const res = results[0].result;
        const isError = typeof res === "string" && res.startsWith("Error:");
        sendBrowserResult(controlId, res, isError);
      });
    } catch (err) {
      sendBrowserResult(controlId, `Error: Script injection failed: ${err.message || String(err)}`, true);
    }
  });
}

async function sendBrowserResult(controlId, result, isError) {
  try {
    await fetch(`${BASE_URL}/api/browser/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controlId, result, isError })
    });
  } catch (err) {
    console.error("Failed to send browser control result", err);
  }
}
