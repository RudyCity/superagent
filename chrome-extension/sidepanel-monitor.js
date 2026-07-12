// Monitor module for Superagent Chrome Extension (File Changes, Background Processes, & Subagents)

document.addEventListener("DOMContentLoaded", () => {
  const rightPanel = document.getElementById("right-side-panel");
  const toggleBtn = document.getElementById("btn-toggle-right-panel");

  if (!rightPanel || !toggleBtn) return;

  // Load sidebar toggle state from chrome storage
  chrome.storage.local.get(["rightPanelOpen"], (result) => {
    if (result.rightPanelOpen) {
      rightPanel.classList.remove("hidden");
      toggleBtn.classList.add("active");
      pollMonitorData();
      if (typeof pollWorkspaceFiles === "function") {
        pollWorkspaceFiles();
      }
    } else {
      rightPanel.classList.add("hidden");
      toggleBtn.classList.remove("active");
    }
  });

  // Toggle Panel
  toggleBtn.addEventListener("click", () => {
    const isHidden = rightPanel.classList.contains("hidden");
    if (isHidden) {
      rightPanel.classList.remove("hidden");
      toggleBtn.classList.add("active");
      chrome.storage.local.set({ rightPanelOpen: true });
      pollMonitorData();
      if (typeof pollWorkspaceFiles === "function") {
        pollWorkspaceFiles();
      }
    } else {
      rightPanel.classList.add("hidden");
      toggleBtn.classList.remove("active");
      chrome.storage.local.set({ rightPanelOpen: false });
    }
  });

  // Start Polling
  setInterval(pollMonitorData, 3000);
  pollMonitorData();
});

// Get effective BASE_URL
function getMonitorBaseUrl() {
  return typeof BASE_URL !== "undefined" ? BASE_URL : "http://localhost:7888";
}

// Poll monitor data from server
async function pollMonitorData() {
  const rightPanel = document.getElementById("right-side-panel");
  if (!rightPanel || rightPanel.classList.contains("hidden")) return;

  await Promise.all([
    updateGitChanges(),
    updateBackgroundTasks(),
    updateActiveAgents()
  ]);
}

// Fetch and update Git Changes
async function updateGitChanges() {
  const container = document.getElementById("file-changes-container");
  const badge = document.getElementById("changes-count-badge");
  if (!container) return;

  try {
    const baseUrl = getMonitorBaseUrl();
    const res = await fetch(`${baseUrl}/api/git/changes`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.success && Array.isArray(data.changes)) {
      const changes = data.changes;
      if (badge) {
        if (changes.length > 0) {
          badge.textContent = changes.length;
          badge.classList.remove("hidden");
        } else {
          badge.classList.add("hidden");
        }
      }

      if (changes.length === 0) {
        container.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px] italic">No file changes detected</div>';
        return;
      }

      container.innerHTML = "";
      changes.forEach(c => {
        const item = document.createElement("div");
        item.className = "monitor-item flex items-center justify-between p-1.5 rounded-sm bg-vscode-inner border border-vscode-dim text-[11px]";

        // Style the status badge
        let statusClass = "bg-vscode-muted/20 text-vscode-muted";
        let statusLabel = c.status;
        if (c.status === "M") {
          statusClass = "bg-amber-warning/20 text-amber-warning border border-amber-warning/30";
          statusLabel = "Mod";
        } else if (c.status === "A" || c.status === "??") {
          statusClass = "bg-green-success/20 text-green-success border border-green-success/30";
          statusLabel = c.status === "??" ? "New" : "Add";
        } else if (c.status === "D") {
          statusClass = "bg-red-error/20 text-red-error border border-red-error/30";
          statusLabel = "Del";
        }

        const filename = c.filepath.split("/").pop().split("\\").pop();

        item.innerHTML = `
          <div class="flex items-center gap-2 overflow-hidden flex-1 mr-2">
            <span class="px-1 py-0.5 rounded-[2px] font-mono text-[9px] font-bold ${statusClass}">${statusLabel}</span>
            <span class="font-mono text-vscode-light overflow-hidden text-ellipsis whitespace-nowrap" title="${c.filepath}">${filename}</span>
          </div>
        `;
        container.appendChild(item);
      });
    }
  } catch (err) {
    console.error("Failed to update git changes:", err);
  }
}

// Fetch and update Background Tasks
async function updateBackgroundTasks() {
  const container = document.getElementById("bg-tasks-container");
  const badge = document.getElementById("bg-tasks-count-badge");
  if (!container) return;

  try {
    const baseUrl = getMonitorBaseUrl();
    const res = await fetch(`${baseUrl}/api/background-tasks`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.success && Array.isArray(data.tasks)) {
      const tasks = data.tasks.filter(t => !t.hasExited);
      if (badge) {
        if (tasks.length > 0) {
          badge.textContent = tasks.length;
          badge.classList.remove("hidden");
        } else {
          badge.classList.add("hidden");
        }
      }

      if (tasks.length === 0) {
        container.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px] italic">No active processes</div>';
        return;
      }

      container.innerHTML = "";
      tasks.forEach(t => {
        const item = document.createElement("div");
        item.className = "monitor-item flex flex-col gap-1 p-2 rounded-sm bg-vscode-inner border border-vscode-dim text-[11px]";

        const title = t.command.length > 40 ? t.command.slice(0, 37) + "..." : t.command;

        item.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <span class="font-mono text-vscode-bright font-bold overflow-hidden text-ellipsis whitespace-nowrap flex-1" title="${t.command}">${title}</span>
            <button class="btn-kill-task px-1.5 py-0.5 text-[9px] bg-red-error/20 hover:bg-red-error text-red-error hover:text-white rounded-[2px] border border-red-error/30 cursor-pointer transition-colors duration-150" data-id="${t.id}">Kill</button>
          </div>
          <div class="flex justify-between items-center text-[9px] text-vscode-muted font-mono">
            <span>PID: ${t.id}</span>
            <span class="text-green-success font-semibold">Running</span>
          </div>
        `;

        item.querySelector(".btn-kill-task").addEventListener("click", async (e) => {
          const btn = e.target;
          btn.disabled = true;
          btn.textContent = "Killing...";
          const success = await killBackgroundTask(t.id);
          if (success) {
            updateBackgroundTasks();
          } else {
            btn.disabled = false;
            btn.textContent = "Kill";
          }
        });

        container.appendChild(item);
      });
    }
  } catch (err) {
    console.error("Failed to update background tasks:", err);
  }
}

// Kill background task
async function killBackgroundTask(id) {
  try {
    const baseUrl = getMonitorBaseUrl();
    const res = await fetch(`${baseUrl}/api/background-tasks/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    return res.ok;
  } catch (err) {
    console.error("Failed to kill task:", err);
    return false;
  }
}

// Fetch and update Active Agents
async function updateActiveAgents() {
  const container = document.getElementById("active-agents-container");
  const badge = document.getElementById("agents-count-badge");
  if (!container) return;

  try {
    const baseUrl = getMonitorBaseUrl();
    const res = await fetch(`${baseUrl}/api/instances`);
    if (!res.ok) return;
    const data = await res.json();

    const runningSubagents = (data.subagents || []).filter(s => s.status === "running");
    const runningSuperagents = (data.superagents || []).filter(s => s.status === "running");
    const totalRunning = runningSubagents.length + runningSuperagents.length;

    if (badge) {
      if (totalRunning > 0) {
        badge.textContent = totalRunning;
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }

    if (totalRunning === 0) {
      container.innerHTML = '<div class="p-3 text-center text-vscode-muted text-[11px] italic">No active agents</div>';
      return;
    }

    container.innerHTML = "";

    // Render Superagents
    runningSuperagents.forEach(agent => {
      const item = document.createElement("div");
      item.className = "monitor-item flex flex-col gap-1 p-2 rounded-sm bg-vscode-inner border border-vscode-dim text-[11px]";
      item.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold text-vscode-bright overflow-hidden text-ellipsis whitespace-nowrap" title="${agent.role}">${agent.role}</span>
          <span class="px-1.5 py-0.5 text-[9px] bg-vscode-blue/20 text-vscode-blue border border-vscode-blue/30 rounded-[2px] font-mono">Superagent</span>
        </div>
        <div class="flex justify-between items-center text-[9px] text-vscode-muted font-mono">
          <span>ID: ${agent.id.slice(0, 8)}</span>
          <span class="text-green-success font-semibold">Running</span>
        </div>
      `;
      container.appendChild(item);
    });

    // Render Subagents
    runningSubagents.forEach(agent => {
      const item = document.createElement("div");
      item.className = "monitor-item flex flex-col gap-1 p-2 rounded-sm bg-vscode-inner border border-vscode-dim text-[11px]";
      item.innerHTML = `
        <div class="flex items-center justify-between gap-2">
          <span class="font-bold text-vscode-bright overflow-hidden text-ellipsis whitespace-nowrap" title="${agent.typeName}">${agent.typeName}</span>
          <span class="px-1.5 py-0.5 text-[9px] bg-purple-500/20 text-purple-400 border border-purple-500/30 rounded-[2px] font-mono">Subagent</span>
        </div>
        <div class="flex justify-between items-center text-[9px] text-vscode-muted font-mono">
          <span>ID: ${agent.id.slice(0, 8)}</span>
          <span class="text-green-success font-semibold">Running</span>
        </div>
      `;
      container.appendChild(item);
    });

  } catch (err) {
    console.error("Failed to update active agents:", err);
  }
}
