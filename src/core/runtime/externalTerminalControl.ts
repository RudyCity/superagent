/**
 * Explicit lifecycle controls for Windows development servers observed outside
 * SuperAgent. PID discovery is not ownership: every stop requires Full YOLO,
 * a one-time server-side operation, process birth verification and a second
 * in-command guard before Stop-Process. A command/cwd recipe must be supplied
 * by the operator to start a replacement (never replay an unknown command line).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { discoverExternalTerminalProcesses, invalidateExternalProcessCache,
  type ExternalTerminalProcess } from "./externalTerminalProcesses.js";

const execFileAsync = promisify(execFile);
const MAX_SNAPSHOTS = 64;
const STOP_TTL_MS = 45_000;
// SuperAgent and its bridges must be managed by their authenticated owners.
export const PROTECTED_EXTERNAL_PORTS = new Set([
  7888, 7891, 7892, 9223, 9224, 9225, 9227, 17341,
]);

interface ExternalRecord {
  taskId: string;
  pid: number;
  name: string;
  ports: number[];
  identity: string;
  lastSeen: number;
  stoppedAt?: number;
  command?: string;
  cwd?: string;
}
interface PendingStop { taskId: string; identity: string; expiresAt: number }
const records = new Map<string, ExternalRecord>();
const pendingStops = new Map<string, PendingStop>();
const inflightStops = new Set<string>();
const inflightStarts = new Set<string>();

const externalId = (pid: number) => "external-win-" + pid;

export function externalControlEligibility(
  observed: Pick<ExternalTerminalProcess, "pid" | "name" | "ports" | "creationIdentity">,
): { allowed: boolean; reason?: string } {
  if (process.platform !== "win32") return { allowed: false, reason: "External control is supported only on Windows." };
  if (!/^win:\d{15,20}$/.test(observed.creationIdentity || "")) {
    return { allowed: false, reason: "Process creation identity could not be verified." };
  }
  if (observed.pid === process.pid || observed.pid === process.ppid ||
      observed.name.toLowerCase() === "superagent.exe" ||
    observed.ports.some((port) => PROTECTED_EXTERNAL_PORTS.has(port))) {
    return { allowed: false, reason: "SuperAgent Core, MCP and internal bridges require owner-managed lifecycle controls." };
  }
  return { allowed: true };
}

export function observeExternalProcess(observed: ExternalTerminalProcess) {
  const taskId = externalId(observed.pid);
  const eligibility = externalControlEligibility(observed);
  const identity = observed.creationIdentity;
  if (!eligibility.allowed || !identity) {
    return { canStop: false, canStart: false, canConfigureStart: false, controlReason: eligibility.reason };
  }
  let record = records.get(taskId);
  if (!record || record.identity !== identity) {
    record = {
      taskId, pid: observed.pid, name: observed.name, ports: observed.ports,
      identity, lastSeen: Date.now(),
    };
    records.set(taskId, record);
  } else {
    record.lastSeen = Date.now();
    record.ports = observed.ports;
    record.stoppedAt = undefined; // observed running again; do not offer duplicate Start
  }
  if (records.size > MAX_SNAPSHOTS) {
    const first = records.keys().next().value;
    if (first && first !== taskId) records.delete(first);
  }
  return {
    canStop: true, canStart: false, canConfigureStart: true,
    controlReason: "External Stop requires local Full YOLO, verified process birth identity, and explicit confirmation.",
  };
}

/** Show only explicitly stopped processes in All Tasks (not as live PIDs). */
export function getStoppedExternalProcesses() {
  return [...records.values()].filter((record) => record.stoppedAt !== undefined)
    .map((record) => ({
      id: record.taskId,
      pid: record.pid,
      command: record.name + " (previously listening on " + record.ports.map((port) => ":" + port).join(", ") + ")",
      cwd: record.cwd || "Start command not configured",
      windowLabel: record.name + " · stopped",
      status: "killed" as const,
      source: "external" as const,
      isTerminal: true,
      canStop: false,
      canStart: Boolean(record.command && record.cwd),
      canConfigureStart: true,
      canViewLogs: false,
      controlReason: "Stopped by SuperAgent. Start uses the operator-provided command and working directory.",
      completedAt: record.stoppedAt,
    }));
}

function lookup(taskId: string): ExternalRecord {
  if (!/^external-win-[1-9]\d{0,9}$/.test(taskId)) throw new Error("Invalid external process task ID");
  const record = records.get(taskId);
  if (!record) throw new Error("External process is not in the current discovery session; refresh the list.");
  return record;
}

/** The operator must explicitly define a restart recipe. Not read from Win32_CommandLine. */
export function configureExternalStart(taskId: string, command: string, cwd: string) {
  const record = lookup(taskId);
  if (typeof command !== "string" || !command.trim() || command.length > 2048 ||
      command.includes("\0") || /[\r\n]/.test(command)) {
    throw new Error("Enter a non-empty single-line restart command (maximum 2048 characters).");
  }
  if (typeof cwd !== "string" || cwd.length > 600 || !path.isAbsolute(cwd) ||
      !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error("Enter an existing absolute working directory for the restart command.");
  }
  record.command = command.trim();
  record.cwd = path.resolve(cwd);
  return { success: true, taskId, canStart: Boolean(record.stoppedAt) };
}

export async function prepareExternalStop(taskId: string) {
  const record = lookup(taskId);
  if (record.stoppedAt) throw new Error("External process is already stopped.");
  const discovered = (await discoverExternalTerminalProcesses()).find((item) =>
    item.pid === record.pid && item.creationIdentity === record.identity);
  if (!discovered) throw new Error("External process changed or disappeared; refresh the list.");
  const eligibility = externalControlEligibility(discovered);
  if (!eligibility.allowed) throw new Error(eligibility.reason || "External process cannot be stopped safely.");
  if (await readProcessStartIdentity(record.pid) !== record.identity) {
    throw new Error("Process birth fingerprint changed. Refusing to stop reused PID.");
  }
  const operationId = crypto.randomBytes(24).toString("hex");
  pendingStops.set(operationId, { taskId, identity: record.identity, expiresAt: Date.now() + STOP_TTL_MS });
  if (pendingStops.size > 100) {
    for (const [key, value] of pendingStops) {
      if (value.expiresAt < Date.now() || pendingStops.size > 90) pendingStops.delete(key);
    }
  }
  return { success: true, operationId, pid: record.pid, name: record.name, ports: [...record.ports],
    hasRestartCommand: Boolean(record.command && record.cwd) };
}

/** Stop only one verified PID; no recursive taskkill and no unverified PID reuse. */
export async function stopExternalProcess(taskId: string, operationId: string) {
  const plan = pendingStops.get(operationId);
  pendingStops.delete(operationId); // one use even on failure
  const record = lookup(taskId);
  if (!plan || plan.taskId !== taskId || plan.identity !== record.identity ||
      plan.expiresAt < Date.now() || record.stoppedAt) {
    throw new Error("External stop authorization expired or does not match this process. Retry Stop.");
  }
  if (inflightStops.has(taskId)) throw new Error("Stop operation already underway.");
  inflightStops.add(taskId);
  try {
    if (await readProcessStartIdentity(record.pid) !== record.identity) {
      throw new Error("Process birth identity changed; refusing to stop.");
    }
    const command = buildVerifiedExternalStopScript(record);
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 12000, maxBuffer: 8192 }));
    } catch {
      // Do not surface a full encoded PowerShell command or sensitive OS details
      // through the authenticated Tray UI. The script intentionally fails closed.
      throw new Error("Windows refused the stop. The process may have changed, exited, lack permission, or belong to a protected service.");
    }
    if (stdout.trim() !== "STOPPED") {
      throw new Error("Windows did not acknowledge verified process termination.");
    }
    record.stoppedAt = Date.now();
    invalidateExternalProcessCache();
    return { success: true, taskId, status: "killed", canStart: Boolean(record.command && record.cwd) };
  } finally {
    inflightStops.delete(taskId);
  }
}

export function buildVerifiedExternalStopScript(record: Pick<ExternalRecord, "pid" | "identity" | "name">): string {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0 ||
      !/^win:\d{15,20}$/.test(record.identity) ||
      !/^(bun|node|deno|python|python3|pythonw|uvicorn|rudy|go|cargo|dotnet|java|ruby|php)\.exe$/i.test(record.name)) {
    throw new Error("Invalid external process identity.");
  }
  // The script double-checks PID birth, executable name and current ports
  // immediately before Stop-Process. Fixed numeric arguments, no user text.
  const protectedPorts = [...PROTECTED_EXTERNAL_PORTS].join(",");
  return [
    "$ErrorActionPreference='Stop'",
    "$pidToStop=" + record.pid,
    "$expectedTicks='" + record.identity.slice(4) + "'",
    "$expectedName='" + record.name.toLowerCase() + "'",
    "$item=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$pidToStop) -ErrorAction Stop",
    "if ($null -eq $item -or [string]$item.CreationDate.ToUniversalTime().Ticks -ne $expectedTicks -or $item.Name.ToLowerInvariant() -ne $expectedName) { throw 'Process identity changed' }",
    "$protected=@(" + protectedPorts + ")",
    "$connections=@(Get-NetTCPConnection -OwningProcess $pidToStop -ErrorAction Stop | Where-Object { (($_.State -eq 'Listen' -or $_.State -eq 2) -or ($null -eq $_.State -and $_.RemotePort -eq 0 -and $_.LocalPort -ge 3000)) })",
    "if ($connections.Count -eq 0) { throw 'No listening ports remain for this process' }",
    "$ports=@($connections | Select-Object -ExpandProperty LocalPort)",
    "if (@($ports | Where-Object { $protected -contains $_ }).Count -gt 0) { throw 'Service owner must manage protected SuperAgent ports' }",
    "if ($item.CommandLine -match '(?i)superagent(\\\\|/|\\\\s|[-.]exe|[-.]js|[-.]tsx)') { throw 'SuperAgent processes require authenticated service lifecycle' }",
    "Stop-Process -Id $pidToStop -Force -ErrorAction Stop",
    "Write-Output 'STOPPED'",
  ].join("\n");
}

export async function startStoppedExternal(taskId: string, launch: (command: string, cwd: string) => unknown) {
  if (inflightStarts.has(taskId)) throw new Error("Start operation is already in progress.");
  inflightStarts.add(taskId);
  try {
  const record = lookup(taskId);
  if (!record.stoppedAt) throw new Error("Stop the external process before starting its replacement.");
  if (!record.command || !record.cwd) throw new Error("Configure a restart command and working directory first.");
  if (!fs.existsSync(record.cwd) || !fs.statSync(record.cwd).isDirectory()) {
    throw new Error("Configured working directory no longer exists.");
  }
  const active = (await discoverExternalTerminalProcesses()).some((item) =>
    item.creationIdentity === record.identity && item.pid === record.pid);
  if (active) throw new Error("Original external process is still running; cannot start a duplicate.");
  // A new managed process gets a new task ID; the original external PID is never adopted.
  const result = launch(record.command, record.cwd);
  records.delete(taskId);
  invalidateExternalProcessCache();
  return result;
  } finally {
    inflightStarts.delete(taskId);
  }
}
