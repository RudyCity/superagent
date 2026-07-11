const BASE_URL = "http://localhost:7888";
const MAX_SAVED_WORKSPACES = 10;

let eventSource = null;
let currentAgentMessageElement = null;
let currentReasoningElement = null;
let currentActiveToolElement = null;
let taskPollInterval = null;

let pendingPermissionId = null;
let pendingQuestionId = null;
let selectedQuestionOption = null;
let currentIsMultiSelect = false;
let currentQuestionIsArray = false;
let apiToken = "";
let currentMode = "single";
let workspaceDropdownOpen = false;

// Config state
let serverPresets = null;
let serverActivePresetId = null;
let advancedSettingsOpen = false;
let wasOffline = true;

// Local fetch wrapper to append API token and active workspace path
const originalFetch = window.fetch;
const fetch = async (url, options = {}) => {
  options.headers = options.headers || {};
  if (apiToken) {
    options.headers["Authorization"] = `Bearer ${apiToken}`;
  }
  const activeWorkspaceText = document.getElementById("active-workspace-text");
  const workspacePath = activeWorkspaceText ? activeWorkspaceText.textContent : "";
  if (workspacePath && workspacePath !== "Not Selected") {
    options.headers["X-Workspace-Path"] = workspacePath;
  }
  return originalFetch(url, options);
};

// UI Elements
const statusBadge = document.getElementById("connection-status");
const setupScreen = document.getElementById("setup-screen");
const workspaceScreen = document.getElementById("workspace-screen");

const workspacePathInput = document.getElementById("workspace-path");
const apiTokenInput = document.getElementById("api-token");
const btnInit = document.getElementById("btn-init");
const btnBrowse = document.getElementById("btn-browse");
const recentWorkspacesContainer = document.getElementById("recent-workspaces-container");
const recentWorkspacesList = document.getElementById("recent-workspaces-list");

const activeWorkspaceText = document.getElementById("active-workspace-text");
const activeModeText = document.getElementById("active-mode-text");
const btnAbort = document.getElementById("btn-abort");

const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");
const processingIndicator = document.getElementById("processing-indicator");
const processingText = document.getElementById("processing-text");

const checklistStripItems = document.getElementById("checklist-strip-items");
const agentsStrip = document.getElementById("agents-strip");
const agentsStripItems = document.getElementById("agents-strip-items");

const permissionOverlay = document.getElementById("permission-overlay");
const permissionTool = document.getElementById("permission-tool");
const permissionDesc = document.getElementById("permission-desc");
const btnApproveOnce = document.getElementById("btn-approve-once");
const btnApproveSession = document.getElementById("btn-approve-session");
const btnDenyPermission = document.getElementById("btn-deny-permission");

const questionOverlay = document.getElementById("question-overlay");
const questionTitle = document.getElementById("question-title");
const questionOptionsContainer = document.getElementById("question-options-container");
const questionCustomContainer = document.getElementById("question-custom-container");
const questionCustomInput = document.getElementById("question-custom-input");
const btnSubmitAnswer = document.getElementById("btn-submit-answer");

const btnGrabContext = document.getElementById("btn-grab-context");
const contextBadge = document.getElementById("context-badge");

const btnNewChat = document.getElementById("btn-new-chat");
const btnChatHistory = document.getElementById("btn-chat-history");
const chatHistoryDropdown = document.getElementById("chat-history-dropdown");
const chatHistoryList = document.getElementById("chat-history-list");

const btnSwitchWorkspace = document.getElementById("btn-switch-workspace");
const workspaceDropdown = document.getElementById("workspace-dropdown");
const savedWorkspacesList = document.getElementById("saved-workspaces-list");
const btnNewWorkspace = document.getElementById("btn-new-workspace");

const btnHeaderSettings = document.getElementById("btn-header-settings");
const settingsOverlay = document.getElementById("settings-overlay");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");

// Workspace Tabs Elements
const tabChat = document.getElementById("tab-chat");
const tabPlan = document.getElementById("tab-plan");
const tabTasks = document.getElementById("tab-tasks");
const tabWalkthrough = document.getElementById("tab-walkthrough");

const viewChat = document.getElementById("view-chat");
const viewPlan = document.getElementById("view-plan");
const viewTasks = document.getElementById("view-tasks");
const viewWalkthrough = document.getElementById("view-walkthrough");

const planContent = document.getElementById("plan-content");
const tasksContent = document.getElementById("tasks-content");
const walkthroughContent = document.getElementById("walkthrough-content");

const btnRefreshPlan = document.getElementById("btn-refresh-plan");
const btnRefreshTasks = document.getElementById("btn-refresh-tasks");
const btnRefreshWalkthrough = document.getElementById("btn-refresh-walkthrough");
const modelPresetSelect = document.getElementById("model-preset");
const settingDisableStreaming = document.getElementById("setting-disable-streaming");
const settingConcurrency = document.getElementById("setting-concurrency");
const settingMaxIterations = document.getElementById("setting-max-iterations");
const settingRpm = document.getElementById("setting-rpm");

// Initialize View
document.addEventListener("DOMContentLoaded", () => {
  // Load saved workspace path, API token, and saved workspaces list if any
  chrome.storage.local.get(["lastWorkspacePath", "lastApiToken", "savedWorkspaces"], (result) => {
    if (result.lastWorkspacePath) {
      workspacePathInput.value = result.lastWorkspacePath;
    }
    if (result.lastApiToken) {
      apiTokenInput.value = result.lastApiToken;
      apiToken = result.lastApiToken;
    }
    renderSetupRecentWorkspaces(result.savedWorkspaces || []);
    checkServerStatus();
  });

  setInterval(checkServerStatus, 1000);


  // Buttons Event Listeners
  btnInit.addEventListener("click", initSession);
  btnBrowse.addEventListener("click", browseWorkspaceFolder);
  btnSend.addEventListener("click", () => {
    if (btnSend.dataset.state === "stop") {
      abortExecution();
    } else {
      sendChatMessage();
    }
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (btnSend.dataset.state !== "stop") {
        sendChatMessage();
      }
    }
  });

  btnAbort.addEventListener("click", abortExecution);
  btnApproveOnce.addEventListener("click", () => resolvePermission(true));
  btnApproveSession.addEventListener("click", () => resolvePermission("session"));
  btnDenyPermission.addEventListener("click", () => resolvePermission(false));
  btnSubmitAnswer.addEventListener("click", submitAnswer);
  btnGrabContext.addEventListener("click", grabTabContext);
 
  // Summary modal listeners
  const btnCloseSummary = document.getElementById("btn-close-summary");
  const btnDismissSummary = document.getElementById("btn-dismiss-summary");
  const summaryOverlay = document.getElementById("summary-overlay");

  if (btnCloseSummary) {
    btnCloseSummary.addEventListener("click", () => {
      summaryOverlay.classList.remove("active");
    });
  }
  if (btnDismissSummary) {
    btnDismissSummary.addEventListener("click", () => {
      summaryOverlay.classList.remove("active");
    });
  }


  // Workspace switcher
  btnSwitchWorkspace.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWorkspaceDropdown();
  });

  btnNewWorkspace.addEventListener("click", () => {
    hideWorkspaceDropdown();
    goToSetupScreen();
  });

  if (btnNewChat) {
    btnNewChat.addEventListener("click", startNewChatSession);
  }

  if (btnChatHistory) {
    btnChatHistory.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleChatHistoryDropdown();
    });
  }

  document.addEventListener("click", () => {
    hideWorkspaceDropdown();
    hideChatHistoryDropdown();
  });

  // Settings Modal Toggle
  if (btnHeaderSettings) {
    btnHeaderSettings.addEventListener("click", (e) => {
      e.stopPropagation();
      settingsOverlay.classList.add("active");
    });
  }

  if (btnCloseSettings) {
    btnCloseSettings.addEventListener("click", () => {
      settingsOverlay.classList.remove("active");
    });
  }

  if (btnSaveSettings) {
    btnSaveSettings.addEventListener("click", async () => {
      const selectedPresetId = modelPresetSelect.value;
      const maxIterations = parseInt(settingMaxIterations.value, 10) || 50;
      const rateLimitRpm = parseInt(settingRpm.value, 10) || 60;
      const disableStreaming = settingDisableStreaming.checked;
      const concurrencyLimit = parseInt(settingConcurrency.value, 10) || 0;

      const configUpdate = {
        settings: {
          maxIterations,
          rateLimitRpm,
          disableStreaming,
          concurrencyLimit
        }
      };
      
      const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
      const mode = modeRadio ? modeRadio.value : "single";
      const activeMode = currentMode || mode;

      if (selectedPresetId) {
        configUpdate.activePresetId = {
          [activeMode]: selectedPresetId
        };
      }
      
      try {
        btnSaveSettings.disabled = true;
        btnSaveSettings.textContent = "Saving...";
        const res = await fetch(`${BASE_URL}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(configUpdate)
        });
        if (res.ok) {
          settingsOverlay.classList.remove("active");
          // Refresh configuration locally
          fetchServerConfig();
        } else {
          alert("Failed to save settings to server.");
        }
      } catch (err) {
        alert("Failed to save settings: " + err.message);
      } finally {
        btnSaveSettings.disabled = false;
        btnSaveSettings.textContent = "Save & Apply";
      }
    });
  }

  // Orchestration Mode Radio Change
  document.querySelectorAll('input[name="agent-mode"]').forEach(radio => {
    radio.addEventListener("change", updatePresetsDropdown);
  });

  // Tab Navigation Listeners
  if (tabChat) tabChat.addEventListener("click", () => switchTab("chat"));
  if (tabPlan) tabPlan.addEventListener("click", () => switchTab("plan"));
  if (tabTasks) tabTasks.addEventListener("click", () => switchTab("tasks"));
  if (tabWalkthrough) tabWalkthrough.addEventListener("click", () => switchTab("walkthrough"));

  // Document Refresh Listeners
  if (btnRefreshPlan) btnRefreshPlan.addEventListener("click", loadDocuments);
  if (btnRefreshTasks) btnRefreshTasks.addEventListener("click", loadDocuments);
  if (btnRefreshWalkthrough) btnRefreshWalkthrough.addEventListener("click", loadDocuments);
});

// Check Server Status
async function checkServerStatus() {
  try {
    const res = await fetch(`${BASE_URL}/api/status`);
    const data = await res.json();
    if (data.status === "online") {
      if (wasOffline) {
        wasOffline = false;
        fetchServerConfig();
      }

      if (data.agentRunning) {
        statusBadge.textContent = "Running";
        statusBadge.className = "status-badge status-running";
      } else {
        statusBadge.textContent = "Online";
        statusBadge.className = "status-badge status-online";
      }


      // Auto reconnect view if server is running session
      if (data.sessionId && workspaceScreen.className.indexOf("active") === -1) {
        activeWorkspaceText.textContent = data.workspace;
        activeModeText.textContent = data.mode;
        setupScreen.classList.remove("active");
        workspaceScreen.classList.add("active");
        setupSSE();
        startPolling();
        await loadChatHistory();
      }

      // Handle CLI session mode toggle
      const cliBanner = document.getElementById("cli-mode-banner");
      if (data.isCliSession) {
        if (cliBanner) cliBanner.classList.remove("hidden");
        if (workspaceScreen) workspaceScreen.classList.add("cli-active");
      } else {
        if (cliBanner) cliBanner.classList.add("hidden");
        if (workspaceScreen) workspaceScreen.classList.remove("cli-active");
      }
    }
  } catch {
    wasOffline = true;
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-offline";

    if (workspaceScreen.classList.contains("active")) {
      workspaceScreen.classList.remove("active");
      setupScreen.classList.add("active");
      stopPolling();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }
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

// Initialize Session
async function initSession() {
  const workspace = workspacePathInput.value.trim();
  const mode = document.querySelector('input[name="agent-mode"]:checked').value;
  const resume = document.getElementById("resume-session").checked;
  const token = apiTokenInput.value.trim();

  if (!workspace) {
    alert("Please provide a valid workspace path.");
    return;
  }

  apiToken = token;

  // Save workspace path and token locally
  chrome.storage.local.set({ lastWorkspacePath: workspace, lastApiToken: token });

  btnInit.disabled = true;
  btnInit.textContent = "LAUNCHING...";

  try {
    // Save settings and preset first!
    const selectedPresetId = modelPresetSelect.value;
    const maxIterations = parseInt(settingMaxIterations.value, 10) || 50;
    const rateLimitRpm = parseInt(settingRpm.value, 10) || 60;
    const disableStreaming = settingDisableStreaming.checked;
    const concurrencyLimit = parseInt(settingConcurrency.value, 10) || 0;

    const configUpdate = {
      settings: {
        maxIterations,
        rateLimitRpm,
        disableStreaming,
        concurrencyLimit
      }
    };
    if (selectedPresetId) {
      configUpdate.activePresetId = {
        [mode]: selectedPresetId
      };
    }
    
    await fetch(`${BASE_URL}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configUpdate)
    });

    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, workspace, resume })
    });
    const data = await res.json();

    if (data.success) {
      activeWorkspaceText.textContent = workspace;
      activeModeText.textContent = mode;
      currentMode = mode;

      await saveWorkspace(workspace);
      
      setupScreen.classList.remove("active");
      workspaceScreen.classList.add("active");
      
      clearChatMessages();
      await loadChatHistory();
      
      setupSSE();
      startPolling();
    } else {
      alert("Error initializing session: " + data.error);
    }
  } catch (err) {
    alert("Failed to connect to local server: " + err.message);
  } finally {
    btnInit.disabled = false;
    btnInit.textContent = "LAUNCHING SESSION";
  }
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
    opt.textContent = `${p.name} - ${p.description || ""}`;
    if (p.id === activePresetId) {
      opt.selected = true;
    }
    modelPresetSelect.appendChild(opt);
  });
}

// Setup EventSource (SSE)
function setupSSE() {
  if (eventSource) {
    eventSource.close();
  }

  const sseUrl = apiToken 
    ? `${BASE_URL}/api/events?token=${encodeURIComponent(apiToken)}` 
    : `${BASE_URL}/api/events`;

  eventSource = new EventSource(sseUrl);

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSSEEvent(data);
    } catch (err) {
      console.error("[SSE Error]", err);
    }
  };

  eventSource.onerror = (err) => {
    console.error("[SSE Connection Error]", err);
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-offline";
  };
}

// Handle Incoming SSE Events
function handleSSEEvent(data) {
  if (data.type === "agent_event") {
    const e = data.event;
    switch (e.type) {
      case "text":
        hideSpinner();
        if (!currentAgentMessageElement) {
          currentAgentMessageElement = appendMessage("agent", "");
        }
        // Append text chunk
        const contentSpan = currentAgentMessageElement.querySelector(".msg-content-text") || currentAgentMessageElement.querySelector(".msg-content");
        contentSpan.textContent += e.content;
        scrollToBottom();
        break;

      case "reasoning":
        hideSpinner();
        if (!currentAgentMessageElement) {
          currentAgentMessageElement = appendMessage("agent", "");
        }
        let reasoningDiv = currentAgentMessageElement.querySelector(".reasoning-block");
        if (!reasoningDiv) {
          reasoningDiv = document.createElement("div");
          reasoningDiv.className = "reasoning-block";
          const label = document.createElement("div");
          label.className = "msg-header";
          label.textContent = "Reasoning";
          reasoningDiv.appendChild(label);
          
          const textSpan = document.createElement("span");
          textSpan.className = "reasoning-text";
          reasoningDiv.appendChild(textSpan);
          
          const contentDiv = currentAgentMessageElement.querySelector(".msg-content");
          contentDiv.insertBefore(reasoningDiv, contentDiv.firstChild);
        }
        const reasoningSpan = reasoningDiv.querySelector(".reasoning-text");
        reasoningSpan.textContent += e.content;
        scrollToBottom();
        break;

      case "tool_start":
        showSpinner(`Executing: ${e.description}`);
        if (!currentAgentMessageElement) {
          currentAgentMessageElement = appendMessage("agent", "");
        }

        currentActiveToolElement = document.createElement("div");
        currentActiveToolElement.className = "tool-block";

        // Format args as preview — ToolCall.args is the correct field
        let argsText = "";
        try {
          const args = e.toolCall.args || {};
          const argsStr = JSON.stringify(args, null, 2);
          argsText = argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr;
        } catch (_) {}

        currentActiveToolElement.innerHTML = `
          <div class="tool-header">
            <span class="tool-indicator tool-running">•</span>
            <span class="tool-name">${e.toolCall?.name ?? "tool"}</span>
            <span class="tool-desc">${e.description ?? ""}</span>
          </div>
          <div class="tool-detail hidden">
            ${argsText ? `<pre class="tool-args">${argsText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>` : ""}
            <div class="tool-result-area hidden"></div>
          </div>
        `;

        // Toggle expand/collapse on header click
        const toolBlock = currentActiveToolElement;
        toolBlock.querySelector(".tool-header").addEventListener("click", () => {
          const detail = toolBlock.querySelector(".tool-detail");
          detail.classList.toggle("hidden");
        });

        currentAgentMessageElement.querySelector(".msg-content").appendChild(currentActiveToolElement);
        scrollToBottom();
        break;

      case "tool_end":
        hideSpinner();
        if (currentActiveToolElement) {
          const indicator = currentActiveToolElement.querySelector(".tool-indicator");
          const isErr = e.toolResult && e.toolResult.isError;
          indicator.className = isErr ? "tool-indicator tool-error" : "tool-indicator tool-success";

          // Render result — ToolResult.result is the correct field (string)
          const resultArea = currentActiveToolElement.querySelector(".tool-result-area");
          if (resultArea && e.toolResult) {
            const resultText = e.toolResult.result || "";
            if (resultText) {
              const preview = resultText.length > 600 ? resultText.slice(0, 600) + "\n... (truncated)" : resultText;
              resultArea.textContent = preview;
              resultArea.classList.remove("hidden");
              if (isErr) resultArea.classList.add("tool-result-error");
              // Auto-expand to show result
              const detail = currentActiveToolElement.querySelector(".tool-detail");
              detail.classList.remove("hidden");
            }
          }

          currentActiveToolElement = null;
        }
        break;

      case "system":
        hideSpinner();
        appendMessage("system", e.content);
        break;

      case "error":
        hideSpinner();
        appendMessage("system", `Error: ${e.message}`);
        break;

      case "done":
        hideSpinner();
        if (currentAgentMessageElement) {
          const contentSpan = currentAgentMessageElement.querySelector(".msg-content-text");
          if (contentSpan) {
            contentSpan.innerHTML = formatMarkdown(contentSpan.textContent);
          }
        }
        currentAgentMessageElement = null;
        currentReasoningElement = null;
        currentActiveToolElement = null;
        break;
        
      case "token_usage":
        // Optionally update token indicators
        break;
    }
  }

  // Handle Active Tool Progress (Streaming Output)
  else if (data.type === "tool_progress") {
    if (currentActiveToolElement) {
      const resultArea = currentActiveToolElement.querySelector(".tool-result-area");
      const detail = currentActiveToolElement.querySelector(".tool-detail");
      if (resultArea) {
        // Show last 600 characters of streaming text to keep display readable
        const preview = data.content.length > 600 
          ? data.content.slice(data.content.length - 600) + "\n... (streaming)" 
          : data.content;
        resultArea.textContent = preview;
        resultArea.classList.remove("hidden");
        // Auto-expand tool block to show streaming progress
        if (detail && detail.classList.contains("hidden")) {
          detail.classList.remove("hidden");
        }
      }
      scrollToBottom();
    }
  }

  // Handle Permission Request
  else if (data.type === "permission_required") {
    pendingPermissionId = data.permissionId;
    permissionTool.textContent = data.toolCall.name;
    permissionDesc.textContent = data.description;
    permissionOverlay.classList.add("active");
  }

  // Handle Question Request
  else if (data.type === "question_required") {
    pendingQuestionId = data.questionId;
    renderQuestion(data.question, data.options, data.isMultiSelect);
    questionOverlay.classList.add("active");
  }

  // Handle Browser Control Request
  else if (data.type === "browser_control_required") {
    executeBrowserControl(data.controlId, data.action, data.target, data.value);
  }
}

// Render Question Form
function renderQuestion(question, options, isMultiSelect) {
  questionOptionsContainer.innerHTML = "";
  questionCustomContainer.classList.add("hidden");
  questionCustomInput.value = "";
  selectedQuestionOption = null;
  currentIsMultiSelect = !!isMultiSelect;
  currentQuestionIsArray = Array.isArray(question);

  if (currentQuestionIsArray) {
    // Multi-question item format
    questionTitle.textContent = "Multiple items requested. Please select options:";
    question.forEach((q, idx) => {
      const qLabel = document.createElement("p");
      qLabel.className = "modal-label mt-2 text-[10px] text-vscode-muted uppercase";
      qLabel.textContent = q.question;
      questionOptionsContainer.appendChild(qLabel);

      const groupDiv = document.createElement("div");
      groupDiv.className = "flex flex-col gap-1.5";
      groupDiv.dataset.questionIdx = idx;
      groupDiv.dataset.isMultiSelect = q.isMultiSelect ? "true" : "false";

      const qOptions = q.options || [];
      qOptions.forEach(opt => {
        const btn = document.createElement("div");
        btn.className = "option-btn";
        btn.innerHTML = `
          <div class="option-bullet ${q.isMultiSelect ? 'checkbox-bullet' : ''}"></div>
          <span class="option-text">${opt}</span>
        `;
        btn.addEventListener("click", () => {
          if (q.isMultiSelect) {
            btn.classList.toggle("selected");
          } else {
            groupDiv.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
          }
        });
        groupDiv.appendChild(btn);
      });
      questionOptionsContainer.appendChild(groupDiv);
    });
  } else {
    questionTitle.textContent = question;
    const hasOptions = options && options.length > 0;
    
    if (hasOptions) {
      options.forEach(opt => {
        const btn = document.createElement("div");
        btn.className = "option-btn";
        btn.innerHTML = `
          <div class="option-bullet ${currentIsMultiSelect ? 'checkbox-bullet' : ''}"></div>
          <span class="option-text">${opt}</span>
        `;
        btn.addEventListener("click", () => {
          if (currentIsMultiSelect) {
            btn.classList.toggle("selected");
            const hasCustom = Array.from(questionOptionsContainer.querySelectorAll(".option-btn.selected"))
              .some(b => b.querySelector(".option-text").textContent === "Custom...");
            if (hasCustom) {
              questionCustomContainer.classList.remove("hidden");
            } else {
              questionCustomContainer.classList.add("hidden");
            }
          } else {
            document.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
            btn.classList.add("selected");
            selectedQuestionOption = opt;
            if (opt === "Custom...") {
              questionCustomContainer.classList.remove("hidden");
            } else {
              questionCustomContainer.classList.add("hidden");
            }
          }
        });
        questionOptionsContainer.appendChild(btn);
      });
    } else {
      // Freeform text entry
      questionCustomContainer.classList.remove("hidden");
    }
  }
}

// Submit interactive answer
async function submitAnswer() {
  let answer = "";

  if (currentQuestionIsArray) {
    const groups = Array.from(questionOptionsContainer.querySelectorAll("[data-question-idx]"));
    const answersList = [];
    
    for (const group of groups) {
      const isMulti = group.dataset.isMultiSelect === "true";
      const selected = Array.from(group.querySelectorAll(".option-btn.selected"));
      
      if (selected.length === 0) {
        alert("Please answer all questions before submitting.");
        return;
      }
      
      if (isMulti) {
        const val = selected.map(b => b.querySelector(".option-text").textContent).join(", ");
        answersList.push(val);
      } else {
        const val = selected[0].querySelector(".option-text").textContent;
        answersList.push(val);
      }
    }
    answer = answersList;
  } else {
    const selectedBtns = Array.from(questionOptionsContainer.querySelectorAll(".option-btn.selected"));
    
    if (selectedBtns.length > 0) {
      if (currentIsMultiSelect) {
        const hasCustom = selectedBtns.some(b => b.querySelector(".option-text").textContent === "Custom...");
        if (hasCustom) {
          const customVal = questionCustomInput.value.trim();
          if (!customVal) {
            alert("Please type a custom response.");
            return;
          }
          const otherVals = selectedBtns
            .map(b => b.querySelector(".option-text").textContent)
            .filter(v => v !== "Custom...");
          otherVals.push(customVal);
          answer = otherVals.join(", ");
        } else {
          answer = selectedBtns.map(b => b.querySelector(".option-text").textContent).join(", ");
        }
      } else {
        const selVal = selectedBtns[0].querySelector(".option-text").textContent;
        if (selVal === "Custom...") {
          answer = questionCustomInput.value.trim();
          if (!answer) {
            alert("Please type a custom response.");
            return;
          }
        } else {
          answer = selVal;
        }
      }
    } else {
      answer = questionCustomInput.value.trim();
      if (!answer) {
        alert("Please type an answer.");
        return;
      }
    }
  }

  try {
    const res = await fetch(`${BASE_URL}/api/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionId: pendingQuestionId, answer })
    });
    if (res.ok) {
      questionOverlay.classList.remove("active");
      pendingQuestionId = null;
    }
  } catch (err) {
    alert("Error submitting answer: " + err.message);
  }
}

// Resolve Tool Permission
async function resolvePermission(approval) {
  try {
    const res = await fetch(`${BASE_URL}/api/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionId: pendingPermissionId, approval })
    });
    if (res.ok) {
      permissionOverlay.classList.remove("active");
      pendingPermissionId = null;
    }
  } catch (err) {
    alert("Error sending approval: " + err.message);
  }
}

// Send Message
async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  contextBadge.classList.add("hidden");
  appendMessage("user", text);
  scrollToBottom();
  showSpinner("Thinking...");

  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    if (!res.ok) {
      const data = await res.json();
      appendMessage("system", "Error: " + data.error);
      hideSpinner();
    }
  } catch (err) {
    appendMessage("system", "Error: Failed to deliver prompt.");
    hideSpinner();
  }
}

// Abort Execution
async function abortExecution() {
  try {
    await fetch(`${BASE_URL}/api/abort`, { method: "POST" });
    appendMessage("system", "Halt signal sent to Superagent.");
  } catch (err) {
    alert("Failed to send abort command: " + err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// Poll Active Info
function startPolling() {
  stopPolling();
  pollChecklistAndAgents();
  taskPollInterval = setInterval(pollChecklistAndAgents, 2500);
}

function stopPolling() {
  if (taskPollInterval) {
    clearInterval(taskPollInterval);
    taskPollInterval = null;
  }
}

async function pollChecklistAndAgents() {
  // Poll tasks
  try {
    const resTasks = await fetch(`${BASE_URL}/api/tasks`);
    if (resTasks.ok) {
      const data = await resTasks.json();
      renderTasks(data.tasks);
    }
  } catch {}

  // Poll agent hierarchy instances
  try {
    const resInsts = await fetch(`${BASE_URL}/api/instances`);
    if (resInsts.ok) {
      const data = await resInsts.json();
      renderAgentsTree(data.subagents, data.superagents);
    }
  } catch {}
}

// Render task list as compact chip strip
function renderTasks(tasks) {
  if (!tasks || tasks.length === 0) {
    checklistStripItems.innerHTML = '<span class="strip-empty">No active tasks</span>';
    return;
  }

  checklistStripItems.innerHTML = "";
  tasks.forEach(t => {
    const chip = document.createElement("div");
    const statusKey = t.status === "x" ? "done" : t.status === "/" ? "running" : "todo";
    chip.className = `task-chip chip-${statusKey}`;

    let icon = "○";
    if (t.status === "x") icon = "✓";
    else if (t.status === "/") icon = "◌";

    chip.title = t.text;
    chip.innerHTML = `<span class="chip-icon">${icon}</span><span class="chip-text">${t.text}</span>`;
    checklistStripItems.appendChild(chip);
  });
}

// Render agent hierarchy as compact chip strip
function renderAgentsTree(subagents, superagents) {
  const hasAgents = (subagents && subagents.length > 0) || (superagents && superagents.length > 0);
  if (!hasAgents) {
    agentsStrip.classList.add("hidden");
    return;
  }

  agentsStrip.classList.remove("hidden");
  agentsStripItems.innerHTML = "";

  superagents.forEach(sa => {
    const chip = document.createElement("div");
    const isCompleted = sa.status === "completed" || sa.status === "done";
    const statusKey = isCompleted ? "done" : (sa.status === "running" ? "running" : (sa.status === "error" ? "error" : "todo"));
    chip.className = `agent-chip chip-super chip-${statusKey}`;
    chip.title = `Superagent: ${sa.role} (${sa.status})`;
    chip.innerHTML = `<span class="chip-icon">◈</span><span class="chip-text">${sa.role}</span>`;
    
    if (isCompleted && sa.result) {
      chip.addEventListener("click", () => {
        showSummaryModal(`Superagent: ${sa.role}`, sa.result);
      });
    }
    
    agentsStripItems.appendChild(chip);
  });

  subagents.forEach(sub => {
    const chip = document.createElement("div");
    const isCompleted = sub.status === "completed" || sub.status === "done";
    const statusKey = isCompleted ? "done" : (sub.status === "running" ? "running" : (sub.status === "error" ? "error" : "todo"));
    chip.className = `agent-chip chip-sub chip-${statusKey}`;
    chip.title = `Subagent: ${sub.typeName} (${sub.status})`;
    chip.innerHTML = `<span class="chip-icon">◆</span><span class="chip-text">${sub.typeName}</span>`;
    
    if (isCompleted && sub.result) {
      chip.addEventListener("click", () => {
        showSummaryModal(`Subagent: ${sub.typeName}`, sub.result);
      });
    }
    
    agentsStripItems.appendChild(chip);
  });
}

// Chat Helpers
function appendMessage(role, text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `msg msg-${role}`;

  const header = document.createElement("div");
  header.className = "msg-header";
  header.textContent = role === "user" ? "USER" : (role === "system" ? "SYSTEM" : "SUPERAGENT");

  const content = document.createElement("div");
  content.className = "msg-content";
  
  if (role === "agent") {
    // Separate span for text output so reasoning blocks aren't overwritten
    const textSpan = document.createElement("span");
    textSpan.className = "msg-content-text";
    textSpan.textContent = text;
    content.appendChild(textSpan);
  } else {
    // User or System: parse markdown directly
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

function showSpinner(text) {
  processingIndicator.classList.add("active");
  processingText.textContent = text;
  
  // Change Send button to Stop button
  btnSend.dataset.state = "stop";
  btnSend.classList.remove("bg-vscode-blue", "hover:bg-vscode-blue-hover");
  btnSend.classList.add("bg-red-error", "hover:bg-[#be533f]");
  btnSend.innerHTML = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>`;
  
  scrollToBottom();
}

function hideSpinner() {
  processingIndicator.classList.remove("active");
  
  // Reset Send button to original state
  btnSend.dataset.state = "send";
  btnSend.classList.remove("bg-red-error", "hover:bg-[#be533f]");
  btnSend.classList.add("bg-vscode-blue", "hover:bg-vscode-blue-hover");
  btnSend.innerHTML = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-current"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function clearChatMessages() {
  if (!chatMessages) return;
  Array.from(chatMessages.childNodes).forEach(node => {
    if (node !== processingIndicator) {
      chatMessages.removeChild(node);
    }
  });
}

// Fetch and Render Chat History
async function loadChatHistory() {
  try {
    const res = await fetch(`${BASE_URL}/api/history`);
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success && Array.isArray(data.messages)) {
      clearChatMessages();
      renderChatHistory(data.messages);
    }
  } catch (err) {
    console.error("Failed to load chat history:", err);
  }
}

function renderChatHistory(messages) {
  if (!messages || messages.length === 0) {
    appendMessage("system", `System initialized in ${currentMode} mode.`);
    return;
  }

  messages.forEach(msg => {
    if (msg.role === "system") {
      if (msg.content) {
        appendMessage("system", typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
      }
      return;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" 
        ? msg.content 
        : (Array.isArray(msg.content) ? msg.content.map(p => p.text || "").join(" ") : "");
      appendMessage("user", text);
      return;
    }

    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" 
        ? msg.content 
        : (Array.isArray(msg.content) ? msg.content.map(p => p.text || "").join(" ") : "");

      const msgDiv = appendMessage("agent", "");
      const contentDiv = msgDiv.querySelector(".msg-content");
      const textSpan = msgDiv.querySelector(".msg-content-text");

      // 1. Render Reasoning if present
      if (msg.reasoning) {
        const reasoningDiv = document.createElement("div");
        reasoningDiv.className = "reasoning-block";
        
        const label = document.createElement("div");
        label.className = "msg-header";
        label.textContent = "Reasoning";
        reasoningDiv.appendChild(label);
        
        const textSpanReasoning = document.createElement("span");
        textSpanReasoning.className = "reasoning-text";
        textSpanReasoning.textContent = msg.reasoning;
        reasoningDiv.appendChild(textSpanReasoning);
        
        contentDiv.insertBefore(reasoningDiv, contentDiv.firstChild);
      }

      // 2. Render Text Content
      if (textSpan && text) {
        textSpan.innerHTML = formatMarkdown(text);
      }

      // 3. Render Tool Calls & Results
      const toolCalls = msg.toolCalls || [];
      const toolResults = msg.toolResults || [];

      toolCalls.forEach((tc, idx) => {
        const tr = toolResults.find(r => r.toolCallId === tc.id) || toolResults[idx];

        const toolBlock = document.createElement("div");
        toolBlock.className = "tool-block";

        let argsText = "";
        try {
          const args = tc.args || {};
          const argsStr = JSON.stringify(args, null, 2);
          argsText = argsStr.length > 300 ? argsStr.slice(0, 300) + "..." : argsStr;
        } catch (_) {}

        const isCompleted = !!tr;
        const isErr = tr && tr.isError;
        const indicatorClass = isCompleted 
          ? (isErr ? "tool-indicator tool-error" : "tool-indicator tool-success")
          : "tool-indicator tool-running";

        toolBlock.innerHTML = `
          <div class="tool-header">
            <span class="tool-indicator ${indicatorClass}">•</span>
            <span class="tool-name">${tc.name ?? "tool"}</span>
            <span class="tool-desc"></span>
          </div>
          <div class="tool-detail hidden">
            ${argsText ? `<pre class="tool-args">${argsText.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>` : ""}
            <div class="tool-result-area hidden"></div>
          </div>
        `;

        toolBlock.querySelector(".tool-header").addEventListener("click", () => {
          const detail = toolBlock.querySelector(".tool-detail");
          detail.classList.toggle("hidden");
        });

        if (tr) {
          const resultArea = toolBlock.querySelector(".tool-result-area");
          const resultText = tr.result || "";
          if (resultText) {
            const preview = resultText.length > 600 ? resultText.slice(0, 600) + "\n... (truncated)" : resultText;
            resultArea.textContent = preview;
            resultArea.classList.remove("hidden");
            if (isErr) resultArea.classList.add("tool-result-error");
            
            // By default expand completed tool details
            const detail = toolBlock.querySelector(".tool-detail");
            detail.classList.remove("hidden");
          }
        }

        contentDiv.appendChild(toolBlock);
      });
    }

    if (msg.role === "tool" && Array.isArray(msg.toolResults)) {
      // Find the last assistant message element to append tool results if not already rendered
      const msgDivs = chatMessages.querySelectorAll(".msg-agent");
      if (msgDivs.length > 0) {
        const lastMsgDiv = msgDivs[msgDivs.length - 1];
        const contentDiv = lastMsgDiv.querySelector(".msg-content");
        
        msg.toolResults.forEach(tr => {
          // Check if this tool result was already rendered
          const existingBlocks = contentDiv.querySelectorAll(".tool-block");
          let alreadyRendered = false;
          existingBlocks.forEach(block => {
            const nameSpan = block.querySelector(".tool-name");
            if (nameSpan && nameSpan.textContent === tr.name) {
              const resArea = block.querySelector(".tool-result-area");
              if (resArea && resArea.classList.contains("hidden")) {
                alreadyRendered = true;
                const preview = tr.result.length > 600 ? tr.result.slice(0, 600) + "\n... (truncated)" : tr.result;
                resArea.textContent = preview;
                resArea.classList.remove("hidden");
                if (tr.isError) resArea.classList.add("tool-result-error");
                
                const indicator = block.querySelector(".tool-indicator");
                indicator.className = tr.isError ? "tool-indicator tool-error" : "tool-indicator tool-success";
                
                const detail = block.querySelector(".tool-detail");
                detail.classList.remove("hidden");
              }
            }
          });

          if (!alreadyRendered) {
            const toolBlock = document.createElement("div");
            toolBlock.className = "tool-block";
            const indicatorClass = tr.isError ? "tool-indicator tool-error" : "tool-indicator tool-success";

            toolBlock.innerHTML = `
              <div class="tool-header">
                <span class="tool-indicator ${indicatorClass}">•</span>
                <span class="tool-name">${tr.name ?? "tool"}</span>
                <span class="tool-desc"></span>
              </div>
              <div class="tool-detail">
                <div class="tool-result-area">${tr.result.length > 600 ? tr.result.slice(0, 600) + "\n... (truncated)" : tr.result}</div>
              </div>
            `;
            if (tr.isError) {
              toolBlock.querySelector(".tool-result-area").classList.add("tool-result-error");
            }
            
            toolBlock.querySelector(".tool-header").addEventListener("click", () => {
              const detail = toolBlock.querySelector(".tool-detail");
              detail.classList.toggle("hidden");
            });

            contentDiv.appendChild(toolBlock);
          }
        });
      }
    }
  });
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
  chrome.storage.local.get(["savedWorkspaces"], (result) => {
    renderSetupRecentWorkspaces(result.savedWorkspaces || []);
  });
}

// Tab Switching Logic
function switchTab(tabId) {
  const tabs = [tabChat, tabPlan, tabTasks, tabWalkthrough];
  const views = [viewChat, viewPlan, viewTasks, viewWalkthrough];
  
  tabs.forEach(t => { if (t) t.classList.remove("active"); });
  views.forEach(v => { if (v) v.classList.add("hidden"); });
  
  if (tabId === "chat" && tabChat && viewChat) {
    tabChat.classList.add("active");
    viewChat.classList.remove("hidden");
  } else if (tabId === "plan" && tabPlan && viewPlan) {
    tabPlan.classList.add("active");
    viewPlan.classList.remove("hidden");
    loadDocuments();
  } else if (tabId === "tasks" && tabTasks && viewTasks) {
    tabTasks.classList.add("active");
    viewTasks.classList.remove("hidden");
    loadDocuments();
  } else if (tabId === "walkthrough" && tabWalkthrough && viewWalkthrough) {
    tabWalkthrough.classList.add("active");
    viewWalkthrough.classList.remove("hidden");
    loadDocuments();
  }
}

// Document Fetching and Parsing
async function loadDocuments() {
  try {
    const res = await fetch(`${BASE_URL}/api/documents`);
    if (res.ok) {
      const data = await res.json();
      renderDocument(planContent, data.plan, "No implementation plan found.");
      renderDocument(tasksContent, data.tasks, "No task checklist found.");
      renderDocument(walkthroughContent, data.walkthrough, "No walkthrough found.");
    }
  } catch (err) {
    console.error("Error loading documents:", err);
  }
}

function renderDocument(element, markdown, fallback) {
  if (!element) return;
  if (!markdown || markdown.trim() === "") {
    element.innerHTML = `<p class="text-vscode-muted italic">${fallback}</p>`;
    return;
  }
  element.innerHTML = parseMarkdownDoc(markdown);
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

function showSummaryModal(role, result) {
  const overlay = document.getElementById("summary-overlay");
  const roleEl = document.getElementById("summary-role");
  const textEl = document.getElementById("summary-text");
  
  if (overlay && roleEl && textEl) {
    roleEl.textContent = role;
    textEl.textContent = result;
    overlay.classList.add("active");
  }
}

let chatHistoryDropdownOpen = false;

function toggleChatHistoryDropdown() {
  if (chatHistoryDropdown.classList.contains("hidden")) {
    hideWorkspaceDropdown();
    chatHistoryDropdown.classList.remove("hidden");
    chatHistoryDropdownOpen = true;
    loadChatHistorySessions();
  } else {
    hideChatHistoryDropdown();
  }
}

function hideChatHistoryDropdown() {
  chatHistoryDropdown.classList.add("hidden");
  chatHistoryDropdownOpen = false;
}

async function loadChatHistorySessions() {
  chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Loading sessions...</div>';
  try {
    const res = await fetch(`${BASE_URL}/api/history/sessions`);
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success && Array.isArray(data.sessions)) {
      renderChatHistorySessionsList(data.sessions);
    } else {
      chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Failed to load sessions</div>';
    }
  } catch (err) {
    console.error("Failed to fetch chat history sessions:", err);
    chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Error loading sessions</div>';
  }
}

function renderChatHistorySessionsList(sessions) {
  chatHistoryList.innerHTML = "";
  if (sessions.length === 0) {
    chatHistoryList.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">No previous sessions</div>';
    return;
  }

  sessions.forEach(s => {
    const item = document.createElement("div");
    item.className = "history-item px-2.5 py-2 border-b border-vscode-dim cursor-pointer hover:bg-vscode-hover flex flex-col gap-1 transition-colors duration-150";
    
    const formattedDate = new Date(s.lastModified).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    item.innerHTML = `
      <div class="flex justify-between items-center text-[11px] font-medium">
        <span class="history-name text-vscode-light truncate max-w-[170px]" title="${s.displayName}">${escapeHtml(s.displayName)}</span>
        <span class="history-count text-vscode-muted text-[10px] shrink-0">${s.messageCount} msgs</span>
      </div>
      <div class="text-[10px] text-vscode-muted truncate" title="${s.preview}">${escapeHtml(s.preview)}</div>
      <div class="text-[9px] text-vscode-muted/70 text-right mt-0.5">${formattedDate}</div>
    `;

    item.addEventListener("click", () => {
      hideChatHistoryDropdown();
      switchChatSession(s.id);
    });

    chatHistoryList.appendChild(item);
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function switchChatSession(sessionId) {
  const activeWorkspaceText = document.getElementById("active-workspace-text");
  const workspace = activeWorkspaceText ? activeWorkspaceText.textContent : "";
  const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : "single";
  const activeMode = currentMode || mode;

  if (!workspace || workspace === "Not Selected") return;

  chatMessages.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px]">Switching chat session...</div>';

  try {
    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: activeMode,
        workspace: workspace,
        resume: sessionId
      })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success) {
      await checkServerStatus();
    } else {
      alert("Failed to switch chat session");
      await loadChatHistory();
    }
  } catch (err) {
    console.error("Error switching chat session:", err);
    alert("Error connecting to server: " + err.message);
    await loadChatHistory();
  }
}

async function startNewChatSession() {
  const activeWorkspaceText = document.getElementById("active-workspace-text");
  const workspace = activeWorkspaceText ? activeWorkspaceText.textContent : "";
  const modeRadio = document.querySelector('input[name="agent-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : "single";
  const activeMode = currentMode || mode;

  if (!workspace || workspace === "Not Selected") return;

  if (!confirm("Are you sure you want to start a new chat? This will clear the current chat messages and begin a fresh session.")) return;

  try {
    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: activeMode,
        workspace: workspace,
        resume: false
      })
    });
    const data = await res.json().catch(() => null);
    if (res.ok && data && data.success) {
      await checkServerStatus();
      clearChatMessages();
      appendMessage("system", "New chat session started.");
    } else {
      alert("Failed to start new chat");
    }
  } catch (err) {
    console.error("Error starting new chat:", err);
    alert("Error connecting to server: " + err.message);
  }
}



