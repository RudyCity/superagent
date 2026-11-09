import path from "node:path";
import { DesktopUiError } from "../desktopUi/errors.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../desktopUi/processRunner.js";
import type { DesktopPlatform } from "../desktopUi/types.js";

export interface SecurityPromptObservation {
  kind: "uac" | "firewall" | "admin";
  detected: boolean;
  humanApprovalRequired: true;
  processId?: number;
  publisher?: string;
  target?: string;
  scope: string;
}

export interface SecurityPromptReport {
  platform: DesktopPlatform;
  supported: boolean;
  observations: SecurityPromptObservation[];
  limitations: string[];
}

const WINDOWS_POWERSHELL = path.win32.join(
  process.env.SystemRoot || process.env.windir || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const WINDOWS_PROMPT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$items = @()
Get-Process -Name consent -ErrorAction SilentlyContinue | Select-Object -First 4 | ForEach-Object {
  $publisher = $null
  try {
    if ($_.Path) {
      $sig = Get-AuthenticodeSignature -LiteralPath $_.Path
      if ($sig.SignerCertificate) { $publisher = [string]$sig.SignerCertificate.Subject }
    }
  } catch {}
  $items += [pscustomobject]@{
    kind = "uac"
    detected = $true
    humanApprovalRequired = $true
    processId = [int]$_.Id
    publisher = $publisher
    target = $null
    scope = "Windows secure desktop consent process"
  }
}
[pscustomobject]@{
  observations = $items
} | ConvertTo-Json -Depth 5 -Compress
`;

export async function inspectSecurityPrompts(options: {
  platform?: NodeJS.Platform;
  runner?: DesktopProcessRunner;
} = {}): Promise<SecurityPromptReport> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const runner = options.runner ?? createRestrictedProcessRunner([WINDOWS_POWERSHELL]);
    try {
      const result = await runner.run({
        executable: WINDOWS_POWERSHELL,
        args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROMPT_SCRIPT],
        timeoutMs: 5_000,
      });
      const parsed = JSON.parse(result.stdout || "{}") as { observations?: SecurityPromptObservation[] };
      return {
        platform: "win32",
        supported: true,
        observations: Array.isArray(parsed.observations) ? parsed.observations.slice(0, 4) : [],
        limitations: [
          "UAC secure-desktop contents cannot be read or clicked from this user-mode inspector.",
          "Windows firewall consent dialogs are not reliably attributable from user mode and are never auto-approved.",
          "Publisher evidence describes consent.exe when available; the requested elevated target is intentionally not inferred.",
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DesktopUiError("PROCESS_FAILED", `Windows security prompt inspection failed: ${message}`);
    }
  }

  if (platform === "darwin") {
    return {
      platform: "darwin",
      supported: false,
      observations: [],
      limitations: [
        "macOS authorization/password dialogs are intentionally not inspected because their protected contents may contain credentials.",
        "SuperAgent never submits administrator credentials or programmatically approves macOS security prompts.",
      ],
    };
  }

  if (platform === "linux") {
    return {
      platform: "linux",
      supported: false,
      observations: [],
      limitations: [
        "Desktop polkit/admin prompts vary by desktop environment and are not reliably detectable without a compositor-specific integration.",
        "SuperAgent never invokes sudo/pkexec or enters administrator credentials automatically.",
      ],
    };
  }

  throw new DesktopUiError("PLATFORM_UNSUPPORTED", `Security prompt inspection is unsupported on platform '${platform}'.`);
}
