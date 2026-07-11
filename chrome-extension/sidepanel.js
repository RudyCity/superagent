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

const tabChat = document.getElementById("tab-chat");
const tabHistory = document.getElementById("tab-history");

const viewChat = document.getElementById("view-chat");
const viewHistory = document.getElementById("view-history");

const btnRefreshHistory = document.getElementById("btn-refresh-history");
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

  // Status strip collapse/expand toggle
  const statusStrip = document.getElementById("status-strip");
  const btnToggleStatusStrip = document.getElementById("btn-toggle-status-strip");
  if (statusStrip && btnToggleStatusStrip) {
    btnToggleStatusStrip.addEventListener("click", () => {
      const isCollapsed = statusStrip.classList.contains("status-strip-collapsed");
      statusStrip.classList.toggle("status-strip-collapsed", !isCollapsed);
      const icon = btnToggleStatusStrip.querySelector(".toggle-icon");
      if (icon) {
        icon.textContent = isCollapsed ? "▾" : "▸";
      }
    });
  }

  // Quick Preset Selector Change Listener
  const quickPresetSelect = document.getElementById("quick-preset-select");
  if (quickPresetSelect) {
    quickPresetSelect.addEventListener("change", async () => {
      const selectedId = quickPresetSelect.value;
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
    });
  }

  // Input Metadata Preset Selector Change Listener
  const inputPresetSelect = document.getElementById("input-preset-select");
  if (inputPresetSelect) {
    inputPresetSelect.addEventListener("change", async () => {
      const selectedId = inputPresetSelect.value;
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
    });
  }

  // Collapsible Terminal Drawer Toggler
  const terminalDrawer = document.getElementById("terminal-drawer");
  const terminalHeader = document.getElementById("terminal-header");
  const btnToggleTerminal = document.getElementById("btn-toggle-terminal");
  if (terminalDrawer && terminalHeader) {
    terminalHeader.addEventListener("click", () => {
      const isExpanded = terminalDrawer.style.height === "200px";
      terminalDrawer.style.height = isExpanded ? "28px" : "200px";
      if (btnToggleTerminal) {
        btnToggleTerminal.textContent = isExpanded ? "▲" : "▼";
      }
      // Hide badge when drawer is opened
      if (!isExpanded) {
        const badge = document.getElementById("terminal-badge");
        if (badge) badge.classList.add("hidden");
      }
    });
  }

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
  btnApprovePlan.addEventListener("click", () => resolvePlanApproval("approve"));
  btnRejectPlan.addEventListener("click", () => resolvePlanApproval("reject"));

 
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

  document.addEventListener("click", () => {
    hideWorkspaceDropdown();
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
  if (tabHistory) tabHistory.addEventListener("click", () => switchTab("history"));

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
        if (sendBtnEl && sendBtnEl.dataset.state === "stop") {
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

// [browseWorkspaceFolder moved to sidepanel-ui.js]

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
          const label = getToolLabel(e.toolCall, e.description);
          const detail = buildToolDetail(e.toolCall);
          const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

          // Format args as preview for expanded section
          let argsText = "";
          try {
            const args = e.toolCall.args || {};
            const argsStr = JSON.stringify(args, null, 2);
            argsText = argsStr.length > 400 ? argsStr.slice(0, 400) + "..." : argsStr;
          } catch (_) {}

          currentActiveToolElement.innerHTML = `
            <div class="tool-row">
              <span class="tool-row-label">${esc(label)}</span>
              ${detail ? `<span class="tool-row-detail">${esc(detail)}</span>` : ""}
              <span class="tool-row-chevron">›</span>
            </div>
            <div class="tool-expand hidden">
              ${argsText ? `<pre class="tool-args">${esc(argsText)}</pre>` : ""}
              <div class="tool-result-area hidden"></div>
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
          if (isErr) {
            const label = currentActiveToolElement.querySelector(".tool-row-label");
            if (label) label.classList.add("tool-row-label-error");
          }

          // Inline result suffix (e.g. diff stat for edits)
          const inlineSuffix = buildResultSuffix(e.toolCall, e.toolResult);
          if (inlineSuffix) {
            const rowLabel = currentActiveToolElement.querySelector(".tool-row-label");
            const suffixSpan = document.createElement("span");
            suffixSpan.className = "tool-row-suffix";
            suffixSpan.textContent = inlineSuffix;
            rowLabel.parentNode.insertBefore(suffixSpan, rowLabel.nextSibling);
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
                const preview = resultText.length > 500 ? resultText.slice(0, 500) + "\n... (truncated)" : resultText;
                resultArea.textContent = preview;
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
    const termBody = document.getElementById("terminal-body");
    if (termBody) {
      if (termBody.textContent === "Welcome to Superagent terminal logs...") {
        termBody.textContent = "";
      }
      termBody.textContent += data.content;
      termBody.scrollTop = termBody.scrollHeight;
      
      const termDrawer = document.getElementById("terminal-drawer");
      const badge = document.getElementById("terminal-badge");
      if (termDrawer && termDrawer.style.height !== "200px" && badge) {
        badge.classList.remove("hidden");
      }
    }

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

// [Rendering helpers, appendMessage, finishFooter, spinner controls, workspaces rendering moved to sidepanel-ui.js]

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

// [History rendering moved to sidepanel-history.js]

function updateSetupRecentWorkspaces() {
  chrome.storage.local.get(["savedWorkspaces"], (result) => {
    renderSetupRecentWorkspaces(result.savedWorkspaces || []);
  });
}

// Tab Switching Logic
function switchTab(tabId) {
  const tabs = [tabChat, tabHistory];
  const views = [viewChat, viewHistory];
  
  tabs.forEach(t => { if (t) t.classList.remove("active"); });
  views.forEach(v => { if (v) v.classList.add("hidden"); });
  
  if (tabId === "chat" && tabChat && viewChat) {
    tabChat.classList.add("active");
    viewChat.classList.remove("hidden");
  } else if (tabId === "history" && tabHistory && viewHistory) {
    tabHistory.classList.add("active");
    viewHistory.classList.remove("hidden");
    loadChatHistorySessions();
  }
}

// [Document rendering, markdown parsing, and sessions switcher moved to sidepanel-ui.js and sidepanel-history.js]



