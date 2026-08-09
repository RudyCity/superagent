// ─── Workspace Header Dropdown Management ────────────────────────────────────────

async function loadSavedWorkspaces() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["savedWorkspaces"], (result) => {
      resolve(result.savedWorkspaces || []);
    });
  });
}

async function saveWorkspace(workspacePath) {
  if (!workspacePath) return;
  const saved = await loadSavedWorkspaces();
  const filtered = saved.filter(w => w !== workspacePath);
  filtered.unshift(workspacePath);
  const trimmed = filtered.slice(0, MAX_SAVED_WORKSPACES);
  return new Promise((resolve) => {
    chrome.storage.local.set({ savedWorkspaces: trimmed }, () => {
      resolve();
    });
  });
}

async function renderWorkspaceListOnly() {
  const selectEl = document.getElementById("quick-workspace-select");
  if (!selectEl) return;

  const saved = await loadSavedWorkspaces();
  const currentPath = activeWorkspaceText ? activeWorkspaceText.textContent : "";

  selectEl.innerHTML = "";

  if (saved.length === 0 && !currentPath) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(No Workspace)";
    selectEl.appendChild(opt);
  } else {
    // Add active path if not in saved list yet
    let allWorkspaces = [...saved];
    if (currentPath && currentPath !== "Not Selected" && !allWorkspaces.includes(currentPath)) {
      allWorkspaces.unshift(currentPath);
    }

    allWorkspaces.forEach(ws => {
      const wsName = ws.split(/[\\/]/).filter(Boolean).pop() || ws;
      const opt = document.createElement("option");
      opt.value = ws;
      opt.textContent = wsName;
      opt.title = ws;
      if (ws === currentPath) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
  }
}

async function switchToWorkspace(workspacePath, mode) {
  if (!workspacePath) return;
  try {
    const res = await fetch(`${BASE_URL}/api/switch-workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: workspacePath, mode })
    });
    const data = await res.json();

    if (data.success) {
      if (data.sessionId) {
        window.currentSessionId = data.sessionId;
      }
      if (activeWorkspaceText) {
        activeWorkspaceText.textContent = data.workspace;
        activeWorkspaceText.title = data.workspace;
      }
      if (activeModeText) {
        activeModeText.textContent = data.mode;
      }
      currentMode = data.mode;

      if (typeof window.updateWorkspaceRequiredUI === "function") {
        window.updateWorkspaceRequiredUI();
      }

      await saveWorkspace(data.workspace);
      await renderWorkspaceListOnly();

      clearChatMessages();
      await loadChatHistory(data.sessionId);
      if (typeof loadChatHistorySessions === "function") {
        await loadChatHistorySessions();
      }

      stopPolling();
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      setupSSE();
      startPolling();

      // Save new last workspace path
      chrome.storage.local.set({ lastWorkspacePath: data.workspace });

      // Refresh monitor and file explorer immediately
      if (typeof pollMonitorData === "function") {
        pollMonitorData();
      }
      if (typeof pollWorkspaceFiles === "function") {
        pollWorkspaceFiles();
      }
      if (typeof loadChatHistorySessions === "function") {
        loadChatHistorySessions();
      }
    } else {
      alert("Failed to switch workspace: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("Error switching workspace: " + err.message);
  }
}

function promptAddNewWorkspace() {
  const newPath = prompt("Enter full absolute path to target workspace directory:");
  if (newPath && newPath.trim()) {
    const trimmedPath = newPath.trim();
    switchToWorkspace(trimmedPath, currentMode || "single");
  }
}

// Attach event listeners for header workspace selection
document.addEventListener("DOMContentLoaded", () => {
  const selectEl = document.getElementById("quick-workspace-select");
  if (selectEl) {
    selectEl.addEventListener("change", (e) => {
      const selectedValue = e.target.value;
      if (selectedValue) {
        switchToWorkspace(selectedValue, currentMode || "single");
      }
    });
  }

  const btnAdd = document.getElementById("btn-header-add-workspace");
  if (btnAdd) {
    btnAdd.addEventListener("click", () => {
      promptAddNewWorkspace();
    });
  }
});

function goToSetupScreen() {
  stopPolling();
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  workspaceScreen.classList.remove("active");
  setupScreen.classList.add("active");
  clearChatMessages();
}

async function syncTrustedWorkspaces(trustedDirs) {
  const saved = await loadSavedWorkspaces();
  let changed = false;
  const newSaved = [...saved];
  for (const dir of trustedDirs) {
    if (!newSaved.includes(dir)) {
      newSaved.push(dir);
      changed = true;
    }
  }
  if (changed) {
    await new Promise((resolve) => {
      chrome.storage.local.set({ savedWorkspaces: newSaved }, () => {
        resolve();
      });
    });
    await renderWorkspaceListOnly();
  }
}
