/**
 * Interactive stdin contract for the Ink CLI.
 *
 * Ink 5 never calls `stdin.resume()`; it only switches raw mode while a
 * `useInput` hook is active. Any code that pauses the TTY — readline prompts,
 * piped command bridges, terminal cleanup on exit paths — therefore leaves the
 * renderer alive but deaf: the UI is drawn, focus sits on the input, and no
 * keystroke is ever delivered to the key handler.
 *
 * Resuming the stream when the App mounts is the invariant that keeps typing
 * alive. It is intentionally isolated here so the behaviour is unit-testable
 * without rendering Ink.
 */

export interface CliStdinLike {
  isTTY?: boolean;
  isPaused?: () => boolean;
  resume?: () => void;
  setRawMode?: (mode: boolean) => unknown;
}

export interface CliStdoutLike {
  isTTY?: boolean;
}

export interface CliStdinState {
  /** Terminal attached to stdin. */
  stdinIsTTY: boolean;
  /** Stream was paused before the mount-time resume, which is the failure precondition. */
  stdinWasPaused: boolean;
  /** Raw mode is required by Ink's `useInput`. */
  rawModeSupported: boolean;
  /** Ink can only paint the TUI on a TTY stdout. */
  stdoutIsTTY: boolean;
}

/** Snapshot the stdin/stdout state that explains a "renders but ignores keys" session. */
export function describeCliStdin(
  stdin: CliStdinLike | undefined,
  stdout: CliStdoutLike | undefined
): CliStdinState {
  let stdinWasPaused = false;
  try {
    stdinWasPaused = typeof stdin?.isPaused === "function" ? Boolean(stdin.isPaused()) : false;
  } catch {
    stdinWasPaused = false;
  }

  return {
    stdinIsTTY: Boolean(stdin?.isTTY),
    stdinWasPaused,
    rawModeSupported: typeof stdin?.setRawMode === "function",
    stdoutIsTTY: Boolean(stdout?.isTTY)
  };
}

/**
 * Restore stdin flow for an interactive terminal.
 *
 * Returns true only when a TTY stream was actually resumed. Non-TTY streams
 * (piped or headless runs) are left untouched so one-shot prompt execution
 * does not block waiting for input that will never arrive.
 */
export function ensureCliStdinFlowing(stdin: CliStdinLike | undefined): boolean {
  if (!stdin?.isTTY || typeof stdin.resume !== "function") return false;
  try {
    stdin.resume();
    return true;
  } catch {
    return false;
  }
}
