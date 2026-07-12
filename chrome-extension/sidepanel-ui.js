// UI Helpers and DOM rendering functions for Superagent Chrome Extension

// Escape HTML utility
function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Format markdown bold/inline-code/links/lists
function formatMarkdown(text) {
  if (!text) return "";
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

  // Convert raw file paths to clickable links
  html = html.replace(/(?<![("'/=\/\\\[])\b([a-zA-Z0-9_\-\.\/\\\\]+\.(?:ts|js|tsx|jsx|html|css|json|md|py|go|rs|sh|bat|yml|yaml|txt|log|cpp|c|h))\b/g, '<a href="file:///$1" class="text-vscode-bright hover:underline">$1</a>');

  // Support links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-vscode-bright hover:underline">$1</a>');

  // Support list items
  html = html.replace(/^\s*-\s+(.+)$/gm, "<li>$1</li>");

  return html;
}

function parseMarkdownDoc(md) {
  let html = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Headers
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');

  // Checkboxes
  html = html.replace(/^\s*-\s*\[\s*\]\s*(.*$)/gim, '<li class="task-list-item"><input type="checkbox" disabled> $1</li>');
  html = html.replace(/^\s*-\s*\[x\]\s*(.*$)/gim, '<li class="task-list-item"><input type="checkbox" checked disabled> $1</li>');
  html = html.replace(/^\s*-\s*\[\/\]\s*(.*$)/gim, '<li class="task-list-item"><input type="checkbox" disabled style="opacity:0.6"> <span style="color:var(--text-vscode-bright)">◌ $1</span></li>');

  // Lists (remaining bullet points)
  html = html.replace(/^\s*-\s*(?!\[)(.*$)/gim, '<li>$1</li>');
  html = html.replace(/^\s*\*\s*(.*$)/gim, '<li>$1</li>');

  // Group list items
  html = html.replace(/(<li>.*<\/li>)/gim, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/gim, '');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Inline Code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Code blocks
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/gm, '<pre><code class="language-$1">$2</code></pre>');

  // Paragraphs
  const paragraphs = html.split(/\n\n+/);
  html = paragraphs.map(p => {
    const trimmed = p.trim();
    if (trimmed.startsWith('<h') || trimmed.startsWith('<u') || trimmed.startsWith('<li') || trimmed.startsWith('<pre')) {
      return p;
    }
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  return html;
}

function renderDocument(element, markdown, fallback) {
  if (!element) return;
  if (!markdown || markdown.trim() === "") {
    element.innerHTML = `<p class="text-vscode-muted italic">${fallback}</p>`;
    return;
  }
  element.innerHTML = parseMarkdownDoc(markdown);
}

// Show/Hide thinking spinner
function showSpinner(text) {
  const spinnerEl = document.getElementById("processing-indicator");
  const spinnerTextEl = document.getElementById("processing-text");
  if (spinnerEl) spinnerEl.classList.add("active");
  if (spinnerTextEl) spinnerTextEl.textContent = text;
  
  // Disable chat input
  const inputEl = document.getElementById("chat-input");
  if (inputEl) {
    inputEl.disabled = true;
    inputEl.placeholder = "Agent is executing...";
  }

  // Change Send button to Stop button
  const sendBtnEl = document.getElementById("btn-send");
  if (sendBtnEl) {
    sendBtnEl.dataset.state = "stop";
    sendBtnEl.classList.remove("bg-vscode-blue", "hover:bg-vscode-blue-hover");
    sendBtnEl.classList.add("bg-red-error", "hover:bg-[#be533f]");
    sendBtnEl.innerHTML = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>`;
  }
  
  scrollToBottom();
}

function hideSpinner() {
  const spinnerEl = document.getElementById("processing-indicator");
  if (spinnerEl) spinnerEl.classList.remove("active");
  
  // Enable chat input
  const inputEl = document.getElementById("chat-input");
  if (inputEl) {
    inputEl.disabled = false;
    inputEl.placeholder = "Type instructions for Superagent...";
  }

  // Reset Send button to original state
  const sendBtnEl = document.getElementById("btn-send");
  if (sendBtnEl) {
    sendBtnEl.dataset.state = "send";
    sendBtnEl.classList.remove("bg-red-error", "hover:bg-[#be533f]");
    sendBtnEl.classList.add("bg-vscode-blue", "hover:bg-vscode-blue-hover");
    sendBtnEl.innerHTML = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
  }
}

function scrollToBottom(force = false) {
  if (!chatMessages) return;
  const spinnerEl = document.getElementById("processing-indicator");
  const isProcessing = spinnerEl && spinnerEl.classList.contains("active");
  const threshold = isProcessing ? 200 : 60;
  
  const isNearBottom = chatMessages.scrollHeight - chatMessages.clientHeight - chatMessages.scrollTop < threshold;
  if (force || isNearBottom) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function clearChatMessages() {
  if (!chatMessages) return;
  Array.from(chatMessages.childNodes).forEach(node => {
    if (node !== processingIndicator) {
      chatMessages.removeChild(node);
    }
  });
  
  window.lastSerializedTasks = "";
  window.currentTasksCardElement = null;

  // Clear and hide persistent tasks panel
  const persistentPanel = document.getElementById("persistent-tasks-panel");
  if (persistentPanel) {
    persistentPanel.classList.add("hidden");
    const listEl = document.getElementById("persistent-tasks-list");
    if (listEl) listEl.innerHTML = "";
    const agentsSection = document.getElementById("persistent-agents-section");
    if (agentsSection) agentsSection.classList.add("hidden");
    const agentsList = document.getElementById("persistent-agents-list");
    if (agentsList) agentsList.innerHTML = "";
    
    // Reset collapse state
    const content = document.getElementById("persistent-tasks-content");
    const chevron = document.getElementById("persistent-tasks-chevron");
    if (content) content.classList.remove("hidden");
    if (chevron) chevron.textContent = "▼";
  }
}



// Agent Summary modal
function showSummaryModal(role, result) {
  const overlay = document.getElementById("summary-overlay");
  const roleEl = document.getElementById("summary-role");
  const textEl = document.getElementById("summary-text");
  
  if (overlay && roleEl && textEl) {
    roleEl.textContent = role;
    textEl.innerHTML = formatMarkdown(result);
    overlay.classList.add("active");
  }
}

// Mapping raw tool names to clean action verbs
function getToolLabel(toolCall, fallbackDesc) {
  if (!toolCall) return "Ran tool";
  const name = toolCall.name;
  
  switch (name) {
    case "run_command":
      const cmd = (toolCall.args && toolCall.args.CommandLine) || "";
      if (cmd.startsWith("git commit")) return "Committed changes";
      if (cmd.startsWith("git add")) return "Staged files";
      if (cmd.startsWith("git checkout")) return "Switched branch";
      if (cmd.startsWith("npm test") || cmd.startsWith("vitest")) return "Ran tests";
      if (cmd.startsWith("npm run build") || cmd.startsWith("tsc")) return "Built project";
      return "Ran command";
    
    case "replace_file_content":
    case "multi_replace_file_content":
      return "Edited file";
      
    case "write_to_file":
      return "Created file";
      
    case "view_file":
      return "Read file";
      
    case "list_dir":
      return "Explored directory";
      
    case "grep_search":
      return "Searched";
      
    case "invoke_subagent":
      return "Spawned subagent";
      
    case "ask_question":
      return "Asked question";
      
    default:
      return name ? name.replace(/_/g, " ") : "Ran tool";
  }
}

// Extracting key arguments into inline description (e.g. filename, command)
function buildToolDetail(toolCall) {
  if (!toolCall || !toolCall.args) return "";
  const args = toolCall.args;
  
  // Helper to get last 2 segments of a path
  const formatPath = (p) => {
    if (!p) return "";
    const clean = p.replace(/\\/g, "/");
    const parts = clean.split("/");
    if (parts.length > 2) {
      return parts.slice(-2).join("/");
    }
    return parts[parts.length - 1];
  };

  const name = toolCall.name;

  if (name === "run_command") {
    const cmd = args.CommandLine || "";
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  
  if (name === "view_file") {
    const file = formatPath(args.AbsolutePath);
    if (args.StartLine !== undefined && args.EndLine !== undefined) {
      return `${file}:${args.StartLine}-${args.EndLine}`;
    }
    return file;
  }

  if (name === "replace_file_content" || name === "multi_replace_file_content") {
    return formatPath(args.TargetFile);
  }

  if (name === "write_to_file") {
    return formatPath(args.TargetFile);
  }

  if (name === "list_dir") {
    return formatPath(args.DirectoryPath);
  }

  if (name === "grep_search") {
    const query = args.Query || "";
    const cleanQuery = query.length > 25 ? query.slice(0, 22) + "..." : query;
    const path = formatPath(args.SearchPath);
    return `"${cleanQuery}" in ${path}`;
  }

  if (name === "invoke_subagent") {
    let details = [];
    if (args.Subagents && args.Subagents[0]) {
      const sa = args.Subagents[0];
      const role = sa.Role || sa.TypeName || "";
      const prompt = sa.Prompt || "";
      const cleanPrompt = prompt.length > 25 ? prompt.slice(0, 22) + "..." : prompt;
      details.push(`${role} ("${cleanPrompt}")`);
    }
    return details.join(", ");
  }

  if (name === "ask_question") {
    if (args.questions && args.questions[0]) {
      const q = args.questions[0].question || "";
      return q.length > 30 ? q.slice(0, 27) + "..." : q;
    }
    return "";
  }

  if (name === "ask_permission") {
    return `${args.Action || ""}: ${args.Target || ""}`;
  }

  // Fallback for paths
  const filePath = args.TargetFile || args.AbsolutePath || args.DirectoryPath || args.SearchPath;
  if (filePath) {
    return formatPath(filePath);
  }
  
  if (args.Query) {
    return `"${args.Query}"`;
  }
  
  return "";
}

// Build inline suffix for file diff changes or search matches
function buildResultSuffix(toolCall, toolResult) {
  if (!toolCall || !toolResult || toolResult.isError) return "";
  const name = toolCall.name;
  const res = toolResult.result || "";
  
  if (name === "replace_file_content" || name === "multi_replace_file_content") {
    // Count added/removed lines from replacement content
    const rep = toolCall.args.ReplacementContent || "";
    const tar = toolCall.args.TargetContent || "";
    
    const added = rep.split("\n").length;
    const removed = tar.split("\n").length;
    return `+${added} -${removed}`;
  }
  
  if (name === "grep_search" && res) {
    try {
      const parsed = JSON.parse(res);
      if (Array.isArray(parsed)) {
        return parsed.length === 1 ? "1 match" : `${parsed.length} matches`;
      }
    } catch (_) {
      // Fallback matching logic if JSON parsing failed
      const matchCount = (res.match(/LineNumber/g) || []).length;
      if (matchCount > 0) {
        return matchCount === 1 ? "1 match" : `${matchCount} matches`;
      }
    }
  }
  
  return "";
}

// Append inline question bubble directly into chat
function appendInlineQuestion(questionId, question, options, isMultiSelect) {
  hideSpinner();
  currentIsMultiSelect = !!isMultiSelect;
  currentQuestionIsArray = Array.isArray(question);

  const msgDiv = document.createElement("div");
  msgDiv.className = "msg msg-question";
  msgDiv.dataset.questionId = questionId;

  const header = document.createElement("div");
  header.className = "msg-header";
  header.textContent = "DECISION POINT";

  const body = document.createElement("div");
  body.className = "msg-content inline-question-body";

  // Title
  const titleEl = document.createElement("p");
  titleEl.className = "inline-question-title";
  titleEl.textContent = currentQuestionIsArray
    ? "Multiple items requested. Please select options:"
    : (typeof question === "string" ? question : "Choose an option:");
  body.appendChild(titleEl);

  // Options container
  const optsCon = document.createElement("div");
  optsCon.className = "inline-question-options";

  if (currentQuestionIsArray) {
    question.forEach((q, idx) => {
      const qLabel = document.createElement("p");
      qLabel.className = "inline-question-group-label";
      qLabel.textContent = q.question;
      optsCon.appendChild(qLabel);

      const groupDiv = document.createElement("div");
      groupDiv.className = "inline-question-group";
      groupDiv.dataset.questionIdx = idx;
      groupDiv.dataset.isMultiSelect = q.isMultiSelect ? "true" : "false";

      (q.options || []).forEach(opt => {
        const btn = buildOptionBtn(opt, q.isMultiSelect, groupDiv, null);
        groupDiv.appendChild(btn);
      });
      optsCon.appendChild(groupDiv);
    });
  } else if (options && options.length > 0) {
    options.forEach(opt => {
      const btn = buildOptionBtn(opt, isMultiSelect, optsCon, null);
      optsCon.appendChild(btn);
    });
  }
  body.appendChild(optsCon);

  // Custom write-in
  const customWrap = document.createElement("div");
  customWrap.className = "inline-question-custom hidden";
  const customLabel = document.createElement("label");
  customLabel.textContent = "Write-in response:";
  customLabel.className = "inline-question-custom-label";
  const customInput = document.createElement("input");
  customInput.type = "text";
  customInput.className = "inline-question-input";
  customInput.placeholder = "Type your response...";
  customWrap.appendChild(customLabel);
  customWrap.appendChild(customInput);
  body.appendChild(customWrap);

  // Show custom input for freeform (no options)
  if ((!options || options.length === 0) && !currentQuestionIsArray) {
    customWrap.classList.remove("hidden");
  }

  // Wire up Custom... option visibility
  optsCon.querySelectorAll(".inline-option-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const hasCustom = Array.from(optsCon.querySelectorAll(".inline-option-btn.selected"))
        .some(b => b.dataset.value === "Custom...");
      customWrap.classList.toggle("hidden", !hasCustom);
    });
  });

  // Submit button
  const submitBtn = document.createElement("button");
  submitBtn.className = "inline-question-submit";
  submitBtn.textContent = "Submit";
  submitBtn.addEventListener("click", () => submitInlineAnswer(msgDiv, questionId, customInput));

  // Enter key on custom input
  customInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitInlineAnswer(msgDiv, questionId, customInput);
  });

  body.appendChild(submitBtn);
  msgDiv.appendChild(header);
  msgDiv.appendChild(body);

  if (processingIndicator && processingIndicator.parentNode === chatMessages) {
    chatMessages.insertBefore(msgDiv, processingIndicator);
  } else {
    chatMessages.appendChild(msgDiv);
  }
  scrollToBottom();
}

function buildOptionBtn(opt, isMulti, container, _unused) {
  const btn = document.createElement("div");
  btn.className = "inline-option-btn";
  btn.dataset.value = opt;

  const bullet = document.createElement("span");
  bullet.className = isMulti ? "inline-option-check" : "inline-option-radio";
  const label = document.createElement("span");
  label.className = "inline-option-text";
  label.textContent = opt;
  btn.appendChild(bullet);
  btn.appendChild(label);

  btn.addEventListener("click", () => {
    if (isMulti) {
      btn.classList.toggle("selected");
      bullet.textContent = btn.classList.contains("selected") ? "✓" : "";
    } else {
      container.querySelectorAll(".inline-option-btn").forEach(b => {
        b.classList.remove("selected");
        b.querySelector(".inline-option-radio").textContent = "";
      });
      btn.classList.add("selected");
      bullet.textContent = "●";
    }
  });
  return btn;
}

async function submitInlineAnswer(msgDiv, questionId, customInput) {
  let answer = "";

  if (currentQuestionIsArray) {
    const groups = Array.from(msgDiv.querySelectorAll(".inline-question-group"));
    const list = [];
    for (const g of groups) {
      const isMulti = g.dataset.isMultiSelect === "true";
      const sel = Array.from(g.querySelectorAll(".inline-option-btn.selected"));
      if (sel.length === 0) { alert("Please answer all questions."); return; }
      list.push(isMulti
        ? sel.map(b => b.dataset.value).join(", ")
        : sel[0].dataset.value);
    }
    answer = list;
  } else {
    const sel = Array.from(msgDiv.querySelectorAll(".inline-option-btn.selected"));
    if (sel.length > 0) {
      const vals = sel.map(b => b.dataset.value);
      if (vals.includes("Custom...")) {
        const cv = customInput.value.trim();
        if (!cv) { alert("Please type a custom response."); return; }
        answer = [...vals.filter(v => v !== "Custom..."), cv].join(", ");
      } else {
        answer = currentIsMultiSelect ? vals.join(", ") : vals[0];
      }
    } else {
      answer = customInput.value.trim();
      if (!answer) { alert("Please type an answer."); return; }
    }
  }

  try {
    const res = await fetch(`${BASE_URL}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId, answer })
    });
    if (res.ok) {
      // Replace question bubble with compact answered state
      const answerText = Array.isArray(answer) ? answer.join(" / ") : answer;
      const body = msgDiv.querySelector(".inline-question-body");
      body.innerHTML = "";
      const doneEl = document.createElement("span");
      doneEl.className = "inline-question-answered";
      doneEl.textContent = `Answered: ${answerText}`;
      body.appendChild(doneEl);
      msgDiv.classList.add("msg-question-answered");
      pendingQuestionId = null;
    }
  } catch (err) {
    alert("Error submitting answer: " + err.message);
  }
}

// Legacy functions kept for API signature compatibility
function renderQuestion() {}
async function submitAnswer() {}

// Append user or agent message block
function appendMessage(role, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `msg msg-${role}`;

  const header = document.createElement("div");
  header.className = "msg-header";
  header.textContent = role === "user" ? "USER" : (role === "system" ? "SYSTEM" : "SUPERAGENT");

  const content = document.createElement("div");
  content.className = "msg-content";
  
  if (role === "agent") {
    const textSpan = document.createElement("span");
    textSpan.className = "msg-content-text";
    textSpan.textContent = text;
    content.appendChild(textSpan);
  } else {
    const textSpan = document.createElement("span");
    textSpan.className = "msg-content-text";
    textSpan.innerHTML = formatMarkdown(text);
    content.appendChild(textSpan);
  }

  msgDiv.appendChild(header);
  msgDiv.appendChild(content);

  if (processingIndicator && processingIndicator.parentNode === chatMessages) {
    chatMessages.insertBefore(msgDiv, processingIndicator);
  } else {
    chatMessages.appendChild(msgDiv);
  }
  
  scrollToBottom();
  return msgDiv;
}

// Job finish footer: "Finished in Xm Xs" badge + collapsible summary
function appendJobFinishFooter(msgEl, startTime) {
  if (!msgEl) return;

  // Compute elapsed duration
  const elapsed = startTime ? Math.round((Date.now() - startTime) / 1000) : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const durationLabel = mins > 0
    ? `${mins}m ${secs}s`
    : `${secs}s`;

  // Grab the content element (the chat bubble)
  const contentDiv = msgEl.querySelector(".msg-content");

  // Build footer container
  const footer = document.createElement("div");
  footer.className = "job-finish-footer";

  // Hide all tool blocks within this message content by default
  const toolBlocks = msgEl.querySelectorAll(".tool-block");
  toolBlocks.forEach(tb => tb.classList.add("hidden"));

  // Duration badge row (styled with cursor: pointer to indicate toggle function)
  const badgeRow = document.createElement("div");
  badgeRow.className = "job-finish-badge-row";
  badgeRow.style.cursor = "pointer";
  badgeRow.title = "Click to show/hide tools usage";

  const checkIcon = document.createElement("span");
  checkIcon.className = "job-finish-icon";
  checkIcon.textContent = "✓";

  const badge = document.createElement("span");
  badge.className = "job-finish-badge";
  badge.textContent = `Finished in ${durationLabel}`;

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "job-finish-toggle";
  toggleBtn.textContent = "Summary ▴"; // default open (visible)
  toggleBtn.title = "Toggle summary visibility";

  badgeRow.appendChild(checkIcon);
  badgeRow.appendChild(badge);
  badgeRow.appendChild(toggleBtn);

  // Toggle logic for the original chat bubble content
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (contentDiv) {
      const isHidden = contentDiv.classList.contains("hidden");
      contentDiv.classList.toggle("hidden", !isHidden);
      toggleBtn.textContent = isHidden ? "Summary ▴" : "Summary ▾";
    }
  });

  // Clicking finished badge row will toggle the tools usage visibility
  badgeRow.addEventListener("click", () => {
    // If the content div is hidden, expand it first!
    if (contentDiv && contentDiv.classList.contains("hidden")) {
      contentDiv.classList.remove("hidden");
      toggleBtn.textContent = "Summary ▴";
    }
    let anyVisible = false;
    toolBlocks.forEach(tb => {
      if (!tb.classList.contains("hidden")) {
        anyVisible = true;
      }
    });
    toolBlocks.forEach(tb => {
      tb.classList.toggle("hidden", anyVisible);
    });
  });

  footer.appendChild(badgeRow);

  // Inject after the msg content (outside the msg-content div, inside .msg)
  msgEl.appendChild(footer);

  // Directly scroll the message into view smoothly
  setTimeout(() => {
    msgEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 100);
}

function renderSetupRecentWorkspaces(saved) {
  if (!recentWorkspacesContainer || !recentWorkspacesList) return;
  
  if (!saved || saved.length === 0) {
    recentWorkspacesContainer.classList.add("hidden");
    return;
  }
  
  recentWorkspacesList.innerHTML = "";
  saved.forEach(ws => {
    const item = document.createElement("div");
    item.className = "recent-ws-item";
    item.title = ws;
    item.innerHTML = `
      <span class="recent-ws-path">${ws}</span>
      <span class="recent-ws-arrow">➔</span>
    `;
    item.addEventListener("click", () => {
      workspacePathInput.value = ws;
    });
    recentWorkspacesList.appendChild(item);
  });
  recentWorkspacesContainer.classList.remove("hidden");
}

function updateSetupRecentWorkspaces() {
  renderWorkspaceListOnly();
}

// Fetch Server Config
async function fetchServerConfig() {
  try {
    const res = await fetch(`${BASE_URL}/api/config`);
    if (!res.ok) return;
    const data = await res.json();
    if (data) {
      serverPresets = data.presets;
      serverActivePresetId = data.activePresetId;

      // Populate settings fields if they are not active in user focus
      if (data.settings) {
        if (document.activeElement !== settingMaxIterations) {
          settingMaxIterations.value = data.settings.maxIterations ?? 50;
        }
        if (document.activeElement !== settingRpm) {
          settingRpm.value = data.settings.rateLimitRpm ?? 60;
        }
        settingDisableStreaming.checked = !!data.settings.disableStreaming;
        settingConcurrency.value = String(data.settings.concurrencyLimit ?? 0);
      }
      
      // Update presets dropdown for current selected mode
      updatePresetsDropdown();
    }
  } catch (err) {
    console.error("Failed to fetch server config:", err);
  }
}

// Populate standard select helper
function populateStandardSelect(selectId, presets, activePresetId) {
  const selectEl = document.getElementById(selectId);
  if (!selectEl) return;
  
  selectEl.innerHTML = "";
  if (presets.length === 0) {
    selectEl.innerHTML = '<option value="">No presets</option>';
    return;
  }
  
  presets.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    
    // Find model name for this preset
    let modelName = "";
    if (p.models) {
      if (p.models.superagent) {
        modelName = p.models.superagent.model || "";
      } else if (p.models.master) {
        modelName = p.models.master.model || "";
      } else {
        const keys = Object.keys(p.models);
        if (keys.length > 0 && p.models[keys[0]]) {
          modelName = p.models[keys[0]].model || "";
        }
      }
    }
    const displayModel = modelName ? ` (${modelName})` : "";
    opt.textContent = `${p.name}${displayModel}`;
    opt.title = `${p.name}${displayModel} - ${p.description || ""}`;
    if (p.id === activePresetId) {
      opt.selected = true;
    }
    selectEl.appendChild(opt);
  });
}

// Update presets dropdown based on active orchestration mode selection
function updatePresetsDropdown() {
  if (!serverPresets) return;
  const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : "single";
  const presets = serverPresets[mode] || [];
  const activePresetId = serverActivePresetId ? serverActivePresetId[mode] : "";

  modelPresetSelect.innerHTML = "";
  if (presets.length === 0) {
    modelPresetSelect.innerHTML = '<option value="">No presets available</option>';
    return;
  }

  presets.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.id;
    
    // Find model name for this preset
    let modelName = "";
    if (p.models) {
      if (p.models.superagent) {
        modelName = p.models.superagent.model || "";
      } else if (p.models.master) {
        modelName = p.models.master.model || "";
      } else {
        const keys = Object.keys(p.models);
        if (keys.length > 0 && p.models[keys[0]]) {
          modelName = p.models[keys[0]].model || "";
        }
      }
    }
    const displayModel = modelName ? ` (${modelName})` : "";
    opt.textContent = `${p.name}${displayModel}${p.description ? ` - ${p.description}` : ""}`;
    if (p.id === activePresetId) {
      opt.selected = true;
    }
    modelPresetSelect.appendChild(opt);
  });

  // Populate Standard Select dropdowns
  populateStandardSelect("quick-preset-select", presets, activePresetId);
  populateStandardSelect("input-preset-select", presets, activePresetId);

  const metaModelName = document.getElementById("meta-model-name");
  const activePreset = presets.find(p => p.id === activePresetId);
  if (metaModelName && activePreset) {
    let modelName = "";
    if (mode === "single" && activePreset.models && activePreset.models.superagent) {
      modelName = activePreset.models.superagent.model;
    } else if (mode === "multi" && activePreset.models && activePreset.models.master) {
      modelName = activePreset.models.master.model;
    }
    metaModelName.textContent = modelName || "Unknown Model";
  }
}

async function browseWorkspaceFolder() {
  btnBrowse.disabled = true;
  const originalText = btnBrowse.textContent;
  btnBrowse.textContent = "Browsing...";
  try {
    const res = await fetch(`${BASE_URL}/api/browse`);
    const data = await res.json().catch(() => null);
    if (res.ok) {
      if (data && data.success) {
        if (data.path) {
          workspacePathInput.value = data.path;
        }
      } else {
        alert("Error opening folder picker: " + (data?.error || "Unknown error"));
      }
    } else {
      const errMsg = data?.error || res.statusText || "Unknown error";
      alert("Browse error: " + errMsg);
    }
  } catch (err) {
    alert("Failed to connect to browse API. Please make sure the local server is running at " + BASE_URL);
    console.error("Failed to connect to browse API:", err);
  } finally {
    btnBrowse.disabled = false;
    btnBrowse.textContent = originalText;
  }
}

// Render side-by-side diff in result area
function renderDiffInResultArea(toolCall, resultArea) {
  if (!toolCall || !resultArea) return;
  const name = toolCall.name;
  
  if (name === "replace_file_content") {
    const originalText = toolCall.args.TargetContent || "";
    const modifiedText = toolCall.args.ReplacementContent || "";
    renderSplitDiff(originalText, modifiedText, resultArea);
  } else if (name === "multi_replace_file_content") {
    const chunks = toolCall.args.ReplacementChunks || [];
    resultArea.innerHTML = "";
    resultArea.className = "flex flex-col gap-2 w-full";
    resultArea.classList.remove("hidden");
    
    chunks.forEach((chunk, index) => {
      const title = document.createElement("div");
      title.className = "text-[9px] text-vscode-muted font-sans font-semibold mt-1";
      title.textContent = `Chunk #${index + 1} (Lines ${chunk.StartLine}-${chunk.EndLine})`;
      resultArea.appendChild(title);

      const diffContainer = document.createElement("div");
      renderSplitDiff(chunk.TargetContent || "", chunk.ReplacementContent || "", diffContainer);
      resultArea.appendChild(diffContainer);
    });
  }
}

function renderSplitDiff(originalText, modifiedText, container) {
  container.innerHTML = "";
  container.className = "split-diff-container flex gap-2 w-full font-mono text-[10px] overflow-x-auto border border-vscode-dim bg-vscode-editor p-2 rounded-sm";

  const originalLines = originalText.split("\n");
  const modifiedLines = modifiedText.split("\n");

  const leftCol = document.createElement("div");
  leftCol.className = "flex-1 flex flex-col border-r border-vscode-dim pr-2 overflow-x-auto min-w-0";
  
  const rightCol = document.createElement("div");
  rightCol.className = "flex-1 flex flex-col pl-2 overflow-x-auto min-w-0";

  originalLines.forEach(line => {
    const row = document.createElement("div");
    row.className = "diff-line bg-red-error/15 text-red-error border-l-2 border-red-error px-1 truncate select-text";
    row.textContent = "- " + line;
    leftCol.appendChild(row);

    const spacer = document.createElement("div");
    spacer.className = "diff-line text-transparent select-none px-1";
    spacer.textContent = " ";
    rightCol.appendChild(spacer);
  });

  modifiedLines.forEach(line => {
    const spacer = document.createElement("div");
    spacer.className = "diff-line text-transparent select-none px-1";
    spacer.textContent = " ";
    leftCol.appendChild(spacer);

    const row = document.createElement("div");
    row.className = "diff-line bg-green-success/15 text-green-success border-l-2 border-green-success px-1 truncate select-text";
    row.textContent = "+ " + line;
    rightCol.appendChild(row);
  });

  container.appendChild(leftCol);
  container.appendChild(rightCol);
}

// Helper to manage custom dropdown select elements
function initCustomSelect(triggerId, optionsId) {
  const trigger = document.getElementById(triggerId);
  const options = document.getElementById(optionsId);
  if (!trigger || !options) return;

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close other dropdowns
    document.querySelectorAll(".custom-select-options").forEach(opt => {
      if (opt !== options) opt.classList.add("hidden");
    });
    options.classList.toggle("hidden");
  });

  // Hide on click outside
  document.addEventListener("click", () => {
    options.classList.add("hidden");
  });
}

// Populate custom options list
function populateCustomSelect(optionsId, triggerValId, items, selectedId, onSelectChange) {
  const options = document.getElementById(optionsId);
  const triggerVal = document.getElementById(triggerValId);
  if (!options) return;

  options.innerHTML = "";
  if (items.length === 0) {
    options.innerHTML = '<div class="px-2.5 py-1.5 text-[10px] text-vscode-muted italic">No items</div>';
    if (triggerVal) triggerVal.textContent = "None";
    return;
  }

  items.forEach(item => {
    const row = document.createElement("div");
    row.className = "custom-select-row px-2.5 py-1.5 text-[10px] font-mono text-vscode-primary cursor-pointer hover:bg-vscode-hover hover:text-vscode-light truncate flex items-center justify-between";
    row.textContent = item.name;
    
    if (item.id === selectedId) {
      row.classList.add("font-semibold", "text-vscode-bright");
      const check = document.createElement("span");
      check.className = "text-[8px] text-vscode-blue font-bold ml-2";
      check.textContent = "✓";
      row.appendChild(check);
      if (triggerVal) {
        triggerVal.textContent = item.name;
        triggerVal.title = `${item.name} - ${item.description || ""}`;
      }
    }

    row.addEventListener("click", () => {
      onSelectChange(item.id);
      options.classList.add("hidden");
    });

    options.appendChild(row);
  });
}

async function changeActivePreset(selectedId) {
  if (!selectedId) return;

  const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : "single";

  const configUpdate = {
    activePresetId: {
      [mode]: selectedId
    }
  };

  try {
    const res = await fetch(`${BASE_URL}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configUpdate)
    });
    if (res.ok) {
      fetchServerConfig();
    }
  } catch (err) {
    console.error("Failed to update preset:", err);
  }
}

