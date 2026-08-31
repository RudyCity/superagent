/**
 * cliBridgeSession.ts — In-process subprocess session manager for the
 * `cli_bridge` tool.
 *
 * File-size note: this module is intentionally over the 1000-line soft
 * cap. The v1.5.17 events subsystem (types, ring buffer, subscribers,
 * idle-scanner handle) has already been extracted into
 * `cliBridgeSessionEvents.ts`; further splits would create circular
 * imports between the subprocess-lifecycle code and the observation
 * code, so we keep them in one cohesive file. Sections below are
 * clearly marked (// ─── v1.5.17: …).
 *
 *
 * Each session holds:
 *  - a long-running subprocess (e.g. `agy`, `claude`, `codex`)
 *  - rolling stdout/stderr buffers (capped)
 *  - a "ready" promise that resolves when the CLI prints its input prompt
 *    (or after a generous startup timeout)
 *  - a per-session log file under ~/.superagent-r/logs/cli-bridge/
 *
 * Concurrency: sessions are stored in a module-level Map keyed by `sessionId`.
 * The manager exposes async CRUD-style functions used by `cliBridgeTool`.
 *
 * SSH support: sessions run on the local host only. Calling `createSession`
 * from inside an SSH-mode workspace will return a clear "not supported" error.
 */

import { execa } from "execa";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getRootConfigDir } from "../config/paths.js";

// ─── Public types ────────────────────────────────────────────────────────

export interface CliDescriptor {
  /** Public alias, e.g. "codex", "claude", "agy", "custom" */
  alias: string;
  /** Resolved absolute path or bare name. */
  binary: string;
  /** Human-friendly label, e.g. "OpenAI Codex CLI" */
  label: string;
  /** Whether the binary was found on disk. */
  available: boolean;
  /** Hint shown when not installed. */
  installHint?: string;
  /** Default args prepended for 1-shot delegations. */
  defaultArgs?: string[];
  /** Whether this CLI takes the prompt as a positional arg (vs stdin). */
  promptAsArg?: boolean;
  /** Subcommand to invoke the prompt, e.g. ["exec"] for `codex exec "..."`. */
  promptSubcommand?: string[];
}

export interface CliSession {
  sessionId: string;
  cliAlias: string;
  binary: string;
  pid: number | null;
  /** Path to the per-session log file. */
  logPath: string;
  createdAt: number;
  lastActivityAt: number;
  status: "starting" | "ready" | "busy" | "awaiting_input" | "exited" | "errored";
  exitCode: number | null;
  /** Captured so far (capped). */
  stdoutBuffer: string;
  stderrBuffer: string;
  /** Optional abort signal consumer. */
  signalBound: boolean;
  /** Conversation id this session is tied to (for resume). */
  conversationId?: string;
  /** Per-session skills/extra dirs. */
  skills?: string[];
  /** Resolved working directory. */
  cwd: string;
  /** Last detected interactive prompt awaiting an answer. */
  pendingPrompt?: DetectedPrompt;
  /** Profile alias used to create this session. */
  profileAlias?: string;
  /** v1.5.16: System prompt set on the session. */
  systemPrompt?: string;
  /** v1.5.16: Names that were unresolved during skill resolution. */
  unresolvedSkills?: string[];
  /** v1.5.17: Per-session cap on stdout/stderr buffer lines. */
  maxBufferLines: number;
  /** v1.5.17: Time of the last stdout/stderr chunk. */
  lastOutputAt: number;
  /** v1.5.17: Idle TTL in ms; 0 disables. Default 30 min. */
  idleTimeoutMs: number;
  /** v1.5.17: True if the idle TTL killed this session. */
  autoKilled?: boolean;
  /** v1.5.17: If true, the initial message is auto-sent after the session becomes ready. */
  autoSendInitial: boolean;
  /** v1.5.17: Optional initial message queued for auto-send. */
  pendingInitialMessage?: string;
  /** v1.5.17: True if the session is detached (no longer managed but process still alive). */
  detached: boolean;
}

/** Structured representation of a TUI prompt we detected. */
export interface DetectedPrompt {
  /** Raw text the CLI sent (last 4 KB before the prompt). */
  rawText: string;
  /** One of: yesno, password, choice, text, enter. */
  kind: "yesno" | "password" | "choice" | "text" | "enter";
  /** Question or label (best-effort extract). */
  question: string;
  /** Pre-filled options for yesno/choice (e.g. ["y","n"]). */
  options?: string[];
  /** Detected at. */
  detectedAt: number;
}

export interface DelegateResult {
  output: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  logPath: string;
  timedOut: boolean;
  cliAlias: string;
}

export interface SendResult {
  response: string;
  durationMs: number;
  timedOut: boolean;
  status: CliSession["status"];
  /** v1.5.15: set when the session is now blocked on a TUI prompt. */
  pendingPrompt?: DetectedPrompt;
}

export type SessionError = { error: string; code: string };

// ─── v1.5.17: Session events (state/types live in cliBridgeSessionEvents.ts) ──

import {
  emitEvent,
  ensureEmitter,
  setIdleScanHandle,
  getIdleScanHandle,
  sessionEmitters,
  sessionEventBuffers,
  sessionSeqCounters,
  sessionSubscribers,
  MAX_EVENT_BUFFER,
  IDLE_SCAN_INTERVAL_MS,
  type SessionEvent,
  type SessionEventType,
  type SessionEventListener,
  type SessionSubscription,
} from "./cliBridgeSessionEvents.js";

export {
  // types
  type SessionEvent,
  type SessionEventType,
  type SessionEventListener,
  type SessionSubscription,
  // functions
  emitEvent,
  ensureEmitter,
  setIdleScanHandle,
  getIdleScanHandle,
  __resetEventStateForTests,
  // state maps (re-exported so existing tests/imports still work)
  sessionEmitters,
  sessionEventBuffers,
  sessionSeqCounters,
  sessionSubscribers,
  // constants (re-exported so existing imports still work)
  MAX_EVENT_BUFFER,
  IDLE_SCAN_INTERVAL_MS,
} from "./cliBridgeSessionEvents.js";

// ─── Constants ───────────────────────────────────────────────────────────

const LOG_DIR = "logs/cli-bridge";
const DEFAULT_DELEGATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_SEND_TIMEOUT_MS = 2 * 60 * 1000;     // 2 min
const READY_TIMEOUT_MS = 30 * 1000;                // 30 s
const MAX_BUFFER_LINES = 2000;                     // soft cap per session (default; overridable per-session in v1.5.17)
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;    // 30 min (v1.5.17)
const PROMPT_END_MARKERS = [
  ">", // agy, generic REPL
  ">>>", // python-style
  "claude>", // claude code TUI hint
  "codex>", // codex TUI hint
  "▌", // block cursor
  "╭", // box-drawing prompt start
  "│", // box-drawing prompt body
];

// ─── Module state ────────────────────────────────────────────────────────

const sessions = new Map<string, CliSession>();
/** v1.5.17: Detached sessions — child process still alive but no longer managed. */
const detachedSessions = new Map<string, CliSession>();
const procHandles = new Map<string, any>();

function ensureIdleScannerRunning(): void {
  if (getIdleScanHandle()) return;
  const h = setInterval(() => {
    scanIdleSessions().catch(() => {
      // Never let the interval throw — the next pass will retry.
    });
  }, IDLE_SCAN_INTERVAL_MS);
  // Don't keep the process alive solely for the scanner.
  if (typeof h.unref === "function") h.unref();
  setIdleScanHandle(h);
}

function maybeStopIdleScanner(): void {
  if (sessions.size === 0 && detachedSessions.size === 0) {
    setIdleScanHandle(null);
  }
}

/** Lazy directory ensure (one-time, best-effort). */
let logDirEnsured = false;
async function ensureLogDir(): Promise<string> {
  if (logDirEnsured) {
    return path.join(getRootConfigDir(), LOG_DIR);
  }
  const full = path.join(getRootConfigDir(), LOG_DIR);
  try {
    await fs.mkdir(full, { recursive: true });
    logDirEnsured = true;
  } catch {
    // best-effort: logging failures must not crash the tool
  }
  return full;
}

function newSessionId(): string {
  return "clb_" + crypto.randomBytes(6).toString("hex");
}

function appendLines(buf: string, chunk: string, cap: number): string {
  const merged = buf + chunk;
  const lines = merged.split(/\r?\n/);
  if (lines.length > cap) {
    return lines.slice(lines.length - cap).join("\n");
  }
  return merged;
}

function looksLikeReadyPrompt(text: string): boolean {
  const tail = text.slice(-2000);
  return PROMPT_END_MARKERS.some((m) => tail.includes(m));
}

/**
 * v1.5.17: re-export of the internal buffer-cap helper for unit tests that
 * want to assert the rolling-buffer behavior without spinning up a real
 * subprocess.
 */
export function appendLinesForTest(buf: string, chunk: string, cap: number): string {
  return appendLines(buf, chunk, cap);
}

// ─── Interactive prompt detection ────────────────────────────────────────
//
// Heuristic patterns for common TUI prompts. We scan the last 2 KB of stdout
// to find the most recent prompt. Conservative by design — false positives
// would block the LLM, so we err on the side of NOT detecting.
//
// Match order matters: password/yesno/choice/text are tried in this order.
// The first match wins.

const PROMPT_PATTERNS: Array<{
  kind: DetectedPrompt["kind"];
  re: RegExp;
  optionsForChoice?: (m: RegExpMatchArray) => string[] | undefined;
  questionFor: (m: RegExpMatchArray) => string;
}> = [
  {
    kind: "yesno",
    re: /\b(?:Allow|Approve|Confirm|Continue|Apply|Run|Accept)\b[^\n]*?\?\s*\(?\s*\[?\s*[Yy](?:es)?\s*[/|]\s*[Nn](?:o)?\s*\]?\s*\)?:?\s*$/m,
    questionFor: (m) => (m[0] || "Confirm?").trim(),
  },
  {
    kind: "yesno",
    re: /\([Yy]\/[Nn]\)\s*:?\s*$/m,
    questionFor: () => "Yes or no?",
  },
  {
    kind: "password",
    re: /(?:Enter|Type|Provide)\b[^\n]*?(?:password|passphrase|PIN|token|secret|api[ _-]?key)[^\n]*?:\s*$/im,
    questionFor: (m) => (m[0] || "Enter password:").trim(),
  },
  {
    kind: "choice",
    // "Select [1/2/3]" / "Choose (1-3):" / "1) yes  2) no"
    re: /(?:Select|Choose|Pick)\b[^\n]*?\[([0-9]+(?:[/,\s|-][0-9]+)+)\][^\n]*?:?\s*$/im,
    optionsForChoice: (m) => {
      const inner = m[1] || "";
      return inner.split(/[\/,\s|-]+/).filter((n) => /^\d+$/.test(n));
    },
    questionFor: (m) => (m[0] || "Select option:").trim(),
  },
  {
    kind: "enter",
    re: /Press\s+(?:Enter|Return)\b[^\n]*?(?:to\s+\w+)?[^\n]*?\.{0,3}\s*:?\s*$/im,
    questionFor: (m) => (m[0] || "Press Enter to continue").trim(),
  },
  {
    kind: "text",
    re: /(?:Enter|Type|Input)\b[^\n]*?(?:message|input|response|answer|reply|name|description)[^\n]*?:\s*$/im,
    questionFor: (m) => (m[0] || "Enter input:").trim(),
  },
  {
    kind: "text",
    re: /\?\s*$/m,
    questionFor: (m) => (m[0] || "Input?").trim(),
  },
];

/**
 * Try to detect a TUI prompt in the recent stdout of a session.
 * Returns the highest-priority DetectedPrompt, or null.
 */
export function detectPrompt(stdoutText: string): DetectedPrompt | null {
  // Look at the last 2 KB for performance.
  const tail = stdoutText.slice(-2048);
  // Strip ANSI escapes for cleaner matching.
  const clean = tail.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
  for (const pat of PROMPT_PATTERNS) {
    const matches = clean.match(pat.re);
    if (matches) {
      return {
        rawText: clean.slice(-1024),
        kind: pat.kind,
        question: pat.questionFor(matches),
        options: pat.optionsForChoice?.(matches),
        detectedAt: Date.now(),
      };
    }
  }
  return null;
}

/**
 * Strip ANSI color codes from a string. Useful for LLM-friendly output.
 */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

async function appendToLog(logPath: string, prefix: string, chunk: string): Promise<void> {
  try {
    await fs.appendFile(logPath, `[${prefix}] ${chunk}`, "utf8");
  } catch {
    // best-effort
  }
}

function killHandle(h: any): void {
  if (!h) return;
  try {
    if ("pid" in h && h.pid) {
      // Tree-kill fallback if execa lacks .kill()
      try {
        // @ts-ignore — execa exposes kill
        h.kill?.("SIGTERM");
      } catch {}
      try {
        // Last resort: spawn kill
        spawn("taskkill", ["/F", "/T", "/PID", String(h.pid)], { stdio: "ignore" }).on("error", () => {});
      } catch {}
    }
  } catch {
    // best-effort
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * List of well-known AI CLI descriptors.
 * We always return the full list; `available` is computed lazily on demand.
 */
export function knownCliDescriptors(): CliDescriptor[] {
  return [
    {
      alias: "codex",
      binary: process.platform === "win32" ? "codex.cmd" : "codex",
      label: "OpenAI Codex CLI",
      available: false,
      installHint: "Install: npm i -g @openai/codex",
      defaultArgs: ["exec", "--skip-git-repo-check"],
      promptSubcommand: ["exec"],
      promptAsArg: true,
    },
    {
      alias: "claude",
      binary: process.platform === "win32" ? "claude.cmd" : "claude",
      label: "Claude Code CLI",
      available: false,
      installHint: "Install: npm i -g @anthropic-ai/claude-code",
      promptAsArg: true,
    },
    {
      alias: "agy",
      binary: process.platform === "win32" ? "agy.exe" : "agy",
      label: "Antigravity CLI",
      available: false,
      installHint: "Visit https://antigravity.google for installation",
      promptAsArg: true,
    },
  ];
}

/**
 * Try to resolve each known alias to an actual on-disk binary using
 * `where` (Windows) or `which` (POSIX). Updates `available` in-place
 * and returns the fresh descriptors.
 */
export async function detectAvailableClis(): Promise<CliDescriptor[]> {
  const descriptors = knownCliDescriptors();
  const isWin = process.platform === "win32";
  const cmd = isWin ? "where" : "which";
  await Promise.all(
    descriptors.map(async (d) => {
      try {
        const { stdout } = await execa(cmd, [d.binary], { reject: false });
        const found = (stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
        if (found) {
          d.available = true;
          d.binary = found;
        }
      } catch {
        d.available = false;
      }
    })
  );
  return descriptors;
}

/**
 * Build the full argv for a delegation. Caller can supply extra args.
 */
export function buildDelegateArgv(
  desc: CliDescriptor,
  prompt: string,
  extraArgs: string[] = []
): string[] {
  const argv: string[] = [];
  if (desc.promptSubcommand && desc.promptSubcommand.length > 0) {
    argv.push(...desc.promptSubcommand);
  }
  if (desc.defaultArgs && desc.defaultArgs.length > 0) {
    argv.push(...desc.defaultArgs);
  }
  argv.push(...extraArgs);
  if (desc.promptAsArg !== false) {
    argv.push(prompt);
  }
  return argv;
}

/**
 * Run a 1-shot delegation. Spawns the CLI, waits for exit, returns captured
 * output (capped) plus the path to the full log file.
 */
export async function runDelegate(opts: {
  cliAlias: string;
  binary: string;
  prompt: string;
  cwd: string;
  extraArgs?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<DelegateResult> {
  const start = Date.now();
  const timeout = opts.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS;
  const logDir = await ensureLogDir();
  const logPath = path.join(logDir, `delegate-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.log`);

  await appendToLog(logPath, "meta", `cli=${opts.cliAlias} binary=${opts.binary}\n`);
  await appendToLog(logPath, "meta", `prompt (${opts.prompt.length} chars):\n${opts.prompt}\n---\n`);

  const argv = [
    ...((opts.extraArgs ?? []) as string[]),
    opts.prompt,
  ];

  let proc: any;
  try {
    proc = execa(opts.binary, argv, {
      cwd: opts.cwd,
      all: true,
      reject: false,
      env: opts.env ?? process.env,
      input: opts.prompt, // also feed stdin in case CLI reads from it
      timeout,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: "",
      stderr: msg,
      exitCode: -1,
      durationMs: Date.now() - start,
      logPath,
      timedOut: false,
      cliAlias: opts.cliAlias,
    };
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let timedOut = false;

  const onAbort = () => killHandle(proc);
  if (opts.signal) {
    if (opts.signal.aborted) {
      killHandle(proc);
      throw new Error("AbortError");
    }
    opts.signal.addEventListener("abort", onAbort);
  }

  proc.all?.on("data", async (data: Buffer | string) => {
    const text = data.toString();
    stdoutBuf = appendLines(stdoutBuf, text, MAX_BUFFER_LINES);
    await appendToLog(logPath, "stdout", text);
  });

  try {
    const result = await proc;
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    if (result.timedOut) timedOut = true;
    return {
      output: (result.all ?? stdoutBuf).toString().trim(),
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? null,
      durationMs: Date.now() - start,
      logPath,
      timedOut,
      cliAlias: opts.cliAlias,
    };
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: stdoutBuf.trim(),
      stderr: stderrBuf || msg,
      exitCode: -1,
      durationMs: Date.now() - start,
      logPath,
      timedOut: /timed out|timeout/i.test(msg),
      cliAlias: opts.cliAlias,
    };
  }
}

/**
 * Spawn a long-running session for the given CLI alias. The returned session
 * is in `starting` status; callers should poll readiness or use `sendToSession`
 * which internally waits for the ready prompt.
 *
 * Extended for v1.5.15:
 *   - `skills` is recorded on the session for later reference
 *   - `conversationId` is recorded so `session.resume` can re-attach
 *   - the stdout listener also runs `detectPrompt` and updates
 *     `pendingPrompt` + `status: "awaiting_input"` when a TUI prompt is found
 */
export async function createSession(opts: {
  cliAlias: string;
  binary: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  skills?: string[];
  conversationId?: string;
  profileAlias?: string;
  systemPrompt?: string;
  unresolvedSkills?: string[];
  maxBufferLines?: number;
  idleTimeoutMs?: number;
  autoSendInitial?: boolean;
  initialMessage?: string;
}): Promise<{ ok: true; session: CliSession } | { ok: false; error: SessionError }> {
  const sessionId = newSessionId();
  const logDir = await ensureLogDir();
  const logPath = path.join(logDir, `session-${sessionId}.log`);

  const session: CliSession = {
    sessionId,
    cliAlias: opts.cliAlias,
    binary: opts.binary,
    pid: null,
    logPath,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    status: "starting",
    exitCode: null,
    stdoutBuffer: "",
    stderrBuffer: "",
    signalBound: false,
    skills: opts.skills,
    conversationId: opts.conversationId,
    profileAlias: opts.profileAlias,
    cwd: opts.cwd,
    systemPrompt: opts.systemPrompt,
    unresolvedSkills: opts.unresolvedSkills,
    // v1.5.17
    maxBufferLines:
      typeof opts.maxBufferLines === "number" && opts.maxBufferLines > 0
        ? Math.floor(opts.maxBufferLines)
        : MAX_BUFFER_LINES,
    lastOutputAt: Date.now(),
    idleTimeoutMs:
      typeof opts.idleTimeoutMs === "number" && opts.idleTimeoutMs >= 0
        ? Math.floor(opts.idleTimeoutMs)
        : DEFAULT_IDLE_TIMEOUT_MS,
    autoKilled: false,
    autoSendInitial: opts.autoSendInitial !== false && !!opts.initialMessage,
    pendingInitialMessage: opts.initialMessage,
    detached: false,
  };

  ensureEmitter(sessionId);
  ensureIdleScannerRunning();

  await appendToLog(
    logPath,
    "meta",
    `cli=${opts.cliAlias} binary=${opts.binary} cwd=${opts.cwd}\n` +
      `args=${JSON.stringify(opts.args ?? [])}\n` +
      `skills=${JSON.stringify(opts.skills ?? [])}\n` +
      `conversationId=${opts.conversationId ?? ""}\n` +
      `profileAlias=${opts.profileAlias ?? ""}\n` +
      `maxBufferLines=${session.maxBufferLines}\n` +
      `idleTimeoutMs=${session.idleTimeoutMs}\n` +
      `autoSendInitial=${session.autoSendInitial}\n` +
      `systemPrompt=${JSON.stringify(opts.systemPrompt ?? "")}\n` +
      `unresolvedSkills=${JSON.stringify(opts.unresolvedSkills ?? [])}\n---\n`
  );

  let proc: any;
  try {
    // Use execa to spawn — it correctly handles Windows .cmd/.bat files and
    // paths with spaces (child_process.spawn with shell:true has quoting
    // issues that break on paths like "D:\Program Files\...").
    // We expose the same surface (stdio streams, pid) by reading from the
    // returned ExecaChildProcess.
    const child = execa(opts.binary, opts.args ?? [], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      reject: false,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      all: false,
    });
    proc = child;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: { code: "SPAWN_FAILED", error: `Failed to spawn "${opts.binary}": ${msg}` },
    };
  }

  session.pid = proc.pid ?? null;
  sessions.set(sessionId, session);
  procHandles.set(sessionId, proc);

  proc.stdout?.on("data", async (data: Buffer) => {
    const text = data.toString();
    session.stdoutBuffer = appendLines(session.stdoutBuffer, text, session.maxBufferLines);
    session.lastActivityAt = Date.now();
    session.lastOutputAt = Date.now();
    // v1.5.17: emit per-chunk events. We split on newlines so subscribers
    // get a "line" event per logical line, not per raw chunk.
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length === 0) continue;
      emitEvent(session, "stdout", { line });
    }
    if (session.status === "starting" && looksLikeReadyPrompt(text)) {
      session.status = "ready";
      emitEvent(session, "status", { status: session.status });
      // v1.5.17: now that the session is ready, fire the queued initial message.
      if (session.pendingInitialMessage) {
        // Don't await — we want stdout listener to keep going.
        maybeAutoSendInitial(session).catch(() => {
          /* logged inside */
        });
      }
    }
    // v1.5.15: detect interactive prompts (yes/no, password, etc.)
    // Only trigger after the session is past "starting" to avoid false
    // positives on banner/loading screens.
    if (session.status === "ready" || session.status === "awaiting_input") {
      const prompt = detectPrompt(session.stdoutBuffer);
      if (prompt) {
        // Throttle: if a recent prompt is still unanswered, do not re-emit
        // unless the prompt text actually changed.
        const prev = session.pendingPrompt;
        if (!prev || prev.question !== prompt.question || prev.kind !== prompt.kind) {
          session.pendingPrompt = prompt;
          session.status = "awaiting_input";
          emitEvent(session, "status", { status: session.status });
          emitEvent(session, "prompt", { prompt, isPrompt: true });
          await appendToLog(logPath, "prompt", `[${prompt.kind}] ${prompt.question}\n`);
        }
      }
    }
    await appendToLog(logPath, "stdout", text);
  });

  proc.stderr?.on("data", async (data: Buffer) => {
    const text = data.toString();
    session.stderrBuffer = appendLines(session.stderrBuffer, text, session.maxBufferLines);
    session.lastActivityAt = Date.now();
    session.lastOutputAt = Date.now();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (line.length === 0) continue;
      emitEvent(session, "stderr", { line });
    }
    await appendToLog(logPath, "stderr", text);
  });

  proc.on("exit", (code: number | null) => {
    session.status = code === 0 ? "exited" : "errored";
    session.exitCode = code;
    session.pid = null;
    procHandles.delete(sessionId);
    emitEvent(session, "exit", { code, signal: null });
  });

  proc.on("error", (err: Error) => {
    session.status = "errored";
    session.stderrBuffer = appendLines(
      session.stderrBuffer,
      `\n[spawn error] ${err.message}\n`,
      session.maxBufferLines
    );
    procHandles.delete(sessionId);
    emitEvent(session, "exit", { code: null, signal: "spawn-error" });
  });

  // Best-effort ready probe: if the CLI doesn't print a prompt marker,
  // we still mark it ready after READY_TIMEOUT_MS so the caller can proceed.
  setTimeout(() => {
    if (session.status === "starting") {
      session.status = "ready";
      emitEvent(session, "status", { status: session.status });
      // v1.5.17: fire the auto-send if a prompt marker never came.
      if (session.pendingInitialMessage) {
        maybeAutoSendInitial(session).catch(() => {
          /* logged inside */
        });
      }
    }
  }, READY_TIMEOUT_MS).unref();

  return { ok: true, session };
}

/**
 * Send a message into a running session and wait for the response.
 * Strategy: write the message to stdin, then watch stdout for a stable
 * "ready again" signal (prompt marker reappears) within the timeout.
 */
export async function sendToSession(opts: {
  sessionId: string;
  message: string;
  timeoutMs?: number;
}): Promise<SendResult | SessionError> {
  const session = sessions.get(opts.sessionId);
  if (!session) {
    return { code: "SESSION_NOT_FOUND", error: `Session ${opts.sessionId} not found.` };
  }
  if (session.status === "exited" || session.status === "errored") {
    return {
      code: "SESSION_DEAD",
      error: `Session ${opts.sessionId} is ${session.status} (exit=${session.exitCode ?? "?"}).`,
    };
  }

  const proc = procHandles.get(opts.sessionId) as any;
  if (!proc || !proc.stdin || proc.stdin.writableEnded) {
    return {
      code: "SESSION_DEAD",
      error: `Session ${opts.sessionId} has no writable stdin (process exited or was killed).`,
    };
  }

  const timeout = opts.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const start = Date.now();
  const captureFromBytes = session.stdoutBuffer.length;

  session.status = "busy";
  session.lastActivityAt = Date.now();

  await appendToLog(session.logPath, "user", `\n>>> ${opts.message}\n`);

  try {
    proc.stdin.write(opts.message + "\n");
  } catch (err) {
    session.status = "errored";
    const msg = err instanceof Error ? err.message : String(err);
    return { code: "STDIN_WRITE_FAILED", error: `Failed to write to session stdin: ${msg}` };
  }

  // Wait for the prompt to "stabilize": no new output for `idleMs`.
  const idleMs = 1500;
  const deadline = start + timeout;
  let lastLen = captureFromBytes;
  let lastChangeAt = Date.now();

  return await new Promise<SendResult>((resolve) => {
    const tick = setInterval(() => {
      const now = Date.now();
      if (session.status === "exited" || session.status === "errored") {
        clearInterval(tick);
        resolve({
          response: session.stdoutBuffer.slice(captureFromBytes).trim(),
          durationMs: now - start,
          timedOut: false,
          status: session.status,
          pendingPrompt: session.pendingPrompt,
        });
        return;
      }
      // v1.5.15: If we detected a prompt mid-send, surface it immediately
      // and stop waiting. The LLM will call `session.respond` to continue.
      if (session.status === "awaiting_input" && session.pendingPrompt) {
        clearInterval(tick);
        resolve({
          response: session.stdoutBuffer.slice(captureFromBytes).trim(),
          durationMs: now - start,
          timedOut: false,
          status: "awaiting_input",
          pendingPrompt: session.pendingPrompt,
        });
        return;
      }
      if (session.stdoutBuffer.length !== lastLen) {
        lastLen = session.stdoutBuffer.length;
        lastChangeAt = now;
      }
      if (now - lastChangeAt >= idleMs) {
        clearInterval(tick);
        // If a prompt was detected just before idle, surface it instead
        // of marking the session ready.
        if (session.pendingPrompt && session.status === "awaiting_input") {
          resolve({
            response: session.stdoutBuffer.slice(captureFromBytes).trim(),
            durationMs: now - start,
            timedOut: false,
            status: "awaiting_input",
            pendingPrompt: session.pendingPrompt,
          });
          return;
        }
        session.status = "ready";
        resolve({
          response: session.stdoutBuffer.slice(captureFromBytes).trim(),
          durationMs: now - start,
          timedOut: false,
          status: "ready",
          pendingPrompt: session.pendingPrompt,
        });
        return;
      }
      if (now >= deadline) {
        clearInterval(tick);
        const finalStatus: CliSession["status"] = session.pendingPrompt ? "awaiting_input" : "ready";
        session.status = finalStatus;
        resolve({
          response: session.stdoutBuffer.slice(captureFromBytes).trim(),
          durationMs: now - start,
          timedOut: true,
          status: finalStatus,
          pendingPrompt: session.pendingPrompt,
        });
      }
    }, 200);
    // Do not keep the event loop alive solely for this timer.
    tick.unref?.();
  });
}

/**
 * List active sessions as plain JSON-safe objects.
 */
export function listSessions(): CliSession[] {
  const result: CliSession[] = [];
  for (const s of sessions.values()) {
    // Strip stdout/stderr buffers from the list view — they can be large.
    result.push({
      ...s,
      stdoutBuffer: "",
      stderrBuffer: "",
    });
  }
  return result;
}

/**
 * Inspect one session (including its buffers). Used by the LLM to debug.
 */
export function getSession(sessionId: string): CliSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Kill a session and remove it from the manager.
 */
export function killSession(sessionId: string): { ok: boolean; reason?: string } {
  // v1.5.17: search both active and detached maps.
  const session = sessions.get(sessionId) ?? detachedSessions.get(sessionId);
  if (!session) return { ok: false, reason: "not_found" };
  const proc = procHandles.get(sessionId);
  killHandle(proc as any);
  sessions.delete(sessionId);
  detachedSessions.delete(sessionId);
  procHandles.delete(sessionId);
  maybeStopIdleScanner();
  return { ok: true };
}

/**
 * Best-effort cleanup for process-exit hook.
 */
export function killAllSessions(): void {
  for (const id of Array.from(sessions.keys())) {
    killSession(id);
  }
  for (const id of Array.from(detachedSessions.keys())) {
    killSession(id);
  }
}

// Make sure all sessions are cleaned up on process exit.
try {
  process.on("exit", killAllSessions);
  process.on("SIGINT", () => {
    killAllSessions();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killAllSessions();
    process.exit(143);
  });
} catch {
  // best-effort
}

/**
 * Convenience: synchronous existence check (used in tests).
 */
export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * v1.5.15: Feed an answer to a pending interactive prompt.
 * Returns the response after the CLI consumes the answer and reaches
 * a new stable state (or hits the timeout).
 */
export async function respondToSession(opts: {
  sessionId: string;
  answer: string;
  timeoutMs?: number;
}): Promise<SendResult | SessionError> {
  // Re-use sendToSession under the hood — semantically it's the same:
  // write to stdin, wait for the next stable state.
  const r = await sendToSession({
    sessionId: opts.sessionId,
    message: opts.answer,
    timeoutMs: opts.timeoutMs,
  });
  if ("error" in r) return r;
  // Clear the pending prompt — the LLM has now answered it.
  const session = sessions.get(opts.sessionId);
  if (session) {
    session.pendingPrompt = undefined;
    if (session.status === "awaiting_input") {
      session.status = "ready";
    }
  }
  return r;
}

/**
 * v1.5.15: Resume a previously-killed session by spawning a new process
 * with the same conversationId and the profile's resume flag. The actual
 * conversation history is restored by the CLI itself (e.g. `claude --continue`
 * or `agy --conversation <id>`), not by us.
 */
export interface ResumeOpts {
  cliAlias: string;
  binary: string;
  profileAlias: string;
  cwd: string;
  conversationId?: string;
  resume?: boolean;
  skills?: string[];
  env?: NodeJS.ProcessEnv;
  args?: string[];
  systemPrompt?: string;
  unresolvedSkills?: string[];
}

export async function resumeSession(opts: ResumeOpts): Promise<
  | { ok: true; session: CliSession }
  | { ok: false; error: SessionError }
> {
  // Lazy import to avoid a static cycle: profiles -> session -> profiles
  const { getProfile, buildSessionArgv, buildSessionEnv } = await import("./cliBridgeProfiles.js");
  const profile = getProfile(opts.profileAlias);
  if (!profile) {
    return {
      ok: false,
      error: { code: "UNKNOWN_PROFILE", error: `No profile for alias "${opts.profileAlias}".` },
    };
  }
  const argv = buildSessionArgv(profile, {
    skills: opts.skills,
    resume: opts.resume ?? true,
    conversationId: opts.conversationId,
    extraArgs: opts.args,
  });
  const env = opts.env ?? buildSessionEnv(profile);
  const created = await createSession({
    cliAlias: opts.cliAlias,
    binary: opts.binary,
    cwd: opts.cwd,
    args: argv,
    env,
    skills: opts.skills,
    conversationId: opts.conversationId,
    profileAlias: opts.profileAlias,
    systemPrompt: opts.systemPrompt,
    unresolvedSkills: opts.unresolvedSkills,
  });
  return created;
}

/**
 * v1.5.15: Export a session's current state as JSON. Useful for debugging
 * and for handing the conversation context to another tool.
 */
export interface ExportedSession {
  sessionId: string;
  cliAlias: string;
  profileAlias?: string;
  binary: string;
  pid: number | null;
  status: CliSession["status"];
  createdAt: number;
  lastActivityAt: number;
  conversationId?: string;
  skills?: string[];
  cwd: string;
  /** v1.5.16 */
  systemPrompt?: string;
  unresolvedSkills?: string[];
  /** Last N lines of stdout, ANSI-stripped for LLM-friendliness. */
  stdoutTail: string;
  /** Last N lines of stderr, ANSI-stripped. */
  stderrTail: string;
  /** Pending prompt if any. */
  pendingPrompt?: DetectedPrompt;
  /** Absolute path to the full log file. */
  logPath: string;
}

export function exportSession(sessionId: string, tailLines = 200): ExportedSession | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  const tail = (buf: string, n: number) => {
    const lines = buf.split(/\r?\n/);
    return lines.slice(Math.max(0, lines.length - n)).join("\n");
  };
  return {
    sessionId: s.sessionId,
    cliAlias: s.cliAlias,
    profileAlias: s.profileAlias,
    binary: s.binary,
    pid: s.pid,
    status: s.status,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    conversationId: s.conversationId,
    skills: s.skills,
    cwd: s.cwd,
    systemPrompt: s.systemPrompt,
    unresolvedSkills: s.unresolvedSkills,
    stdoutTail: stripAnsi(tail(s.stdoutBuffer, tailLines)),
    stderrTail: stripAnsi(tail(s.stderrBuffer, tailLines)),
    pendingPrompt: s.pendingPrompt,
    logPath: s.logPath,
  };
}

/**
 * Test-only: reset all module state. Do NOT call from production code.
 */
export function __resetForTests(): void {
  killAllSessions();
  sessions.clear();
  procHandles.clear();
  detachedSessions.clear();
  sessionEmitters.forEach((em) => em.removeAllListeners());
  sessionEmitters.clear();
  sessionEventBuffers.clear();
  sessionSeqCounters.clear();
  sessionSubscribers.clear();
  setIdleScanHandle(null);
  logDirEnsured = false;
}

// ─── v1.5.17: Public event/subscription API ───────────────────────────────

/**
 * Subscribe to a session's events. The subscriber receives all NEW events
 * (no replay) — use `tailEvents` if you also need the history.
 *
 * Returns a `SessionSubscription` so the caller can stop receiving events
 * and (optionally) inspect what they missed.
 */
export function subscribeSession(
  sessionId: string,
  listener: SessionEventListener
): SessionSubscription | null {
  const s = sessions.get(sessionId) ?? detachedSessions.get(sessionId);
  if (!s) return null;
  ensureEmitter(sessionId);
  let subs = sessionSubscribers.get(sessionId);
  if (!subs) {
    subs = new Set();
    sessionSubscribers.set(sessionId, subs);
  }
  subs.add(listener);
  const replay = (sessionEventBuffers.get(sessionId) ?? []).slice();
  const lastSeq = replay.length > 0 ? replay[replay.length - 1].seq : 0;
  return {
    unsubscribe: () => {
      const set = sessionSubscribers.get(sessionId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) sessionSubscribers.delete(sessionId);
      }
    },
    replay,
    lastSeq,
  };
}

/** Return the buffered events for a session. `since=0` returns all. */
export function tailEvents(sessionId: string, since = 0, cap = MAX_EVENT_BUFFER): SessionEvent[] {
  const buf = sessionEventBuffers.get(sessionId) ?? [];
  if (since <= 0) return buf.slice(-cap);
  return buf.filter((e) => e.seq > since).slice(-cap);
}

/** Last delivered seq (0 if none). */
export function getLastEventSeq(sessionId: string): number {
  const buf = sessionEventBuffers.get(sessionId) ?? [];
  return buf.length > 0 ? buf[buf.length - 1].seq : 0;
}

// ─── v1.5.17: Idle TTL scanner ───────────────────────────────────────────

/** Internal — called by the interval. Returns the IDs that were killed. */
export async function scanIdleSessions(): Promise<string[]> {
  const now = Date.now();
  const killed: string[] = [];
  for (const s of sessions.values()) {
    if (s.detached) continue;
    if (s.status === "exited" || s.status === "errored") continue;
    if (s.idleTimeoutMs <= 0) continue;
    if (now - s.lastOutputAt > s.idleTimeoutMs) {
      s.autoKilled = true;
      s.status = "exited";
      emitEvent(s, "status", { status: s.status });
      // Best-effort: actually kill the process.
      const handle = procHandles.get(s.sessionId);
      if (handle && typeof handle.kill === "function") {
        try {
          handle.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      killed.push(s.sessionId);
    }
  }
  return killed;
}

/** Test-only: trigger an immediate scan instead of waiting for the interval. */
export function __triggerIdleCheckForTests(): Promise<string[]> {
  return scanIdleSessions();
}

/** v1.5.17: Per-session idle TTL update. 0 disables. */
export function setIdleTimeout(sessionId: string, ms: number): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (!Number.isFinite(ms) || ms < 0) return false;
  s.idleTimeoutMs = ms;
  return true;
}

// ─── v1.5.17: Detach / re-kill detached ──────────────────────────────────

/**
 * Detach a session: stop managing it, but do NOT terminate the process.
 * The child process keeps running. `session.list` will still show it (in
 * the "detached" bucket). `session.kill` works against detached sessions
 * too.
 */
export function detachSession(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return false;
  if (s.status === "exited" || s.status === "errored") return false;
  s.detached = true;
  sessions.delete(sessionId);
  detachedSessions.set(sessionId, s);
  emitEvent(s, "status", { status: s.status });
  return true;
}

/** Get a session from either the active or detached map. */
export function getSessionAny(sessionId: string): CliSession | null {
  return sessions.get(sessionId) ?? detachedSessions.get(sessionId) ?? null;
}

/** List detached session IDs. */
export function listDetachedSessions(): string[] {
  return Array.from(detachedSessions.keys());
}

/** Return a detached session object (for serialization). */
export function detachedSessionsFull(id: string): CliSession | undefined {
  return detachedSessions.get(id);
}

// ─── v1.5.17: Initial message auto-send ──────────────────────────────────

/** Internal — called by `startSession` once the process is ready. */
async function maybeAutoSendInitial(session: CliSession): Promise<void> {
  if (!session.autoSendInitial) return;
  const msg = session.pendingInitialMessage;
  if (!msg) return;
  // Clear so we don't double-send if status flips back to "ready".
  session.pendingInitialMessage = undefined;
  try {
    const tpl = "{system}\n\n{prompt}";
    const composed = session.systemPrompt
      ? tpl.replace(/\{system\}/g, session.systemPrompt).replace(/\{prompt\}/g, msg)
      : msg;
    await sendToSession({ sessionId: session.sessionId, message: composed, timeoutMs: DEFAULT_SEND_TIMEOUT_MS });
  } catch {
    // Swallow — auto-send failure should not crash the session. The error
    // appears in the session's log file; the LLM can still call session.send.
  }
}
