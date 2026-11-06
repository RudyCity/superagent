"use strict";

/**
 * SuperAgent Terminal & Process Manager Controller for SuperAgent Tray.
 * Manages running terminal processes, detached console windows, live log tailing,
 * process termination, and preset execution.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  const terminalState = {
    tasks: [],
    presets: [],
    runningCount: 0,
    totalCount: 0,
    runningOnly: true, // Default to running processes; All Tasks history is opt-in
    searchQuery: "",
    loading: false,
    pollTimer: null,
    logModalTaskId: null,
    logModalTimer: null,
  };

  const escapeHtml = (str) =>
    String(str ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));

  function formatDuration(ms) {
    if (!ms || ms <= 0) return "< 1s";
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h ${min % 60}m`;
  }

  async function invokeTerminal(action, payload) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") {
      if (action === "list") {
        return invoke("get_terminal_tasks", {
          runningOnly: terminalState.runningOnly ? true : false,
          search: terminalState.searchQuery || null,
        });
      }
      if (action === "kill") {
        return invoke("kill_terminal_task", { taskId: payload.taskId });
      }
      if (action === "launch") {
        return invoke("launch_terminal_task", {
          command: payload.command || null,
          presetName: payload.presetName || null,
        });
      }
      if (action === "logs") {
        return invoke("get_terminal_logs", { taskId: payload.taskId });
      }
      if (action === "presets") {
        return invoke("get_terminal_presets");
      }
      if (action === "prune") {
        return invoke("prune_terminal_tasks");
      }
    }

    // HTTP loopback fallback
    let url = "/api/desktop/terminal/tasks";
    let method = "GET";
    let body = undefined;

    if (action === "list") {
      const q = new URLSearchParams();
      if (terminalState.runningOnly) q.set("runningOnly", "true");
      if (terminalState.searchQuery) q.set("search", terminalState.searchQuery);
      url = `/api/desktop/terminal/tasks?${q.toString()}`;
    } else if (action === "kill") {
      url = "/api/desktop/terminal/kill";
      method = "POST";
      body = JSON.stringify(payload);
    } else if (action === "launch") {
      url = "/api/desktop/terminal/launch";
      method = "POST";
      body = JSON.stringify(payload);
    } else if (action === "logs") {
      url = `/api/desktop/terminal/logs?taskId=${encodeURIComponent(payload.taskId)}`;
    } else if (action === "presets") {
      url = "/api/desktop/terminal/presets";
    } else if (action === "prune") {
      url = "/api/desktop/terminal/prune";
      method = "POST";
    }

    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function fetchTerminalTasks() {
    if (terminalState.loading) return;
    terminalState.loading = true;

    const refreshBtn = $("terminal-refresh-btn");
    if (refreshBtn) refreshBtn.disabled = true;

    try {
      const data = await invokeTerminal("list");
      if (data) {
        terminalState.tasks = data.tasks || [];
        terminalState.runningCount = data.runningCount ?? 0;
        terminalState.totalCount = data.totalCount ?? 0;
        renderTerminalUI();
      }
    } catch (err) {
      console.warn("[Terminal] Failed to fetch terminal tasks:", err);
    } finally {
      terminalState.loading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  async function fetchPresets() {
    try {
      const data = await invokeTerminal("presets");
      if (data?.presets) {
        terminalState.presets = data.presets;
        renderPresetsDropdown();
      }
    } catch (err) {
      console.warn("[Terminal] Failed to fetch presets:", err);
    }
  }

  function renderPresetsDropdown() {
    const select = $("terminal-quick-preset-select");
    if (!select) return;

    if (!terminalState.presets.length) {
      select.innerHTML = '<option value="">No presets configured</option>';
      select.disabled = true;
      return;
    }

    select.disabled = false;
    select.innerHTML =
      '<option value="">-- Choose a configured preset --</option>' +
      terminalState.presets
        .map(
          (p) =>
            `<option value="${escapeHtml(p.name)}">${escapeHtml(p.label || p.name)} (${escapeHtml(
              p.command
            )})</option>`
        )
        .join("");
  }

  function renderTerminalUI() {
    // 1. Metric counters
    const runningEl = $("terminal-stat-running");
    const totalEl = $("terminal-stat-total");
    const presetsEl = $("terminal-stat-presets");

    if (runningEl) runningEl.textContent = String(terminalState.runningCount);
    if (totalEl) totalEl.textContent = String(terminalState.totalCount);
    if (presetsEl) presetsEl.textContent = String(terminalState.presets.length);

    // 2. Kill all button visibility
    const killAllBtn = $("terminal-kill-all-btn");
    if (killAllBtn) {
      killAllBtn.disabled = !terminalState.tasks.some((task) => task.status === "running" && task.canStop !== false);
    }

    // 3. Tasks Table
    const tbody = $("terminal-tasks-tbody");
    if (!tbody) return;

    if (!terminalState.tasks.length) {
      tbody.innerHTML = `<tr>
        <td colspan="6" class="empty-state">
          ${
            terminalState.runningOnly
              ? "No terminal processes currently running.<br /><small class=\"text-secondary\">Switch filter to 'All Tasks' or launch a command below.</small>"
              : "No terminal processes recorded yet."
          }
        </td>
      </tr>`;
      return;
    }

    tbody.innerHTML = terminalState.tasks
      .map((t) => {
        const isRunning = t.status === "running";
        const statusBadge = isRunning
          ? `<span class="pill pill-success"><span class="pill-dot"></span>Running</span>`
          : t.status === "unverified"
          ? `<span class="pill pill-muted">Unverified PID</span>`
          : t.status === "exited"
          ? `<span class="pill pill-muted">Exited${t.exitCode == null ? "" : ` (${t.exitCode})`}</span>`
          : `<span class="pill pill-danger">Killed</span>`;

        const displayLabel = t.windowLabel || t.command.split(" ")[0] || "terminal";
        const pidBadge = t.pid > 0 ? `<code class="font-mono text-cyan">${t.pid}</code>` : "-";
        const sourceLabel = t.source === "mcp"
          ? "MCP"
          : t.source === "agent"
          ? "Agent"
          : t.source === "background"
          ? "Background"
          : t.source === "external"
          ? "External (read-only)"
          : "Tray";

        return `<tr class="terminal-task-row" data-task-id="${escapeHtml(t.id)}">
          <td>
            <div class="terminal-task-name">
              <strong class="terminal-title">${escapeHtml(displayLabel)}</strong>
              <small class="font-mono text-muted">${escapeHtml(sourceLabel)} · ${escapeHtml(t.id)}</small>
            </div>
          </td>
          <td>
            <div class="command-snippet font-mono" title="${escapeHtml(t.command)}">
              <code>${escapeHtml(t.command)}</code>
            </div>
          </td>
          <td>${pidBadge}</td>
          <td>
            <div class="cwd-cell font-mono text-secondary" title="${escapeHtml(t.cwd)}">
              ${escapeHtml(t.cwd)}
            </div>
          </td>
          <td>${statusBadge}</td>
          <td class="text-right">
            <div class="table-actions">
              ${t.canViewLogs === false
                ? `<span class="text-muted" title="This process was started outside SuperAgent; its logs are not captured.">Logs unavailable</span>`
                : `<button type="button" class="button ghost sm terminal-logs-btn" data-task-id="${escapeHtml(t.id)}" title="Inspect terminal stdout logs">View Logs</button>`}
              ${
                isRunning && t.canStop !== false
                  ? `<button type="button" class="button ghost sm danger terminal-kill-btn" data-task-id="${escapeHtml(
                      t.id
                    )}" data-pid="${t.pid}" data-cmd="${escapeHtml(t.command)}" title="Terminate running process tree">
                      Stop
                    </button>`
                  : ""
              }
            </div>
          </td>
        </tr>`;
      })
      .join("");
  }

  async function openLogModal(taskId) {
    terminalState.logModalTaskId = taskId;
    const dialog = $("terminal-log-dialog");
    const titleEl = $("terminal-log-title");
    const cmdEl = $("terminal-log-cmd");
    const consoleEl = $("terminal-log-console");
    const pathEl = $("terminal-log-path");

    if (dialog) dialog.hidden = false;
    if (titleEl) titleEl.textContent = `Terminal Log: ${taskId}`;
    if (consoleEl) consoleEl.textContent = "Loading terminal output...";

    async function loadLogs() {
      try {
        const data = await invokeTerminal("logs", { taskId });
        if (cmdEl) cmdEl.textContent = data.command || taskId;
        if (pathEl) pathEl.textContent = data.logPath || "In-memory stream";
        if (consoleEl) {
          consoleEl.textContent = data.content || "[No output produced yet]";
          consoleEl.scrollTop = consoleEl.scrollHeight;
        }
      } catch (err) {
        if (consoleEl) consoleEl.textContent = `[Failed to load logs: ${err.message}]`;
      }
    }

    await loadLogs();

    // Auto-refresh while modal is open if task is running
    if (terminalState.logModalTimer) clearInterval(terminalState.logModalTimer);
    terminalState.logModalTimer = setInterval(() => {
      if (dialog && !dialog.hidden && terminalState.logModalTaskId === taskId) {
        loadLogs();
      } else {
        clearInterval(terminalState.logModalTimer);
      }
    }, 2000);
  }

  function closeLogModal() {
    terminalState.logModalTaskId = null;
    if (terminalState.logModalTimer) {
      clearInterval(terminalState.logModalTimer);
      terminalState.logModalTimer = null;
    }
    const dialog = $("terminal-log-dialog");
    if (dialog) dialog.hidden = true;
  }

  function setupEventListeners() {
    // Refresh button
    $("terminal-refresh-btn")?.addEventListener("click", fetchTerminalTasks);

    // Prune completed/stale tasks button
    $("terminal-prune-btn")?.addEventListener("click", async () => {
      const btn = $("terminal-prune-btn");
      if (btn) btn.disabled = true;
      try {
        await invokeTerminal("prune");
        await fetchTerminalTasks();
      } catch (err) {
        console.warn("[Terminal] Failed to prune tasks:", err);
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // Filter toggle (Running Only vs All)
    $("terminal-filter-running")?.addEventListener("change", (e) => {
      terminalState.runningOnly = e.target.checked;
      fetchTerminalTasks();
    });

    // Search input
    $("terminal-search-input")?.addEventListener("input", (e) => {
      terminalState.searchQuery = e.target.value.trim();
      fetchTerminalTasks();
    });

    // Kill All Running button
    $("terminal-kill-all-btn")?.addEventListener("click", async () => {
      const running = terminalState.tasks.filter((t) => t.status === "running" && t.canStop !== false);
      if (!running.length) return;

      if (!confirm(`Are you sure you want to terminate ALL ${running.length} running terminal process(es)?`)) {
        return;
      }

      for (const t of running) {
        try {
          await invokeTerminal("kill", { taskId: t.id });
        } catch {}
      }
      await fetchTerminalTasks();
    });

    // Quick Launch Form submission
    $("terminal-quick-launch-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cmdInput = $("terminal-quick-cmd");
      const presetSelect = $("terminal-quick-preset-select");
      const launchBtn = $("terminal-quick-launch-btn");

      const command = cmdInput?.value?.trim();
      const presetName = presetSelect?.value?.trim();

      if (!command && !presetName) {
        alert("Please enter a command to run or select a configured preset.");
        return;
      }

      if (launchBtn) launchBtn.disabled = true;
      try {
        await invokeTerminal("launch", { command: command || undefined, presetName: presetName || undefined });
        if (cmdInput) cmdInput.value = "";
        if (presetSelect) presetSelect.value = "";
        await fetchTerminalTasks();
      } catch (err) {
        alert(`Failed to launch terminal process: ${err.message || err}`);
      } finally {
        if (launchBtn) launchBtn.disabled = false;
      }
    });

    // Table actions delegation (View Logs, Stop)
    $("terminal-tasks-tbody")?.addEventListener("click", async (e) => {
      const logsBtn = e.target.closest(".terminal-logs-btn");
      if (logsBtn) {
        const taskId = logsBtn.dataset.taskId;
        if (taskId) openLogModal(taskId);
        return;
      }

      const killBtn = e.target.closest(".terminal-kill-btn");
      if (killBtn) {
        const taskId = killBtn.dataset.taskId;
        const pid = killBtn.dataset.pid;
        const cmd = killBtn.dataset.cmd;
        if (!taskId) return;

        if (!confirm(`Terminate terminal process ${taskId} (PID: ${pid})?\nCommand: ${cmd}`)) {
          return;
        }

        killBtn.disabled = true;
        try {
          await invokeTerminal("kill", { taskId });
          await fetchTerminalTasks();
        } catch (err) {
          alert(`Failed to terminate process: ${err.message || err}`);
          killBtn.disabled = false;
        }
      }
    });

    // Log modal controls
    $("terminal-log-close")?.addEventListener("click", closeLogModal);
    $("terminal-log-copy")?.addEventListener("click", async () => {
      const consoleEl = $("terminal-log-console");
      if (!consoleEl?.textContent) return;
      try {
        await navigator.clipboard.writeText(consoleEl.textContent);
        const copyBtn = $("terminal-log-copy");
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = orig;
        }, 1500);
      } catch {
        alert("Failed to copy logs to clipboard.");
      }
    });

    // Close modal on escape
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("terminal-log-dialog") && !$("terminal-log-dialog").hidden) {
        closeLogModal();
      }
    });
  }

  function startPolling() {
    if (terminalState.pollTimer) clearInterval(terminalState.pollTimer);
    terminalState.pollTimer = setInterval(() => {
      const pageTerminal = $("page-terminal");
      if (pageTerminal && !pageTerminal.hidden) {
        fetchTerminalTasks();
      }
    }, 4000);
  }

  window.__superagentTerminalRefresh = () => Promise.all([fetchTerminalTasks(), fetchPresets()]);
  window.__superagentTerminalState = terminalState;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupEventListeners();
      fetchPresets();
      startPolling();
    });
  } else {
    setupEventListeners();
    fetchPresets();
    startPolling();
  }
})();
