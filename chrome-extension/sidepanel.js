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
let apiToken = "";
let currentMode = "single";
let workspaceDropdownOpen = false;

// Config state
let serverPresets = null;
let serverActivePresetId = null;
let advancedSettingsOpen = false;
let wasOffline = true;

// Local fetch wrapper to append API token
const originalFetch = window.fetch;
const fetch = async (url, options = {}) => {
  if (apiToken) {
    options.headers = options.headers || {};
    options.headers["Authorization"] = `Bearer ${apiToken}`;
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

const btnStopServer = document.getElementById("btn-stop-server");
const btnStartServerHelp = document.getElementById("btn-start-server-help");
const startServerTooltip = document.getElementById("start-server-tooltip");

const btnSwitchWorkspace = document.getElementById("btn-switch-workspace");
const workspaceDropdown = document.getElementById("workspace-dropdown");
const savedWorkspacesList = document.getElementById("saved-workspaces-list");
const btnNewWorkspace = document.getElementById("btn-new-workspace");

const btnToggleAdvanced = document.getElementById("btn-toggle-advanced");
const advancedSettingsContent = document.getElementById("advanced-settings-content");
const modelPresetSelect = document.getElementById("model-preset");
const settingDisableStreaming = document.getElementById("setting-disable-streaming");
const settingConcurrency = document.getElementById("setting-concurrency");
const settingMaxIterations = document.getElementById("setting-max-iterations");
const settingRpm = document.getElementById("setting-rpm");

// Initialize View
document.addEventListener("DOMContentLoaded", () => {
  // Load saved workspace path and API token if any
  chrome.storage.local.get(["lastWorkspacePath", "lastApiToken"], (result) => {
    if (result.lastWorkspacePath) {
      workspacePathInput.value = result.lastWorkspacePath;
    }
    if (result.lastApiToken) {
      apiTokenInput.value = result.lastApiToken;
      apiToken = result.lastApiToken;
    }
    checkServerStatus();
  });

  setInterval(checkServerStatus, 1000);


  // Buttons Event Listeners
  btnInit.addEventListener("click", initSession);
  btnBrowse.addEventListener("click", browseWorkspaceFolder);
  btnSend.addEventListener("click", sendChatMessage);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  btnAbort.addEventListener("click", abortExecution);
  btnApproveOnce.addEventListener("click", () => resolvePermission(true));
  btnApproveSession.addEventListener("click", () => resolvePermission("session"));
  btnDenyPermission.addEventListener("click", () => resolvePermission(false));
  btnSubmitAnswer.addEventListener("click", submitAnswer);
  btnGrabContext.addEventListener("click", grabTabContext);

  btnStopServer.addEventListener("click", stopServer);
  btnStartServerHelp.addEventListener("click", (e) => {
    e.stopPropagation();
    startServerTooltip.classList.toggle("hidden");
  });

  // Workspace switcher
  btnSwitchWorkspace.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleWorkspaceDropdown();
  });

  btnNewWorkspace.addEventListener("click", () => {
    hideWorkspaceDropdown();
    goToSetupScreen();
  });

  document.addEventListener("click", () => {
    startServerTooltip.classList.add("hidden");
    hideWorkspaceDropdown();
  });

  // Advanced Settings Toggle
  btnToggleAdvanced.addEventListener("click", () => {
    advancedSettingsOpen = !advancedSettingsOpen;
    btnToggleAdvanced.classList.toggle("open", advancedSettingsOpen);
    advancedSettingsContent.classList.toggle("hidden", !advancedSettingsOpen);
  });

  // Orchestration Mode Radio Change
  document.querySelectorAll('input[name="agent-mode"]').forEach(radio => {
    radio.addEventListener("change", updatePresetsDropdown);
  });
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
      
      btnStopServer.classList.remove("hidden");
      btnStartServerHelp.classList.add("hidden");
      startServerTooltip.classList.add("hidden");

      // Auto reconnect view if server is running session
      if (data.sessionId && workspaceScreen.className.indexOf("active") === -1) {
        activeWorkspaceText.textContent = data.workspace;
        activeModeText.textContent = data.mode;
        setupScreen.classList.remove("active");
        workspaceScreen.classList.add("active");
        setupSSE();
        startPolling();
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
    btnStopServer.classList.add("hidden");
    btnStartServerHelp.classList.remove("hidden");
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

// Stop local server
async function stopServer() {
  if (!confirm("Are you sure you want to stop the local Superagent server?")) return;
  try {
    await fetch(`${BASE_URL}/api/shutdown`, { method: "POST" });
    statusBadge.textContent = "Offline";
    statusBadge.className = "status-badge status-offline";
    btnStopServer.classList.add("hidden");
    btnStartServerHelp.classList.remove("hidden");
    if (workspaceScreen.classList.contains("active")) {
      workspaceScreen.classList.remove("active");
      setupScreen.classList.add("active");
      stopPolling();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }
  } catch (err) {
    alert("Failed to send shutdown command: " + err.message);
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
      appendMessage("system", `System initialized in ${mode} mode.`);
      
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
            <div class="tool-indicator tool-running"></div>
            <span class="tool-name">${e.toolCall?.name ?? "tool"}</span>
            <span class="tool-desc">${e.description ?? ""}</span>
            <button class="tool-toggle" aria-expanded="false" title="Expand details">&#9658;</button>
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
          const toggle = toolBlock.querySelector(".tool-toggle");
          const isOpen = !detail.classList.contains("hidden");
          detail.classList.toggle("hidden", isOpen);
          toggle.textContent = isOpen ? "▸" : "▾";
          toggle.setAttribute("aria-expanded", String(!isOpen));
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
              const toggle = currentActiveToolElement.querySelector(".tool-toggle");
              detail.classList.remove("hidden");
              toggle.textContent = "\u25be";
              toggle.setAttribute("aria-expanded", "true");
            }
          }

          currentActiveToolElement = null;
        }
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

  if (Array.isArray(question)) {
    // Multi-question item format
    questionTitle.textContent = "Multiple items requested. Please select pathways:";
    question.forEach((q, idx) => {
      const qLabel = document.createElement("p");
      qLabel.className = "modal-label";
      qLabel.textContent = q.question;
      questionOptionsContainer.appendChild(qLabel);

      q.options.forEach(opt => {
        const btn = document.createElement("div");
        btn.className = "option-btn";
        btn.innerHTML = `
          <div class="option-bullet"></div>
          <span class="option-text">${opt}</span>
        `;
        btn.addEventListener("click", () => {
          btn.parentElement.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
        });
        questionOptionsContainer.appendChild(btn);
      });
    });
  } else {
    questionTitle.textContent = question;
    if (options && options.length > 0) {
      options.forEach(opt => {
        const btn = document.createElement("div");
        btn.className = "option-btn";
        btn.innerHTML = `
          <div class="option-bullet"></div>
          <span class="option-text">${opt}</span>
        `;
        btn.addEventListener("click", () => {
          document.querySelectorAll(".option-btn").forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          selectedQuestionOption = opt;
          if (opt === "Custom...") {
            questionCustomContainer.classList.remove("hidden");
          } else {
            questionCustomContainer.classList.add("hidden");
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
  let answer = selectedQuestionOption;
  if (selectedQuestionOption === "Custom..." || !selectedQuestionOption) {
    answer = questionCustomInput.value.trim();
  }

  if (answer === null || answer === "") {
    alert("Please select or type an answer.");
    return;
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
  const mode = activeModeText.textContent.toLowerCase();

  const hasAgents = (subagents && subagents.length > 0) || (superagents && superagents.length > 0);
  if (mode !== "multi" || !hasAgents) {
    agentsStrip.classList.add("hidden");
    return;
  }

  agentsStrip.classList.remove("hidden");
  agentsStripItems.innerHTML = "";

  superagents.forEach(sa => {
    const chip = document.createElement("div");
    const statusKey = sa.status === "done" ? "done" : sa.status === "running" ? "running" : "todo";
    chip.className = `agent-chip chip-super chip-${statusKey}`;
    chip.title = `Superagent: ${sa.role} (${sa.status})`;
    chip.innerHTML = `<span class="chip-icon">◈</span><span class="chip-text">${sa.role}</span>`;
    agentsStripItems.appendChild(chip);
  });

  subagents.forEach(sub => {
    const chip = document.createElement("div");
    const statusKey = sub.status === "done" ? "done" : sub.status === "running" ? "running" : "todo";
    chip.className = `agent-chip chip-sub chip-${statusKey}`;
    chip.title = `Subagent: ${sub.typeName} (${sub.status})`;
    chip.innerHTML = `<span class="chip-icon">◆</span><span class="chip-text">${sub.typeName}</span>`;
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
  scrollToBottom();
}

function hideSpinner() {
  processingIndicator.classList.remove("active");
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


