let isTabLocked = false;
let originalTabId = null;
let originalWindowId = null;
const activeChains = new Map();

// Execute browser automation control
async function executeBrowserControl(controlId, action, target, value) {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (!tabs || tabs.length === 0) {
      sendBrowserResult(controlId, "Error: No active tab found in current window.", true);
      return;
    }
    const activeTab = tabs[0];
    const url = activeTab.url || "";
    const lowerUrl = url.toLowerCase();
    const isRestricted = lowerUrl.startsWith("chrome://") || 
                         lowerUrl.startsWith("chrome-extension://") || 
                         lowerUrl.startsWith("chrome-devtools://") || 
                         lowerUrl.startsWith("edge://") || 
                         lowerUrl.startsWith("about:") || 
                         lowerUrl.startsWith("view-source:");

    const nonRestrictedActions = ["navigate", "reload", "refresh", "back", "forward", "open", "close", "list", "switch", "duplicate", "pin", "unpin", "mute", "unmute", "move", "group", "ungroup", "discard", "new_window", "close_window", "top_sites", "reading_list_add", "reading_list_remove", "reading_list_get", "group_update", "group_get", "history_search", "history_delete", "history_clear", "management_list", "management_get"];
    if (isRestricted && !nonRestrictedActions.includes(action)) {
      sendBrowserResult(controlId, `Error: Cannot perform action "${action}" on a restricted page (${url || "restricted tab"}). Please navigate to a standard website first (e.g., navigate to https://google.com).`, true);
      return;
    }

    if (action === "top_sites") {
      chrome.topSites.get((sites) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, JSON.stringify(sites), false);
        }
      });
      return;
    }

    if (action === "reading_list_add") {
      chrome.readingList.create({ url: target, title: value || target }, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Added ${target} to reading list`, false);
        }
      });
      return;
    }

    if (action === "reading_list_remove") {
      chrome.readingList.remove({ url: target }, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Removed ${target} from reading list`, false);
        }
      });
      return;
    }

    if (action === "reading_list_get") {
      chrome.readingList.query({}, (items) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, JSON.stringify(items), false);
        }
      });
      return;
    }

    if (action === "group_update") {
      const groupId = parseInt(target, 10);
      if (isNaN(groupId)) {
        sendBrowserResult(controlId, `Error: Invalid group ID "${target}"`, true);
        return;
      }
      let updateObj = {};
      try {
        updateObj = JSON.parse(value);
      } catch (e) {
        updateObj = { title: value };
      }
      chrome.tabGroups.update(groupId, updateObj, (group) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Updated group ${groupId} with metadata: ${JSON.stringify(updateObj)}`, false);
        }
      });
      return;
    }

    if (action === "group_get") {
      if (target) {
        const groupId = parseInt(target, 10);
        if (isNaN(groupId)) {
          sendBrowserResult(controlId, `Error: Invalid group ID "${target}"`, true);
          return;
        }
        chrome.tabGroups.get(groupId, (group) => {
          if (chrome.runtime.lastError) {
            sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
          } else {
            sendBrowserResult(controlId, JSON.stringify(group), false);
          }
        });
      } else {
        chrome.tabGroups.query({}, (groups) => {
          if (chrome.runtime.lastError) {
            sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
          } else {
            sendBrowserResult(controlId, JSON.stringify(groups), false);
          }
        });
      }
      return;
    }

    if (action === "history_search") {
      const maxResults = value ? parseInt(value, 10) : 100;
      chrome.history.search({ text: target || "", maxResults: isNaN(maxResults) ? 100 : maxResults }, (items) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, JSON.stringify(items), false);
        }
      });
      return;
    }

    if (action === "history_delete") {
      chrome.history.deleteUrl({ url: target }, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Deleted ${target} from history`, false);
        }
      });
      return;
    }

    if (action === "history_clear") {
      chrome.history.deleteAll(() => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Browser history cleared`, false);
        }
      });
      return;
    }

    if (action === "management_list") {
      chrome.management.getAll((infos) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, JSON.stringify(infos), false);
        }
      });
      return;
    }

    if (action === "management_get") {
      chrome.management.get(target, (info) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, JSON.stringify(info), false);
        }
      });
      return;
    }

    if (action === "open") {
      chrome.tabs.create({ url: target || "about:blank" }, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          if (isTabLocked && tab) {
            originalTabId = tab.id;
            originalWindowId = tab.windowId;
          }
          sendBrowserResult(controlId, `Opened new tab with ID ${tab.id} and URL ${target || "about:blank"}`, false);
        }
      });
      return;
    }

    if (action === "close") {
      const tabId = target ? parseInt(target, 10) : activeTab.id;
      if (isNaN(tabId)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}"`, true);
        return;
      }
      chrome.tabs.remove(tabId, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Closed tab ${tabId}`, false);
        }
      });
      return;
    }

    if (action === "list") {
      chrome.tabs.query({}, (allTabs) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          const tabList = allTabs.map(t => ({
            id: t.id,
            title: t.title,
            url: t.url,
            active: t.active,
            pinned: t.pinned,
            muted: t.mutedInfo ? t.mutedInfo.muted : false,
            groupId: t.groupId,
            windowId: t.windowId
          }));
          sendBrowserResult(controlId, JSON.stringify(tabList), false);
        }
      });
      return;
    }

    if (action === "switch") {
      const tabId = parseInt(target, 10);
      if (isNaN(tabId)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}"`, true);
        return;
      }
      chrome.tabs.update(tabId, { active: true }, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          if (isTabLocked && tab) {
            originalTabId = tab.id;
            originalWindowId = tab.windowId;
          }
          if (tab && tab.windowId) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
          sendBrowserResult(controlId, `Switched to tab ${tabId}`, false);
        }
      });
      return;
    }

    if (action === "duplicate") {
      const tabId = target ? parseInt(target, 10) : activeTab.id;
      if (isNaN(tabId)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}"`, true);
        return;
      }
      chrome.tabs.duplicate(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          if (isTabLocked && tab) {
            originalTabId = tab.id;
            originalWindowId = tab.windowId;
          }
          sendBrowserResult(controlId, `Duplicated tab ${tabId} as new tab ${tab ? tab.id : ""}`, false);
        }
      });
      return;
    }

    if (action === "pin" || action === "unpin") {
      const tabId = target ? parseInt(target, 10) : activeTab.id;
      if (isNaN(tabId)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}"`, true);
        return;
      }
      const pinned = action === "pin";
      chrome.tabs.update(tabId, { pinned }, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `${pinned ? "Pinned" : "Unpinned"} tab ${tabId}`, false);
        }
      });
      return;
    }

    if (action === "mute" || action === "unmute") {
      const tabId = target ? parseInt(target, 10) : activeTab.id;
      if (isNaN(tabId)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}"`, true);
        return;
      }
      const muted = action === "mute";
      chrome.tabs.update(tabId, { muted }, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `${muted ? "Muted" : "Unmuted"} tab ${tabId}`, false);
        }
      });
      return;
    }

    if (action === "move") {
      const tabId = parseInt(target, 10);
      const index = parseInt(value, 10);
      if (isNaN(tabId) || isNaN(index)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}" or index "${value}"`, true);
        return;
      }
      chrome.tabs.move(tabId, { index }, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Moved tab ${tabId} to index ${index}`, false);
        }
      });
      return;
    }

    if (action === "group") {
      const tabIds = target.split(",").map(idStr => parseInt(idStr.trim(), 10)).filter(id => !isNaN(id));
      if (tabIds.length === 0) {
        sendBrowserResult(controlId, `Error: No valid tab IDs found in target "${target}"`, true);
        return;
      }
      const groupId = value ? parseInt(value, 10) : undefined;
      chrome.tabs.group({ tabIds, groupId }, (gid) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Grouped tabs [${tabIds.join(", ")}] under group ${gid}`, false);
        }
      });
      return;
    }

    if (action === "ungroup") {
      const tabIds = target.split(",").map(idStr => parseInt(idStr.trim(), 10)).filter(id => !isNaN(id));
      if (tabIds.length === 0) {
        sendBrowserResult(controlId, `Error: No valid tab IDs found in target "${target}"`, true);
        return;
      }
      chrome.tabs.ungroup(tabIds, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Ungrouped tabs [${tabIds.join(", ")}]`, false);
        }
      });
      return;
    }

    if (action === "discard") {
      const tabId = target ? parseInt(target, 10) : activeTab.id;
      if (isNaN(tabId)) {
        sendBrowserResult(controlId, `Error: Invalid tab ID "${target}"`, true);
        return;
      }
      chrome.tabs.discard(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Discarded tab ${tabId}`, false);
        }
      });
      return;
    }

    if (action === "new_window") {
      const url = target || undefined;
      chrome.windows.create({ url }, (win) => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Created new window with ID ${win ? win.id : ""}`, false);
        }
      });
      return;
    }

    if (action === "close_window") {
      const windowId = target ? parseInt(target, 10) : activeTab.windowId;
      if (isNaN(windowId)) {
        sendBrowserResult(controlId, `Error: Invalid window ID "${target}"`, true);
        return;
      }
      chrome.windows.remove(windowId, () => {
        if (chrome.runtime.lastError) {
          sendBrowserResult(controlId, `Error: ${chrome.runtime.lastError.message}`, true);
        } else {
          sendBrowserResult(controlId, `Closed window ${windowId}`, false);
        }
      });
      return;
    }

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

    if (action === "show_detections") {
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          args: [target],
          func: (elementsJson) => {
            try {
              const elements = JSON.parse(elementsJson);
              const existing = document.getElementById("__sa_detr_overlay__");
              if (existing) existing.remove();

              const overlay = document.createElement("div");
              overlay.id = "__sa_detr_overlay__";
              overlay.style.cssText = "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;";
              document.body.appendChild(overlay);

              const COLORS = {
                button: "#4285F4", input: "#34A853", select: "#FBBC05",
                checkbox: "#EA4335", link: "#9C27B0", text: "#00BCD4",
                image: "#FF5722", default: "#607D8B"
              };

              elements.forEach((el) => {
                const [x1, y1, x2, y2] = el.box;
                const color = COLORS[el.label] || COLORS.default;
                const box = document.createElement("div");
                box.style.cssText = `position:fixed;left:${x1}px;top:${y1}px;width:${x2-x1}px;height:${y2-y1}px;border:2px solid ${color};box-sizing:border-box;pointer-events:none;`;
                
                const label = document.createElement("div");
                label.style.cssText = `position:absolute;top:-18px;left:0;background:${color};color:white;font-size:10px;font-family:monospace;padding:1px 4px;white-space:nowrap;border-radius:2px 2px 0 0;`;
                label.textContent = `${el.label} ${Math.round(el.score * 100)}%`;
                box.appendChild(label);
                overlay.appendChild(box);
              });
            } catch(e) {}
          }
        }, () => {
          sendBrowserResult(controlId, "Detection overlay shown", false);
        });
      } catch (err) {
        sendBrowserResult(controlId, `Error: show_detections failed: ${err.message}`, true);
      }
      return;
    }

    if (action === "hide_detections") {
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            const el = document.getElementById("__sa_detr_overlay__");
            if (el) el.remove();
          }
        }, () => {
          sendBrowserResult(controlId, "Detection overlay hidden", false);
        });
      } catch (err) {
        sendBrowserResult(controlId, `Error: hide_detections failed: ${err.message}`, true);
      }
      return;
    }

    if (action === "dom_info") {
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          args: [target],
          func: (coordStr) => {
            const [x, y] = coordStr.split(",").map(Number);
            const el = document.elementFromPoint(x, y);
            if (!el) return JSON.stringify({ found: false });
            
            function buildSelector(node) {
              if (node.id) return "#" + node.id;
              if (node.getAttribute?.("data-testid")) return `[data-testid="${node.getAttribute("data-testid")}"]`;
              if (node.name && ["INPUT","SELECT","TEXTAREA"].includes(node.tagName)) return `${node.tagName.toLowerCase()}[name="${node.name}"]`;
              const parts = [];
              let cur = node;
              while (cur && cur !== document.body) {
                let idx = 1, sib = cur.previousElementSibling;
                while (sib) { if (sib.tagName === cur.tagName) idx++; sib = sib.previousElementSibling; }
                parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${idx})`);
                cur = cur.parentElement;
              }
              return parts.join(" > ");
            }
            
            return JSON.stringify({
              found: true,
              tagName: el.tagName,
              id: el.id || null,
              ariaLabel: el.getAttribute("aria-label") || null,
              placeholder: el.getAttribute("placeholder") || null,
              innerText: (el.innerText || "").slice(0, 80).trim(),
              selector: buildSelector(el),
              isClickable: ["A","BUTTON","INPUT","SELECT","TEXTAREA"].includes(el.tagName) || el.getAttribute("role") === "button"
            });
          }
        }, (results) => {
          if (chrome.runtime.lastError) {
            sendBrowserResult(controlId, JSON.stringify({ found: false, error: chrome.runtime.lastError.message }), false);
            return;
          }
          sendBrowserResult(controlId, results?.[0]?.result ?? JSON.stringify({ found: false }), false);
        });
      } catch (err) {
        sendBrowserResult(controlId, JSON.stringify({ found: false, error: err.message }), false);
      }
      return;
    }

    if (action === "highlight_element") {
      try {
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          args: [target],
          func: (targetCoord) => {
            const existing = document.querySelectorAll(".__sa_hover_highlight__");
            existing.forEach(el => el.remove());
            
            if (targetCoord === "clear" || !targetCoord) return;
            
            const [x, y] = targetCoord.split(",").map(Number);
            if (isNaN(x) || isNaN(y)) return;
            
            const el = document.elementFromPoint(x, y);
            if (!el) return;
            
            const rect = el.getBoundingClientRect();
            const highlight = document.createElement("div");
            highlight.className = "__sa_hover_highlight__";
            highlight.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;border:3px dashed #FFBC05;background-color:rgba(251,188,5,0.15);box-sizing:border-box;pointer-events:none;z-index:2147483645;transition:all 0.15s ease-out;`;
            document.body.appendChild(highlight);
          }
        }, () => {
          sendBrowserResult(controlId, "Element highlighted", false);
        });
      } catch (err) {
        sendBrowserResult(controlId, `Error: highlight_element failed: ${err.message}`, true);
      }
      return;
    }

    if (action === "execute_chain") {
      try {
        const steps = JSON.parse(target);
        if (!Array.isArray(steps)) throw new Error("Steps must be a JSON array");
        
        const runNextStep = async (idx) => {
          if (idx >= steps.length) {
            sendBrowserResult(controlId, "Chain executed successfully", false);
            return;
          }
          const step = steps[idx];
          const stepControlId = `chain-step-${controlId}-${idx}`;
          
          activeChains.set(stepControlId, async (result, isError) => {
            activeChains.delete(stepControlId);
            if (isError) {
              sendBrowserResult(controlId, `Chain failed at step ${idx} (${step.action}): ${result}`, true);
            } else {
              await new Promise(r => setTimeout(r, 250));
              runNextStep(idx + 1);
            }
          });
          
          executeBrowserControl(stepControlId, step.action, step.target, step.value || "");
        };
        
        runNextStep(0);
      } catch (err) {
        sendBrowserResult(controlId, `Chain parsing failed: ${err.message}`, true);
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

            const isElementInViewport = (element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
              );
            };

            const scrollIntoViewAndWait = async (element) => {
              if (isElementInViewport(element)) return;

              element.scrollIntoView({ behavior: "smooth", block: "center" });

              await new Promise((resolve) => {
                let lastTop = null;
                let lastLeft = null;
                let samePositionCount = 0;
                const check = () => {
                  const rect = element.getBoundingClientRect();
                  if (rect.top === lastTop && rect.left === lastLeft) {
                    samePositionCount++;
                    if (samePositionCount >= 3) {
                      resolve();
                      return;
                    }
                  } else {
                    samePositionCount = 0;
                    lastTop = rect.top;
                    lastLeft = rect.left;
                  }
                  requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
              });

              await new Promise((r) => setTimeout(r, 100));
            };

            const startCursorTremor = () => {
              if (window.__superagent_cursor_tremor_interval__) {
                clearInterval(window.__superagent_cursor_tremor_interval__);
              }
              const cursor = document.getElementById("__superagent_cursor__");
              if (!cursor) return;

              let angle = 0;
              window.__superagent_cursor_tremor_interval__ = setInterval(() => {
                const opacity = parseFloat(cursor.style.opacity || "1");
                if (opacity <= 0.01) {
                  clearInterval(window.__superagent_cursor_tremor_interval__);
                  return;
                }
                const dx = Math.sin(angle) * 0.4;
                const dy = Math.cos(angle * 1.3) * 0.4;
                const currentScale = cursor.style.transform.match(/scale\([^)]+\)/) || "scale(1)";
                cursor.style.transform = `${currentScale} translate(${dx}px, ${dy}px)`;
                angle += 0.2;
              }, 40);
            };

            const pasteTextInstant = async (element, text) => {
               const isInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
               const isEditable = element.isContentEditable || element.closest("[contenteditable='true']");
               
               if (!isInput && !isEditable) {
                 try {
                   element.value = text;
                 } catch (e) {
                   element.innerText = text;
                 }
                 element.dispatchEvent(new Event("input", { bubbles: true }));
                 element.dispatchEvent(new Event("change", { bubbles: true }));
                 return;
               }

               // Focus element first
               if (typeof element.focus === "function") {
                 element.focus();
               }
               const editableContainer = element.closest("[contenteditable='true']") || (element.isContentEditable ? element : null);
               if (editableContainer && typeof editableContainer.focus === "function") {
                 editableContainer.focus();
               }

               // Initialize caret position for contenteditable if not already focused
               if (isEditable && editableContainer) {
                 const sel = window.getSelection();
                 if (sel.rangeCount === 0 || !editableContainer.contains(sel.anchorNode)) {
                   const range = document.createRange();
                   range.selectNodeContents(editableContainer);
                   range.collapse(false); // Position at the end
                   sel.removeAllRanges();
                   sel.addRange(range);
                 }
               }

               if (isInput) {
                 const start = element.selectionStart;
                 const end = element.selectionEnd;
                 const val = element.value;
                 const newVal = val.substring(0, start) + text + val.substring(end);
                 
                 // Use native setter if available to bypass React/Vue setters
                 const proto = element instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                 const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                 if (nativeInputValueSetter) {
                   nativeInputValueSetter.call(element, newVal);
                 } else {
                   element.value = newVal;
                 }
                 
                 element.setSelectionRange(start + text.length, start + text.length);
                 element.dispatchEvent(new Event("input", { bubbles: true }));
               } else if (isEditable && editableContainer) {
                 const sel = window.getSelection();
                 if (sel.rangeCount > 0) {
                   const range = sel.getRangeAt(0);
                   range.deleteContents();
                   const textNode = document.createTextNode(text);
                   range.insertNode(textNode);
                   range.setStartAfter(textNode);
                   range.setEndAfter(textNode);
                   sel.removeAllRanges();
                   sel.addRange(range);
                 }
                 editableContainer.dispatchEvent(new Event("input", { bubbles: true }));
               }

               if (isInput) {
                 element.dispatchEvent(new Event("change", { bubbles: true }));
               } else if (isEditable && editableContainer) {
                 editableContainer.dispatchEvent(new Event("change", { bubbles: true }));
               }
             };

            const typeTextHumanLike = async (element, text) => {
              const isInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
              const isEditable = element.isContentEditable || element.closest("[contenteditable='true']");
              
              if (!isInput && !isEditable) {
                try {
                  element.value = text;
                } catch (e) {
                  element.innerText = text;
                }
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
                return;
              }

              // Focus element first
              if (typeof element.focus === "function") {
                element.focus();
              }
              const editableContainer = element.closest("[contenteditable='true']") || (element.isContentEditable ? element : null);
              if (editableContainer && typeof editableContainer.focus === "function") {
                editableContainer.focus();
              }

              // Initialize caret position for contenteditable if not already focused
              if (isEditable && editableContainer) {
                const sel = window.getSelection();
                if (sel.rangeCount === 0 || !editableContainer.contains(sel.anchorNode)) {
                  const range = document.createRange();
                  range.selectNodeContents(editableContainer);
                  range.collapse(false); // Position at the end
                  sel.removeAllRanges();
                  sel.addRange(range);
                }
              }

              const typoChance = 0.03;
              const keyboardNeighbors = {
                'a': 'qwsz', 'b': 'vghn', 'c': 'xdfv', 'd': 'ersfxc', 'e': 'wsdr',
                'f': 'rtgvcd', 'g': 'tyhbvf', 'h': 'yujnbg', 'i': 'ujko', 'j': 'uikmnh',
                'k': 'ijlm', 'l': 'okp', 'm': 'njk', 'n': 'bhjm', 'o': 'iklp',
                'p': 'ol', 'q': 'wa', 'r': 'edft', 's': 'wedxza', 't': 'rfgy',
                'u': 'yhji', 'v': 'cfgb', 'w': 'qase', 'x': 'zsdc', 'y': 'tghu', 'z': 'asx'
              };

              const insertChar = (char) => {
                if (isInput) {
                  const start = element.selectionStart;
                  const end = element.selectionEnd;
                  const val = element.value;
                  const newVal = val.substring(0, start) + char + val.substring(end);
                  
                  // Use native setter if available to bypass React/Vue setters
                  const proto = element instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                  if (nativeInputValueSetter) {
                    nativeInputValueSetter.call(element, newVal);
                  } else {
                    element.value = newVal;
                  }
                  
                  element.setSelectionRange(start + 1, start + 1);
                  element.dispatchEvent(new Event("input", { bubbles: true }));
                } else if (isEditable && editableContainer) {
                  const sel = window.getSelection();
                  if (sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();
                    const textNode = document.createTextNode(char);
                    range.insertNode(textNode);
                    range.setStartAfter(textNode);
                    range.setEndAfter(textNode);
                    sel.removeAllRanges();
                    sel.addRange(range);
                  }
                  editableContainer.dispatchEvent(new Event("input", { bubbles: true }));
                }
              };

              const deleteChar = () => {
                if (isInput) {
                  const start = element.selectionStart;
                  const end = element.selectionEnd;
                  if (start > 0 || start !== end) {
                    const val = element.value;
                    const deleteStart = start === end ? start - 1 : start;
                    const newVal = val.substring(0, deleteStart) + val.substring(end);
                    
                    const proto = element instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
                    if (nativeInputValueSetter) {
                      nativeInputValueSetter.call(element, newVal);
                    } else {
                      element.value = newVal;
                    }
                    
                    element.setSelectionRange(deleteStart, deleteStart);
                    element.dispatchEvent(new Event("input", { bubbles: true }));
                  }
                } else if (isEditable && editableContainer) {
                  const sel = window.getSelection();
                  if (sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    if (range.collapsed) {
                      const node = range.startContainer;
                      const offset = range.startOffset;
                      if (node.nodeType === Node.TEXT_NODE && offset > 0) {
                        node.deleteData(offset - 1, 1);
                        range.setStart(node, offset - 1);
                        range.setEnd(node, offset - 1);
                        sel.removeAllRanges();
                        sel.addRange(range);
                      }
                    } else {
                      range.deleteContents();
                    }
                  }
                  editableContainer.dispatchEvent(new Event("input", { bubbles: true }));
                }
              };

              for (let i = 0; i < text.length; i++) {
                const char = text[i];
                
                // Typos simulation (only for letters)
                if (Math.random() < typoChance && keyboardNeighbors[char.toLowerCase()]) {
                  const neighbors = keyboardNeighbors[char.toLowerCase()];
                  const typoChar = neighbors[Math.floor(Math.random() * neighbors.length)];
                  const realTypoChar = (char === char.toUpperCase() ? typoChar.toUpperCase() : typoChar);
                  
                  insertChar(realTypoChar);
                  element.dispatchEvent(new KeyboardEvent("keydown", { key: realTypoChar, bubbles: true }));
                  element.dispatchEvent(new KeyboardEvent("keypress", { key: realTypoChar, bubbles: true }));
                  element.dispatchEvent(new KeyboardEvent("keyup", { key: realTypoChar, bubbles: true }));
                  
                  // Typo pause (human realization of error)
                  await new Promise(r => setTimeout(r, 80 + Math.random() * 80));
                  
                  // Backspace
                  deleteChar();
                  element.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", keyCode: 8, bubbles: true }));
                  element.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", keyCode: 8, bubbles: true }));
                  
                  // Correction pause (re-typing correct key)
                  await new Promise(r => setTimeout(r, 100 + Math.random() * 100));
                }

                insertChar(char);
                element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
                element.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
                element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));

                // Delay between key presses (approx. 50ms to 150ms per key)
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
              }

              if (isInput) {
                element.dispatchEvent(new Event("change", { bubbles: true }));
              } else if (isEditable && editableContainer) {
                editableContainer.dispatchEvent(new Event("change", { bubbles: true }));
              }
            };

            const animateCursorTo = async (elementOrCoords) => {
              try {
                if (window.__superagent_cursor_tremor_interval__) {
                  clearInterval(window.__superagent_cursor_tremor_interval__);
                }

                let targetX, targetY;
                let targetWidth = 20;
                let targetHeight = 20;
                const scrollX = window.scrollX;
                const scrollY = window.scrollY;

                if (elementOrCoords && typeof elementOrCoords.getBoundingClientRect === "function") {
                  // Smoothly scroll target element into viewport if offscreen
                  await scrollIntoViewAndWait(elementOrCoords);
                  const rect = elementOrCoords.getBoundingClientRect();
                  targetWidth = rect.width;
                  targetHeight = rect.height;
                  // Pick a target coordinate slightly randomized inside the target element (inner 60%) to look human-like
                  const paddingX = rect.width * 0.2;
                  const paddingY = rect.height * 0.2;
                  targetX = rect.left + paddingX + Math.random() * (rect.width - 2 * paddingX) + scrollX;
                  targetY = rect.top + paddingY + Math.random() * (rect.height - 2 * paddingY) + scrollY;
                } else if (elementOrCoords && typeof elementOrCoords.x === "number" && typeof elementOrCoords.y === "number") {
                  targetX = elementOrCoords.x + scrollX;
                  targetY = elementOrCoords.y + scrollY;
                } else {
                  return;
                }

                let cursor = document.getElementById("__superagent_cursor__");
                if (!cursor) {
                  cursor = document.createElement("div");
                  cursor.id = "__superagent_cursor__";
                  cursor.style.position = "absolute";
                  cursor.style.width = "20px";
                  cursor.style.height = "20px";
                  cursor.style.setProperty("pointer-events", "none", "important");
                  cursor.style.zIndex = "999999999";
                  cursor.style.transition = "transform 0.15s ease-out, opacity 0.3s ease-out";
                  cursor.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" style="pointer-events: none !important;">
                      <path d="M3 1V15.75L7.7 11.75L11.7 19.75L14 18.25L10 10.25L16.25 10L3 1Z" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round" style="pointer-events: none !important;"/>
                    </svg>
                  `;
                  document.body.appendChild(cursor);
                }

                cursor.style.setProperty("pointer-events", "none", "important");
                if (window.__superagent_cursor_timeout__) {
                  clearTimeout(window.__superagent_cursor_timeout__);
                }
                cursor.style.opacity = "1";

                // Retrieve last position or start from a random edge of screen
                let startX = window.__superagent_cursor_x__;
                let startY = window.__superagent_cursor_y__;
                if (startX === undefined || startY === undefined) {
                  if (Math.random() < 0.5) {
                    startX = scrollX + (Math.random() < 0.5 ? 0 : window.innerWidth);
                    startY = scrollY + Math.random() * window.innerHeight;
                  } else {
                    startX = scrollX + Math.random() * window.innerWidth;
                    startY = scrollY + (Math.random() < 0.5 ? 0 : window.innerHeight);
                  }
                }

                const dx = targetX - startX;
                const dy = targetY - startY;
                const distance = Math.hypot(dx, dy);

                if (distance < 2) {
                  cursor.style.left = `${targetX}px`;
                  cursor.style.top = `${targetY}px`;
                  window.__superagent_cursor_x__ = targetX;
                  window.__superagent_cursor_y__ = targetY;
                  startCursorTremor();
                  return;
                }

                // Decide whether to overshoot (mimicking ghost-cursor human mistake)
                const shouldOvershoot = distance > 200 && Math.random() < 0.6;
                let phase1TargetX = targetX;
                let phase1TargetY = targetY;

                if (shouldOvershoot) {
                  const overshootDist = Math.min(20, Math.max(8, distance * (0.02 + Math.random() * 0.03)));
                  // Pick a random direction slightly offset from the target vector to simulate human error
                  const overshootAngleOffset = (Math.random() - 0.5) * 0.15; // in radians
                  const targetAngle = Math.atan2(dy, dx) + overshootAngleOffset;
                  phase1TargetX = targetX + Math.cos(targetAngle) * overshootDist;
                  phase1TargetY = targetY + Math.sin(targetAngle) * overshootDist;
                }

                const p1Dx = phase1TargetX - startX;
                const p1Dy = phase1TargetY - startY;
                const p1Distance = Math.hypot(p1Dx, p1Dy);

                // Bezier control points calculation for the main movement phase
                const curveDirection = Math.random() < 0.5 ? 1 : -1;
                const perpendicularX = -p1Dy / p1Distance;
                const perpendicularY = p1Dx / p1Distance;
                const controlOffset = p1Distance * (0.15 + Math.random() * 0.2) * curveDirection;

                const controlX1 = startX + p1Dx * 0.25 + perpendicularX * controlOffset;
                const controlY1 = startY + p1Dy * 0.25 + perpendicularY * controlOffset;
                const controlX2 = startX + p1Dx * 0.75 - perpendicularX * controlOffset;
                const controlY2 = startY + p1Dy * 0.75 - perpendicularY * controlOffset;

                // Duration based on Fitts's law: movement time is logarithmic curve of (distance / size)
                const targetSize = Math.min(targetWidth, targetHeight);
                const ID = Math.log2((2 * p1Distance) / Math.max(10, targetSize) + 1);
                const duration = Math.min(950, Math.max(280, 150 + ID * 80));
                const startTime = performance.now();

                const animatePhase1 = () => {
                  return new Promise((resolve) => {
                    const step = (now) => {
                      const elapsed = now - startTime;
                      const t = Math.min(1, elapsed / duration);

                      // Cubic ease-in-out curve
                      const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

                      // Cubic Bezier formula
                      const u = 1 - easeT;
                      const tt = easeT * easeT;
                      const uu = u * u;
                      const uuu = uu * u;
                      const ttt = tt * easeT;

                      let x = uuu * startX + 3 * uu * easeT * controlX1 + 3 * u * tt * controlX2 + ttt * phase1TargetX;
                      let y = uuu * startY + 3 * uu * easeT * controlY1 + 3 * u * tt * controlY2 + ttt * phase1TargetY;

                      // Micro-jitter for biological movement representation
                      if (t < 0.95) {
                        x += (Math.random() - 0.5) * 0.8;
                        y += (Math.random() - 0.5) * 0.8;
                      }

                      cursor.style.left = `${x}px`;
                      cursor.style.top = `${y}px`;

                      window.__superagent_cursor_x__ = x;
                      window.__superagent_cursor_y__ = y;

                      if (t < 1) {
                        requestAnimationFrame(step);
                      } else {
                        cursor.style.left = `${phase1TargetX}px`;
                        cursor.style.top = `${phase1TargetY}px`;
                        window.__superagent_cursor_x__ = phase1TargetX;
                        window.__superagent_cursor_y__ = phase1TargetY;
                        resolve();
                      }
                    };
                    requestAnimationFrame(step);
                  });
                };

                await animatePhase1();

                // Phase 2: Correction movement if overshoot occurred
                if (shouldOvershoot) {
                  // Wait a tiny moment (human recognition delay of overshoot)
                  await new Promise((r) => setTimeout(r, 60 + Math.random() * 50));

                  const correctionStartTime = performance.now();
                  const correctionDuration = 180 + Math.random() * 80;
                  const cStartX = phase1TargetX;
                  const cStartY = phase1TargetY;

                  await new Promise((resolve) => {
                    const stepCorrection = (now) => {
                      const elapsed = now - correctionStartTime;
                      const t = Math.min(1, elapsed / correctionDuration);
                      const easeT = t * (2 - t); // Quadratic ease-out for correction

                      const x = cStartX + (targetX - cStartX) * easeT;
                      const y = cStartY + (targetY - cStartY) * easeT;

                      cursor.style.left = `${x}px`;
                      cursor.style.top = `${y}px`;

                      window.__superagent_cursor_x__ = x;
                      window.__superagent_cursor_y__ = y;

                      if (t < 1) {
                        requestAnimationFrame(stepCorrection);
                      } else {
                        cursor.style.left = `${targetX}px`;
                        cursor.style.top = `${targetY}px`;
                        window.__superagent_cursor_x__ = targetX;
                        window.__superagent_cursor_y__ = targetY;
                        resolve();
                      }
                    };
                    requestAnimationFrame(stepCorrection);
                  });
                }

                startCursorTremor();
              } catch (e) {
                // Ignore cursor animation errors
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
              const valNum = parseInt(val, 10);
              const tgtNum = parseInt(tgt, 10);

              if (val && !isNaN(valNum) && (!tgt || isNaN(tgtNum))) {
                showBanner(`Waiting for ${valNum}ms...`);
                await new Promise(r => setTimeout(r, valNum));
                return `Waited for ${valNum}ms`;
              }

              if (tgt && !isNaN(tgtNum)) {
                showBanner(`Waiting for ${tgtNum}ms...`);
                await new Promise(r => setTimeout(r, tgtNum));
                return `Waited for ${tgtNum}ms`;
              }

              if (tgt === "page_load" || tgt === "document_load") {
                showBanner("Waiting for page load...");
                const timeout = (val && !isNaN(valNum)) ? valNum : 5000;
                if (document.readyState === "complete") {
                  return "Page loaded";
                }
                const startTime = Date.now();
                await new Promise((resolve, reject) => {
                  const interval = setInterval(() => {
                    if (document.readyState === "complete") {
                      clearInterval(interval);
                      resolve();
                    } else if (Date.now() - startTime > timeout) {
                      clearInterval(interval);
                      reject(new Error("Timeout waiting for page load"));
                    }
                  }, 100);
                });
                return "Page loaded";
              }

              showBanner(`Waiting for selector ${tgt}...`);
              const timeout = (val && !isNaN(valNum)) ? valNum : 5000;
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

            // Resolve target selector or coordinate (with optional fallback selector separated by |)
            const coordMatch = typeof tgt === "string" && tgt.match(/^(\d+),(\d+)(?:\|(.+))?$/);
            let el, clientX, clientY;
            let cursorTarget;

            if (coordMatch) {
              clientX = parseInt(coordMatch[1], 10);
              clientY = parseInt(coordMatch[2], 10);
              const selectorBackup = coordMatch[3];
              
              el = document.elementFromPoint(clientX, clientY);
              
              // Smart fallback: if element is null/body/html and we have a backup selector
              if ((!el || el === document.body || el === document.documentElement) && selectorBackup) {
                const fallbackEl = document.querySelector(selectorBackup);
                if (fallbackEl) {
                  el = fallbackEl;
                  const rect = el.getBoundingClientRect();
                  clientX = rect.left + rect.width / 2;
                  clientY = rect.top + rect.height / 2;
                }
              }
              
              if (!el) {
                el = document.body;
              }
              cursorTarget = { x: clientX, y: clientY };
            } else {
              el = document.querySelector(tgt);
              if (!el) {
                return `Error: Element not found for selector: ${tgt}`;
              }
              const rect = el.getBoundingClientRect();
              clientX = rect.left + rect.width / 2;
              clientY = rect.top + rect.height / 2;
              cursorTarget = el;
            }

            if (act === "click") {
              showBanner(`Clicking element ${tgt}...`);
              // Orange highlight ring before click
              const highlightRing = document.createElement("div");
              const targetRect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              if (targetRect) {
                const pad = 3;
                highlightRing.style.cssText = `position:fixed;left:${targetRect.left-pad}px;top:${targetRect.top-pad}px;width:${targetRect.width+pad*2}px;height:${targetRect.height+pad*2}px;border:3px solid #FF6B35;border-radius:4px;pointer-events:none;z-index:2147483645;box-shadow:0 0 0 2px rgba(255,107,53,0.3);transition:opacity 0.2s;`;
                document.body.appendChild(highlightRing);
                setTimeout(() => {
                  highlightRing.style.opacity = "0";
                  setTimeout(() => highlightRing.remove(), 220);
                }, 420);
              }
              await animateCursorTo(cursorTarget);

              // Small delay to simulate human hover before click
              await new Promise((r) => setTimeout(r, 80));

              // Retrieve cursor element to animate mouse down
              const cursor = document.getElementById("__superagent_cursor__");
              if (cursor) {
                cursor.style.transform = "scale(0.8)";
              }

              // Dispatch human-like mousedown event
              el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX, clientY }));

              // Programmatically focus the element or contenteditable container to ensure caret appears
              if (typeof el.focus === "function") {
                el.focus();
              }
              const editable = el.closest("[contenteditable='true']");
              if (editable && typeof editable.focus === "function") {
                editable.focus();
              }

              // Small delay to simulate mouse button press duration
              await new Promise((r) => setTimeout(r, 60));

              if (cursor) {
                cursor.style.transform = "scale(1.2)";
              }

              // Dispatch mouseup event
              el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX, clientY }));

              // Trigger click event: use native el.click() for native interactive elements, and dispatch event for custom/generic elements
              const isNativeInteractive = el.closest("input, textarea, button, select, a");
              if (isNativeInteractive) {
                el.click();
              } else {
                el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX, clientY }));
              }
              el.dispatchEvent(new Event("change", { bubbles: true }));

              // Final cursor release animation
              if (cursor) {
                setTimeout(() => {
                  cursor.style.transform = "scale(1)";
                  cursor.style.opacity = "0";
                }, 100);
              }

              return `Clicked element ${tgt}`;
            }

            if (act === "hover") {
              showBanner(`Hovering over element ${tgt}...`);
              await animateCursorTo(cursorTarget);
              el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, clientX, clientY }));
              el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX, clientY }));

              window.__superagent_cursor_timeout__ = setTimeout(() => {
                const cursor = document.getElementById("__superagent_cursor__");
                if (cursor) cursor.style.opacity = "0";
              }, 3000);

              return `Hovered over element ${tgt}`;
            }

            if (act === "keypress") {
              showBanner(`Pressing key ${val || "Enter"} on element ${tgt}...`);
              await animateCursorTo(cursorTarget);
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

              window.__superagent_cursor_timeout__ = setTimeout(() => {
                const cursor = document.getElementById("__superagent_cursor__");
                if (cursor) cursor.style.opacity = "0";
              }, 3000);

              return `Pressed key "${key}" on element ${tgt}`;
            }

            if (act === "type") {
              showBanner(`Typing into element ${tgt}...`);
              await animateCursorTo(cursorTarget);
              await typeTextHumanLike(el, val);

              window.__superagent_cursor_timeout__ = setTimeout(() => {
                const cursor = document.getElementById("__superagent_cursor__");
                if (cursor) cursor.style.opacity = "0";
              }, 3000);

              return `Typed "${val}" into element ${tgt}`;
            }

            if (act === "paste") {
              showBanner(`Pasting into element ${tgt}...`);
              await animateCursorTo(cursorTarget);
              await pasteTextInstant(el, val);

              window.__superagent_cursor_timeout__ = setTimeout(() => {
                const cursor = document.getElementById("__superagent_cursor__");
                if (cursor) cursor.style.opacity = "0";
              }, 3000);

              return `Pasted "${val}" into element ${tgt}`;
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
  if (activeChains.has(controlId)) {
    const callback = activeChains.get(controlId);
    callback(result, isError);
    return;
  }
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

// Function to lock the active tab
window.lockCurrentTab = function() {
  if (isTabLocked) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs.length > 0) {
      originalTabId = tabs[0].id;
      originalWindowId = tabs[0].windowId;
      isTabLocked = true;
      console.log(`[TabLock] Locked to tab ID: ${originalTabId} in window ID: ${originalWindowId}`);
    }
  });
};

// Function to unlock the tab
window.unlockTab = function() {
  if (!isTabLocked) return;
  isTabLocked = false;
  originalTabId = null;
  originalWindowId = null;
  console.log(`[TabLock] Tab unlocked`);
};

// Listener to force tab revert back if switched while locked
chrome.tabs.onActivated.addListener((activeInfo) => {
  if (isTabLocked) {
    if (!originalTabId) {
      originalTabId = activeInfo.tabId;
      originalWindowId = activeInfo.windowId;
      console.log(`[TabLock] Lock updated to newly active tab ID: ${originalTabId}`);
      return;
    }
    if (activeInfo.tabId !== originalTabId && activeInfo.windowId === originalWindowId) {
      chrome.tabs.update(originalTabId, { active: true }, () => {
        if (chrome.runtime.lastError) {
          console.error(`[TabLock] Failed to revert tab: ${chrome.runtime.lastError.message}`);
        } else {
          console.log(`[TabLock] Prevented switch to tab ${activeInfo.tabId}, reverted back to ${originalTabId}`);
          
          // Display warning banner inside the tab
          chrome.scripting.executeScript({
            target: { tabId: originalTabId },
            func: () => {
              let warning = document.getElementById("__superagent_tab_lock_warning__");
              if (!warning) {
                warning = document.createElement("div");
                warning.id = "__superagent_tab_lock_warning__";
                warning.style.position = "fixed";
                warning.style.top = "50%";
                warning.style.left = "50%";
                warning.style.transform = "translate(-50%, -50%)";
                warning.style.padding = "12px 24px";
                warning.style.background = "rgba(220, 38, 38, 0.95)";
                warning.style.color = "#ffffff";
                warning.style.border = "1px solid #ffffff";
                warning.style.borderRadius = "6px";
                warning.style.fontFamily = "system-ui, -apple-system, sans-serif";
                warning.style.fontSize = "14px";
                warning.style.fontWeight = "bold";
                warning.style.zIndex = "9999999999";
                warning.style.boxShadow = "0 8px 24px rgba(0,0,0,0.5)";
                warning.style.transition = "opacity 0.4s ease-out";
                warning.textContent = "Tab switching is locked while the AI Agent is running!";
                document.body.appendChild(warning);
              }
              warning.style.opacity = "1";
              if (window.__superagent_tab_lock_timeout__) {
                clearTimeout(window.__superagent_tab_lock_timeout__);
              }
              window.__superagent_tab_lock_timeout__ = setTimeout(() => {
                warning.style.opacity = "0";
                setTimeout(() => {
                  if (warning.parentNode) warning.parentNode.removeChild(warning);
                }, 400);
              }, 2000);
            }
          }).catch(() => {});
        }
      });
    }
  }
});

// Listener to handle locked tab removal
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (isTabLocked && tabId === originalTabId) {
    console.log(`[TabLock] Locked tab was closed, clearing reference`);
    originalTabId = null;
  }
});
