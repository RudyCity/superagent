/**
 * Synchronous and bounded terminal workflows over CDP, sharing the Chrome CDP
 * connection manager. No hidden process execution, no background listeners.
 */
import { randomBytes } from "node:crypto";
import type { CdpTarget } from "./chromeCdpHelpers.js";
import { buildReadTerminalJs, formatTerminalReadResult, type TerminalResult } from "./chromeCdpTerminal.js";
import { buildFocusTerminalJs, terminalKeyEvent, type TerminalFocusResult } from "./chromeCdpTerminalInput.js";
import {
  observeTerminal, getTerminalSessions, clearTerminalSessions,
  terminalCommandRisk, recordTerminalAction, setPendingTerminalVerification,
  pendingTerminalVerification, clearPendingTerminalVerification,
} from "./chromeCdpTerminalEngine.js";

export interface TerminalCdpDeps {
  pickTarget(targetId?: string, autoActivate?: boolean, requireExplicitWhenMultiple?: boolean): Promise<CdpTarget>;
  send(target: CdpTarget, method: string, params?: Record<string, unknown>): Promise<any>;
  scopeTarget?(target: CdpTarget): string;
}
const writers = new Set<string>();
type MultilineMode = "reject" | "bracketed" | "base64" | "raw";
export function prepareTerminalInput(text: string, payload: Record<string, unknown>): {
  ok: boolean; text: string; mode: string; reason?: string
} {
  const multiline = /[\r\n]/.test(text);
  const requested = payload.multiline_mode;
  if (requested !== undefined && !["reject", "bracketed", "base64", "raw"].includes(String(requested))) {
    return { ok: false, text: "", mode: "", reason: "multiline_mode must be reject, bracketed, base64 or raw." };
  }
  if (!multiline) return { ok: true, text, mode: "single" };
  const mode = (requested || (/<<[^\n]*\n/.test(text) ? "base64" : "bracketed")) as MultilineMode;
  if (mode === "reject") {
    return { ok: false, text: "", mode, reason: "multiline terminal input rejected by multiline_mode." };
  }
  if (mode === "raw") {
    if (payload.allow_dangerous !== true) {
      return { ok: false, text: "", mode, reason: "raw multi-line input can execute partial commands; explicit allow_dangerous:true required." };
    }
    return { ok: true, text, mode };
  }
  if (mode === "base64") {
    if (payload.verify_shell !== "posix") {
      return { ok: false, text: "", mode, reason: "base64 multiline mode requires verify_shell:'posix' (known bash environment)." };
    }
    const encoded = Buffer.from(text, "utf8").toString("base64");
    // Encode the original command, not a user-supplied shell fragment.
    return { ok: true, text: "printf '%s' '" + encoded + "' | base64 -d | bash", mode };
  }
  // Bracketed-paste support varies by terminal and shell. It is never used to
  // claim atomic execution or a verified exit status.
  return { ok: true, text: "\x1b[200~" + text.replace(/\r\n/g, "\n") + "\x1b[201~", mode };
}
const num = (v: unknown, fallback: number, max: number): number => {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? fallback : Math.max(0, Math.min(max, Math.floor(n)));
};
const terminalOpts = (payload: Record<string, unknown>) => ({
  selector: typeof payload.selector === "string" ? payload.selector : undefined,
  index: payload.index === undefined ? undefined : Number(payload.index),
  terminal_id: typeof payload.terminal_id === "string" ? payload.terminal_id : undefined,
});
export function checkTerminalPayload(payload: Record<string, unknown>): string | null {
  if (payload.index !== undefined &&
      (!Number.isSafeInteger(Number(payload.index)) || Number(payload.index) < 0 || Number(payload.index) > 1000)) {
    return "terminal index must be an integer between 0 and 1000.";
  }
  if (payload.terminal_id !== undefined &&
      (typeof payload.terminal_id !== "string" || !/^term-[a-z0-9]+-\d{1,6}$/i.test(payload.terminal_id))) {
    return "Invalid opaque terminal_id. Obtain a current id from read_terminal.";
  }
  return null;
}
async function capture(target: CdpTarget, payload: Record<string, unknown>, deps: TerminalCdpDeps): Promise<TerminalResult> {
  const res = await deps.send(target, "Runtime.evaluate", {
    expression: buildReadTerminalJs({
      ...terminalOpts(payload),
      max_lines: payload.max_lines === undefined ? 80 : Number(payload.max_lines),
      max_chars: payload.max_chars === undefined ? 20000 : Number(payload.max_chars),
      viewport_only: payload.viewport_only === true,
    }),
    returnByValue: true,
  });
  if (res?.exceptionDetails) throw new Error("Terminal read page evaluation failed.");
  const value = res?.result?.value as TerminalResult;
  if (!value || !Array.isArray(value.terminals)) throw new Error("Terminal read returned no structured data.");
  return value;
}
async function visualFallback(
  target: CdpTarget, pane: TerminalResult["terminals"][number], deps: TerminalCdpDeps,
): Promise<Record<string, unknown>> {
  const rect = pane.rect;
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return { status: "unavailable", source: "unavailable", reason: "Terminal has no visible bounding box for screenshot.", terminalId: pane.terminalId };
  }
  try {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const width = Math.min(1400, Math.ceil(rect.width - Math.max(0, -rect.x)));
    const height = Math.min(900, Math.ceil(rect.height - Math.max(0, -rect.y)));
    if (width < 1 || height < 1) throw new Error("terminal is off-screen");
    const shot = await deps.send(target, "Page.captureScreenshot", {
      format: "png", fromSurface: true, captureBeyondViewport: false,
      clip: { x, y, width, height, scale: 1 },
    });
    const data = typeof shot?.data === "string" ? shot.data : "";
    return {
      status: "visual_only_unverified", source: "canvas-visual", terminalId: pane.terminalId,
      completionVerified: false, exitCode: null, output: null,
      rect: { x, y, width, height }, screenshot: data && data.length <= 1_500_000 ? "data:image/png;base64," + data : null,
      warning: "Screenshot pixels only; no text, output change, shell exit code or command completion can be verified."
        + (data.length > 1_500_000 ? " Image was omitted due to size." : ""),
    };
  } catch (err) {
    return { status: "unavailable", source: "unavailable", terminalId: pane.terminalId,
      reason: "Terminal screenshot failed: " + (err instanceof Error ? err.message : String(err)) };
  }
}
const wantsVisual = (payload: Record<string, unknown>) =>
  payload.allow_visual_fallback === true || payload.auto_crop_screenshot === true;

async function focusAndDispatch(
  target: CdpTarget, payload: Record<string, unknown>, command: string, deps: TerminalCdpDeps
): Promise<{ ok: boolean; message: string; focus?: TerminalFocusResult }> {
  const text = typeof payload.text === "string" ? payload.text : "";
  const isWrite = command === "write_terminal";
  if (isWrite && !text) return { ok: false, message: 'write_terminal requires nonempty payload {"text":"..."}.' };
  if (isWrite && text.length > 4000) return { ok: false, message: "write_terminal text exceeds 4000 characters." };
  const prepared = isWrite ? prepareTerminalInput(text, payload) : { ok: true, text: "", mode: "single" };
  if (!prepared.ok) return { ok: false, message: prepared.reason || "terminal input rejected." };
  if (isWrite && prepared.text.length > 8000) return { ok: false, message: "encoded terminal input exceeds 8000 characters." };
  // A multiline paste can execute even without a final Enter on some shells.
  const risk = isWrite && (payload.enter === true || /[\r\n]/.test(text))
    ? terminalCommandRisk(text, true) : { blocked: false, reason: "" };
  if (risk.blocked && payload.allow_dangerous !== true) return { ok: false, message: risk.reason };
  const key = isWrite ? "Enter" : String(payload.key || "");
  const keyEvent = terminalKeyEvent(key);
  if (!isWrite && !keyEvent) return { ok: false, message: "unsupported terminal key." };
  const response = await deps.send(target, "Runtime.evaluate", {
    expression: buildFocusTerminalJs(terminalOpts(payload)),
    returnByValue: true,
  });
  if (response?.exceptionDetails) return { ok: false, message: "terminal focus evaluation raised an exception." };
  const focus = response?.result?.value as TerminalFocusResult | undefined;
  if (!focus?.ok) return { ok: false, message: "terminal input not sent: " + (focus?.reason || "could not focus input.") };
  if (isWrite) await deps.send(target, "Input.insertText", { text: prepared.text });
  if ((!isWrite || payload.enter === true) && keyEvent) {
    if (key.toLowerCase() === "enter") {
      // Chrome's native Enter path: one raw keydown, one char, one keyup.
      const { text: _text, unmodifiedText: _unmodified, ...rawDown } = keyEvent.down;
      await deps.send(target, "Input.dispatchKeyEvent", { ...rawDown, type: "rawKeyDown" });
      await deps.send(target, "Input.dispatchKeyEvent", {
        type: "char", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13,
        text: "\r", unmodifiedText: "\r",
      });
    } else {
      await deps.send(target, "Input.dispatchKeyEvent", keyEvent.down);
    }
    await deps.send(target, "Input.dispatchKeyEvent", keyEvent.up);
  }
  const destination = "terminal [" + focus.terminalIndex + "] " + (focus.kind || "web-terminal");
  recordTerminalAction(deps.scopeTarget?.(target) || target.id,
    focus.terminalId || "index:" + focus.terminalIndex, command, true);
  return {
    ok: true, focus,
    message: isWrite
      ? "dispatched " + text.length + " character(s) to " + destination + " using " + prepared.mode + " mode" +
        (payload.enter === true ? " and sent Enter" : " (Enter not sent)") +
        ". Input was dispatched; command execution is not verified."
      : "dispatched key " + key + " to " + destination + ". Key was dispatched; terminal reaction is not verified.",
  };
}

async function pollTerminal(
  target: CdpTarget, payload: Record<string, unknown>, deps: TerminalCdpDeps,
  options: { waitMs: number; expected: string; marker?: string }
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + options.waitMs;
  let combined = "";
  let polls = 0;
  let last: ReturnType<typeof observeTerminal> | null = null;
  let foundExitCode: number | null = null;
  while (true) {
    const result = await capture(target, { ...payload, max_lines: payload.max_lines ?? 200 }, deps);
    if (result.terminals.length !== 1) {
      return { status: "unavailable", reason: "Watch requires one matching terminal; specify index or terminal_id.", detected: result.detected };
    }
    const term = result.terminals[0];
    if (term.source === "unavailable") {
      return wantsVisual(payload) ? await visualFallback(target, term, deps)
        : { status: "unavailable", reason: term.warning };
    }
    const scope = deps.scopeTarget?.(target) || target.id;
    last = observeTerminal(scope, term);
    const verificationMarker = options.marker || pendingTerminalVerification(scope, last.session.terminalId) || undefined;
    polls++;
    if (last.delta) combined = (combined + (combined ? "\n" : "") + last.delta).slice(-12000);
    if (verificationMarker) {
      // The completion marker must be a standalone terminal output line, not
      // simply a substring of the echoed command line.
      const match = combined.match(new RegExp("(?:^|\\n)" + verificationMarker + ":(-?\\d+)(?:\\r?\\n|$)"));
      if (match) {
        foundExitCode = Number(match[1]);
        if (Number.isSafeInteger(foundExitCode)) {
          clearPendingTerminalVerification(scope, last.session.terminalId);
          break;
        }
      }
    }
    if (options.expected && combined.includes(options.expected)) break;
    if (last.changed && !options.expected && !verificationMarker) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(400, Math.max(1, deadline - Date.now()))));
  }
  return {
    status: foundExitCode !== null ? "exit_code_observed" :
      (options.expected && combined.includes(options.expected)) ? "expected_output_observed" :
      last?.changed ? "output_changed_unverified" : "timed_out_unverified",
    exitCode: foundExitCode,
    completionVerified: foundExitCode !== null,
    expectedOutputMatched: !!(options.expected && combined.includes(options.expected)),
    output: combined.replace(options.marker ? new RegExp("(?:^|\\n)" + options.marker + ":-?\\d+(?:\\r?\\n|$)") : /(?!)^/, "\n").slice(-12000),
    reset: last?.reset || false, cursor: last?.cursor ?? null,
    terminalId: last?.session.terminalId || null, agent: last?.session.agent || null, polls,
  };
}

function verifiedShellLine(original: string, shell: "posix" | "powershell", marker: string): string {
  if (shell === "posix") {
    return original + "; __sa_exit=$?; printf '\\n" + marker + ":%s\\n' \"$__sa_exit\"";
  }
  return original + "; $__sa_exit = if ($?) { 0 } else { if ($LASTEXITCODE) { $LASTEXITCODE } else { 1 } }; Write-Output \"" +
    marker + ":$__sa_exit\"";
}

export async function executeCdpTerminalCommand(
  command: string,
  payload: Record<string, unknown>,
  targetId: string | undefined,
  deps: TerminalCdpDeps,
): Promise<string> {
  if (command === "list_terminal_sessions" || command === "monitor_terminal_agents") {
    const sessions = getTerminalSessions().map((s) => ({
      targetId: s.targetId, terminalId: s.terminalId, index: s.index,
      kind: s.kind, source: s.source, agent: s.agent, updatedAt: s.updatedAt,
      changedAt: s.changedAt, cursor: s.cursor, outputChars: s.outputChars, recentActions: s.recentActions,
    }));
    return JSON.stringify({ sessions: command === "monitor_terminal_agents" ? sessions.filter((s) => s.agent) : sessions });
  }
  if (command === "clear_terminal_sessions") {
    clearTerminalSessions(typeof payload.targetId === "string" ? payload.targetId : undefined);
    return "control_chrome_cdp: terminal observation cache cleared (no terminal processes affected).";
  }
  const bad = checkTerminalPayload(payload);
  if (bad) return "control_chrome_cdp failed: " + bad;
  const needsWriter = ["write_terminal", "send_terminal_key", "execute_terminal"].includes(command);
  const target = await deps.pickTarget(targetId, false, needsWriter);
  const scope = deps.scopeTarget?.(target) || target.id;
  if (needsWriter) {
    if (writers.has(scope)) return "control_chrome_cdp failed: terminal writer busy for this CDP target; retry after the active command completes.";
    writers.add(scope);
  }
  try {
    if (command === "read_terminal" || command === "read_terminal_delta") {
      const result = await capture(target, payload, deps);
      const observations = result.terminals.map((pane) => {
        if (pane.source === "unavailable") return { index: pane.index, terminalId: pane.terminalId, status: "unavailable", warning: pane.warning };
        const o = observeTerminal(scope, pane);
        return { index: pane.index, terminalId: pane.terminalId, changed: o.changed, delta: o.delta,
          cursor: o.cursor, reset: o.reset, agent: o.session.agent, source: pane.source };
      });
      if (wantsVisual(payload) && result.terminals.length === 1 && result.terminals[0].source === "unavailable") {
        return JSON.stringify(await visualFallback(target, result.terminals[0], deps));
      }
      return command === "read_terminal"
        ? formatTerminalReadResult(result)
        : JSON.stringify({ detected: result.detected, observations, warning: result.warning });
    }
    if (command === "recover_terminal") {
      let result = await capture(target, payload, deps);
      let rebound = false;
      if (result.terminals.length !== 1 && payload.rebind_on_reload === true && payload.terminal_id) {
        // A previous opaque ID is invalid after page reload; rebind only when
        // the new page exposes exactly one pane. Never silently guess among many.
        result = await capture(target, { ...payload, terminal_id: undefined, index: undefined }, deps);
        rebound = result.terminals.length === 1;
      }
      if (result.terminals.length !== 1) {
        return JSON.stringify({ status: "unavailable", rebound: false,
          reason: "Cannot identify a unique terminal after reconnect. Run list_targets/read_terminal and choose a new terminal_id.",
          detected: result.detected });
      }
      const pane = result.terminals[0];
      const o = pane.source === "unavailable" ? null : observeTerminal(scope, pane);
      return JSON.stringify({ status: o ? "connected" : "unavailable", rebound,
        targetId: target.id, terminalId: pane.terminalId, index: pane.index,
        source: pane.source, cursor: o?.cursor ?? null,
        warning: rebound ? "Terminal id changed after reload; verify identity before writing." : pane.warning });
    }
    if (command === "write_terminal" || command === "send_terminal_key") {
      const res = await focusAndDispatch(target, payload, command, deps);
      return "control_chrome_cdp" + (res.ok ? ": " : " failed: ") + res.message;
    }
    if (command === "watch_terminal") {
      // A fresh watcher must not interpret historical scrollback as new output.
      const baseline = await capture(target, payload, deps);
      if (baseline.terminals.length === 1 && baseline.terminals[0].source !== "unavailable") {
        const pane = baseline.terminals[0];
        const id = pane.terminalId || "index:" + pane.index;
        if (!getTerminalSessions().some((s) => s.targetId === scope && s.terminalId === id)) {
          observeTerminal(scope, pane);
        }
      }
      return JSON.stringify(await pollTerminal(target, payload, deps, {
        waitMs: num(payload.wait_ms, 5000, 15000),
        expected: String(payload.expected_output || "").slice(0, 250),
      }));
    }
    if (command === "execute_terminal") {
      const original = typeof payload.text === "string" ? payload.text : "";
      if (!original || original.length > 3400) return "control_chrome_cdp failed: execute_terminal requires 1-3400 characters of text.";
      const risk = terminalCommandRisk(original, true);
      if (risk.blocked && payload.allow_dangerous !== true) return "control_chrome_cdp failed: " + risk.reason;
      const shell = payload.verify_shell;
      if (shell !== undefined && shell !== "posix" && shell !== "powershell") {
        return "control_chrome_cdp failed: verify_shell must be posix or powershell.";
      }
      // Establish baseline before writing; never count stale scrollback as new output.
      const baseline = await capture(target, { ...payload, max_lines: payload.max_lines ?? 200 }, deps);
      if (baseline.terminals.length !== 1 || (baseline.terminals[0].source === "unavailable" && !wantsVisual(payload))) {
        return "control_chrome_cdp failed: execute_terminal needs exactly one readable terminal (or explicitly opt into allow_visual_fallback); use read_terminal and select terminal_id.";
      }
      const base = baseline.terminals[0];
      const session = base.source === "unavailable" ? null : observeTerminal(scope, base).session;
      if (session && pendingTerminalVerification(scope, session.terminalId) && payload.force_new_command !== true) {
        return "control_chrome_cdp failed: a previous shell-marker command is still awaiting completion. Use watch_terminal or explicit force_new_command:true.";
      }
      const prepared = prepareTerminalInput(original, payload);
      if (!prepared.ok) return "control_chrome_cdp failed: " + prepared.reason;
      // For multiline scripts, base64 packages the original script into one
      // shell line. Never run bracketed-paste escape bytes through an exit marker.
      if (/[\r\n]/.test(original) && prepared.mode === "bracketed" && shell) {
        return "control_chrome_cdp failed: verified multiline scripts require multiline_mode:'base64' and verify_shell:'posix'.";
      }
      const marker = shell ? "__SA_EXIT_" + randomBytes(10).toString("hex") : undefined;
      const line = prepared.mode === "bracketed" ? original
        : marker ? verifiedShellLine(prepared.text, shell as "posix" | "powershell", marker) : prepared.text;
      if (line.length > 8000) return "control_chrome_cdp failed: wrapped command exceeds 8000 characters.";
      const sent = await focusAndDispatch(target, {
        ...payload, index: base.index, terminal_id: base.terminalId, text: line, enter: true,
        multiline_mode: prepared.mode === "bracketed" ? "bracketed" : prepared.mode === "raw" ? "raw" : undefined,
      }, "write_terminal", deps);
      if (!sent.ok) return "control_chrome_cdp failed: " + sent.message;
      if (marker && session) setPendingTerminalVerification(scope, session.terminalId, marker);
      const result = await pollTerminal(target, {
        ...payload, index: base.index, terminal_id: base.terminalId,
      }, deps, {
        waitMs: num(payload.wait_ms, 6000, 15000),
        expected: String(payload.expected_output || "").slice(0, 250),
        marker,
      });
      return JSON.stringify({ command: "execute_terminal", dispatched: true, riskOverride: risk.blocked,
        verification: shell || "none", ...result });
    }
    return "control_chrome_cdp failed: unsupported terminal command " + command;
  } finally {
    if (needsWriter) writers.delete(scope);
  }
}
