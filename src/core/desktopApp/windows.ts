import path from "node:path";
import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type {
  DesktopAppLifecycleProvider,
  ExactWindowIdentity,
  InstalledApplication,
} from "./types.js";

const WINDOWS_ROOT = process.env.SystemRoot || process.env.windir || "C:\\Windows";
const WINDOWS_POWERSHELL = path.win32.join(WINDOWS_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const WINDOWS_EXPLORER = path.win32.join(WINDOWS_ROOT, "explorer.exe");

const START_APPS_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$payload = ConvertFrom-Json $env:SUPERAGENT_DESKTOP_APP_PAYLOAD
$limit = [int]$payload.limit
if ($limit -lt 1 -or $limit -gt 100) { throw "INVALID_ACTION: limit must be between 1 and 100" }
$items = @(Get-StartApps | Where-Object {
  -not [string]::IsNullOrWhiteSpace($_.Name) -and -not [string]::IsNullOrWhiteSpace($_.AppID)
} | Sort-Object Name | Select-Object -First ($limit + 1) | ForEach-Object {
  [pscustomobject]@{ id = [string]$_.AppID; name = [string]$_.Name }
})
[pscustomobject]@{
  applications = @($items | Select-Object -First $limit)
  truncated = ($items.Count -gt $limit)
} | ConvertTo-Json -Depth 4 -Compress
`;

const REGISTRY_PROGRAMS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$payload = ConvertFrom-Json $env:SUPERAGENT_DESKTOP_APP_PAYLOAD',
  '$limit = [int]$payload.limit',
  'if ($limit -lt 1 -or $limit -gt 100) { throw "INVALID_ACTION: invalid registry list limit" }',
  '$keys = @("HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
  '  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
  '  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*")',
  '$seen = @{}',
  '$items = @()',
  '$rows = @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Sort-Object DisplayName)',
  'foreach ($row in $rows) {',
  '  $name = [string]$row.DisplayName',
  '  if (-not $name.Trim() -or $name.Length -gt 256) { continue }',
  '  $version = [string]$row.DisplayVersion',
  '  $publisher = [string]$row.Publisher',
  '  $identity = $name.ToLowerInvariant() + "|" + $version.ToLowerInvariant()',
  '  if ($seen.ContainsKey($identity)) { continue }',
  '  $seen[$identity] = $true',
  '  $items += [pscustomobject]@{ name = $name; version = $version; publisher = $publisher }',
  '  if ($items.Count -gt $limit) { break }',
  '}',
  '[pscustomobject]@{ programs = @($items | Select-Object -First $limit); truncated = ($items.Count -gt $limit) } | ConvertTo-Json -Depth 4 -Compress',
].join("\n");

const WINDOW_ACTION_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SuperAgentDesktopAppWindow {
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$payload = ConvertFrom-Json $env:SUPERAGENT_DESKTOP_APP_PAYLOAD
$pidValue = [int]$payload.pid
$hwnd = [IntPtr]([Int64]::Parse([string]$payload.nativeId))
if ($pidValue -le 0 -or $hwnd -eq [IntPtr]::Zero -or -not [SuperAgentDesktopAppWindow]::IsWindow($hwnd)) {
  throw "TARGET_NOT_FOUND: exact native window is unavailable"
}
if ([SuperAgentDesktopAppWindow]::GetAncestor($hwnd, 2) -ne $hwnd) {
  throw "TARGET_NOT_FOUND: nativeId is not a root top-level window"
}
[uint32]$ownerPid = 0
[void][SuperAgentDesktopAppWindow]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
if ([int]$ownerPid -ne $pidValue) { throw "TARGET_NOT_FOUND: pid/nativeId ownership mismatch" }
if ($payload.action -eq "focus") {
  if (-not [SuperAgentDesktopAppWindow]::SetForegroundWindow($hwnd)) {
    throw "INPUT_UNAVAILABLE: Windows refused foreground activation"
  }
  [pscustomobject]@{ ok=$true } | ConvertTo-Json -Compress
  exit 0
}
if ($payload.action -eq "close") {
  if (-not [SuperAgentDesktopAppWindow]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
    throw "INPUT_UNAVAILABLE: WM_CLOSE could not be posted"
  }
  [pscustomobject]@{ ok=$true } | ConvertTo-Json -Compress
  exit 0
}
if ($payload.action -eq "exists") {
  [pscustomobject]@{ ok=$true; exists=$true } | ConvertTo-Json -Compress
  exit 0
}
throw "INVALID_ACTION: unsupported window action"
`;

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function requireAppId(value: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new DesktopUiError("INVALID_ACTION", "appId must be a bounded installed application identifier.");
  }
  if (/[\\/]/.test(id) || /^[a-z][a-z0-9+.-]*:/i.test(id)) {
    throw new DesktopUiError("INVALID_ACTION", "appId must be an AppsFolder identifier, not a path or URL.");
  }
  return id;
}

function requireTarget(target: ExactWindowIdentity): ExactWindowIdentity {
  if (!Number.isInteger(target.pid) || target.pid <= 0) {
    throw new DesktopUiError("INVALID_ACTION", "pid must be a positive integer.");
  }
  const nativeId = typeof target.nativeId === "string" ? target.nativeId.trim() : "";
  if (!/^\d{1,20}$/.test(nativeId)) {
    throw new DesktopUiError("INVALID_ACTION", "Windows nativeId must be an exact decimal HWND identity.");
  }
  return { pid: target.pid, nativeId };
}

export function createWindowsDesktopAppProvider(
  runner: DesktopProcessRunner = createRestrictedProcessRunner([WINDOWS_POWERSHELL, WINDOWS_EXPLORER]),
): DesktopAppLifecycleProvider {
  const runPowerShell = (script: string, payload: unknown) => runner.run({
    executable: WINDOWS_POWERSHELL,
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(script)],
    env: { SUPERAGENT_DESKTOP_APP_PAYLOAD: JSON.stringify(payload) },
    timeoutMs: 10_000,
  });

  const listApplications = async (limit: number) => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DesktopUiError("INVALID_ACTION", "Application discovery limit must be between 1 and 100.");
    }
    const result = await runPowerShell(START_APPS_SCRIPT, { limit });
    const parsed = JSON.parse(result.stdout || "{}") as { applications?: Array<{ id?: unknown; name?: unknown }>; truncated?: boolean };
    const applications: InstalledApplication[] = [];
    for (const entry of Array.isArray(parsed.applications) ? parsed.applications : []) {
      if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      try {
        const id = requireAppId(entry.id);
        const name = entry.name.trim();
        if (!name || name.length > 256) continue;
        applications.push({ id, name, platform: "win32", launchKind: "windows-apps-folder" });
      } catch {}
    }
    return { applications: applications.slice(0, limit), truncated: parsed.truncated === true || applications.length > limit };
  };

  const runWindowAction = async (target: ExactWindowIdentity, action: "focus" | "close" | "exists") => {
    const exact = requireTarget(target);
    return runPowerShell(WINDOW_ACTION_SCRIPT, { ...exact, action });
  };

  return {
    listApplications,

    async listRegisteredPrograms(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new DesktopUiError("INVALID_ACTION", "Registry inventory limit must be between 1 and 100.");
      }
      const response = await runPowerShell(REGISTRY_PROGRAMS_SCRIPT, { limit });
      const parsed = JSON.parse(response.stdout || "{}") as {
        programs?: Array<{ name?: unknown; version?: unknown; publisher?: unknown }>;
        truncated?: boolean;
      };
      const programs = (Array.isArray(parsed.programs) ? parsed.programs : [])
        .filter((item) => typeof item.name === "string" && item.name.length > 0 && item.name.length <= 256)
        .map((item) => ({
          name: String(item.name),
          ...(typeof item.version === "string" && item.version.length <= 100 && item.version ? { version: item.version } : {}),
          ...(typeof item.publisher === "string" && item.publisher.length <= 256 && item.publisher ? { publisher: item.publisher } : {}),
        }));
      return { programs: programs.slice(0, limit), truncated: parsed.truncated === true || programs.length > limit };
    },

    async launchVerified(appId) {
      const id = requireAppId(appId);
      const discovered = await listApplications(100);
      if (!discovered.applications.some((app) => app.id === id)) {
        throw new DesktopUiError("TARGET_NOT_FOUND", "Application ID was not found in fresh Windows Start app discovery.");
      }
      await runner.run({
        executable: WINDOWS_EXPLORER,
        args: [`shell:AppsFolder\\${id}`],
        timeoutMs: 10_000,
      });
      return { launched: true, appId: id };
    },

    async focusExact(target) {
      await runWindowAction(target, "focus");
      return { focused: true };
    },

    async closeExact(target) {
      await runWindowAction(target, "close");
      return { closeRequested: true };
    },

    async waitUntilClosed(target, timeoutMs) {
      const exact = requireTarget(target);
      const deadline = Date.now() + Math.max(100, Math.min(timeoutMs, 5_000));
      while (Date.now() < deadline) {
        try {
          await runWindowAction(exact, "exists");
        } catch (error) {
          if (error instanceof DesktopUiError && error.code === "TARGET_NOT_FOUND") return true;
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("TARGET_NOT_FOUND")) return true;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    },
  };
}
