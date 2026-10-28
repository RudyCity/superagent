import { spawn, execFileSync, execFile, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Explicit launch intent for every subprocess created by SuperAgent.
 *
 * - `headless`: Internal tools, background commands, git, probes, tunnels, daemons,
 *   MCP commands, and one-shot CLI delegations. Always sets `windowsHide: true`.
 * - `capturedInteractive`: Persistent multi-turn interactive sessions with piped
 *   stdin/stdout/stderr (e.g., CLI Bridge sessions). Always sets `windowsHide: true`.
 * - `visibleTerminal`: Explicit user-requested visible OS terminal/window or browser
 *   (e.g., foreground `/terminal <command>` viewer window). Sets `windowsHide: false`.
 */
export type ProcessLaunchIntent =
  | "headless"
  | "capturedInteractive"
  | "visibleTerminal";

export interface ProcessTraceMeta {
  caller?: string;
  executable?: string;
  args?: readonly string[] | string;
  cwd?: string;
  intent?: ProcessLaunchIntent;
}

export interface ProcessTraceEvent {
  id: string;
  timestamp: string;
  phase: "spawn" | "exit";
  parentPid: number;
  childPid?: number;
  executable: string;
  argvSummary: string[];
  intent: ProcessLaunchIntent;
  caller: string;
  cwd?: string;
  shell: boolean | string;
  detached: boolean;
  windowsHide: boolean;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
}

export interface WindowsProcessNode {
  processId: number;
  parentProcessId: number;
  name: string;
  commandLineSummary: string;
  depth: number;
  ancestryPids: number[];
}

const MAX_TRACE_BUFFER = 500;
const traceBuffer: ProcessTraceEvent[] = [];
let traceEnabledOverride: boolean | null = null;
let traceSeq = 0;

const SENSITIVE_VALUE_FLAGS = new Set([
  "-p",
  "--prompt",
  "--api-key",
  "--apikey",
  "--token",
  "--access-token",
  "--refresh-token",
  "--client-secret",
  "--secret",
  "--password",
  "--pass",
  "--auth",
  "--bearer",
  "--header",
  "-h",
  "-e",
  "--encodedcommand",
  "-encodedcommand",
]);

const SENSITIVE_KEY_VALUE_RE =
  /^(--?(?:prompt|api[-_]?key|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|auth|bearer|header)|[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|PROMPT)[A-Z0-9_]*)\s*[:=]\s*(.+)$/i;

const INLINE_FLAG_PROMPT_RE = /^(-p|--prompt)=(.+)$/i;

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\bBasic\s+[A-Za-z0-9+/=]{6,}/gi,
  /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|token)\s*[:=]\s*)([^\s"'&]+)/gi,
];

/**
 * Redacts API keys, OAuth secrets, bearer tokens, and long payloads from any process string.
 */
export function redactSensitiveProcessText(input: string, maxLen = 120): string {
  if (!input) return "";
  let out = String(input);

  const kvMatch = out.match(SENSITIVE_KEY_VALUE_RE);
  if (kvMatch) {
    return `${kvMatch[1]}=[REDACTED]`;
  }
  const inlinePrompt = out.match(INLINE_FLAG_PROMPT_RE);
  if (inlinePrompt) {
    return `${inlinePrompt[1]}=[REDACTED_PROMPT len=${inlinePrompt[2].length}]`;
  }

  for (const pattern of TOKEN_PATTERNS) {
    out = out.replace(pattern, (...args) => {
      if (args.length >= 3 && typeof args[1] === "string" && typeof args[2] === "string") {
        return `${args[1]}[REDACTED]`;
      }
      if (/^Bearer\s+/i.test(args[0])) return "Bearer [REDACTED]";
      if (/^Basic\s+/i.test(args[0])) return "Basic [REDACTED]";
      return "[REDACTED]";
    });
  }

  // Collapse newlines so single-line trace logs stay clean
  out = out.replace(/[\r\n]+/g, " ").trim();

  if (out.length > maxLen) {
    return `${out.slice(0, Math.max(24, maxLen - 28))}...[TRUNCATED len=${out.length}]`;
  }
  return out;
}

/**
 * Produces a safe, redacted argv summary suitable for diagnostic logs and trace buffers.
 * Never logs raw prompts, `-EncodedCommand` payloads, API keys, or OAuth tokens.
 */
export function sanitizeArgvForTrace(
  args?: readonly string[] | string | null,
  maxItems = 16
): string[] {
  if (!args) return [];
  const rawList: string[] = Array.isArray(args)
    ? args.map((x) => String(x ?? ""))
    : [String(args)];

  const sanitized: string[] = [];
  let redactNext: "prompt" | "secret" | "encoded" | null = null;

  for (let i = 0; i < rawList.length; i++) {
    if (sanitized.length >= maxItems) {
      sanitized.push(`...[+${rawList.length - i} more args]`);
      break;
    }

    const token = rawList[i] ?? "";
    const lower = token.trim().toLowerCase();

    if (redactNext) {
      const kind = redactNext;
      redactNext = null;
      if (kind === "prompt") {
        sanitized.push(`[REDACTED_PROMPT len=${token.length}]`);
      } else if (kind === "encoded") {
        sanitized.push(`[REDACTED_ENCODED len=${token.length}]`);
      } else {
        sanitized.push("[REDACTED]");
      }
      continue;
    }

    if (lower === "-p" || lower === "--prompt") {
      sanitized.push(token);
      redactNext = "prompt";
      continue;
    }

    if (lower === "-encodedcommand" || lower === "--encodedcommand" || lower === "-e") {
      sanitized.push(token);
      redactNext = "encoded";
      continue;
    }

    if (SENSITIVE_VALUE_FLAGS.has(lower)) {
      sanitized.push(token);
      redactNext = "secret";
      continue;
    }

    sanitized.push(redactSensitiveProcessText(token, 96));
  }

  return sanitized;
}

/**
 * Returns whether process tracing is currently active.
 */
export function isProcessTraceEnabled(): boolean {
  if (traceEnabledOverride !== null) return traceEnabledOverride;
  return process.env.SUPERAGENT_PROCESS_TRACE === "1";
}

/**
 * Enables or disables process tracing programmatically (used by regression tests).
 */
export function setProcessTraceEnabledForTest(enabled: boolean | null): void {
  traceEnabledOverride = enabled;
}

/**
 * Returns a copy of the in-memory process trace buffer.
 */
export function getProcessTraceEvents(): ProcessTraceEvent[] {
  return [...traceBuffer];
}

/**
 * Clears the in-memory process trace buffer.
 */
export function clearProcessTraceEvents(): void {
  traceBuffer.length = 0;
}

function appendTraceEvent(event: ProcessTraceEvent): void {
  traceBuffer.push(event);
  if (traceBuffer.length > MAX_TRACE_BUFFER) {
    traceBuffer.splice(0, traceBuffer.length - MAX_TRACE_BUFFER);
  }

  const traceFile = process.env.SUPERAGENT_PROCESS_TRACE_FILE?.trim();
  if (traceFile) {
    try {
      fs.appendFileSync(traceFile, JSON.stringify(event) + "\n", "utf8");
    } catch {
      // Never fail a process launch due to trace file write errors
    }
  }
}

/**
 * Canonical Windows headless options object.
 */
export function windowsHeadlessOptions(): { windowsHide: true } {
  return { windowsHide: true };
}

/**
 * Applies the centralized process launch intent policy to a `child_process` or `execa`
 * options object without mutating the caller's object or stripping streaming/cancellation options.
 *
 * - `headless` -> `windowsHide: true`
 * - `capturedInteractive` -> `windowsHide: true`
 * - `visibleTerminal` -> `windowsHide: false`
 */
export function applyProcessIntent<T extends Record<string, any> = Record<string, any>>(
  options?: T,
  intent: ProcessLaunchIntent = "headless",
  meta?: ProcessTraceMeta
): T & { windowsHide: boolean } {
  const windowsHide = intent !== "visibleTerminal";
  const merged = {
    ...(options ?? ({} as T)),
    windowsHide,
  };

  if (meta && isProcessTraceEnabled()) {
    recordProcessLaunchTrace({
      ...meta,
      intent,
      options: merged,
    });
  }

  return merged;
}

/**
 * Records a sanitized process launch event when tracing is enabled.
 */
export function recordProcessLaunchTrace(params: {
  caller?: string;
  executable?: string;
  args?: readonly string[] | string;
  cwd?: string;
  intent?: ProcessLaunchIntent;
  childPid?: number;
  options?: Record<string, any>;
}): ProcessTraceEvent | null {
  if (!isProcessTraceEnabled()) return null;

  const opts = params.options ?? {};
  const intent: ProcessLaunchIntent =
    params.intent ?? (opts.windowsHide === false ? "visibleTerminal" : "headless");
  const windowsHide = typeof opts.windowsHide === "boolean" ? opts.windowsHide : intent !== "visibleTerminal";

  const event: ProcessTraceEvent = {
    id: `ptrace_${Date.now()}_${++traceSeq}`,
    timestamp: new Date().toISOString(),
    phase: "spawn",
    parentPid: process.pid,
    childPid: params.childPid,
    executable: redactSensitiveProcessText(params.executable || "<unknown>", 120),
    argvSummary: sanitizeArgvForTrace(params.args),
    intent,
    caller: params.caller || "unspecified",
    cwd: params.cwd || (typeof opts.cwd === "string" ? opts.cwd : undefined),
    shell: opts.shell ?? false,
    detached: Boolean(opts.detached),
    windowsHide,
  };

  appendTraceEvent(event);
  return event;
}

/**
 * Attaches non-intrusive lifecycle tracing (`spawn` + `exit`) to a spawned child process
 * or `execa` subprocess when `SUPERAGENT_PROCESS_TRACE=1` is active.
 */
export function traceChildProcess<
  T extends { pid?: number; on?: (...args: any[]) => any; once?: (...args: any[]) => any }
>(
  child: T,
  meta: ProcessTraceMeta & { options?: Record<string, any> }
): T {
  if (!child || !isProcessTraceEnabled()) return child;

  const startedAt = Date.now();
  const spawnEvent = recordProcessLaunchTrace({
    ...meta,
    childPid: child.pid,
  });

  const attachOnce = typeof child.once === "function" ? child.once.bind(child) : null;
  if (attachOnce && spawnEvent) {
    let recordedExit = false;
    const onFinish = (code: number | null, signal: string | null) => {
      if (recordedExit) return;
      recordedExit = true;
      appendTraceEvent({
        ...spawnEvent,
        id: `${spawnEvent.id}_exit`,
        timestamp: new Date().toISOString(),
        phase: "exit",
        childPid: child.pid ?? spawnEvent.childPid,
        exitCode: typeof code === "number" ? code : null,
        signal: typeof signal === "string" ? signal : null,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    };
    try {
      attachOnce("exit", onFinish);
    } catch {
      // Ignore if mock/custom process object does not support exit event
    }
  }

  return child;
}

/**
 * Spawns a hidden Windows `taskkill` process (`windowsHide: true`, `stdio: "ignore"`)
 * to terminate a PID (and its process tree when `tree = true`).
 */
export function spawnHiddenTaskkill(
  pid: number,
  tree = true,
  caller = "spawnHiddenTaskkill"
): ChildProcess | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const args = tree ? ["/F", "/T", "/PID", String(pid)] : ["/F", "/PID", String(pid)];
  const opts = applyProcessIntent(
    { stdio: "ignore" as const },
    "headless",
    { caller, executable: "taskkill", args }
  );
  try {
    const child = spawn("taskkill", args, opts);
    child.unref?.();
    return child;
  } catch {
    return null;
  }
}

/**
 * Synchronously executes a hidden Windows `taskkill` (`windowsHide: true`, `stdio: "ignore"`)
 * to terminate a PID (and its process tree when `tree = true`).
 */
export function execHiddenTaskkillSync(
  pid: number,
  tree = true,
  timeoutMs = 5000,
  caller = "execHiddenTaskkillSync"
): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const args = tree ? ["/F", "/T", "/PID", String(pid)] : ["/F", "/PID", String(pid)];
  const opts = applyProcessIntent(
    { stdio: "ignore" as const, timeout: timeoutMs },
    "headless",
    { caller, executable: "taskkill", args }
  );
  try {
    execFileSync("taskkill", args, opts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Queries Windows `Win32_Process` headlessly (`windowsHide: true`) and returns all
 * descendant processes rooted at `rootPid` (defaults to `process.pid`), including
 * ancestry chains and redacted command lines.
 */
export async function inspectWindowsProcessDescendants(
  rootPid: number = process.pid,
  timeoutMs = 8000
): Promise<WindowsProcessNode[]> {
  if (process.platform !== "win32") return [];

  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | Select-Object ProcessId, ParentProcessId, Name, @{Name='CommandLine';Expression={if ($_.CommandLine -and $_.CommandLine.Length -gt 300) { $_.CommandLine.Substring(0,300) } else { $_.CommandLine }}} | ConvertTo-Json -Compress",
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      applyProcessIntent(
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        "headless",
        { caller: "inspectWindowsProcessDescendants", executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "[Win32_Process]"] }
      )
    );

    const trimmed = String(stdout || "").trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    const byParent = new Map<number, Array<{ pid: number; ppid: number; name: string; cmd: string }>>();
    for (const item of items) {
      const pid = Number(item?.ProcessId);
      const ppid = Number(item?.ParentProcessId);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid && ppid === rootPid && String(item?.CommandLine || "").includes("Win32_Process")) {
        // Skip our own transient Win32_Process inspection powershell child
        continue;
      }
      const name = String(item?.Name || "");
      const cmd = String(item?.CommandLine || "");
      if (cmd.includes("Get-CimInstance Win32_Process")) continue;

      const list = byParent.get(ppid) ?? [];
      list.push({ pid, ppid, name, cmd });
      byParent.set(ppid, list);
    }

    const descendants: WindowsProcessNode[] = [];
    const queue: Array<{ pid: number; depth: number; ancestry: number[] }> = [
      { pid: rootPid, depth: 0, ancestry: [rootPid] },
    ];
    const visited = new Set<number>([rootPid]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const children = byParent.get(current.pid) ?? [];
      for (const child of children) {
        if (visited.has(child.pid)) continue;
        visited.add(child.pid);
        const ancestryPids = [...current.ancestry, child.pid];
        const depth = current.depth + 1;
        descendants.push({
          processId: child.pid,
          parentProcessId: child.ppid,
          name: child.name,
          commandLineSummary: redactSensitiveProcessText(child.cmd, 140),
          depth,
          ancestryPids,
        });
        queue.push({ pid: child.pid, depth, ancestry: ancestryPids });
      }
    }

    return descendants;
  } catch {
    return [];
  }
}

export interface AgySidecarDescriptor {
  pluginName: string;
  sidecarName: string;
  sidecarJsonPath: string;
  command: string;
  args: string[];
}

export interface AgyWindowsEnvironmentReport {
  platform: NodeJS.Platform;
  agyBinaryPath: string | null;
  agyBinaryIsNativeExe: boolean;
  agyNodeCmdPath: string | null;
  agyNodeTargetExe: string | null;
  sidecars: AgySidecarDescriptor[];
}

/**
 * Resolves a Windows CLI binary name or `.cmd`/`.bat` shim to a direct `.exe`
 * when a known native executable exists on disk (specifically `agy` / `agy.cmd` -> `agy.exe`).
 * Avoiding unnecessary `.cmd` batch wrappers eliminates intermediate `cmd.exe` process creation.
 */
export function resolveWindowsDirectExecutable(
  binary: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (process.platform !== "win32" || !binary) return binary;
  const trimmed = binary.trim();
  const base = path.basename(trimmed).toLowerCase();

  // Explicit existing paths are caller intent (custom/test installations) and must
  // not be silently redirected to a different machine-wide AGY installation.
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) return trimmed;

  if (base === "agy" || base === "agy.cmd" || base === "agy.bat" || base === "agy.exe") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const home = os.homedir();
    const candidates = [
      path.join(localAppData, "agy", "bin", "agy.exe"),
      path.join(home, ".agy", "bin", "agy.exe"),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Ignore inaccessible candidate
      }
    }
  }

  return binary;
}

/**
 * Inspects the local Windows AGY CLI installation, `agy-node.cmd` shim, and configured
 * plugin sidecars (`compose-preview`, `device-hub`, `biomolecular_structure_viewer`, etc.)
 * to verify binary types and sidecar launch chains.
 */
export function inspectAgyWindowsEnvironment(
  env: NodeJS.ProcessEnv = process.env
): AgyWindowsEnvironmentReport {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const appData = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const home = os.homedir();

  const resolvedAgy = resolveWindowsDirectExecutable("agy", env);
  const agyBinaryPath =
    resolvedAgy !== "agy" && fs.existsSync(resolvedAgy) ? resolvedAgy : null;
  const agyBinaryIsNativeExe = Boolean(
    agyBinaryPath && agyBinaryPath.toLowerCase().endsWith(".exe")
  );

  const agyNodeCandidate = path.join(appData, "Antigravity", "bin", "agy-node.cmd");
  let agyNodeCmdPath: string | null = null;
  let agyNodeTargetExe: string | null = null;
  try {
    if (fs.existsSync(agyNodeCandidate)) {
      agyNodeCmdPath = agyNodeCandidate;
      const content = fs.readFileSync(agyNodeCandidate, "utf8");
      const match = content.match(/"([^"]+\.exe)"/i);
      if (match?.[1]) {
        agyNodeTargetExe = match[1];
      }
    }
  } catch {
    // Best-effort inspection
  }

  const sidecars: AgySidecarDescriptor[] = [];
  const pluginsRoot = path.join(home, ".gemini", "config", "plugins");
  try {
    if (fs.existsSync(pluginsRoot)) {
      for (const pluginName of fs.readdirSync(pluginsRoot)) {
        const sidecarsDir = path.join(pluginsRoot, pluginName, "sidecars");
        if (!fs.existsSync(sidecarsDir) || !fs.statSync(sidecarsDir).isDirectory()) continue;
        for (const sidecarName of fs.readdirSync(sidecarsDir)) {
          const sidecarJsonPath = path.join(sidecarsDir, sidecarName, "sidecar.json");
          if (!fs.existsSync(sidecarJsonPath)) continue;
          try {
            const raw = JSON.parse(fs.readFileSync(sidecarJsonPath, "utf8"));
            sidecars.push({
              pluginName,
              sidecarName,
              sidecarJsonPath,
              command: String(raw?.command || ""),
              args: Array.isArray(raw?.args) ? raw.args.map(String) : [],
            });
          } catch {
            // Skip malformed sidecar.json
          }
        }
      }
    }
  } catch {
    // Best-effort inspection
  }

  return {
    platform: process.platform,
    agyBinaryPath,
    agyBinaryIsNativeExe,
    agyNodeCmdPath,
    agyNodeTargetExe,
    sidecars,
  };
}
