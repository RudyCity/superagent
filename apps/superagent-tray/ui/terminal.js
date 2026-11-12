"use strict";

/**
 * SuperAgent Terminal & Process Manager Controller for SuperAgent Tray.
 * Manages running terminal processes, detached console windows, live log tailing,
 * process termination, and preset execution.
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const notifyTerminal = (kind, message) => window.TrayFeedback?.notify({
    kind, message, scope: "terminal",
  });

  const terminalState = {
    tasks: [],
    presets: [],
    runningCount: 0,
    totalCount: 0,
    runningOnly: false, // Show stopped Tray tasks so their Start actions are discoverable.
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
      if (action === "external") {
        return invoke("external_terminal_task_action", {
          taskId: payload.taskId, action: payload.action,
          command: payload.command ?? null, cwd: payload.cwd ?? null,
          operationId: payload.operationId ?? null,
        });
      }
      if (["start", "pause", "resume"].includes(action)) {
        return invoke("control_terminal_task", { taskId: payload.taskId, action });
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
    } else if (action === "external") {
      url = "/api/desktop/terminal/external";
      method = "POST";
      body = JSON.stringify(payload);
    } else if (action === "kill") {
      url = "/api/desktop/terminal/kill";
      method = "POST";
      body = JSON.stringify(payload);
    } else if (["start", "pause", "resume"].includes(action)) {
      url = "/api/desktop/terminal/control";
      method = "POST";
      body = JSON.stringify({ taskId: payload.taskId, action });
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

  const actionMenu = window.SuperAgentActionMenu.createController(document, window);

  /**
   * Render the same guarded process actions into a compact reusable menu.
   * Capability flags come from Core, not inferred from a PID or command label.
   */
  function renderTaskActions(task, label) {
    const active = task.status === "running" || task.status === "paused";
    const external = task.source === "external";
    const unverified = task.status === "unverified";
    const reason = task.controlReason || "Action unavailable: ownership or lifecycle state is not verified.";
    const items = [];
    const enabled = (text, className, data, title, danger = false) =>
      items.push({ label: text, className, data, title, danger });
    const unavailable = (text, why = reason) =>
      items.push({ label: text, className: "terminal-unavailable-btn", disabled: true, title: why });

    if (task.canViewLogs === false) {
      unavailable("Logs unavailable", "Output of external processes is not captured by SuperAgent.");
    } else {
      enabled("View Logs", "terminal-logs-btn", { "task-id": task.id }, "Inspect terminal output");
    }
    items.push({ separator: true });

    if (external) {
      if (task.canConfigureStart === true) {
        enabled("Configure Start", "terminal-external-btn",
          { "task-id": task.id, action: "configure" }, "Save a command and working directory");
      } else {
        unavailable("Configure Start");
      }
      if (task.canStart === true && !active) {
        enabled("Start", "terminal-external-btn",
          { "task-id": task.id, action: "start" }, "Launch the configured command as a new process");
      } else {
        unavailable("Start", active ? "Stop this process before starting a replacement." : reason);
      }
      unavailable("Pause", "External pause requires a SuperAgent-owned process handle.");
      if (task.status === "running" && task.canStop === true) {
        enabled("Stop", "terminal-external-btn", { "task-id": task.id, action: "stop" },
          "Verify process identity and confirm termination", true);
      } else {
        unavailable("Stop");
      }
      items.push({ separator: true });
      enabled("Service Controls", "terminal-manage-btn", { "task-id": task.id },
        "Open verified lifecycle management");
    } else if (unverified) {
      unavailable("Start");
      unavailable("Pause");
      unavailable("Stop");
      items.push({ separator: true });
      enabled("Service Controls", "terminal-manage-btn", { "task-id": task.id },
        "Open verified lifecycle management");
    } else {
      if (task.canStart === true && !active) {
        enabled("Start", "terminal-control-btn", { "task-id": task.id, action: "start" },
          "Start a new process with the original command");
      }
      if (task.canPause === true && task.status === "running") {
        enabled("Pause", "terminal-control-btn", { "task-id": task.id, action: "pause" },
          "Suspend the owned process tree");
      }
      if (task.canResume === true && task.status === "paused") {
        enabled("Resume", "terminal-control-btn", { "task-id": task.id, action: "resume" },
          "Resume the owned process tree");
      }
      if (active && task.canStop !== false) {
        enabled("Stop", "terminal-kill-btn",
          { "task-id": task.id, pid: task.pid, cmd: task.command },
          "Terminate running process tree", true);
      }
    }

    return window.SuperAgentActionMenu.render({
      id: task.id,
      label,
      items,
      note: (external || unverified) ? (
        external && task.canStop === true
          ? "External · Stop requires confirmation"
          : reason
      ) : "",
    });
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
      killAllBtn.disabled = !terminalState.tasks.some((task) => (task.status === "running" || task.status === "paused") && task.source !== "external" && task.canStop !== false);
    }

    // 3. Tasks Table
    const tbody = $("terminal-tasks-tbody");
    if (!tbody) return;
    // Refresh replaces row nodes: release focus, geometry, and ARIA state first.
    actionMenu.close();

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
        const isPaused = t.status === "paused";
        const statusBadge = isRunning
          ? `<span class="pill pill-success"><span class="pill-dot"></span>Running</span>`
          : isPaused
          ? `<span class="pill pill-muted">Paused</span>`
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
          ? (t.canStop === true || t.canStart === true || t.canConfigureStart === true
              ? "External (verified)" : "External (read-only)")
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
            ${renderTaskActions(t, displayLabel)}
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
    $("terminal-refresh-btn")?.addEventListener("click", async () => {
      if (terminalState.loading) return;
      const ticket = window.TrayFeedback?.begin({
        key: "terminal:refresh", button: $("terminal-refresh-btn"), label: "Refreshing…",
      });
      try { await fetchTerminalTasks(); }
      finally { ticket?.end(); }
    });

    // Prune completed/stale tasks button
    $("terminal-prune-btn")?.addEventListener("click", async () => {
      const btn = $("terminal-prune-btn");
      const ticket = window.TrayFeedback?.begin({
        key: "terminal:prune", button: btn, label: "Pruning…",
      });
      if (btn) btn.disabled = true;
      try {
        await invokeTerminal("prune");
        await fetchTerminalTasks();
        notifyTerminal("success", "Completed terminal entries pruned.");
      } catch (err) {
        console.warn("[Terminal] Failed to prune tasks:", err);
        notifyTerminal("error", "Could not prune terminal entries.");
      } finally {
        if (btn) btn.disabled = false;
        ticket?.end();
      }
    });

    // Filter toggle (Running Only vs All). Start with All Tasks visible.
    const filter = $("terminal-filter-running");
    if (filter) filter.checked = terminalState.runningOnly;
    filter?.addEventListener("change", (e) => {
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
      const running = terminalState.tasks.filter((t) => (t.status === "running" || t.status === "paused") && t.source !== "external" && t.canStop !== false);
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
        notifyTerminal("warning", "Enter a command or select a configured preset.");
        return;
      }

      const ticket = window.TrayFeedback?.begin({
        key: "terminal:launch", button: launchBtn, label: "Launching terminal…",
      });
      if (window.TrayFeedback && !ticket) return;
      if (launchBtn) launchBtn.disabled = true;
      try {
        const launched = await invokeTerminal("launch", { command: command || undefined, presetName: presetName || undefined });
        if (launched?.success === false) throw Error("Launch not accepted");
        if (cmdInput) cmdInput.value = "";
        if (presetSelect) presetSelect.value = "";
        await fetchTerminalTasks();
        notifyTerminal("success", "Terminal launch accepted. Check process state.");
      } catch (err) {
        notifyTerminal(/timeout|timed out/i.test(String(err)) ? "warning" : "error",
          /timeout|timed out/i.test(String(err))
            ? "Terminal launch outcome unknown. Inspect processes before retrying."
            : "Terminal launch failed or was not verified.");
      } finally {
        if (launchBtn) launchBtn.disabled = false;
        ticket?.end();
      }
    });

    // Delegation remains the single handler for both table and body-portaled menu items.
    const tableBody = $("terminal-tasks-tbody");
    const onProcessActionClick = async (e) => {
      if (actionMenu.handleClick(e)) return;
      const manageBtn = e.target.closest(".terminal-manage-btn");
      if (manageBtn) {
        // Navigation only; never infer permission to signal an external PID.
        window.navigateToPage?.("runtime");
        return;
      }
      const externalBtn = e.target.closest(".terminal-external-btn");
      if (externalBtn) {
        const taskId = externalBtn.dataset.taskId;
        const action = externalBtn.dataset.action;
        if (!taskId || !["configure", "stop", "start"].includes(action)) return;
        externalBtn.disabled = true;
        try {
          if (action === "configure") {
            const command = window.prompt("Command for a NEW process (not automatically recovered):", "");
            if (!command?.trim()) return;
            const cwd = window.prompt("Absolute working directory for that command:", "");
            if (!cwd?.trim()) return;
            await invokeTerminal("external", { taskId, action, command, cwd });
          } else if (action === "stop") {
            const plan = await invokeTerminal("external", { taskId, action: "plan-stop" });
            const confirmed = window.confirm(`Stop external ${plan.name} (PID ${plan.pid}, ports ${plan.ports.join(", ")})?\nThis forcibly stops this OS process. ${plan.hasRestartCommand ? "A start command has been saved." : "To restart it, configure the command and working directory."}`);
            if (!confirmed) return;
            await invokeTerminal("external", { taskId, action: "stop", operationId: plan.operationId });
          } else {
            if (!window.confirm("Start a NEW managed process using your saved command and working directory?")) return;
            await invokeTerminal("external", { taskId, action: "start" });
          }
          await fetchTerminalTasks();
        } catch (err) {
          window.alert(`External process ${action} failed: ${err?.message || err}`);
        } finally {
          externalBtn.disabled = false;
        }
        return;
      }
      const logsBtn = e.target.closest(".terminal-logs-btn");
      if (logsBtn) {
        const taskId = logsBtn.dataset.taskId;
        if (taskId) openLogModal(taskId);
        return;
      }

      const controlBtn = e.target.closest(".terminal-control-btn");
      if (controlBtn) {
        const taskId = controlBtn.dataset.taskId;
        const action = controlBtn.dataset.action;
        if (!taskId || !["start", "pause", "resume"].includes(action)) return;
        const ticket = window.TrayFeedback?.begin({
          key: "terminal:control:" + taskId, button: controlBtn,
          label: action === "pause" ? "Pausing…" : action === "resume" ? "Resuming…" : "Starting…",
        });
        if (window.TrayFeedback && !ticket) return;
        controlBtn.disabled = true;
        try {
          const result = await invokeTerminal(action, { taskId });
          if (result?.success === false) throw new Error(result.error || "Control action failed");
          await fetchTerminalTasks();
          notifyTerminal("success", "Terminal " + action + " accepted. Inspect the updated state.");
        } catch (err) {
          notifyTerminal(/timeout|timed out/i.test(String(err)) ? "warning" : "error",
            "Terminal " + action + " not verified. Check process status.");
          controlBtn.disabled = false;
        } finally { ticket?.end(); }
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

        const ticket = window.TrayFeedback?.begin({
          key: "terminal:kill:" + taskId, button: killBtn, label: "Stopping process…",
        });
        if (window.TrayFeedback && !ticket) return;
        killBtn.disabled = true;
        try {
          await invokeTerminal("kill", { taskId });
          await fetchTerminalTasks();
          notifyTerminal("success", "Terminal stop request accepted.");
        } catch (err) {
          notifyTerminal(/timeout|timed out/i.test(String(err)) ? "warning" : "error",
            "Terminal stop was not verified. Check process state.");
          killBtn.disabled = false;
        } finally { ticket?.end(); }
      }
    };
    tableBody?.addEventListener("click", onProcessActionClick);
    document.addEventListener("click", (event) => {
      // Popovers are portaled out of overflow-hidden panels and the table.
      if (actionMenu.isOpen() && event.target?.closest?.(".sa-action-menu-item") &&
          event.target?.closest?.(".sa-action-menu-popover") &&
          !tableBody?.contains?.(event.target)) {
        void onProcessActionClick(event);
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
        notifyTerminal("success", "Terminal output copied.");
      } catch {
        notifyTerminal("error", "Could not copy terminal output.");
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
      if (pageTerminal && !pageTerminal.hidden && !actionMenu.isOpen()) {
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
