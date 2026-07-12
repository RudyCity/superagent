// ─── Workspace Left Sidebar Management ────────────────────────────────────────

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
    chrome.storage.local.set({ savedWorkspaces: trimmed }, () => {
      resolve();
    });
  });
}

async function renderWorkspaceListOnly() {
  const saved = await loadSavedWorkspaces();
  const currentPath = activeWorkspaceText.textContent;

  savedWorkspacesList.innerHTML = "";

  if (saved.length === 0) {
    savedWorkspacesList.innerHTML = '<p class="ws-empty text-[10px] text-vscode-muted italic p-2">No saved workspaces yet.</p>';
    return;
  }

  saved.forEach(ws => {
    const isActive = ws === currentPath;
    const item = document.createElement("div");
    item.className = "workspace-item flex items-center justify-between gap-1.5 p-1.5 rounded cursor-pointer text-[10.5px] transition-colors hover:bg-vscode-hover " + (isActive ? "bg-vscode-inner border border-vscode-dim" : "");
    item.title = ws;
    
    // Format display path
    const displayName = ws.length > 25 ? "..." + ws.slice(-22) : ws;
    item.innerHTML = `
      <div class="flex items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
        <span class="ws-dot w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-green-success' : 'bg-vscode-muted'}"></span>
        <span class="ws-path font-mono ${isActive ? 'text-vscode-bright font-medium' : 'text-vscode-primary'}">${displayName}</span>
      </div>
      ${isActive ? '<span class="ws-active-badge text-[8.5px] bg-green-success/20 text-green-success px-1 py-0.5 rounded font-mono font-medium scale-90 shrink-0">active</span>' : ''}
    `;
    
    if (!isActive) {
      item.addEventListener("click", () => {
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
      activeWorkspaceText.title = data.workspace;
      activeModeText.textContent = data.mode;
      currentMode = data.mode;

      await saveWorkspace(data.workspace);
      await renderWorkspaceListOnly();

      clearChatMessages();
      await loadChatHistory();
      if (chatMessages.querySelectorAll(".msg").length === 0) {
        appendMessage("system", `Switched to workspace: ${data.workspace}`);
        appendMessage("system", `Mode: ${data.mode}`);
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
    } else {
      alert("Failed to switch workspace: " + (data.error || "Unknown error"));
    }
  } catch (err) {
    alert("Error switching workspace: " + err.message);
  }
}

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
