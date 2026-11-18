"use strict";
/**
 * Attended Windows LAN terminal tasks. The UI holds only an opaque job ID and
 * bounded output; credentials and process ownership remain in Core/receiver.
 * Native Bun receivers use ConPTY, older receivers use pipes. Never replay ambiguous mutations.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const selected = () => window.__superagentLanGetSelected?.() || null;
  let task = null;
  let mutationPending = false;
  let readPending = false;
  let lastError = "";
  let mutationRevision = 0;

  const validJob = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
  const validKey = (key) => [
    "Enter", "Backspace", "Tab", "Escape", "ArrowUp", "ArrowDown",
    "ArrowLeft", "ArrowRight", "Home", "End", "Delete", "PageUp", "PageDown", "CtrlC",
  ].includes(key);
  const displayVtLog = (raw) => String(raw || "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\r/g, "\n");

  const invoke = async (action, payload) => {
    const fn = window.__TAURI__?.core?.invoke;
    if (typeof fn !== "function") throw Error("Native SuperAgent Tray required.");
    const reply = await fn("lan_support_action", { action, payload });
    if (!reply || reply.success !== true || !reply.terminal)
      throw Error("Target did not return a confirmed terminal result.");
    return reply.terminal;
  };
  const display = (message, error = false) => {
    const node = $("lan-terminal-task-status");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", error);
  };
  const sameSelection = () => task && selected()?.id === task.deviceId;
  const sync = () => {
    const device = selected();
    const panel = $("lan-terminal-task-panel");
    if (!panel) return;
    panel.hidden = !device || device.platform !== "windows";
    const mine = sameSelection();
    const running = Boolean(mine && task.running);
    const stopping = Boolean(running && task.stopping);
    const conptyReady = Boolean(running && !stopping && task.mode === "conpty");
    const command = ($("lan-command")?.value || "").trim();
    const input = $("lan-terminal-task-input")?.value || "";
    for (const [name, enabled] of [
      ["lan-terminal-task-start", !mutationPending && Boolean(device) && !running && Boolean(command)],
      ["lan-terminal-task-refresh", !readPending && Boolean(mine)],
      ["lan-terminal-task-stop", Boolean(running && !stopping)],
      ["lan-terminal-task-send", !mutationPending && running && !stopping && input.length > 0 && input.length <= 1024],
      ["lan-terminal-task-input", !mutationPending && running && !stopping],
      ["lan-terminal-task-newline", !mutationPending && running && !stopping],
      ["lan-terminal-task-cols", !mutationPending && conptyReady],
      ["lan-terminal-task-rows", !mutationPending && conptyReady],
      ["lan-terminal-task-resize", !mutationPending && conptyReady],
      ["lan-terminal-task-key", !mutationPending && conptyReady],
      ["lan-terminal-task-send-key", !mutationPending && conptyReady],
    ]) if ($(name)) $(name).disabled = !enabled;
    if (!mine) {
      if (!mutationPending) display(device?.platform === "windows"
        ? "No task for the selected approved session. Enter a command above and choose Start task."
        : "Select an approved Windows session to use terminal tasks.");
      if ($("lan-terminal-task-output")) $("lan-terminal-task-output").textContent =
        "No terminal output for this device.";
      return;
    }
    if ($("lan-terminal-task-output")) $("lan-terminal-task-output").textContent =
      displayVtLog(task.output) || "(No output yet)";
    if (lastError) display(lastError, true);
    else if (mutationPending) display("Waiting for target-owner approval...");
    else display(task.stopping ? "Stopping · verifying owned process exit" : task.running
      ? "Running " + (task.mode === "conpty" ? "ConPTY" : "piped fallback") + " · " + task.jobId.slice(0, 8) + " · 10-minute maximum, 2-minute idle limit"
      : "Finished · " + (task.reason || "unknown") +
        " · exit code " + (task.exitCode === null ? "n/a" : task.exitCode));
  };
  const apply = (snapshot) => {
    if (!task || !snapshot || snapshot.jobId !== task.jobId ||
        !Number.isSafeInteger(snapshot.nextCursor) || !Array.isArray(snapshot.chunks))
      throw Error("Terminal response did not match the active task.");
    if (snapshot.nextCursor < task.cursor) return; // stale response must not rewind state
    if (snapshot.truncated) task.output += "\n[Earlier receiver output discarded]\n";
    for (const chunk of snapshot.chunks) {
      if (!chunk || typeof chunk.text !== "string" ||
          !Number.isSafeInteger(chunk.cursor) || chunk.cursor <= task.cursor ||
          !["stdout", "stderr"].includes(chunk.stream))
        continue;
      task.output += chunk.stream === "stderr" ? "[stderr] " + chunk.text : chunk.text;
    }
    task.output = task.output.slice(-65_536);
    task.cursor = snapshot.nextCursor;
    task.latestCursor = Number.isSafeInteger(snapshot.cursor) ? snapshot.cursor : task.cursor;
    task.running = snapshot.running === true;
    task.stopping = snapshot.stopping === true;
    task.reason = typeof snapshot.reason === "string" ? snapshot.reason : null;
    task.exitCode = Number.isSafeInteger(snapshot.exitCode) ? snapshot.exitCode : null;
    task.mode = snapshot.mode === "conpty" ? "conpty" : "pipe";
    task.cols = Number.isSafeInteger(snapshot.cols) ? snapshot.cols : 80;
    task.rows = Number.isSafeInteger(snapshot.rows) ? snapshot.rows : 24;
    lastError = "";
    sync();
    const output = $("lan-terminal-task-output");
    if (output && output.scrollHeight - output.scrollTop - output.clientHeight < 150)
      output.scrollTop = output.scrollHeight;
  };
  const start = async () => {
    const device = selected();
    const command = ($("lan-command")?.value || "").trim();
    if (mutationPending || !device || device.platform !== "windows" ||
        !command || command.length > 2000 || sameSelection() && task.running) return;
    mutationPending = true;
    const revision = ++mutationRevision;
    lastError = "";
    display("Approve the full command on the Windows receiver to start a task.");
    sync();
    try {
      const snapshot = await invoke("terminal_start", { deviceId: device.id, command });
      if (!validJob(snapshot.jobId)) throw Error("Invalid terminal task receipt.");
      // Never display output from another device after a route/selection change.
      if (revision !== mutationRevision) return;
      task = { deviceId: device.id, jobId: snapshot.jobId, cursor: 0, latestCursor: 0,
        running: true, stopping: false, reason: null, exitCode: null, output: "", mode: "pipe", cols: 80, rows: 24 };
      apply(snapshot);
      if ($("lan-terminal-task-cols")) $("lan-terminal-task-cols").value = String(task.cols);
      if ($("lan-terminal-task-rows")) $("lan-terminal-task-rows").value = String(task.rows);
    } catch (error) {
      lastError = /timeout/i.test(String(error))
        ? "Start outcome unknown. Check the receiver before starting another task."
        : "Task start denied: " + String(error);
    } finally { mutationPending = false; sync(); }
  };
  const poll = async () => {
    if (readPending || mutationPending || !task || !sameSelection() ||
        (!task.running && task.cursor >= task.latestCursor)) return;
    const revision = mutationRevision;
    readPending = true;
    try {
      const snapshot = await invoke("terminal_read", {
        deviceId: task.deviceId, jobId: task.jobId, cursor: task.cursor,
      });
      if (revision === mutationRevision) apply(snapshot);
    } catch (error) {
      lastError = "Cannot verify terminal task: " + String(error);
      // Keep opaque task ID and cursor for a deliberate manual retry.
    } finally { readPending = false; sync(); }
  };
  const input = async () => {
    if (mutationPending || !sameSelection() || !task.running) return;
    const field = $("lan-terminal-task-input");
    const text = field?.value || "";
    if (!text || text.length > 1024 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return;
    mutationPending = true;
    const revision = ++mutationRevision;
    lastError = "";
    display("The receiver owner must approve this exact input.");
    sync();
    try {
      const snapshot = await invoke("terminal_input", {
        deviceId: task.deviceId, jobId: task.jobId, text,
        appendNewline: $("lan-terminal-task-newline")?.checked === true,
      });
      if (revision === mutationRevision) {
        apply(snapshot);
        if (field) field.value = "";
      }
    } catch (error) {
      lastError = /timeout/i.test(String(error))
        ? "Input outcome unknown. Inspect receiver output before another send."
        : "Input denied: " + String(error);
    } finally { mutationPending = false; sync(); }
  };
  const resize = async () => {
    if (mutationPending || !sameSelection() || !task.running || task.mode !== "conpty") return;
    const cols = Number($("lan-terminal-task-cols")?.value);
    const rows = Number($("lan-terminal-task-rows")?.value);
    if (!Number.isSafeInteger(cols) || cols < 20 || cols > 300 ||
        !Number.isSafeInteger(rows) || rows < 5 || rows > 120) {
      lastError = "Terminal dimensions must be 20–300 columns and 5–120 rows.";
      sync(); return;
    }
    mutationPending = true;
    const revision = ++mutationRevision;
    lastError = "";
    try {
      const snapshot = await invoke("terminal_resize", {
        deviceId: task.deviceId, jobId: task.jobId, cols, rows,
      });
      if (revision === mutationRevision) apply(snapshot);
    } catch (error) {
      lastError = "Resize not verified: " + String(error);
    } finally { mutationPending = false; sync(); }
  };
  const sendKey = async () => {
    if (mutationPending || !sameSelection() || !task.running || task.mode !== "conpty") return;
    const key = $("lan-terminal-task-key")?.value || "";
    if (!validKey(key)) return;
    mutationPending = true;
    const revision = ++mutationRevision;
    lastError = "";
    display("The receiving PC must approve this key: " + key);
    try {
      const snapshot = await invoke("terminal_key", {
        deviceId: task.deviceId, jobId: task.jobId, key,
      });
      if (revision === mutationRevision) apply(snapshot);
    } catch (error) {
      lastError = /timeout/i.test(String(error))
        ? "Key outcome unknown; inspect the receiver before another send."
        : "Key denied: " + String(error);
    } finally { mutationPending = false; sync(); }
  };
  const stop = async () => {
    if (!sameSelection() || !task.running) return;
    const target = { deviceId: task.deviceId, jobId: task.jobId };
    const revision = ++mutationRevision;
    display("Stopping the exact remote task...");
    try {
      const snapshot = await invoke("terminal_stop", target);
      if (revision === mutationRevision) apply(snapshot);
    } catch (error) {
      lastError = "Stop not verified: " + String(error) + ". Close or revoke device session to force cleanup.";
    } finally { sync(); }
  };
  const install = () => {
    $("lan-terminal-task-start")?.addEventListener("click", () => void start());
    $("lan-terminal-task-refresh")?.addEventListener("click", () => void poll());
    $("lan-terminal-task-send")?.addEventListener("click", () => void input());
    $("lan-terminal-task-stop")?.addEventListener("click", () => void stop());
    $("lan-terminal-task-resize")?.addEventListener("click", () => void resize());
    $("lan-terminal-task-send-key")?.addEventListener("click", () => void sendKey());
    $("lan-terminal-task-input")?.addEventListener("input", sync);
    $("lan-command")?.addEventListener("input", sync);
    $("lan-command-presets")?.addEventListener("change", sync);
    $("lan-terminal-task-clear")?.addEventListener("click", () => {
      if (task) task.output = "";
      lastError = "";
      sync();
    });
    const pollInterval = typeof window.setInterval === "function"
      ? window.setInterval(() => {
        if (document.visibilityState !== "hidden") void poll();
        sync();
      }, 1700) : null;
    window.addEventListener?.("beforeunload", () => {
      if (pollInterval !== null) window.clearInterval?.(pollInterval);
    }, { once: true });
    sync();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
