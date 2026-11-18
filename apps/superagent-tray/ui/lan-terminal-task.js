"use strict";
/**
 * Attended Windows LAN terminal tasks. The UI holds only an opaque job ID and
 * bounded output; credentials and process ownership remain in Core/receiver.
 * A terminal task is piped (not a PTY). Never replay ambiguous mutations.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const selected = () => window.__superagentLanGetSelected?.() || null;
  let task = null;
  let mutationPending = false;
  let readPending = false;
  let lastError = "";

  const validJob = (value) => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
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
    const command = ($("lan-command")?.value || "").trim();
    const input = $("lan-terminal-task-input")?.value || "";
    for (const [name, enabled] of [
      ["lan-terminal-task-start", !mutationPending && Boolean(device) && !running && Boolean(command)],
      ["lan-terminal-task-refresh", !readPending && Boolean(mine)],
      ["lan-terminal-task-stop", Boolean(mine && task.running)],
      ["lan-terminal-task-send", !mutationPending && running && input.length > 0 && input.length <= 1024],
      ["lan-terminal-task-input", !mutationPending && running],
      ["lan-terminal-task-newline", !mutationPending && running],
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
      task.output || "(No output yet)";
    if (lastError) display(lastError, true);
    else if (mutationPending) display("Waiting for target-owner approval...");
    else display(task.running
      ? "Running · " + task.jobId.slice(0, 8) + " · 10-minute maximum, 2-minute idle limit"
      : "Finished · " + (task.reason || "unknown") +
        " · exit code " + (task.exitCode === null ? "n/a" : task.exitCode));
  };
  const apply = (snapshot) => {
    if (!task || !snapshot || snapshot.jobId !== task.jobId ||
        !Number.isSafeInteger(snapshot.nextCursor) || !Array.isArray(snapshot.chunks))
      throw Error("Terminal response did not match the active task.");
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
    task.running = snapshot.running === true;
    task.reason = typeof snapshot.reason === "string" ? snapshot.reason : null;
    task.exitCode = Number.isSafeInteger(snapshot.exitCode) ? snapshot.exitCode : null;
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
    lastError = "";
    display("Approve the full command on the Windows receiver to start a task.");
    sync();
    try {
      const snapshot = await invoke("terminal_start", { deviceId: device.id, command });
      if (!validJob(snapshot.jobId)) throw Error("Invalid terminal task receipt.");
      // Never display output from another device after a route/selection change.
      task = { deviceId: device.id, jobId: snapshot.jobId, cursor: 0,
        running: true, reason: null, exitCode: null, output: "" };
      apply(snapshot);
    } catch (error) {
      lastError = /timeout/i.test(String(error))
        ? "Start outcome unknown. Check the receiver before starting another task."
        : "Task start denied: " + String(error);
    } finally { mutationPending = false; sync(); }
  };
  const poll = async () => {
    if (readPending || !task || !task.running || !sameSelection()) return;
    readPending = true;
    try {
      const snapshot = await invoke("terminal_read", {
        deviceId: task.deviceId, jobId: task.jobId, cursor: task.cursor,
      });
      apply(snapshot);
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
    lastError = "";
    display("The receiver owner must approve this exact input.");
    sync();
    try {
      const snapshot = await invoke("terminal_input", {
        deviceId: task.deviceId, jobId: task.jobId, text,
        appendNewline: $("lan-terminal-task-newline")?.checked === true,
      });
      apply(snapshot);
      if (field) field.value = "";
    } catch (error) {
      lastError = /timeout/i.test(String(error))
        ? "Input outcome unknown. Inspect receiver output before another send."
        : "Input denied: " + String(error);
    } finally { mutationPending = false; sync(); }
  };
  const stop = async () => {
    if (!sameSelection() || !task.running) return;
    const target = { deviceId: task.deviceId, jobId: task.jobId };
    display("Stopping the exact remote task...");
    try {
      const snapshot = await invoke("terminal_stop", target);
      apply(snapshot);
    } catch (error) {
      lastError = "Stop not verified: " + String(error) + ". Close or revoke device session to force cleanup.";
    } finally { sync(); }
  };
  const install = () => {
    $("lan-terminal-task-start")?.addEventListener("click", () => void start());
    $("lan-terminal-task-refresh")?.addEventListener("click", () => void poll());
    $("lan-terminal-task-send")?.addEventListener("click", () => void input());
    $("lan-terminal-task-stop")?.addEventListener("click", () => void stop());
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
