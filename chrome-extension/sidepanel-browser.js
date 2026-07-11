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
        return { selection, bodyText };
      }
    }, (results) => {
      if (!results || results.length === 0) return;
      const { selection, bodyText } = results[0].result;
      
      let contextText = `[Context from tab: "${activeTab.title}" (${activeTab.url})]\n`;
      contextText += `=========================================\n`;
      
      if (selection) {
        contextText += `[Selected text]:\n${selection}\n`;
      } else {
        contextText += `[Page Content Summary (First 1500 chars)]:\n${bodyText.slice(0, 1500)}...\n`;
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
        func: (act, tgt, val) => {
          try {
            if (act === "scroll") {
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
              el.click();
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return `Clicked element ${tgt}`;
            }

            if (act === "type") {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                "value"
              )?.set || Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype,
                "value"
              )?.set;

              if (nativeInputValueSetter) {
                nativeInputValueSetter.call(el, val);
              } else {
                el.value = val;
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
