/**
 * Terminal-echo policy for SuperAgent Core/server runtime logs.
 *
 * Runtime messages are always captured to `~/.superagent-r/superagent-server.log`
 * because SuperAgent Tray reads that file. Echoing the same messages onto a
 * terminal that is already hosting the interactive CLI only clutters a screen
 * the operator is typing into, so terminal echo is a per-host decision: an
 * explicitly attached foreground server keeps it, an embedded (silent) host
 * does not.
 *
 * Keeping the policy here - instead of replacing `console` wholesale - leaves
 * CLI/REPL output (slash commands, tool progress) untouched.
 */

export type RuntimeLogLevel = "info" | "warn" | "error";

export type RuntimeLogger = (level: RuntimeLogLevel, ...args: unknown[]) => void;

export interface RuntimeLoggerDeps {
  /** Durable sink; always receives exactly one formatted line per call. */
  append: (line: string) => void;
  /** Terminal writer, invoked only while echo is enabled. */
  echo: (level: RuntimeLogLevel, text: string) => void;
  /** Override for tests; defaults to the process-wide policy below. */
  echoEnabled?: () => boolean;
}

let terminalEchoEnabled = true;

export function setRuntimeLogTerminalEcho(enabled: boolean): void {
  terminalEchoEnabled = enabled;
}

export function isRuntimeLogTerminalEchoEnabled(): boolean {
  return terminalEchoEnabled;
}

function stringifyArgument(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Same formatting the previous console wrapper produced: JSON for objects, String otherwise. */
export function formatRuntimeLogArgs(args: readonly unknown[]): string {
  return args.map(stringifyArgument).join(" ");
}

export function createRuntimeLogger(deps: RuntimeLoggerDeps): RuntimeLogger {
  const echoEnabled = deps.echoEnabled ?? isRuntimeLogTerminalEchoEnabled;
  return (level, ...args) => {
    const text = formatRuntimeLogArgs(args);
    if (echoEnabled()) deps.echo(level, text);
    deps.append(`[${level.toUpperCase()}] ${text}`);
  };
}
