/**
 * Runtime logging contract for SuperAgent Core/server hosts.
 *
 * Two responsibilities live here so every host shares one policy:
 *
 * 1. The durable sink (`~/.superagent-r/superagent-server.log`). SuperAgent Tray
 *    renders that file, so every runtime message must reach it.
 * 2. The terminal-echo decision. Echoing runtime chatter onto a terminal that is
 *    already hosting the interactive CLI clutters a screen the operator types
 *    into, so echo is opt-in per host and can be overridden for debugging with
 *    `SUPERAGENT_RUNTIME_LOG_ECHO=1|0`.
 *
 * Keeping the decision here - instead of replacing `console` wholesale - leaves
 * CLI/REPL output (slash commands, tool progress) untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type RuntimeLogLevel = "info" | "warn" | "error";

export type RuntimeLogger = (level: RuntimeLogLevel, ...args: unknown[]) => void;

export type RuntimeLogEchoSource = "env" | "host";

export interface RuntimeLogEchoState {
  /** Effective decision used by the logger. */
  enabled: boolean;
  /** `env` when the operator overrode the host decision. */
  source: RuntimeLogEchoSource;
  /** Decision the host asked for, before any environment override. */
  hostEnabled: boolean;
  /** Why the host chose that decision, for `/doctor` and incident review. */
  hostReason: string;
  /** Raw override value when present, so an ignored typo stays visible. */
  envValue?: string;
}

export interface RuntimeLoggerDeps {
  /** Durable sink; always receives exactly one formatted line per call. */
  append: (line: string) => void;
  /** Terminal writer, invoked only while echo is enabled. */
  echo: (level: RuntimeLogLevel, text: string) => void;
  /** Override for tests; defaults to the process-wide policy below. */
  echoEnabled?: () => boolean;
}

const ECHO_ENV_VAR = "SUPERAGENT_RUNTIME_LOG_ECHO";
const SERVER_LOG_FILE = "superagent-server.log";
const SERVER_LOG_MAX_BYTES = 5 * 1024 * 1024;

let hostEchoEnabled = true;
let hostEchoReason = "default";

/** True / false for explicit operator values, undefined for "leave it to the host". */
export function parseRuntimeLogEchoOverride(raw: string | undefined): boolean | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (["1", "true", "on", "yes"].includes(value)) return true;
  if (["0", "false", "off", "no"].includes(value)) return false;
  return undefined;
}

/**
 * A host (foreground server, embedded CLI server, Core supervisor) records its
 * own decision here. The environment override wins over it when valid, so an
 * operator can force echo while debugging without editing code.
 */
export function setRuntimeLogTerminalEcho(enabled: boolean, reason = "host default"): void {
  hostEchoEnabled = enabled;
  hostEchoReason = reason;
}

export function runtimeLogEchoState(environment: NodeJS.ProcessEnv = process.env): RuntimeLogEchoState {
  const envValue = environment[ECHO_ENV_VAR];
  const override = parseRuntimeLogEchoOverride(envValue);
  return {
    enabled: override ?? hostEchoEnabled,
    source: override === undefined ? "host" : "env",
    hostEnabled: hostEchoEnabled,
    hostReason: hostEchoReason,
    envValue,
  };
}

export function isRuntimeLogTerminalEchoEnabled(): boolean {
  return runtimeLogEchoState().enabled;
}

/** One line for `/doctor`, e.g. `off (host: interactive CLI server); env: unset`. */
export function describeRuntimeLogEcho(state: RuntimeLogEchoState = runtimeLogEchoState()): string {
  const host = state.hostEnabled ? "on" : "off";
  const env = state.envValue === undefined ? "unset" : JSON.stringify(state.envValue);
  return `${state.enabled ? "on" : "off"} (host: ${host} - ${state.hostReason}; source: ${state.source}; env: ${env})`;
}

export function superAgentServerLogPath(configDir: string = path.join(os.homedir(), ".superagent-r")): string {
  return path.join(configDir, SERVER_LOG_FILE);
}

function logFileSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * Append one timestamped line to the Tray-readable runtime log. Rotates once past
 * 5 MB. Logging failures are swallowed: a diagnostic sink must never break a host.
 */
export function logToSuperAgentServerFile(message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}\n`;
  try {
    const filePath = superAgentServerLogPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const size = logFileSize(filePath);
    if (size !== null && size > SERVER_LOG_MAX_BYTES) {
      fs.writeFileSync(filePath, `[${timestamp}] [INFO] Log file rotated (exceeded 5MB limit)\n`);
    }
    // Synchronous append: a short-lived host (for example `core boot`, which
    // decides and exits in the same tick) must not lose its last line when the
    // process ends before an async write is flushed.
    fs.appendFileSync(filePath, logLine);
  } catch {
    // Ignore logging errors.
  }
}

// Captured at module load, before any host installs its own console wrapper, so
// runtime echo never recurses through that wrapper or writes a line twice.
const originalTerminalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/**
 * Core/server runtime logger: always appends to the Tray-readable log file and
 * echoes to the terminal only while the host (or `SUPERAGENT_RUNTIME_LOG_ECHO`)
 * allows it.
 */
export const serverRuntimeLog: RuntimeLogger = createRuntimeLogger({
  append: (line) => logToSuperAgentServerFile(line),
  echo: (level, text) => {
    const write = level === "error"
      ? originalTerminalConsole.error
      : level === "warn"
        ? originalTerminalConsole.warn
        : originalTerminalConsole.log;
    write(text);
  },
});

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
