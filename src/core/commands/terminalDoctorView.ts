/**
 * Operator-facing terminal diagnostics for `/doctor terminal`.
 *
 * Reuses the same stdin contract as the App mount guard so the report explains
 * the one failure that looks like a dead CLI: a TTY whose stream is paused, the
 * TUI painted, focus on the input, and no keystroke arriving.
 */
import path from "node:path";
import { getGlobalConfigDir } from "../config/paths.js";
import { readFileTail } from "../../utils/logTail.js";
import { describeCliStdin, type CliStdinLike, type CliStdoutLike } from "../../utils/cliStdin.js";
import {
  describeRuntimeLogEcho,
  runtimeLogEchoState,
  type RuntimeLogEchoState,
} from "../utils/runtimeLog.js";

export interface MountRecord {
  stdinIsTTY?: boolean;
  stdinWasPaused?: boolean;
  rawModeSupported?: boolean;
  stdoutIsTTY?: boolean;
  stdinResumed?: boolean;
}

export interface TerminalDiagnosticsOptions {
  stdin?: CliStdinLike;
  stdout?: CliStdoutLike;
  logText?: string;
  /** Injected echo policy so tests never depend on the process-wide state. */
  echoState?: RuntimeLogEchoState;
}

/** Last "App component mounted" record written by the CLI, if any. */
export function parseLastMountRecord(logText: string): MountRecord | undefined {
  if (!logText) return undefined;
  const pattern = /App component mounted \| (\{[^\n]*\})/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((match = pattern.exec(logText)) !== null) last = match;
  if (!last) return undefined;
  try {
    return JSON.parse(last[1]) as MountRecord;
  } catch {
    return undefined;
  }
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) return "unknown";
  return value ? "yes" : "no";
}

export function formatTerminalDiagnostics(options: TerminalDiagnosticsOptions = {}): string {
  const stdin = options.stdin ?? (process.stdin as unknown as CliStdinLike);
  const stdout = options.stdout ?? (process.stdout as unknown as CliStdoutLike);
  const state = describeCliStdin(stdin, stdout);
  const mount = parseLastMountRecord(options.logText ?? "");
  const echoState = options.echoState ?? runtimeLogEchoState();

  const lines = [
    "SUPERAGENT TERMINAL DIAGNOSTICS",
    `  stdin TTY            : ${yesNo(state.stdinIsTTY)}`,
    `  stdin paused now     : ${yesNo(state.stdinWasPaused)}`,
    `  raw mode supported   : ${yesNo(state.rawModeSupported)}`,
    `  stdout TTY           : ${yesNo(state.stdoutIsTTY)}`,
    `  last mount stdin     : ${mount
      ? `paused=${yesNo(mount.stdinWasPaused)} resumed=${yesNo(mount.stdinResumed)}`
      : "no mount record in log"}`,
    `  runtime log echo     : ${describeRuntimeLogEcho(echoState)}`,
  ];

  if (!state.stdinIsTTY) {
    lines.push("Verdict: stdin is not a TTY. Interactive keys cannot arrive; launch the CLI directly in a terminal.");
  } else if (!state.rawModeSupported) {
    lines.push("Verdict: raw mode is unavailable, so Ink cannot read single keys. Use a standard terminal host.");
  } else if (state.stdinWasPaused) {
    lines.push("Verdict: stdin is paused right now. The mount guard resumes it on the next launch; if typing still fails, restart the CLI.");
  } else if (mount?.stdinWasPaused === true && mount.stdinResumed !== true) {
    lines.push("Verdict: the last mount saw a paused stdin and did not resume it. Upgrade to v1.14.126+ and restart.");
  } else {
    lines.push("Verdict: interactive input transport looks healthy.");
  }

  if (echoState.source === "env") {
    lines.push(
      echoState.enabled
        ? "Runtime log note: SUPERAGENT_RUNTIME_LOG_ECHO forces runtime logs onto this terminal."
        : "Runtime log note: SUPERAGENT_RUNTIME_LOG_ECHO suppresses runtime logs on this terminal."
    );
  }

  return lines.join("\n");
}

/** Read the CLI log tail and report the live terminal state. */
export function formatTerminalDiagnosticsFromDisk(): string {
  const logText = readFileTail(path.join(getGlobalConfigDir(), "superagent.log"), 256 * 1024);
  return formatTerminalDiagnostics({ logText });
}
