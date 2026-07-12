const BASE_URL = "http://localhost:7888";
const MAX_SAVED_WORKSPACES = 10;

let eventSource = null;
let currentAgentMessageElement = null;
let currentReasoningElement = null;
let currentActiveToolElement = null;
let taskPollInterval = null;
let agentJobStartTime = null;
let streamStartTime = null;
let streamCharCount = 0;

let pendingPermissionId = null;
let pendingQuestionId = null;
let selectedQuestionOption = null;
let currentIsMultiSelect = false;
let currentQuestionIsArray = false;
let apiToken = "";
let currentMode = "single";
let workspaceDropdownOpen = false;
window.isWaitingForAgentStart = false;

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

const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSend = document.getElementById("btn-send");
const processingIndicator = document.getElementById("processing-indicator");
const processingText = document.getElementById("processing-text");

const chatTasksContainer = document.getElementById("chat-tasks-container");
const chatTasksList = document.getElementById("chat-tasks-list");
const chatAgentsSection = document.getElementById("chat-agents-section");
const chatAgentsList = document.getElementById("chat-agents-list");

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

const planOverlay = document.getElementById("plan-overlay");
const btnApprovePlan = document.getElementById("btn-approve-plan");
const btnRejectPlan = document.getElementById("btn-reject-plan");

const btnGrabContext = document.getElementById("btn-grab-context");
const contextBadge = document.getElementById("context-badge");

const btnNewChat = document.getElementById("btn-new-chat");
const chatHistoryList = document.getElementById("chat-history-list");

const btnSwitchWorkspace = document.getElementById("btn-switch-workspace");
const workspaceDropdown = document.getElementById("workspace-dropdown");
const savedWorkspacesList = document.getElementById("saved-workspaces-list");
const btnNewWorkspace = document.getElementById("btn-new-workspace");

const btnHeaderSettings = document.getElementById("btn-header-settings");
const settingsOverlay = document.getElementById("settings-overlay");
const btnCloseSettings = document.getElementById("btn-close-settings");
const btnSaveSettings = document.getElementById("btn-save-settings");

const tabWorkspace = document.getElementById("tab-workspace");
const tabChat = document.getElementById("tab-chat");
const tabHistory = document.getElementById("tab-history");

const viewWorkspace = document.getElementById("view-workspace");
const viewChat = document.getElementById("view-chat");
const viewHistory = document.getElementById("view-history");

const btnRefreshHistory = document.getElementById("btn-refresh-history-sidebar");
const modelPresetSelect = document.getElementById("model-preset");
const settingDisableStreaming = document.getElementById("setting-disable-streaming");
const settingConcurrency = document.getElementById("setting-concurrency");
const settingMaxIterations = document.getElementById("setting-max-iterations");
const settingRpm = document.getElementById("setting-rpm");

// Initialize View
document.addEventListener("DOMContentLoaded", () => {
  // Sidebar Draggable Resizer Logic
  const leftSidebarElement = document.getElementById("left-sidebar");
  const resizerElement = document.getElementById("sidebar-resizer");

  if (leftSidebarElement && resizerElement) {
    chrome.storage.local.get(["leftSidebarWidth"], (res) => {
      if (res.leftSidebarWidth) {
        leftSidebarElement.style.width = res.leftSidebarWidth + "px";
      }
    });

    let isResizing = false;

    resizerElement.addEventListener("mousedown", () => {
      isResizing = true;
      document.body.classList.add("select-none");
      document.body.style.cursor = "col-resize";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isResizing) return;
      const activityBarWidth = 48;
      const newWidth = Math.max(120, Math.min(380, e.clientX - activityBarWidth));
      leftSidebarElement.style.width = newWidth + "px";
    });

    document.addEventListener("mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.classList.remove("select-none");
        document.body.style.cursor = "";
        const currentWidth = parseInt(leftSidebarElement.style.width, 10);
        if (currentWidth) {
          chrome.storage.local.set({ leftSidebarWidth: currentWidth });
        }
      }
    });
  }

  // Load saved workspace path, API token, and saved workspaces list if any
  chrome.storage.local.get(["lastWorkspacePath", "lastApiToken", "savedWorkspaces"], (result) => {
    if (result.lastWorkspacePath) {
      workspacePathInput.value = result.lastWorkspacePath;
    }
    if (result.lastApiToken) {
      apiTokenInput.value = result.lastApiToken;
      apiToken = result.lastApiToken;
    }
    renderWorkspaceListOnly();
    checkServerStatus();
    if (typeof window.updateWorkspaceRequiredUI === "function") {
      window.updateWorkspaceRequiredUI();
    }
  });

  setInterval(checkServerStatus, 1000);



  // Initialize Preset Select Event Listeners
  const quickPresetSelect = document.getElementById("quick-preset-select");
  if (quickPresetSelect) {
    quickPresetSelect.addEventListener("change", (e) => {
      if (typeof changeActivePreset === "function") {
        changeActivePreset(e.target.value);
      }
    });
  }

  const inputPresetSelect = document.getElementById("input-preset-select");
  if (inputPresetSelect) {
    inputPresetSelect.addEventListener("change", (e) => {
      if (typeof changeActivePreset === "function") {
        changeActivePreset(e.target.value);
      }
    });
  }



  // Buttons Event Listeners
  btnInit.addEventListener("click", launchWelcomeSession);
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

  btnApproveOnce.addEventListener("click", () => resolvePermission(true));
  btnApproveSession.addEventListener("click", () => resolvePermission("session"));
  btnDenyPermission.addEventListener("click", () => resolvePermission(false));
  btnSubmitAnswer.addEventListener("click", submitAnswer);
  btnGrabContext.addEventListener("click", grabTabContext);
  btnApprovePlan.addEventListener("click", () => resolvePlanApproval("approve"));
  btnRejectPlan.addEventListener("click", () => resolvePlanApproval("reject"));

  // Persistent tasks header expand/collapse listener
  const tasksHeader = document.getElementById("persistent-tasks-header");
  if (tasksHeader) {
    tasksHeader.addEventListener("click", () => {
      const content = document.getElementById("persistent-tasks-content");
      const chevron = document.getElementById("persistent-tasks-chevron");
      if (content && chevron) {
        const isHidden = content.classList.contains("hidden");
        content.classList.toggle("hidden", !isHidden);
        chevron.textContent = isHidden ? "▼" : "▶";
      }
    });
  }

  // Global link click interceptor to open local file:// links in default editor via server
  document.addEventListener("click", async (e) => {
    const link = e.target.closest("a");
    if (!link) return;

    const href = link.getAttribute("href");
    if (!href) return;

    if (href.startsWith("file:///")) {
      e.preventDefault();
      let filepath = decodeURIComponent(href.replace("file:///", ""));
      const hasDriveLetter = /^[a-zA-Z]:/.test(filepath);
      if (!hasDriveLetter && !filepath.startsWith("/")) {
        filepath = "/" + filepath;
      }

      try {
        const res = await fetch(`${BASE_URL}/api/workspace/file/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filepath })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error("Failed to open file:", data.error || "Unknown error");
        }
      } catch (err) {
        console.error("Error opening file:", err);
      }
    }
  });

 
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


  // Add Workspace modal listeners
  const btnShowAddWorkspace = document.getElementById("btn-show-add-workspace");
  const btnCloseAddWorkspace = document.getElementById("btn-close-add-workspace");
  const btnCancelAddWorkspace = document.getElementById("btn-cancel-add-workspace");
  const addWorkspaceOverlay = document.getElementById("add-workspace-overlay");

  if (btnShowAddWorkspace && addWorkspaceOverlay) {
    btnShowAddWorkspace.addEventListener("click", () => {
      addWorkspaceOverlay.classList.add("active");
      if (workspacePathInput) workspacePathInput.focus();
    });
  }

  if (btnCloseAddWorkspace && addWorkspaceOverlay) {
    btnCloseAddWorkspace.addEventListener("click", () => {
      addWorkspaceOverlay.classList.remove("active");
    });
  }

  if (btnCancelAddWorkspace && addWorkspaceOverlay) {
    btnCancelAddWorkspace.addEventListener("click", () => {
      addWorkspaceOverlay.classList.remove("active");
    });
  }

  // Workspace Left Sidebar Buttons
  const btnAddWorkspace = document.getElementById("btn-add-workspace");
  if (btnAddWorkspace) {
    btnAddWorkspace.addEventListener("click", () => {
      const workspacePath = workspacePathInput.value.trim();
      if (!workspacePath) {
        alert("Please provide a valid workspace path.");
        return;
      }
      connectToWorkspace(workspacePath);
    });
  }

  if (btnNewChat) {
    btnNewChat.addEventListener("click", startNewChatSession);
  }

  if (workspacePathInput) {
    workspacePathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const workspacePath = workspacePathInput.value.trim();
        if (workspacePath) {
          connectToWorkspace(workspacePath);
        }
      }
    });
  }

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
  if (tabWorkspace) tabWorkspace.addEventListener("click", () => handleSidebarTabClick("workspace"));
  if (tabChat) tabChat.addEventListener("click", () => handleSidebarTabClick("chat"));
  if (tabHistory) tabHistory.addEventListener("click", () => handleSidebarTabClick("history"));

  // Document Refresh Listeners
  if (btnRefreshHistory) btnRefreshHistory.addEventListener("click", loadChatHistorySessions);

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
        
        // Sync spinner and button state if not already in stop/running state
        const sendBtnEl = document.getElementById("btn-send");
        if (sendBtnEl && sendBtnEl.dataset.state !== "stop") {
          showSpinner("Agent is executing...");
        }
      } else {
        statusBadge.textContent = "Online";
        statusBadge.className = "status-badge status-online";
        
        // Reset spinner and button state if it was in stop/running state
        const sendBtnEl = document.getElementById("btn-send");
        if (sendBtnEl && sendBtnEl.dataset.state === "stop" && !window.isWaitingForAgentStart) {
          hideSpinner();
        }
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

      // Show plan approval overlay if server reports agent is in PLANNING_PENDING
      if (data.planState === "PLANNING_PENDING") {
        showPlanOverlay();
      } else if (planOverlay && planOverlay.classList.contains("active") && data.planState !== "PLANNING_PENDING") {
        planOverlay.classList.remove("active");
      }
      
      if (typeof window.updateWorkspaceRequiredUI === "function") {
        window.updateWorkspaceRequiredUI();
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
    
    if (typeof window.updateWorkspaceRequiredUI === "function") {
      window.updateWorkspaceRequiredUI();
    }
  }
}

// [browseWorkspaceFolder moved to sidepanel-ui.js]

// Welcome screen transition (only Mode and API Token)
async function launchWelcomeSession() {
  const mode = document.querySelector('input[name="agent-mode"]:checked').value;
  const token = apiTokenInput.value.trim();
  const resume = document.getElementById("resume-session").checked;

  apiToken = token;
  currentMode = mode;

  // Save settings and token locally
  chrome.storage.local.set({ lastApiToken: token, lastMode: mode, lastResume: resume });

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

    activeWorkspaceText.textContent = "Not Selected";
    activeWorkspaceText.title = "Not Selected";
    activeModeText.textContent = mode;

    await renderWorkspaceListOnly();

    setupScreen.classList.remove("active");
    workspaceScreen.classList.add("active");

    if (typeof window.updateWorkspaceRequiredUI === "function") {
      window.updateWorkspaceRequiredUI();
    }

    clearChatMessages();
    appendMessage("system", "Engine initialized. Please select a workspace from Saved Workspaces below or enter a path above to start your session.");
  } catch (err) {
    alert("Failed to connect to local server: " + err.message);
  } finally {
    btnInit.disabled = false;
    btnInit.textContent = "LAUNCH SESSION";
  }
}

// Connect to a Workspace inside the workspace view
async function connectToWorkspace(workspacePath) {
  if (!workspacePath) return;

  const btnAddWorkspace = document.getElementById("btn-add-workspace");
  if (btnAddWorkspace) {
    btnAddWorkspace.disabled = true;
    btnAddWorkspace.textContent = "CONNECTING...";
  }

  try {
    const resume = document.getElementById("resume-session").checked;
    const mode = currentMode;

    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, workspace: workspacePath, resume })
    });
    const data = await res.json();

    if (data.success) {
      activeWorkspaceText.textContent = workspacePath;
      activeWorkspaceText.title = workspacePath;
      
      // Hide the add workspace modal
      const addWorkspaceOverlay = document.getElementById("add-workspace-overlay");
      if (addWorkspaceOverlay) {
        addWorkspaceOverlay.classList.remove("active");
      }
      if (workspacePathInput) {
        workspacePathInput.value = "";
      }
      
      if (typeof window.updateWorkspaceRequiredUI === "function") {
        window.updateWorkspaceRequiredUI();
      }
      
      // Save new last workspace path
      chrome.storage.local.set({ lastWorkspacePath: workspacePath });
      await saveWorkspace(workspacePath);
      await renderWorkspaceListOnly();

      clearChatMessages();
      await loadChatHistory();
      if (chatMessages.querySelectorAll(".msg").length === 0) {
        appendMessage("system", `Connected to workspace: ${workspacePath}`);
        appendMessage("system", `Mode: ${mode}`);
      }

      stopPolling();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setupSSE();
      startPolling();
    } else {
      alert("Error initializing workspace session: " + data.error);
    }
  } catch (err) {
    alert("Failed to connect to workspace: " + err.message);
  } finally {
    if (btnAddWorkspace) {
      btnAddWorkspace.disabled = false;
      btnAddWorkspace.textContent = "+ Add Workspace";
    }
  }
}

// [fetchServerConfig and updatePresetsDropdown moved to sidepanel-ui.js]

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

// [Tool label/detail helpers moved to sidepanel-ui.js]

// Handle Incoming SSE Events
function handleSSEEvent(data) {
  window.isWaitingForAgentStart = false;
  if (data.type === "agent_event") {
    const e = data.event;
    switch (e.type) {
      case "text":
        if (processingText && processingText.textContent !== "Generating response...") {
          showSpinner("Generating response...");
        }
        if (!agentJobStartTime) agentJobStartTime = Date.now();
        if (!currentAgentMessageElement) {
          currentAgentMessageElement = appendMessage("agent", "");
        }
        // Append text chunk
        const contentSpan = currentAgentMessageElement.querySelector(".msg-content-text") || currentAgentMessageElement.querySelector(".msg-content");
        contentSpan.textContent += e.content;

        if (!streamStartTime) streamStartTime = Date.now();
        streamCharCount += e.content.length;
        const elapsed = (Date.now() - streamStartTime) / 1000;
        if (elapsed > 0.1) {
          const estimatedTokens = streamCharCount / 4;
          const speed = estimatedTokens / elapsed;
          const speedText = document.getElementById("meta-speed-text");
          if (speedText) {
            speedText.textContent = `${speed.toFixed(1)} t/s`;
          }
        }

        scrollToBottom();
        break;

      case "reasoning":
        if (processingText && processingText.textContent !== "Thinking...") {
          showSpinner("Thinking...");
        }
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
        if (!agentJobStartTime) agentJobStartTime = Date.now();
        showSpinner(getToolLabel(e.toolCall, e.description));
        if (!currentAgentMessageElement) {
          currentAgentMessageElement = appendMessage("agent", "");
        }

        currentActiveToolElement = document.createElement("div");
        currentActiveToolElement.className = "tool-block";

        {
          const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

          // Format args as preview for expanded section
          let argsText = "";
          try {
            const args = e.toolCall.args || {};
            const argsStr = JSON.stringify(args, null, 2);
            argsText = argsStr.length > 400 ? argsStr.slice(0, 400) + "..." : argsStr;
          } catch (_) {}

          let argsSummary = "";
          if (e.toolCall.args) {
            const parts = Object.entries(e.toolCall.args).map(([key, val]) => {
              let valStr = typeof val === "object" ? JSON.stringify(val) : String(val);
              if (valStr.length > 30) valStr = valStr.slice(0, 27) + "...";
              return `${key}: ${valStr}`;
            });
            argsSummary = parts.join(", ");
          }

          currentActiveToolElement.innerHTML = `
            <div class="tool-row flex items-center justify-between gap-2 cursor-pointer py-1 px-1.5 rounded bg-vscode-inner hover:bg-vscode-hover border border-vscode-dim select-none">
              <div class="tool-row-left flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
                <span class="tool-row-icon text-vscode-muted text-[10px]">🛠</span>
                <span class="tool-row-name font-mono font-bold text-vscode-bright">${esc(e.toolCall.name)}</span>
                <span class="tool-row-args font-mono text-vscode-muted text-[9px]">(${esc(argsSummary)})</span>
              </div>
              <div class="tool-row-right flex items-center gap-1.5 shrink-0">
                <span class="tool-row-status font-mono text-[9px] text-vscode-blue font-bold">running...</span>
                <span class="tool-row-chevron font-mono text-[9px] text-vscode-muted">⌄</span>
              </div>
            </div>
            <div class="tool-expand hidden">
              ${argsText ? `<pre class="tool-args block p-1.5 bg-vscode-sidebar border border-vscode-dim rounded text-[9.5px] font-mono text-vscode-muted max-h-[120px] overflow-y-auto mt-1">${esc(argsText)}</pre>` : ""}
              <div class="tool-result-area mt-1"></div>
            </div>
          `;

          // Toggle expand on row click
          const tb = currentActiveToolElement;
          tb.querySelector(".tool-row").addEventListener("click", () => {
            const exp = tb.querySelector(".tool-expand");
            const chev = tb.querySelector(".tool-row-chevron");
            const isHidden = exp.classList.contains("hidden");
            exp.classList.toggle("hidden", !isHidden);
            chev.textContent = isHidden ? "⌄" : "›";
          });
        }

        currentAgentMessageElement.querySelector(".msg-content").appendChild(currentActiveToolElement);
        scrollToBottom();
        break;

      case "tool_end":
        if (processingText) {
          processingText.textContent = "Thinking...";
        }
        if (currentActiveToolElement) {
          const isErr = e.toolResult && e.toolResult.isError;
          const statusEl = currentActiveToolElement.querySelector(".tool-row-status");
          
          if (isErr) {
            const label = currentActiveToolElement.querySelector(".tool-row-name");
            if (label) label.classList.add("tool-row-label-error");
            if (statusEl) {
              statusEl.textContent = "✗ failed";
              statusEl.className = "tool-row-status font-mono text-[9px] text-red-error font-bold";
            }
          } else {
            if (statusEl) {
              statusEl.textContent = "✓ done";
              statusEl.className = "tool-row-status font-mono text-[9px] text-green-success font-bold";
            }
          }

          // Inline result suffix (e.g. diff stat for edits)
          const inlineSuffix = buildResultSuffix(e.toolCall, e.toolResult);
          if (inlineSuffix) {
            const rowLabel = currentActiveToolElement.querySelector(".tool-row-left");
            const suffixSpan = document.createElement("span");
            suffixSpan.className = "tool-row-suffix shrink-0 font-mono text-[9px] text-vscode-muted ml-1";
            suffixSpan.textContent = inlineSuffix;
            rowLabel.appendChild(suffixSpan);
          }

          // Populate expanded result area
          const resultArea = currentActiveToolElement.querySelector(".tool-result-area");
          if (resultArea && e.toolResult) {
            const name = e.toolCall ? e.toolCall.name : "";
            if (!isErr && (name === "replace_file_content" || name === "multi_replace_file_content")) {
              renderDiffInResultArea(e.toolCall, resultArea);
            } else {
              const resultText = e.toolResult.result || "";
              if (resultText) {
                if (resultText.length > 500) {
                  resultArea.textContent = resultText.slice(0, 500) + "\n... (truncated)";
                  const expandBtn = document.createElement("button");
                  expandBtn.className = "btn-expand-result";
                  expandBtn.textContent = "Expand Full Result";
                  expandBtn.addEventListener("click", (evt) => {
                    evt.stopPropagation();
                    resultArea.textContent = resultText;
                    expandBtn.remove();
                  });
                  resultArea.appendChild(document.createElement("br"));
                  resultArea.appendChild(expandBtn);
                } else {
                  resultArea.textContent = resultText;
                }
                resultArea.classList.remove("hidden");
                if (isErr) resultArea.classList.add("tool-result-error");
              }
            }
          }

          currentActiveToolElement = null;
        }
        break;

      case "system":
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
            currentAgentMessageElement.dataset.rawMarkdown = contentSpan.textContent;
            contentSpan.innerHTML = formatMarkdown(contentSpan.textContent);
          }
          // Inject "Finished in Xm Xs" badge + summary footer
          appendJobFinishFooter(currentAgentMessageElement, agentJobStartTime);
        }
        currentAgentMessageElement = null;
        currentReasoningElement = null;
        currentActiveToolElement = null;
        agentJobStartTime = null;
        break;
        
      case "token_usage":
        {
          const speedText = document.getElementById("meta-speed-text");
          if (speedText) {
            const completion = e.completionTokens || 0;
            const duration = e.durationMs ? e.durationMs / 1000 : 0;
            if (duration > 0.1) {
              const speed = completion / duration;
              speedText.textContent = `${speed.toFixed(1)} t/s (${completion} t, ${duration.toFixed(1)}s)`;
            } else {
              speedText.textContent = `${completion} t`;
            }
          }
        }
        break;
    }
  }

  // Handle Active Tool Progress (Streaming Output)
  else if (data.type === "tool_progress") {
    if (currentActiveToolElement) {
      const resultArea = currentActiveToolElement.querySelector(".tool-result-area");
      if (resultArea) {
        const preview = data.content.length > 600 
          ? data.content.slice(data.content.length - 600) + "\n... (streaming)" 
          : data.content;
        resultArea.textContent = preview;
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

  // Handle Question Request — inline in chat, no modal
  else if (data.type === "question_required") {
    pendingQuestionId = data.questionId;
    appendInlineQuestion(data.questionId, data.question, data.options, data.isMultiSelect);
  }

  // Handle Plan Approval Required
  else if (data.type === "plan_approval_required") {
    if (data.planState === "PLANNING_PENDING") {
      showPlanOverlay();
    } else {
      // planState is IDLE or APPROVED — hide the overlay if visible
      planOverlay.classList.remove("active");
    }
  }

  // Handle Browser Control Request
  else if (data.type === "browser_control_required") {
    executeBrowserControl(data.controlId, data.action, data.target, data.value);
  }
}

// [Inline question helpers and answer submission moved to sidepanel-ui.js]

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

// Show Plan Approval Overlay
function showPlanOverlay() {
  if (planOverlay && !planOverlay.classList.contains("active")) {
    planOverlay.classList.add("active");
  }
}

// Resolve Plan Approval
async function resolvePlanApproval(action) {
  try {
    const res = await fetch(`${BASE_URL}/api/plan/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    if (res.ok) {
      planOverlay.classList.remove("active");
    } else {
      const data = await res.json().catch(() => ({}));
      alert("Error: " + (data.error || "Failed to send plan action."));
    }
  } catch (err) {
    alert("Error sending plan action: " + err.message);
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
  window.isWaitingForAgentStart = true;

  streamStartTime = null;
  streamCharCount = 0;
  const speedText = document.getElementById("meta-speed-text");
  if (speedText) speedText.textContent = "0.0 t/s";

  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text })
    });
    if (!res.ok) {
      window.isWaitingForAgentStart = false;
      const data = await res.json();
      appendMessage("system", "Error: " + data.error);
      hideSpinner();
    }
  } catch (err) {
    window.isWaitingForAgentStart = false;
    appendMessage("system", "Error: Failed to deliver prompt.");
    hideSpinner();
  }
}

// Abort Execution
async function abortExecution() {
  window.isWaitingForAgentStart = false;
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
  let tasks = [];
  let subagents = [];
  let superagents = [];

  // Poll tasks
  try {
    const resTasks = await fetch(`${BASE_URL}/api/tasks`);
    if (resTasks.ok) {
      const data = await resTasks.json();
      tasks = data.tasks || [];
      renderTasks(tasks);
    }
  } catch {}

  // Poll agent hierarchy instances
  try {
    const resInsts = await fetch(`${BASE_URL}/api/instances`);
    if (resInsts.ok) {
      const data = await resInsts.json();
      subagents = data.subagents || [];
      superagents = data.superagents || [];
      renderAgentsTree(subagents, superagents);
    }
  } catch {}
}
let checklistDecayInterval = null;

// Render task list in the persistent panel above the input area
function renderTasks(tasks) {
  const panel = document.getElementById("persistent-tasks-panel");
  if (!panel) return;

  if (!tasks || tasks.length === 0) {
    panel.classList.add("hidden");
    if (checklistDecayInterval) {
      clearInterval(checklistDecayInterval);
      checklistDecayInterval = null;
    }
    return;
  }

  window.currentTasksList = tasks;
  window.completedTaskTimestamps = window.completedTaskTimestamps || new Map();

  const now = Date.now();
  
  // Record timestamps for completed tasks
  tasks.forEach(t => {
    if (t.status === "x") {
      if (!window.completedTaskTimestamps.has(t.text)) {
        window.completedTaskTimestamps.set(t.text, now);
      }
    } else {
      window.completedTaskTimestamps.delete(t.text);
    }
  });

  // Filter and map tasks with remainingSeconds
  let activeDecayCount = 0;
  const processedTasks = tasks.map(t => {
    if (t.status === "x") {
      const completionTime = window.completedTaskTimestamps.get(t.text) || now;
      const elapsed = now - completionTime;
      const remainingSeconds = Math.max(0, Math.ceil((15000 - elapsed) / 1000));
      if (remainingSeconds > 0) {
        activeDecayCount++;
      }
      return { ...t, remainingSeconds };
    }
    return t;
  }).filter(t => {
    return t.status !== "x" || t.remainingSeconds > 0;
  });

  // Set up 1s refresh interval if there are active decay countdowns
  if (activeDecayCount > 0) {
    if (!checklistDecayInterval) {
      checklistDecayInterval = setInterval(() => {
        renderTasks(window.currentTasksList);
      }, 1000);
    }
  } else {
    if (checklistDecayInterval) {
      clearInterval(checklistDecayInterval);
      checklistDecayInterval = null;
    }
  }

  // If all tasks are completed and expired, the list becomes empty
  if (processedTasks.length === 0) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");

  // Auto-expand content panel when tasks update
  const content = document.getElementById("persistent-tasks-content");
  const chevron = document.getElementById("persistent-tasks-chevron");
  
  const serialized = JSON.stringify(processedTasks);
  if (serialized === window.lastSerializedTasks) {
    panel.classList.remove("hidden");
    return;
  }
  window.lastSerializedTasks = serialized;

  if (content) content.classList.remove("hidden");
  if (chevron) chevron.textContent = "▼";

  let completed = 0;
  processedTasks.forEach(t => {
    if (t.status === "x") completed++;
  });

  const countEl = document.getElementById("persistent-tasks-count");
  if (countEl) {
    countEl.textContent = `${completed}/${processedTasks.length}`;
  }

  const listEl = document.getElementById("persistent-tasks-list");
  if (listEl) {
    listEl.innerHTML = "";
    processedTasks.forEach(t => {
      const row = document.createElement("div");
      row.className = "flex items-center gap-1.5 py-[1px] text-[10px] font-sans leading-tight";

      let icon = "○";
      let textClass = "text-vscode-primary";

      if (t.status === "x") {
        icon = "✓";
        textClass = "line-through text-vscode-muted";
      } else if (t.status === "/") {
        icon = "◌";
        textClass = "text-vscode-bright font-medium";
      }

      const iconSpan = document.createElement("span");
      iconSpan.className = `font-mono text-[9px] select-none ${t.status === '/' ? 'animate-spin inline-block text-vscode-blue' : (t.status === 'x' ? 'text-green-success font-bold' : 'text-vscode-muted')}`;
      iconSpan.textContent = icon;

      const textSpan = document.createElement("span");
      textSpan.className = `${textClass} flex-1 overflow-hidden text-ellipsis`;
      if (t.status === "x" && t.remainingSeconds !== undefined) {
        textSpan.textContent = `${t.text} ~ Hide in (${t.remainingSeconds}s)`;
      } else {
        textSpan.textContent = t.text;
      }

      row.appendChild(iconSpan);
      row.appendChild(textSpan);
      listEl.appendChild(row);
    });
  }
  
  scrollToBottom();
}

// Render active subagents/superagents inside the persistent tasks panel
function renderAgentsTree(subagents, superagents) {
  const section = document.getElementById("persistent-agents-section");
  const listEl = document.getElementById("persistent-agents-list");
  if (!section || !listEl) return;

  const hasAgents = (subagents && subagents.length > 0) || (superagents && superagents.length > 0);
  if (!hasAgents) {
    section.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  section.classList.remove("hidden");
  listEl.innerHTML = "";

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

    listEl.appendChild(chip);
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

    listEl.appendChild(chip);
  });

  scrollToBottom();
}

// [Rendering helpers, appendMessage, finishFooter, spinner controls, workspaces rendering moved to sidepanel-ui.js]



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

// [History rendering moved to sidepanel-history.js]

function updateSetupRecentWorkspaces() {
  renderWorkspaceListOnly();
}

// Tab Switching and Sidebar Navigation Logic
let activeSidebarTab = "workspace";

function switchSidebarTab(tabId) {
  const leftSidebar = document.getElementById("left-sidebar");
  const sidebarTitle = document.getElementById("left-sidebar-title");
  const btnShowAddWorkspace = document.getElementById("btn-show-add-workspace");
  
  if (leftSidebar) {
    leftSidebar.classList.remove("hidden");
  }
  
  // Toggle the "+" button depending on sidebar view
  if (btnShowAddWorkspace) {
    if (tabId === "workspace") {
      btnShowAddWorkspace.classList.remove("hidden");
    } else {
      btnShowAddWorkspace.classList.add("hidden");
    }
  }
  
  // Reset tab button active states
  if (tabWorkspace) tabWorkspace.classList.remove("active");
  if (tabChat) tabChat.classList.remove("active");
  if (tabHistory) tabHistory.classList.remove("active");
  
  // Hide all sidebar views
  if (viewWorkspace) viewWorkspace.classList.add("hidden");
  if (viewHistory) viewHistory.classList.add("hidden");
  
  if (tabId === "workspace") {
    if (tabWorkspace) tabWorkspace.classList.add("active");
    if (viewWorkspace) viewWorkspace.classList.remove("hidden");
    if (sidebarTitle) sidebarTitle.textContent = "Workspace";
    activeSidebarTab = "workspace";
  } else if (tabId === "history") {
    if (tabHistory) tabHistory.classList.add("active");
    if (viewHistory) viewHistory.classList.remove("hidden");
    if (sidebarTitle) sidebarTitle.textContent = "History";
    activeSidebarTab = "history";
    loadChatHistorySessions();
  }
}

function handleSidebarTabClick(tabId) {
  const leftSidebar = document.getElementById("left-sidebar");
  
  if (tabId === "chat") {
    if (leftSidebar) {
      const isHidden = leftSidebar.classList.contains("hidden");
      if (isHidden) {
        // Show sidebar and active tab
        switchSidebarTab(activeSidebarTab);
      } else {
        // Collapse sidebar and focus Chat
        leftSidebar.classList.add("hidden");
        if (tabWorkspace) tabWorkspace.classList.remove("active");
        if (tabHistory) tabHistory.classList.remove("active");
        if (tabChat) tabChat.classList.add("active");
      }
    }
  } else {
    const tabButton = tabId === "workspace" ? tabWorkspace : tabHistory;
    if (leftSidebar && !leftSidebar.classList.contains("hidden") && activeSidebarTab === tabId) {
      // Toggle off
      leftSidebar.classList.add("hidden");
      if (tabButton) tabButton.classList.remove("active");
    } else {
      switchSidebarTab(tabId);
    }
  }
}

// Legacy switchTab wrapper for backward compatibility
function switchTab(tabId) {
  if (tabId === "chat") {
    const leftSidebar = document.getElementById("left-sidebar");
    if (leftSidebar) {
      leftSidebar.classList.add("hidden");
    }
    if (tabWorkspace) tabWorkspace.classList.remove("active");
    if (tabHistory) tabHistory.classList.remove("active");
    if (tabChat) tabChat.classList.add("active");
  } else {
    switchSidebarTab(tabId);
  }
}

// [Document rendering, markdown parsing, and sessions switcher moved to sidepanel-ui.js and sidepanel-history.js]

window.updateWorkspaceRequiredUI = function() {
  const activeWorkspaceText = document.getElementById("active-workspace-text");
  const isWorkspaceConnected = activeWorkspaceText && activeWorkspaceText.textContent && activeWorkspaceText.textContent !== "Not Selected";
  const btnNewChat = document.getElementById("btn-new-chat");
  const chatInput = document.getElementById("chat-input");
  const btnSend = document.getElementById("btn-send");

  if (!isWorkspaceConnected) {
    if (btnNewChat) btnNewChat.classList.add("hidden");
    if (chatInput) {
      chatInput.disabled = true;
      chatInput.placeholder = "Please select or add a workspace in the Left Sidebar to start chatting...";
      chatInput.value = "";
    }
    if (btnSend) {
      btnSend.disabled = true;
      btnSend.classList.add("opacity-50");
      btnSend.style.pointerEvents = "none";
    }
  } else {
    if (btnNewChat) btnNewChat.classList.remove("hidden");
    if (chatInput) {
      chatInput.disabled = false;
      chatInput.placeholder = "Type instructions or / for commands, ! for terminal...";
    }
    if (btnSend) {
      btnSend.disabled = false;
      btnSend.classList.remove("opacity-50");
      btnSend.style.pointerEvents = "auto";
    }
  }
};



