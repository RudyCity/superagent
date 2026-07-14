// Input redesign module for Superagent Chrome Extension (Slash Commands, Autocomplete, Attachments, Terminal)

const SLASH_COMMANDS = [
  { command: "/help", desc: "Show help listing for all slash commands", usage: "/help" },
  { command: "/clear", desc: "Clear active chat and start a fresh session", usage: "/clear" },
  { command: "/settings", desc: "Open configuration settings panel", usage: "/settings" },
  { command: "/terminal", desc: "Execute a terminal preset", usage: "/terminal <preset_name>" },
  { command: "/goal", desc: "Launch goal agent (interactive, run until done)", usage: "/goal <objective>" },
  { command: "/browser", desc: "Trigger browser helper to visit a webpage", usage: "/browser <url>" },
  { command: "/model", desc: "Manage provider preset overrides", usage: "/model <preset_id>" },
  { command: "/login", desc: "Add or switch provider profiles", usage: "/login" }
];

const TERMINAL_SHORTCUTS = [
  { command: "!npm test", desc: "Run all unit tests in the workspace" },
  { command: "!npm run build", desc: "Compile TypeScript build check" },
  { command: "!git status", desc: "Check git workspace status" },
  { command: "!git diff", desc: "Show diff of current changes" },
  { command: "!npm start", desc: "Start the local application" }
];

let activeSuggestions = [];
let highlightedSuggestionIndex = 0;
let attachedFiles = [];

document.addEventListener("DOMContentLoaded", () => {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) return;

  // Autocomplete triggering on input
  chatInput.addEventListener("input", handleInputChange);

  // Key event capturing for suggestions (high priority capture listener)
  chatInput.addEventListener("keydown", handleSuggestionKeys, true);

  // Initialize Attachment Buttons & Inputs
  initAttachmentHandlers();

  // Initialize Inspect Element Handler
  initInspectHandler();

  // Input Help Button Listener
  const helpBtn = document.getElementById("btn-input-help");
  if (helpBtn) {
    helpBtn.addEventListener("click", displayHelpInfo);
  }
});

// Fuzzy Match Helper
function fuzzyMatch(text, query) {
  query = query.toLowerCase();
  text = text.toLowerCase();
  let queryIdx = 0;
  for (let textIdx = 0; textIdx < text.length; textIdx++) {
    if (text[textIdx] === query[queryIdx]) {
      queryIdx++;
      if (queryIdx === query.length) return true;
    }
  }
  return query.length === 0;
}

// Input Change Handler
function handleInputChange() {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) return;

  const text = chatInput.value;
  const cursorPosition = chatInput.selectionStart;
  const textBeforeCursor = text.slice(0, cursorPosition);
  const words = textBeforeCursor.split(/\s+/);
  const currentWord = words[words.length - 1] || "";

  if (currentWord.startsWith("/")) {
    const query = currentWord.slice(1);
    activeSuggestions = SLASH_COMMANDS.filter(cmd => fuzzyMatch(cmd.command, "/" + query));
    showSuggestions(activeSuggestions);
  } else if (currentWord.startsWith("!")) {
    const query = currentWord.slice(1);
    activeSuggestions = TERMINAL_SHORTCUTS.filter(cmd => fuzzyMatch(cmd.command, "!" + query));
    showSuggestions(activeSuggestions);
  } else {
    hideSuggestions();
  }
}

// Show Autocomplete Suggestions list
function showSuggestions(suggestions) {
  const popover = document.getElementById("suggestions-popover");
  const list = document.getElementById("suggestions-list");
  if (!popover || !list) return;

  if (suggestions.length === 0) {
    hideSuggestions();
    return;
  }

  highlightedSuggestionIndex = 0;
  list.innerHTML = "";
  suggestions.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "suggestion-row flex justify-between items-center px-3 py-2 text-[11px] cursor-pointer hover:bg-vscode-hover border-b border-vscode-dim/30 last:border-0";
    if (idx === 0) row.classList.add("active");

    const left = document.createElement("div");
    left.className = "flex flex-col gap-0.5";
    
    const cmdSpan = document.createElement("span");
    cmdSpan.className = "font-mono font-bold text-vscode-light";
    cmdSpan.textContent = s.command;
    left.appendChild(cmdSpan);

    const descSpan = document.createElement("span");
    descSpan.className = "text-[9.5px] text-vscode-muted";
    descSpan.textContent = s.desc;
    left.appendChild(descSpan);

    row.appendChild(left);

    row.addEventListener("click", () => {
      selectSuggestion(s);
    });

    list.appendChild(row);
  });

  popover.classList.remove("hidden");
}

// Hide Autocomplete Suggestions
function hideSuggestions() {
  const popover = document.getElementById("suggestions-popover");
  if (popover) popover.classList.add("hidden");
  activeSuggestions = [];
}

// Select suggestion and insert into text input
function selectSuggestion(s) {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) return;

  const text = chatInput.value;
  const cursorPosition = chatInput.selectionStart;
  const textBeforeCursor = text.slice(0, cursorPosition);
  const textAfterCursor = text.slice(cursorPosition);
  
  const words = textBeforeCursor.split(/\s+/);
  words[words.length - 1] = s.command;
  
  const newTextBeforeCursor = words.join(" ") + " ";
  chatInput.value = newTextBeforeCursor + textAfterCursor;
  chatInput.focus();
  
  const newCursorPos = newTextBeforeCursor.length;
  chatInput.setSelectionRange(newCursorPos, newCursorPos);
  
  hideSuggestions();
}

// Keyboard navigation and select keys handler
function handleSuggestionKeys(e) {
  const popover = document.getElementById("suggestions-popover");
  if (!popover || popover.classList.contains("hidden")) return;

  const list = document.getElementById("suggestions-list");
  if (!list) return;

  const rows = list.querySelectorAll(".suggestion-row");

  if (e.key === "ArrowDown") {
    e.preventDefault();
    e.stopImmediatePropagation();
    rows[highlightedSuggestionIndex]?.classList.remove("active");
    highlightedSuggestionIndex = (highlightedSuggestionIndex + 1) % rows.length;
    rows[highlightedSuggestionIndex]?.classList.add("active");
    rows[highlightedSuggestionIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    e.stopImmediatePropagation();
    rows[highlightedSuggestionIndex]?.classList.remove("active");
    highlightedSuggestionIndex = (highlightedSuggestionIndex - 1 + rows.length) % rows.length;
    rows[highlightedSuggestionIndex]?.classList.add("active");
    rows[highlightedSuggestionIndex]?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopImmediatePropagation();
    const activeSuggestion = activeSuggestions[highlightedSuggestionIndex];
    if (activeSuggestion) {
      selectSuggestion(activeSuggestion);
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    hideSuggestions();
  }
}

// Initialize File Attachments Handlers
function initAttachmentHandlers() {
  const attachImageBtn = document.getElementById("btn-attach-image");
  const attachImageInput = document.getElementById("attach-image-input");
  const attachDocBtn = document.getElementById("btn-attach-doc");
  const attachDocInput = document.getElementById("attach-doc-input");

  if (attachImageBtn && attachImageInput) {
    attachImageBtn.addEventListener("click", () => attachImageInput.click());
    attachImageInput.addEventListener("change", handleImageUpload);
  }

  if (attachDocBtn && attachDocInput) {
    attachDocBtn.addEventListener("click", () => attachDocInput.click());
    attachDocInput.addEventListener("change", handleDocUpload);
  }
}

// Handle Image attachment upload
function handleImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    const base64Data = evt.target.result.split(",")[1];
    attachedFiles.push({
      name: file.name,
      type: "image",
      content: base64Data,
      mimeType: file.type || "image/png"
    });
    renderAttachmentPreviews();
  };
  reader.readAsDataURL(file);
  e.target.value = "";
}

// Handle Text Document attachment upload
function handleDocUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(evt) {
    attachedFiles.push({
      name: file.name,
      type: "document",
      content: evt.target.result
    });
    renderAttachmentPreviews();
  };
  reader.readAsText(file);
  e.target.value = "";
}

// Render attachment previews
function renderAttachmentPreviews() {
  const container = document.getElementById("attachment-preview-container");
  if (!container) return;

  container.innerHTML = "";
  attachedFiles.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip flex items-center gap-1.5 px-2 py-1 rounded-[2px] bg-vscode-inner border border-vscode-dim max-w-[140px] shrink-0 text-[10px]";

    if (file.type === "image") {
      const img = document.createElement("img");
      img.src = `data:${file.mimeType};base64,${file.content}`;
      img.className = "w-4 h-4 object-cover rounded-[1px]";
      chip.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.textContent = "📄";
      chip.appendChild(icon);
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "font-mono text-vscode-light truncate flex-1";
    nameSpan.textContent = file.name;
    chip.appendChild(nameSpan);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove-attachment hover:text-red-error ml-1 bg-none border-none p-0 cursor-pointer text-vscode-muted";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      attachedFiles.splice(index, 1);
      renderAttachmentPreviews();
    });
    chip.appendChild(removeBtn);

    container.appendChild(chip);
  });
}

// Display Help Info list in Chat Window
function displayHelpInfo() {
  const helpText = `
Available Slash Commands:
- /help: Show this help guide.
- /clear: Start a fresh session.
- /settings: Open configuration settings modal.
- /terminal <preset>: Execute terminal preset.
- /goal <objective>: Launch goal agent.
- /browser <url>: Visit a webpage.
- /model <preset>: Switch preset.
- /login: Switch provider configuration.

Direct Terminal Commands:
- Prefix your prompt with ! to run commands directly in the workspace, e.g., !git status or !npm test.
  `;
  appendMessage("system", helpText.trim());
  scrollToBottom(true);
}

// Override global sendChatMessage function
window.sendChatMessage = async function() {
  const chatInput = document.getElementById("chat-input");
  if (!chatInput) return;

  const text = chatInput.value.trim();
  
  if (!text && attachedFiles.length === 0) return;

  chatInput.value = "";

  // Display user message in chat
  let displayMessageText = text;
  if (attachedFiles.length > 0) {
    const attachedNames = attachedFiles.map(f => `${f.type === "image" ? "🖼️" : "📄"} ${f.name}`).join(", ");
    displayMessageText = text ? `${text}\n\n[Attachments: ${attachedNames}]` : `[Attachments: ${attachedNames}]`;
  }
  appendMessage("user", displayMessageText);
  scrollToBottom(true);
  showSpinner("Thinking...");
  window.isWaitingForAgentStart = true;

  // Intercept slash commands locally
  if (text.startsWith("/")) {
    if (text === "/help") {
      window.isWaitingForAgentStart = false;
      hideSpinner();
      displayHelpInfo();
      attachedFiles = [];
      renderAttachmentPreviews();
      return;
    }
    if (text === "/clear") {
      window.isWaitingForAgentStart = false;
      hideSpinner();
      const btnNewChat = document.getElementById("btn-new-chat");
      if (btnNewChat) {
        btnNewChat.click();
      } else {
        clearChatMessages();
      }
      attachedFiles = [];
      renderAttachmentPreviews();
      return;
    }
    if (text === "/settings") {
      window.isWaitingForAgentStart = false;
      hideSpinner();
      const btnSettings = document.getElementById("btn-header-settings");
      if (btnSettings) btnSettings.click();
      attachedFiles = [];
      renderAttachmentPreviews();
      return;
    }
  }

  // Construct message payload
  let payloadMessage = text;

  // Append documents to the text prompt
  const documents = attachedFiles.filter(f => f.type === "document");
  if (documents.length > 0) {
    let docEmbed = "";
    documents.forEach(doc => {
      docEmbed += `\n\n[Attached Document: ${doc.name}]\n\`\`\`\n${doc.content}\n\`\`\``;
    });
    payloadMessage += docEmbed;
  }

  // Check if we have image attachments
  const images = attachedFiles.filter(f => f.type === "image");
  if (images.length > 0) {
    const parts = [];
    if (payloadMessage) {
      parts.push({ type: "text", text: payloadMessage });
    }
    images.forEach(img => {
      parts.push({
        type: "image",
        image: img.content,
        mimeType: img.mimeType
      });
    });
    payloadMessage = parts;
  }

  // Clear attached files list
  attachedFiles = [];
  renderAttachmentPreviews();

  if (typeof window.lockCurrentTab === "function") {
    window.lockCurrentTab();
  }

  try {
    const baseUrl = typeof BASE_URL !== "undefined" ? BASE_URL : "http://localhost:7888";
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: payloadMessage })
    });
    if (!res.ok) {
      window.isWaitingForAgentStart = false;
      if (typeof window.unlockTab === "function") window.unlockTab();
      const data = await res.json();
      appendMessage("system", "Error: " + data.error);
      hideSpinner();
    }
  } catch (err) {
    window.isWaitingForAgentStart = false;
    if (typeof window.unlockTab === "function") window.unlockTab();
    appendMessage("system", "Error: Failed to deliver prompt.");
    hideSpinner();
  }
};

function initInspectHandler() {
  const inspectBtn = document.getElementById("btn-inspect-element");
  const chatInput = document.getElementById("chat-input");
  if (!inspectBtn || !chatInput) return;

  inspectBtn.addEventListener("click", async () => {
    // Disable button during inspect to prevent double triggers
    inspectBtn.disabled = true;
    inspectBtn.style.opacity = "0.5";

    // Query active tab
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs || tabs.length === 0) {
        inspectBtn.disabled = false;
        inspectBtn.style.opacity = "1";
        return;
      }
      const activeTab = tabs[0];

      try {
        // Execute inspect script
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          func: () => {
            return new Promise((resolve) => {
              const styleId = "__superagent_inspect_style__";
              const tooltipId = "__superagent_inspect_tooltip__";
              const outlineClass = "__superagent_inspect_overlay__";

              // Inject styling
              let style = document.getElementById(styleId);
              if (!style) {
                style = document.createElement("style");
                style.id = styleId;
                style.textContent = `
                  .${outlineClass} {
                    outline: 2px dashed #0a84ff !important;
                    outline-offset: 1px !important;
                    cursor: crosshair !important;
                  }
                `;
                document.head.appendChild(style);
              }

              // Create tooltip
              let tooltip = document.getElementById(tooltipId);
              if (!tooltip) {
                tooltip = document.createElement("div");
                tooltip.id = tooltipId;
                tooltip.style.position = "fixed";
                tooltip.style.zIndex = "10000000000";
                tooltip.style.padding = "6px 10px";
                tooltip.style.background = "rgba(10, 132, 255, 0.95)";
                tooltip.style.color = "#ffffff";
                tooltip.style.borderRadius = "4px";
                tooltip.style.fontFamily = "system-ui, -apple-system, sans-serif";
                tooltip.style.fontSize = "11px";
                tooltip.style.pointerEvents = "none";
                tooltip.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.3)";
                tooltip.style.maxWidth = "280px";
                tooltip.style.wordBreak = "break-all";
                document.body.appendChild(tooltip);
              }

              let currentEl = null;

              function getUniqueSelector(el) {
                if (el.getAttribute("data-testid")) {
                  return `[data-testid="${el.getAttribute("data-testid")}"]`;
                }
                if (el.id) {
                  const id = el.id.trim();
                  if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
                    return `#${id}`;
                  }
                }
                if (el.tagName === "INPUT" && el.name) {
                  return `input[name="${el.name}"]`;
                }
                if (el.tagName === "INPUT" && el.type === "submit") {
                  return `input[type="submit"]`;
                }
                
                const path = [];
                let current = el;
                while (current && current.nodeType === Node.ELEMENT_NODE) {
                  let selector = current.nodeName.toLowerCase();
                  if (current.getAttribute("data-testid")) {
                    selector = `[data-testid="${current.getAttribute("data-testid")}"]`;
                    path.unshift(selector);
                    break;
                  }
                  if (current.id) {
                    const id = current.id.trim();
                    if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
                      path.unshift(`#${id}`);
                      break;
                    }
                  }
                  let classList = current.classList ? Array.from(current.classList).filter(c => !c.startsWith("__superagent")) : [];
                  if (classList.length > 0) {
                    selector += "." + classList.map(c => CSS.escape(c)).join(".");
                  }
                  if (current.parentNode) {
                    let siblings = Array.from(current.parentNode.children).filter(c => c.nodeName === current.nodeName);
                    if (siblings.length > 1) {
                      let index = siblings.indexOf(current) + 1;
                      selector += `:nth-of-type(${index})`;
                    }
                  }
                  path.unshift(selector);
                  current = current.parentNode;
                }
                return path.join(" > ");
              }

              function getElementDescription(el) {
                if (el.placeholder) return `Placeholder: "${el.placeholder}"`;
                if (el.title) return `Title: "${el.title}"`;
                if (el.name) return `Name: "${el.name}"`;
                
                let text = el.innerText || el.textContent;
                if (text) {
                  text = text.trim().replace(/\s+/g, " ");
                  if (text.length > 40) text = text.slice(0, 37) + "...";
                  return `Text: "${text}"`;
                }
                return `Tag: <${el.tagName.toLowerCase()}>`;
              }

              // Build a compact tag label like <button#submit.btn> or <input[type=email]>
              function buildTagLabel(el) {
                const tag = el.tagName.toLowerCase();
                let label = "<" + tag;

                // Append id if present and unique
                if (el.id && el.id.trim()) {
                  label += "#" + el.id.trim();
                }

                // Append up to 2 meaningful classes (skip utility/superagent internal classes)
                const classes = Array.from(el.classList || [])
                  .filter(c => !c.startsWith("__superagent") && c.trim().length > 0)
                  .slice(0, 2);
                if (classes.length > 0) {
                  label += "." + classes.join(".");
                }

                // Append key attribute for inputs/buttons/links
                if (el.type && el.tagName === "INPUT") {
                  label += `[type=${el.type}]`;
                } else if (el.href && el.tagName === "A") {
                  const href = el.getAttribute("href") || "";
                  const short = href.length > 20 ? href.slice(0, 17) + "…" : href;
                  label += `[href="${short}"]`;
                } else if (el.name && !el.id) {
                  label += `[name="${el.name}"]`;
                }

                label += ">";
                return label;
              }

              const onMouseOver = (e) => {
                const el = e.target;
                if (el === tooltip || el.closest(`#${tooltipId}`) || el.tagName === "HTML" || el.tagName === "BODY") return;

                if (currentEl !== el) {
                  if (currentEl) {
                    currentEl.classList.remove(outlineClass);
                  }
                  currentEl = el;
                  currentEl.classList.add(outlineClass);
                }

                const tagLabel = buildTagLabel(el);
                const desc = getElementDescription(el);
                tooltip.innerHTML = `<div style="font-weight: bold; margin-bottom: 2px; font-family: monospace;">${tagLabel}</div><div style="opacity: 0.85;">${desc}</div>`;
                
                const padding = 10;
                let left = e.clientX + padding;
                let top = e.clientY + padding;
                
                if (left + tooltip.offsetWidth > window.innerWidth) {
                  left = e.clientX - tooltip.offsetWidth - padding;
                }
                if (top + tooltip.offsetHeight > window.innerHeight) {
                  top = e.clientY - tooltip.offsetHeight - padding;
                }
                
                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${top}px`;
              };

              const onClick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                cleanup();
                if (currentEl) {
                  const tagLabel = buildTagLabel(currentEl);
                  const selector = getUniqueSelector(currentEl);
                  const desc = getElementDescription(currentEl);
                  resolve({ tagLabel, selector, description: desc });
                } else {
                  resolve(null);
                }
              };

              const onKeyDown = (e) => {
                if (e.key === "Escape") {
                  cleanup();
                  resolve(null);
                }
              };

              function cleanup() {
                if (currentEl) {
                  currentEl.classList.remove(outlineClass);
                }
                window.removeEventListener("mouseover", onMouseOver, true);
                window.removeEventListener("click", onClick, true);
                window.removeEventListener("keydown", onKeyDown, true);
                if (tooltip && tooltip.parentNode) {
                  tooltip.parentNode.removeChild(tooltip);
                }
                if (style && style.parentNode) {
                  style.parentNode.removeChild(style);
                }
              }

              window.addEventListener("mouseover", onMouseOver, true);
              window.addEventListener("click", onClick, true);
              window.addEventListener("keydown", onKeyDown, true);
            });
          }
        }, (results) => {
          inspectBtn.disabled = false;
          inspectBtn.style.opacity = "1";

          if (results && results[0] && results[0].result) {
            const { tagLabel, selector, description } = results[0].result;
            if (tagLabel) {
              // Build the insert label: tag label + selector + description for full AI context.
              // Example: <button#submit> (selector: #submit, Text: "Login")
              const parts = [];
              if (selector && selector !== tagLabel) parts.push(`selector: ${selector}`);
              if (description) parts.push(description);

              const insertLabel = parts.length > 0
                ? `${tagLabel} (${parts.join(", ")})`
                : tagLabel;

              const startPos = chatInput.selectionStart;
              const endPos = chatInput.selectionEnd;
              const originalText = chatInput.value;
              
              const needsSpace = startPos > 0 && !originalText.substring(0, startPos).endsWith(" ");
              const insertText = (needsSpace ? " " : "") + insertLabel;

              chatInput.value = originalText.substring(0, startPos) +
                               insertText +
                               originalText.substring(endPos);
              
              const newPos = startPos + insertText.length;
              chatInput.focus();
              chatInput.setSelectionRange(newPos, newPos);
            }
          }
        });
      } catch (err) {
        inspectBtn.disabled = false;
        inspectBtn.style.opacity = "1";
      }
    });
  });
}
