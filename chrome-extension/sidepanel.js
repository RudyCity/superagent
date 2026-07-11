const BASE_URL = "http://localhost:7888";

let eventSource = null;
let currentAgentMessageElement = null;
let currentReasoningElement = null;
let currentActiveToolElement = null;
let taskPollInterval = null;

let pendingPermissionId = null;
let pendingQuestionId = null;
let selectedQuestionOption = null;
let apiToken = "";

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

const checklistContainer = document.getElementById("checklist-container");
const agentsTree = document.getElementById("agents-tree");

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

  // Tab navigation
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      
      btn.classList.add("active");
      document.getElementById(btn.dataset.tab).classList.add("active");
    });
  });

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
  document.addEventListener("click", () => {
    startServerTooltip.classList.add("hidden");
  });
});

// Check Server Status
async function checkServerStatus() {
  try {
    const res = await fetch(`${BASE_URL}/api/status`);
    const data = await res.json();
    if (data.status === "online") {
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
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        if (data.path) {
          workspacePathInput.value = data.path;
        }
      } else {
        alert("Error opening folder picker: " + (data.error || "Unknown error"));
      }
    } else {
      alert("Browse API returned an error status: " + res.statusText);
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
    const res = await fetch(`${BASE_URL}/api/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, workspace, resume })
    });
    const data = await res.json();

    if (data.success) {
      activeWorkspaceText.textContent = workspace;
      activeModeText.textContent = mode;
      
      setupScreen.classList.remove("active");
      workspaceScreen.classList.add("active");
      
      chatMessages.innerHTML = "";
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
        currentActiveToolElement.innerHTML = `
          <div class="tool-indicator tool-running"></div>
          <span>${e.toolCall.name} (${e.description})</span>
        `;
        currentAgentMessageElement.querySelector(".msg-content").appendChild(currentActiveToolElement);
        scrollToBottom();
        break;

      case "tool_end":
        hideSpinner();
        if (currentActiveToolElement) {
          const indicator = currentActiveToolElement.querySelector(".tool-indicator");
          indicator.className = e.toolResult.isError ? "tool-indicator tool-error" : "tool-indicator tool-success";
          currentActiveToolElement = null;
        }
        break;

      case "error":
        hideSpinner();
        appendMessage("system", `Error: ${e.message}`);
        break;

      case "done":
        hideSpinner();
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

// Render task list checklist
function renderTasks(tasks) {
  if (!tasks || tasks.length === 0) {
    checklistContainer.innerHTML = '<p class="empty-state">No active tasks in checklist.</p>';
    return;
  }

  checklistContainer.innerHTML = "";
  tasks.forEach(t => {
    const div = document.createElement("div");
    div.className = "task-item";
    
    // Status text mapping
    let statusLabel = t.status;
    if (t.status === " ") statusLabel = "TODO";
    if (t.status === "/") statusLabel = "RUNNING";
    if (t.status === "x") statusLabel = "DONE";

    div.innerHTML = `
      <span class="task-status status-val-${t.status.replace('/', '\\/') || 'todo'}">${statusLabel}</span>
      <span class="task-text">${t.text}</span>
    `;
    checklistContainer.appendChild(div);
  });
}

// Render Multi-Agent tree hierarchy
function renderAgentsTree(subagents, superagents) {
  const mode = activeModeText.textContent.toLowerCase();
  
  if (mode !== "multi") {
    agentsTree.innerHTML = '<p class="empty-state">Agent tree hierarchy is only active in Multi Mode.</p>';
    return;
  }

  if ((!subagents || subagents.length === 0) && (!superagents || superagents.length === 0)) {
    agentsTree.innerHTML = `
      <div class="agent-node agent-node-master">
        <div class="node-title">Orchestrator Master</div>
        <div class="node-sub">Status: Idle</div>
      </div>
      <p class="empty-state">Waiting to spawn feature Superagents...</p>
    `;
    return;
  }

  agentsTree.innerHTML = "";

  // Master Orchestrator Node
  const masterNode = document.createElement("div");
  masterNode.className = "agent-node agent-node-master";
  masterNode.innerHTML = `
    <div class="node-title">Orchestrator Master</div>
    <div class="node-sub">Status: Active</div>
  `;
  agentsTree.appendChild(masterNode);

  // Render Superagent Nodes
  superagents.forEach(sa => {
    const node = document.createElement("div");
    node.className = "agent-node agent-node-super";
    node.innerHTML = `
      <div class="node-title">Superagent (Role: ${sa.role})</div>
      <div class="node-sub">Status: ${sa.status.toUpperCase()} ${sa.result ? `(${sa.result})` : ''}</div>
    `;
    agentsTree.appendChild(node);
  });

  // Render Subagent Nodes
  subagents.forEach(sub => {
    const node = document.createElement("div");
    node.className = "agent-node agent-node-sub";
    node.innerHTML = `
      <div class="node-title">Subagent (Type: ${sub.typeName})</div>
      <div class="node-sub">Status: ${sub.status.toUpperCase()} ${sub.result ? `(${sub.result})` : ''}</div>
    `;
    agentsTree.appendChild(node);
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
    content.textContent = text;
  }

  msgDiv.appendChild(header);
  msgDiv.appendChild(content);
  chatMessages.appendChild(msgDiv);
  
  scrollToBottom();
  return msgDiv;
}

function showSpinner(text) {
  processingIndicator.classList.add("active");
  processingText.textContent = text;
}

function hideSpinner() {
  processingIndicator.classList.remove("active");
}

function scrollToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

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
            if (act === "navigate") {
              window.location.href = tgt;
              return `Navigated to ${tgt}`;
            }

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
        args: [action, target, value]
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
