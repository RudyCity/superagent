const BASE_URL = "http://localhost:7888";
const MAX_SAVED_WORKSPACES = 10;

let eventSource = null;
let currentAgentMessageElement = null;
let currentReasoningElement = null;
let currentActiveToolElement = null;
let taskPollInterval = null;
let agentJobStartTime = null;

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
const tabPlan = document.getElementById("tab-plan");
const tabTasks = document.getElementById("tab-tasks");
const tabWalkthrough = document.getElementById("tab-walkthrough");
const tabHistory = document.getElementById("tab-history");

const viewChat = document.getElementById("view-chat");
const viewPlan = document.getElementById("view-plan");
const viewTasks = document.getElementById("view-tasks");
const viewWalkthrough = document.getElementById("view-walkthrough");
const viewHistory = document.getElementById("view-history");

const planContent = document.getElementById("plan-content");
const tasksContent = document.getElementById("tasks-content");
const walkthroughContent = document.getElementById("walkthrough-content");

const btnRefreshPlan = document.getElementById("btn-refresh-plan");
const btnRefreshTasks = document.getElementById("btn-refresh-tasks");
const btnRefreshWalkthrough = document.getElementById("btn-refresh-walkthrough");
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
  if (tabPlan) tabPlan.addEventListener("click", () => switchTab("plan"));
  if (tabTasks) tabTasks.addEventListener("click", () => switchTab("tasks"));
  if (tabWalkthrough) tabWalkthrough.addEventListener("click", () => switchTab("walkthrough"));
  if (tabHistory) tabHistory.addEventListener("click", () => switchTab("history"));

  // Document Refresh Listeners
  if (btnRefreshPlan) btnRefreshPlan.addEventListener("click", loadDocuments);
  if (btnRefreshTasks) btnRefreshTasks.addEventListener("click", loadDocuments);
  if (btnRefreshWalkthrough) btnRefreshWalkthrough.addEventListener("click", loadDocuments);
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

// Tool label helpers — map tool name → human verb (like screenshot style)
function getToolLabel(toolCall, fallbackDesc) {
  if (!toolCall) return fallbackDesc || "Running tool";
  const name = toolCall.name || "";
  const args = toolCall.args || {};
  const cmd = args.command || args.cmd || "";
  const truncCmd = (s) => (s.length > 60 ? s.slice(0, 60) + "…" : s);
  switch (name) {
    case "bash":
    case "run_command":
    case "run_background_process":
      return `Ran ${truncCmd(cmd)}`;
    case "read":
    case "view_file":
      return "Read file";
    case "write":
    case "write_to_file":
      return "Wrote file";
    case "edit":
    case "replace_file_content":
      return "Edited file";
    case "multi_replace_file_content":
      return "Edited file";
    case "apply_patch":
      return "Applied patch";
    case "glob":
      return "Found files";
    case "grep":
    case "ripgrep_search":
      return "Searched";
    case "web_search":
      return "Searched web";
    case "fetch_url":
      return "Fetched URL";
    case "git_action":
      return `Git ${args.action || "action"}`;
    case "git_worktree":
      return `Git worktree ${args.action || ""}`;
    case "list_dir":
      return "Explored directory";
    case "screenshot":
      return "Captured screenshot";
    case "invoke_subagent":
      return `Spawned subagent`;
    case "define_subagent":
      return `Defined subagent`;
    case "manage_subagents":
      return `Managed subagents`;
    case "manage_tasks":
      return `Managed tasks`;
    case "manage_plan":
      return `Managed plan`;
    case "ask_question":
      return "Asked question";
    case "schedule":
      return "Scheduled job";
    default:
      return fallbackDesc || `Ran ${name}`;
  }
}

function buildToolDetail(toolCall) {
  if (!toolCall) return "";
  const args = toolCall.args || {};
  const name = toolCall.name || "";
  // Extract the most useful "detail" token to show inline
  switch (name) {
    case "bash":
    case "run_command":
    case "run_background_process": {
      const cmd = args.command || args.cmd || "";
      return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
    }
    case "read":
    case "view_file":
    case "write":
    case "write_to_file":
    case "edit":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "apply_patch": {
      const fp = args.filePath || args.file_path || args.path || args.TargetFile || "";
      return fp ? fp.split(/[\\/]/).pop() : "";
    }
    case "grep":
    case "ripgrep_search":
      return args.pattern || args.query || "";
    case "web_search":
      return (args.query || "").slice(0, 60);
    case "fetch_url":
      return (args.url || "").replace(/^https?:\/\//, "").slice(0, 60);
    case "git_action":
      return args.action || "";
    case "list_dir":
      return (args.path || args.DirectoryPath || "").split(/[\\/]/).pop() || "";
    case "invoke_subagent":
      return args.role || args.typeName || "";
    default:
      return "";
  }
}

function buildResultSuffix(toolCall, toolResult) {
  if (!toolCall || !toolResult) return "";
  const name = toolCall.name || "";
  const result = toolResult.result || "";
  const isEdit = ["edit", "replace_file_content", "multi_replace_file_content", "write", "write_to_file", "apply_patch"].includes(name);
  if (isEdit && !toolResult.isError) {
    // Count lines added/removed from diff-like result
    const added = (result.match(/^\+/gm) || []).length;
    const removed = (result.match(/^-/gm) || []).length;
    if (added > 0 || removed > 0) {
      return `+${added} -${removed}`;
    }
    return "";
  }
  // For search/grep: show match count
  if (["grep", "ripgrep_search"].includes(name) && !toolResult.isError) {
    const lines = result.split("\n").filter(Boolean).length;
    return lines > 0 ? `${lines} match${lines !== 1 ? "es" : ""}` : "";
  }
  return "";
}

// Handle Incoming SSE Events
function handleSSEEvent(data) {
  if (data.type === "agent_event") {
    const e = data.event;
    switch (e.type) {
      case "text":
        hideSpinner();
        if (!agentJobStartTime) agentJobStartTime = Date.now();
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
        hideSpinner();
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
            const resultText = e.toolResult.result || "";
            if (resultText) {
              const preview = resultText.length > 500 ? resultText.slice(0, 500) + "\n... (truncated)" : resultText;
              resultArea.textContent = preview;
              resultArea.classList.remove("hidden");
              if (isErr) resultArea.classList.add("tool-result-error");
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
          // Inject "Finished in Xm Xs" badge + summary footer
          appendJobFinishFooter(currentAgentMessageElement, agentJobStartTime);
        }
        currentAgentMessageElement = null;
        currentReasoningElement = null;
        currentActiveToolElement = null;
        agentJobStartTime = null;
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

// Legacy renderQuestion / submitAnswer kept for compatibility but no longer used for live flow
function renderQuestion() {}
async function submitAnswer() {}

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

  // Grab summary text from the agent message text content
  const contentSpan = msgEl.querySelector(".msg-content-text");
  const summaryText = contentSpan ? contentSpan.innerText.trim() : "";

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
  toggleBtn.textContent = "Summary ▴"; // default open, arrow pointing up
  toggleBtn.title = "Toggle summary";

  badgeRow.appendChild(checkIcon);
  badgeRow.appendChild(badge);
  badgeRow.appendChild(toggleBtn);

  // Summary card (default expanded, NO "hidden" class)
  const summaryCard = document.createElement("div");
  summaryCard.className = "job-summary-card";

  const summaryLabel = document.createElement("div");
  summaryLabel.className = "job-summary-label";
  summaryLabel.textContent = "Summary";

  const summaryBody = document.createElement("div");
  summaryBody.className = "job-summary-body";

  if (summaryText) {
    // Show only last ~600 chars as a quick summary
    const preview = summaryText.length > 600
      ? "..." + summaryText.slice(summaryText.length - 600)
      : summaryText;
    summaryBody.innerHTML = formatMarkdown(preview);
  } else {
    summaryBody.textContent = "No summary available.";
  }

  summaryCard.appendChild(summaryLabel);
  summaryCard.appendChild(summaryBody);

  // Toggle logic for summary card
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation(); // prevent triggering tool blocks toggle
    const isHidden = summaryCard.classList.contains("hidden");
    summaryCard.classList.toggle("hidden", !isHidden);
    toggleBtn.textContent = isHidden ? "Summary ▴" : "Summary ▾";
  });

  // Clicking finished badge row will toggle the tools usage visibility
  badgeRow.addEventListener("click", () => {
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
  footer.appendChild(summaryCard);

  // Inject after the msg content (outside the msg-content div, inside .msg)
  msgEl.appendChild(footer);

  // Directly scroll the summary card into view smoothly
  setTimeout(() => {
    summaryCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, 100);
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

        const isErr = tr && tr.isError;
        const label = getToolLabel(tc, tc.name);
        const detail = buildToolDetail(tc);
        const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

        toolBlock.innerHTML = `
          <div class="tool-row">
            <span class="tool-row-label ${isErr ? 'tool-row-label-error' : ''}">${esc(label)}</span>
            ${detail ? `<span class="tool-row-detail">${esc(detail)}</span>` : ""}
            <span class="tool-row-chevron">›</span>
          </div>
          <div class="tool-expand hidden">
            ${argsText ? `<pre class="tool-args">${esc(argsText)}</pre>` : ""}
            <div class="tool-result-area hidden"></div>
          </div>
        `;

        toolBlock.querySelector(".tool-row").addEventListener("click", () => {
          const exp = toolBlock.querySelector(".tool-expand");
          const chev = toolBlock.querySelector(".tool-row-chevron");
          const isHidden = exp.classList.contains("hidden");
          exp.classList.toggle("hidden", !isHidden);
          chev.textContent = isHidden ? "⌄" : "›";
        });

        if (tr) {
          const resultArea = toolBlock.querySelector(".tool-result-area");
          const resultText = tr.result || "";
          if (resultText) {
            const preview = resultText.length > 500 ? resultText.slice(0, 500) + "\n... (truncated)" : resultText;
            resultArea.textContent = preview;
            resultArea.classList.remove("hidden");
            if (isErr) resultArea.classList.add("tool-result-error");
          }
        }

        contentDiv.appendChild(toolBlock);
      });
    }

    if (msg.role === "tool" && Array.isArray(msg.toolResults)) {
      const msgDivs = chatMessages.querySelectorAll(".msg-agent");
      if (msgDivs.length > 0) {
        const lastMsgDiv = msgDivs[msgDivs.length - 1];
        const contentDiv = lastMsgDiv.querySelector(".msg-content");
        
        msg.toolResults.forEach(tr => {
          const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const toolBlock = document.createElement("div");
          toolBlock.className = "tool-block";
          const resultText = tr.result || "";
          const preview = resultText.length > 500 ? resultText.slice(0, 500) + "\n... (truncated)" : resultText;

          toolBlock.innerHTML = `
            <div class="tool-row">
              <span class="tool-row-label ${tr.isError ? 'tool-row-label-error' : ''}">${esc(tr.name ?? "tool")}</span>
              <span class="tool-row-chevron">›</span>
            </div>
            <div class="tool-expand hidden">
              <div class="tool-result-area ${tr.isError ? 'tool-result-error' : ''}">${esc(preview)}</div>
            </div>
          `;

          toolBlock.querySelector(".tool-row").addEventListener("click", () => {
            const exp = toolBlock.querySelector(".tool-expand");
            const chev = toolBlock.querySelector(".tool-row-chevron");
            const isHidden = exp.classList.contains("hidden");
            exp.classList.toggle("hidden", !isHidden);
            chev.textContent = isHidden ? "⌄" : "›";
          });

          contentDiv.appendChild(toolBlock);
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
  const tabs = [tabChat, tabPlan, tabTasks, tabWalkthrough, tabHistory];
  const views = [viewChat, viewPlan, viewTasks, viewWalkthrough, viewHistory];
  
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
  } else if (tabId === "history" && tabHistory && viewHistory) {
    tabHistory.classList.add("active");
    viewHistory.classList.remove("hidden");
    loadChatHistorySessions();
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

    item.addEventListener("click", async () => {
      await switchChatSession(s.id);
      switchTab("chat");
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



