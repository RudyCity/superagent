/**
 * Best-effort, read-only discovery of externally launched Windows development servers.
 *
 * These processes have no SuperAgent ownership lease or child-process handle.
 * Birth-verified, operator-confirmed controls live in externalTerminalControl.
 * Raw command lines and environment secrets are never exposed.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_MS = 8_000;
const MAX_PROCESSES = 64;
const MAX_PORTS_PER_PROCESS = 12;

const WINDOWS_PROCESS_SNAPSHOT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$portsByPid = @{}",
  "Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {",
  "  $_.OwningProcess -gt 0 -and $_.LocalPort -ge 1024 -and",
  "  (($_.State -eq 'Listen' -or $_.State -eq 2) -or",
  "    ($null -eq $_.State -and $_.RemotePort -eq 0 -and $_.LocalPort -ge 3000))",
  "} | ForEach-Object {",
  "  $key = [string]$_.OwningProcess",
  "  if (-not $portsByPid.ContainsKey($key)) { $portsByPid[$key] = @() }",
  "  $portsByPid[$key] += [int]$_.LocalPort",
  "}",
  "$allowed = @('bun.exe', 'node.exe', 'deno.exe', 'python.exe', 'python3.exe', 'pythonw.exe', 'uvicorn.exe', 'rudy.exe', 'go.exe', 'cargo.exe', 'dotnet.exe', 'java.exe', 'ruby.exe', 'php.exe')",
  "$result = New-Object 'System.Collections.Generic.List[object]'",
  "if ($portsByPid.Count -gt 0) {",
  "  Get-CimInstance Win32_Process -Property ProcessId,Name,CreationDate -ErrorAction SilentlyContinue | ForEach-Object {",
  "    $key = [string]$_.ProcessId",
  "    if ($allowed -contains $_.Name -and $portsByPid.ContainsKey($key) -and $result.Count -lt 64) {",
  "      $ticks = if ($null -ne $_.CreationDate) { [string]$_.CreationDate.ToUniversalTime().Ticks } else { ''}",
  "      $result.Add([pscustomobject]@{ ProcessId = $_.ProcessId; Name = $_.Name; Ports = @($portsByPid[$key]); CreationTicks = $ticks })",
  "    }",
  "  }",
  "}",
  "ConvertTo-Json -InputObject @($result.ToArray()) -Compress -Depth 4",
].join("\n");

const RUNTIME_NAMES = new Set([
  "bun.exe", "node.exe", "deno.exe", "python.exe", "python3.exe",
  "pythonw.exe", "uvicorn.exe", "rudy.exe", "go.exe", "cargo.exe",
  "dotnet.exe", "java.exe", "ruby.exe", "php.exe",
]);

export interface ExternalTerminalProcess {
  pid: number;
  name: string;
  ports: number[];
  creationIdentity?: string;
}

/** Validate and bound untrusted OS inventory results; no command lines are retained. */
export function parseExternalProcessSnapshot(raw: unknown): ExternalTerminalProcess[] {
  const entries = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const grouped = new Map<number, ExternalTerminalProcess>();

  for (const entry of entries.slice(0, 256)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const pid = Number(value.ProcessId);
    const name = String(value.Name ?? "").toLowerCase();
    if (!Number.isSafeInteger(pid) || pid <= 0 || !RUNTIME_NAMES.has(name)) continue;

    const rawPorts = Array.isArray(value.Ports) ? value.Ports : [value.Ports];
    const ports = rawPorts
      .map((v) => Number(v))
      .filter((p) => Number.isInteger(p) && p >= 1024 && p <= 65535)
      .slice(0, MAX_PORTS_PER_PROCESS);
    if (ports.length === 0) continue;

    const creationTicks = String(value.CreationTicks ?? "");
    const creationIdentity = /^\d{15,20}$/.test(creationTicks) ? `win:${creationTicks}` : undefined;
    const previous = grouped.get(pid);
    const allPorts = [...new Set([...(previous?.ports ?? []), ...ports])]
      .sort((a, b) => a - b)
      .slice(0, MAX_PORTS_PER_PROCESS);
    grouped.set(pid, { pid, name, ports: allPorts,
      ...(creationIdentity || previous?.creationIdentity
        ? { creationIdentity: creationIdentity || previous?.creationIdentity } : {}),
    });
    if (grouped.size >= MAX_PROCESSES) break;
  }
  return [...grouped.values()].sort((a, b) => a.ports[0] - b.ports[0] || a.pid - b.pid);
}

let cache: { expiresAt: number; processes: ExternalTerminalProcess[] } | undefined;
let pending: Promise<ExternalTerminalProcess[]> | undefined;

export function invalidateExternalProcessCache(): void { cache = undefined; }

/** Non-Windows hosts currently rely on SuperAgent's owned process registry. */
export async function discoverExternalTerminalProcesses(): Promise<ExternalTerminalProcess[]> {
  if (process.platform !== "win32") return [];
  if (cache && Date.now() < cache.expiresAt) return cache.processes;
  if (pending) return pending;

  pending = (async () => {
    let processes: ExternalTerminalProcess[] = [];
    try {
      const encoded = Buffer.from(WINDOWS_PROCESS_SNAPSHOT, "utf16le").toString("base64");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 7_000, maxBuffer: 256 * 1024 },
      );
      processes = parseExternalProcessSnapshot(JSON.parse(stdout.trim()));
    } catch {
      // Discovery is observational: never block or break the terminal manager.
    }
    cache = { expiresAt: Date.now() + CACHE_MS, processes };
    return processes;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}
