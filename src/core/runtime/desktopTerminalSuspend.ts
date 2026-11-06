/**
 * Suspend/resume only processes spawned by this Core's Terminal Manager.
 * On Windows PowerShell takes a single snapshot of the owned child tree,
 * validates every process creation timestamp and suspends descendants before
 * the shell. This must never be used for discovered or restored PIDs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export interface SuspendedProcess { pid: number; ticks: string }

const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TerminalSuspend {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("ntdll.dll")]
  public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")]
  public static extern int NtResumeProcess(IntPtr handle);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
function Set-ProcessState([int]$id, [bool]$resume) {
  $handle = [TerminalSuspend]::OpenProcess(0x0800, $false, $id)
  if ($handle -eq [IntPtr]::Zero) { throw "Cannot open owned process $id for suspend/resume" }
  try {
    if ($resume) { $code = [TerminalSuspend]::NtResumeProcess($handle) }
    else { $code = [TerminalSuspend]::NtSuspendProcess($handle) }
    if ($code -ne 0) { throw "Windows suspend/resume failed for PID $id (NTSTATUS $code)" }
  } finally { [void][TerminalSuspend]::CloseHandle($handle) }
}
$all = @(Get-CimInstance Win32_Process)
$root = $all | Where-Object { $_.ProcessId -eq $rootPid } | Select-Object -First 1
if ($null -eq $root -or [string]$root.CreationDate.ToUniversalTime().Ticks -ne $rootTicks) {
  throw "Owned terminal process creation identity changed"
}
if ($operation -eq 'pause') {
  $targets = New-Object System.Collections.ArrayList
  [void]$targets.Add($root)
  for ($i = 0; $i -lt $targets.Count; $i++) {
    if ($targets.Count -gt 128) { throw "Process tree too large to pause safely" }
    $parent = $targets[$i]
    foreach ($child in $all) {
      if ($child.ParentProcessId -eq $parent.ProcessId -and
          $child.CreationDate.ToUniversalTime().Ticks -ge $parent.CreationDate.ToUniversalTime().Ticks -and
          -not (@($targets | Where-Object { $_.ProcessId -eq $child.ProcessId }).Count)) {
        [void]$targets.Add($child)
      }
    }
  }
  $done = New-Object System.Collections.ArrayList
  try {
    for ($i = $targets.Count - 1; $i -ge 0; $i--) {
      $item = $targets[$i]
      Set-ProcessState ([int]$item.ProcessId) $false
      [void]$done.Add($item)
    }
  } catch {
    foreach ($item in $done) { try { Set-ProcessState ([int]$item.ProcessId) $true } catch {} }
    throw
  }
  $result = @($targets | ForEach-Object { @{ pid = [int]$_.ProcessId; ticks = [string]$_.CreationDate.ToUniversalTime().Ticks } })
  ConvertTo-Json -InputObject $result -Compress -Depth 3
} elseif ($operation -eq 'resume') {
  $saved = @($savedJson | ConvertFrom-Json)
  foreach ($item in $saved) {
    $match = $all | Where-Object { $_.ProcessId -eq $item.pid } | Select-Object -First 1
    if ($null -ne $match -and [string]$match.CreationDate.ToUniversalTime().Ticks -eq [string]$item.ticks) {
      Set-ProcessState ([int]$item.pid) $true
    }
  }
  Write-Output '[]'
} else { throw "Invalid terminal process operation" }
`;

export async function suspendOwnedTerminalProcess(
  pid: number,
  expectedIdentity: string,
): Promise<SuspendedProcess[]> {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGSTOP");
    return [{ pid, ticks: expectedIdentity }];
  }
  return runWindows("pause", pid, expectedIdentity, []);
}

export async function resumeOwnedTerminalProcess(
  pid: number,
  expectedIdentity: string,
  suspended: SuspendedProcess[],
): Promise<void> {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGCONT");
    return;
  }
  await runWindows("resume", pid, expectedIdentity, suspended);
}

async function runWindows(
  operation: "pause" | "resume",
  pid: number,
  identity: string,
  saved: SuspendedProcess[],
): Promise<SuspendedProcess[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^win:\d{15,20}$/.test(identity)) {
    throw new Error("Owned terminal process has no verified Windows creation identity");
  }
  const rootTicks = identity.slice(4);
  // All values are internal PID/identity metadata, never user shell commands.
  const savedJson = JSON.stringify(saved);
  const prelude = "$rootPid=" + pid + ";$rootTicks='" + rootTicks +
    "';$operation='" + operation + "';$savedJson='" + savedJson.replace(/'/g, "''") + "';\n";
  const { stdout } = await execFileAsync("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", prelude + windowsScript],
    { windowsHide: true, timeout: 12000, maxBuffer: 16000 });
  const parsed = JSON.parse(stdout.trim());
  if (!Array.isArray(parsed)) throw new Error("Invalid terminal process control result");
  return parsed.map((entry: any) => {
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 ||
      !/^\d{15,20}$/.test(String(entry.ticks))) {
      throw new Error("Invalid owned process identity returned by Windows");
    }
    return { pid: entry.pid, ticks: String(entry.ticks) };
  });
}
