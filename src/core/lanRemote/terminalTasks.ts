/**
 * Attended LAN receiver terminal tasks.
 * Runs under Windows ConPTY when the Bun runtime supports it, or bounded pipes otherwise.
 * The task belongs to exactly one approved support-session ID, never to a device
 * name, caller-provided path or persistent credential. State stays in memory.
 */
import crypto from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { spawnWindowsConpty, type ConptyProcess } from "./bunConpty.js";

export const LAN_TERMINAL_MAX_COMMAND = 2000;
export const LAN_TERMINAL_MAX_INPUT = 1024;
export const LAN_TERMINAL_MAX_LIFETIME_MS = 10 * 60_000;
const MAX_BUFFER_CHARS = 64 * 1024;
const MAX_READ_CHARS = 8 * 1024;
const INPUT_IDLE_MS = 2 * 60_000;

type Chunk = { cursor: number; stream: "stdout" | "stderr"; text: string };
type Task = {
  jobId: string;
  sessionId: string;
  child: ChildProcessWithoutNullStreams | ConptyProcess;
  pty: ConptyProcess | null;
  cols: number;
  rows: number;
  decoders: { stdout: StringDecoder; stderr: StringDecoder };
  chunks: Chunk[];
  chars: number;
  cursor: number;
  running: boolean;
  stopping: boolean;
  exitCode: number | null;
  reason: string | null;
  deadline: ReturnType<typeof setTimeout>;
  idle: ReturnType<typeof setTimeout>;
};

export type LanTerminalSnapshot = {
  jobId: string;
  running: boolean;
  stopping: boolean;
  exitCode: number | null;
  reason: string | null;
  cursor: number;
  oldestCursor: number;
  nextCursor: number;
  truncated: boolean;
  chunks: Chunk[];
  mode: "conpty" | "pipe";
  cols: number;
  rows: number;
};

function commandIsValid(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= LAN_TERMINAL_MAX_COMMAND && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}
function inputIsValid(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= LAN_TERMINAL_MAX_INPUT && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}

export class LanTerminalTaskManager {
  private task: Task | null = null;

  hasRunning(): boolean { return this.task?.running === true; }

  start(sessionId: string, command: string): LanTerminalSnapshot {
    if (!commandIsValid(command)) throw Error("Terminal command must be 1–2000 printable characters.");
    if (!sessionId) throw Error("Approved terminal session required.");
    if (this.hasRunning()) throw Error("A remote terminal task is already running.");
    this.stopAll();
    const windows = process.platform === "win32";
    let currentTask: Task | null = null;
    const earlyData: Buffer[] = [];
    const pty = windows ? spawnWindowsConpty(command, data => {
      if (currentTask) append("stdout", data);
      else earlyData.push(data);
    }) : null;
    const child = pty ?? spawn(windows ? "powershell.exe" : "/bin/sh",
      windows ? ["-NoLogo", "-NoProfile", "-Command", command] : ["-c", command],
      { windowsHide: true, shell: false, detached: !windows, stdio: ["pipe", "pipe", "pipe"] });
    const task: Task = {
      jobId: crypto.randomUUID(), sessionId, child, pty, cols: 80, rows: 24,
      decoders: { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") },
      chunks: [], chars: 0,
      cursor: 0, running: true, stopping: false, exitCode: null, reason: null,
      deadline: undefined as unknown as ReturnType<typeof setTimeout>,
      idle: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    this.task = task;
    currentTask = task;
    const finish = (reason: string, exitCode: number | null = null) => {
      if (!task.running) return;
      task.running = false; task.stopping = false;
      task.reason = task.reason ?? reason; task.exitCode = exitCode;
      clearTimeout(task.deadline); clearTimeout(task.idle);
      if (pty) { try { pty.close(); } catch {} }
      else { try { (child as ChildProcessWithoutNullStreams).stdin.end(); } catch {} }
    };
    const terminate = (reason: string) => {
      if (this.task === task) this.stopAll(reason);
    };
    const idleReset = () => {
      clearTimeout(task.idle);
      task.idle = setTimeout(() => terminate("idle_timeout"), INPUT_IDLE_MS);
      task.idle.unref?.();
    };
    task.deadline = setTimeout(() => terminate("lifetime_timeout"), LAN_TERMINAL_MAX_LIFETIME_MS);
    task.deadline.unref?.();
    idleReset();
    function append(stream: "stdout" | "stderr", data: Buffer) {
      if (task !== currentTask) return;
      const value = task.decoders[stream].write(data);
      for (let i = 0; i < value.length; i += 1024) {
        const text = value.slice(i, i + 1024);
        task.chunks.push({ cursor: ++task.cursor, stream, text });
        task.chars += text.length;
      }
      while (task.chars > MAX_BUFFER_CHARS && task.chunks.length) {
        task.chars -= task.chunks.shift()!.text.length;
      }
    }
    for (const data of earlyData) append("stdout", data);
    if (pty) {
      void pty.exited.then(code => finish("exited", code), error => {
        append("stderr", Buffer.from(String(error)));
        finish("spawn_failed");
      });
    } else {
      const piped = child as ChildProcessWithoutNullStreams;
      piped.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE" && task.running && !task.stopping)
          append("stderr", Buffer.from("Terminal stdin: " + error.message));
      });
      piped.stdout.on("data", (data: Buffer) => append("stdout", data));
      piped.stderr.on("data", (data: Buffer) => append("stderr", data));
      piped.once("error", (error: Error) => {
        append("stderr", Buffer.from(error.message)); finish("spawn_failed");
      });
      piped.once("close", (code: number | null) => finish("exited", code));
    }
    return this.read(sessionId, task.jobId, 0);
  }

  read(sessionId: string, jobId: string, cursor = 0): LanTerminalSnapshot {
    const task = this.forSession(sessionId, jobId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > task.cursor) throw Error("Invalid terminal cursor.");
    // An authorized polling controller keeps its active task alive across
    // transient request disconnects. No polling for 2 minutes means stop.
    if (task.running && !task.stopping) {
      clearTimeout(task.idle);
      task.idle = setTimeout(() => {
        if (this.task === task) this.stopAll("idle_timeout");
      }, INPUT_IDLE_MS);
      task.idle.unref?.();
    }
    const oldestCursor = task.chunks[0]?.cursor ?? task.cursor + 1;
    const truncated = cursor < oldestCursor - 1;
    const chunks: Chunk[] = [];
    let size = 0;
    for (const item of task.chunks) {
      if (item.cursor <= cursor) continue;
      if (size + item.text.length > MAX_READ_CHARS) break;
      chunks.push(item); size += item.text.length;
    }
    return {
      jobId: task.jobId, running: task.running, stopping: task.stopping, exitCode: task.exitCode,
      reason: task.reason, cursor: task.cursor, oldestCursor,
      nextCursor: chunks.at(-1)?.cursor ?? Math.max(cursor, oldestCursor - 1),
      truncated, chunks, mode: task.pty ? "conpty" : "pipe", cols: task.cols, rows: task.rows,
    };
  }

  input(sessionId: string, jobId: string, text: string, appendNewline = false): LanTerminalSnapshot {
    const task = this.forSession(sessionId, jobId);
    if (!task.running || task.stopping) throw Error("Terminal is not running.");
    if (!inputIsValid(text) || typeof appendNewline !== "boolean") throw Error("Invalid terminal input.");
    if (task.pty) {
      task.pty.write(text + (appendNewline ? "\r" : ""));
    } else {
      const stdin = (task.child as ChildProcessWithoutNullStreams).stdin;
      if (!stdin.writable) throw Error("Terminal is not running.");
      if (stdin.writableLength + text.length > 16 * 1024)
        throw Error("Terminal input queue is full; read output before retrying.");
      stdin.write(text + (appendNewline ? "\n" : ""));
    }
    clearTimeout(task.idle);
    task.idle = setTimeout(() => this.stopAll("idle_timeout"), INPUT_IDLE_MS);
    task.idle.unref?.();
    return this.read(sessionId, jobId, task.cursor);
  }

  key(sessionId: string, jobId: string, key: string): LanTerminalSnapshot {
    const task = this.forSession(sessionId, jobId);
    if (!task.running || task.stopping) throw Error("Terminal is not running.");
    if (!task.pty) throw Error("Terminal key input requires ConPTY.");
    const keys: Record<string, string> = {
      Enter: "\r", Backspace: "\x7f", Tab: "\t", Escape: "\x1b",
      ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowRight: "\x1b[C", ArrowLeft: "\x1b[D",
      Home: "\x1b[H", End: "\x1b[F", Delete: "\x1b[3~",
      PageUp: "\x1b[5~", PageDown: "\x1b[6~", CtrlC: "\x03",
    };
    if (!Object.hasOwn(keys, key)) throw Error("Unsupported terminal key.");
    task.pty.write(keys[key]!);
    clearTimeout(task.idle);
    task.idle = setTimeout(() => this.stopAll("idle_timeout"), INPUT_IDLE_MS);
    task.idle.unref?.();
    return this.read(sessionId, jobId, task.cursor);
  }

  resize(sessionId: string, jobId: string, cols: number, rows: number): LanTerminalSnapshot {
    const task = this.forSession(sessionId, jobId);
    if (!Number.isSafeInteger(cols) || cols < 20 || cols > 300 ||
        !Number.isSafeInteger(rows) || rows < 5 || rows > 120)
      throw Error("Invalid terminal dimensions.");
    if (!task.running || task.stopping) throw Error("Terminal is not running.");
    if (!task.pty) throw Error("Terminal resize requires ConPTY.");
    task.pty.resize(cols, rows);
    task.cols = cols; task.rows = rows;
    return this.read(sessionId, jobId, task.cursor);
  }

  stop(sessionId: string, jobId: string): LanTerminalSnapshot {
    const task = this.forSession(sessionId, jobId);
    if (task.running) this.stopAll("stopped_by_owner");
    return this.read(sessionId, jobId, task.cursor);
  }

  stopAll(reason = "session_revoked"): void {
    const task = this.task;
    if (!task) return;
    if (!task.running) { this.task = null; return; }
    if (task.stopping) return;
    task.stopping = true; task.reason = reason;
    clearTimeout(task.deadline); clearTimeout(task.idle);
    const pid = task.child.pid;
    try {
      if (!task.pty) (task.child as ChildProcessWithoutNullStreams).stdin.destroy();
      if (process.platform !== "win32" && pid) process.kill(-pid, "SIGKILL");
      else task.child.kill();
    } catch {}
    if (process.platform === "win32" && pid) {
      const reaper = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" });
      reaper.once("error", () => {});
    }
  }

  private forSession(sessionId: string, jobId: string): Task {
    const task = this.task;
    if (!task || task.sessionId !== sessionId || task.jobId !== jobId)
      throw Error("Terminal task not found in this approved session.");
    return task;
  }
}
