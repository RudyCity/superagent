/**
 * Explicit Windows per-user logon startup plan for safe Core boot.
 * Build and preview are pure; no OS task is registered unless operator
 * invokes the returned PowerShell installer manually.
 */
import path from "node:path";
export interface CoreWindowsStartupPlan {
  port: number; taskName: string; launcherFile: string;
  launcherContent: string; registerCommand: string; inspectCommand: string;
  removeCommand: string;
}
const psString = (value: string): string => "'" + value.replace(/'/g, "''") + "'";
function goodWindowsPath(value: string): boolean {
  return path.win32.isAbsolute(value) && !/[\r\n\0]/.test(value) &&
    !/[\u0001-\u001f]/.test(value) &&
    !value.startsWith("\\\\"); // no UNC or remote binaries
}
export function createCoreWindowsStartupPlan(options: {
  port: number; cliFile: string; bunExecutable: string; launcherFile: string;
  clientMode?: "tline" | "chrome-extension";
}): CoreWindowsStartupPlan {
  const { port, cliFile, bunExecutable, launcherFile } = options;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      !goodWindowsPath(cliFile) || !goodWindowsPath(bunExecutable) ||
      !goodWindowsPath(launcherFile) ||
      !cliFile.toLowerCase().endsWith(".js") ||
      !bunExecutable.toLowerCase().endsWith(".exe") ||
      !launcherFile.toLowerCase().endsWith(".ps1") ||
      !["tline", "chrome-extension"].includes(options.clientMode ?? "tline")) {
    throw new Error("Invalid Windows Core startup plan options");
  }
  const taskName = "SuperAgent-Core-Boot-" + port;
  const mode = options.clientMode ?? "tline";
  // Child executable is invoked directly by the installer-owned script;
  // no cmd.exe, password, bearer token or downloaded component is involved.
  const launcherContent = [
    "$ErrorActionPreference = 'Stop'",
    "& " + psString(bunExecutable) + " " + psString(cliFile) +
      " core boot --port " + port + " --client-mode " + mode,
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
  const taskArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File " +
    '"' + launcherFile.replace(/"/g, '""') + '"';
  const registerCommand = [
    "$ErrorActionPreference = 'Stop'",
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument " + psString(taskArgs),
    "$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $account",
    "$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)",
    "$principal = New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited",
    "Register-ScheduledTask -TaskName " + psString(taskName) +
      " -Action $action -Trigger $trigger -Settings $settings -Principal $principal" +
      " -Description 'Local-only Core boot; checkpoint recovery fails closed; no external transports' -ErrorAction Stop",
  ].join("\r\n");
  const inspectCommand = "Get-ScheduledTask -TaskName " + psString(taskName) +
    " | Select-Object TaskName, State";
  const removeCommand = "Unregister-ScheduledTask -TaskName " + psString(taskName) +
    " -Confirm:$true";
  return { port, taskName, launcherFile, launcherContent, registerCommand,
    inspectCommand, removeCommand };
}
