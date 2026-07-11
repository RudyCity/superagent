// ─── Workspace Switcher ──────────────────────────────────────────────────────

async function loadSavedWorkspaces() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["savedWorkspaces"], (result) => {
      resolve(result.savedWorkspaces || []);
    });
  });
}

async function saveWorkspace(workspacePath) {
  const saved = await loadSavedWorkspaces();
  const filtered = saved.filter(w => w !== workspacePath);
  filtered.unshift(workspacePath);
  const trimmed = filtered.slice(0, MAX_SAVED_WORKSPACES);
  return new Promise((resolve) => {
    chrome.storage.local.set({ savedWorkspaces: trimmed }, resolve);
  });
}

async function renderWorkspaceDropdown() {
  const saved = await loadSavedWorkspaces();
  const currentPath = activeWorkspaceText.textContent;

  savedWorkspacesList.innerHTML = "";

  if (saved.length === 0) {
    savedWorkspacesList.innerHTML = '<p class="ws-empty">No saved workspaces yet.</p>';
    return;
  }

  saved.forEach(ws => {
    const isActive = ws === currentPath;
    const item = document.createElement("div");
    item.className = "workspace-item" + (isActive ? " active" : "");
    item.title = ws;
    item.innerHTML = `
      <span class="ws-dot"></span>
      <span class="ws-path">${ws}</span>
      ${isActive ? '<span class="ws-active-badge">active</span>' : ''}
    `;
    if (!isActive) {
      item.addEventListener("click", () => {
        hideWorkspaceDropdown();
        switchToWorkspace(ws, currentMode);
      });
    }
    savedWorkspacesList.appendChild(item);
  });
}

async function switchToWorkspace(workspacePath, mode) {
  try {
    const res = await fetch(`${BASE_URL}/api/switch-workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspacePath, mode })
    });
    const data = await res.json();

    if (data.success) {
      activeWorkspaceText.textContent = data.workspace;
      activeModeText.textContent = data.mode;
      currentMode = data.mode;

      await saveWorkspace(data.workspace);

      clearChatMessages();
      appendMessage("system", `Switched to workspace: ${data.workspace}`);
      appendMessage("system", `Mode: ${data.mode}`);

      stopPolling();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setupSSE();
      startPolling();

      // Save new last workspace path
      chrome.storage.local.set({ lastWorkspacePath: data.workspace });
    } else {
      alert("Failed to switch workspace: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("Error switching workspace: " + err.message);
  }
}

function toggleWorkspaceDropdown() {
  if (workspaceDropdownOpen) {
    hideWorkspaceDropdown();
  } else {
    showWorkspaceDropdown();
  }
}

function showWorkspaceDropdown() {
  workspaceDropdownOpen = true;
  workspaceDropdown.classList.remove("hidden");
  btnSwitchWorkspace.classList.add("open");
  renderWorkspaceDropdown();
}

function hideWorkspaceDropdown() {
  workspaceDropdownOpen = false;
  workspaceDropdown.classList.add("hidden");
  btnSwitchWorkspace.classList.remove("open");
}

function goToSetupScreen() {
  if (activeAgent && typeof activeAgent.abort === "function") {
    // Signal abort but don't wait
  }
  stopPolling();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  workspaceScreen.classList.remove("active");
  setupScreen.classList.add("active");
  clearChatMessages();
}
