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
    item.className = "workspace-item flex items-center gap-2.5 p-2 rounded-lg cursor-pointer border transition-all duration-150 " + 
      (isActive 
        ? "active bg-vscode-inner border-vscode-dim shadow-sm" 
        : "border-transparent hover:bg-vscode-hover");
    item.title = ws;
    
    // Extract workspace name (last component of path)
    const wsName = ws.split(/[\\/]/).filter(Boolean).pop() || ws;
    
    // Get first 1-2 letters of workspace name as initials
    const cleanName = wsName.replace(/[^a-zA-Z0-9\s-_]/g, '');
    const words = cleanName.split(/[-_\s]+/).filter(Boolean);
    let initials = '';
    if (words.length >= 2) {
      initials = (words[0][0] + words[1][0]).toUpperCase();
    } else if (words.length === 1 && words[0].length >= 2) {
      initials = words[0].slice(0, 2).toUpperCase();
    } else if (wsName.length > 0) {
      initials = wsName.slice(0, Math.min(2, wsName.length)).toUpperCase();
    } else {
      initials = 'WS';
    }

    // Dynamic color index based on hash of workspace name
    let hash = 0;
    for (let i = 0; i < wsName.length; i++) {
      hash = wsName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const colorIndex = Math.abs(hash) % 5;
    const colorClass = `ws-avatar-color-${colorIndex}`;

    // Get parent path for clean rendering
    let parentPath = ws;
    const normalized = ws.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash !== -1) {
      parentPath = ws.slice(0, lastSlash);
    }
    let displayPath = parentPath;
    if (displayPath.length > 25) {
      displayPath = "..." + displayPath.slice(-22);
    }

    item.innerHTML = `
      <div class="ws-avatar ${colorClass}">${initials}</div>
      <div class="flex flex-col min-w-0 flex-1 gap-0.5">
        <span class="ws-name text-[11px] font-semibold tracking-wide truncate ${isActive ? 'text-vscode-bright' : 'text-vscode-primary'}">${wsName}</span>
        <span class="ws-path font-mono text-[8.5px] text-vscode-muted truncate">${displayPath}</span>
      </div>
      ${isActive ? '<span class="ws-active-badge text-[8.5px] px-1.5 py-0.5 rounded-full font-medium shrink-0">Active</span>' : ''}
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

      if (typeof window.updateWorkspaceRequiredUI === "function") {
        window.updateWorkspaceRequiredUI();
      }

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
